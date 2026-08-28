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

/** CLI 阶段使用的持久通知收件箱 */
export class NotificationInbox {
    /**
     * 创建通知收件箱
     *
     * @param filePath JSONL 文件路径
     */
    constructor (private readonly filePath: string) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
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
        const existing = this.list().find(notification => notification.id === id);
        if (existing) {
            return existing;
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
        fs.appendFileSync(this.filePath, `${JSON.stringify(notification)}\n`, 'utf8');
        return notification;
    }

    /**
     * 列出所有通知
     *
     * @returns 按写入顺序排列的通知
     */
    public list (): Notification[] {
        if (!fs.existsSync(this.filePath)) {
            return [];
        }
        return fs.readFileSync(this.filePath, 'utf8').split(/\r?\n/)
            .filter(Boolean)
            .map(line => JSON.parse(line) as Notification);
    }

    /** 清空通知收件箱 */
    public clear (): void {
        fs.writeFileSync(this.filePath, '', 'utf8');
    }
}
