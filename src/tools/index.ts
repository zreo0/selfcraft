import type { Tool } from 'ai';
import { createEvolutionTools } from './evolution-tool';
import { createFileTools } from './file-tools';
import { createJobTools } from './job-tools';
import { createMemoryTools } from './memory-tools';
import { createNotifyTool } from './notify-tool';
import { PathGuard } from './path-guard';
import { createShellTool } from './shell-tool';
import { createSkillTools } from './skill-tools';
import { createScheduledTaskTools } from './scheduled-task-tools';
import { createWebTools } from './web-tools';
import { wrapToolsWithResultOffload } from '../context/result-store';
import type { EvolutionService } from '../evolution/evolution-service';
import type { JobManager } from '../job/job-manager';
import type { MemoryStore } from '../memory/memory-store';
import type { NotificationInbox } from '../notification/notification-inbox';
import type { SkillRegistry } from '../skills/skill-registry';
import type { ScheduledTaskManager } from '../task/scheduled-task-manager';
import type { WebProvider } from '../web-access/web-provider';

/** Runtime 注入每次工具执行的可信上下文 */
export type ToolRuntimeContext = {
    /** 本轮 Agent 运行标识 */
    runId: string;
    /** 触发本轮执行的用户或后台任务事件 */
    sourceEventId: string;
    /** 当前用户时区 */
    timezone: string;
    /** 前台对话或后台任务 */
    channel: 'foreground' | 'background';
    /** 关联的后台任务 */
    taskId?: string;
    /** 当前运行已知的长期事项 */
    topicIds?: string[];
};

/**
 * 创建 Runtime 的完整基础工具集合
 *
 * @param workspacePath 工作区路径
 * @param skills 技能注册表
 * @param notifications 本地通知收件箱
 * @param evolution 演化服务
 * @param jobs 持久后台任务
 * @param memory 结构化长期记忆
 * @param scheduledTasks 一次性定时提醒，可选以便独立脚本复用基础工具
 * @param webProvider 可替换的外部搜索与网页读取实现
 * @returns AI SDK 工具集合
 */
export function createTools (
    workspacePath: string,
    skills: SkillRegistry,
    notifications: NotificationInbox,
    evolution: EvolutionService,
    jobs: JobManager,
    memory: MemoryStore,
    scheduledTasks?: ScheduledTaskManager,
    webProvider?: WebProvider,
) {
    const guard = new PathGuard(workspacePath);
    const tools = {
        ...createFileTools(guard),
        shell: createShellTool(guard),
        ...createSkillTools(skills),
        ...createJobTools(jobs),
        ...createMemoryTools(memory),
        ...(scheduledTasks ? createScheduledTaskTools(scheduledTasks) : {}),
        ...(webProvider ? createWebTools(webProvider) : {}),
        notify: createNotifyTool(notifications),
        ...createEvolutionTools(evolution),
    };
    const offloaded = wrapToolsWithResultOffload(tools, workspacePath);
    return wrapToolsWithTimeline(offloaded, memory);
}

/**
 * 为工具调用写入可追溯的开始、结果或失败事件
 *
 * @param tools 已完成大结果落盘处理的工具集合
 * @param memory 事件时间线
 * @returns 保持原工具 schema 的包装工具
 */
function wrapToolsWithTimeline (
    tools: Record<string, any>,
    memory: MemoryStore,
): Record<string, Tool<any, any, ToolRuntimeContext>> {
    return Object.fromEntries(Object.entries(tools).map(([name, definition]) => {
        if (typeof definition.execute !== 'function') {
            return [name, definition];
        }
        return [name, {
            ...definition,
            execute: async (input: unknown, options: any) => {
                const context = readToolRuntimeContext(options?.context);
                if (!context) {
                    return definition.execute(input, options);
                }
                const callEvent = memory.recordEvent({
                    actor: 'agent',
                    type: 'tool_call',
                    payload: {
                        toolName: name,
                        toolCallId: options.toolCallId,
                        input: toTimelineValue(input),
                    },
                    timezone: context.timezone,
                    runId: context.runId,
                    ...(context.taskId && { taskId: context.taskId }),
                    sourceEventId: context.sourceEventId,
                    idempotencyKey: `run:${context.runId}:tool:${options.toolCallId}:call`,
                });
                let result: unknown;
                try {
                    result = await definition.execute(input, options);
                } catch (error) {
                    try {
                        memory.recordEvent({
                            actor: `tool:${name}`,
                            type: 'tool_error',
                            payload: {
                                toolName: name,
                                toolCallId: options.toolCallId,
                                error: redactTimelineText(error instanceof Error ? error.message : String(error)),
                            },
                            timezone: context.timezone,
                            runId: context.runId,
                            ...(context.taskId && { taskId: context.taskId }),
                            sourceEventId: callEvent.id,
                            idempotencyKey: `run:${context.runId}:tool:${options.toolCallId}:error`,
                        });
                    } catch {
                        // 审计失败不能遮蔽真实工具错误
                    }
                    throw error;
                }
                try {
                    memory.recordEvent({
                        actor: `tool:${name}`,
                        type: 'tool_result',
                        payload: {
                            toolName: name,
                            toolCallId: options.toolCallId,
                            result: toTimelineValue(result),
                        },
                        timezone: context.timezone,
                        runId: context.runId,
                        ...(context.taskId && { taskId: context.taskId }),
                        sourceEventId: callEvent.id,
                        idempotencyKey: `run:${context.runId}:tool:${options.toolCallId}:result`,
                    });
                } catch {
                    // 工具已经成功，结果审计失败不能改写真实执行结果
                }
                return result;
            },
        }];
    })) as Record<string, Tool<any, any, ToolRuntimeContext>>;
}

/** 读取合法的工具运行上下文，允许测试直接调用无上下文工具 */
function readToolRuntimeContext (value: unknown): ToolRuntimeContext | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const candidate = value as Partial<ToolRuntimeContext>;
    if (typeof candidate.runId !== 'string'
        || typeof candidate.sourceEventId !== 'string'
        || typeof candidate.timezone !== 'string'
        || (candidate.channel !== 'foreground' && candidate.channel !== 'background')) {
        return null;
    }
    return candidate as ToolRuntimeContext;
}

/** 将工具输入或结果压缩成适合时间线保存的有界数据 */
function toTimelineValue (value: unknown): unknown {
    let serialized: string;
    try {
        serialized = JSON.stringify(value) ?? 'null';
    } catch {
        return '[无法序列化]';
    }
    const redacted = redactTimelineText(serialized);
    if (redacted.length > 4000) {
        return { preview: redacted.slice(0, 4000), truncated: true };
    }
    try {
        return JSON.parse(redacted) as unknown;
    } catch {
        return redacted;
    }
}

/** 遮盖工具事件中的常见凭证形态 */
function redactTimelineText (value: string): string {
    return value
        .replace(/\b(?:sk|tvly|ghp|github_pat)-[A-Za-z0-9_-]{12,}\b/gi, '[REDACTED]')
        .replace(/((?:api[_-]?key|access[_-]?token|password)["'\s]*[:=]["'\s]*)[^,"'\s}]+/gi, '$1[REDACTED]');
}
