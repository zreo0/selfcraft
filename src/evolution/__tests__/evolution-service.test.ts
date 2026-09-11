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

        expect(fs.readFileSync(path.join(project, 'src', 'agent', 'behavior.ts'), 'utf8')).toContain('1');
        releases.activate(project);
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

test('暂存候选不覆盖随后发生的实例源码修改，稳定备份可以回退', async () => {
    const root = createTemporaryDirectory();
    const paths = resolvePaths('development', path.join(root, 'home'));
    paths.project = path.join(root, 'project');
    fs.mkdirSync(path.join(paths.project, 'src'), { recursive: true });
    const file = path.join(paths.project, 'src', 'behavior.ts');
    fs.writeFileSync(file, 'export const value = 1;');
    const releases = new ReleaseStore(paths.supervisor, paths.evolution);
    const service = new EvolutionService(paths, releases, new Logger(paths.logs), async () => ({ healthy: true, output: 'verified' }));
    await service.propose([{ path: 'src/behavior.ts', content: 'export const value = 2;' }], 'Verified local improvement');
    fs.writeFileSync(file, 'export const value = 3;');
    expect(() => releases.activate(paths.project)).toThrow('基础已改变');
    releases.rollback(paths.project, 'conflict');
    expect(fs.readFileSync(file, 'utf8')).toContain('3');
    await service.propose([{ path: 'src/behavior.ts', content: 'export const value = 4;' }], 'Rebased improvement');
    releases.activate(paths.project);
    releases.markStable();
    expect(fs.existsSync(path.join(paths.evolution, releases.read()!.backupDirectory))).toBeTrue();
    releases.rollback(paths.project, 'later behavioral regression');
    expect(fs.readFileSync(file, 'utf8')).toContain('3');
});

test('并发演化只有一个候选进入验证与发布通道', async () => {
    const root = createTemporaryDirectory();
    const paths = resolvePaths('development', path.join(root, 'home'));
    paths.project = path.join(root, 'project');
    fs.mkdirSync(path.join(paths.project, 'src'), { recursive: true });
    let finish: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const service = new EvolutionService(paths, new ReleaseStore(paths.supervisor, paths.evolution), new Logger(paths.logs), async () => {
        await gate;
        return { healthy: true, output: 'verified' };
    });
    const first = service.propose([{ path: 'src/one.ts', content: 'export const one = 1;' }], 'First validated change');
    await expect(service.propose([{ path: 'src/two.ts', content: 'export const two = 2;' }], 'Concurrent change')).rejects.toThrow('正在验证');
    finish();
    await first;
});
