import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { Logger } from '../../logging/logger';
import { MemoryStore, type MemoryCandidate, type GrowthCandidate } from '../memory-store';
import { ReflectionWorker } from '../reflection-worker';

const roots: string[] = [];

/** 创建不访问真实实例数据的测试存储 */
function setup () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-reflection-'));
    roots.push(root);
    return { store: new MemoryStore(path.join(root, 'state.sqlite')), root };
}

/** 建立失败、修正调用及其真实结果的执行链 */
function correction (store: MemoryStore, output: unknown = { title: '今日榜单', items: ['科技新闻'] }) {
    const runId = crypto.randomUUID();
    const failedCall = store.recordEvent({ actor: 'agent', type: 'tool_call', runId,
        payload: { toolName: 'web_fetch', input: { url: 'https://example.test/old' } } });
    const failure = store.recordEvent({ actor: 'tool:web_fetch', type: 'tool_error', runId,
        sourceEventId: failedCall.id, payload: { error: '旧地址失效' } });
    const call = store.recordEvent({ actor: 'agent', type: 'tool_call', runId,
        payload: { toolName: 'web_fetch', input: { url: 'https://example.test/board' } } });
    const result = store.recordEvent({ actor: 'tool:web_fetch', type: 'tool_result', runId,
        sourceEventId: call.id, payload: { result: output } });
    const sourceEventIds = [failedCall.id, failure.id, call.id, result.id];
    const id = store.enqueueReflection({ runId, eventIds: sourceEventIds, outcome: 'completed' });
    store.claimReflection();
    const memory: MemoryCandidate = {
        kind: 'lesson', content: '读取 example.test 今日榜单时，旧地址失效后使用 /board 获取榜单',
        basis: 'observed', assertion: 'established', needsConfirmation: false,
        confidence: 0.8, importance: 0.8, sensitive: false, sourceEventIds,
        verifiedCorrection: { failureEventId: failure.id, correctionEventId: call.id, resultEventId: result.id,
            applicability: '读取 example.test 今日榜单时', explanation: '新地址实际返回了所需榜单条目', aboutUser: false },
    };
    return { id, memory, failure, call, result };
}

/** 创建带独立来源的成长候选批次 */
function growthBatch (store: MemoryStore, title: string) {
    const runId = crypto.randomUUID();
    const event = store.recordEvent({ actor: 'user', type: 'user_message', payload: { text: title }, runId });
    const id = store.enqueueReflection({ runId, eventIds: [event.id], outcome: 'completed' });
    store.claimReflection();
    const growth: GrowthCandidate = { kind: 'runtime', title, observation: '网页地址选择重复失败',
        evidence: '用户指出地址失效', confidence: 0.8, sourceEventIds: [event.id] };
    return { id, growth };
}

afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

test('已验证具体纠错立即生效并进入上下文，依据保持 observed', () => {
    const { store } = setup();
    const batch = correction(store);
    store.completeReflections([batch.id], { memories: [batch.memory], growth: [] });
    const learned = store.search('今日榜单')[0]!;
    expect(learned.status).toBe('active');
    expect(learned.basis).toBe('observed');
    expect(learned.sourceEventIds).toContain(batch.result.id);
    expect(store.buildContext('今日榜单')).toContain(learned.content);
});

test('reinforce 重新验证具体纠错，同一候选被激活且不改为 stated', () => {
    const { store } = setup();
    const first = correction(store);
    store.completeReflections([first.id], { memories: [{ ...first.memory, verifiedCorrection: undefined }], growth: [] });
    const candidate = store.search('今日榜单')[0]!;
    const next = correction(store);
    store.completeReflections([next.id], { memories: [{ ...next.memory, operation: 'reinforce', targetId: candidate.id }], growth: [] }, [candidate]);
    expect(store.search('今日榜单')).toHaveLength(1);
    expect(store.getMemory(candidate.id)?.status).toBe('active');
    expect(store.getMemory(candidate.id)?.basis).toBe('observed');
    expect(store.getMemory(candidate.id)?.sourceEventIds).toContain(first.result.id);
    expect(store.getMemory(candidate.id)?.sourceEventIds).toContain(next.result.id);
});

test('重复 add 的已验证经验保留 observed，缺乏验证的高置信经验仍为候选', () => {
    const { store } = setup();
    const first = correction(store);
    store.completeReflections([first.id], { memories: [{ ...first.memory, confidence: 1, verifiedCorrection: undefined }], growth: [] });
    const candidate = store.search('今日榜单')[0]!;
    expect(candidate.status).toBe('candidate');
    const next = correction(store);
    store.completeReflections([next.id], { memories: [next.memory], growth: [] });
    expect(store.getMemory(candidate.id)?.basis).toBe('observed');
    expect(store.getMemory(candidate.id)?.status).toBe('active');
});

test('用户推测、错误结果、未注明条件、越界来源和无关结果不能自动生效', () => {
    for (const variant of ['user', 'inferred', 'error', 'scope', 'source', 'unrelated', 'assistant', 'order']) {
        const { store } = setup();
        const batch = correction(store, variant === 'error' ? { error: '仍然失败' } : { items: ['科技新闻'] });
        const memory = batch.memory;
        if (variant === 'user') memory.verifiedCorrection!.aboutUser = true;
        if (variant === 'inferred') memory.basis = 'inferred';
        if (variant === 'scope') memory.content = '所有榜单都用新地址读取';
        if (variant === 'source') memory.sourceEventIds = [batch.failure.id, batch.call.id];
        if (variant === 'order') memory.verifiedCorrection!.failureEventId = batch.result.id;
        if (variant === 'unrelated' || variant === 'assistant') {
            const unrelated = store.recordEvent({ actor: variant === 'assistant' ? 'agent' : 'tool:web_fetch',
                type: variant === 'assistant' ? 'assistant_message' : 'tool_result', runId: batch.call.runId,
                payload: { text: '我已经成功', result: { items: ['科技新闻'] } } });
            // 不能把未进入本批的事件冒充证据
            memory.verifiedCorrection!.resultEventId = unrelated.id;
        }
        store.completeReflections([batch.id], { memories: [memory], growth: [] });
        expect(store.search()[0]?.status).toBe('candidate');
    }
});

test('不同标题按目标 ID 增强同一成长候选，已处理或不可见目标不能增强', () => {
    const { store } = setup();
    const first = growthBatch(store, '网页地址选择需要改进');
    store.completeReflections([first.id], { memories: [], growth: [first.growth] });
    const original = store.listGrowth()[0]!;
    const second = growthBatch(store, '避免重复选择失效网页');
    store.completeReflections([second.id], { memories: [], growth: [{ ...second.growth, targetId: original.id }] }, [], [original]);
    expect(store.listGrowth()).toHaveLength(1);
    expect(store.listGrowth()[0]?.evidenceCount).toBe(2);
    expect(store.listGrowth()[0]?.title).toBe(original.title);
    const invisible = growthBatch(store, '另一个措辞描述地址失效');
    expect(store.completeReflections([invisible.id], { memories: [], growth: [{ ...invisible.growth, targetId: original.id }] })).toHaveLength(1);
    const shown = store.listGrowth()[0]!;
    store.resolveGrowth(original.id, 'dismissed');
    const third = growthBatch(store, original.title);
    expect(store.completeReflections([third.id], { memories: [], growth: [{ ...third.growth, targetId: original.id }] }, [], [shown])).toHaveLength(1);
    const fourth = growthBatch(store, original.title);
    store.completeReflections([fourth.id], { memories: [], growth: [fourth.growth] });
    expect(store.listGrowth()[0]?.status).toBe('dismissed');
    expect(store.listGrowth()[0]?.evidenceCount).toBe(2);
});

test('相关推测单独呈现，忘记后消失，不进入事实档案或普通召回', () => {
    const { store } = setup();
    const batch = growthBatch(store, '酒店安排');
    const eventId = batch.growth.sourceEventIds![0]!;
    store.completeReflections([batch.id], { memories: [{ kind: 'preference', content: '用户可能偏好安静酒店，尚待确认',
        basis: 'inferred', assertion: 'hypothetical', needsConfirmation: true, confidence: 0.7,
        importance: 0.7, sensitive: false, sourceEventIds: [eventId] }], growth: [] });
    const candidate = store.search('酒店')[0]!;
    expect(store.buildHypothesisContext('酒店')).toContain(candidate.id);
    expect(store.buildHypothesisContext('酒店')).toContain('candidate');
    expect(store.buildHypothesisContext('量子物理')).toBe('');
    expect(store.buildHypothesisContext('酒店', [eventId])).toBe('');
    expect(store.buildProfile()).not.toContain(candidate.content);
    expect(store.buildContext('酒店')).not.toContain(candidate.content);
    store.forget(candidate.id);
    expect(store.buildHypothesisContext('酒店')).toBe('');
});

test('Reflection 看到上一轮前台回复、相关记忆与成长候选，背景不会成为新来源', async () => {
    const { store, root } = setup();
    const first = growthBatch(store, '网页地址选择需要改进');
    store.completeReflections([first.id], { memories: [], growth: [first.growth] });
    const topic = store.createTopic({ title: '酒店安排' });
    const reply = store.recordEvent({ actor: 'agent', type: 'assistant_message', runId: 'previous',
        payload: { text: '要不要先修复网页地址选择，再安排酒店？', channel: 'foreground' } });
    store.recordEvent({ actor: 'agent', type: 'assistant_message', runId: 'background',
        payload: { text: '后台完成，不应作为回复对象', channel: 'background' } });
    const memory = store.remember({ kind: 'preference', content: '酒店安排需先比较位置', confidence: 1,
        importance: 1, sourceEventIds: [first.growth.sourceEventIds![0]!] });
    const event = store.recordEvent({ actor: 'user', type: 'user_message', runId: 'current',
        payload: { text: '这个暂时不用', channel: 'foreground' }, topicIds: [topic.id] });
    const model = new MockLanguageModelV4({ doGenerate: {
        content: [{ type: 'text', text: JSON.stringify({ memories: [], growth: [] }) }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
    } });
    const worker = new ReflectionWorker(store, () => ({ model, providerId: 'mock', modelId: 'mock',
        contextWindow: 32000, maxOutputTokens: 4096 }), new Logger(root), 0);
    try {
        worker.enqueue({ runId: 'current', eventIds: [event.id], outcome: 'completed' });
        await worker.waitForIdle();
        const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
        expect(prompt).toContain('要不要先修复网页地址选择');
        expect(prompt).not.toContain('后台完成，不应作为回复对象');
        expect(prompt).toContain(memory.id);
        expect(prompt).toContain(store.listGrowth()[0]!.id);
        expect(prompt).toContain('respondingEventNumber');
        expect(prompt).not.toContain(reply.id);
        const privateMemory = store.remember({ kind: 'fact', content: '忘记这次回复', confidence: 1,
            importance: 1, sourceEventIds: [reply.id] });
        store.forget(privateMemory.id);
        expect(store.previousAssistantReply(event)).toBeNull();
    } finally {
        worker.stop();
    }
});

test('Worker 将纠错证据编号绑定为真实事件，外部伪造 ID 不参与激活', async () => {
    const { store, root } = setup();
    const batch = correction(store);
    store.releaseReflections([batch.id]);
    const model = new MockLanguageModelV4({ doGenerate: {
        content: [{ type: 'text', text: JSON.stringify({ memories: [{ ...batch.memory,
            sourceEventNumbers: [1, 2, 3, 4], sourceEventIds: ['fabricated'],
            verifiedCorrection: { failureEventNumber: 2, correctionEventNumber: 3, resultEventNumber: 4,
                applicability: batch.memory.verifiedCorrection!.applicability,
                explanation: '结果包含实际所需榜单', aboutUser: false, resultEventId: 'fabricated' },
        }], growth: [] }) }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
    } });
    const worker = new ReflectionWorker(store, () => ({ model, providerId: 'mock', modelId: 'mock',
        contextWindow: 32000, maxOutputTokens: 4096 }), new Logger(root), 0);
    try {
        worker.start();
        await worker.waitForIdle();
        const learned = store.search('今日榜单')[0]!;
        expect(learned.status).toBe('active');
        expect(learned.sourceEventIds).not.toContain('fabricated');
        expect(learned.sourceEventIds).toContain(batch.result.id);
        expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).toContain('sourceEventNumber: 3');
    } finally {
        worker.stop();
    }
});

test('reinforce 不会把用户推测包装成 observed 后绕过确认，也不会偷换正文', () => {
    for (const inferred of [true, false]) {
        const { store } = setup();
        const first = correction(store);
        store.completeReflections([first.id], { memories: [{ ...first.memory,
            basis: inferred ? 'inferred' : 'observed', verifiedCorrection: undefined }], growth: [] });
        const candidate = store.search('今日榜单')[0]!;
        const next = correction(store);
        store.completeReflections([next.id], { memories: [{ ...next.memory,
            content: inferred ? next.memory.content : `${next.memory.content}，一律如此`,
            operation: 'reinforce', targetId: candidate.id }], growth: [] }, [candidate]);
        expect(store.getMemory(candidate.id)?.status).toBe('candidate');
    }
});
