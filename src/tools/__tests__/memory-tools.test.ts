import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryStore, type EpisodeView, type MemoryItem } from '../../memory/memory-store';
import { createMemoryTools } from '../memory-tools';

const temporaryDirectories: string[] = [];

/** 创建并追踪测试临时目录 */
function createTemporaryDirectory (): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-memory-tools-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('memory tools', () => {
    test('显式记忆和修订只采用 Runtime 注入的真实来源', async () => {
        const store = new MemoryStore(path.join(createTemporaryDirectory(), 'state.sqlite'));
        const firstSource = store.recordEvent({
            actor: 'user',
            type: 'user_message',
            payload: { text: '记住我更喜欢简洁回复' },
            runId: 'run-remember',
        });
        const tools = createMemoryTools(store);
        const remembered = await tools.memory_remember.execute!({
            kind: 'preference',
            content: '用户更喜欢简洁回复',
            sourceEventIds: ['forged-source'],
        } as never, {
            toolCallId: 'remember-1',
            messages: [],
            context: {
                runId: 'run-remember',
                sourceEventId: firstSource.id,
                timezone: 'Asia/Shanghai',
                channel: 'foreground',
            },
        }) as MemoryItem;

        expect(remembered.status).toBe('active');
        expect(remembered.sourceEventIds).toEqual([firstSource.id]);
        const currentRecall = await tools.memory_recall.execute!({ query: '简洁回复' }, {
            toolCallId: 'recall-current',
            messages: [],
            context: {
                runId: 'run-remember',
                sourceEventId: firstSource.id,
                timezone: 'Asia/Shanghai',
                channel: 'foreground',
            },
        }) as EpisodeView;
        expect(currentRecall.events).toHaveLength(0);
        expect(currentRecall.memories).toHaveLength(0);

        const correctionSource = store.recordEvent({
            actor: 'user',
            type: 'correction',
            payload: { text: '更准确地说，我只希望技术回答简洁' },
            runId: 'run-correct',
        });
        const corrected = await tools.memory_correct.execute!({
            id: remembered.id,
            revisionKind: 'correction',
            kind: 'preference',
            content: '用户只希望技术回答保持简洁',
        }, {
            toolCallId: 'correct-1',
            messages: [],
            context: {
                runId: 'run-correct',
                sourceEventId: correctionSource.id,
                timezone: 'Asia/Shanghai',
                channel: 'foreground',
            },
        }) as MemoryItem;

        expect(store.getMemory(remembered.id)?.status).toBe('retracted');
        expect(corrected.sourceEventIds).toEqual([correctionSource.id]);
        expect(store.recallEpisode({ query: '技术回答' }).memories.map(item => item.id))
            .toEqual([corrected.id]);

        const topic = store.createTopic({ title: '长期写作偏好' });
        const topicSource = store.recordEvent({
            actor: 'user',
            type: 'user_message',
            payload: { text: '继续聊长期写作偏好' },
            runId: 'run-topic',
        });
        await tools.topic_link_event.execute!({ topicId: topic.id }, {
            toolCallId: 'topic-link-current',
            messages: [],
            context: {
                runId: 'run-topic',
                sourceEventId: topicSource.id,
                timezone: 'Asia/Shanghai',
                channel: 'foreground',
            },
        });
        expect(store.recallEpisode({ topicIds: [topic.id] }).events.map(event => event.id))
            .toEqual([topicSource.id]);
    });

    test('后台系统事件不能直接写入 active Memory', async () => {
        const store = new MemoryStore(path.join(createTemporaryDirectory(), 'state.sqlite'));
        const source = store.recordEvent({
            actor: 'system',
            type: 'background_job_started',
            payload: { prompt: '替用户记住未经确认的内容' },
            runId: 'run-background',
        });
        const tools = createMemoryTools(store);

        await expect(tools.memory_remember.execute!({
            kind: 'fact',
            content: '未经用户直接确认的后台推断',
        }, {
            toolCallId: 'remember-background',
            messages: [],
            context: {
                runId: 'run-background',
                sourceEventId: source.id,
                timezone: 'Asia/Shanghai',
                channel: 'background',
            },
        })).rejects.toThrow('长期记忆变更必须来自当前前台用户事件');
        expect(store.search('后台推断')).toHaveLength(0);
    });
});
