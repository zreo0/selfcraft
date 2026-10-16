import type { InteractionSubmission, InteractionValues, InteractionView } from '@/types/interaction.types';

/** 保留交互错误状态码，区分确定拒绝与回执未知 */
export class InteractionRequestError extends Error {
    /** 保存状态码及可读说明 */
    constructor (public status: number, message: string) { super(message); }
}
/** 请求同源交互接口，不发送完整历史或组件定义 */
async function request<T> (path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`/api/conversation/ui${path}`, { method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    if (!response.ok) throw new InteractionRequestError(response.status, data.error || '交互请求失败');
    return data as T;
}
/** 读取最新 UI */
export function getInteraction (id: string): Promise<InteractionView> { return request(`/${encodeURIComponent(id)}`); }
/** 查询待回答列表，包含聊天窗口之外的表单 */
export function listInteractions (after = 0): Promise<{ items: InteractionView[]; nextCursor: number | null }> { return request(`?status=ready&after=${after}`); }
/** 原子保存草稿 */
export function saveInteraction (id: string, expectedRevision: number, values: InteractionValues): Promise<InteractionView> {
    return request(`/${id}/state`, 'PATCH', { expectedRevision, values });
}
/** 提交原始用户意图，网络失败时必须保留同一 request */
export function submitInteraction (id: string, body: InteractionSubmission): Promise<{ executionId: string }> { return request(`/${id}/actions`, 'POST', body); }
/** 查询超时或断线请求是否已接收 */
export function interactionReceipt (id: string): Promise<{ executionId: string }> { return request(`/submissions/${id}`); }
