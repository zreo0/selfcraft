import { afterEach, describe, expect, test } from 'bun:test';
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
import { MemoryStore } from '../../memory/memory-store';
import { NotificationInbox } from '../../notification/notification-inbox';
import { SessionStore } from '../../session/session-store';
import { SkillRegistry } from '../../skills/skill-registry';
import { ReleaseStore } from '../../supervisor/release-store';
import { createTools } from '../../tools';
import { PathGuard } from '../../tools/path-guard';
import { WorkspaceService } from '../../workspace/workspace-service';

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
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('AgentRuntime', () => {
    test('执行工具循环并把完整消息持久化到长期会话', async () => {
        const root = createTemporaryDirectory();
        const paths = resolvePaths('development', path.join(root, 'home'));
        paths.project = path.resolve(import.meta.dir, '../../..');
        const workspace = new WorkspaceService(paths.workspace, path.join(paths.project, 'workspace-template'));
        workspace.initialize();
        const config = new ConfigStore(paths.config);
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
        const model = new MockLanguageModelV4({
            doStream: [
                {
                    stream: simulateReadableStream({
                        chunks: [
                            {
                                type: 'tool-call',
                                toolCallId: 'call-1',
                                toolName: 'write',
                                input: JSON.stringify({ path: 'files/agent-test.txt', content: 'done' }),
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
        const agent = new AgentRuntime(
            config,
            workspace,
            skills,
            session,
            new ContextManager(),
            evolution,
            memory,
            { enqueue: () => 'reflection-test' },
            createTools(paths.workspace, skills, notifications, evolution, jobs, memory),
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

        await agent.run('创建测试文件', text => {
            response += text;
        });

        expect(response).toBe('完成');
        expect(fs.readFileSync(path.join(paths.workspace, 'files', 'agent-test.txt'), 'utf8')).toBe('done');
        expect(session.load().messages.map(message => message.role)).toEqual([
            'user',
            'assistant',
            'tool',
            'assistant',
        ]);
    });
});
