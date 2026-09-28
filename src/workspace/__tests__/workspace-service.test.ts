import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceService } from '../workspace-service';

test('派生档案保持稳定，手动修改不被覆盖也不混入核心上下文', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-profile-'));
    try {
        const workspace = new WorkspaceService(root, path.resolve('workspace-template'));
        workspace.initialize();
        expect(workspace.writeUserProfile('用户喜欢简洁')).toBe('written');
        const file = path.join(root, 'USER.md');
        const before = fs.statSync(file).mtimeMs;
        expect(workspace.writeUserProfile('用户喜欢简洁')).toBe('unchanged');
        expect(fs.statSync(file).mtimeMs).toBe(before);
        fs.appendFileSync(file, '\n手动记录的内容');
        expect(workspace.writeUserProfile('用户喜欢详细')).toBe('conflict');
        expect(fs.readFileSync(file, 'utf8')).toContain('手动记录的内容');
        expect(workspace.readCoreContext()).not.toContain('手动记录的内容');
        fs.writeFileSync(path.join(root, 'MEMORY.md'), '旧的冲突事实');
        expect(workspace.readCoreContext()).not.toContain('旧的冲突事实');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
