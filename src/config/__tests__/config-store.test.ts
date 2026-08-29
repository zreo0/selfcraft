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
    test('首次读取不伪造默认模型', () => {
        const store = new ConfigStore(createTemporaryDirectory());

        expect(store.read().activeModel).toBeNull();
        expect(store.read().timezone).toBeTruthy();
        expect(store.isConfigured()).toBeFalse();
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

        expect(store.getActiveModel().selection.modelId).toBe('pro');
        expect(store.read().timezone).toBe('Asia/Shanghai');
        expect(fs.readFileSync(path.join(directory, 'config.json'), 'utf8')).not.toContain('test-secret');
        expect(fs.readFileSync(path.join(directory, 'secrets.json'), 'utf8')).toContain('test-secret');
        expect(fs.statSync(path.join(directory, 'secrets.json')).mode & 0o777).toBe(0o600);
    });

    test('更新当前渠道并移除旧模型时自动切换到新模型', () => {
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

        expect(store.getActiveModel().selection).toEqual({
            providerId: 'local',
            modelId: 'current',
        });
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
        expect(store.read().activeModel).toBeNull();
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
        expect(store.read().activeModel).toBeNull();
        expect(fs.existsSync(path.join(directory, 'backups'))).toBeFalse();
        expect(fs.existsSync(path.join(directory, 'secrets.json'))).toBeFalse();
    });
});
