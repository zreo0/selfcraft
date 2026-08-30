import { describe, expect, test } from 'bun:test';
import {
    completeAgentActivity,
    createAgentActivity,
    failAgentActivity,
} from '../run-events';

describe('AgentRunEvent', () => {
    test('网络搜索只公开有界的候选结果，不把摘要正文当作来源', () => {
        const started = createAgentActivity('web_search', 'search-1', {
            query: '最近的 Agent 研究',
        });
        const completion = completeAgentActivity(started, {
            results: [{
                title: '研究报告',
                url: 'https://www.example.com/report',
                snippet: '这段摘要不应进入活动结构',
            }],
        }, 42);

        expect(completion).toEqual({
            activity: {
                id: 'search-1',
                kind: 'search',
                toolName: 'web_search',
                label: '搜索网络',
                target: '最近的 Agent 研究',
                state: 'success',
                durationMs: 42,
                results: [{
                    id: '1:https://www.example.com/report',
                    title: '研究报告',
                    domain: 'example.com',
                    url: 'https://www.example.com/report',
                }],
            },
            sources: [],
        });
    });

    test('只有实际读取的网页会成为来源', () => {
        const started = createAgentActivity('web_fetch', 'fetch-1', {
            url: 'https://docs.example.com/article',
        });
        const completion = completeAgentActivity(started, {
            url: 'https://docs.example.com/article',
            content: '已经读取的原文',
        });

        expect(completion.sources).toEqual([{
            id: 'fetch-1:source',
            url: 'https://docs.example.com/article',
            title: 'docs.example.com',
        }]);
        expect(failAgentActivity(started, 9)).toMatchObject({
            state: 'error',
            durationMs: 9,
        });
    });

    test('命令和写入正文不会进入可展示目标', () => {
        expect(createAgentActivity('shell', 'shell-1', {
            command: 'printenv SECRET',
        }).target).toBeUndefined();
        expect(createAgentActivity('write', 'write-1', {
            path: 'notes/today.md',
            content: '私密正文',
        }).target).toBe('notes/today.md');
    });
});
