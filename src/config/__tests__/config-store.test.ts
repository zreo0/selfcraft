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
});
