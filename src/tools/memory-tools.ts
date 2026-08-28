import { tool } from 'ai';
import { z } from 'zod';
import type { MemoryStore } from '../memory/memory-store';
import type { ToolRuntimeContext } from './index';

const memoryKindSchema = z.enum([
    'identity',
    'fact',
    'preference',
    'relationship',
    'decision',
    'lesson',
]);

/**
 * 创建显式记忆、Episode 召回、Topic 与成长候选工具
 *
 * @param memory 结构化记忆存储
 * @returns AI SDK 工具集合
 */
export function createMemoryTools (memory: MemoryStore) {
    return {
        memory_remember: tool({
            description: '仅在用户明确要求长期记住时，保存已确认的事实、偏好、身份、关系、决定或经验教训',
            inputSchema: z.object({
                kind: memoryKindSchema,
                content: z.string().min(4).max(1000),
                importance: z.number().min(0).max(1).optional(),
                validFrom: z.string().optional(),
                validTo: z.string().optional(),
                topicIds: z.array(z.string().uuid()).max(20).optional(),
            }),
            execute: async ({
                kind,
                content,
                importance = 0.8,
                validFrom,
                validTo,
                topicIds,
            }, options) => {
                const context = requireUserMemoryContext(memory, options.context);
                return memory.remember({
                    kind,
                    content,
                    confidence: 1,
                    importance,
                    ...(validFrom && { validFrom }),
                    ...(validTo && { validTo }),
                    sourceEventIds: [context.sourceEventId],
                    ...(topicIds && { topicIds }),
                });
            },
        }),
        memory_search: tool({
            description: '检查当前结构化长期记忆及 Reflection 候选，不用于按时间回顾经历',
            inputSchema: z.object({
                query: z.string().max(500).optional(),
                limit: z.number().int().min(1).max(50).optional(),
            }),
            execute: async ({ query = '', limit = 20 }) => memory.search(query, limit),
        }),
        memory_confirm: tool({
            description: '仅在用户明确确认 Reflection 候选时激活；可同时补充现实有效时间与已有 Topic',
            inputSchema: z.object({
                id: z.string().uuid(),
                validFrom: z.string().optional(),
                validTo: z.string().optional(),
                topicIds: z.array(z.string().uuid()).max(20).optional(),
            }),
            execute: async ({ id, validFrom, validTo, topicIds }, options) => {
                const context = requireUserMemoryContext(memory, options.context);
                return memory.confirmMemory(id, [context.sourceEventId], {
                    ...(validFrom && { validFrom }),
                    ...(validTo && { validTo }),
                    ...(topicIds && { topicIds }),
                });
            },
        }),
        memory_recall: tool({
            description: '按文本、Topic、发生时间、认知时间或日历日期重建过往经历；回顾上周、去年同一天或长期事项时使用',
            inputSchema: z.object({
                query: z.string().max(500).optional(),
                topicIds: z.array(z.string().uuid()).max(20).optional(),
                from: z.string().optional(),
                to: z.string().optional(),
                calendarMonthDay: z.string().regex(/^\d{2}-\d{2}$/).optional(),
                validAt: z.string().optional(),
                knownAt: z.string().optional(),
                limitEvents: z.number().int().min(1).max(200).optional(),
                limitMemories: z.number().int().min(1).max(100).optional(),
            }),
            execute: async (input, options) => {
                const context = requireToolContext(options.context);
                const currentRunEventIds = memory.listEventsByRun(context.runId)
                    .map(event => event.id);
                return memory.recallEpisode(input, currentRunEventIds);
            },
        }),
        memory_correct: tool({
            description: '用纠错或现实变化语义修订一条长期记忆，并保留旧版本和证据链',
            inputSchema: z.object({
                id: z.string().uuid(),
                revisionKind: z.enum(['correction', 'world_change']),
                kind: memoryKindSchema,
                content: z.string().min(4).max(1000),
                confidence: z.number().min(0).max(1).optional(),
                importance: z.number().min(0).max(1).optional(),
                validFrom: z.string().optional(),
                validTo: z.string().optional(),
                topicIds: z.array(z.string().uuid()).max(20).optional(),
            }).superRefine((input, context) => {
                if (input.revisionKind === 'world_change' && !input.validFrom) {
                    context.addIssue({
                        code: 'custom',
                        path: ['validFrom'],
                        message: '现实变化必须提供开始生效时间',
                    });
                }
            }),
            execute: async ({
                id,
                revisionKind,
                kind,
                content,
                confidence = 1,
                importance = 0.8,
                validFrom,
                validTo,
                topicIds,
            }, options) => {
                const context = requireUserMemoryContext(memory, options.context);
                return memory.reviseMemory(id, {
                    revisionKind,
                    kind,
                    content,
                    confidence,
                    importance,
                    ...(validFrom && { validFrom }),
                    ...(validTo && { validTo }),
                    sourceEventIds: [context.sourceEventId],
                    ...(topicIds && { topicIds }),
                });
            },
        }),
        memory_forget: tool({
            description: '软忘记一条长期记忆，使其不再被正常召回，同时保留审计关系',
            inputSchema: z.object({
                id: z.string().uuid(),
            }),
            execute: async ({ id }, options) => {
                requireUserMemoryContext(memory, options.context);
                return { forgotten: memory.forget(id) };
            },
        }),
        memory_erase_event: tool({
            description: '按用户明确的隐私删除要求，硬删除一个原始事件及直接由它支撑的派生记忆',
            inputSchema: z.object({
                eventId: z.string().uuid(),
            }),
            execute: async ({ eventId }, options) => {
                requireUserMemoryContext(memory, options.context);
                return memory.eraseEvent(eventId);
            },
        }),
        topic_create: tool({
            description: '为跨多轮、可能持续很久的事项创建稳定 Topic；同名事项允许分别创建',
            inputSchema: z.object({
                title: z.string().min(1).max(200),
                kind: z.string().min(1).max(100).optional(),
            }),
            execute: async ({ title, kind }, options) => {
                const context = requireToolContext(options.context);
                const topic = memory.createTopic({ title, ...(kind && { kind }) });
                memory.linkEventTopic(context.sourceEventId, topic.id);
                return topic;
            },
        }),
        topic_search: tool({
            description: '按名称查找持续事项；返回稳定 ID，同名结果不会被自动合并',
            inputSchema: z.object({
                query: z.string().max(200).optional(),
                limit: z.number().int().min(1).max(50).optional(),
            }),
            execute: async ({ query = '', limit = 20 }) => memory.searchTopics(query, limit),
        }),
        topic_link_event: tool({
            description: '把当前对话或已召回的历史事件关联到一个持续事项；省略 eventId 时关联当前对话',
            inputSchema: z.object({
                eventId: z.string().uuid().optional(),
                topicId: z.string().uuid(),
            }),
            execute: async ({ eventId, topicId }, options) => {
                const context = requireToolContext(options.context);
                return {
                    linked: memory.linkEventTopic(eventId || context.sourceEventId, topicId),
                };
            },
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

/** 从工具执行参数读取由 Runtime 注入的可信来源 */
function requireToolContext (value: unknown): ToolRuntimeContext {
    if (!isToolRuntimeContext(value)) {
        throw new Error('当前工具缺少可信的运行上下文');
    }
    return value;
}

/**
 * 要求 active Memory 变更来自当前前台用户事件
 *
 * @param memory 事件存储
 * @param value 工具运行上下文
 * @returns 已验证的前台用户上下文
 */
function requireUserMemoryContext (memory: MemoryStore, value: unknown): ToolRuntimeContext {
    const context = requireToolContext(value);
    const source = memory.getEvent(context.sourceEventId);
    if (context.channel !== 'foreground' || !source || source.actor !== 'user') {
        throw new Error('长期记忆变更必须来自当前前台用户事件');
    }
    return context;
}

/** 判断未知值是否包含最小工具运行上下文 */
function isToolRuntimeContext (value: unknown): value is ToolRuntimeContext {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const candidate = value as Partial<ToolRuntimeContext>;
    return typeof candidate.runId === 'string'
        && typeof candidate.sourceEventId === 'string'
        && typeof candidate.timezone === 'string'
        && (candidate.channel === 'foreground' || candidate.channel === 'background');
}
