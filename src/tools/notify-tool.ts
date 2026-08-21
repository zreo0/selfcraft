import { tool } from 'ai';
import { z } from 'zod';
import type { NotificationInbox } from '../notification/notification-inbox';

/** 创建本地通知工具，未来通信适配器可复用相同边界 */
export function createNotifyTool (inbox: NotificationInbox) {
    return tool({
        description: '记录需要用户稍后看到的本地通知',
        inputSchema: z.object({
            title: z.string().min(1).max(120),
            message: z.string().min(1).max(4000),
        }),
        execute: async ({ title, message }) => inbox.push(title, message),
    });
}
