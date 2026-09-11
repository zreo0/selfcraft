import { WorkRunner } from '../../work/work-runner';
import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { AgentRuntime } from '../agent-runtime';
import { ForegroundRunner } from '../foreground-runner';
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
import { ExecutionStore } from '../../execution/execution-store';
import { WorkStore } from '../../work/work-store';

const roots: string[] = [];
/** 创建协议层模拟响应，工具执行仍经过真实生产包装器 */
function response (call?: { name: string; input: unknown }, text = '已完成') {
    return {
        stream: simulateReadableStream({ chunks: [
            ...(call ? [{ type: 'tool-call' as const, toolCallId: 'call-write', toolName: call.name, input: JSON.stringify(call.input) }]
                : [{ type: 'text-start' as const, id: 'text' }, { type: 'text-delta' as const, id: 'text', delta: text }, { type: 'text-end' as const, id: 'text' }]),
            { type: 'finish' as const, finishReason: { unified: call ? 'tool-calls' as const : 'stop' as const, raw: undefined }, usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
            } },
        ] }),
    };
}
/** 创建与 Runtime 相同的持久 Agent 组装 */
function fixture (model: MockLanguageModelV4) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-durable-agent-'));
    roots.push(root);
    const paths = resolvePaths('development', root);
    const workspace = new WorkspaceService(paths.workspace, path.join(paths.project, 'workspace-template'));
    workspace.initialize();
    const config = new ConfigStore(paths.config);
    const logger = new Logger(paths.logs);
    const memory = new MemoryStore(paths.state);
    const executions = new ExecutionStore(paths.state);
    const works = new WorkStore(paths.state);
    const notifications = new NotificationInbox(paths.notifications);
    const skills = new SkillRegistry(path.join(paths.workspace, 'skills'));
    const evolution = new EvolutionService(paths, new ReleaseStore(paths.supervisor, paths.evolution), logger);
    const jobs = new JobManager(paths.state, paths.jobs, new PathGuard(paths.workspace), notifications, logger);
    const tools = createTools(paths.workspace, skills, notifications, evolution, jobs, memory, undefined, undefined, executions, works);
    const session = new SessionStore(paths.sessions);
    const agent = new AgentRuntime(config, workspace, skills, session, new ContextManager(), evolution, memory,
        { beginAgentActivity: () => undefined, endAgentActivity: () => undefined, enqueue: () => 'reflection' }, tools, logger,
        () => ({ model, providerId: 'test', modelId: 'test', contextWindow: 128000, maxOutputTokens: 4096, vision: false }), executions, works);
    return { paths, agent, executions, session, works, memory, jobs, notifications, logger };
}
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

test('真实工具循环在写入后模型失败，恢复相同执行复用检查点且不重复用户输入或工具', async () => {
    let calls = 0;
    let recoveryPrompt = '';
    const model = new MockLanguageModelV4({ doStream: async options => {
        calls += 1;
        if (calls === 1) {
            return response({ name: 'write', input: { path: 'files/result.txt', content: '一次写入' } });
        }
        if (calls === 2) {
            throw new Error('模拟模型中断');
        }
        recoveryPrompt = JSON.stringify(options.prompt);
        return response();
    } });
    const { agent, executions, session, memory } = fixture(model);
    await expect(agent.run('写入结果', () => undefined, { executionId: 'durable' })).rejects.toThrow();
    expect(executions.get('durable')?.messages.some(message => message.role === 'tool')).toBeTrue();
    await agent.run('写入结果', () => undefined, { executionId: 'durable' });
    expect(recoveryPrompt).toContain('一次写入');
    expect(session.loadTranscript().filter(message => message.role === 'user')).toHaveLength(1);
    expect(memory.listEventsByRun('durable').filter(event => event.type === 'tool_call')).toHaveLength(1);
    expect(executions.get('durable')?.status).toBe('completed');
});

test('客户端断开和观察回调失败不取消已持久接收的输入', async () => {
    const model = new MockLanguageModelV4({ doStream: async () => response(undefined, '已接收并完成') });
    const { agent, executions, session } = fixture(model);
    const runner = new ForegroundRunner(agent, executions);
    const controller = new AbortController();
    const result = runner.run('你好', () => { throw new Error('浏览器已经关闭'); }, { signal: controller.signal, executionId: 'detached' });
    controller.abort();
    await result;
    expect(executions.get('detached')?.status).toBe('completed');
    expect(session.loadTranscript().at(-1)?.content).toEqual([{ type: 'text', text: '已接收并完成' }]);
});

test('跨重启等待的事项在用户改变要求后由同一个助理自动验收交付', async () => {
    let calls = 0;
    let works: WorkStore;
    let workId = '';
    const model = new MockLanguageModelV4({ doStream: async options => {
        calls += 1;
        if (calls === 1) {
            expect(JSON.stringify(options.prompt)).toContain('新的简报');
            const current = works.get(workId)!;
            return response({ name: 'work_update', input: {
                id: workId, revision: current.revision, status: 'completed',
                next: '', evidence: '已根据补充资料完成新的简报，核对了用户要求的三个要点',
            } });
        }
        return response(undefined, '新的简报已完成');
    } });
    const f = fixture(model);
    works = f.works;
    const work = works.create({ goal: '旧报告', acceptance: '核对三个要点', authority: '仅本地整理', sourceEventId: 'user:1', next: '等资料' });
    workId = work.id;
    works.update(work.id, 1, { status: 'waiting', waitFor: 'user' });
    const restored = new WorkStore(f.paths.state);
    const runner = new WorkRunner(restored, f.agent, new ForegroundRunner(f.agent, f.executions),
        f.jobs, f.memory, f.notifications, f.logger, () => undefined, () => false);
    runner.start();
    try {
        runner.tick();
        expect(calls).toBe(0);
        restored.update(work.id, 2, { goal: '新的简报', status: 'ready', next: '资料已补齐，按最新要求交付' }, true);
        runner.tick();
        const deadline = Date.now() + 3000;
        while (restored.get(work.id)?.status !== 'completed' && Date.now() < deadline) {
            await Bun.sleep(10);
        }
        runner.tick();
        expect(restored.get(work.id)?.status).toBe('completed');
        expect(f.notifications.list().some(item => item.message.includes('三个要点'))).toBeTrue();
        expect(f.session.loadTranscript()).toHaveLength(0);
    } finally {
        runner.stop();
        await Bun.sleep(30);
    }
});
