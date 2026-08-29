import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillRegistry } from '../skill-registry';
import { WorkspaceService } from '../../workspace/workspace-service';

const temporaryDirectories: string[] = [];

/** 创建并追踪测试临时目录 */
function createTemporaryDirectory (): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-skill-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('SkillRegistry', () => {
    test('无需重启即可发现新技能', () => {
        const skillsPath = createTemporaryDirectory();
        const registry = new SkillRegistry(skillsPath);
        expect(registry.discover()).toEqual([]);

        fs.mkdirSync(path.join(skillsPath, 'research'));
        fs.writeFileSync(
            path.join(skillsPath, 'research', 'SKILL.md'),
            '# Research\n\nSearch and verify current sources before answering.\n',
        );

        expect(registry.discover()[0]).toMatchObject({
            name: 'research',
            description: 'Search and verify current sources before answering.',
        });
        expect(registry.read('research')).toContain('# Research');
    });

    test('新工作区默认安装可替换实现的网络研究技能', () => {
        const root = createTemporaryDirectory();
        const workspacePath = path.join(root, 'workspace');
        const templatePath = path.resolve(import.meta.dir, '../../../workspace-template');
        new WorkspaceService(workspacePath, templatePath).initialize();
        const registry = new SkillRegistry(path.join(workspacePath, 'skills'));

        expect(registry.discover()).toContainEqual(expect.objectContaining({
            name: 'web-research',
        }));
        expect(registry.read('web-research')).toContain('web_search');
        expect(registry.read('web-research')).not.toContain('Tavily');
    });
});
