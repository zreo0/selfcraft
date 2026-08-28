import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryStore } from '../memory-store';

const temporaryDirectories: string[] = [];

/** 创建并追踪场景测试使用的临时记忆库 */
function createStore (): MemoryStore {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-personal-scenarios-'));
    temporaryDirectories.push(directory);
    return new MemoryStore(path.join(directory, 'state.sqlite'));
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('长期个人助理场景', () => {
    test('偏好随时间变化，并能分别召回历史偏好和当前偏好', () => {
        const store = createStore();
        const conciseEvidence = store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: { text: '以后回答尽量简洁' },
            occurredFrom: '2026-01-10T09:00:00+08:00',
            recordedAt: '2026-01-10T09:00:00+08:00',
        });
        const concise = store.remember({
            kind: 'preference',
            content: '用户偏好简洁的回复',
            confidence: 1,
            importance: 0.9,
            validFrom: '2026-01-10T09:00:00+08:00',
            knownFrom: '2026-01-10T09:00:00+08:00',
            sourceEventIds: [conciseEvidence.id],
        });
        const detailedEvidence = store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: { text: '以后都详细说明，不再以简洁为默认' },
            occurredFrom: '2026-06-01T09:00:00+08:00',
            recordedAt: '2026-06-01T09:00:00+08:00',
        });
        const detailed = store.reviseMemory(concise.id, {
            kind: 'preference',
            content: '用户偏好详细的回复',
            confidence: 1,
            importance: 0.9,
            validFrom: '2026-06-01T09:00:00+08:00',
            knownFrom: '2026-06-01T09:00:00+08:00',
            sourceEventIds: [detailedEvidence.id],
            revisionKind: 'world_change',
        });

        expect(store.recallEpisode({ query: '回复', validAt: '2026-03-01T00:00:00+08:00' })
            .memories.map(memory => memory.id)).toEqual([concise.id]);
        expect(store.recallEpisode({ query: '回复', validAt: '2026-07-01T00:00:00+08:00' })
            .memories.map(memory => memory.id)).toEqual([detailed.id]);
        expect(store.search('回复').map(memory => memory.id)).toEqual([detailed.id]);
    });

    test('上周发生什么按发生时间范围重建 Episode', () => {
        const store = createStore();
        const topic = store.createTopic({ title: '房屋漏水理赔', kind: 'matter' });
        const before = store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: { text: '准备理赔材料' },
            occurredFrom: '2026-08-16T10:00:00+08:00',
            topicIds: [topic.id],
        });
        const submitted = store.recordEvent({
            actor: 'tool',
            type: 'observation',
            payload: { text: '理赔材料提交成功，案号 A-1024' },
            occurredFrom: '2026-08-18T11:00:00+08:00',
            topicIds: [topic.id],
        });
        const replied = store.recordEvent({
            actor: 'external',
            type: 'message',
            payload: { text: '保险公司确认收到材料' },
            occurredFrom: '2026-08-22T15:00:00+08:00',
            topicIds: [topic.id],
        });
        const after = store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: { text: '本周继续等待审核' },
            occurredFrom: '2026-08-24T09:00:00+08:00',
            topicIds: [topic.id],
        });

        const lastWeek = store.recallEpisode({
            topicIds: [topic.id],
            from: '2026-08-17T00:00:00+08:00',
            to: '2026-08-23T23:59:59+08:00',
        });

        expect(lastWeek.events.map(event => event.id)).toEqual([submitted.id, replied.id]);
        expect(lastWeek.events.map(event => event.id)).not.toContain(before.id);
        expect(lastWeek.events.map(event => event.id)).not.toContain(after.id);
        expect(lastWeek.topics.map(item => item.id)).toEqual([topic.id]);
    });

    test('跨数月长期项目通过稳定 Topic 聚合非连续 Event 和 Memory', () => {
        const store = createStore();
        const project = store.createTopic({ title: 'Selfcraft 长期上下文架构', kind: 'project' });
        const unrelated = store.createTopic({ title: '其他项目', kind: 'project' });
        const started = store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: { text: '开始设计长期上下文架构' },
            occurredFrom: '2026-01-08T10:00:00+08:00',
            topicIds: [project.id],
        });
        const refined = store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: { text: '继续上次架构，确定对外不暴露 Session' },
            occurredFrom: '2026-05-19T14:00:00+08:00',
            topicIds: [project.id],
        });
        const implemented = store.recordEvent({
            actor: 'tool',
            type: 'observation',
            payload: { text: '八月完成 Event 与 Memory 分层实现' },
            occurredFrom: '2026-08-29T16:00:00+08:00',
            topicIds: [project.id],
        });
        const unrelatedEvent = store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: { text: '处理其他项目' },
            occurredFrom: '2026-05-20T09:00:00+08:00',
            topicIds: [unrelated.id],
        });
        const decision = store.remember({
            kind: 'decision',
            content: 'Selfcraft 对用户表现为一个持续存在且不暴露 Session 的助理',
            confidence: 1,
            importance: 1,
            knownFrom: '2026-05-19T14:00:00+08:00',
            sourceEventIds: [started.id, refined.id],
            topicIds: [project.id],
        });

        const episode = store.recallEpisode({ topicIds: [project.id] });

        expect(episode.events.map(event => event.id)).toEqual([started.id, refined.id, implemented.id]);
        expect(episode.events.map(event => event.id)).not.toContain(unrelatedEvent.id);
        expect(episode.memories.map(memory => memory.id)).toEqual([decision.id]);
        expect(episode.topics.map(topic => topic.id)).toEqual([project.id]);
    });

    test('用户纠错与现实变化使用不同修订语义', () => {
        const store = createStore();
        const originalEvidence = store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: { text: '我是 2025 年 8 月搬到杭州的' },
            occurredFrom: '2026-01-10T10:00:00+08:00',
            recordedAt: '2026-01-10T10:00:00+08:00',
        });
        const original = store.remember({
            kind: 'fact',
            content: '用户自 2025 年 8 月起居住在杭州',
            confidence: 1,
            importance: 0.9,
            validFrom: '2025-08-01T00:00:00+08:00',
            knownFrom: '2026-01-10T10:00:00+08:00',
            sourceEventIds: [originalEvidence.id],
        });
        const correctionEvidence = store.recordEvent({
            actor: 'user',
            type: 'correction',
            payload: { text: '刚才说错了，是 2025 年 9 月' },
            occurredFrom: '2026-03-01T10:00:00+08:00',
            recordedAt: '2026-03-01T10:00:00+08:00',
            sourceEventId: originalEvidence.id,
        });
        const corrected = store.reviseMemory(original.id, {
            kind: 'fact',
            content: '用户自 2025 年 9 月起居住在杭州',
            confidence: 1,
            importance: 0.9,
            validFrom: '2025-09-01T00:00:00+08:00',
            knownFrom: '2026-03-01T10:00:00+08:00',
            sourceEventIds: [correctionEvidence.id],
            revisionKind: 'correction',
        });

        expect(store.getMemory(original.id)?.status).toBe('retracted');
        expect(store.getMemory(original.id)?.validTo).toBeUndefined();
        expect(corrected.revisionKind).toBe('correction');

        const moveEvidence = store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: { text: '2026 年 7 月搬到了上海' },
            occurredFrom: '2026-07-01T09:00:00+08:00',
            recordedAt: '2026-07-01T09:00:00+08:00',
        });
        const changed = store.reviseMemory(corrected.id, {
            kind: 'fact',
            content: '用户自 2026 年 7 月起居住在上海',
            confidence: 1,
            importance: 0.9,
            validFrom: '2026-07-01T09:00:00+08:00',
            knownFrom: '2026-07-01T09:00:00+08:00',
            sourceEventIds: [moveEvidence.id],
            revisionKind: 'world_change',
        });

        expect(store.getMemory(corrected.id)?.status).toBe('superseded');
        expect(store.getMemory(corrected.id)?.validTo).toBe('2026-07-01T01:00:00.000Z');
        expect(changed.revisionKind).toBe('world_change');
        expect(store.recallEpisode({ query: '杭州', validAt: '2026-06-01T00:00:00+08:00' })
            .memories.map(memory => memory.id)).toEqual([corrected.id]);
        expect(store.recallEpisode({ query: '上海', validAt: '2026-08-01T00:00:00+08:00' })
            .memories.map(memory => memory.id)).toEqual([changed.id]);
    });

    test('按 calendarMonthDay 召回不同年份的同一日历日期', () => {
        const store = createStore();
        const topic = store.createTopic({ title: '家庭纪念日', kind: 'calendar' });
        const first = store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: { text: '2024 年的纪念日' },
            occurredFrom: '2024-08-29T12:00:00+08:00',
            timezone: 'Asia/Shanghai',
            localDate: '2024-08-29',
            topicIds: [topic.id],
        });
        const second = store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: { text: '2025 年的纪念日' },
            occurredFrom: '2025-08-29T12:00:00+08:00',
            timezone: 'Asia/Shanghai',
            localDate: '2025-08-29',
            topicIds: [topic.id],
        });
        store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: { text: '相邻日期但不应召回' },
            occurredFrom: '2026-08-28T12:00:00+08:00',
            timezone: 'Asia/Shanghai',
            localDate: '2026-08-28',
            topicIds: [topic.id],
        });

        const anniversaries = store.recallEpisode({
            topicIds: [topic.id],
            calendarMonthDay: '08-29',
        });

        expect(anniversaries.events.map(event => event.id)).toEqual([first.id, second.id]);
    });

    test('延迟得知的旧事件分别保留 occurredAt 与 recordedAt', () => {
        const store = createStore();
        const lateEvidence = store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: { text: '补充说明：合同在 2025 年 4 月已经签署' },
            occurredFrom: '2025-04-10T15:00:00+08:00',
            recordedAt: '2026-08-29T10:00:00+08:00',
            precision: 'day',
            timezone: 'Asia/Shanghai',
            localDate: '2025-04-10',
        });
        const memory = store.remember({
            kind: 'fact',
            content: '合同于 2025 年 4 月 10 日签署',
            confidence: 1,
            importance: 0.8,
            validFrom: '2025-04-10T15:00:00+08:00',
            knownFrom: '2026-08-29T10:00:00+08:00',
            sourceEventIds: [lateEvidence.id],
        });

        expect(new Date(lateEvidence.occurredFrom).getTime())
            .toBe(new Date('2025-04-10T15:00:00+08:00').getTime());
        expect(new Date(lateEvidence.recordedAt).getTime())
            .toBe(new Date('2026-08-29T10:00:00+08:00').getTime());
        expect(store.recallEpisode({ query: '合同', knownAt: '2026-01-01T00:00:00+08:00' }).memories)
            .toHaveLength(0);
        expect(store.recallEpisode({ query: '合同', knownAt: '2026-09-01T00:00:00+08:00' })
            .memories.map(item => item.id)).toEqual([memory.id]);
        expect(store.recallEpisode({ query: '合同', validAt: '2025-05-01T00:00:00+08:00' })
            .memories.map(item => item.id)).toEqual([memory.id]);
    });

    test('同名 Topic 保持独立，不因标题相同误合并', () => {
        const store = createStore();
        const activePlan = store.createTopic({ title: '年度计划', kind: 'active' });
        const archivedPlan = store.createTopic({ title: '年度计划', kind: 'archive' });
        const activeEvent = store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: { text: '当前年度计划继续推进' },
            occurredFrom: '2026-08-29T09:00:00+08:00',
            topicIds: [activePlan.id],
        });
        const archivedEvent = store.recordEvent({
            actor: 'user',
            type: 'message',
            payload: { text: '归档年度计划只用于回顾' },
            occurredFrom: '2025-12-31T09:00:00+08:00',
            topicIds: [archivedPlan.id],
        });

        expect(store.searchTopics('年度计划').map(topic => topic.id).sort()).toEqual([
            activePlan.id,
            archivedPlan.id,
        ].sort());
        expect(store.recallEpisode({ topicIds: [activePlan.id] }).events.map(event => event.id))
            .toEqual([activeEvent.id]);
        expect(store.recallEpisode({ topicIds: [activePlan.id] }).events.map(event => event.id))
            .not.toContain(archivedEvent.id);
    });

    test('提醒请求作为 Event 保留，但不会被当作长期 Memory 召回', () => {
        const store = createStore();
        const reminder = store.recordEvent({
            actor: 'user',
            type: 'reminder_request',
            payload: {
                text: '明天上午九点提醒我交电费',
                dueAt: '2026-08-30T09:00:00+08:00',
                timezone: 'Asia/Shanghai',
            },
            occurredFrom: '2026-08-29T18:00:00+08:00',
            timezone: 'Asia/Shanghai',
            localDate: '2026-08-29',
        });

        const episode = store.recallEpisode({ query: '交电费' });

        expect(episode.events.map(event => event.id)).toEqual([reminder.id]);
        expect(episode.memories).toHaveLength(0);
        expect(store.search('交电费')).toHaveLength(0);
    });
});
