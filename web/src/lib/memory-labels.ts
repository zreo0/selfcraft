import type { MemoryBasis, MemoryItemView, MemoryKind } from '@/types/memory.types';

/** 记忆类型在页面上的称呼，按浏览顺序排列 */
export const MEMORY_KIND_LABELS: Array<[MemoryKind, string]> = [
    ['identity', '身份'],
    ['relationship', '关系'],
    ['preference', '偏好'],
    ['fact', '事实'],
    ['decision', '决定'],
    ['lesson', '经验'],
];

/** 依据类别用助理的口吻表达 */
const BASIS_LABELS: Record<MemoryBasis, string> = {
    stated: '你告诉我的',
    observed: '我观察到的',
    inferred: '我推测的',
};

/** 返回一条认识的依据说明 */
export function basisLabel (basis?: MemoryBasis): string {
    return basis ? BASIS_LABELS[basis] : '早先记下的';
}

/** 版本在变化之河中的动作，以及它现在的状态 */
export function versionVerb (item: MemoryItemView): string {
    if (item.status === 'forgotten') return '忘记';
    if (item.status === 'candidate') return item.supersedesId ? '想改写' : '待确认';
    if (item.revisionKind === 'correction') return '纠正';
    if (item.revisionKind === 'world_change') return '改变';
    return '记下';
}

/**
 * 按用户时区格式化日期
 *
 * @param value ISO 时间
 * @param timezone IANA 时区
 * @param withYear 是否包含年份
 * @returns 例如「9月20日」
 */
export function formatMemoryDate (value: string, timezone: string, withYear = false): string {
    return new Intl.DateTimeFormat('zh-CN', {
        timeZone: timezone,
        ...(withYear && { year: 'numeric' }),
        month: 'long',
        day: 'numeric',
    }).format(new Date(value));
}

/**
 * 返回版本所属的月份标题与排序键
 *
 * @param value ISO 时间
 * @param timezone IANA 时区
 * @returns 例如「2026年9月」
 */
export function formatMemoryMonth (value: string, timezone: string): string {
    return new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, year: 'numeric', month: 'long' }).format(new Date(value));
}

/**
 * 说明一条认识在现实中的有效区间，只在将来生效或即将结束时提示
 *
 * @param item 认识
 * @param timezone IANA 时区
 * @returns 有效期提示，没有特殊区间时为空
 */
export function validityLabel (item: MemoryItemView, timezone: string): string | null {
    const now = Date.now();
    if (item.validFrom && new Date(item.validFrom).getTime() > now) {
        return `${formatMemoryDate(item.validFrom, timezone)}起`;
    }
    if (item.validTo && new Date(item.validTo).getTime() > now) {
        return `到${formatMemoryDate(item.validTo, timezone)}为止`;
    }
    return null;
}

/** 判断版本此刻仍成立或已约定将来生效，供分页时间线定位当前认识 */
export function isCurrentMemory (item: MemoryItemView): boolean {
    const unexpired = !item.validTo || Date.parse(item.validTo) > Date.now();
    return unexpired && (item.status === 'active' || (item.status === 'superseded' && Boolean(item.validTo)));
}
