import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryStore, type EpisodeView, type EventInput } from '../../memory/memory-store';
import { createTools } from '..';

const temporaryDirectories: string[] = [];

/** 创建并追踪工具测试目录 */
function createTemporaryDirectory (): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-tool-timeline-'));
    temporaryDirectories.push(directory);
    return directory;
}

/** 只实现时间线包装测试所需的 MemoryStore 边界 */
class FakeTimelineMemory {
    /** 成功写入的事件 */
    public readonly events: EventInput[] = [];

    /**
     * 创建可按事件类型模拟审计失败的存储
     *
     * @param failedAuditType 需要抛错的审计事件类型
     * @param toolFails 底层 memory_search 是否失败
     */
    constructor (
        private readonly failedAuditType: string,
        private readonly toolFails = false,
    ) {}

    /**
     * 写入测试事件或模拟审计失败
     *
     * @param event 待写入事件
     * @returns 测试事件标识
     */
    public recordEvent (event: EventInput): { id: string } {
        if (event.type === this.failedAuditType) {
            throw new Error(`${event.type} 审计失败`);
        }
        this.events.push(event);
        return { id: `event-${this.events.length}` };
    }

    /**
     * 执行 memory_search 的测试替身
     *
     * @returns 空结果或抛出真实工具错误
     */
    public search (): [] {
        if (this.toolFails) {
            throw new Error('真实工具失败');
        }
        return [];
    }
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('tool timeline', () => {
    test('显式召回不会把当前运行的工具事件当成历史', async () => {
        const root = createTemporaryDirectory();
        const memory = new MemoryStore(path.join(root, 'state.sqlite'));
        const source = memory.recordEvent({
            actor: 'user',
            type: 'user_message',
            payload: { text: '回顾保险材料' },
            runId: 'run-recall',
        });
        const tools = createTools(
            root,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            memory,
        );

        const episode = await tools.memory_recall.execute!({ query: '保险材料' }, {
            toolCallId: 'recall-current-run',
            messages: [],
            context: {
                runId: 'run-recall',
                sourceEventId: source.id,
                timezone: 'Asia/Shanghai',
                channel: 'foreground',
            },
        }) as EpisodeView;

        expect(episode.events).toHaveLength(0);
        expect(memory.listEventsByRun('run-recall').map(event => event.type)).toEqual([
            'user_message',
            'tool_call',
            'tool_result',
        ]);
    });

    test('结果审计失败不改写成功的工具结果', async () => {
        const memory = new FakeTimelineMemory('tool_result');
        const tools = createTools(
            createTemporaryDirectory(),
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            memory as never,
        );

        const result = await tools.memory_search.execute!({}, {
            toolCallId: 'search-success',
            messages: [],
            context: {
                runId: 'run-success',
                sourceEventId: 'source-success',
                timezone: 'Asia/Shanghai',
                channel: 'foreground',
            },
        });

        expect(result).toEqual([]);
        expect(memory.events.map(event => event.type)).toEqual(['tool_call']);
    });

    test('错误审计失败不遮蔽真实工具错误', async () => {
        const memory = new FakeTimelineMemory('tool_error', true);
        const tools = createTools(
            createTemporaryDirectory(),
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            memory as never,
        );

        await expect(tools.memory_search.execute!({}, {
            toolCallId: 'search-failure',
            messages: [],
            context: {
                runId: 'run-failure',
                sourceEventId: 'source-failure',
                timezone: 'Asia/Shanghai',
                channel: 'foreground',
            },
        })).rejects.toThrow('真实工具失败');
        expect(memory.events.map(event => event.type)).toEqual(['tool_call']);
    });

    test('截断搜索结果仍保留刷新展示所需的候选来源', async () => {
        const root = createTemporaryDirectory();
        const memory = new MemoryStore(path.join(root, 'state.sqlite'));
        const source = memory.recordEvent({
            actor: 'user',
            type: 'user_message',
            payload: { text: '搜索资料' },
            runId: 'run-large-search',
        });
        const tools = createTools(
            root,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            memory,
            undefined,
            {
                async search (input) {
                    return {
                        provider: 'test',
                        query: input.query,
                        searchedAt: new Date().toISOString(),
                        results: Array.from({ length: 5 }, (_, index) => ({
                            title: `候选 ${index + 1}`,
                            url: `https://example.com/${index + 1}`,
                            snippet: 'x'.repeat(800),
                        })),
                    };
                },
                async fetchPage () {
                    throw new Error('本测试不会读取网页');
                },
            },
        );

        await tools.web_search.execute!({ query: '测试候选' }, {
            toolCallId: 'large-search',
            messages: [],
            context: {
                runId: 'run-large-search',
                sourceEventId: source.id,
                timezone: 'Asia/Shanghai',
                channel: 'foreground',
            },
        });

        const resultEvent = memory.listEventsByRun('run-large-search')
            .find(event => event.type === 'tool_result');
        const result = (resultEvent?.payload as { result?: Record<string, unknown> })?.result;
        expect(result?.truncated).toBeTrue();
        expect(result?.results).toEqual(Array.from({ length: 5 }, (_, index) => ({
            title: `候选 ${index + 1}`,
            url: `https://example.com/${index + 1}`,
        })));
        expect((result?.results as Array<Record<string, unknown>>)[0]?.snippet).toBeUndefined();
    });
});
