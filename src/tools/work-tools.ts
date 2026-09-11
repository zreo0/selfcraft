import { tool } from 'ai';
import { z } from 'zod';
import type { WorkStore } from '../work/work-store';
import type { ToolRuntimeContext } from './index';

/** 创建事项工具；状态变更有版本检查，后台执行不得扩展原始授权 */
export function createWorkTools (works: WorkStore) {
    return {
        work_create: tool({
            description: '承接需要跨轮次推进的事项，记录目标、完成条件、用户授权和下一步；普通闲聊不用创建',
            inputSchema: z.object({
                goal: z.string().min(1).max(4000), acceptance: z.string().min(1).max(4000),
                authority: z.string().min(1).max(4000), next: z.string().min(1).max(4000),
            }),
            execute: async (input, options) => {
                const context = options.context as ToolRuntimeContext;
                if (!context || context.channel !== 'foreground') {
                    throw new Error('只有用户对话可以承接新事项；后台继续更新原事项');
                }
                return works.create({ ...input, sourceEventId: context.sourceEventId });
            },
        }),
        work_list: tool({
            description: '查看持续事项及最新版本，包括等待条件和验收依据',
            inputSchema: z.object({ id: z.string().optional(), includeFinished: z.boolean().optional() }),
            execute: async ({ id, includeFinished }) => id ? works.get(id) : works.list(includeFinished),
        }),
        work_update: tool({
            description: '按最新 revision 更新事项。完成必须给证据；等待需明确条件。用户改变目标时更新原事项，不新建 session',
            inputSchema: z.object({
                id: z.string(), revision: z.number().int().positive(),
                status: z.enum(['ready', 'waiting', 'completed', 'cancelled', 'blocked']),
                next: z.string().max(4000), evidence: z.string().max(24000),
                goal: z.string().min(1).max(4000).optional(), acceptance: z.string().min(1).max(4000).optional(),
                authority: z.string().min(1).max(4000).optional(),
                waitFor: z.enum(['user', 'time', 'job']).nullable().optional(),
                wakeAt: z.string().datetime({ offset: true }).nullable().optional(),
            }),
            execute: async ({ id, revision, ...patch }, options) => {
                const context = options.context as ToolRuntimeContext;
                if (!context) {
                    throw new Error('事项更新缺少可信来源');
                }
                if (context.channel === 'background' && (context.workId !== id
                    || patch.authority !== undefined || patch.goal !== undefined || patch.acceptance !== undefined)) {
                    throw new Error('后台只能推进原事项，不能改变用户目标或授权');
                }
                return works.update(id, revision, patch, context.channel === 'foreground');
            },
        }),
    };
}
