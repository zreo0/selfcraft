import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PathGuard } from '../path-guard';

const temporaryDirectories: string[] = [];

/** 创建并追踪测试临时目录 */
function createTemporaryDirectory (): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-path-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('PathGuard', () => {
    test('允许 workspace 内读写并拒绝父目录逃逸', () => {
        const workspace = createTemporaryDirectory();
        const guard = new PathGuard(workspace);
        fs.writeFileSync(path.join(workspace, 'note.md'), 'hello');

        const realWorkspace = fs.realpathSync(workspace);
        expect(guard.resolveRead('note.md')).toBe(path.join(realWorkspace, 'note.md'));
        expect(guard.resolveWrite('nested/new.md')).toBe(path.join(realWorkspace, 'nested/new.md'));
        expect(() => guard.resolveWrite('../outside.md')).toThrow('路径超出 workspace');
    });

    test('拒绝指向 workspace 外部的符号链接', () => {
        const workspace = createTemporaryDirectory();
        const outside = createTemporaryDirectory();
        fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
        fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(workspace, 'escape'));

        expect(() => new PathGuard(workspace).resolveRead('escape')).toThrow('路径超出 workspace');
    });
});
