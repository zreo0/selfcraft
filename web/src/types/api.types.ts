import type { UIMessage } from 'ai';

/** Web API 返回的模型能力 */
export interface ModelView {
    /** 模型标识 */
    id: string;
    /** 是否支持图片输入 */
    vision: boolean;
    /** 上下文窗口大小 */
    contextWindow: number;
    /** 最大输出 token */
    maxOutputTokens: number;
}

/** Web API 返回的脱敏渠道 */
export interface ProviderView {
    /** 渠道标识 */
    id: string;
    /** 模型协议 */
    type: 'openai-compatible' | 'openai' | 'anthropic';
    /** 可选 API 根地址 */
    baseURL?: string;
    /** 是否已经保存凭证 */
    credentialConfigured: boolean;
    /** 渠道内模型 */
    models: ModelView[];
}

/** Web API 返回的非敏感配置 */
export interface ConfigView {
    /** 是否可以开始对话 */
    configured: boolean;
    /** 用户本地时区 */
    timezone: string;
    /** 当前活动模型 */
    activeModel: { providerId: string; modelId: string } | null;
    /** 可选网络搜索配置 */
    webAccess: {
        provider: 'tavily';
        configured: boolean;
    } | null;
    /** 已配置渠道 */
    providers: ProviderView[];
}

/** Web 消息附带的持久时间线信息 */
export interface MessageMetadata {
    /** 持久消息的时间线序号，乐观消息尚未分配 */
    seq?: number;
    /** 消息发生时间 */
    occurredAt: string;
}

/** Agent 工具活动的执行状态 */
export type AgentActivityState = 'running' | 'success' | 'error' | 'unknown';

/** 网络搜索返回的一条候选结果 */
export interface AgentSearchResultView {
    /** 当前结果在活动中的稳定标识 */
    id: string;
    /** 页面标题 */
    title: string;
    /** 页面域名 */
    domain?: string;
    /** 页面地址 */
    url: string;
}

/** Runtime 输出的一次可展示工具活动 */
export interface AgentActivityView {
    /** 工具调用标识 */
    id: string;
    /** 搜索或通用工具呈现 */
    kind: 'search' | 'tool';
    /** Runtime 工具名 */
    toolName: string;
    /** 面向用户的动作名称 */
    label: string;
    /** 不包含正文和凭证的目标摘要 */
    target?: string;
    /** 当前执行状态 */
    state: AgentActivityState;
    /** 执行耗时 */
    durationMs?: number;
    /** 网络搜索的有界候选结果 */
    results?: AgentSearchResultView[];
}

/** 一轮回复中的 Agent 活动组 */
export interface AgentActivityGroup {
    /** 是否仍有活动在执行 */
    status: 'working' | 'complete';
    /** 按调用顺序排列的活动 */
    items: AgentActivityView[];
}

/** Web 消息接收的结构化数据类型 */
export interface MessageData extends Record<string, unknown> {
    /** 不进入历史消息的短暂运行状态 */
    status: {
        phase: 'queued' | 'preparing' | 'thinking';
        label: string;
    };
    /** 可持久重建的 Agent 活动 */
    activity: AgentActivityGroup;
}

/** Selfcraft Web 的 AI SDK UI 消息 */
export type SelfcraftMessage = UIMessage<MessageMetadata, MessageData>;

/** 健康检查结果 */
export interface HealthCheckView {
    /** 检查名称 */
    name: string;
    /** 是否通过 */
    healthy: boolean;
    /** 状态说明 */
    message: string;
}

/** Runtime 状态摘要 */
export interface RuntimeView {
    /** 运行环境 */
    environment: string;
    /** 数据目录 */
    home: string;
    /** 工作区目录 */
    workspace: string;
    /** 正在执行或等待的前台请求数 */
    pendingForegroundRuns: number;
    /** 确定性健康检查 */
    checks: HealthCheckView[];
}

/** 一页持久消息 */
export interface MessagePage {
    /** 正序排列的消息 */
    items: SelfcraftMessage[];
    /** 更早一页的游标 */
    nextCursor: number | null;
}

/** 页面初始化数据 */
export interface BootstrapView {
    /** 产品名 */
    product: string;
    /** 配置无效时为空 */
    config: ConfigView | null;
    /** 配置读取错误 */
    configurationError: string | null;
    /** 最近消息 */
    messages: MessagePage;
    /** Runtime 状态 */
    runtime: RuntimeView;
}

/** 新增模型渠道的页面输入 */
export interface ProviderInput {
    /** 渠道标识 */
    providerId: string;
    /** 模型协议 */
    type: ProviderView['type'];
    /** API 根地址 */
    baseURL?: string;
    /** 新凭证 */
    apiKey: string;
    /** 模型标识 */
    modelId: string;
    /** 是否支持视觉 */
    vision: boolean;
    /** 上下文窗口 */
    contextWindow: number;
    /** 最大输出 token */
    maxOutputTokens: number;
}
