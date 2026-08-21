import { tool } from 'ai';
import { z } from 'zod';
import type { MemoryStore } from '../memory/memory-store';

/**
 * 创建显式记忆与成长候选工具
 *
 * @param memory 结构化记忆存储
 * @returns AI SDK 工具集合
 */
export function createMemoryTools (memory: MemoryStore) {
    return {
        memory_remember: tool({
            description: '显式记住用户要求长期保留的稳定事实、偏好、承诺或经验',
            inputSchema: z.object({
                kind: z.enum(['identity', 'user', 'preference', 'relationship', 'commitment', 'procedure', 'experience']),
                content: z.string().min(4).max(1000),
                importance: z.number().min(0).max(1).optional(),
            }),
            execute: async ({ kind, content, importance = 0.8 }) => memory.remember({
                kind,
                content,
                confidence: 1,
                importance,
            }),
        }),
        memory_search: tool({
            description: '检索结构化长期记忆，需要回顾早期事实、偏好或经验时使用',
            inputSchema: z.object({
                query: z.string().max(500).optional(),
                limit: z.number().int().min(1).max(50).optional(),
            }),
            execute: async ({ query = '', limit = 20 }) => memory.search(query, limit),
        }),
        memory_forget: tool({
            description: '按记忆 ID 忘记用户要求删除或已确认失效的长期记忆',
            inputSchema: z.object({
                id: z.string().uuid(),
            }),
            execute: async ({ id }) => ({ forgotten: memory.forget(id) }),
        }),
        growth_list: tool({
            description: '查看 Reflection 积累的技能与 Runtime 成长候选及其证据数',
            inputSchema: z.object({
                status: z.enum(['proposed', 'accepted', 'dismissed']).optional(),
            }),
            execute: async ({ status }) => memory.listGrowth(status),
        }),
        growth_resolve: tool({
            description: '在完成验证、技能改进或 Runtime 演化后，标记成长候选的处理结果',
            inputSchema: z.object({
                id: z.string().uuid(),
                status: z.enum(['accepted', 'dismissed']),
            }),
            execute: async ({ id, status }) => ({ updated: memory.resolveGrowth(id, status) }),
        }),
    };
}
