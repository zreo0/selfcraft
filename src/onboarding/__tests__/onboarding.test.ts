import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigStore } from '../../config/config-store';
import { resolvePaths } from '../../config/paths';

type PromptValidator = (
    value?: string,
) => string | Error | undefined | Promise<string | Error | undefined>;

const CANCELLED = Symbol('cancelled');
const temporaryDirectories: string[] = [];
const textValues: Array<string | symbol> = [];
const passwordValues: Array<string | symbol> = [];
const selectValues: Array<string | symbol> = [];
const autocompleteValues: Array<string | symbol> = [];
const confirmValues: Array<boolean | symbol> = [];
const validationErrors: string[] = [];

/** 返回队列中的下一个 prompt 值 */
function nextPromptValue<T> (values: Array<T | symbol>): T | symbol {
    const value = values.shift();
    if (value === undefined) {
        throw new Error('测试没有提供足够的 prompt 返回值');
    }
    return value;
}

/** 模拟 Clack 对字符串输入的逐字段校验与重试 */
async function nextValidatedValue (
    values: Array<string | symbol>,
    validate?: PromptValidator,
): Promise<string | symbol> {
    while (values.length > 0) {
        const value = nextPromptValue(values);
        if (typeof value === 'symbol' || !validate) {
            return value;
        }
        const error = await validate(value);
        if (!error) {
            return value;
        }
        validationErrors.push(error instanceof Error ? error.message : error);
    }
    throw new Error('测试输入均未通过 prompt 校验');
}

const introMock = mock(() => {});
const outroMock = mock(() => {});
const noteMock = mock(() => {});
const cancelMock = mock(() => {});
const logMessageMock = mock((_message: string | string[]) => {});
const logSuccessMock = mock((_message: string) => {});
const textMock = mock(async (options: { validate?: PromptValidator }) =>
    nextValidatedValue(textValues, options.validate));
const passwordMock = mock(async (options: { validate?: PromptValidator }) =>
    nextValidatedValue(passwordValues, options.validate));
const selectMock = mock(async () => nextPromptValue(selectValues));
const autocompleteMock = mock(async (_options: {
    initialValue?: string;
    maxItems?: number;
    options: Array<{ value: string }>;
}) => nextPromptValue(autocompleteValues));
const confirmMock = mock(async () => nextPromptValue(confirmValues));

mock.module('@clack/prompts', () => ({
    autocomplete: autocompleteMock,
    cancel: cancelMock,
    confirm: confirmMock,
    intro: introMock,
    isCancel: (value: unknown) => typeof value === 'symbol',
    log: {
        message: logMessageMock,
        success: logSuccessMock,
    },
    note: noteMock,
    outro: outroMock,
    password: passwordMock,
    select: selectMock,
    text: textMock,
}));

const { Onboarding, OnboardingCancelledError } = await import('../onboarding');

/** 创建并追踪测试临时目录 */
function createTemporaryDirectory (): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-onboarding-'));
    temporaryDirectories.push(directory);
    return directory;
}

/** 创建使用临时配置目录的 onboarding */
function createOnboarding (): {
    onboarding: InstanceType<typeof Onboarding>;
    config: ConfigStore;
} {
    const root = createTemporaryDirectory();
    const paths = resolvePaths('production', root);
    const config = new ConfigStore(paths.config);
    return {
        onboarding: new Onboarding(paths, config),
        config,
    };
}

beforeEach(() => {
    textValues.length = 0;
    passwordValues.length = 0;
    selectValues.length = 0;
    autocompleteValues.length = 0;
    confirmValues.length = 0;
    validationErrors.length = 0;
    mock.clearAllMocks();
});

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('Onboarding', () => {
    test('首次配置逐字段重试并保存高级模型能力', async () => {
        const { onboarding, config } = createOnboarding();
        const detectedTimezone = config.read().timezone;
        autocompleteValues.push('Asia/Shanghai');
        selectValues.push('openai-compatible');
        textValues.push(
            'not-a-url',
            'https://example.com/v1',
            'model-a, model-b',
            '0',
            '65536',
            '4096',
            'unknown-model',
            'model-b',
        );
        passwordValues.push('', 'test-key');
        confirmValues.push(true);

        await onboarding.run();

        const active = config.getActiveModel();
        const provider = config.read().providers.default;
        expect(config.read().timezone).toBe('Asia/Shanghai');
        expect(active.selection).toEqual({ providerId: 'default', modelId: 'model-a' });
        expect(provider.baseURL).toBe('https://example.com/v1');
        expect(provider.models['model-a']).toEqual({
            vision: false,
            contextWindow: 65536,
            maxOutputTokens: 4096,
        });
        expect(provider.models['model-b'].vision).toBeTrue();
        expect(validationErrors).toEqual([
            '请输入完整的 URL',
            '请输入单行非空 API key',
            '请输入正整数',
            '尚未配置这些模型：unknown-model',
        ]);
        expect(introMock).toHaveBeenCalledTimes(1);
        expect(noteMock).toHaveBeenCalledTimes(1);
        expect(outroMock).toHaveBeenCalledTimes(1);
        const timezonePrompt = autocompleteMock.mock.calls[0][0];
        expect(timezonePrompt.initialValue).toBe(detectedTimezone);
        expect(timezonePrompt.maxItems).toBe(8);
        expect(timezonePrompt.options.map(option => option.value)).toContain('Asia/Shanghai');
        expect(timezonePrompt.options.map(option => option.value)).toContain('UTC');
    });

    test('官方渠道可跳过 Base URL 和高级设置', async () => {
        const { onboarding, config } = createOnboarding();
        textValues.push('official', 'gpt-test');
        passwordValues.push('test-key');
        selectValues.push('openai');
        confirmValues.push(false, false);

        await onboarding.configureModel();

        const provider = config.read().providers.official;
        expect(provider.type).toBe('openai');
        expect(provider.baseURL).toBeUndefined();
        expect(provider.models['gpt-test']).toEqual({
            vision: false,
            contextWindow: 128000,
            maxOutputTokens: 8192,
        });
        expect(outroMock).toHaveBeenCalledTimes(1);
    });

    test('取消时不写入半份配置', async () => {
        const { onboarding, config } = createOnboarding();
        autocompleteValues.push(CANCELLED);

        await expect(onboarding.run()).rejects.toBeInstanceOf(OnboardingCancelledError);

        expect(config.isConfigured()).toBeFalse();
        expect(cancelMock).toHaveBeenCalledWith('没有写入新的设置');
        expect(outroMock).not.toHaveBeenCalled();
    });

    test('拒绝重置时保持现有配置不变', async () => {
        const { onboarding, config } = createOnboarding();
        config.addProvider({
            providerId: 'old',
            type: 'openai',
            apiKey: 'old-key',
            models: {
                'old-model': { vision: false, contextWindow: 128000, maxOutputTokens: 8192 },
            },
        });
        const before = config.read();
        confirmValues.push(false);

        await onboarding.reset();

        expect(config.read()).toEqual(before);
        expect(config.getActiveModel().apiKey).toBe('old-key');
        expect(cancelMock).toHaveBeenCalledWith('配置保持不变');
        expect(autocompleteMock).not.toHaveBeenCalled();
    });

    test('确认重置后备份旧配置并完成一份全新配置', async () => {
        const { onboarding, config } = createOnboarding();
        config.addProvider({
            providerId: 'old',
            type: 'openai',
            apiKey: 'old-key',
            models: {
                'old-model': { vision: false, contextWindow: 128000, maxOutputTokens: 8192 },
            },
        });
        autocompleteValues.push('Asia/Tokyo');
        selectValues.push('openai');
        textValues.push('new-model');
        passwordValues.push('new-key');
        confirmValues.push(true, false, false);

        await onboarding.reset();

        expect(config.read().providers).toHaveProperty('default');
        expect(config.read().providers).not.toHaveProperty('old');
        expect(config.read().timezone).toBe('Asia/Tokyo');
        expect(config.getActiveModel()).toMatchObject({
            selection: { providerId: 'default', modelId: 'new-model' },
            apiKey: 'new-key',
        });
        expect(logSuccessMock.mock.calls.some(call => String(call[0]).includes('旧配置已备份到'))).toBeTrue();
    });

    test('重置后的 onboarding 取消不会被当成启动失败', async () => {
        const { onboarding, config } = createOnboarding();
        config.addProvider({
            providerId: 'old',
            type: 'openai',
            apiKey: 'old-key',
            models: {
                'old-model': { vision: false, contextWindow: 128000, maxOutputTokens: 8192 },
            },
        });
        confirmValues.push(true);
        autocompleteValues.push(CANCELLED);

        await expect(onboarding.reset()).resolves.toBeUndefined();

        expect(config.read().activeModel).toBeNull();
        expect(config.read().providers).toEqual({});
        expect(logMessageMock.mock.calls.some(call => String(call[0]).includes('下次启动时会继续 onboarding'))).toBeTrue();
    });
});
