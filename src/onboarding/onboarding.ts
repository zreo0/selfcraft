import {
    autocomplete,
    cancel,
    confirm,
    intro,
    isCancel,
    log,
    note,
    outro,
    password,
    select,
    text,
} from '@clack/prompts';
import type { ModelConfig, ProviderType } from '../config/types';
import type { RuntimeClient } from '../cli/runtime-client';

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

/** 用户主动取消 onboarding */
export class OnboardingCancelledError extends Error {
    /** 创建稳定的取消错误 */
    constructor () {
        super('初始化已取消');
        this.name = 'OnboardingCancelledError';
    }
}

/** CLI 首次访问与后续 /model add 共用的交互式配置流程 */
export class Onboarding {
    /**
     * 创建 onboarding 流程
     *
     * @param client 唯一 Runtime 的 HTTP 客户端
     */
    constructor (private readonly client: Pick<
        RuntimeClient,
        'bootstrap' | 'addProvider' | 'setTimezone' | 'resetConfig' | 'configureWebAccess'
    >) {}

    /** 完成首次环境与模型配置 */
    public async run (): Promise<void> {
        const bootstrap = await this.client.bootstrap();
        if (!bootstrap.config) {
            throw new Error(`现有配置无效：${bootstrap.configurationError || '未知错误'}。请运行 bun run cli reset-config`);
        }
        intro(' Selfcraft · 初次见面 ');
        log.message([
            '在我们开始之前，先给我一个可以思考的模型。',
            '名字和性格不用现在填写——它们应该在相处里慢慢形成。当然如果你想，你可以随时告诉我。',
        ]);
        note([
            `环境    ${bootstrap.runtime.environment}`,
            `数据    ${bootstrap.runtime.home}`,
            `工作区  ${bootstrap.runtime.workspace}`,
        ].join('\n'), '我会住在这里');
        const detectedTimezone = bootstrap.config.timezone;
        const timezone = this.unwrap(await autocomplete({
            message: '你通常按哪个时区生活？',
            options: createTimezoneOptions(detectedTimezone),
            initialValue: detectedTimezone,
            placeholder: '输入城市或时区，例如 Shanghai',
            maxItems: 8,
        }));
        await this.configureModel(true);
        await this.client.setTimezone(timezone);
        outro('准备好了。接下来，你想让我做点什么？');
    }

    /**
     * 备份并重置现有配置，然后重新进入首次配置流程
     *
     * @returns 配置流程完成后结束
     */
    public async reset (): Promise<void> {
        const confirmed = await confirm({
            message: '备份当前 config.json 并重新配置？API key 不会备份，需要重新输入；记忆、会话、任务和 workspace 不受影响。',
            active: '备份并重置',
            inactive: '取消',
            initialValue: false,
        });
        if (isCancel(confirmed) || !confirmed) {
            cancel('配置保持不变');
            return;
        }

        const { backupDirectory } = await this.client.resetConfig();
        log.success(backupDirectory
            ? `旧配置已备份到 ${backupDirectory}`
            : '没有发现旧配置，已创建一份新配置');
        try {
            await this.run();
        } catch (error) {
            if (!(error instanceof OnboardingCancelledError)) {
                throw error;
            }
            log.message([
                '重新配置尚未完成，但刚才的重置已经生效。',
                backupDirectory ? `旧 config 仍在 ${backupDirectory}。` : '',
                '下次启动时会继续 onboarding。',
            ].filter(Boolean).join('\n'));
        }
    }

    /**
     * 交互式新增模型渠道
     *
     * @param firstRun 是否为首次配置
     */
    public async configureModel (firstRun = false): Promise<void> {
        if (!firstRun) {
            intro(' Selfcraft · 添加模型 ');
        }

        const providerId = firstRun
            ? 'default'
            : this.unwrap(await text({
                message: '给这个模型渠道一个标识',
                placeholder: '例如 openai、anthropic 或 local',
                defaultValue: 'default',
                validate: value => this.validateProviderId(value ?? ''),
            }));
        const type = this.unwrap(await select<ProviderType>({
            message: '使用哪种接口？',
            options: [
                {
                    value: 'openai-compatible',
                    label: 'OpenAI Compatible',
                    hint: 'OpenAI 格式的第三方或本地服务',
                },
                {
                    value: 'openai',
                    label: 'OpenAI',
                    hint: 'OpenAI 官方接口',
                },
                {
                    value: 'anthropic',
                    label: 'Anthropic',
                    hint: 'Anthropic 官方接口',
                },
            ],
            initialValue: 'openai-compatible',
        }));
        const baseURL = await this.askBaseURL(type);
        const apiKey = this.unwrap(await password({
            message: 'API key（已有渠道留空保留；本地兼容接口可不填）',
            clearOnError: true,
            validate: value => {
                if (value && /[\r\n]/.test(value)) {
                    return '请输入单行 API key';
                }
            },
        }));
        const rawModels = this.unwrap(await text({
            message: '准备使用哪个模型？',
            placeholder: '例如 gpt-5.6，多个模型用逗号分隔',
            validate: value => this.validateModelIds(value ?? ''),
        }));
        const modelIds = this.parseModelIds(rawModels);
        const models = await this.askModelCapabilities(modelIds);

        await this.client.addProvider({
            providerId,
            type,
            baseURL,
            apiKey,
            models,
        });
        log.success(`已保存 ${providerId}/${modelIds[0]}${modelIds.length > 1 ? ` 等 ${modelIds.length} 个模型` : ''}`);

        if (!firstRun) {
            outro('模型已经记下了。需要时可用 /model use 切换。');
        }
    }

    /** 交互式保存 Tavily 凭证并启用网络访问 */
    public async configureWebSearch (): Promise<void> {
        intro(' Selfcraft · 网络搜索 ');
        log.message('网络访问是可选能力。凭证只保存在本地，搜索结果不会自动进入长期记忆。');
        const apiKey = this.unwrap(await password({
            message: 'Tavily API key',
            clearOnError: true,
            validate: value => {
                if (!value?.trim() || /[\r\n]/.test(value)) {
                    return '请输入单行非空 API key';
                }
            },
        }));
        await this.client.configureWebAccess(apiKey);
        log.success('网络搜索已经可用');
        outro('下次对话会立即看到 web_search 与 web_fetch。');
    }

    /**
     * 根据接口类型收集可选的 Base URL
     *
     * @param type 模型接口类型
     * @returns 自定义 Base URL 或 undefined
     */
    private async askBaseURL (type: ProviderType): Promise<string | undefined> {
        if (type === 'openai-compatible') {
            return this.unwrap(await text({
                message: '服务地址是什么？',
                placeholder: '例如 https://api.example.com/v1',
                validate: value => this.validateBaseURL(value ?? '', true),
            })).trim();
        }

        const customBaseURL = this.unwrap(await confirm({
            message: '要使用自定义 Base URL 吗？',
            active: '使用',
            inactive: '官方地址',
            initialValue: false,
        }));
        if (!customBaseURL) {
            return undefined;
        }
        return this.unwrap(await text({
            message: '自定义服务地址',
            placeholder: '例如 https://api.example.com/v1',
            validate: value => this.validateBaseURL(value ?? '', true),
        })).trim();
    }

    /**
     * 收集可选的模型上下文与图片能力
     *
     * @param modelIds 已校验的模型标识
     * @returns 各模型的能力配置
     */
    private async askModelCapabilities (modelIds: string[]): Promise<Record<string, ModelConfig>> {
        const useAdvancedSettings = this.unwrap(await confirm({
            message: '要配置上下文、输出长度或图片能力吗？',
            active: '配置',
            inactive: '使用默认值',
            initialValue: false,
        }));
        if (!useAdvancedSettings) {
            return this.createModels(modelIds, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT_TOKENS, new Set());
        }

        const contextWindow = Number(this.unwrap(await text({
            message: '上下文窗口',
            defaultValue: String(DEFAULT_CONTEXT_WINDOW),
            validate: value => this.validatePositiveInteger(value ?? ''),
        })));
        const maxOutputTokens = Number(this.unwrap(await text({
            message: '单次最大输出 token',
            defaultValue: String(DEFAULT_MAX_OUTPUT_TOKENS),
            validate: value => this.validatePositiveInteger(value ?? ''),
        })));
        const visionModels = await this.askVisionModels(modelIds);
        return this.createModels(modelIds, contextWindow, maxOutputTokens, visionModels);
    }

    /**
     * 收集支持图片输入的模型
     *
     * @param modelIds 已配置的模型标识
     * @returns 支持图片的模型集合
     */
    private async askVisionModels (modelIds: string[]): Promise<Set<string>> {
        if (modelIds.length === 1) {
            const supportsVision = this.unwrap(await confirm({
                message: `${modelIds[0]} 支持图片输入吗？`,
                active: '支持',
                inactive: '不支持',
                initialValue: false,
            }));
            return new Set(supportsVision ? modelIds : []);
        }

        const rawVisionModels = this.unwrap(await text({
            message: '哪些模型支持图片输入？',
            placeholder: '多个模型用逗号分隔，没有则留空',
            validate: value => this.validateVisionModels(value ?? '', modelIds),
        }));
        return new Set(this.parseModelIds(rawVisionModels));
    }

    /**
     * 构建统一参数的模型配置
     *
     * @param modelIds 模型标识
     * @param contextWindow 上下文窗口
     * @param maxOutputTokens 最大输出 token
     * @param visionModels 支持图片输入的模型
     * @returns 模型配置映射
     */
    private createModels (
        modelIds: string[],
        contextWindow: number,
        maxOutputTokens: number,
        visionModels: Set<string>,
    ): Record<string, ModelConfig> {
        return Object.fromEntries(modelIds.map(modelId => [
            modelId,
            {
                vision: visionModels.has(modelId),
                contextWindow,
                maxOutputTokens,
            } satisfies ModelConfig,
        ]));
    }

    /**
     * 将取消符号转换为稳定的业务错误
     *
     * @param value prompt 返回值
     * @returns 已确认的 prompt 值
     */
    private unwrap<T> (value: T | symbol): T {
        if (isCancel(value)) {
            cancel('没有写入新的设置');
            throw new OnboardingCancelledError();
        }
        return value;
    }

    /**
     * 校验渠道标识
     *
     * @param value 用户输入
     * @returns 校验错误或 undefined
     */
    private validateProviderId (value: string): string | undefined {
        if (!PROVIDER_ID_PATTERN.test(value.trim())) {
            return '只能使用字母、数字、点、下划线和连字符，最长 64 个字符';
        }
    }

    /**
     * 校验模型标识列表
     *
     * @param value 用户输入
     * @returns 校验错误或 undefined
     */
    private validateModelIds (value: string): string | undefined {
        const modelIds = this.parseModelIds(value);
        if (modelIds.length === 0) {
            return '至少输入一个 Model ID';
        }
        if (modelIds.some(modelId => !MODEL_ID_PATTERN.test(modelId))) {
            return 'Model ID 只能使用字母、数字、点、下划线、斜线和连字符';
        }
    }

    /**
     * 校验图片模型属于当前渠道
     *
     * @param value 用户输入
     * @param modelIds 当前渠道的模型标识
     * @returns 校验错误或 undefined
     */
    private validateVisionModels (value: string, modelIds: string[]): string | undefined {
        const error = value.trim() ? this.validateModelIds(value) : undefined;
        if (error) {
            return error;
        }
        const unknownModels = this.parseModelIds(value).filter(modelId => !modelIds.includes(modelId));
        if (unknownModels.length > 0) {
            return `尚未配置这些模型：${unknownModels.join(', ')}`;
        }
    }

    /**
     * 校验 HTTP(S) 服务地址
     *
     * @param value 用户输入
     * @param required 是否必填
     * @returns 校验错误或 undefined
     */
    private validateBaseURL (value: string, required: boolean): string | undefined {
        if (!value.trim()) {
            return required ? '请输入服务地址' : undefined;
        }
        try {
            const url = new URL(value.trim());
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
                return '请输入不含凭证、query 和 hash 的 HTTP(S) 地址';
            }
        } catch {
            return '请输入完整的 URL';
        }
    }

    /**
     * 校验正整数
     *
     * @param value 用户输入
     * @returns 校验错误或 undefined
     */
    private validatePositiveInteger (value: string): string | undefined {
        const number = Number(value);
        if (!Number.isInteger(number) || number <= 0) {
            return '请输入正整数';
        }
    }

    /**
     * 解析并去重模型标识
     *
     * @param value 逗号分隔的模型标识
     * @returns 去重后的模型标识
     */
    private parseModelIds (value: string): string[] {
        return [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))];
    }
}

/**
 * 构造可搜索的 IANA 时区选项，并把当前检测值放在首位
 *
 * @param detectedTimezone 当前系统检测到的时区
 * @returns 去重后的时区选择项
 */
function createTimezoneOptions (detectedTimezone: string): Array<{
    value: string;
    label: string;
    hint?: string;
}> {
    const timezones = [...new Set([
        detectedTimezone,
        'UTC',
        ...Intl.supportedValuesOf('timeZone'),
    ])];
    return timezones.map(timezone => ({
        value: timezone,
        label: timezone,
        ...(timezone === detectedTimezone && { hint: '自动检测' }),
    }));
}
