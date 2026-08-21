import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
    ActiveModelConfig,
    AddProviderInput,
    ModelConfig,
    ProviderConfig,
    SelfcraftConfig,
} from './types';

const modelSchema = z.object({
    vision: z.boolean(),
    contextWindow: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
});

const providerSchema = z.object({
    type: z.enum(['openai-compatible', 'openai', 'anthropic']),
    baseURL: z.string().url().optional(),
    credentialRef: z.string().min(1),
    models: z.record(z.string(), modelSchema),
});

const configSchema = z.object({
    version: z.literal(1),
    activeModel: z.object({
        providerId: z.string().min(1),
        modelId: z.string().min(1),
    }).nullable(),
    providers: z.record(z.string(), providerSchema),
    maxSteps: z.number().int().min(1).max(100),
});

const secretsSchema = z.object({
    version: z.literal(1),
    credentials: z.record(z.string(), z.string().min(1)),
});

/** 模型配置与凭证的持久化边界 */
export class ConfigStore {
    private readonly configPath: string;
    private readonly secretsPath: string;

    /**
     * 创建配置存储
     *
     * @param configDirectory 配置目录
     */
    constructor (configDirectory: string) {
        this.configPath = path.join(configDirectory, 'config.json');
        this.secretsPath = path.join(configDirectory, 'secrets.json');
        fs.mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
        fs.chmodSync(configDirectory, 0o700);
    }

    /**
     * 判断是否已经配置可用模型
     *
     * @returns 是否可开始对话
     */
    public isConfigured (): boolean {
        try {
            this.getActiveModel();
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 读取完整的非敏感配置
     *
     * @returns 配置副本
     */
    public read (): SelfcraftConfig {
        if (!fs.existsSync(this.configPath)) {
            return { version: 1, activeModel: null, providers: {}, maxSteps: 32 };
        }
        const parsed = configSchema.parse(JSON.parse(fs.readFileSync(this.configPath, 'utf8')));
        return structuredClone(parsed) as SelfcraftConfig;
    }

    /**
     * 新增或更新一个模型渠道
     *
     * @param input 已校验的交互输入
     * @returns 更新后的配置
     */
    public addProvider (input: AddProviderInput): SelfcraftConfig {
        this.assertProviderId(input.providerId);
        const modelEntries = Object.entries(input.models);
        if (modelEntries.length === 0) {
            throw new Error('至少需要配置一个模型');
        }
        for (const [modelId, model] of modelEntries) {
            this.assertId(modelId, 'modelId');
            modelSchema.parse(model);
        }
        const baseURL = input.baseURL?.trim() || undefined;
        if (input.type === 'openai-compatible' && !baseURL) {
            throw new Error('openai-compatible 渠道必须配置 baseURL');
        }
        if (baseURL) {
            const url = new URL(baseURL);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
                throw new Error('baseURL 必须是无凭证、query 和 hash 的 HTTP(S) 地址');
            }
        }
        const apiKey = input.apiKey.trim();
        if (!apiKey || /[\r\n]/.test(apiKey)) {
            throw new Error('API key 必须是单行非空文本');
        }

        const config = this.read();
        const credentialRef = `provider:${input.providerId}`;
        config.providers[input.providerId] = {
            type: input.type,
            ...(baseURL && { baseURL }),
            credentialRef,
            models: structuredClone(input.models),
        };
        config.activeModel ||= {
            providerId: input.providerId,
            modelId: modelEntries[0][0],
        };
        this.writeSecrets({
            ...this.readSecrets(),
            [credentialRef]: apiKey,
        });
        this.write(config);
        return config;
    }

    /**
     * 切换后续对话使用的模型
     *
     * @param selection 目标渠道与模型
     */
    public useModel (selection: ActiveModelConfig): void {
        const config = this.read();
        if (!config.providers[selection.providerId]?.models[selection.modelId]) {
            throw new Error(`模型不存在: ${selection.providerId}/${selection.modelId}`);
        }
        config.activeModel = selection;
        this.write(config);
    }

    /**
     * 返回活动模型、渠道和凭证
     *
     * @returns 当前可用于请求的配置
     */
    public getActiveModel (): {
        selection: ActiveModelConfig;
        provider: ProviderConfig;
        model: ModelConfig;
        apiKey: string;
    } {
        const config = this.read();
        if (!config.activeModel) {
            throw new Error('尚未配置活动模型');
        }
        const provider = config.providers[config.activeModel.providerId];
        const model = provider?.models[config.activeModel.modelId];
        const apiKey = provider && this.readSecrets()[provider.credentialRef];
        if (!provider || !model || !apiKey) {
            throw new Error('活动模型配置不完整');
        }
        return {
            selection: structuredClone(config.activeModel),
            provider: structuredClone(provider),
            model: structuredClone(model),
            apiKey,
        };
    }

    /**
     * 原子保存非敏感配置
     *
     * @param config 已校验配置
     */
    private write (config: SelfcraftConfig): void {
        configSchema.parse(config);
        this.atomicWrite(this.configPath, JSON.stringify(config, null, 4));
    }

    /**
     * 读取凭证映射
     *
     * @returns credentialRef 到 API key 的映射
     */
    private readSecrets (): Record<string, string> {
        if (!fs.existsSync(this.secretsPath)) {
            return {};
        }
        const parsed = secretsSchema.parse(JSON.parse(fs.readFileSync(this.secretsPath, 'utf8')));
        return { ...parsed.credentials };
    }

    /**
     * 保存凭证并收紧文件权限
     *
     * @param credentials 凭证映射
     */
    private writeSecrets (credentials: Record<string, string>): void {
        secretsSchema.parse({ version: 1, credentials });
        this.atomicWrite(this.secretsPath, JSON.stringify({ version: 1, credentials }, null, 4));
        fs.chmodSync(this.secretsPath, 0o600);
    }

    /**
     * 使用同目录临时文件替换目标文件
     *
     * @param targetPath 目标路径
     * @param content 文件正文
     */
    private atomicWrite (targetPath: string, content: string): void {
        const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
        fs.writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        fs.renameSync(temporaryPath, targetPath);
    }

    /**
     * 限制持久标识的字符集合
     *
     * @param value 标识值
     * @param field 字段名
     */
    private assertId (value: string, field: string): void {
        if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value)) {
            throw new Error(`${field} 格式无效`);
        }
    }

    /** 渠道名同时作为 CLI 选择前缀，因此不允许包含斜线 */
    private assertProviderId (value: string): void {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
            throw new Error('providerId 格式无效');
        }
    }
}
