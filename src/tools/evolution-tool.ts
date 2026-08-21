import { tool } from 'ai';
import { z } from 'zod';
import type { EvolutionService } from '../evolution/evolution-service';

/** 创建只能读取可变源码并通过候选验证发布的演化工具 */
export function createEvolutionTools (evolution: EvolutionService) {
    return {
        runtime_files: tool({
            description: '列出允许演化的 Selfcraft Runtime 源码与工作区模板文件',
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
            description: '提出 Selfcraft Runtime 源码修改。候选必须通过类型检查、测试和健康检查，失败会拒绝激活',
            inputSchema: z.object({
                rationale: z.string().min(10).max(2000),
                changes: z.array(z.object({
                    path: z.string().min(1),
                    content: z.string().max(512 * 1024),
                })).min(1).max(12),
            }),
            execute: async ({ changes, rationale }) => evolution.propose(changes, rationale),
        }),
    };
}
