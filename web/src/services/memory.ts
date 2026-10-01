import { requestJson } from '@/services/runtime';
import type {
    MemoryCorrectionInput,
    MemoryDetailView,
    MemoryItemView,
    MemoryOverview,
} from '@/types/memory.types';

/** 读取记忆页的当前认识、档案、候选与版本 */
export function getMemoryOverview (query = '', offset = 0): Promise<MemoryOverview> {
    const params = new URLSearchParams({ q: query, offset: String(offset) });
    return requestJson<MemoryOverview>(`/api/memory?${params}`);
}

/** 读取一条认识的原话来源与修订链 */
export function getMemoryDetail (id: string): Promise<MemoryDetailView> {
    return requestJson<MemoryDetailView>(`/api/memory/${encodeURIComponent(id)}`);
}

/** 发送一次记忆操作并返回操作后的认识 */
async function postMemoryAction (id: string, action: string, body: object): Promise<MemoryItemView> {
    const result = await requestJson<{ memory: MemoryItemView }>(`/api/memory/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return result.memory;
}

/** 确认一条候选，现实变化的修订需要给出开始日期 */
export function confirmMemory (id: string, validFrom?: string): Promise<MemoryItemView> {
    return postMemoryAction(id, 'confirm', validFrom ? { validFrom } : {});
}

/** 修正一条当前认识，返回新的版本 */
export function correctMemory (id: string, input: MemoryCorrectionInput): Promise<MemoryItemView> {
    return postMemoryAction(id, 'correct', input);
}

/** 忘记一条认识或否定一条候选 */
export function forgetMemory (id: string): Promise<MemoryItemView> {
    return postMemoryAction(id, 'forget', {});
}

/** 调整一条认识是否常驻档案 */
export function setMemoryResident (id: string, resident: boolean): Promise<MemoryItemView> {
    return postMemoryAction(id, 'resident', { resident });
}

/** 设置候选是否从待确认列表隐藏，返回未改变判断的认识 */
export function setMemoryIgnored (id: string, ignored: boolean): Promise<MemoryItemView> {
    return postMemoryAction(id, 'ignore', { ignored });
}
