import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { AgentRuntime } from '../agent-runtime';
import { ConfigStore } from '../../config/config-store';
import { resolvePaths } from '../../config/paths';
import { ContextManager } from '../../context/context-manager';
import { EvolutionService } from '../../evolution/evolution-service';
import { JobManager } from '../../job/job-manager';
import { Logger } from '../../logging/logger';
import { MemoryStore, type ReflectionInput } from '../../memory/memory-store';
import { NotificationInbox } from '../../notification/notification-inbox';
import { SessionStore } from '../../session/session-store';
import { SkillRegistry } from '../../skills/skill-registry';
import { ReleaseStore } from '../../supervisor/release-store';
import { ScheduledTaskManager } from '../../task/scheduled-task-manager';
import { createTools } from '../../tools';
import { PathGuard } from '../../tools/path-guard';
import { WorkspaceService } from '../../workspace/workspace-service';
import { createWebTools } from '../../tools/web-tools';

const temporaryDirectories: string[] = [];

/** 创建并追踪测试临时目录 */
function createTemporaryDirectory (): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-agent-'));
    temporaryDirectories.push(directory);
    return directory;
}

/** 返回 AI SDK v4 流使用的零值 token 统计 */
function usage () {
    return {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
    };
}

afterEach(() => {
    setSystemTime();
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('AgentRuntime', () => {
    test('执行提醒工具循环并持久化完整会话与事件链', async () => {
        setSystemTime(new Date('2026-08-29T16:30:00.000Z'));
        const root = createTemporaryDirectory();
        const paths = resolvePaths('development', path.join(root, 'home'));
        paths.project = path.resolve(import.meta.dir, '../../..');
        const workspace = new WorkspaceService(paths.workspace, path.join(paths.project, 'workspace-template'));
        workspace.initialize();
        const config = new ConfigStore(paths.config);
        config.setTimezone('Asia/Shanghai');
        const skills = new SkillRegistry(path.join(paths.workspace, 'skills'));
        const logger = new Logger(paths.logs);
        const evolution = new EvolutionService(
            paths,
            new ReleaseStore(paths.supervisor, paths.evolution),
            logger,
        );
        const notifications = new NotificationInbox(paths.notifications);
        const memory = new MemoryStore(paths.state);
        const jobs = new JobManager(
            paths.state,
            paths.jobs,
            new PathGuard(paths.workspace),
            notifications,
            logger,
        );
        const scheduledTasks = new ScheduledTaskManager(paths.state, notifications, memory);
        const model = new MockLanguageModelV4({
            doStream: [
                {
                    stream: simulateReadableStream({
                        chunks: [
                            {
                                type: 'tool-call',
                                toolCallId: 'call-1',
                                toolName: 'task_schedule',
                                input: JSON.stringify({
                                    title: '准备材料',
                                    message: '整理验收材料',
                                    dueAt: '2099-09-01T09:00:00+08:00',
                                    originalExpression: '2099 年 9 月 1 日上午九点',
                                }),
                            },
                            {
                                type: 'finish',
                                finishReason: { unified: 'tool-calls', raw: undefined },
                                usage: usage(),
                            },
                        ] as any,
                    }),
                },
                {
                    stream: simulateReadableStream({
                        chunks: [
                            { type: 'text-start', id: 'text-1' },
                            { type: 'text-delta', id: 'text-1', delta: '完成' },
                            { type: 'text-end', id: 'text-1' },
                            {
                                type: 'finish',
                                finishReason: { unified: 'stop', raw: undefined },
                                usage: usage(),
                            },
                        ] as any,
                    }),
                },
            ],
        });
        const session = new SessionStore(paths.sessions);
        const reflections: ReflectionInput[] = [];
        const agent = new AgentRuntime(
            config,
            workspace,
            skills,
            session,
            new ContextManager(),
            evolution,
            memory,
            {
                enqueue: input => {
                    reflections.push(input);
                    return 'reflection-test';
                },
            },
            createTools(
                paths.workspace,
                skills,
                notifications,
                evolution,
                jobs,
                memory,
                scheduledTasks,
            ),
            logger,
            () => ({
                model,
                providerId: 'mock',
                modelId: 'mock-v4',
                contextWindow: 128000,
                maxOutputTokens: 4096,
            }),
        );
        let response = '';

        await agent.run('到 2099 年 9 月 1 日上午九点提醒我准备材料', text => {
            response += text;
        });

        expect(response).toBe('完成');
        expect(scheduledTasks.list()).toHaveLength(1);
        expect(scheduledTasks.list()[0]).toMatchObject({
            title: '准备材料',
            status: 'scheduled',
            timezone: config.read().timezone,
        });
        expect(session.load().messages.map(message => message.role)).toEqual([
            'user',
            'assistant',
            'tool',
            'assistant',
        ]);
        expect(reflections).toHaveLength(1);
        const events = memory.listEventsByRun(reflections[0].runId);
        expect(events.map(event => event.type)).toEqual([
            'user_message',
            'tool_call',
            'task_created',
            'tool_result',
            'assistant_message',
        ]);
        expect(events[1].sourceEventId).toBe(events[0].id);
        expect(events[2].sourceEventId).toBe(events[0].id);
        expect(events[3].sourceEventId).toBe(events[1].id);
        expect(events[4].sourceEventId).toBe(events[0].id);
        expect(events.every(event => event.timezone === 'Asia/Shanghai')).toBe(true);
        expect(events.every(event => event.localDate === '2026-08-30')).toBe(true);
        expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).not.toContain(events[0].id);
        expect(reflections[0]).toEqual({
            runId: reflections[0].runId,
            eventIds: events.map(event => event.id),
            outcome: 'completed',
        });
    });

    test('模型失败仍保留用户事件、失败事件和可追溯 Reflection', async () => {
        setSystemTime(new Date('2026-08-29T16:30:00.000Z'));
        const root = createTemporaryDirectory();
        const paths = resolvePaths('development', path.join(root, 'home'));
        paths.project = path.resolve(import.meta.dir, '../../..');
        const workspace = new WorkspaceService(paths.workspace, path.join(paths.project, 'workspace-template'));
        workspace.initialize();
        const config = new ConfigStore(paths.config);
        config.setTimezone('Asia/Shanghai');
        const logger = new Logger(paths.logs);
        const memory = new MemoryStore(paths.state);
        const reflections: ReflectionInput[] = [];
        const model = new MockLanguageModelV4({
            doStream: async () => {
                throw new Error('model unavailable');
            },
        });
        const agent = new AgentRuntime(
            config,
            workspace,
            new SkillRegistry(path.join(paths.workspace, 'skills')),
            new SessionStore(paths.sessions),
            new ContextManager(),
            new EvolutionService(
                paths,
                new ReleaseStore(paths.supervisor, paths.evolution),
                logger,
            ),
            memory,
            {
                enqueue: input => {
                    reflections.push(input);
                    return 'reflection-failed';
                },
            },
            {},
            logger,
            () => ({
                model,
                providerId: 'mock',
                modelId: 'mock-v4',
                contextWindow: 128000,
                maxOutputTokens: 4096,
            }),
        );

        await expect(agent.run('不要丢掉这条输入', () => undefined)).rejects.toThrow('model unavailable');

        expect(reflections).toHaveLength(1);
        const events = memory.listEventsByRun(reflections[0].runId);
        expect(events.map(event => event.type)).toEqual(['user_message', 'run_failed']);
        expect(events[1].sourceEventId).toBe(events[0].id);
        expect(events.every(event => event.timezone === 'Asia/Shanghai')).toBe(true);
        expect(events.every(event => event.localDate === '2026-08-30')).toBe(true);
        expect(reflections[0]).toEqual({
            runId: reflections[0].runId,
            eventIds: events.map(event => event.id),
            outcome: 'failed',
            error: 'model unavailable',
        });
    });

    test('网络工具随配置在同一个 Runtime 中按轮次显隐', async () => {
        const root = createTemporaryDirectory();
        const paths = resolvePaths('development', path.join(root, 'home'));
        paths.project = path.resolve(import.meta.dir, '../../..');
        const workspace = new WorkspaceService(paths.workspace, path.join(paths.project, 'workspace-template'));
        workspace.initialize();
        const config = new ConfigStore(paths.config);
        const logger = new Logger(paths.logs);
        const memory = new MemoryStore(paths.state);
        const model = new MockLanguageModelV4({
            doStream: async () => ({
                stream: simulateReadableStream({
                    chunks: [
                        { type: 'text-start', id: 'text' },
                        { type: 'text-delta', id: 'text', delta: '好' },
                        { type: 'text-end', id: 'text' },
                        {
                            type: 'finish',
                            finishReason: { unified: 'stop', raw: undefined },
                            usage: usage(),
                        },
                    ] as any,
                }),
            }),
        });
        const agent = new AgentRuntime(
            config,
            workspace,
            new SkillRegistry(path.join(paths.workspace, 'skills')),
            new SessionStore(paths.sessions),
            new ContextManager(),
            new EvolutionService(paths, new ReleaseStore(paths.supervisor, paths.evolution), logger),
            memory,
            { enqueue: () => 'reflection-web-tools' },
            createWebTools({
                async search () {
                    throw new Error('本测试不会执行工具');
                },
                async fetchPage () {
                    throw new Error('本测试不会执行工具');
                },
            }) as never,
            logger,
            () => ({
                model,
                providerId: 'mock',
                modelId: 'mock-v4',
                contextWindow: 128000,
                maxOutputTokens: 4096,
            }),
        );

        await agent.run('第一次', () => undefined);
        config.configureWebAccess('tvly-test-key');
        await agent.run('第二次', () => undefined);

        const toolNames = model.doStreamCalls.map(call => call.tools?.map(item => item.name) || []);
        expect(toolNames[0]).not.toContain('web_search');
        expect(toolNames[0]).not.toContain('web_fetch');
        expect(toolNames[1]).toContain('web_search');
        expect(toolNames[1]).toContain('web_fetch');
        expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain('当前没有配置网络访问');
        expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain('不得只根据搜索摘要作答');
    });
});
