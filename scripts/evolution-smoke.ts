import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePaths } from '../src/config/paths';
import { EvolutionService } from '../src/evolution/evolution-service';
import { Logger } from '../src/logging/logger';
import { ReleaseStore } from '../src/supervisor/release-store';

/** 复制当前项目到临时位置，但复用已安装依赖 */
function createProjectCopy (source: string, destination: string): void {
    fs.cpSync(source, destination, {
        recursive: true,
        filter: item => {
            const firstPart = path.relative(source, item).split(path.sep)[0];
            return !['.git', '.selfcraft', 'node_modules', 'coverage'].includes(firstPart);
        },
    });
    fs.symlinkSync(path.join(source, 'node_modules'), path.join(destination, 'node_modules'), 'dir');
}

/** 验证真实候选检查、原子激活和备份回滚闭环 */
async function main (): Promise<void> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-evolution-smoke-'));
    const source = path.resolve(import.meta.dir, '..');
    const project = path.join(root, 'project');
    try {
        createProjectCopy(source, project);
        const paths = resolvePaths('development', path.join(root, 'home'));
        paths.project = project;
        const releases = new ReleaseStore(paths.supervisor, paths.evolution);
        const service = new EvolutionService(paths, releases, new Logger(paths.logs));
        const markerPath = 'src/evolution/__tests__/candidate-marker.test.ts';
        await service.propose([{
            path: markerPath,
            content: [
                "import { expect, test } from 'bun:test';",
                '',
                "test('candidate marker', () => {",
                '    expect(true).toBeTrue();',
                '});',
                '',
            ].join('\n'),
        }], 'Verify the complete candidate validation, activation and rollback pipeline');
        releases.activate(project);
        if (!fs.existsSync(path.join(project, markerPath)) || releases.read()?.status !== 'pending') {
            throw new Error('候选版本未被正确激活');
        }
        releases.rollback(project, 'acceptance rollback');
        if (fs.existsSync(path.join(project, markerPath)) || releases.read()?.status !== 'rolled_back') {
            throw new Error('候选版本未被正确回滚');
        }
        console.log(JSON.stringify({
            healthy: true,
            candidateValidation: true,
            atomicActivation: true,
            rollback: true,
        }, null, 4));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
