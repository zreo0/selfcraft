import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillRegistry } from '../skill-registry';

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
});
