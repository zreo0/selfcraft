import type { WorkStore } from '../work/work-store';
import type { ToolRuntimeContext } from './index';
import { tool } from 'ai';
import { z } from 'zod';
import type { JobManager } from '../job/job-manager';

/**
 * 创建后台任务工具
 *
 * @param jobs 持久后台任务管理器
 * @returns AI SDK 工具集合
 */
export function createJobTools (jobs: JobManager, works?: WorkStore) {
    return {
        job_start: tool({
            description: '启动可独立运行的后台长任务。普通的短工具调用应当直接完成，不要滥用后台任务',
            inputSchema: z.discriminatedUnion('type', [
                z.object({
                    type: z.literal('agent'),
                    workId: z.string().optional(),
                    workRevision: z.number().int().positive().optional(),
                    title: z.string().min(1).max(120),
                    prompt: z.string().min(1).max(30000),
                    timeoutSeconds: z.number().int().min(1).max(86400).optional(),
                }),
                z.object({
                    type: z.literal('shell'),
                    workId: z.string().optional(),
                    workRevision: z.number().int().positive().optional(),
                    title: z.string().min(1).max(120),
                    command: z.string().min(1).max(100000),
                    cwd: z.string().optional(),
                    timeoutSeconds: z.number().int().min(1).max(86400).optional(),
                }),
            ]),
            execute: async (input, options) => {
                const context = options.context as ToolRuntimeContext | undefined;
                const workId = context?.workId || input.workId;
                const revision = context?.workRevision ?? input.workRevision;
                if (workId && (revision === undefined || !works)) {
                    throw new Error('关联事项需要最新版本');
                }
                if (workId) {
                    works!.requireCurrent(workId, revision!);
                }
                const owner = workId ? { workId, workRevision: revision! + 1 } : {};
                const job = input.type === 'agent'
                    ? jobs.createAgent(input.title, input.prompt, input.timeoutSeconds, owner)
                    : jobs.createShell(input.title, input.command, input.cwd, input.timeoutSeconds, owner);
                if (workId) {
                    works!.update(workId, revision!, {
                        status: 'waiting', waitFor: 'job', jobId: job.id,
                        next: '后台执行结束后核实结果并继续原目标',
                    });
                }
                return {
                    id: job.id,
                    title: job.title,
                    type: job.type,
                    status: job.status,
                    message: '任务已转入后台，完成或失败时会生成通知',
                };
            },
        }),
        job_list: tool({
            description: '查看后台任务列表和当前状态',
            inputSchema: z.object({
                limit: z.number().int().min(1).max(100).optional(),
            }),
            execute: async ({ limit = 30 }) => jobs.list(limit),
        }),
        job_status: tool({
            description: '查看单个后台任务及最近执行日志',
            inputSchema: z.object({
                id: z.string().uuid(),
                maxLogBytes: z.number().int().min(1024).max(256000).optional(),
            }),
            execute: async ({ id, maxLogBytes }) => jobs.readLog(id, maxLogBytes),
        }),
        job_cancel: tool({
            description: '取消排队中或正在执行的后台任务',
            inputSchema: z.object({
                id: z.string().uuid(),
            }),
            execute: async ({ id }) => ({ cancelled: jobs.cancel(id) }),
        }),
        job_resume: tool({
            description: '在检查实际状态后，重新排队中断或失败的后台任务',
            inputSchema: z.object({
                id: z.string().uuid(),
            }),
            execute: async ({ id }) => ({ resumed: jobs.resume(id) }),
        }),
    };
}
