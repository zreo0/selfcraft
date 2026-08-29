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
    test('大段正文单独落盘并保留可直接使用的开头', async () => {
        const workspace = createTemporaryDirectory();
        const tools = wrapToolsWithResultOffload({
            large: {
                execute: async () => ({ source: 'test', content: 'x'.repeat(20000) }),
            },
        }, workspace);

        const result = await tools.large.execute({});

        expect(result).toMatchObject({
            source: 'test',
            contentTruncated: true,
            contentBytes: 20000,
        });
        expect(result.content.length).toBeLessThan(3000);
        expect(result.contentPath).toEndWith('.txt');
        expect(fs.readFileSync(path.join(workspace, result.contentPath), 'utf8')).toBe('x'.repeat(20000));
    });

    test('read 的大分页只缩短返回内容而不制造递归副本', async () => {
        const workspace = createTemporaryDirectory();
        const tools = wrapToolsWithResultOffload({
            read: {
                execute: async () => ({
                    path: 'files/source.md',
                    content: 'line\n'.repeat(5000),
                    totalLines: 5000,
                    hasMore: false,
                }),
            },
        }, workspace);

        const result = await tools.read.execute({});

        expect(result).toMatchObject({
            path: 'files/source.md',
            contentTruncated: true,
        });
        expect(result.hint).toContain('缩小 limit');
        expect(fs.existsSync(path.join(workspace, 'files', 'tool-results'))).toBeFalse();
    });

    test('没有正文的大型结构化结果仍保存为 JSON', async () => {
        const workspace = createTemporaryDirectory();
        const tools = wrapToolsWithResultOffload({
            large: {
                execute: async () => ({ items: Array.from({ length: 1000 }, (_, index) => ({ index, value: 'x'.repeat(20) })) }),
            },
        }, workspace);

        const result = await tools.large.execute({});

        expect(result.offloaded).toBe(true);
        expect(result.path).toEndWith('.json');
        expect(fs.readFileSync(path.join(workspace, result.path), 'utf8')).toContain('"index":999');
    });
});
