import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
    createUIMessageStream,
    createUIMessageStreamResponse,
    type UIMessage,
} from 'ai';
import { z } from 'zod';
import type { ForegroundRunner } from '../agent/foreground-runner';
import type { ConfigStore } from '../config/config-store';
import type { SelfcraftPaths } from '../config/paths';
import type { SelfcraftConfig } from '../config/types';
import type { HealthChecker } from '../health/health-checker';
import type { JobManager } from '../job/job-manager';
import type { Logger } from '../logging/logger';
import type { EventRecord, MemoryStore } from '../memory/memory-store';
import type { NotificationInbox } from '../notification/notification-inbox';
import type { SkillRegistry } from '../skills/skill-registry';
import type { ScheduledTaskManager } from '../task/scheduled-task-manager';

const chatRequestSchema = z.object({
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
    apiKey: z.string().min(1).max(8192),
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
    providerId: z.string().min(1).max(64),
    modelId: z.string().min(1).max(128),
});

const timezoneRequestSchema = z.object({
    timezone: z.string().min(1).max(100),
});

const webAccessRequestSchema = z.object({
    apiKey: z.string().trim().min(1).max(8192).refine(value => !/[\r\n]/.test(value), 'API key 必须是单行文本'),
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
        label: string;
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

    /**
     * 创建 Web 入口
     *
     * @param dependencies Runtime 共享服务与生命周期回调
     */
    constructor (private readonly dependencies: {
        paths: SelfcraftPaths;
        config: ConfigStore;
        agent: ForegroundRunner;
        memory: MemoryStore;
        skills: SkillRegistry;
        notifications: NotificationInbox;
        jobs: JobManager;
        scheduledTasks: ScheduledTaskManager;
        health: HealthChecker;
        logger: Logger;
        staticDirectory: string;
        onRestart: () => void;
    }) {}

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
            fetch: request => this.fetch(request),
        });
        const address = this.address();
        this.dependencies.logger.info('Web entry started', { ...address });
        return address;
    }

    /** 停止接受新的 Web 请求 */
    public stop (): void {
        this.server?.stop();
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
        if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
            return jsonResponse(this.buildBootstrap());
        }
        if (request.method === 'GET' && url.pathname === '/api/messages') {
            const limit = parseOptionalInteger(url.searchParams.get('limit')) || 50;
            const before = parseOptionalInteger(url.searchParams.get('before'));
            return jsonResponse(this.buildMessages(limit, before));
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
            this.dependencies.config.useModel(modelRequestSchema.parse(await request.json()));
            return jsonResponse(this.buildConfigView());
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
            activeModel: config.activeModel,
            webAccess: config.webAccess ? {
                provider: config.webAccess.provider,
                configured: this.dependencies.config.isWebAccessConfigured(),
            } : null,
            providers: Object.entries(config.providers).map(([id, provider]) => ({
                id,
                type: provider.type,
                baseURL: provider.baseURL,
                credentialConfigured: this.dependencies.config.hasCredential(id),
                models: Object.entries(provider.models).map(([modelId, model]) => ({
                    id: modelId,
                    ...model,
                })),
            })),
        } satisfies WebConfigView;
    }

    /** 构造一页可直接交给 useChat 的历史消息 */
    private buildMessages (limit: number, before?: number): object {
        const events = this.dependencies.memory.listConversationEvents(limit, before);
        return {
            items: events.map(event => toUIMessage(event)),
            nextCursor: events.length === limit ? events[0]?.seq || null : null,
        };
    }

    /** 把当前 Agent Runtime 的回调流适配为 AI SDK UI Message Stream */
    private async handleChat (request: Request): Promise<Response> {
        if (!this.dependencies.config.isConfigured()) {
            return new Response('请先完成模型配置', { status: 409 });
        }
        const body = chatRequestSchema.parse(await request.json());
        const lastMessage = body.messages.at(-1);
        if (!lastMessage || lastMessage.role !== 'user') {
            return new Response('最后一条消息必须来自用户', { status: 400 });
        }
        const input = lastMessage.parts
            .filter((part): part is { type: 'text'; text: string } => (
                typeof part === 'object'
                && part !== null
                && (part as { type?: unknown }).type === 'text'
                && typeof (part as { text?: unknown }).text === 'string'
            ))
            .map(part => part.text)
            .join('\n')
            .trim();
        if (!input) {
            return new Response('消息不能为空', { status: 400 });
        }

        let restartRequired = false;
        const textId = randomUUID();
        const stream = createUIMessageStream<SelfcraftUIMessage>({
            execute: async ({ writer }) => {
                writer.write({ type: 'start' });
                writer.write({ type: 'start-step' });
                writer.write({
                    type: 'data-status',
                    data: { label: '正在理解你的意思' },
                    transient: true,
                });
                writer.write({ type: 'text-start', id: textId });
                try {
                    const result = await this.dependencies.agent.run(
                        input,
                        delta => writer.write({ type: 'text-delta', id: textId, delta }),
                        status => writer.write({
                            type: 'data-status',
                            data: { label: status },
                            transient: true,
                        }),
                        { signal: request.signal },
                    );
                    restartRequired = result.restartRequired;
                    writer.write({ type: 'text-end', id: textId });
                    writer.write({ type: 'finish-step' });
                    writer.write({ type: 'finish', finishReason: 'stop' });
                } catch (error) {
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
    activeModel: SelfcraftConfig['activeModel'];
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
        models: Array<{
            id: string;
            vision: boolean;
            contextWindow: number;
            maxOutputTokens: number;
        }>;
    }>;
}

/** 把持久事件转换为浏览器 UI 消息 */
function toUIMessage (event: EventRecord): SelfcraftUIMessage {
    const payload = event.payload as { text?: unknown } | null;
    return {
        id: event.id,
        role: event.type === 'user_message' ? 'user' : 'assistant',
        metadata: {
            seq: event.seq,
            occurredAt: event.occurredFrom,
        },
        parts: [{
            type: 'text',
            text: typeof payload?.text === 'string' ? payload.text : '',
        }],
    };
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
    return '回应没有完成，请稍后重试或查看 Runtime 日志';
}
