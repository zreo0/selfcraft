import type { FileUIPart } from 'ai';
import type {
    BootstrapView,
    ConfigView,
    MessagePage,
    ProviderInput,
    ModelInput,
} from '@/types/api.types';

/** 请求并解析 Selfcraft JSON API */
export async function requestJson<T> (pathname: string, init?: RequestInit): Promise<T> {
    const response = await fetch(pathname, init);
    if (!response.ok) {
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            const body = await response.json() as { error?: string };
            throw new Error(body.error || '请求失败');
        }
        throw new Error((await response.text()) || '请求失败');
    }
    return await response.json() as T;
}

/** 读取页面初始化数据 */
export function getBootstrap (): Promise<BootstrapView> {
    return requestJson<BootstrapView>('/api/bootstrap');
}

/** 读取更早的持久消息 */
export function getMessages (before: number, limit = 50): Promise<MessagePage> {
    return requestJson<MessagePage>(`/api/messages?before=${before}&limit=${limit}`);
}

/**
 * 创建新渠道，可在首次配置时同时提交首个模型
 * @param input 渠道连接
 * @param model 可选首个模型能力
 * @returns 服务端脱敏配置
 */
export function createProvider (input: ProviderInput, model?: Omit<ModelInput, 'providerId'>): Promise<ConfigView> {
    return requestJson<ConfigView>('/api/config/providers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input, ...model }),
    });
}

/**
 * 只更新已有渠道连接
 * @param input 固定渠道的连接字段
 * @returns 服务端脱敏配置
 */
export function updateProvider (input: ProviderInput): Promise<ConfigView> {
    return requestJson<ConfigView>('/api/config/providers', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    });
}

/**
 * 在固定渠道内新增或编辑模型，不提交连接信息
 * @param input 模型标识与能力
 * @param editing 是否编辑已存在模型
 * @returns 服务端脱敏配置
 */
export function saveModel (input: ModelInput, editing = false): Promise<ConfigView> {
    return requestJson<ConfigView>('/api/config/models', {
        method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    });
}

/**
 * 删除没有用途引用的模型
 * @param providerId 所属渠道
 * @param modelId 模型标识
 * @returns 服务端脱敏配置
 */
export function deleteModel (providerId: string, modelId: string): Promise<ConfigView> {
    return requestJson<ConfigView>('/api/config/models', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerId, modelId }),
    });
}

/** 切换活动模型 */
export function useModel (providerId: string, modelId: string, purpose: 'agent' | 'reflection' | 'compression' = 'agent', reasoningEffort?: 'low' | 'medium' | 'high'): Promise<ConfigView> {
    return requestJson<ConfigView>('/api/config/model', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: providerId || undefined, modelId: modelId || undefined, purpose, inherit: !providerId, reasoningEffort }),
    });
}

/** 显式验证已保存模型的流式连接，不产生会话 */
export function testModel (providerId: string, modelId: string): Promise<{ durationMs: number; finishReason: string; warnings: unknown[] }> {
    return requestJson('/api/config/model/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId, modelId }),
    });
}

/** 保存用户时区 */
export function saveTimezone (timezone: string): Promise<ConfigView> {
    return requestJson<ConfigView>('/api/config/timezone', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timezone }),
    });
}

/** 保存 Tavily 凭证并启用网络访问 */
export function saveWebAccess (apiKey: string): Promise<ConfigView> {
    return requestJson<ConfigView>('/api/config/web', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
    });
}

/** 关闭网络访问并删除 Tavily 凭证 */
export function disableWebAccess (): Promise<ConfigView> {
    return requestJson<ConfigView>('/api/config/web', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
    });
}

/** 备份并重置模型、网络访问与时区配置 */
export function resetConfig (): Promise<{ backupDirectory?: string; config: ConfigView }> {
    return requestJson('/api/config/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
    });
}

/** 上传一张图片，返回 Runtime 持久保存的标准文件部分 */
export function uploadImage (file: File): Promise<FileUIPart> {
    const body = new FormData();
    body.append('file', file);
    return requestJson<FileUIPart>('/api/attachments', { method: 'POST', body });
}

/** 提交标准 AI SDK UI 消息；接收成功后不等待生成结束 */
export async function submitConversation (message: import('@/types/api.types').SelfcraftMessage, retry = false): Promise<void> {
    const response = await fetch('/api/conversation/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: retry ? crypto.randomUUID() : message.id, messages: [message], trigger: retry ? 'regenerate-message' : 'submit-message' }),
    });
    if (!response.ok) throw new Error(await response.text());
}

/** 订阅共享消息视图；浏览器重连自动携带最后接收的版本 */
export function subscribeConversation (receive: (items: import('@/types/api.types').SelfcraftMessage[]) => void): () => void {
    const source = new EventSource('/api/conversation/events');
    source.onmessage = event => receive((JSON.parse(event.data) as { items: import('@/types/api.types').SelfcraftMessage[] }).items);
    return () => source.close();
}

/** 只停止主脑当前生成，独立事项继续保持原状态 */
export async function stopConversation (): Promise<void> {
    const response = await fetch('/api/conversation/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!response.ok) throw new Error(await response.text());
}
