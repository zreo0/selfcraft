import * as fs from 'node:fs';
import * as path from 'node:path';
import { backupInstance, inspectDatabases, assertCompatibleData } from '../src/supervisor/instance-backup';

/** 从恢复备份复制到空目录并核对数据库，不覆盖运行中实例或较新的数据 */
function main (): void {
    const [source, destination] = process.argv.slice(2);
    if (!source || !destination) {
        throw new Error('用法：bun run scripts/restore-instance.ts <备份的 instance 目录> <新的空数据目录>');
    }
    const from = path.resolve(source);
    const to = path.resolve(destination);
    if (from === to || to.startsWith(`${from}${path.sep}`) || from.startsWith(`${to}${path.sep}`)) {
        throw new Error('恢复源与目标目录不能相互包含');
    }
    if (fs.existsSync(to) && fs.readdirSync(to).length > 0) {
        throw new Error('目标必须为空目录；不会覆盖已有实例');
    }
    backupInstance(from, to);
    assertCompatibleData(inspectDatabases(from), inspectDatabases(to));
    console.log(`恢复完成。请使用匹配的 Runtime 版本，并将 SELFCRAFT_HOME 指向 ${to}`);
}

main();
