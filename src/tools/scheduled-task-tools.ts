import { tool } from 'ai';
import { z } from 'zod';
import type {
    ScheduledTaskManager,
    ScheduledTaskRecord,
} from '../task/scheduled-task-manager';

const scheduledTaskContextSchema = z.object({
    runId: z.string().min(1),
    sourceEventId: z.string().min(1),
    timezone: z.string().min(1).max(100),
    channel: z.enum(['foreground', 'background']),
    taskId: z.string().min(1).optional(),
    topicIds: z.array(z.string().min(1)).max(20).optional(),
});

/** AI 工具返回的最小提醒状态 */
interface ScheduledTaskToolResult {
    /** 提醒标识 */
    id: string;
    /** 便于后续对话识别提醒的标题 */
    title: string;
    /** 当前状态 */
    status: ScheduledTaskRecord['status'];
    /** UTC 格式的绝对到期时间 */
    dueAt: string;
    /** 用户时区 */
    timezone: string;
    /** 用户最初使用的时间表达式 */
    originalExpression: string;
}

/**
 * 创建一次性定时提醒工具
 *
 * @param tasks 一次性提醒管理器
 * @returns 创建、列表与取消工具
 */
export function createScheduledTaskTools (tasks: ScheduledTaskManager) {
    return {
        task_schedule: tool({
            description: '创建一次性定时提醒。dueAt 必须是已经解析好的绝对 ISO 时间，不支持重复规则、Cron 或任意动作',
            contextSchema: scheduledTaskContextSchema,
            inputSchema: z.object({
                title: z.string().min(1).max(120),
                message: z.string().min(1).max(4000),
                dueAt: z.iso.datetime({ offset: true }),
                originalExpression: z.string().min(1).max(300),
            }),
            execute: async (input, { context, toolCallId }) => toToolResult(tasks.create({
                ...input,
                timezone: context.timezone,
                runId: context.runId,
                sourceEventId: context.sourceEventId,
                topicIds: context.topicIds,
                idempotencyKey: `task-schedule:${context.runId}:${toolCallId}`,
            })),
        }),
        task_list: tool({
            description: '列出一次性定时提醒及其当前状态',
            contextSchema: scheduledTaskContextSchema,
            inputSchema: z.object({
                limit: z.number().int().min(1).max(100).optional(),
            }),
            execute: async ({ limit = 30 }) => tasks.list(limit).map(toToolResult),
        }),
        task_cancel: tool({
            description: '取消一条尚未触发的一次性定时提醒',
            contextSchema: scheduledTaskContextSchema,
            inputSchema: z.object({
                id: z.string().uuid(),
            }),
            execute: async ({ id }, { context }) => {
                const existing = tasks.get(id);
                if (!existing) {
                    throw new Error('定时提醒不存在');
                }
                tasks.cancel(id, {
                    runId: context.runId,
                    sourceEventId: context.sourceEventId,
                    timezone: context.timezone,
                    topicIds: context.topicIds,
                });
                return toToolResult(tasks.get(id) || existing);
            },
        }),
    };
}

/**
 * 将完整提醒收敛为工具所需的稳定返回值
 *
 * @param task 完整提醒
 * @returns 最小提醒状态
 */
function toToolResult (task: ScheduledTaskRecord): ScheduledTaskToolResult {
    return {
        id: task.id,
        title: task.title,
        status: task.status,
        dueAt: task.dueAt,
        timezone: task.timezone,
        originalExpression: task.originalExpression,
    };
}
