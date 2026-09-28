import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryStore, type MemoryCandidate } from '../memory-store';

const roots: string[] = [];

/** 创建独立的记忆测试实例 */
function setup () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-learning-'));
    roots.push(root);
    return new MemoryStore(path.join(root, 'state.sqlite'));
}

/** 创建带本批真实来源的反思结果 */
function reflect (store: MemoryStore, text: string, proposal: Partial<MemoryCandidate> = {}) {
    const runId = crypto.randomUUID();
    const event = store.recordEvent({ actor: 'user', type: 'user_message', payload: { text }, runId });
    const id = store.enqueueReflection({ runId, eventIds: [event.id], outcome: 'completed' });
    store.claimReflection();
    store.completeReflections([id], { memories: [{
        kind: 'fact', content: text, confidence: 0.9, importance: 0.8, sensitive: false,
        basis: 'stated', assertion: 'established', needsConfirmation: false, sourceEventIds: [event.id], ...proposal,
    }], growth: [] }, proposal.targetId ? [store.getMemory(proposal.targetId)!] : []);
    return event;
}

afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

test('自然语言检索找回早期事实，工具正文不进入自动上下文', () => {
    const store = setup();
    reflect(store, '用户习惯在周五上午写周报');
    for (let i = 0; i < 30; i++) reflect(store, `用户完成其他工作事项 ${i}`);
    const event = store.recordEvent({ actor: 'tool:web_fetch', type: 'tool_result', payload: { text: '周报 HIDDEN_TOOL_BODY' } });
    store.remember({ kind: 'lesson', content: '周报格式需要核对', confidence: 1, importance: 0.5, sourceEventIds: [event.id] });
    expect(store.recallEpisode({ query: '帮我回忆一下通常什么时候写周报', limitMemories: 2 }).memories.some(m => m.content.includes('周五上午'))).toBe(true);
    expect(store.buildContext('周报')).not.toContain('HIDDEN_TOOL_BODY');
});

test('自动学习明确陈述，计划和推断保持候选，档案不依赖 query', () => {
    const store = setup();
    reflect(store, '用户习惯简洁的回答', { kind: 'preference', resident: true });
    reflect(store, '用户计划搬到杭州', { assertion: 'planned', resident: true });
    reflect(store, '用户可能喜欢昂贵酒店', { basis: 'inferred', resident: true });
    expect(store.search('简洁')[0]?.status).toBe('active');
    expect(store.search('搬到杭州')[0]?.status).toBe('candidate');
    expect(store.search('昂贵酒店')[0]?.status).toBe('candidate');
    expect(store.buildProfile()).toContain('简洁');
    expect(store.buildProfile()).not.toContain('杭州');
});

test('候选修订确认时关闭旧版本，过时的候选不能覆盖新认识', () => {
    const store = setup();
    reflect(store, '用户住在上海', { resident: true });
    const original = store.search('上海')[0]!;
    reflect(store, '用户住在杭州', { operation: 'update', targetId: original.id, revisionKind: 'world_change', validFrom: '2026-09-01', needsConfirmation: true });
    const candidate = store.search('杭州')[0]!;
    expect(store.getMemory(original.id)?.status).toBe('active');
    reflect(store, '用户住在苏州', { operation: 'update', targetId: original.id, revisionKind: 'correction' });
    const confirmation = store.recordEvent({ actor: 'user', type: 'user_message', payload: { text: '确认' } });
    expect(() => store.confirmMemory(candidate.id, [confirmation.id])).toThrow();
    expect(store.buildProfile()).toContain('苏州');
    expect(store.buildProfile()).not.toContain('上海');
});

test('遗忘阻止正在运行的反思通过混合新旧来源恢复认识', () => {
    const store = setup();
    const runId = crypto.randomUUID();
    const source = store.recordEvent({ actor: 'user', type: 'user_message', payload: { text: '用户喜欢蓝色' }, runId });
    const memory = store.remember({ kind: 'preference', content: '用户喜欢蓝色', confidence: 1, importance: 1, sourceEventIds: [source.id] });
    const fresh = store.recordEvent({ actor: 'user', type: 'user_message', payload: { text: '你好' }, runId });
    const id = store.enqueueReflection({ runId, eventIds: [source.id, fresh.id], outcome: 'completed' });
    store.claimReflection();
    store.forget(memory.id);
    store.completeReflections([id], { memories: [{ kind: 'preference', content: '用户喜欢蓝色', confidence: 1, importance: 1,
        sensitive: false, basis: 'stated', assertion: 'established', sourceEventIds: [source.id, fresh.id] }], growth: [] });
    expect(store.search('蓝色')).toHaveLength(0);
});

test('候选确认原子激活修订，重复证据不产生新版本', () => {
    const store = setup();
    reflect(store, '用户住在上海', { resident: true });
    const original = store.search('上海')[0]!;
    reflect(store, '用户住在杭州', { operation: 'update', targetId: original.id, revisionKind: 'world_change', validFrom: '2026-09-01', needsConfirmation: true });
    const candidate = store.search('杭州')[0]!;
    const confirmation = store.recordEvent({ actor: 'user', type: 'user_message', payload: { text: '确认已经搬家' } });
    const current = store.confirmMemory(candidate.id, [confirmation.id]);
    expect(store.getMemory(original.id)?.status).toBe('superseded');
    expect(current.resident).toBe(true);
    expect(store.buildProfile()).toContain('杭州');
    const extra = reflect(store, '再次确认用户住在杭州', { operation: 'reinforce', targetId: current.id });
    expect(store.search('杭州')).toHaveLength(1);
    expect(store.getMemory(current.id)?.sourceEventIds).toContain(extra.id);
});

test('检索先执行 Topic 与来源约束，再限制结果数量', () => {
    const store = setup();
    const topic = store.createTopic({ title: '家庭安排' });
    const source = reflect(store, '用户每周在周五安排写周报');
    const correct = store.search('周报')[0]!;
    store.linkMemoryTopic(correct.id, topic.id);
    for (let index = 0; index < 10; index++) reflect(store, `周报 周报 ${index}`);
    expect(store.recallEpisode({ query: '周报', topicIds: [topic.id], limitMemories: 1 }).memories.map(item => item.id)).toEqual([correct.id]);
    const excluded = store.search('周报', 100).filter(item => item.id !== correct.id).flatMap(item => item.sourceEventIds);
    expect(store.recallEpisode({ query: '周报', limitMemories: 1 }, excluded).memories[0]?.sourceEventIds).toContain(source.id);
});

test('来源文字命中可以召回字面不同的认识，不受近期无关记忆挤占', () => {
    const store = setup();
    const event = store.recordEvent({ actor: 'user', type: 'user_message', payload: { text: '针叶项目的负责人已经确认' } });
    const expected = store.remember({ kind: 'fact', content: '负责对接的人是小林', confidence: 1, importance: 1, sourceEventIds: [event.id] });
    for (let index = 0; index < 20; index++) reflect(store, `用户完成其他事项 ${index}`);
    expect(store.recallEpisode({ query: '针叶项目', limitMemories: 1 }).memories[0]?.id).toBe(expected.id);
});

test('模型自信、缺少提交判断或仅有助理证据，都不能自动激活', () => {
    const store = setup();
    reflect(store, '用户可能从事海洋研究', { needsConfirmation: undefined });
    expect(store.search('海洋研究')[0]?.status).toBe('candidate');
    const runId = crypto.randomUUID();
    const event = store.recordEvent({ actor: 'agent', type: 'assistant_message', payload: { text: '我认为用户喜欢徒步' }, runId });
    const id = store.enqueueReflection({ runId, eventIds: [event.id], outcome: 'completed' });
    store.claimReflection();
    store.completeReflections([id], { memories: [{ kind: 'preference', content: '用户喜欢徒步', confidence: 1, importance: 1,
        sensitive: false, basis: 'stated', assertion: 'established', needsConfirmation: false, sourceEventIds: [event.id] }], growth: [] });
    expect(store.search('徒步')[0]?.status).toBe('candidate');
});
