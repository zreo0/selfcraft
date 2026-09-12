import { ModelFactory } from '../../model/model-factory';
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigStore } from '../config-store';

const temporaryDirectories: string[] = [];

/** 创建并追踪测试临时目录 */
function createTemporaryDirectory (): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-config-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('ConfigStore', () => {
    test('用途覆盖直接跟随默认且运行快照不随配置变化', () => {
        const store = new ConfigStore(createTemporaryDirectory());
        store.addProvider({
            providerId: 'local', type: 'openai-compatible', baseURL: 'http://localhost:3000/v1', apiKey: '',
            models: {
                first: { vision: false, contextWindow: 32000, maxOutputTokens: 4096 },
                second: { vision: false, contextWindow: 64000, maxOutputTokens: 8192 },
            },
        });
        expect(store.getModel('reflection').selection.modelId).toBe('first');
        const snapshot = store.getModel();
        store.useModel({ providerId: 'local', modelId: 'first', reasoningEffort: 'high' }, 'reflection');
        store.useModel({ providerId: 'local', modelId: 'second' });
        expect(snapshot.selection.modelId).toBe('first');
        expect(store.getModel('compression').selection.modelId).toBe('second');
        expect(store.getModel('reflection').selection.reasoningEffort).toBe('high');
        store.useModel(null, 'reflection');
        expect(store.getModel('reflection').selection.modelId).toBe('second');
        expect(() => store.useModel(null)).toThrow();
        expect(() => store.useModel({ providerId: 'local', modelId: 'missing' }, 'compression')).toThrow();
        expect(store.read().modelOverrides).toEqual({});
    });

    test('空 Key 保留现有凭证，首次兼容接口可以显式免认证', () => {
        const store = new ConfigStore(createTemporaryDirectory());
        const input = {
            providerId: 'local', type: 'openai-compatible' as const, baseURL: 'http://localhost:3000/v1', apiKey: '',
            models: { first: { vision: false, contextWindow: 32000, maxOutputTokens: 4096 } },
        };
        store.addProvider(input);
        expect(store.getModel().provider.auth).toBe('none');
        expect(store.getModel().apiKey).toBeUndefined();
        expect(store.isConfigured()).toBeTrue();
        store.addProvider({ ...input, apiKey: 'test-key' });
        store.addProvider(input);
        expect(store.getModel().apiKey).toBe('test-key');
        expect(store.getModel().provider.auth).toBe('api-key');
        expect(() => store.addProvider({ ...input, providerId: 'official', type: 'openai' })).toThrow();
    });
    test('首次读取不伪造默认模型', () => {
        const store = new ConfigStore(createTemporaryDirectory());

        expect(store.read().defaultModel).toBeNull();
        expect(store.read().webAccess).toBeNull();
        expect(store.read().timezone).toBeTruthy();
        expect(store.isConfigured()).toBeFalse();
    });

    test('分离保存 Tavily 配置与凭证并支持关闭', () => {
        const directory = createTemporaryDirectory();
        const store = new ConfigStore(directory);

        store.configureWebAccess('tvly-test-secret');

        expect(store.read().webAccess).toEqual({
            provider: 'tavily',
            credentialRef: 'web:tavily',
        });
        expect(store.getWebAccess()).toEqual({
            provider: 'tavily',
            apiKey: 'tvly-test-secret',
        });
        expect(store.isWebAccessConfigured()).toBeTrue();
        expect(fs.readFileSync(path.join(directory, 'config.json'), 'utf8')).not.toContain('tvly-test-secret');

        store.disableWebAccess();

        expect(store.read().webAccess).toBeNull();
        expect(store.isWebAccessConfigured()).toBeFalse();
        expect(fs.readFileSync(path.join(directory, 'secrets.json'), 'utf8')).not.toContain('tvly-test-secret');
    });

    test('读取尚无 webAccess 字段的 v1 配置时使用关闭状态', () => {
        const directory = createTemporaryDirectory();
        const store = new ConfigStore(directory);
        fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({
            version: 1,
            defaultModel: null,
            providers: {},
            maxSteps: 32,
            timezone: 'Asia/Shanghai',
        }));

        expect(store.read().webAccess).toBeNull();
    });

    test('分离保存渠道配置与凭证并支持模型切换', () => {
        const directory = createTemporaryDirectory();
        const store = new ConfigStore(directory);
        store.addProvider({
            providerId: 'local',
            type: 'openai-compatible',
            baseURL: 'http://127.0.0.1:3000/v1',
            apiKey: 'test-secret',
            models: {
                flash: { vision: false, contextWindow: 128000, maxOutputTokens: 4096 },
                pro: { vision: true, contextWindow: 128000, maxOutputTokens: 8192 },
            },
        });
        store.useModel({ providerId: 'local', modelId: 'pro' });
        store.setTimezone('Asia/Shanghai');

        expect(store.getModel().selection.modelId).toBe('pro');
        expect(store.read().timezone).toBe('Asia/Shanghai');
        expect(fs.readFileSync(path.join(directory, 'config.json'), 'utf8')).not.toContain('test-secret');
        expect(fs.readFileSync(path.join(directory, 'secrets.json'), 'utf8')).toContain('test-secret');
        expect(fs.statSync(path.join(directory, 'secrets.json')).mode & 0o777).toBe(0o600);
    });

    test('更新当前渠道时合并模型并保留默认选择', () => {
        const store = new ConfigStore(createTemporaryDirectory());
        store.addProvider({
            providerId: 'local',
            type: 'openai-compatible',
            baseURL: 'http://127.0.0.1:3000/v1',
            apiKey: 'old-secret',
            models: {
                old: { vision: false, contextWindow: 128000, maxOutputTokens: 4096 },
            },
        });

        store.addProvider({
            providerId: 'local',
            type: 'openai-compatible',
            baseURL: 'http://127.0.0.1:3000/v1',
            apiKey: 'new-secret',
            models: {
                current: { vision: true, contextWindow: 200000, maxOutputTokens: 8192 },
            },
        });

        expect(store.getModel().selection).toEqual({
            providerId: 'local',
            modelId: 'old',
        });
        expect(Object.keys(store.read().providers.local.models)).toEqual(['old', 'current']);
        expect(store.isConfigured()).toBeTrue();
    });

    test('无需解析旧文件即可按时间备份配置并清空模型凭证', () => {
        const directory = createTemporaryDirectory();
        const store = new ConfigStore(directory);
        const legacyConfig = '{"version":1,';
        fs.writeFileSync(path.join(directory, 'config.json'), legacyConfig);
        fs.writeFileSync(path.join(directory, 'secrets.json'), '{"version":1,');
        fs.writeFileSync(path.join(directory, 'keep.txt'), 'keep');

        const backupDirectory = store.backupAndReset();

        expect(backupDirectory).toBeDefined();
        if (!backupDirectory) {
            throw new Error('预期生成配置备份');
        }
        expect(path.basename(backupDirectory)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
        expect(fs.readFileSync(path.join(backupDirectory, 'config.json'), 'utf8')).toBe(legacyConfig);
        expect(fs.statSync(backupDirectory).mode & 0o777).toBe(0o700);
        expect(fs.statSync(path.join(backupDirectory, 'config.json')).mode & 0o777).toBe(0o600);
        expect(store.read().defaultModel).toBeNull();
        expect(store.read().providers).toEqual({});
        expect(JSON.parse(fs.readFileSync(path.join(directory, 'secrets.json'), 'utf8')).credentials).toEqual({});
        expect(fs.readFileSync(path.join(directory, 'keep.txt'), 'utf8')).toBe('keep');
        expect(fs.existsSync(path.join(backupDirectory, 'secrets.json'))).toBeFalse();
    });

    test('拒绝损坏或缺失的活动模型凭证', () => {
        const directory = createTemporaryDirectory();
        const store = new ConfigStore(directory);
        store.addProvider({
            providerId: 'local',
            type: 'openai-compatible',
            baseURL: 'http://127.0.0.1:3000/v1',
            apiKey: 'test-secret',
            models: {
                model: { vision: false, contextWindow: 128000, maxOutputTokens: 4096 },
            },
        });

        fs.writeFileSync(path.join(directory, 'secrets.json'), '{');
        expect(() => store.assertValid()).toThrow();
        fs.unlinkSync(path.join(directory, 'secrets.json'));
        expect(() => store.assertValid()).toThrow('活动模型配置不完整');
    });

    test('没有旧配置时直接创建默认配置且不生成空备份', () => {
        const directory = createTemporaryDirectory();
        const store = new ConfigStore(directory);

        expect(store.backupAndReset()).toBeUndefined();
        expect(store.read().defaultModel).toBeNull();
        expect(fs.existsSync(path.join(directory, 'backups'))).toBeFalse();
        expect(fs.existsSync(path.join(directory, 'secrets.json'))).toBeFalse();
    });
});


test('视觉辅助只选择已配置的视觉模型，优先当前模型且不改写默认选择', () => {
    const store = new ConfigStore(createTemporaryDirectory());
    expect(ModelFactory.createVision(store)).toBeNull();
    store.addProvider({ providerId: 'local', type: 'openai-compatible', baseURL: 'http://localhost:3000/v1', apiKey: '',
        models: {
            text: { vision: false, contextWindow: 32000, maxOutputTokens: 4096 },
            visionA: { vision: true, contextWindow: 64000, maxOutputTokens: 4096 },
            visionB: { vision: true, contextWindow: 64000, maxOutputTokens: 4096 },
        } });
    expect(ModelFactory.createVision(store)?.modelId).toBe('visionA');
    expect(store.getModel().selection.modelId).toBe('text');
    store.useModel({ providerId: 'local', modelId: 'visionB' });
    expect(ModelFactory.createVision(store)?.modelId).toBe('visionB');
});
