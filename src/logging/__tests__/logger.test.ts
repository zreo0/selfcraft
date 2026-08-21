import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Logger } from '../logger';

const temporaryDirectories: string[] = [];

/** 创建并追踪测试临时目录 */
function createTemporaryDirectory (): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-logger-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('Logger', () => {
    test('使用 JSONL 记录并脱敏常见凭证', () => {
        const directory = createTemporaryDirectory();
        const logger = new Logger(directory, 'debug');
        logger.info('request with sk-abcdefghijklmnop', {
            apiKey: 'plain-secret',
            modelId: 'flash',
        });

        const content = fs.readFileSync(path.join(directory, 'selfcraft.log'), 'utf8');
        expect(content).not.toContain('abcdefghijklmnop');
        expect(content).not.toContain('plain-secret');
        expect(JSON.parse(content).context.modelId).toBe('flash');
    });
});
