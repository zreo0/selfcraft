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
        const notification = {
            id: randomUUID(),
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
