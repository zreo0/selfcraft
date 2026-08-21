import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePaths } from '../../config/paths';
import { Logger } from '../../logging/logger';
import { ReleaseStore } from '../../supervisor/release-store';
import { EvolutionService } from '../evolution-service';

const temporaryDirectories: string[] = [];

/** 创建并追踪测试临时目录 */
function createTemporaryDirectory (): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-evolution-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('EvolutionService', () => {
    test('只在候选健康后激活，并可从备份回滚', async () => {
        const root = createTemporaryDirectory();
        const project = path.join(root, 'project');
        const home = path.join(root, 'home');
        fs.mkdirSync(path.join(project, 'src', 'agent'), { recursive: true });
        fs.writeFileSync(path.join(project, 'src', 'agent', 'behavior.ts'), 'export const value = 1;\n');
        fs.writeFileSync(path.join(project, 'package.json'), '{}');
        const paths = resolvePaths('development', home);
        paths.project = project;
        const releases = new ReleaseStore(paths.supervisor, paths.evolution);
        const service = new EvolutionService(
            paths,
            releases,
            new Logger(paths.logs),
            async () => ({ healthy: true, output: 'all checks passed' }),
        );

        await service.propose([{
            path: 'src/agent/behavior.ts',
            content: 'export const value = 2;\n',
        }], 'Fix a reproduced behavior and cover it with tests');

        expect(fs.readFileSync(path.join(project, 'src', 'agent', 'behavior.ts'), 'utf8')).toContain('2');
        expect(releases.read()?.status).toBe('pending');
        releases.rollback(project, 'simulated crash');
        expect(fs.readFileSync(path.join(project, 'src', 'agent', 'behavior.ts'), 'utf8')).toContain('1');
        expect(releases.read()?.status).toBe('rolled_back');
    });

    test('拒绝修改 Supervisor 边界', async () => {
        const root = createTemporaryDirectory();
        const paths = resolvePaths('development', path.join(root, 'home'));
        paths.project = path.join(root, 'project');
        fs.mkdirSync(paths.project, { recursive: true });
        const service = new EvolutionService(
            paths,
            new ReleaseStore(paths.supervisor, paths.evolution),
            new Logger(paths.logs),
            async () => ({ healthy: true, output: 'ok' }),
        );

        expect(service.propose([{
            path: 'src/supervisor/supervisor.ts',
            content: 'broken',
        }], 'Attempt to modify immutable supervisor boundary')).rejects.toThrow('不可演化');
    });
});
