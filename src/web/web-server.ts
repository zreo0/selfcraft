import { ConversationStore } from '../conversation/conversation-store';
import { AttachmentStore, MAX_IMAGES, MAX_IMAGE_BYTES } from '../attachment/attachment-store';
import { userContentFiles } from '../model/user-content';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
    createUIMessageStream,
    createUIMessageStreamResponse,
    streamText,
    type UIMessage,
    type UserModelMessage,
} from 'ai';
import { z } from 'zod';
import type { ForegroundRunner } from '../agent/foreground-runner';
import {
    completeAgentActivity,
    createAgentActivity,
    failAgentActivity,
    type AgentActivity,
    type AgentRunEvent,
    type AgentSource,
} from '../agent/run-events';
import type { ConfigStore } from '../config/config-store';
import { ModelFactory } from '../model/model-factory';
import type { SelfcraftPaths } from '../config/paths';
import type { SelfcraftConfig } from '../config/types';
import type { HealthChecker } from '../health/health-checker';
import type { JobManager } from '../job/job-manager';
import type { Logger } from '../logging/logger';
import type { EventRecord, MemoryItem, MemoryStore } from '../memory/memory-store';
import { eventSearchText } from '../memory/memory-search';
import type { NotificationInbox } from '../notification/notification-inbox';
import type { SkillRegistry } from '../skills/skill-registry';
import type { ScheduledTaskManager } from '../task/scheduled-task-manager';

const chatRequestSchema = z.object({
    trigger: z.enum(['submit-message', 'regenerate-message']).optional(),
    messages: z.array(z.object({
        role: z.enum(['system', 'user', 'assistant']),
        parts: z.array(z.unknown()),
    }).passthrough()).min(1),
}).passthrough();

const modelCapabilitiesSchema = z.object({
    vision: z.boolean().default(false),
    contextWindow: z.number().int().positive().max(10_000_000),
    maxOutputTokens: z.number().int().positive().max(1_000_000),
});

const providerRequestSchema = z.object({
    providerId: z.string().min(1).max(64),
    type: z.enum(['openai-compatible', 'openai', 'anthropic']),
    baseURL: z.string().max(2048).optional(),
    apiKey: z.string().max(8192).default(''),
    modelId: z.string().min(1).max(128).optional(),
    vision: z.boolean().default(false).optional(),
    contextWindow: z.number().int().positive().max(10_000_000).optional(),
    maxOutputTokens: z.number().int().positive().max(1_000_000).optional(),
    models: z.record(z.string().min(1).max(128), modelCapabilitiesSchema).optional(),
}).superRefine((value, context) => {
    const hasSingleModel = value.modelId !== undefined
        && value.contextWindow !== undefined
        && value.maxOutputTokens !== undefined;
    if (!hasSingleModel && !value.models) {
        context.addIssue({
            code: 'custom',
            message: '请提供一个模型或 models 配置',
        });
    }
});

const modelRequestSchema = z.object({
    providerId: z.string().min(1).max(64).optional(),
    modelId: z.string().min(1).max(128).optional(),
    purpose: z.enum(['agent', 'reflection', 'compression']).default('agent'),
    reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
    inherit: z.boolean().default(false),
}).refine(value => value.inherit
    ? value.purpose !== 'agent'
    : Boolean(value.providerId && value.modelId), '请选择模型，或让后台用途跟随默认模型');

const timezoneRequestSchema = z.object({
    timezone: z.string().min(1).max(100),
});

const webAccessRequestSchema = z.object({
    apiKey: z.string().trim().min(1).max(8192).refine(value => !/[\r\n]/.test(value), 'API key 必须是单行文本'),
});

const memoryConfirmSchema = z.object({
    validFrom: z.string().max(64).optional(),
});

const memoryCorrectSchema = z.object({
    content: z.string().trim().min(4, '请至少写下四个字').max(1000, '内容过长'),
    revisionKind: z.enum(['correction', 'world_change']),
    validFrom: z.string().max(64).optional(),
}).refine(value => value.revisionKind !== 'world_change' || Boolean(value.validFrom), {
    message: '情况变化需要写明从哪天开始',
    path: ['validFrom'],
});

const memoryResidentSchema = z.object({
    resident: z.boolean(),
});

interface WebMessageMetadata {
    /** 时间线序号，用于稳定排序 */
    seq: number;
    /** 消息发生时间 */
    occurredAt: string;
}

interface WebMessageData extends Record<string, unknown> {
    /** 不进入持久消息的短暂运行状态 */
    status: {
        phase: 'queued' | 'preparing' | 'thinking';
        label: string;
    };
    /** 当前 Agent 运行产生的结构化活动 */
    activity: {
        status: 'working' | 'complete';
        items: AgentActivity[];
    };
}

/** Web 端使用的 AI SDK UI 消息 */
export type SelfcraftUIMessage = UIMessage<WebMessageMetadata, WebMessageData>;

/** Web 服务实际监听的地址 */
export interface WebServerAddress {
    /** 监听主机 */
    hostname: string;
    /** 监听端口 */
    port: number;
    /** 便于展示的访问地址 */
    url: string;
}

/** 同一 Runtime 中的 Web 通信入口与静态文件服务 */
export class WebServer {
    private server?: Bun.Server<undefined>;
    private readonly attachments: AttachmentStore;
    private readonly conversation: ConversationStore;
    private readonly subscriptions = new Set<() => void>();

    /**
     * 创建 Web 入口
     *
     * @param dependencies Runtime 共享服务与生命周期回调
     */
    constructor (private readonly dependencies: {
        paths: SelfcraftPaths;
        config: ConfigStore;
        agent: ForegroundRunner;
        conversation?: ConversationStore;
        memory: MemoryStore;
        skills: SkillRegistry;
        notifications: NotificationInbox;
        jobs: JobManager;
        scheduledTasks: ScheduledTaskManager;
        health: HealthChecker;
        logger: Logger;
        staticDirectory: string;
        onRestart: () => void;
    }) {
        this.attachments = new AttachmentStore(dependencies.paths.home);
        this.conversation = dependencies.conversation || new ConversationStore(dependencies.paths.state);
        this.importHistory();
    }

    /**
     * 启动 HTTP 服务
     *
     * @param hostname 监听主机
     * @param port 监听端口，0 表示由系统分配
     * @returns 实际监听地址
     */
    public start (
        hostname = process.env.SELFCRAFT_WEB_HOST || '127.0.0.1',
        port = parsePort(process.env.SELFCRAFT_WEB_PORT),
    ): WebServerAddress {
        if (this.server) {
            return this.address();
        }
        this.server = Bun.serve({
            hostname,
            port,
            maxRequestBodySize: MAX_IMAGE_BYTES + 65536,
            fetch: (request, server) => {
                if (request.method === 'POST' && new URL(request.url).pathname === '/api/chat') {
                    // 图片读取期间可能没有流式输出，执行预算由 ForegroundRunner 控制
                    server.timeout(request, 0);
                }
                return this.fetch(request);
            },
        });
        const address = this.address();
        this.dependencies.logger.info('Web entry started', { ...address });
        return address;
    }

    /** 停止接受新的 Web 请求 */
    public stop (): void {
        for (const close of this.subscriptions) close();
        this.server?.stop(true);
        this.server = undefined;
    }

    /**
     * 处理一个 Web 请求，公开该方法以便做无端口单元测试
     *
     * @param request 标准 Fetch 请求
     * @returns HTTP 响应
     */
    public async fetch (request: Request): Promise<Response> {
        const url = new URL(request.url);
        try {
            if (url.pathname.startsWith('/api/')) {
                return await this.handleApi(request, url);
            }
            return await this.serveStatic(request, url.pathname);
        } catch (error) {
            this.dependencies.logger.warn('Web request failed', {
                method: request.method,
                path: url.pathname,
                error: error instanceof Error ? error.message : String(error),
            });
            return jsonResponse({ error: publicError(error) }, 400);
        }
    }

    /** 返回当前服务监听地址 */
    private address (): WebServerAddress {
        if (!this.server) {
            throw new Error('Web 服务尚未启动');
        }
        const hostname = this.server.hostname || '127.0.0.1';
        const port = this.server.port || 0;
        const displayHost = ['0.0.0.0', '::'].includes(hostname) ? '127.0.0.1' : hostname;
        return {
            hostname,
            port,
            url: `http://${displayHost}:${port}`,
        };
    }

    /** 分发同源 API 请求 */
    private async handleApi (request: Request, url: URL): Promise<Response> {
        if (request.method === 'POST' && url.pathname === '/api/attachments') {
            const origin = request.headers.get('origin');
            if (origin && origin !== url.origin) {
                return new Response('不允许跨站上传', { status: 403 });
            }
            if (Number(request.headers.get('content-length')) > MAX_IMAGE_BYTES + 65536) {
                return new Response('图片不能超过 10 MB', { status: 413 });
            }
            const form = await request.formData();
            const file = form.get('file');
            if (!(file instanceof File)) {
                throw new Error('请选择图片');
            }
            return jsonResponse(await this.attachments.save(file));
        }
        if (request.method === 'GET' && url.pathname.startsWith('/api/attachments/')) {
            const { bytes, mediaType } = this.attachments.read(url.pathname);
            return new Response(new Uint8Array(bytes), { headers: {
                'Content-Type': mediaType,
                'Cache-Control': 'private, max-age=31536000, immutable',
                'X-Content-Type-Options': 'nosniff',
            } });
        }
        if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
            return jsonResponse(this.buildBootstrap());
        }
        if (request.method === 'GET' && url.pathname === '/api/messages') {
            const limit = parseOptionalInteger(url.searchParams.get('limit')) || 50;
            const before = parseOptionalInteger(url.searchParams.get('before'));
            return jsonResponse(this.buildMessages(limit, before));
        }
        if (request.method === 'GET' && url.pathname === '/api/conversation/events') {
            return this.streamConversation(request);
        }
        if (request.method === 'POST' && url.pathname === '/api/conversation/stop') {
            this.assertMutationRequest(request);
            this.dependencies.agent.interrupt();
            return jsonResponse({ stopped: true });
        }
        if (request.method === 'POST' && url.pathname === '/api/conversation/messages') {
            this.assertMutationRequest(request);
            if (!this.dependencies.config.isConfigured()) return new Response('请先完成模型配置', { status: 409 });
            const body = chatRequestSchema.parse(await request.json());
            const input = this.readInput(body);
            const id = z.string().min(1).max(128).parse(body.id || randomUUID());
            void this.dependencies.agent.run(input, () => undefined, {
                executionId: id, retry: body.trigger === 'regenerate-message',
            }).catch(error => this.dependencies.logger.warn('对话未完成，执行记录已保留', { error: publicChatError(error) }));
            return jsonResponse({ id }, 202);
        }
        if (request.method === 'POST' && url.pathname === '/api/chat') {
            this.assertMutationRequest(request);
            return await this.handleChat(request);
        }
        if (request.method === 'POST' && url.pathname === '/api/config/providers') {
            this.assertMutationRequest(request);
            const input = providerRequestSchema.parse(await request.json());
            const models = input.models || {
                [input.modelId!]: {
                    vision: input.vision || false,
                    contextWindow: input.contextWindow!,
                    maxOutputTokens: input.maxOutputTokens!,
                },
            };
            this.dependencies.config.addProvider({
                providerId: input.providerId,
                type: input.type,
                baseURL: input.baseURL,
                apiKey: input.apiKey,
                models,
            });
            return jsonResponse(this.buildConfigView());
        }
        if (request.method === 'PUT' && url.pathname === '/api/config/model') {
            this.assertMutationRequest(request);
            const input = modelRequestSchema.parse(await request.json());
            this.dependencies.config.useModel(input.inherit ? null : {
                providerId: input.providerId!,
                modelId: input.modelId!,
                ...(input.reasoningEffort && { reasoningEffort: input.reasoningEffort }),
            }, input.purpose);
            return jsonResponse(this.buildConfigView());
        }
        if (request.method === 'POST' && url.pathname === '/api/config/model/test') {
            this.assertMutationRequest(request);
            const input = modelRequestSchema.parse(await request.json());
            const active = ModelFactory.create(this.dependencies.config, input.purpose, undefined,
                input.inherit ? undefined : {
                    providerId: input.providerId!, modelId: input.modelId!, reasoningEffort: input.reasoningEffort,
                });
            const startedAt = Date.now();
            const result = streamText({
                model: active.model,
                prompt: 'Reply with OK only.',
                maxOutputTokens: Math.min(active.maxOutputTokens, 256),
                maxRetries: 0,
                abortSignal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
            });
            // 测试走真实流式协议，但不写会话、记忆或修改默认模型
            for await (const part of result.fullStream) {
                if (part.type === 'error') {
                    throw part.error;
                }
            }
            return jsonResponse({
                durationMs: Date.now() - startedAt,
                finishReason: await result.finishReason,
                warnings: await result.warnings,
            });
        }
        if (request.method === 'PUT' && url.pathname === '/api/config/timezone') {
            this.assertMutationRequest(request);
            const input = timezoneRequestSchema.parse(await request.json());
            this.dependencies.config.setTimezone(input.timezone);
            return jsonResponse(this.buildConfigView());
        }
        if (request.method === 'POST' && url.pathname === '/api/config/web') {
            this.assertMutationRequest(request);
            const input = webAccessRequestSchema.parse(await request.json());
            this.dependencies.config.configureWebAccess(input.apiKey);
            return jsonResponse(this.buildConfigView());
        }
        if (request.method === 'DELETE' && url.pathname === '/api/config/web') {
            this.assertMutationRequest(request);
            await request.json();
            this.dependencies.config.disableWebAccess();
            return jsonResponse(this.buildConfigView());
        }
        if (request.method === 'POST' && url.pathname === '/api/config/reset') {
            this.assertMutationRequest(request);
            const backupDirectory = this.dependencies.config.backupAndReset();
            return jsonResponse({
                backupDirectory,
                config: this.buildConfigView(),
            });
        }
        if (request.method === 'GET' && url.pathname === '/api/skills') {
            return jsonResponse({ items: this.dependencies.skills.discover() });
        }
        if (request.method === 'GET' && url.pathname === '/api/jobs') {
            return jsonResponse({ items: this.dependencies.jobs.list() });
        }
        const jobMatch = matchResourcePath(url.pathname, '/api/jobs');
        if (request.method === 'GET' && jobMatch) {
            return jsonResponse(this.dependencies.jobs.readLog(jobMatch.id));
        }
        const jobActionMatch = matchResourceActionPath(url.pathname, '/api/jobs');
        if (request.method === 'POST' && jobActionMatch) {
            this.assertMutationRequest(request);
            await request.json();
            const changed = jobActionMatch.action === 'cancel'
                ? this.dependencies.jobs.cancel(jobActionMatch.id)
                : jobActionMatch.action === 'resume'
                    ? this.dependencies.jobs.resume(jobActionMatch.id)
                    : false;
            if (!['cancel', 'resume'].includes(jobActionMatch.action)) {
                return jsonResponse({ error: '接口不存在' }, 404);
            }
            return jsonResponse({ changed });
        }
        if (request.method === 'GET' && url.pathname === '/api/tasks') {
            return jsonResponse({ items: this.dependencies.scheduledTasks.list() });
        }
        const taskActionMatch = matchResourceActionPath(url.pathname, '/api/tasks');
        if (request.method === 'POST' && taskActionMatch?.action === 'cancel') {
            this.assertMutationRequest(request);
            await request.json();
            return jsonResponse({ changed: this.cancelScheduledTask(taskActionMatch.id) });
        }
        if (request.method === 'GET' && url.pathname === '/api/topics') {
            return jsonResponse({
                items: this.dependencies.memory.searchTopics(url.searchParams.get('q') || '', 50),
            });
        }
        if (request.method === 'GET' && url.pathname === '/api/memories') {
            return jsonResponse({
                items: this.dependencies.memory.search(url.searchParams.get('q') || '', 50),
            });
        }
        if (request.method === 'GET' && url.pathname === '/api/memory') {
            return jsonResponse(this.buildMemoryOverview(url));
        }
        const memoryMatch = matchResourcePath(url.pathname, '/api/memory');
        if (request.method === 'GET' && memoryMatch) {
            return jsonResponse(this.buildMemoryDetail(memoryMatch.id));
        }
        const memoryActionMatch = matchResourceActionPath(url.pathname, '/api/memory');
        if (request.method === 'POST' && memoryActionMatch) {
            this.assertMutationRequest(request);
            return jsonResponse({
                memory: memoryView(this.applyMemoryAction(memoryActionMatch.id, memoryActionMatch.action, await request.json())),
            });
        }
        if (request.method === 'GET' && url.pathname === '/api/growth') {
            return jsonResponse({ items: this.dependencies.memory.listGrowth('proposed') });
        }
        if (request.method === 'GET' && url.pathname === '/api/notifications') {
            return jsonResponse({ items: this.dependencies.notifications.list() });
        }
        if (request.method === 'DELETE' && url.pathname === '/api/notifications') {
            this.assertMutationRequest(request);
            await request.json();
            this.dependencies.notifications.clear();
            return jsonResponse({ cleared: true });
        }
        return jsonResponse({ error: '接口不存在' }, 404);
    }

    /** 记录可信用户操作并取消指定提醒 */
    private cancelScheduledTask (id: string): boolean {
        const runId = randomUUID();
        const timezone = this.dependencies.config.read().timezone;
        const source = this.dependencies.memory.recordEvent({
            actor: 'user',
            type: 'client_command',
            payload: { command: 'task_cancel', taskId: id },
            runId,
            taskId: id,
            timezone,
            idempotencyKey: `run:${runId}:client-command`,
        });
        return this.dependencies.scheduledTasks.cancel(id, {
            runId,
            sourceEventId: source.id,
            timezone,
        });
    }

    /** 按同一检索词分页返回当前认识、候选和历史，返回总数避免把截断当成全部 */
    private buildMemoryOverview (url: URL): object {
        const memory = this.dependencies.memory;
        const query = url.searchParams.get('q') || '';
        const offset = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(url.searchParams.get('offset') || 0);
        const profileIds = memory.profileMemories().map(item => item.id);
        const current = memory.listMemoryPage('current', { query, offset, profileIds });
        const pending = memory.listMemoryPage('pending', { query, offset });
        const versions = memory.listMemoryPage('versions', { query, offset });
        const totals = { current: current.total, pending: pending.total, versions: versions.total };
        return {
            profileIds,
            current: current.items.map(memoryView),
            pending: pending.items.map(item => {
                const previous = item.supersedesId ? memory.getMemory(item.supersedesId) : null;
                return { ...memoryView(item), previous: previous ? memoryView(previous) : null,
                    confirmable: !item.supersedesId || previous?.status === 'active' };
            }),
            versions: versions.items.map(memoryView),
            totals,
            nextOffset: Object.values(totals).some(total => total > offset + 100) ? offset + 100 : null,
        };
    }

    /** 读取一条认识的修订链与原话来源；工具输出等非对话证据只显示类型 */
    private buildMemoryDetail (id: string): object {
        const memory = this.dependencies.memory;
        const item = memory.getMemory(id);
        if (!item) {
            throw new Error('这条记忆不存在');
        }
        const sources = memory.getEvents(item.status === 'forgotten' ? [] : item.sourceEventIds)
            .sort((left, right) => right.occurredFrom.localeCompare(left.occurredFrom))
            .slice(0, 20)
            .map(event => ({
                id: event.id,
                occurredFrom: event.occurredFrom,
                actor: event.actor,
                type: event.type,
                text: eventSearchText(event) || null,
            }));
        return {
            memory: memoryView(item),
            history: memory.memoryHistory(id).map(memoryView),
            sources,
            sourceCount: item.status === 'forgotten' ? 0 : item.sourceEventIds.length,
        };
    }

    /**
     * 执行记忆页上的一次修正，确认与纠正都以本次用户操作作为新的来源
     *
     * @param id 目标认识
     * @param action confirm、correct、forget 或 resident
     * @param body 已解析的 JSON 请求体
     * @returns 操作后的认识
     */
    private applyMemoryAction (id: string, action: string, body: unknown): MemoryItem {
        const memory = this.dependencies.memory;
        const target = memory.getMemory(id);
        if (!target) {
            throw new Error('这条记忆不存在');
        }
        const runId = randomUUID();
        const event = {
            actor: 'user',
            type: 'client_command',
            runId,
            timezone: this.dependencies.config.read().timezone,
            idempotencyKey: `run:${runId}:client-command`,
        };
        if (action === 'confirm') {
            const input = memoryConfirmSchema.parse(body);
            const validFrom = memoryEffectiveTime(input.validFrom, event.timezone);
            return memory.applyUserEdit({ ...event, payload: { command: 'memory_confirm', memoryId: id, text: `我确认：${target.content}` } },
                eventId => memory.confirmMemory(id, [eventId], { ...(validFrom && { validFrom }) }));
        }
        if (action === 'correct') {
            const input = memoryCorrectSchema.parse(body);
            const validFrom = memoryEffectiveTime(input.validFrom, event.timezone);
            if (target.status !== 'active') {
                throw new Error('只能修正当前成立的认识');
            }
            const prefix = input.revisionKind === 'correction' ? '之前记错了，应该是' : '情况变了，现在是';
            return memory.applyUserEdit({ ...event, payload: { command: 'memory_correct', memoryId: id, text: `${prefix}：${input.content}` } },
                eventId => memory.reviseMemory(id, {
                    kind: target.kind,
                    content: input.content,
                    confidence: 1,
                    importance: target.importance,
                    revisionKind: input.revisionKind,
                    ...(validFrom && { validFrom }),
                    sourceEventIds: [eventId],
                }));
        }
        if (action === 'forget') {
            // 忘记的事件不写入正文，避免被遗忘的内容通过这条操作记录重新被检索到
            return memory.applyUserEdit({ ...event, payload: { command: 'memory_forget', memoryId: id } }, () => {
                if (!memory.forget(id)) throw new Error('这条记忆已经被忘记');
                return memory.getMemory(id)!;
            });
        }
        if (action === 'resident') {
            const input = memoryResidentSchema.parse(body);
            return memory.applyUserEdit({ ...event, payload: { command: 'memory_resident', memoryId: id, resident: input.resident } },
                () => memory.setResident(id, input.resident));
        }
        throw new Error('不支持的记忆操作');
    }

    /** 把当前非敏感配置、状态和最近消息交给页面初始化 */
    private buildBootstrap (): object {
        let config: ReturnType<WebServer['buildConfigView']> | null = null;
        let configurationError: string | null = null;
        try {
            this.dependencies.config.assertValid();
            config = this.buildConfigView();
        } catch (error) {
            configurationError = publicError(error);
        }
        return {
            product: 'Selfcraft',
            config,
            configurationError,
            messages: this.buildMessages(50),
            runtime: {
                environment: this.dependencies.paths.environment,
                home: this.dependencies.paths.home,
                workspace: this.dependencies.paths.workspace,
                pendingForegroundRuns: this.dependencies.agent.getPendingCount(),
                checks: this.dependencies.health.check(this.dependencies.paths),
            },
        };
    }

    /** 返回不包含 credentialRef 与密钥的页面配置 */
    private buildConfigView (): object {
        const config = this.dependencies.config.read();
        return {
            configured: this.dependencies.config.isConfigured(),
            timezone: config.timezone,
            defaultModel: config.defaultModel,
            modelOverrides: config.modelOverrides,
            webAccess: config.webAccess ? {
                provider: config.webAccess.provider,
                configured: this.dependencies.config.isWebAccessConfigured(),
            } : null,
            providers: Object.entries(config.providers).map(([id, provider]) => ({
                id,
                type: provider.type,
                baseURL: provider.baseURL,
                credentialConfigured: this.dependencies.config.hasCredential(id),
                auth: provider.auth,
                models: Object.entries(provider.models).map(([modelId, model]) => ({
                    id: modelId,
                    ...model,
                })),
            })),
        } satisfies WebConfigView;
    }

    /** 首次启用交付视图时保留既有对话 */
    private importHistory (): void {
        if (this.conversation.page(1).items.length === 0) {
            const pages: SelfcraftUIMessage[][] = [];
            let before: number | undefined;
            do {
                const events = this.dependencies.memory.listConversationEvents(100, before);
                if (!events.length) break;
                pages.unshift(events.map(event => ({ ...toUIMessage(event, event.runId ? this.dependencies.memory.listEventsByRun(event.runId) : []),
                    id: event.runId ? `${event.type === 'user_message' ? 'user' : 'assistant'}:${event.runId}` : event.id })));
                before = events[0]!.seq;
                if (events.length < 100) break;
            } while (before);
            this.conversation.import(pages.flat());
        }
    }

    /** 构造一页可直接交给 useChat 的历史消息 */
    private buildMessages (limit: number, before?: number): object {
        this.importHistory();
        return this.conversation.page(limit, before);
    }

    /** 持续订阅持久 UI 消息，重连按版本补齐；与任何单轮生成请求无关 */
    private streamConversation (request: Request): Response {
        let cursor = Number(request.headers.get('last-event-id') || new URL(request.url).searchParams.get('after') || 0);
        if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
        const encoder = new TextEncoder();
        let timer: ReturnType<typeof setInterval>;
        let close = () => undefined;
        const stream = new ReadableStream<Uint8Array>({
            start: controller => {
                let ticks = 0;
                /** 发送最新快照；定时扫描不调用模型 */
                const publish = (): void => {
                    const changes = this.conversation.changes(cursor);
                    if (changes.cursor > cursor || ticks++ % 50 === 0) {
                        controller.enqueue(encoder.encode(`id: ${changes.cursor}\ndata: ${JSON.stringify(changes)}\n\n`));
                        cursor = changes.cursor;
                    }
                };
                close = () => {
                    clearInterval(timer);
                    request.signal.removeEventListener('abort', close);
                    this.subscriptions.delete(close);
                    try { controller.close(); } catch { /* 已断开的读者无需再次关闭 */ }
                };
                this.subscriptions.add(close);
                timer = setInterval(publish, 200);
                request.signal.addEventListener('abort', close, { once: true });
                publish();
                if (request.signal.aborted) close();
            },
            cancel: () => close(),
        });
        this.server?.timeout(request, 0);
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
    }

    /** 所有入口只提交本轮标准 UI 消息，由 Runtime 校验并持久引用图片 */
    private readInput (body: z.infer<typeof chatRequestSchema>): UserModelMessage['content'] {
        const lastMessage = body.messages.at(-1);
        if (!lastMessage || lastMessage.role !== 'user') {
            throw new Error('最后一条消息必须来自用户');
        }
        const parts = z.array(z.discriminatedUnion('type', [
            z.object({ type: z.literal('text'), text: z.string().max(100_000) }),
            z.object({ type: z.literal('file'), url: z.string().max(256), mediaType: z.string(), filename: z.string().max(200).optional() }),
        ])).max(20).parse(lastMessage.parts);
        const files = parts.filter(part => part.type === 'file');
        if (files.length > MAX_IMAGES) {
            throw new Error('每条消息最多包含 4 张图片');
        }
        const input: UserModelMessage['content'] = files.length
            ? parts.map(part => part.type === 'file' ? this.attachments.reference(part) : part)
            : parts.filter(part => part.type === 'text').map(part => part.text).join('\n').trim();
        if (!input || (Array.isArray(input) && !input.length)) {
            throw new Error('消息不能为空');
        }

        return input;
    }

    /** 保留 CLI 协议适配，执行生命周期由共享主脑收件箱管理 */
    private async handleChat (request: Request): Promise<Response> {
        if (!this.dependencies.config.isConfigured()) return new Response('请先完成模型配置', { status: 409 });
        const body = chatRequestSchema.parse(await request.json());
        const input = this.readInput(body);
        let restartRequired = false;
        const textId = randomUUID();
        const activityId = `activity:${textId}`;
        const stream = createUIMessageStream<SelfcraftUIMessage>({
            execute: async ({ writer }) => {
                const activities = new Map<string, AgentActivity>();
                const sources = new Set<string>();
                /** 将统一 Runtime 事件投影为 AI SDK UI Message Stream */
                const writeEvent = (event: AgentRunEvent): void => {
                    if (event.type === 'text-delta') {
                        writer.write({ type: 'text-delta', id: textId, delta: event.delta });
                        return;
                    }
                    if (event.type === 'status') {
                        writer.write({
                            type: 'data-status',
                            data: { phase: event.phase, label: event.label },
                            transient: true,
                        });
                        return;
                    }
                    if (event.type === 'activity') {
                        activities.set(event.activity.id, event.activity);
                        writer.write({
                            type: 'data-activity',
                            id: activityId,
                            data: { status: 'working', items: [...activities.values()] },
                        });
                        return;
                    }
                    if (sources.has(event.source.id)) {
                        return;
                    }
                    sources.add(event.source.id);
                    writer.write({
                        type: 'source-url',
                        sourceId: event.source.id,
                        url: event.source.url,
                        title: event.source.title,
                    });
                };
                writer.write({ type: 'start' });
                writer.write({ type: 'start-step' });
                writer.write({ type: 'text-start', id: textId });
                try {
                    const result = await this.dependencies.agent.run(
                        input,
                        writeEvent,
                        {
                            signal: request.signal,
                            retry: body.trigger === 'regenerate-message',
                        },
                    );
                    restartRequired = result.restartRequired;
                    if (activities.size > 0) {
                        writer.write({
                            type: 'data-activity',
                            id: activityId,
                            data: { status: 'complete', items: [...activities.values()] },
                        });
                    }
                    writer.write({ type: 'text-end', id: textId });
                    writer.write({ type: 'finish-step' });
                    writer.write({ type: 'finish', finishReason: 'stop' });
                } catch (error) {
                    for (const [id, activity] of activities) {
                        if (activity.state === 'running') {
                            activities.set(id, failAgentActivity(activity));
                        }
                    }
                    if (activities.size > 0) {
                        writer.write({
                            type: 'data-activity',
                            id: activityId,
                            data: { status: 'complete', items: [...activities.values()] },
                        });
                    }
                    writer.write({ type: 'text-end', id: textId });
                    throw error;
                }
            },
            onError: error => publicChatError(error),
            onEnd: () => {
                if (restartRequired) {
                    this.dependencies.onRestart();
                }
            },
        });
        return createUIMessageStreamResponse({ stream });
    }

    /** 只允许同源 JSON 请求修改本地 Runtime 状态 */
    private assertMutationRequest (request: Request): void {
        if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
            throw new Error('请求必须使用 application/json');
        }
        const origin = request.headers.get('origin');
        if (!origin) {
            return;
        }
        const requestHost = request.headers.get('host') || new URL(request.url).host;
        const originUrl = new URL(origin);
        const sameOrigin = originUrl.host === requestHost;
        const localDevelopmentOrigin = this.dependencies.paths.environment === 'development'
            && ['localhost:5173', '127.0.0.1:5173'].includes(originUrl.host);
        if (!sameOrigin && !localDevelopmentOrigin) {
            throw new Error('拒绝跨站请求');
        }
    }

    /** 返回构建后的静态文件；前端路由回退到 index.html */
    private async serveStatic (request: Request, pathname: string): Promise<Response> {
        if (!['GET', 'HEAD'].includes(request.method)) {
            return new Response('Method Not Allowed', { status: 405 });
        }
        const root = path.resolve(this.dependencies.staticDirectory);
        const relativePath = decodeURIComponent(pathname).replace(/^\/+/, '');
        const candidate = path.resolve(root, relativePath || 'index.html');
        const withinRoot = candidate === root || candidate.startsWith(`${root}${path.sep}`);
        const file = withinRoot ? Bun.file(candidate) : null;
        const selected = file && await file.exists() ? file : Bun.file(path.join(root, 'index.html'));
        if (!(await selected.exists())) {
            return new Response('Web 前端尚未构建。开发时请运行 bun run dev，生产前请运行 bun run build:web。', {
                status: 503,
            });
        }
        const headers = securityHeaders();
        if (pathname.startsWith('/assets/')) {
            headers.set('Cache-Control', 'public, max-age=31536000, immutable');
        }
        return new Response(request.method === 'HEAD' ? null : selected, { headers });
    }
}

interface WebConfigView {
    /** 是否存在可用于对话的活动模型 */
    configured: boolean;
    /** 用户本地时区 */
    timezone: string;
    /** 当前活动模型 */
    defaultModel: SelfcraftConfig['defaultModel'];
    /** 后台用途的显式模型覆盖 */
    modelOverrides: SelfcraftConfig['modelOverrides'];
    /** 脱敏后的网络访问配置 */
    webAccess: {
        provider: 'tavily';
        configured: boolean;
    } | null;
    /** 脱敏后的渠道与模型 */
    providers: Array<{
        id: string;
        type: string;
        baseURL?: string;
        credentialConfigured: boolean;
        auth: 'api-key' | 'none';
        models: Array<{
            id: string;
            vision: boolean;
            contextWindow: number;
            maxOutputTokens: number;
        }>;
    }>;
}

/** 把持久事件及同轮工具时间线转换为浏览器 UI 消息 */
function toUIMessage (event: EventRecord, runEvents: EventRecord[]): SelfcraftUIMessage {
    const payload = event.payload as { text?: unknown; content?: UserModelMessage['content'] } | null;
    const presentation = event.type === 'assistant_message'
        ? buildRunPresentation(runEvents)
        : { activities: [], sources: [] };
    return {
        id: event.id,
        role: event.type === 'user_message' ? 'user' : 'assistant',
        metadata: {
            seq: event.seq,
            occurredAt: event.occurredFrom,
        },
        parts: [
            ...(presentation.activities.length > 0 ? [{
                type: 'data-activity' as const,
                id: `activity:${event.runId || event.id}`,
                data: {
                    status: 'complete' as const,
                    items: presentation.activities,
                },
            }] : []),
            // 历史必须保留图片与文字的原始顺序，刷新后重试才能对应同一份输入
            ...(event.type === 'user_message' && Array.isArray(payload?.content)
                ? payload.content.flatMap<SelfcraftUIMessage['parts'][number]>(part => part.type === 'text'
                    ? [part] : userContentFiles([part]))
                : [{ type: 'text' as const, text: typeof payload?.text === 'string' ? payload.text : '' }]),
            ...presentation.sources.map(source => ({
                type: 'source-url' as const,
                sourceId: source.id,
                url: source.url,
                title: source.title,
            })),
        ],
    };
}

/** 从工具调用、结果与失败事件重建一次运行的活动和来源 */
function buildRunPresentation (events: EventRecord[]): {
    activities: AgentActivity[];
    sources: AgentSource[];
} {
    const outcomes = new Map<string, EventRecord>();
    for (const event of events) {
        if (event.type !== 'tool_result' && event.type !== 'tool_error') {
            continue;
        }
        const payload = recordValue(event.payload);
        if (typeof payload?.toolCallId === 'string') {
            outcomes.set(payload.toolCallId, event);
        }
    }

    const activities: AgentActivity[] = [];
    const sources = new Map<string, AgentSource>();
    for (const event of events) {
        if (event.type !== 'tool_call') {
            continue;
        }
        const payload = recordValue(event.payload);
        if (typeof payload?.toolName !== 'string' || typeof payload.toolCallId !== 'string') {
            continue;
        }
        const toolInput = payload.input;
        const started = createAgentActivity(payload.toolName, payload.toolCallId, toolInput);
        const outcome = outcomes.get(payload.toolCallId);
        if (!outcome) {
            activities.push({ ...started, state: 'unknown' });
            continue;
        }
        if (outcome.type === 'tool_error') {
            activities.push(failAgentActivity(started));
            continue;
        }
        let completion = completeAgentActivity(
            started,
            recordValue(outcome.payload)?.result,
        );
        const requestedUrl = recordValue(toolInput)?.url;
        if (
            started.toolName === 'web_fetch'
            && completion.sources.length === 0
            && typeof requestedUrl === 'string'
        ) {
            // 大正文可能只在时间线留下截断预览，成功结果仍能证明请求地址已被读取
            completion = completeAgentActivity(started, { url: requestedUrl });
        }
        activities.push(completion.activity);
        for (const source of completion.sources) {
            sources.set(source.id, source);
        }
    }
    return { activities, sources: [...sources.values()] };
}

/** 将未知事件负载收窄成普通对象 */
function recordValue (value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null
        ? value as Record<string, unknown>
        : null;
}

/** 解析可选正整数查询参数 */
function parseOptionalInteger (value: string | null): number | undefined {
    if (value === null || value === '') {
        return undefined;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error('分页参数必须是正整数');
    }
    return parsed;
}

/** 解析 `/collection/:id` 形式的资源路径 */
function matchResourcePath (pathname: string, collection: string): { id: string } | null {
    const prefix = `${collection}/`;
    if (!pathname.startsWith(prefix)) {
        return null;
    }
    const remainder = pathname.slice(prefix.length);
    if (!remainder || remainder.includes('/')) {
        return null;
    }
    return { id: decodeURIComponent(remainder) };
}

/** 解析 `/collection/:id/:action` 形式的资源操作路径 */
function matchResourceActionPath (
    pathname: string,
    collection: string,
): { id: string; action: string } | null {
    const prefix = `${collection}/`;
    if (!pathname.startsWith(prefix)) {
        return null;
    }
    const segments = pathname.slice(prefix.length).split('/');
    if (segments.length !== 2 || segments.some(segment => !segment)) {
        return null;
    }
    return {
        id: decodeURIComponent(segments[0]),
        action: decodeURIComponent(segments[1]),
    };
}

/** 解析 Web 监听端口 */
function parsePort (value: string | undefined): number {
    if (!value) {
        return 3210;
    }
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error('SELFCRAFT_WEB_PORT 必须是有效端口');
    }
    return port;
}

/** 创建 JSON 响应 */
function jsonResponse (value: unknown, status = 200): Response {
    return Response.json(value, {
        status,
        headers: securityHeaders(),
    });
}

/** 返回静态页面与 API 共用的基础安全响应头 */
function securityHeaders (): Headers {
    return new Headers({
        'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
    });
}

/** 返回可以展示给本地用户、但不包含敏感上下文的错误 */
function publicError (error: unknown): string {
    if (error instanceof z.ZodError) {
        return error.issues[0]?.message || '请求格式无效';
    }
    return error instanceof Error ? error.message : '请求失败';
}

/** 返回流式对话的安全错误提示 */
function publicChatError (error: unknown): string {
    if (error instanceof DOMException && error.name === 'AbortError') {
        return '本轮回应已停止';
    }
    if (error instanceof Error && [
        '前台执行超时，步骤已保留',
        '上下文超过安全预算，当前步骤已保留，需要整理后接续',
        '上下文整理未完成，原文和步骤已保留',
        '这轮已经执行过操作，请确认结果后重新发送',
        '最后一轮对话已经变化，请重新发送消息',
        '最后一轮对话没有失败，无需重试',
    ].includes(error.message)) {
        return error.message;
    }
    return '回应没有完成，请稍后重试或查看 Runtime 日志';
}

/** 把遗忘记录渲染成无正文、无证据入口的痕迹，不改变持久审计数据 */
function memoryView (item: MemoryItem): MemoryItem {
    return item.status === 'forgotten' ? { ...item, content: '', sourceEventIds: [] } : item;
}

/**
 * 将日期输入转换为用户时区中该日的第一个有效时刻，完整时间仍由存储层校验
 *
 * @param value 日期或带时间的输入
 * @param timezone 用户配置的 IANA 时区
 * @returns UTC ISO 时间；日期整天不存在时拒绝
 */
function memoryEffectiveTime (value: string | undefined, timezone: string): string | undefined {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const utc = Date.parse(`${value}T00:00:00Z`);
    if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== value) throw new Error('生效日期无效');
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    /** 用固定年月日顺序比较该时刻在用户时区中的日历日期 */
    function localDate (seconds: number): string {
        const parts = formatter.formatToParts(new Date(seconds * 1000));
        return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
    }
    // 搜索日历日期的边界，夏令时跳过午夜时自动选中当天第一个有效时刻
    let low = utc / 1000 - 36 * 3600;
    let high = utc / 1000 + 36 * 3600;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (localDate(middle) < value) low = middle + 1;
        else high = middle;
    }
    if (localDate(low) !== value) throw new Error('用户时区中不存在这个生效日期');
    return new Date(low * 1000).toISOString();
}
