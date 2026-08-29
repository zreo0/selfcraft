import { describe, expect, test } from 'bun:test';
import { TavilyWebProvider } from '../tavily-web-provider';

interface FetchCall {
    url: string;
    init?: RequestInit;
}

/** 创建记录请求并返回固定响应的 fetch 替身 */
function createFetch (response: Response): { calls: FetchCall[]; fetchFunction: typeof fetch } {
    const calls: FetchCall[] = [];
    const fetchFunction = Object.assign(async (input: URL | RequestInfo, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return response.clone();
    }, { preconnect: fetch.preconnect }) as typeof fetch;
    return { calls, fetchFunction };
}

describe('TavilyWebProvider', () => {
    test('使用基础参数搜索并返回与 Tavily 解耦的结果', async () => {
        const { calls, fetchFunction } = createFetch(Response.json({
            answer: '不应返回给 Agent',
            results: [{
                title: '官方公告',
                url: 'https://example.com/news',
                content: '公告摘要',
                score: 0.97,
                published_date: '2026-08-30',
            }],
            request_id: 'request-search',
            usage: { credits: 1 },
        }));
        const provider = new TavilyWebProvider(() => 'tvly-test-key', fetchFunction);

        const result = await provider.search({
            query: '最新公告',
            limit: 3,
            includeDomains: ['example.com'],
            from: '2026-08-01',
            to: '2026-08-30',
            language: 'zh-cn',
        });

        const body = JSON.parse(String(calls[0].init?.body));
        expect(calls[0].url).toBe('https://api.tavily.com/search');
        expect(new Headers(calls[0].init?.headers).get('authorization')).toBe('Bearer tvly-test-key');
        expect(body).toEqual({
            query: '最新公告',
            search_depth: 'basic',
            max_results: 3,
            include_answer: false,
            include_raw_content: false,
            include_images: false,
            include_usage: true,
            include_domains: ['example.com'],
            start_date: '2026-08-01',
            end_date: '2026-08-30',
            language: 'zh-cn',
            filter_by_language: false,
        });
        expect(result).toMatchObject({
            provider: 'tavily',
            query: '最新公告',
            results: [{
                title: '官方公告',
                url: 'https://example.com/news',
                snippet: '公告摘要',
                publishedAt: '2026-08-30',
            }],
            requestId: 'request-search',
            usageCredits: 1,
        });
        expect(JSON.stringify(result)).not.toContain('score');
        expect(JSON.stringify(result)).not.toContain('不应返回给 Agent');
    });

    test('读取公开网页并返回 Markdown 正文', async () => {
        const { calls, fetchFunction } = createFetch(Response.json({
            results: [{
                url: 'https://example.com/article',
                raw_content: '# 原始文章\n\n正文',
            }],
            failed_results: [],
            request_id: 'request-fetch',
            usage: { credits: 1 },
        }));
        const provider = new TavilyWebProvider(() => 'tvly-test-key', fetchFunction);

        const result = await provider.fetchPage('https://example.com/article#section');

        expect(calls[0].url).toBe('https://api.tavily.com/extract');
        expect(JSON.parse(String(calls[0].init?.body))).toEqual({
            urls: ['https://example.com/article'],
            extract_depth: 'basic',
            format: 'markdown',
            include_usage: true,
        });
        expect(result).toMatchObject({
            provider: 'tavily',
            url: 'https://example.com/article',
            content: '# 原始文章\n\n正文',
            requestId: 'request-fetch',
        });
    });

    test('拒绝本地与私有网络地址', async () => {
        const { calls, fetchFunction } = createFetch(Response.json({ results: [] }));
        const provider = new TavilyWebProvider(() => 'tvly-test-key', fetchFunction);

        await expect(provider.fetchPage('http://127.0.0.1/admin')).rejects.toThrow('私有网络');
        await expect(provider.fetchPage('http://localhost./admin')).rejects.toThrow('私有网络');
        await expect(provider.fetchPage('http://service.local/data')).rejects.toThrow('私有网络');
        await expect(provider.fetchPage('http://[::1]/')).rejects.toThrow('私有网络');
        expect(calls).toHaveLength(0);
    });

    test('把认证与额度错误转换为稳定消息', async () => {
        const unauthorized = createFetch(new Response('secret upstream body', { status: 401 }));
        const limited = createFetch(new Response('secret upstream body', { status: 429 }));

        await expect(new TavilyWebProvider(() => 'bad', unauthorized.fetchFunction).search({
            query: 'test',
            limit: 5,
        })).rejects.toThrow('Tavily API key 无效');
        await expect(new TavilyWebProvider(() => 'limited', limited.fetchFunction).search({
            query: 'test',
            limit: 5,
        })).rejects.toThrow('额度已用尽');
    });
});
