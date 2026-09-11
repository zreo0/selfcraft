import { Database } from 'bun:sqlite';
import { assertStateVersion } from '../supervisor/state-version';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

/** 一条本地通知 */
export interface Notification {
    /** 通知标识 */
    id: string;
    /** 创建时间 */
    createdAt: string;
    /** 简短标题 */
    title: string;
    /** 通知正文 */
    message: string;
}

/** 所有入口共用的持久通知，已读记录仍保留投递去重标识 */
export class NotificationInbox {
    private readonly database: Database;
    /**
     * 创建通知收件箱
     *
     * @param filePath JSONL 文件路径
     */
    constructor (private readonly filePath: string) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        this.database = new Database(`${filePath}.sqlite`);
        assertStateVersion(this.database);
        this.database.run('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
        this.database.run(`CREATE TABLE IF NOT EXISTS notifications (
            id TEXT PRIMARY KEY, record TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0
        ); CREATE TABLE IF NOT EXISTS notification_import (id INTEGER PRIMARY KEY);`);
        this.database.transaction(() => {
            if (this.database.query('SELECT id FROM notification_import WHERE id = 1').get()) {
                return;
            }
            if (fs.existsSync(filePath)) {
                for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean)) {
                    const notification = JSON.parse(line) as Notification;
                    this.database.query('INSERT OR IGNORE INTO notifications (id, record) VALUES (?, ?)')
                        .run(notification.id, JSON.stringify(notification));
                }
            }
            this.database.run('INSERT INTO notification_import VALUES (1)');
        }).immediate();
    }

    /**
     * 写入一条通知
     *
     * @param title 标题
     * @param message 正文
     * @returns 已保存通知
     */
    public push (title: string, message: string): Notification {
        return this.append(randomUUID(), title, message);
    }

    /**
     * 使用稳定标识写入通知，重复调用时返回已有记录
     *
     * @param id 稳定通知标识
     * @param title 标题
     * @param message 正文
     * @returns 已存在或新保存的通知
     */
    public pushOnce (id: string, title: string, message: string): Notification {
        const existing = this.database.query('SELECT record FROM notifications WHERE id = ?').get(id) as { record: string } | null;
        if (existing) {
            return JSON.parse(existing.record);
        }
        return this.append(id, title, message);
    }

    /**
     * 追加一条指定标识的通知
     *
     * @param id 通知标识
     * @param title 标题
     * @param message 正文
     * @returns 已保存通知
     */
    private append (id: string, title: string, message: string): Notification {
        const notification = {
            id,
            createdAt: new Date().toISOString(),
            title,
            message,
        };
        this.database.query('INSERT OR IGNORE INTO notifications (id, record) VALUES (?, ?)').run(id, JSON.stringify(notification));
        return notification;
    }

    /**
     * 列出所有通知
     *
     * @returns 按写入顺序排列的通知
     */
    public list (): Notification[] {
        const rows = this.database.query('SELECT record FROM notifications WHERE acknowledged = 0 ORDER BY rowid').all() as { record: string }[];
        return rows.map(row => JSON.parse(row.record));
    }

    /** 将当前通知标记已读，保留去重依据 */
    public clear (): void {
        this.database.run('UPDATE notifications SET acknowledged = 1 WHERE acknowledged = 0');
    }
}
