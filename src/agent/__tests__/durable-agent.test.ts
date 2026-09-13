import { AttachmentStore } from '../../attachment/attachment-store';
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
function fixture (model: MockLanguageModelV4, vision = false, auxiliary?: MockLanguageModelV4) {
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
    const attachments = new AttachmentStore(paths.home);
    const tools = createTools(paths.workspace, skills, notifications, evolution, jobs, memory, undefined, undefined, executions, works, [attachments, () => auxiliary ? ({ model: auxiliary, providerId: 'test', modelId: 'vision', contextWindow: 128000, maxOutputTokens: 2048, vision: true }) : null]);
    const session = new SessionStore(paths.sessions);
    const agent = new AgentRuntime(config, workspace, skills, session, new ContextManager(), evolution, memory,
        { beginAgentActivity: () => undefined, endAgentActivity: () => undefined, enqueue: () => 'reflection' }, tools, logger,
        () => ({ model, providerId: 'test', modelId: 'test', contextWindow: 128000, maxOutputTokens: 4096, vision }), executions, works, attachments);
    return { paths, agent, executions, session, works, memory, jobs, notifications, logger, attachments };
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


test('原生视觉请求读取持久原图，下一轮从磁盘历史再次物化，不向模型泄露本地 URL', async () => {
    const model = new MockLanguageModelV4({ doStream: async () => response() });
    const { agent, attachments, session, memory } = fixture(model, true);
    const uploaded = await attachments.save(new File([new Uint8Array([255, 216, 255, 224])], 'photo.jpg'));
    await agent.run([attachments.reference(uploaded)]);
    await agent.run('再看一下刚才的图片');
    for (const call of model.doStreamCalls) {
        const prompt = JSON.stringify(call.prompt);
        expect(prompt).toContain('image/jpeg');
        expect(prompt).toContain('"type":"data"');
        expect(prompt).not.toContain('"type":"url"');
    }
    expect(JSON.stringify(session.loadTranscript())).toContain(uploaded.url);
    expect(JSON.stringify(session.loadTranscript())).not.toContain('"type":"data"');
    expect(JSON.stringify(memory.listConversationEvents(10))).toContain(uploaded.url);
});

test('纯文本主模型通过真实工具包装调用视觉模型，保留问题和分析证据供后续追问', async () => {
    const auxiliary = new MockLanguageModelV4({ doGenerate: {
        content: [{ type: 'text', text: '右上角显示测试环境' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
        }, warnings: [],
    } });
    let url = '';
    let calls = 0;
    const model = new MockLanguageModelV4({ doStream: async () => ++calls === 1
        ? response({ name: 'image_analyze', input: { url, question: '右上角是什么环境？' } }) : response(undefined, '当前是测试环境') });
    const { agent, attachments, executions, memory } = fixture(model, false, auxiliary);
    const uploaded = await attachments.save(new File([new Uint8Array([255, 216, 255, 224])], 'screen.jpg'));
    url = uploaded.url;
    await agent.run([{ type: 'text', text: '右上角是什么环境？' }, attachments.reference(uploaded)], () => undefined, { executionId: 'image-run' });
    expect(auxiliary.doGenerateCalls).toHaveLength(1);
    expect(JSON.stringify(auxiliary.doGenerateCalls[0]!.prompt)).toContain('image/jpeg');
    expect(JSON.stringify(auxiliary.doGenerateCalls[0]!.prompt)).toContain('右上角是什么环境');
    expect(model.doStreamCalls.every(call => !JSON.stringify(call.prompt).includes('"type":"file"'))).toBeTrue();
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).toContain('右上角显示测试环境');
    expect(executions.get('image-run')?.status).toBe('completed');
    expect(memory.listEventsByRun('image-run').some(event => event.type === 'tool_result')).toBeTrue();
});

test('没有视觉模型时图片仍被接收，工具返回能力缺失且后续文字对话继续', async () => {
    let url = '';
    let calls = 0;
    const model = new MockLanguageModelV4({ doStream: async () => ++calls === 1
        ? response({ name: 'image_analyze', input: { url, question: '这是什么？' } }) : response(undefined, '图片已收到，暂时无法理解') });
    const { agent, attachments } = fixture(model);
    const uploaded = await attachments.save(new File([new Uint8Array([255, 216, 255, 224])], 'photo.jpg'));
    url = uploaded.url;
    await agent.run([attachments.reference(uploaded)]);
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).toContain('没有可用的视觉模型');
    await agent.run('继续聊其他事情');
    expect(model.doStreamCalls).toHaveLength(3);
    expect(attachments.read(url).bytes.length).toBe(4);
});


test('图片分析被取消后显式重试成功，不重复用户消息且保留中断证据', async () => {
    const controller = new AbortController();
    let analysisCalls = 0;
    const auxiliary = new MockLanguageModelV4({ doGenerate: async () => {
        if (++analysisCalls === 1) {
            controller.abort(new Error('模拟图片读取超时'));
            throw controller.signal.reason;
        }
        return {
            content: [{ type: 'text' as const, text: '右侧是蓝色' }],
            finishReason: { unified: 'stop' as const, raw: undefined },
            usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
        };
    } });
    let url = '';
    let modelCalls = 0;
    const model = new MockLanguageModelV4({ doStream: async () => ++modelCalls <= 2
        ? response({ name: 'image_analyze', input: { url, question: '右侧是什么颜色？' } }) : response(undefined, '右侧是蓝色') });
    const { agent, attachments, session, executions } = fixture(model, false, auxiliary);
    url = (await attachments.save(new File([new Uint8Array([255, 216, 255, 224])], 'image.jpg'))).url;
    const input = `查看图片 ${url}`;
    await expect(agent.run(input, () => undefined, { executionId: 'interrupted-image', signal: controller.signal })).rejects.toThrow();
    expect(executions.begin('interrupted-image').status).not.toBe('blocked');
    await agent.run(input, () => undefined, { executionId: 'retry-image', retry: true });
    expect(analysisCalls).toBe(2);
    expect(executions.get('retry-image')?.status).toBe('completed');
    expect(session.loadTranscript().filter(message => message.role === 'user')).toHaveLength(1);
});

test('图片已分析但最终模型失败时，显式重试复用检查点而不重复视觉调用', async () => {
    let calls = 0;
    let url = '';
    const auxiliary = new MockLanguageModelV4({ doGenerate: {
        content: [{ type: 'text', text: '图片中的右侧是蓝色' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
    } });
    const model = new MockLanguageModelV4({ doStream: async options => {
        calls += 1;
        if (calls === 1) {
            return response({ name: 'image_analyze', input: { url, question: '图里是什么？' } });
        }
        if (calls === 2) {
            throw new Error('模型临时不可用');
        }
        expect(JSON.stringify(options.prompt)).toContain('图片中的右侧是蓝色');
        return response();
    } });
    const { agent, session, attachments } = fixture(model, false, auxiliary);
    url = (await attachments.save(new File([new Uint8Array([255, 216, 255, 224])], 'image.jpg'))).url;
    await expect(agent.run('读取图片', () => undefined, { executionId: 'read-failed' })).rejects.toThrow();
    await agent.run('读取图片', () => undefined, { executionId: 'read-retry', retry: true });
    expect(calls).toBe(3);
    expect(auxiliary.doGenerateCalls).toHaveLength(1);
    expect(session.loadTranscript().filter(message => message.role === 'user')).toHaveLength(1);
});

test('写入成功后模型失败，显式重试仍拒绝重复有副作用的操作', async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({ doStream: async () => {
        if (++calls === 1) {
            return response({ name: 'write', input: { path: 'files/once.txt', content: '保留' } });
        }
        throw new Error('模型暂不可用');
    } });
    const { agent } = fixture(model);
    await expect(agent.run('保存文件', () => undefined, { executionId: 'write-once' })).rejects.toThrow();
    await expect(agent.run('保存文件', () => undefined, { executionId: 'write-retry', retry: true })).rejects.toThrow('这轮已经执行过操作');
    expect(calls).toBe(2);
});
