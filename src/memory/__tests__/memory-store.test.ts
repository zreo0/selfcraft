import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { Logger } from '../../logging/logger';
import { MemoryStore } from '../memory-store';
import { ReflectionWorker } from '../reflection-worker';

const temporaryDirectories: string[] = [];

/** 创建并追踪测试临时目录 */
function createTemporaryDirectory (): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-memory-'));
    temporaryDirectories.push(directory);
    return directory;
}

/** 创建使用独立 SQLite 文件的记忆存储 */
function createStore (): MemoryStore {
    return new MemoryStore(path.join(createTemporaryDirectory(), 'state.sqlite'));
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('MemoryStore 核心记忆内核', () => {
    test('同幂等键返回原事件，同内容的独立事件完整保留', () => {
        const store = createStore();
        const input = {
            actor: 'user',
            type: 'message',
            payload: { text: '今天跑了 5 公里' },
            occurredFrom: '2026-08-29T07:30:00+08:00',
            occurredTo: '2026-08-29T08:00:00+08:00',
            recordedAt: '2026-08-29T08:01:00+08:00',
            precision: 'minute' as const,
            timezone: 'Asia/Shanghai',
            localDate: '2026-08-29',
            runId: 'run-1',
            taskId: 'task-1',
            idempotencyKey: 'source-message-1',
        };

        const first = store.recordEvent(input);
        const duplicate = store.recordEvent({
            ...input,
            payload: { text: '重试时不应覆盖原负载' },
        });
        const secondOccurrence = store.recordEvent({
            ...input,
            occurredFrom: '2026-09-05T07:30:00+08:00',
            occurredTo: '2026-09-05T08:00:00+08:00',
            localDate: '2026-09-05',
            idempotencyKey: undefined,
        });

        expect(duplicate.id).toBe(first.id);
        expect(duplicate.payload).toEqual({ text: '今天跑了 5 公里' });
        expect(secondOccurrence.id).not.toBe(first.id);
        expect(first.precision).toBe('minute');
        expect(first.timezone).toBe('Asia/Shanghai');
        expect(first.occurredFrom).toBe('2026-08-28T23:30:00.000Z');
        expect(first.occurredTo).toBe('2026-08-29T00:00:00.000Z');
        expect(first.recordedAt).toBe('2026-08-29T00:01:00.000Z');
        expect(first.localDate).toBe('2026-08-29');
        expect(first.runId).toBe('run-1');
        expect(first.taskId).toBe('task-1');
        expect(store.recallEpisode({ query: '跑了 5 公里' }).events.map(event => event.id)).toEqual([
            first.id,
            secondOccurrence.id,
        ]);
        expect(store.buildContext('今天跑了 5 公里', [first.id])).not.toContain(first.id);
    });

    test('拒绝会被 JavaScript 自动归一化的无效日历日期', () => {
        const store = createStore();

        expect(() => store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: '不存在的日期',
            occurredFrom: '2026-02-30',
        })).toThrow('事件发生时间无效');
        expect(() => store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: '空格不能替代 ISO 的 T',
            occurredFrom: '2026-02-30 10:00:00+08:00',
        })).toThrow('事件发生时间无效');
        expect(() => store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: '月份和日期必须补零',
            occurredFrom: '2026-2-30',
        })).toThrow('事件发生时间无效');
        expect(() => store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: '本地时间不能依赖宿主机解释',
            occurredFrom: '2026-08-29T09:00:00',
            timezone: 'America/New_York',
        })).toThrow('事件发生时间无效');
        expect(() => store.recallEpisode({ calendarMonthDay: '02-30' }))
            .toThrow('calendarMonthDay 必须是有效的 MM-DD');
    });

    test('Topic 允许同名并组织跨时间的非连续事件和记忆', () => {
        const store = createStore();
        const primary = store.createTopic({ title: '母亲术后恢复', kind: 'matter' });
        const sameName = store.createTopic({ title: '母亲术后恢复', kind: 'archive' });
        const first = store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: { text: '一月完成了膝盖手术' },
            occurredFrom: '2025-01-12T10:00:00+08:00',
            timezone: 'Asia/Shanghai',
            localDate: '2025-01-12',
        });
        const recent = store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: { text: '今天复查，恢复情况不错' },
            occurredFrom: '2026-08-29T09:00:00+08:00',
            timezone: 'Asia/Shanghai',
            localDate: '2026-08-29',
        });
        const unrelated = store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: { text: '另一个同名归档事项' },
            occurredFrom: '2026-08-29T10:00:00+08:00',
            localDate: '2026-08-29',
        });
        store.linkEventTopic(first.id, primary.id);
        store.linkEventTopic(recent.id, primary.id);
        store.linkEventTopic(unrelated.id, sameName.id);
        const memory = store.remember({
            kind: 'lesson',
            content: '母亲的膝盖术后恢复整体顺利',
            confidence: 1,
            importance: 0.9,
            validFrom: '2025-01-12',
            sourceEventIds: [first.id, recent.id],
            topicIds: [primary.id],
        });

        expect(store.searchTopics('术后恢复').map(topic => topic.id).sort()).toEqual([
            primary.id,
            sameName.id,
        ].sort());
        expect(store.searchTopics('母亲恢复').map(topic => topic.id).sort()).toEqual([
            primary.id,
            sameName.id,
        ].sort());
        const episode = store.recallEpisode({ topicIds: [primary.id] });
        expect(episode.events.map(event => event.id)).toEqual([first.id, recent.id]);
        expect(episode.memories.map(item => item.id)).toEqual([memory.id]);
        expect(memory.validFrom).toBe('2025-01-12T00:00:00.000Z');
        expect(episode.topics.map(topic => topic.id)).toEqual([primary.id]);

        const anniversary = store.recallEpisode({
            topicIds: [primary.id],
            calendarMonthDay: '08-29',
        });
        expect(anniversary.events.map(event => event.id)).toEqual([first.id, recent.id]);
    });

    test('Reflection 高置信候选不会自动激活，显式记忆才进入上下文', () => {
        const store = createStore();
        const source = store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: { text: '一次不足以确认的推断' },
            runId: 'run-reflection',
        });
        const reflectionId = store.enqueueReflection({
            runId: 'run-reflection',
            eventIds: [source.id],
            outcome: 'completed',
        });
        const job = store.claimReflection();
        expect(job?.id).toBe(reflectionId);
        store.completeReflection(reflectionId, {
            memories: [{
                kind: 'lesson',
                content: '模型推断用户会长期居住月球基地',
                confidence: 0.99,
                importance: 0.9,
                sensitive: false,
            }],
            growth: [{
                kind: 'runtime',
                title: '检查长期推断质量',
                observation: '需要避免单轮高置信推断直接激活',
                evidence: '本次 Reflection',
                confidence: 0.8,
            }],
        });
        const candidate = store.search('月球基地')[0];
        const confirmedSource = store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: { text: '我偏好简洁且可验证的设计' },
        });
        const confirmed = store.remember({
            kind: 'preference',
            content: '用户偏好简洁且可验证的设计',
            confidence: 1,
            importance: 0.9,
            sourceEventIds: [confirmedSource.id],
        });

        expect(candidate.status).toBe('candidate');
        expect(candidate.sourceEventIds).toEqual([source.id]);
        expect(confirmed.status).toBe('active');
        expect(store.listGrowth('proposed')).toHaveLength(1);
        expect(store.recallEpisode({ query: '月球基地' }).memories).toHaveLength(0);
        expect(store.buildContext('月球基地')).not.toContain(candidate.content);
        expect(store.buildContext('简洁且可验证的设计')).toContain(confirmed.content);
        expect(store.buildContext('简洁且可验证的设计')).not.toContain('conversation-summary');
        expect(() => store.remember({
            kind: 'fact',
            content: '没有来源的已确认记忆',
            confidence: 1,
            importance: 0.5,
        })).toThrow('已确认记忆必须引用来源事件');
        expect(() => store.reviseMemory(candidate.id, {
            kind: 'lesson',
            content: '不能绕过确认激活候选',
            confidence: 1,
            importance: 0.8,
            sourceEventIds: [confirmedSource.id],
            revisionKind: 'correction',
        })).toThrow('只能修订当前 active 记忆');

        const confirmationSource = store.recordEvent({
            actor: 'user',
            type: 'confirmation',
            payload: { text: '月球基地这条候选是对的，请记住' },
            occurredFrom: '2099-01-01T09:00:00+08:00',
            recordedAt: '2099-01-01T09:00:00+08:00',
        });
        const candidateTopic = store.createTopic({ title: '月球居住计划' });
        const activated = store.confirmMemory(candidate.id, [confirmationSource.id], {
            validFrom: '2025-01-01',
            topicIds: [candidateTopic.id],
        });
        expect(activated.status).toBe('active');
        expect(activated.knownFrom).toBe('2099-01-01T01:00:00.000Z');
        expect(activated.validFrom).toBe('2025-01-01T00:00:00.000Z');
        expect(activated.topicIds).toEqual([candidateTopic.id]);
        expect(activated.sourceEventIds).toHaveLength(2);
        expect(activated.sourceEventIds).toEqual(expect.arrayContaining([source.id, confirmationSource.id]));
        expect(store.recallEpisode({ query: '月球基地', knownAt: '2098-12-31' }).memories)
            .toHaveLength(0);
        expect(store.recallEpisode({ query: '月球基地', knownAt: '2099-01-02' }).memories
            .map(memory => memory.id)).toEqual([candidate.id]);
        expect(store.recallEpisode({ topicIds: [candidateTopic.id] }).memories
            .map(memory => memory.id)).toEqual([candidate.id]);
        expect(store.buildContext('月球基地')).toContain(candidate.content);
    });

    test('纠错与现实变化保留不同的双时间修订语义', () => {
        const store = createStore();
        const originalEvidence = store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: { text: '我是去年八月搬到杭州的' },
            occurredFrom: '2026-01-10T10:00:00+08:00',
        });
        const correctionEvidence = store.recordEvent({
            actor: 'user',
            type: 'correction',
            payload: { text: '不是八月，是九月' },
            occurredFrom: '2026-03-01T10:00:00+08:00',
        });
        const moveEvidence = store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: { text: '七月搬到了上海' },
            occurredFrom: '2026-07-01T10:00:00+08:00',
        });
        const original = store.remember({
            kind: 'fact',
            content: '用户自 2025 年 8 月起居住在杭州',
            confidence: 1,
            importance: 0.9,
            validFrom: '2025-08-01',
            knownFrom: '2026-01-10',
            sourceEventIds: [originalEvidence.id],
        });
        const corrected = store.reviseMemory(original.id, {
            kind: 'fact',
            content: '用户自 2025 年 9 月起居住在杭州',
            confidence: 1,
            importance: 0.9,
            validFrom: '2025-09-01',
            knownFrom: '2026-03-01',
            sourceEventIds: [correctionEvidence.id],
            revisionKind: 'correction',
        });

        expect(store.getMemory(original.id)?.status).toBe('retracted');
        expect(store.getMemory(original.id)?.knownTo).toBe('2026-03-01T00:00:00.000Z');
        expect(corrected.supersedesId).toBe(original.id);
        expect(corrected.revisionKind).toBe('correction');
        expect(store.recallEpisode({ query: '杭州', knownAt: '2026-02-01' }).memories.map(item => item.id))
            .toEqual([original.id]);
        expect(store.recallEpisode({ query: '杭州', knownAt: '2026-04-01' }).memories.map(item => item.id))
            .toEqual([corrected.id]);

        expect(() => store.reviseMemory(corrected.id, {
            kind: 'fact',
            content: '用户现在居住在上海',
            confidence: 1,
            importance: 0.9,
            sourceEventIds: [moveEvidence.id],
            revisionKind: 'world_change',
        })).toThrow('现实变化必须提供开始生效时间');
        expect(() => store.reviseMemory(corrected.id, {
            kind: 'fact',
            content: '用户更早就居住在上海',
            confidence: 1,
            importance: 0.9,
            validFrom: '2025-08-01',
            sourceEventIds: [moveEvidence.id],
            revisionKind: 'world_change',
        })).toThrow('现实变化生效时间必须晚于旧版本起点');

        const changed = store.reviseMemory(corrected.id, {
            kind: 'fact',
            content: '用户自 2026 年 7 月起居住在上海',
            confidence: 1,
            importance: 0.9,
            validFrom: '2026-07-01',
            knownFrom: '2026-07-01',
            sourceEventIds: [moveEvidence.id],
            revisionKind: 'world_change',
        });

        expect(store.getMemory(corrected.id)?.status).toBe('superseded');
        expect(store.getMemory(corrected.id)?.validTo).toBe('2026-07-01T00:00:00.000Z');
        expect(changed.revisionKind).toBe('world_change');
        expect(() => store.reviseMemory(corrected.id, {
            kind: 'fact',
            content: '不允许从旧版本继续分叉',
            confidence: 1,
            importance: 0.9,
            validFrom: '2026-08-01',
            sourceEventIds: [moveEvidence.id],
            revisionKind: 'world_change',
        })).toThrow('只能修订当前 active 记忆');
        expect(store.recallEpisode({ query: '杭州', validAt: '2026-06-01' }).memories.map(item => item.id))
            .toEqual([corrected.id]);
        expect(store.recallEpisode({ query: '上海', validAt: '2026-08-01' }).memories.map(item => item.id))
            .toEqual([changed.id]);
        expect(store.recallEpisode({ query: '杭州' }).memories).toHaveLength(0);
        expect(store.recallEpisode({ query: '杭州', knownAt: '2026-02-01' }).memories.map(item => item.id))
            .toEqual([original.id]);
        expect(store.recallEpisode({ query: '杭州', knownAt: '2026-04-01' }).memories.map(item => item.id))
            .toEqual([corrected.id]);
    });

    test('软忘记保留记录，硬删除事件会删除直接派生的记忆', () => {
        const store = createStore();
        const topic = store.createTopic({ title: '一次私密经历' });
        const event = store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: { text: '需要彻底删除的原始经历' },
            occurredFrom: '2026-08-29T12:00:00+08:00',
            topicIds: [topic.id],
        });
        const derived = store.remember({
            kind: 'lesson',
            content: '从私密经历中提取出的认识',
            confidence: 1,
            importance: 0.9,
            sourceEventIds: [event.id],
            topicIds: [topic.id],
        });
        const independentSource = store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: { text: '这是一条之后需要软忘记的偏好' },
        });
        const independent = store.remember({
            kind: 'preference',
            content: '仅需要软忘记的偏好',
            confidence: 1,
            importance: 0.7,
            sourceEventIds: [independentSource.id],
        });

        expect(store.forget(independent.id)).toBe(true);
        expect(store.getMemory(independent.id)?.status).toBe('forgotten');
        expect(store.search('软忘记')).toHaveLength(0);
        expect(store.recallEpisode({ query: '软忘记', knownAt: new Date().toISOString() }).memories)
            .toHaveLength(0);
        const result = store.eraseEvent(event.id);
        expect(result).toEqual({ erased: true, erasedMemoryIds: [derived.id] });
        expect(store.getEvent(event.id)).toBeNull();
        expect(store.getMemory(derived.id)).toBeNull();
        expect(store.getTopic(topic.id)).not.toBeNull();
    });

    test('事件、Topic、记忆和关系可在重启后恢复', () => {
        const root = createTemporaryDirectory();
        const databasePath = path.join(root, 'state.sqlite');
        const first = new MemoryStore(databasePath);
        const topic = first.createTopic({ title: '跨重启事项' });
        const event = first.recordEvent({
            actor: 'tool',
            type: 'observation',
            payload: { result: '已完成' },
            occurredFrom: '2026-08-29T15:00:00+08:00',
            idempotencyKey: 'restart-event',
            topicIds: [topic.id],
        });
        const memory = first.remember({
            kind: 'lesson',
            content: '跨重启事项已经完成',
            confidence: 1,
            importance: 0.8,
            sourceEventIds: [event.id],
            topicIds: [topic.id],
        });

        const restored = new MemoryStore(databasePath);
        const episode = restored.recallEpisode({ topicIds: [topic.id] });
        expect(episode.events.map(item => item.id)).toEqual([event.id]);
        expect(episode.memories.map(item => item.id)).toEqual([memory.id]);
        expect(restored.recordEvent({
            actor: 'tool',
            type: 'observation',
            payload: { result: '重复投递' },
            idempotencyKey: 'restart-event',
        }).id).toBe(event.id);
    });

    test('中文片段查询可召回中间有修饰词的事件与记忆', () => {
        const store = createStore();
        const event = store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: { text: '我希望方案保持简洁，同时具备可验证的系统设计' },
        });
        const memory = store.remember({
            kind: 'preference',
            content: '用户偏好简洁且可验证的系统设计',
            confidence: 1,
            importance: 0.8,
            sourceEventIds: [event.id],
        });

        const episode = store.recallEpisode({ query: '简洁设计' });
        expect(episode.events.map(item => item.id)).toContain(event.id);
        expect(episode.memories.map(item => item.id)).toContain(memory.id);
    });

    test('纯时间范围只通过命中事件补齐相关记忆', () => {
        const store = createStore();
        const oldSource = store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: '用户一直偏好安静环境',
            occurredFrom: '2025-01-01',
        });
        const unrelated = store.remember({
            kind: 'preference',
            content: '用户偏好安静环境',
            confidence: 1,
            importance: 0.8,
            sourceEventIds: [oldSource.id],
        });
        const inRange = store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: '本周提交了保险材料',
            occurredFrom: '2026-08-20T10:00:00+08:00',
        });
        const related = store.remember({
            kind: 'fact',
            content: '用户已经提交保险材料',
            confidence: 1,
            importance: 0.7,
            sourceEventIds: [inRange.id],
        });

        const episode = store.recallEpisode({
            from: '2026-08-17',
            to: '2026-08-23T23:59:59+08:00',
        });
        expect(episode.memories.map(memory => memory.id)).toEqual([related.id]);
        expect(episode.memories.map(memory => memory.id)).not.toContain(unrelated.id);
    });

    test('Episode 会补回不在直接 Topic 与时间过滤内的 Memory 来源事件', () => {
        const store = createStore();
        const topic = store.createTopic({ title: '年度健康计划' });
        const source = store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: { text: '复盘后确认一月份已经开始年度健康计划' },
            occurredFrom: '2025-12-20T10:00:00+08:00',
        });
        const direct = store.recordEvent({
            actor: 'user',
            type: 'progress',
            payload: { text: '一月份继续执行年度健康计划' },
            occurredFrom: '2026-01-15T10:00:00+08:00',
            topicIds: [topic.id],
        });
        const memory = store.remember({
            kind: 'decision',
            content: '年度健康计划从一月份开始执行',
            confidence: 1,
            importance: 0.8,
            validFrom: '2026-01-01T00:00:00+08:00',
            validTo: '2026-01-31T23:59:59+08:00',
            sourceEventIds: [source.id],
            topicIds: [topic.id],
        });

        const episode = store.recallEpisode({
            topicIds: [topic.id],
            from: '2026-01-01T00:00:00+08:00',
            to: '2026-01-31T23:59:59+08:00',
            limitEvents: 1,
        });

        expect(source.topicIds).toEqual([]);
        expect(episode.memories.map(item => item.id)).toEqual([memory.id]);
        expect(episode.events.map(item => item.id)).toEqual([source.id, direct.id]);
    });

    test('Reflection Worker 只从本轮真实事件渲染并绑定来源', async () => {
        const store = createStore();
        const event = store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: { text: '我长期偏好短而准确的回答' },
            runId: 'run-worker',
        });
        const model = new MockLanguageModelV4({
            doGenerate: {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        memories: [{
                            kind: 'preference',
                            content: '用户长期偏好短而准确的回答',
                            confidence: 0.9,
                            importance: 0.8,
                            sensitive: false,
                            sourceEventIds: ['fabricated-event'],
                        }],
                        growth: [],
                    }),
                }],
                finishReason: { unified: 'stop', raw: undefined },
                usage: {
                    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
                    outputTokens: { total: 1, text: 1, reasoning: undefined },
                },
                warnings: [],
            },
        });
        const worker = new ReflectionWorker(store, () => ({
            model,
            providerId: 'test',
            modelId: 'test',
            contextWindow: 10000,
            maxOutputTokens: 1000,
        }), new Logger(createTemporaryDirectory()));

        worker.enqueue({ runId: 'run-worker', eventIds: [event.id], outcome: 'completed' });
        await worker.waitForIdle();
        worker.stop();

        const candidate = store.search('短而准确')[0];
        expect(candidate.status).toBe('candidate');
        expect(candidate.sourceEventIds).toEqual([event.id]);
        const prompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
        expect(prompt).toContain(event.id);
        expect(prompt).toContain('我长期偏好短而准确的回答');
    });

    test('Reflection 拒绝引用其他运行的事件', () => {
        const store = createStore();
        const event = store.recordEvent({
            actor: 'assistant',
            type: 'message',
            payload: { text: '完成' },
            runId: 'run-a',
        });

        expect(() => store.enqueueReflection({
            runId: 'run-b',
            eventIds: [event.id],
            outcome: 'completed',
        })).toThrow('Reflection 必须引用本轮存在的来源事件');
    });
});
