import { createHash } from 'node:crypto';
import { tool } from 'ai';
import { z } from 'zod';
import type { WorkStore } from '../work/work-store';
import type { ToolRuntimeContext } from './index';

/** 创建事项工具；状态变更有版本检查，后台执行不得扩展原始授权 */
export function createWorkTools (works: WorkStore) {
    return {
        work_create: tool({
            description: '派发独立事项，继承当前上下文立即在后台推进；也可设置 waitFor 先记录等待，届时再运行',
            inputSchema: z.object({
                goal: z.string().min(1).max(4000), acceptance: z.string().min(1).max(4000),
                authority: z.string().min(1).max(4000), next: z.string().min(1).max(4000),
                waitFor: z.enum(['user', 'time']).optional(),
                wakeAt: z.string().datetime({ offset: true }).optional(),
                writablePaths: z.array(z.string().min(1)).max(20).optional(),
            }),
            execute: async (input, options) => {
                const context = options.context as ToolRuntimeContext;
                if (!context || context.channel !== 'foreground') {
                    throw new Error('只有用户对话可以承接新事项；后台继续更新原事项');
                }
                const id = createHash('sha256').update(`${context.runId}:${options.toolCallId}`).digest('hex').slice(0, 32);
                context.forkWork?.(id);
                return works.create({ ...input, sourceEventId: context.sourceEventId }, id);
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
                status: z.enum(['ready', 'running', 'waiting', 'completed', 'cancelled', 'blocked']),
                next: z.string().max(4000), evidence: z.string().max(24000),
                goal: z.string().min(1).max(4000).optional(), acceptance: z.string().min(1).max(4000).optional(),
                authority: z.string().min(1).max(4000).optional(),
                writablePaths: z.array(z.string().min(1)).max(20).optional(),
                notify: z.boolean().optional().describe('重要进展需主脑关注时开启，普通步骤不要开启'),
                waitFor: z.enum(['user', 'time', 'job']).nullable().optional(),
                wakeAt: z.string().datetime({ offset: true }).nullable().optional(),
            }),
            execute: async ({ id, revision, notify, ...patch }, options) => {
                const context = options.context as ToolRuntimeContext;
                if (!context) {
                    throw new Error('事项更新缺少可信来源');
                }
                if (context.channel === 'background' && (context.workId !== id
                    || patch.authority !== undefined || patch.writablePaths !== undefined || patch.goal !== undefined || patch.acceptance !== undefined)) {
                    throw new Error('后台只能推进原事项，不能改变用户目标或授权');
                }
                const current = works.get(id);
                if (!current || current.revision !== revision) {
                    return { updated: false, current, message: '事项已有新进展，请依据当前状态重新决定修改' };
                }
                const updated = works.update(id, revision, patch, context.channel === 'foreground');
                if (notify && context.channel === 'background') works.report(id, [updated.evidence, updated.next].filter(Boolean).join('\n'));
                return updated;
            },
        }),
    };
}
