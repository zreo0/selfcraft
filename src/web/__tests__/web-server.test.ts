import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ForegroundRunner } from '../../agent/foreground-runner';
import { RuntimeClient } from '../../cli/runtime-client';
import { ConfigStore } from '../../config/config-store';
import { resolvePaths } from '../../config/paths';
import { HealthChecker } from '../../health/health-checker';
import { JobManager } from '../../job/job-manager';
import { Logger } from '../../logging/logger';
import { MemoryStore } from '../../memory/memory-store';
import { NotificationInbox } from '../../notification/notification-inbox';
import { SkillRegistry } from '../../skills/skill-registry';
import { ScheduledTaskManager } from '../../task/scheduled-task-manager';
import { PathGuard } from '../../tools/path-guard';
import { WebServer } from '../web-server';

const temporaryDirectories: string[] = [];

/** 创建并追踪测试临时目录 */
function createTemporaryDirectory (): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-web-'));
    temporaryDirectories.push(directory);
    return directory;
}

/** 创建不监听端口的 WebServer 测试实例 */
function createServer () {
    const root = createTemporaryDirectory();
    const paths = resolvePaths('development', path.join(root, 'home'));
    paths.project = path.resolve(import.meta.dir, '../../..');
    const staticDirectory = path.join(root, 'dist');
    fs.mkdirSync(staticDirectory, { recursive: true });
    fs.writeFileSync(path.join(staticDirectory, 'index.html'), '<!doctype html><title>Selfcraft</title>');
    const config = new ConfigStore(paths.config);
    const memory = new MemoryStore(paths.state);
    const notifications = new NotificationInbox(paths.notifications);
    const logger = new Logger(paths.logs);
    const jobs = new JobManager(
        paths.state,
        paths.jobs,
        new PathGuard(paths.workspace),
        notifications,
        logger,
    );
    const scheduledTasks = new ScheduledTaskManager(paths.state, notifications, memory);
    const calls: string[] = [];
    const agent = new ForegroundRunner({
        async run (input, onEvent) {
            calls.push(input);
            if (input === '触发失败') {
                onEvent?.({
                    type: 'activity',
                    activity: {
                        id: 'interrupted-call',
                        kind: 'tool',
                        toolName: 'read',
                        label: '读取文件',
                        state: 'running',
                    },
                });
                throw new Error('模拟运行失败');
            }
            onEvent?.({ type: 'status', phase: 'thinking', label: '正在思考' });
            onEvent?.({
                type: 'activity',
                activity: {
                    id: 'memory-call',
                    kind: 'tool',
                    toolName: 'memory_recall',
                    label: '回想过往',
                    state: 'running',
                },
            });
            onEvent?.({
                type: 'activity',
                activity: {
                    id: 'memory-call',
                    kind: 'tool',
                    toolName: 'memory_recall',
                    label: '回想过往',
                    state: 'success',
                    durationMs: 12,
                },
            });
            onEvent?.({ type: 'text-delta', delta: '我记得。' });
            return { restartRequired: false };
        },
    });
    const server = new WebServer({
        paths,
        config,
        agent,
        memory,
        skills: new SkillRegistry(path.join(paths.workspace, 'skills')),
        notifications,
        jobs,
        scheduledTasks,
        health: new HealthChecker(),
        logger,
        staticDirectory,
        onRestart: () => undefined,
    });
    return { server, config, memory, notifications, scheduledTasks, paths, calls };
}

/** 创建同源 JSON 请求 */
function jsonRequest (pathname: string, method: string, body: unknown, origin = 'http://selfcraft.local'): Request {
    return new Request(`http://selfcraft.local${pathname}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            Origin: origin,
        },
        body: JSON.stringify(body),
    });
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('WebServer', () => {
    test('初始化只返回脱敏配置、健康状态与前台消息', async () => {
        const { server, config, memory } = createServer();
        config.addProvider({
            providerId: 'local',
            type: 'openai-compatible',
            baseURL: 'http://127.0.0.1:3000/v1',
            apiKey: 'not-a-real-credential',
            models: {
                assistant: { vision: false, contextWindow: 128000, maxOutputTokens: 4096 },
            },
        });
        config.configureWebAccess('tvly-not-a-real-credential');
        memory.recordEvent({
            actor: 'user',
            type: 'user_message',
            payload: { text: '前台消息', channel: 'foreground' },
        });
        memory.recordEvent({
            actor: 'agent',
            type: 'assistant_message',
            payload: { text: '后台消息', channel: 'background' },
        });

        const response = await server.fetch(new Request('http://selfcraft.local/api/bootstrap'));
        const body = await response.json() as any;
        const serialized = JSON.stringify(body);

        expect(response.status).toBe(200);
        expect(body.config.configured).toBeTrue();
        expect(body.config.providers[0].credentialConfigured).toBeTrue();
        expect(body.config.webAccess).toEqual({ provider: 'tavily', configured: true });
        expect(body.messages.items.map((item: any) => item.parts[0].text)).toEqual(['前台消息']);
        expect(serialized).not.toContain('not-a-real-credential');
        expect(serialized).not.toContain('tvly-not-a-real-credential');
        expect(serialized).not.toContain('credentialRef');
    });

    test('刷新后从事件时间线重建工具活动和实际读取来源', async () => {
        const { server, memory } = createServer();
        const runId = 'run-web-research';
        const user = memory.recordEvent({
            actor: 'user',
            type: 'user_message',
            payload: { text: '查一下最新资料', channel: 'foreground' },
            runId,
        });
        const searchCall = memory.recordEvent({
            actor: 'agent',
            type: 'tool_call',
            payload: {
                toolName: 'web_search',
                toolCallId: 'search-1',
                input: { query: 'Selfcraft agent' },
            },
            runId,
            sourceEventId: user.id,
        });
        memory.recordEvent({
            actor: 'tool:web_search',
            type: 'tool_result',
            payload: {
                toolName: 'web_search',
                toolCallId: 'search-1',
                result: {
                    results: [{
                        title: 'Selfcraft 文档',
                        url: 'https://example.com/selfcraft',
                        snippet: '候选摘要',
                    }],
                },
            },
            runId,
            sourceEventId: searchCall.id,
        });
        const fetchCall = memory.recordEvent({
            actor: 'agent',
            type: 'tool_call',
            payload: {
                toolName: 'web_fetch',
                toolCallId: 'fetch-1',
                input: { url: 'https://example.com/selfcraft' },
            },
            runId,
            sourceEventId: user.id,
        });
        memory.recordEvent({
            actor: 'tool:web_fetch',
            type: 'tool_result',
            payload: {
                toolName: 'web_fetch',
                toolCallId: 'fetch-1',
                result: {
                    preview: '过长的网页结果已被截断',
                    truncated: true,
                },
            },
            runId,
            sourceEventId: fetchCall.id,
        });
        memory.recordEvent({
            actor: 'agent',
            type: 'tool_call',
            payload: {
                toolName: 'read',
                toolCallId: 'missing-audit',
                input: { path: 'notes/research.md' },
            },
            runId,
            sourceEventId: user.id,
        });
        memory.recordEvent({
            actor: 'agent',
            type: 'assistant_message',
            payload: { text: '这是查证后的回答', channel: 'foreground' },
            runId,
            sourceEventId: user.id,
        });

        const response = await server.fetch(new Request('http://selfcraft.local/api/bootstrap'));
        const body = await response.json() as any;
        const assistant = body.messages.items.find((item: any) => item.role === 'assistant');
        const activity = assistant.parts.find((part: any) => part.type === 'data-activity');
        const source = assistant.parts.find((part: any) => part.type === 'source-url');

        expect(activity.data.status).toBe('complete');
        expect(activity.data.items).toMatchObject([
            {
                id: 'search-1',
                kind: 'search',
                state: 'success',
                results: [{ title: 'Selfcraft 文档', domain: 'example.com' }],
            },
            {
                id: 'fetch-1',
                kind: 'tool',
                state: 'success',
            },
            {
                id: 'missing-audit',
                kind: 'tool',
                state: 'unknown',
            },
        ]);
        expect(source).toMatchObject({
            sourceId: 'fetch-1:source',
            url: 'https://example.com/selfcraft',
            title: 'example.com',
        });
    });

    test('可通过同源 API 启用和关闭网络搜索且不返回凭证', async () => {
        const { server } = createServer();

        const enabled = await server.fetch(jsonRequest('/api/config/web', 'POST', {
            apiKey: 'tvly-web-secret',
        }));
        const enabledBody = await enabled.json() as any;

        expect(enabled.status).toBe(200);
        expect(enabledBody.webAccess).toEqual({ provider: 'tavily', configured: true });
        expect(JSON.stringify(enabledBody)).not.toContain('tvly-web-secret');

        const disabled = await server.fetch(jsonRequest('/api/config/web', 'DELETE', {}));
        const disabledBody = await disabled.json() as any;

        expect(disabled.status).toBe(200);
        expect(disabledBody.webAccess).toBeNull();
    });

    test('全新实例可只通过 Web 完成初始化并使用 AI SDK 协议流式对话', async () => {
        const { server, calls } = createServer();
        const beforeSetup = await server.fetch(new Request('http://selfcraft.local/api/bootstrap'));
        expect((await beforeSetup.json() as any).config.configured).toBeFalse();

        const setup = await server.fetch(jsonRequest('/api/config/providers', 'POST', {
            providerId: 'default',
            type: 'openai-compatible',
            baseURL: 'http://127.0.0.1:3000/v1',
            apiKey: 'not-a-real-credential',
            modelId: 'assistant',
            vision: false,
            contextWindow: 128000,
            maxOutputTokens: 4096,
        }));
        if (!setup.ok) {
            throw new Error(await setup.text());
        }
        expect(setup.status).toBe(200);

        const timezone = await server.fetch(jsonRequest('/api/config/timezone', 'PUT', {
            timezone: 'Asia/Shanghai',
        }));
        const afterSetup = await server.fetch(new Request('http://selfcraft.local/api/bootstrap'));

        expect(timezone.status).toBe(200);
        expect((await afterSetup.json() as any).config).toMatchObject({
            configured: true,
            timezone: 'Asia/Shanghai',
            activeModel: { providerId: 'default', modelId: 'assistant' },
        });

        const response = await server.fetch(jsonRequest('/api/chat', 'POST', {
            messages: [{
                id: 'user-1',
                role: 'user',
                parts: [{ type: 'text', text: '还记得吗？' }],
            }],
        }));
        const stream = await response.text();

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        expect(stream).toContain('text-delta');
        expect(stream).toContain('我记得。');
        expect(stream).toContain('data-status');
        expect(stream).toContain('data-activity');
        expect(stream).toContain('回想过往');
        expect(calls).toEqual(['还记得吗？']);
    });

    test('运行失败时把未结束活动收口为失败终态', async () => {
        const { server, config } = createServer();
        config.addProvider({
            providerId: 'default',
            type: 'openai-compatible',
            baseURL: 'http://127.0.0.1:3000/v1',
            apiKey: 'not-a-real-credential',
            models: {
                assistant: { vision: false, contextWindow: 128000, maxOutputTokens: 4096 },
            },
        });
        const response = await server.fetch(jsonRequest('/api/chat', 'POST', {
            messages: [{
                id: 'user-failed',
                role: 'user',
                parts: [{ type: 'text', text: '触发失败' }],
            }],
        }));
        const stream = await response.text();

        expect(response.status).toBe(200);
        expect(stream).toContain('data-activity');
        expect(stream).toContain('"status":"complete"');
        expect(stream).toContain('"state":"error"');
        expect(stream).toContain('回应没有完成');
    });

    test('拒绝跨站状态修改并为前端路由返回构建页面', async () => {
        const { server } = createServer();

        const rejected = await server.fetch(jsonRequest('/api/config/timezone', 'PUT', {
            timezone: 'Asia/Shanghai',
        }, 'https://attacker.example'));
        const page = await server.fetch(new Request('http://selfcraft.local/settings'));

        expect(rejected.status).toBe(400);
        expect(await rejected.text()).toContain('拒绝跨站请求');
        expect(page.status).toBe(200);
        expect(await page.text()).toContain('<title>Selfcraft</title>');
    });

    test('已有但损坏的配置不会被误判成首次 onboarding', async () => {
        const { server, config, paths } = createServer();
        config.addProvider({
            providerId: 'old',
            type: 'openai',
            apiKey: 'not-a-real-credential',
            models: {
                assistant: { vision: false, contextWindow: 128000, maxOutputTokens: 4096 },
            },
        });
        fs.writeFileSync(path.join(paths.config, 'secrets.json'), '{broken', 'utf8');

        const response = await server.fetch(new Request('http://selfcraft.local/api/bootstrap'));
        const body = await response.json() as any;

        expect(body.config).toBeNull();
        expect(body.configurationError).toBeString();
        expect(body.configurationError.length).toBeGreaterThan(0);
    });

    test('独立 CLI 客户端可通过 HTTP 共用配置、对话与 Runtime 状态', async () => {
        const { server, memory, notifications, scheduledTasks, calls } = createServer();
        const directFetch = Object.assign(async (input: URL | RequestInfo, init?: RequestInit) => {
            const request = input instanceof Request ? input : new Request(input, init);
            return await server.fetch(request);
        }, { preconnect: fetch.preconnect }) as typeof fetch;
        const client = new RuntimeClient('http://selfcraft.local', directFetch);
        try {
            await client.addProvider({
                providerId: 'default',
                type: 'openai-compatible',
                baseURL: 'http://127.0.0.1:3000/v1',
                apiKey: 'not-a-real-credential',
                models: {
                    assistant: { vision: false, contextWindow: 128000, maxOutputTokens: 4096 },
                    vision: { vision: true, contextWindow: 64000, maxOutputTokens: 2048 },
                },
            });
            const bootstrap = await client.bootstrap();
            expect(bootstrap.config?.providers[0].models.map(model => model.id)).toEqual([
                'assistant',
                'vision',
            ]);
            expect((await client.configureWebAccess('tvly-cli-secret')).webAccess).toEqual({
                provider: 'tavily',
                configured: true,
            });
            expect((await client.disableWebAccess()).webAccess).toBeNull();

            const deltas: string[] = [];
            const activities: string[] = [];
            await client.chat('来自 CLI 的消息', event => {
                if (event.type === 'text-delta') {
                    deltas.push(event.delta);
                }
                if (event.type === 'activity') {
                    activities.push(`${event.activity.label}:${event.activity.state}`);
                }
            });
            expect(deltas.join('')).toBe('我记得。');
            expect(activities).toEqual(['回想过往:running', '回想过往:success']);
            expect(calls).toEqual(['来自 CLI 的消息']);

            notifications.push('验收通知', '来自唯一 Runtime');
            expect(await client.listNotifications()).toHaveLength(1);
            await client.clearNotifications();
            expect(await client.listNotifications()).toEqual([]);

            const source = memory.recordEvent({
                actor: 'user',
                type: 'user_message',
                payload: { text: '明天提醒我' },
                timezone: 'Asia/Shanghai',
            });
            const task = scheduledTasks.create({
                title: '测试提醒',
                message: '验收多入口',
                dueAt: '2099-01-01T00:00:00.000Z',
                timezone: 'Asia/Shanghai',
                originalExpression: '很久以后',
                sourceEventId: source.id,
            });
            expect((await client.listTasks()).map(item => item.id)).toContain(task.id);
            expect(await client.cancelTask(task.id)).toBeTrue();
        } finally {
            server.stop();
        }
    });
});
