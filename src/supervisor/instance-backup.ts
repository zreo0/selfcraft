import * as fs from 'node:fs';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';

/** 复制实例事实与成果，SQLite 使用一致性序列化而非复制活动 WAL */
export function backupInstance (source: string, destination: string, root = true): void {
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        if ((root && ['evolution', 'supervisor', 'logs', 'runtime.lock'].includes(entry.name)) || /(?:-wal|-shm)$/.test(entry.name)) {
            continue;
        }
        const from = path.join(source, entry.name);
        const to = path.join(destination, entry.name);
        if (entry.isSymbolicLink()) {
            fs.symlinkSync(fs.readlinkSync(from), to);
        } else if (entry.isDirectory()) {
            backupInstance(from, to, false);
        } else if (entry.name.endsWith('.sqlite')) {
            const database = new Database(from, { readonly: true });
            try {
                fs.writeFileSync(to, database.serialize(), { mode: 0o600 });
            } finally {
                database.close();
            }
        } else {
            fs.copyFileSync(from, to);
            fs.chmodSync(to, 0o600);
        }
    }
}

/** 返回旧数据库所有表的列与数据，用于拒绝破坏性自动迁移 */
export function inspectDatabases (home: string): Record<string, { columns: string[]; rows: string[] }> {
    const result: Record<string, { columns: string[]; rows: string[] }> = {};
    /** 递归检查实例内部普通文件，不跟随外部链接 */
    const visit = (directory: string): void => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                visit(file);
            } else if (entry.isFile() && entry.name.endsWith('.sqlite')) {
                const database = new Database(file, { readonly: true });
                try {
                    const tables = database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
                    for (const { name } of tables) {
                        const quoted = `"${name.replaceAll('"', '""')}"`;
                        const columns = (database.query(`PRAGMA table_info(${quoted})`).all() as { name: string }[]).map(column => column.name);
                        const rows = database.query(`SELECT * FROM ${quoted}`).all();
                        result[`${path.relative(home, file)}:${name}`] = {
                            columns,
                            rows: rows.map(row => JSON.stringify(row, (_, value) => typeof value === 'bigint' ? value.toString() : value)).sort(),
                        };
                    }
                } finally {
                    database.close();
                }
            }
        }
    };
    visit(home);
    return result;
}

/** 验证旧列和旧数据仍完整存在，新增表和新增列允许自动发布 */
export function assertCompatibleData (
    before: ReturnType<typeof inspectDatabases>,
    after: ReturnType<typeof inspectDatabases>,
): void {
    for (const [table, old] of Object.entries(before)) {
        const current = after[table];
        if (!current || old.columns.some(column => !current.columns.includes(column))) {
            throw new Error(`自动升级不能删除实例表或字段：${table}`);
        }
        const projected = current.rows.map(row => {
            const record = JSON.parse(row);
            return JSON.stringify(Object.fromEntries(old.columns.map(column => [column, record[column]])));
        }).sort();
        if (JSON.stringify(old.rows) !== JSON.stringify(projected)) {
            throw new Error(`自动升级不能改写已有实例数据：${table}`);
        }
    }
}
