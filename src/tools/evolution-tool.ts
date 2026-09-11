import type { ToolRuntimeContext } from './index';
import { tool } from 'ai';
import { z } from 'zod';
import type { EvolutionService } from '../evolution/evolution-service';

/** 创建只能读取可变源码并通过候选验证发布的演化工具 */
export function createEvolutionTools (evolution: EvolutionService) {
    return {
        runtime_release: tool({
            description: '查看最新发布是否已由 Supervisor 应用、稳定或回滚，以及对应成长候选',
            inputSchema: z.object({}),
            execute: async () => evolution.releaseStatus(),
        }),
        runtime_files: tool({
            description: '列出允许演化的 Runtime 源码与模板。实例身份、记忆和技能属于实例数据，上游修改必须基于当前实际源码形成候选',
            inputSchema: z.object({}),
            execute: async () => evolution.listMutableFiles(),
        }),
        runtime_read: tool({
            description: '读取一个允许演化的 Runtime 源码文件',
            inputSchema: z.object({
                path: z.string().min(1),
            }),
            execute: async ({ path }) => ({ path, content: evolution.readMutableFile(path) }),
        }),
        evolve_runtime: tool({
            description: '暂存 Runtime 改进。必须复现问题并附针对性验证；Supervisor 重启后检查实例兼容性再切换，失败保留旧版本。不得删除或改写持久数据格式',
            inputSchema: z.object({
                rationale: z.string().min(10).max(2000),
                growthId: z.string().uuid().optional(),
                changes: z.array(z.object({
                    path: z.string().min(1),
                    content: z.string().max(512 * 1024),
                })).min(1).max(12),
            }),
            execute: async ({ changes, rationale, growthId }, options) => {
                const context = options.context as ToolRuntimeContext | undefined;
                const source = context?.workId?.startsWith('growth:') ? context.workId.slice('growth:'.length) : growthId;
                return evolution.propose(changes, rationale, source);
            },
        }),
    };
}
