import type { Database } from 'bun:sqlite';

/** 首版状态格式只允许兼容性增加，破坏性迁移不属于 Runtime 自动演化 */
export const STATE_VERSION = 1;

/** 检查实例数据兼容范围；旧版无版本数据库原子登记为首版 */
export function assertStateVersion (database: Database): void {
    database.transaction(() => {
        const row = database.query('PRAGMA user_version').get() as { user_version: number };
        if (row.user_version > STATE_VERSION) {
            throw new Error(`实例数据版本 ${row.user_version} 超出当前支持范围 ${STATE_VERSION}`);
        }
        if (row.user_version === 0) {
            database.run(`PRAGMA user_version = ${STATE_VERSION}`);
        }
    }).immediate();
}
