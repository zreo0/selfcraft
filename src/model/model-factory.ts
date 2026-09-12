import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { wrapLanguageModel, type LanguageModel } from 'ai';
import type { ConfigStore } from '../config/config-store';
import type { ModelPurpose, ModelSelection } from '../config/types';
import type { Logger } from '../logging/logger';

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
    /** 已确认的视觉输入能力 */
    vision?: boolean;
}

/** 将持久配置转换为 AI SDK 模型 */
export class ModelFactory {
    /** 优先使用当前视觉模型，否则按稳定顺序选择已配置且凭证可用的视觉模型 */
    public static createVision (config: ConfigStore, logger?: Logger): ModelSnapshot | null {
        const saved = config.read();
        const candidates: ModelSelection[] = Object.entries(saved.providers).sort(([a], [b]) => a.localeCompare(b))
            .flatMap(([providerId, provider]) => Object.keys(provider.models).sort().map(modelId => ({ providerId, modelId })));
        if (saved.defaultModel) {
            candidates.unshift(saved.defaultModel);
        }
        for (const selection of candidates) {
            try {
                if (config.getModel('agent', selection).model.vision) {
                    return ModelFactory.create(config, 'agent', logger, selection);
                }
            } catch {
                // 未配置完整的渠道不参与辅助模型选择
            }
        }
        return null;
    }

    /**
     * 按用途构建不可变模型快照，不改变配置
     *
     * @param configStore 模型配置存储
     * @param purpose 调用用途
     * @param logger 可选请求指标日志
     * @param requested 显式连接测试使用的模型选择
     * @returns 本轮固定模型
     */
    public static create (configStore: ConfigStore, purpose: ModelPurpose = 'agent', logger?: Logger, requested?: ModelSelection): ModelSnapshot {
        const { selection, provider, model, apiKey } = configStore.getModel(purpose, requested);
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
        return Object.freeze({
            model: wrapLanguageModel({
                model: languageModel,
                middleware: {
                    specificationVersion: 'v4',
                    transformParams: async ({ params }) => ({
                        ...params,
                        ...(selection.reasoningEffort && { reasoning: selection.reasoningEffort }),
                    }),
                    wrapGenerate: async ({ doGenerate }) => {
                        const startedAt = Date.now();
                        const result = await doGenerate();
                        logger?.info('Model request completed', {
                            purpose, providerId: selection.providerId, modelId: selection.modelId,
                            streaming: false, durationMs: Date.now() - startedAt,
                            usage: result.usage, finishReason: result.finishReason, warnings: result.warnings,
                        });
                        return result;
                    },
                    wrapStream: async ({ doStream }) => {
                        const startedAt = Date.now();
                        const result = await doStream();
                        return {
                            ...result,
                            stream: result.stream.pipeThrough(new TransformStream({
                                transform (part, controller) {
                                    if (part.type === 'finish') {
                                        logger?.info('Model request completed', {
                                            purpose, providerId: selection.providerId, modelId: selection.modelId,
                                            streaming: true, durationMs: Date.now() - startedAt,
                                            usage: part.usage, finishReason: part.finishReason,
                                        });
                                    }
                                    controller.enqueue(part);
                                },
                            })),
                        };
                    },
                },
            }),
            providerId: selection.providerId,
            modelId: selection.modelId,
            contextWindow: model.contextWindow,
            maxOutputTokens: model.maxOutputTokens,
            vision: model.vision,
        });
    }
}
