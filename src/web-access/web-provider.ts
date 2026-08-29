/** 网络搜索输入 */
export interface WebSearchInput {
    /** 自然语言检索词 */
    query: string;
    /** 最多返回条数 */
    limit: number;
    /** 只搜索这些域名 */
    includeDomains?: string[];
    /** 排除这些域名 */
    excludeDomains?: string[];
    /** 发布时间下界 */
    from?: string;
    /** 发布时间上界 */
    to?: string;
    /** 偏好的结果语言 */
    language?: string;
}

/** 一条统一的网络搜索结果 */
export interface WebSearchResultItem {
    /** 页面标题 */
    title: string;
    /** 页面地址 */
    url: string;
    /** 搜索服务返回的短摘要 */
    snippet: string;
    /** 来源声明的发布时间 */
    publishedAt?: string;
}

/** 统一的网络搜索结果 */
export interface WebSearchResult {
    /** 实际提供搜索的实现 */
    provider: string;
    /** 原始检索词 */
    query: string;
    /** 搜索发生时间 */
    searchedAt: string;
    /** 候选页面 */
    results: WebSearchResultItem[];
    /** 服务端请求标识 */
    requestId?: string;
    /** 本次调用消耗的额度 */
    usageCredits?: number;
}

/** 统一的网页读取结果 */
export interface WebPageResult {
    /** 实际提供读取的实现 */
    provider: string;
    /** 最终读取地址 */
    url: string;
    /** 读取发生时间 */
    fetchedAt: string;
    /** Markdown 正文 */
    content: string;
    /** 服务端请求标识 */
    requestId?: string;
    /** 本次调用消耗的额度 */
    usageCredits?: number;
}

/** 可由 Runtime 替换的网络搜索与网页读取边界 */
export interface WebProvider {
    /** 搜索候选页面 */
    search (input: WebSearchInput, signal?: AbortSignal): Promise<WebSearchResult>;
    /** 读取一个公开网页 */
    fetchPage (url: string, signal?: AbortSignal): Promise<WebPageResult>;
}
