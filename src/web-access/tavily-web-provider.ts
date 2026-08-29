import { isIP } from 'node:net';
import { z } from 'zod';
import type {
    WebPageResult,
    WebProvider,
    WebSearchInput,
    WebSearchResult,
} from './web-provider';

const SEARCH_ENDPOINT = 'https://api.tavily.com/search';
const EXTRACT_ENDPOINT = 'https://api.tavily.com/extract';

const searchResponseSchema = z.object({
    results: z.array(z.object({
        title: z.string(),
        url: z.string().url(),
        content: z.string(),
        published_date: z.string().nullable().optional(),
    }).passthrough()),
    request_id: z.string().optional(),
    usage: z.object({
        credits: z.number().nonnegative().optional(),
    }).passthrough().optional(),
}).passthrough();

const extractResponseSchema = z.object({
    results: z.array(z.object({
        url: z.string().url(),
        raw_content: z.string(),
    }).passthrough()),
    request_id: z.string().optional(),
    usage: z.object({
        credits: z.number().nonnegative().optional(),
    }).passthrough().optional(),
}).passthrough();

/** Tavily 的基础搜索与网页读取实现 */
export class TavilyWebProvider implements WebProvider {
    /**
     * 创建 Tavily 实现
     *
     * @param resolveApiKey 每次请求读取当前凭证
     * @param fetchFunction HTTP 请求实现
     */
    constructor (
        private readonly resolveApiKey: () => string,
        private readonly fetchFunction: typeof fetch = fetch,
    ) {}

    /**
     * 使用低成本基础搜索返回候选网页
     *
     * @param input 已校验的搜索条件
     * @param signal 取消信号
     * @returns 统一搜索结果
     */
    public async search (input: WebSearchInput, signal?: AbortSignal): Promise<WebSearchResult> {
        const response = await this.request(SEARCH_ENDPOINT, {
            query: input.query,
            search_depth: 'basic',
            max_results: input.limit,
            include_answer: false,
            include_raw_content: false,
            include_images: false,
            include_usage: true,
            ...(input.includeDomains && { include_domains: input.includeDomains }),
            ...(input.excludeDomains && { exclude_domains: input.excludeDomains }),
            ...(input.from && { start_date: input.from }),
            ...(input.to && { end_date: input.to }),
            ...(input.language && {
                language: input.language,
                filter_by_language: false,
            }),
        }, signal);
        const parsed = searchResponseSchema.parse(response);
        return {
            provider: 'tavily',
            query: input.query,
            searchedAt: new Date().toISOString(),
            results: parsed.results.map(item => ({
                title: item.title,
                url: item.url,
                snippet: item.content,
                ...(item.published_date && { publishedAt: item.published_date }),
            })),
            ...(parsed.request_id && { requestId: parsed.request_id }),
            ...(parsed.usage?.credits !== undefined && { usageCredits: parsed.usage.credits }),
        };
    }

    /**
     * 使用 Tavily Extract 读取一个公开网页
     *
     * @param inputUrl 公开 HTTP(S) 地址
     * @param signal 取消信号
     * @returns 统一网页正文
     */
    public async fetchPage (inputUrl: string, signal?: AbortSignal): Promise<WebPageResult> {
        const url = normalizePublicUrl(inputUrl);
        const response = await this.request(EXTRACT_ENDPOINT, {
            urls: [url],
            extract_depth: 'basic',
            format: 'markdown',
            include_usage: true,
        }, signal);
        const parsed = extractResponseSchema.parse(response);
        const result = parsed.results[0];
        if (!result) {
            throw new Error('Tavily 无法读取这个网页');
        }
        return {
            provider: 'tavily',
            url: result.url,
            fetchedAt: new Date().toISOString(),
            content: result.raw_content,
            ...(parsed.request_id && { requestId: parsed.request_id }),
            ...(parsed.usage?.credits !== undefined && { usageCredits: parsed.usage.credits }),
        };
    }

    /** 向 Tavily 发送一个不泄露凭证的 JSON 请求 */
    private async request (endpoint: string, body: object, signal?: AbortSignal): Promise<unknown> {
        const response = await this.fetchFunction(endpoint, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.resolveApiKey()}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal,
        });
        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                throw new Error('Tavily API key 无效');
            }
            if (response.status === 429) {
                throw new Error('Tavily 请求过于频繁或额度已用尽');
            }
            throw new Error(`Tavily 请求失败（HTTP ${response.status}）`);
        }
        return await response.json();
    }
}

/** 规范化公开网页地址并拒绝明显的本地与私有网络目标 */
function normalizePublicUrl (value: string): string {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('web_fetch 只接受无凭证的公开 HTTP(S) 地址');
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (hostname === 'localhost'
        || hostname.endsWith('.localhost')
        || hostname.endsWith('.local')
        || isPrivateIp(hostname)) {
        throw new Error('web_fetch 不允许访问本地或私有网络地址');
    }
    url.hash = '';
    return url.toString();
}

/** 判断文本是否是私有、环回或链路本地 IP */
function isPrivateIp (hostname: string): boolean {
    const version = isIP(hostname);
    if (version === 4) {
        const parts = hostname.split('.').map(Number);
        return parts[0] === 0
            || parts[0] === 10
            || parts[0] === 127
            || (parts[0] === 169 && parts[1] === 254)
            || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
            || (parts[0] === 192 && parts[1] === 168);
    }
    if (version === 6) {
        return hostname === '::1'
            || hostname === '::'
            || hostname.startsWith('::ffff:')
            || hostname.startsWith('fc')
            || hostname.startsWith('fd')
            || hostname.startsWith('fe8')
            || hostname.startsWith('fe9')
            || hostname.startsWith('fea')
            || hostname.startsWith('feb');
    }
    return false;
}
