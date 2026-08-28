/** Selfcraft 支持的模型协议 */
export type ProviderType = 'openai-compatible' | 'openai' | 'anthropic';

/** 单个模型的能力与上下文参数 */
export interface ModelConfig {
    /** 是否支持图片输入 */
    vision: boolean;
    /** 模型上下文窗口 */
    contextWindow: number;
    /** 单次最大输出 token */
    maxOutputTokens: number;
}

/** 一个可包含多个模型的请求渠道 */
export interface ProviderConfig {
    /** 请求协议 */
    type: ProviderType;
    /** 自定义 API 根地址 */
    baseURL?: string;
    /** secrets.json 中的凭证键 */
    credentialRef: string;
    /** 渠道下可用模型 */
    models: Record<string, ModelConfig>;
}

/** 当前活动模型 */
export interface ActiveModelConfig {
    /** 渠道标识 */
    providerId: string;
    /** 模型标识 */
    modelId: string;
}

/** 持久配置文件结构 */
export interface SelfcraftConfig {
    /** 配置格式版本 */
    version: 1;
    /** 当前模型；首次启动前为空 */
    activeModel: ActiveModelConfig | null;
    /** 已配置的模型渠道 */
    providers: Record<string, ProviderConfig>;
    /** Agent 单轮最多执行的步骤数 */
    maxSteps: number;
    /** 解释用户本地时间使用的 IANA 时区 */
    timezone: string;
}

/** 新增模型渠道所需参数 */
export interface AddProviderInput {
    /** 渠道标识 */
    providerId: string;
    /** 请求协议 */
    type: ProviderType;
    /** API 根地址 */
    baseURL?: string;
    /** API 密钥 */
    apiKey: string;
    /** 渠道内模型及其能力 */
    models: Record<string, ModelConfig>;
}
