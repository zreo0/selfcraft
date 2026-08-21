import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePaths } from '../../config/paths';
import { Logger } from '../../logging/logger';
import { ReleaseStore } from '../release-store';
import { Supervisor } from '../supervisor';

const temporaryDirectories: string[] = [];

/** 创建并追踪测试临时目录 */
function createTemporaryDirectory (): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-supervisor-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('Supervisor', () => {
    test('新 Runtime 在观察期崩溃时回滚并启动旧版本', async () => {
        const root = createTemporaryDirectory();
        const project = path.join(root, 'project');
        const home = path.join(root, 'home');
        const runtimePath = path.join(project, 'src', 'runtime-entry.ts');
        fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
        fs.writeFileSync(path.join(project, 'package.json'), '{"type":"module"}');
        fs.writeFileSync(path.join(project, 'src', 'doctor.ts'), 'process.exit(0);\n');
        fs.writeFileSync(runtimePath, 'process.exit(1);\n');

        const paths = resolvePaths('development', home);
        paths.project = project;
        const releases = new ReleaseStore(paths.supervisor, paths.evolution);
        const backupDirectory = path.join('backups', 'failed-release');
        const backupPath = path.join(paths.evolution, backupDirectory, 'src', 'runtime-entry.ts');
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.writeFileSync(backupPath, 'process.exit(0);\n');
        releases.recordPending({
            id: 'failed-release',
            rationale: 'supervisor acceptance',
            createdAt: new Date().toISOString(),
            backupDirectory,
            files: [{ path: 'src/runtime-entry.ts', existed: true }],
        });

        const exitCode = await new Supervisor(paths, new Logger(paths.logs)).run();

        expect(exitCode).toBe(0);
        expect(releases.read()?.status).toBe('rolled_back');
        expect(fs.readFileSync(runtimePath, 'utf8')).toBe('process.exit(0);\n');
    });

    test('新 Runtime 在观察期完成请求并请求重启时标记稳定', async () => {
        const root = createTemporaryDirectory();
        const project = path.join(root, 'project');
        const home = path.join(root, 'home');
        const runtimePath = path.join(project, 'src', 'runtime-entry.ts');
        fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
        fs.writeFileSync(path.join(project, 'package.json'), '{"type":"module"}');
        fs.writeFileSync(path.join(project, 'src', 'doctor.ts'), 'process.exit(0);\n');
        fs.writeFileSync(runtimePath, [
            "import * as fs from 'node:fs';",
            "import * as path from 'node:path';",
            "const marker = path.join(process.env.SELFCRAFT_HOME!, 'runtime-seen');",
            'if (!fs.existsSync(marker)) {',
            "    fs.writeFileSync(marker, 'seen');",
            '    process.exit(75);',
            '}',
            'process.exit(0);',
            '',
        ].join('\n'));

        const paths = resolvePaths('development', home);
        paths.project = project;
        const releases = new ReleaseStore(paths.supervisor, paths.evolution);
        releases.recordPending({
            id: 'quick-restart',
            rationale: 'quick successful request',
            createdAt: new Date().toISOString(),
            backupDirectory: path.join('backups', 'quick-restart'),
            files: [],
        });

        const exitCode = await new Supervisor(paths, new Logger(paths.logs)).run();

        expect(exitCode).toBe(0);
        expect(releases.read()?.status).toBe('stable');
    });
});
