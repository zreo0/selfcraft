import type {
    BootstrapView,
    ConfigView,
    MessagePage,
    ProviderInput,
} from '@/types/api.types';

/** 请求并解析 Selfcraft JSON API */
async function requestJson<T> (pathname: string, init?: RequestInit): Promise<T> {
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

/** 新增或更新模型渠道 */
export function saveProvider (input: ProviderInput): Promise<ConfigView> {
    return requestJson<ConfigView>('/api/config/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
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
