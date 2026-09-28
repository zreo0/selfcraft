import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryStore, type MemoryCandidate } from '../memory-store';

const instances: Array<{ root: string; db: Database }> = [];

/** 创建独立数据库，直接 SQL 用于模拟旧版本的写入 */
function setup () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-memory-regression-'));
    const file = path.join(root, 'state.sqlite');
    const store = new MemoryStore(file);
    const db = new Database(file);
    instances.push({ root, db });
    return { store, db, file };
}

/** 建立一批拥有真实用户证据的待提交反思 */
function batch (store: MemoryStore) {
    const runId = crypto.randomUUID();
    const event = store.recordEvent({ actor: 'user', type: 'user_message', payload: { text: '本次用户陈述' }, runId });
    const id = store.enqueueReflection({ runId, eventIds: [event.id], outcome: 'completed' });
    store.claimReflection();
    return { id, event };
}

/** 构造明确成立且无需确认的提议 */
function proposal (content: string, eventId: string): MemoryCandidate {
    return { kind: 'fact', content, confidence: 1, importance: 1, sensitive: false,
        basis: 'stated', assertion: 'established', needsConfirmation: false, sourceEventIds: [eventId] };
}

afterEach(() => {
    setSystemTime();
    for (const { root, db } of instances.splice(0)) {
        db.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('未来现实变化在生效时无缝切换档案和自动召回，历史查询保持原义', () => {
    setSystemTime(new Date('2026-09-01T00:00:00Z'));
    const { store } = setup();
    const initial = batch(store);
    const oldProfile = store.remember({ ...proposal('用户在甲公司工作', initial.event.id), resident: true });
    const oldRecall = store.remember(proposal('周报采用甲公司模板', initial.event.id));
    setSystemTime(new Date('2026-09-02T00:00:00Z'));
    const change = batch(store);
    const validFrom = '2026-10-01T00:00:00.000Z';
    const nextProfile = store.reviseMemory(oldProfile.id, {
        ...proposal('用户在乙公司工作', change.event.id), revisionKind: 'world_change', validFrom,
    });
    const nextRecall = store.reviseMemory(oldRecall.id, {
        ...proposal('周报采用乙公司模板', change.event.id), revisionKind: 'world_change', validFrom,
    });
    for (const time of ['2026-09-02T00:00:00Z', '2026-09-30T23:59:59.999Z', validFrom, '2026-10-02T00:00:00Z']) {
        setSystemTime(new Date(time));
        const after = new Date(time).getTime() >= new Date(validFrom).getTime();
        expect(store.buildProfile()).toContain(after ? nextProfile.content : oldProfile.content);
        expect(store.buildProfile()).not.toContain(after ? oldProfile.content : nextProfile.content);
        expect(store.recallEpisode({ query: '周报' }, [], true).memories.map(item => item.id))
            .toEqual([after ? nextRecall.id : oldRecall.id]);
    }
    expect(store.recallEpisode({ query: '公司', validAt: '2026-09-15' }).memories.map(item => item.id).sort())
        .toEqual([oldProfile.id, oldRecall.id].sort());
    expect(store.recallEpisode({ query: '公司', knownAt: '2026-09-01T12:00:00Z' }).memories.map(item => item.id).sort())
        .toEqual([oldProfile.id, oldRecall.id].sort());
});

test('跨事件重复 add 合并证据，不重复创建 active 认识', () => {
    const { store } = setup();
    const sources: string[] = [];
    for (const content of ['用户偏好 TypeScript', '  用户偏好   typescript  ']) {
        const pending = batch(store);
        sources.push(pending.event.id);
        store.completeReflections([pending.id], { memories: [proposal(content, pending.event.id)], growth: [] });
    }
    const memories = store.search('typescript');
    expect(memories).toHaveLength(1);
    expect(memories[0]?.status).toBe('active');
    expect(memories[0]?.sourceEventIds.sort()).toEqual(sources.sort());
});

test('重复候选只补证据，新的明确陈述满足原有规则后才激活', () => {
    const { store } = setup();
    const sources: string[] = [];
    for (const confirmed of [false, false, true]) {
        const pending = batch(store);
        sources.push(pending.event.id);
        store.completeReflections([pending.id], { memories: [{ ...proposal('用户住在上海', pending.event.id),
            basis: confirmed ? 'stated' : 'inferred', needsConfirmation: !confirmed }], growth: [] });
        const memories = store.search('上海');
        expect(memories).toHaveLength(1);
        expect(memories[0]?.status).toBe(confirmed ? 'active' : 'candidate');
        expect(memories[0]?.sourceEventIds.sort()).toEqual([...sources].sort());
    }
    expect(store.search('上海')[0]?.basis).toBe('stated');
});

test('同文 add 不跨事项、有效时间或全文不同的长内容合并', () => {
    const { store } = setup();
    const topicA = store.createTopic({ title: '项目甲' });
    const topicB = store.createTopic({ title: '项目乙' });
    const proposals: Array<Partial<MemoryCandidate>> = [
        { topicIds: [topicA.id], validFrom: '2026-09-01' },
        { topicIds: [topicB.id], validFrom: '2026-09-01' },
        { topicIds: [topicA.id], validFrom: '2026-10-01' },
        { content: '长正文'.repeat(1400) + '甲' },
        { content: '长正文'.repeat(1400) + '乙' },
    ];
    for (const details of proposals) {
        const pending = batch(store);
        store.completeReflections([pending.id], { memories: [{ ...proposal('项目已经完成', pending.event.id), ...details }], growth: [] });
    }
    expect(store.search()).toHaveLength(proposals.length);
});

test('重复 add 不把待确认的修订当作普通候选激活', () => {
    const { store } = setup();
    const initial = batch(store);
    const old = store.remember(proposal('用户住在上海', initial.event.id));
    store.completeReflections([initial.id], { memories: [], growth: [] });
    const update = batch(store);
    store.completeReflections([update.id], { memories: [{ ...proposal('用户住在杭州', update.event.id),
        operation: 'update', targetId: old.id, revisionKind: 'correction', needsConfirmation: true }], growth: [] }, [old]);
    const candidate = store.search('杭州')[0]!;
    const pending = batch(store);
    store.completeReflections([pending.id], { memories: [proposal(candidate.content, pending.event.id)], growth: [] });
    expect(store.getMemory(candidate.id)?.status).toBe('candidate');
    expect(store.getMemory(old.id)?.status).toBe('active');
});

test('旧事件的重复 add 不恢复已纠正的认识', () => {
    const { store } = setup();
    const pending = batch(store);
    const original = proposal('用户住在上海', pending.event.id);
    const old = store.remember(original);
    const correction = store.recordEvent({ actor: 'user', type: 'user_message', payload: { text: '说错了，其实住苏州' } });
    store.reviseMemory(old.id, { ...proposal('用户住在苏州', correction.id), revisionKind: 'correction' });
    store.completeReflections([pending.id], { memories: [original], growth: [] });
    expect(store.search('上海')).toHaveLength(0);
    expect(store.getMemory(old.id)?.status).toBe('retracted');
});

test('拒绝 candidate 和失效目标的 update，不影响同批合法新增和候选补证据', () => {
    const { store } = setup();
    const initial = batch(store);
    store.completeReflections([initial.id], { memories: [{ ...proposal('用户可能长期住上海', initial.event.id), needsConfirmation: true }], growth: [] });
    const candidate = store.search('上海')[0]!;
    const pending = batch(store);
    const notices = store.completeReflections([pending.id], { memories: [
        proposal('周报采用季度模板', pending.event.id),
        { ...proposal('用户住在杭州', pending.event.id), operation: 'update', targetId: candidate.id, revisionKind: 'correction' },
        { ...proposal('不存在的修订目标', pending.event.id), operation: 'update', targetId: crypto.randomUUID(), revisionKind: 'correction' },
        { ...proposal(candidate.content, pending.event.id), operation: 'reinforce', targetId: candidate.id },
    ], growth: [] }, [candidate]);
    expect(store.search('季度模板')[0]?.status).toBe('active');
    expect(store.search('杭州')).toHaveLength(0);
    expect(store.getMemory(candidate.id)?.status).toBe('candidate');
    expect(store.getMemory(candidate.id)?.sourceEventIds).toContain(pending.event.id);
    expect(notices).toHaveLength(2);
});

test('缺少现实变化时间时保留候选，确认后才关闭旧版本', () => {
    const { store } = setup();
    const initial = batch(store);
    const old = store.remember(proposal('用户住在上海', initial.event.id));
    store.completeReflections([initial.id], { memories: [], growth: [] });
    const pending = batch(store);
    store.completeReflections([pending.id], { memories: [
        proposal('用户每周五写周报', pending.event.id),
        { ...proposal('用户住在杭州', pending.event.id), operation: 'update', targetId: old.id, revisionKind: 'world_change' },
    ], growth: [] }, [old]);
    const next = store.search('杭州')[0]!;
    expect(next.status).toBe('candidate');
    expect(next.supersedesId).toBe(old.id);
    expect(store.getMemory(old.id)?.status).toBe('active');
    expect(store.search('周报')[0]?.status).toBe('active');
    expect(() => store.confirmMemory(next.id, [pending.event.id])).toThrow();
    store.confirmMemory(next.id, [pending.event.id], { validFrom: '2026-09-01' });
    expect(store.getMemory(old.id)?.status).toBe('superseded');
    expect(store.getMemory(next.id)?.status).toBe('active');
});

test('来源越界仍让整批失败，不留下半提交的认识', () => {
    const { store } = setup();
    const pending = batch(store);
    const outside = store.recordEvent({ actor: 'user', type: 'user_message', payload: { text: '批次外事件' } });
    expect(() => store.completeReflections([pending.id], { memories: [
        proposal('正常的周报资料', pending.event.id), proposal('不合法的住址证据', outside.id),
    ], growth: [] })).toThrow();
    expect(store.search('周报')).toHaveLength(0);
});

test('重新升级补齐旧代码写入的记忆和事件索引，重复启动不重复回填', () => {
    const { store, db, file } = setup();
    const now = new Date().toISOString();
    const source = crypto.randomUUID();
    const id = crypto.randomUUID();
    db.query(`INSERT INTO events(id,actor,event_type,payload,occurred_from,recorded_at,precision)
        VALUES(?,'user','user_message',?,?,?,'instant')`).run(source, JSON.stringify({ text: '用户养了一只猫' }), now, now);
    db.query(`INSERT INTO memories(id,kind,content,normalized_content,confidence,importance,status,known_from,created_at,updated_at)
        VALUES(?,'fact','用户养了一只猫','用户养了一只猫',1,1,'active',?,?,?)`).run(id, now, now, now);
    db.query('INSERT INTO memory_sources VALUES (?,?)').run(id, source);
    // 模拟未进入自动索引的旧工具正文
    db.query(`INSERT INTO events(id,actor,event_type,payload,occurred_from,recorded_at,precision)
        VALUES(?,'tool:web_fetch','tool_result',?,?,?,'instant')`).run(crypto.randomUUID(), JSON.stringify({ text: '猫 TOOL_SECRET' }), now, now);
    expect(store.search('猫')).toHaveLength(0);
    const reopened = new MemoryStore(file);
    expect(reopened.search('猫')[0]?.id).toBe(id);
    expect(reopened.buildContext('猫')).toContain('用户养了一只猫');
    expect(reopened.buildContext('猫')).not.toContain('TOOL_SECRET');
    new MemoryStore(file);
    expect(db.query('SELECT count(*) AS n FROM memory_fts').get()).toEqual({ n: 1 });
    expect(db.query('SELECT count(*) AS n FROM event_fts').get()).toEqual({ n: 1 });
});

test('大量来源不挤掉记忆正文，完整来源仍能主动查询', () => {
    const { store } = setup();
    const sources = Array.from({ length: 170 }, () => store.recordEvent({ actor: 'user', type: 'user_message', payload: { text: '确认这项资料' } }).id);
    const content = '每周汇报采用季度专用模板，交付前检查页脚归档编号';
    const memory = store.remember({ ...proposal(content, sources[0]!), sourceEventIds: sources });
    const context = store.buildContext('季度专用模板');
    expect(context).toContain(content);
    expect(context).toContain('170');
    expect(context.length).toBeLessThan(1000);
    expect(store.getMemory(memory.id)?.sourceEventIds).toHaveLength(170);
});

test('停用词查询只能召回匹配 Topic 的内容', () => {
    const { store } = setup();
    const topic = store.createTopic({ title: '我' });
    const related = store.recordEvent({ actor: 'user', type: 'user_message', payload: { text: '关联的生活记录' } });
    const memory = store.remember(proposal('关联的生活资料', related.id));
    store.linkEventTopic(related.id, topic.id);
    store.linkMemoryTopic(memory.id, topic.id);
    const unrelated = store.recordEvent({ actor: 'user', type: 'user_message', payload: { text: '无关的骑行记录' } });
    store.remember(proposal('无关的园艺资料', unrelated.id));
    const result = store.recallEpisode({ query: '我' });
    expect(result.events.map(event => event.id)).toEqual([related.id]);
    expect(result.memories.map(item => item.id)).toEqual([memory.id]);
});


test('单条错误日期不导致同批合法认识回滚', () => {
    const { store } = setup();
    const pending = batch(store);
    const notices = store.completeReflections([pending.id], { memories: [
        proposal('用户每周整理花园', pending.event.id),
        { ...proposal('带无效日期的搬家认识', pending.event.id), validFrom: '2026-02-30' },
        { ...proposal('带反向区间的搬家认识', pending.event.id), validFrom: '2026-10-01', validTo: '2026-09-01' },
    ], growth: [] });
    expect(store.search('花园')[0]?.status).toBe('active');
    expect(store.search('搬家')).toHaveLength(0);
    expect(notices).toHaveLength(2);
});
