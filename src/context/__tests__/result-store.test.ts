import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { wrapToolsWithResultOffload } from '../result-store';

const temporaryDirectories: string[] = [];

/** 创建并追踪测试临时目录 */
function createTemporaryDirectory (): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-result-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('result store', () => {
    test('大工具结果落到 workspace 并只返回预览', async () => {
        const workspace = createTemporaryDirectory();
        const tools = wrapToolsWithResultOffload({
            large: {
                execute: async () => ({ content: 'x'.repeat(20000) }),
            },
        }, workspace);

        const result = await tools.large.execute({});

        expect(result.offloaded).toBe(true);
        expect(result.preview.length).toBeLessThan(3000);
        expect(fs.readFileSync(path.join(workspace, result.path), 'utf8')).toContain('x'.repeat(10000));
    });
});
