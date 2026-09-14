import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
    ModelSelection,
    AddProviderInput,
    ModelConfig,
    ModelPurpose,
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
    auth: z.enum(['api-key', 'none']).default('api-key'),
    models: z.record(z.string(), modelSchema),
});

const webAccessSchema = z.object({
    provider: z.literal('tavily'),
    credentialRef: z.string().min(1),
});

const configSchema = z.object({
    version: z.literal(1),
    defaultModel: z.object({
        providerId: z.string().min(1),
        modelId: z.string().min(1),
        reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
    }).nullable(),
    modelOverrides: z.object({
        reflection: z.object({ providerId: z.string().min(1), modelId: z.string().min(1), reasoningEffort: z.enum(['low', 'medium', 'high']).optional() }).optional(),
        compression: z.object({ providerId: z.string().min(1), modelId: z.string().min(1), reasoningEffort: z.enum(['low', 'medium', 'high']).optional() }).optional(),
    }).default({}),
    providers: z.record(z.string(), providerSchema),
    webAccess: webAccessSchema.nullable().default(null),
    maxSteps: z.number().int().min(1).max(100),
    timezone: z.string().min(1).max(100).refine(isValidTimezone, '时区必须是有效的 IANA 名称'),
});

const secretsSchema = z.object({
    version: z.literal(1),
    credentials: z.record(z.string(), z.string().min(1)),
});

/** 模型配置与凭证的持久化边界 */
export class ConfigStore {
    private readonly configDirectory: string;
    private readonly configPath: string;
    private readonly secretsPath: string;

    /**
     * 创建配置存储
     *
     * @param configDirectory 配置目录
     */
    constructor (configDirectory: string) {
        this.configDirectory = configDirectory;
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
            this.getModel();
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
            return createDefaultConfig();
        }
        const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        // 旧配置只做字段迁移，不丢弃已保存的渠道与凭证
        const parsed = configSchema.parse({ ...raw, defaultModel: raw.defaultModel ?? raw.activeModel ?? null });
        // 已移除模型的用途引用恢复继承，避免对话可用而整理永久指向不存在的模型
        for (const purpose of ['reflection', 'compression'] as const) {
            const selection = parsed.modelOverrides[purpose];
            if (selection && !parsed.providers[selection.providerId]?.models[selection.modelId]) {
                delete parsed.modelOverrides[purpose];
            }
        }
        return structuredClone(parsed) as SelfcraftConfig;
    }

    /**
     * 校验现有配置与活动模型凭证是否可以完整读取
     *
     * @returns 校验通过后结束
     */
    public assertValid (): void {
        const config = this.read();
        const credentials = this.readSecrets();
        if (config.webAccess && !credentials[config.webAccess.credentialRef]) {
            throw new Error('网络访问配置不完整');
        }
        if (!config.defaultModel) {
            return;
        }
        for (const purpose of ['agent', 'reflection', 'compression'] as const) {
            this.getModel(purpose);
        }
    }

    /**
     * 按时间备份非敏感配置，并重置模型、网络访问与凭证设置
     *
     * @returns 旧配置的备份目录；没有旧配置时返回 undefined
     */
    public backupAndReset (): string | undefined {
        let backupDirectory: string | undefined;
        if (fs.existsSync(this.configPath)) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupsDirectory = path.join(this.configDirectory, 'backups');
            backupDirectory = path.join(backupsDirectory, timestamp);
            fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
            fs.chmodSync(backupsDirectory, 0o700);
            fs.chmodSync(backupDirectory, 0o700);
            const backupPath = path.join(backupDirectory, 'config.json');
            fs.copyFileSync(this.configPath, backupPath);
            fs.chmodSync(backupPath, 0o600);
        }

        if (fs.existsSync(this.secretsPath)) {
            this.writeSecrets({});
        }
        this.write(createDefaultConfig());
        return backupDirectory;
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
        if (/[\r\n]/.test(apiKey)) {
            throw new Error('API key 必须是单行文本');
        }

        const config = this.read();
        const credentialRef = `provider:${input.providerId}`;
        const credentials = this.readSecrets();
        if (!apiKey && !credentials[credentialRef] && input.type !== 'openai-compatible') {
            throw new Error('此渠道需要 API key');
        }
        config.providers[input.providerId] = {
            type: input.type,
            ...(baseURL && { baseURL }),
            credentialRef,
            auth: apiKey || credentials[credentialRef] ? 'api-key' : 'none',
            models: { ...config.providers[input.providerId]?.models, ...structuredClone(input.models) },
        };
        const defaultModelStillExists = config.defaultModel
            && config.providers[config.defaultModel.providerId]?.models[config.defaultModel.modelId];
        if (!defaultModelStillExists) {
            config.defaultModel = {
                providerId: input.providerId,
                modelId: modelEntries[0][0],
            };
        }
        if (apiKey) {
            this.writeSecrets({ ...credentials, [credentialRef]: apiKey });
        }
        this.write(config);
        return config;
    }

    /**
     * 切换后续对话使用的模型
     *
     * @param selection 目标渠道与模型
     * @param purpose 使用用途；非 agent 传 null 时恢复继承
     */
    public useModel (selection: ModelSelection | null, purpose: ModelPurpose = 'agent'): void {
        const config = this.read();
        if (selection && !config.providers[selection.providerId]?.models[selection.modelId]) {
            throw new Error(`模型不存在: ${selection.providerId}/${selection.modelId}`);
        }
        if (purpose === 'agent') {
            if (!selection) {
                throw new Error('默认模型不可为空');
            }
            config.defaultModel = selection;
        } else if (selection) {
            config.modelOverrides[purpose] = selection;
        } else {
            delete config.modelOverrides[purpose];
        }
        this.write(config);
    }

    /**
     * 保存解释用户本地时间使用的 IANA 时区
     *
     * @param timezone IANA 时区名称
     */
    public setTimezone (timezone: string): void {
        const normalized = timezone.trim();
        if (!isValidTimezone(normalized)) {
            throw new Error('时区必须是有效的 IANA 名称');
        }
        const config = this.read();
        config.timezone = normalized;
        this.write(config);
    }

    /**
     * 保存 Tavily 网络访问凭证
     *
     * @param apiKey Tavily API key
     * @returns 更新后的非敏感配置
     */
    public configureWebAccess (apiKey: string): SelfcraftConfig {
        const normalized = apiKey.trim();
        if (!normalized || /[\r\n]/.test(normalized)) {
            throw new Error('Tavily API key 必须是单行非空文本');
        }
        const config = this.read();
        const credentialRef = 'web:tavily';
        config.webAccess = {
            provider: 'tavily',
            credentialRef,
        };
        this.writeSecrets({
            ...this.readSecrets(),
            [credentialRef]: normalized,
        });
        this.write(config);
        return config;
    }

    /**
     * 关闭网络访问并移除对应凭证
     *
     * @returns 更新后的非敏感配置
     */
    public disableWebAccess (): SelfcraftConfig {
        const config = this.read();
        const credentialRef = config.webAccess?.credentialRef;
        config.webAccess = null;
        if (credentialRef) {
            const credentials = this.readSecrets();
            delete credentials[credentialRef];
            this.writeSecrets(credentials);
        }
        this.write(config);
        return config;
    }

    /** 返回网络访问是否已有可用凭证 */
    public isWebAccessConfigured (): boolean {
        try {
            this.getWebAccess();
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 返回当前网络访问实现与凭证
     *
     * @returns 可用于发起请求的配置
     */
    public getWebAccess (): { provider: 'tavily'; apiKey: string } {
        const config = this.read();
        if (!config.webAccess) {
            throw new Error('尚未配置网络访问');
        }
        const apiKey = this.readSecrets()[config.webAccess.credentialRef];
        if (!apiKey) {
            throw new Error('网络访问配置不完整');
        }
        return {
            provider: config.webAccess.provider,
            apiKey,
        };
    }

    /**
     * 判断指定渠道是否保存了可用凭证
     *
     * @param providerId 渠道标识
     * @returns 是否存在非空凭证
     */
    public hasCredential (providerId: string): boolean {
        const provider = this.read().providers[providerId];
        if (!provider) {
            return false;
        }
        return Boolean(this.readSecrets()[provider.credentialRef]);
    }

    /**
     * 返回指定用途的模型、渠道和凭证副本
     *
     * @param purpose 使用用途
     * @param requested 连接测试的显式选择，不修改默认配置
     * @returns 当前可用于请求的配置
     */
    public getModel (purpose: ModelPurpose = 'agent', requested?: ModelSelection): {
        selection: ModelSelection;
        provider: ProviderConfig;
        model: ModelConfig;
        apiKey: string | undefined;
    } {
        const config = this.read();
        const selection = requested ?? (purpose === 'agent' ? undefined : config.modelOverrides[purpose]) ?? config.defaultModel;
        if (!selection) {
            throw new Error('尚未配置活动模型');
        }
        const provider = config.providers[selection.providerId];
        const model = provider?.models[selection.modelId];
        const apiKey = provider && this.readSecrets()[provider.credentialRef];
        if (!provider || !model || (!apiKey && provider.auth !== 'none')) {
            throw new Error('活动模型配置不完整');
        }
        return {
            selection: structuredClone(selection),
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

/**
 * 创建尚未配置模型的默认配置
 *
 * @returns 使用当前系统时区的初始配置
 */
function createDefaultConfig (): SelfcraftConfig {
    return {
        version: 1,
        defaultModel: null,
        modelOverrides: {},
        providers: {},
        webAccess: null,
        maxSteps: 32,
        timezone: resolveSystemTimezone(),
    };
}

/** 返回当前系统时区，无法识别时使用 UTC */
function resolveSystemTimezone (): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
        return 'UTC';
    }
}

/** 判断文本是否是有效的 IANA 时区 */
function isValidTimezone (value: string): boolean {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
        return true;
    } catch {
        return false;
    }
}
