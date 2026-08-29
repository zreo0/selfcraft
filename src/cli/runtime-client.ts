import { randomUUID } from 'node:crypto';
import { DefaultChatTransport, type UIMessageChunk } from 'ai';
import type { AddProviderInput, ActiveModelConfig, ModelConfig, ProviderType } from '../config/types';
import type { JobRecord } from '../job/job-manager';
import type { GrowthProposal, MemoryItem, TopicRecord } from '../memory/memory-store';
import type { Notification } from '../notification/notification-inbox';
import type { SkillDescriptor } from '../skills/skill-registry';
import type { ScheduledTaskRecord } from '../task/scheduled-task-manager';
import type { SelfcraftUIMessage } from '../web/web-server';

/** Runtime API 返回的脱敏模型渠道 */
export interface RuntimeProviderView {
    /** 渠道标识 */
    id: string;
    /** 模型协议 */
    type: ProviderType;
    /** 可选自定义地址 */
    baseURL?: string;
    /** 是否已保存凭证 */
    credentialConfigured: boolean;
    /** 渠道下的模型 */
    models: Array<ModelConfig & { id: string }>;
}

/** Runtime API 返回的脱敏配置 */
export interface RuntimeConfigView {
    /** 是否存在可对话的活动模型 */
    configured: boolean;
    /** 用户时区 */
    timezone: string;
    /** 当前活动模型 */
    activeModel: ActiveModelConfig | null;
    /** 已配置渠道 */
    providers: RuntimeProviderView[];
    /** 外部网络访问状态 */
    webAccess: {
        provider: 'tavily';
        configured: boolean;
    } | null;
}

/** CLI 初始化所需的 Runtime 状态 */
export interface RuntimeBootstrap {
    /** 产品名称 */
    product: string;
    /** 配置无效时为空 */
    config: RuntimeConfigView | null;
    /** 可展示的配置错误 */
    configurationError: string | null;
    /** Runtime 路径与健康信息 */
    runtime: {
        environment: string;
        home: string;
        workspace: string;
        pendingForegroundRuns: number;
        checks: unknown;
    };
}

/** CLI 通过 HTTP 使用唯一 Runtime 的轻量客户端 */
export class RuntimeClient {
    private readonly baseURL: string;
    private readonly fetchFunction: typeof fetch;

    /**
     * 创建 Runtime 客户端
     *
     * @param baseURL Runtime HTTP 地址
     * @param fetchFunction 请求实现，默认使用宿主 fetch
     */
    constructor (
        baseURL = process.env.SELFCRAFT_RUNTIME_URL || 'http://127.0.0.1:3210',
        fetchFunction: typeof fetch = fetch,
    ) {
        this.baseURL = baseURL.replace(/\/+$/, '');
        this.fetchFunction = fetchFunction;
    }

    /** 读取 Runtime 初始化状态 */
    public async bootstrap (): Promise<RuntimeBootstrap> {
        return await this.request<RuntimeBootstrap>('/api/bootstrap');
    }

    /** 保存一个模型渠道并返回脱敏配置 */
    public async addProvider (input: AddProviderInput): Promise<RuntimeConfigView> {
        return await this.request<RuntimeConfigView>('/api/config/providers', {
            method: 'POST',
            body: JSON.stringify(input),
        });
    }

    /** 切换活动模型并返回脱敏配置 */
    public async useModel (selection: ActiveModelConfig): Promise<RuntimeConfigView> {
        return await this.request<RuntimeConfigView>('/api/config/model', {
            method: 'PUT',
            body: JSON.stringify(selection),
        });
    }

    /** 更新用户时区并返回脱敏配置 */
    public async setTimezone (timezone: string): Promise<RuntimeConfigView> {
        return await this.request<RuntimeConfigView>('/api/config/timezone', {
            method: 'PUT',
            body: JSON.stringify({ timezone }),
        });
    }

    /** 保存 Tavily 凭证并启用网络访问 */
    public async configureWebAccess (apiKey: string): Promise<RuntimeConfigView> {
        return await this.request<RuntimeConfigView>('/api/config/web', {
            method: 'POST',
            body: JSON.stringify({ apiKey }),
        });
    }

    /** 关闭网络访问并移除 Tavily 凭证 */
    public async disableWebAccess (): Promise<RuntimeConfigView> {
        return await this.request<RuntimeConfigView>('/api/config/web', {
            method: 'DELETE',
            body: '{}',
        });
    }

    /** 备份并重置配置 */
    public async resetConfig (): Promise<{ backupDirectory?: string; config: RuntimeConfigView }> {
        return await this.request('/api/config/reset', {
            method: 'POST',
            body: '{}',
        });
    }

    /** 向 Runtime 发送一轮对话并消费 AI SDK UI Message Stream */
    public async chat (
        input: string,
        onText: (delta: string) => void,
        onStatus?: (status: string) => void,
        signal?: AbortSignal,
    ): Promise<void> {
        const transport = new DefaultChatTransport<SelfcraftUIMessage>({
            api: `${this.baseURL}/api/chat`,
            fetch: this.fetchFunction,
        });
        const stream = await transport.sendMessages({
            trigger: 'submit-message',
            chatId: 'selfcraft-cli',
            messageId: undefined,
            messages: [{
                id: randomUUID(),
                role: 'user',
                parts: [{ type: 'text', text: input }],
            }],
            abortSignal: signal,
        });
        const reader = stream.getReader();
        while (true) {
            const result = await reader.read();
            if (result.done) {
                return;
            }
            this.consumeChatChunk(result.value, onText, onStatus);
        }
    }

    /** 列出当前技能 */
    public async listSkills (): Promise<SkillDescriptor[]> {
        return (await this.request<{ items: SkillDescriptor[] }>('/api/skills')).items;
    }

    /** 列出后台任务 */
    public async listJobs (): Promise<JobRecord[]> {
        return (await this.request<{ items: JobRecord[] }>('/api/jobs')).items;
    }

    /** 读取后台任务及日志 */
    public async readJob (id: string): Promise<{ job: JobRecord; log: string }> {
        return await this.request(`/api/jobs/${encodeURIComponent(id)}`);
    }

    /** 取消或恢复后台任务 */
    public async updateJob (id: string, action: 'cancel' | 'resume'): Promise<boolean> {
        const result = await this.request<{ changed: boolean }>(
            `/api/jobs/${encodeURIComponent(id)}/${action}`,
            { method: 'POST', body: '{}' },
        );
        return result.changed;
    }

    /** 列出一次性提醒 */
    public async listTasks (): Promise<ScheduledTaskRecord[]> {
        return (await this.request<{ items: ScheduledTaskRecord[] }>('/api/tasks')).items;
    }

    /** 取消一次性提醒 */
    public async cancelTask (id: string): Promise<boolean> {
        const result = await this.request<{ changed: boolean }>(
            `/api/tasks/${encodeURIComponent(id)}/cancel`,
            { method: 'POST', body: '{}' },
        );
        return result.changed;
    }

    /** 检索持续事项 */
    public async searchTopics (query: string): Promise<TopicRecord[]> {
        return (await this.request<{ items: TopicRecord[] }>(`/api/topics?q=${encodeURIComponent(query)}`)).items;
    }

    /** 检索长期记忆 */
    public async searchMemories (query: string): Promise<MemoryItem[]> {
        return (await this.request<{ items: MemoryItem[] }>(`/api/memories?q=${encodeURIComponent(query)}`)).items;
    }

    /** 列出待评估成长候选 */
    public async listGrowth (): Promise<GrowthProposal[]> {
        return (await this.request<{ items: GrowthProposal[] }>('/api/growth')).items;
    }

    /** 列出通知 */
    public async listNotifications (): Promise<Notification[]> {
        return (await this.request<{ items: Notification[] }>('/api/notifications')).items;
    }

    /** 清空通知 */
    public async clearNotifications (): Promise<void> {
        await this.request('/api/notifications', { method: 'DELETE', body: '{}' });
    }

    /** 把一段聊天流交给 CLI 展示回调 */
    private consumeChatChunk (
        chunk: UIMessageChunk,
        onText: (delta: string) => void,
        onStatus?: (status: string) => void,
    ): void {
        if (chunk.type === 'text-delta') {
            onText(chunk.delta);
            return;
        }
        if (chunk.type === 'error') {
            throw new Error(chunk.errorText);
        }
        if (chunk.type === 'data-status') {
            const data = chunk.data as { label?: unknown };
            if (typeof data.label === 'string') {
                onStatus?.(data.label);
            }
        }
    }

    /** 发送 JSON 请求并转换 Runtime 错误 */
    private async request<T> (pathname: string, init: RequestInit = {}): Promise<T> {
        let response: Response;
        try {
            response = await this.fetchFunction(`${this.baseURL}${pathname}`, {
                ...init,
                headers: init.body
                    ? { 'Content-Type': 'application/json', ...init.headers }
                    : init.headers,
            });
        } catch {
            throw new Error(`无法连接 Runtime（${this.baseURL}）。请先运行 bun run start`);
        }
        if (!response.ok) {
            const contentType = response.headers.get('content-type') || '';
            const body = contentType.includes('application/json')
                ? await response.json() as { error?: unknown }
                : await response.text();
            const message = typeof body === 'string'
                ? body
                : typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
            throw new Error(message || `Runtime 请求失败（HTTP ${response.status}）`);
        }
        return await response.json() as T;
    }
}
