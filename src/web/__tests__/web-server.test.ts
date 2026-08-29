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
        async run (input, onText, onStatus) {
            calls.push(input);
            onStatus?.('使用工具 memory_recall');
            onText('我记得。');
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
        expect(body.messages.items.map((item: any) => item.parts[0].text)).toEqual(['前台消息']);
        expect(serialized).not.toContain('not-a-real-credential');
        expect(serialized).not.toContain('credentialRef');
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
        expect(calls).toEqual(['还记得吗？']);
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

            const deltas: string[] = [];
            const statuses: string[] = [];
            await client.chat('来自 CLI 的消息', delta => deltas.push(delta), status => statuses.push(status));
            expect(deltas.join('')).toBe('我记得。');
            expect(statuses).toContain('使用工具 memory_recall');
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
