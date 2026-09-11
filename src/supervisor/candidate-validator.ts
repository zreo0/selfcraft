import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { backupInstance, inspectDatabases, assertCompatibleData } from './instance-backup';

/** 从稳定边界验证候选和实例副本，原实例不会暴露给验收进程 */
export async function validateCandidate (candidatePath: string, home?: string): Promise<{ healthy: boolean; output: string }> {
    const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-candidate-state-'));
    let output = '';
    try {
        if (home && fs.existsSync(home)) {
            backupInstance(home, isolatedHome);
        }
        // 验收不需要模型凭证，避免候选测试访问用户的模型账户
        fs.rmSync(path.join(isolatedHome, 'config'), { recursive: true, force: true });
        const before = inspectDatabases(isolatedHome);
        const commands = [
            ['bun', 'run', 'typecheck'],
            ['bun', 'test'],
            ['bun', 'run', 'src/doctor.ts', '--code-only'],
            ['bun', 'run', 'src/runtime-entry.ts', '--check-state'],
        ];
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
            !/API_KEY|ACCESS_TOKEN|SECRET|PASSWORD/i.test(key)));
        for (const command of commands) {
            const child = Bun.spawn(command, {
                cwd: candidatePath,
                env: { ...env, SELFCRAFT_PROJECT_ROOT: candidatePath, SELFCRAFT_HOME: isolatedHome },
                stdout: 'pipe', stderr: 'pipe',
            });
            const timer = setTimeout(() => child.kill(), 120_000);
            const [stdout, stderr, code] = await Promise.all([
                new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
            ]);
            clearTimeout(timer);
            output += `$ ${command.join(' ')}\n${stdout}${stderr}`;
            if (code !== 0) {
                return { healthy: false, output };
            }
        }
        assertCompatibleData(before, inspectDatabases(isolatedHome));
        return { healthy: true, output };
    } catch (error) {
        return { healthy: false, output: `${output}\n${String(error)}` };
    } finally {
        fs.rmSync(isolatedHome, { recursive: true, force: true });
    }
}
