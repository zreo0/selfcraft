import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ConfigStore } from '../config/config-store';

/** 一次 Agent run 使用的不可变模型快照 */
export interface ModelSnapshot {
    /** AI SDK 统一模型 */
    model: LanguageModel;
    /** 日志使用的渠道标识 */
    providerId: string;
    /** 模型标识 */
    modelId: string;
    /** 上下文窗口 */
    contextWindow: number;
    /** 最大输出 token */
    maxOutputTokens: number;
}

/** 将持久配置转换为 AI SDK 模型 */
export class ModelFactory {
    /**
     * 构建当前活动模型
     *
     * @param configStore 模型配置存储
     * @returns 本轮固定模型
     */
    public static create (configStore: ConfigStore): ModelSnapshot {
        const { selection, provider, model, apiKey } = configStore.getActiveModel();
        let languageModel: LanguageModel;
        if (provider.type === 'openai-compatible') {
            const compatible = createOpenAICompatible({
                name: selection.providerId,
                baseURL: provider.baseURL!,
                apiKey,
                includeUsage: true,
                supportsStructuredOutputs: false,
            });
            languageModel = compatible(selection.modelId);
        } else if (provider.type === 'openai') {
            const openai = createOpenAI({
                apiKey,
                ...(provider.baseURL && { baseURL: provider.baseURL }),
            });
            languageModel = openai(selection.modelId);
        } else {
            const anthropic = createAnthropic({
                apiKey,
                ...(provider.baseURL && { baseURL: provider.baseURL }),
            });
            languageModel = anthropic(selection.modelId);
        }
        return {
            model: languageModel,
            providerId: selection.providerId,
            modelId: selection.modelId,
            contextWindow: model.contextWindow,
            maxOutputTokens: model.maxOutputTokens,
        };
    }
}
