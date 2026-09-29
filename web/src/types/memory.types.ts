/** 记忆的语义类型 */
export type MemoryKind = 'identity' | 'fact' | 'preference' | 'relationship' | 'decision' | 'lesson';

/** 记忆在当前认知中的状态 */
export type MemoryStatus = 'candidate' | 'active' | 'superseded' | 'retracted' | 'forgotten';

/** 记忆的依据类别 */
export type MemoryBasis = 'stated' | 'observed' | 'inferred';

/** 修订代表纠错还是现实变化 */
export type MemoryRevisionKind = 'correction' | 'world_change';

/** Runtime 返回的一条认识或它的某个版本 */
export interface MemoryItemView {
    /** 记忆标识 */
    id: string;
    /** 语义类型 */
    kind: MemoryKind;
    /** 独立可读的认识 */
    content: string;
    /** 是否常驻用户档案 */
    resident: boolean;
    /** 依据类别，早期记录可能缺失 */
    basis?: MemoryBasis;
    /** 当前状态 */
    status: MemoryStatus;
    /** 对未来互动的重要性 */
    importance: number;
    /** 现实中开始成立的时间 */
    validFrom?: string;
    /** 现实中不再成立的时间 */
    validTo?: string;
    /** 助理开始持有该认识的时间 */
    knownFrom: string;
    /** 被这一版本接替的旧版本 */
    supersedesId?: string;
    /** 接替旧版本的方式 */
    revisionKind?: MemoryRevisionKind;
    /** 支撑该认识的事件 */
    sourceEventIds: string[];
    /** 最近一次更新时间 */
    updatedAt: string;
}

/** 等待确认的候选，修订候选附带它想接替的旧版本 */
export interface MemoryPendingView extends MemoryItemView {
    /** 候选修订的原认识 */
    previous: MemoryItemView | null;
    /** 原认识仍可接续时才能确认 */
    confirmable: boolean;
}

/** 记忆页的整体数据 */
export interface MemoryOverview {
    /** 实际进入常驻档案的认识 */
    profileIds: string[];
    /** 此刻成立或已约定将来生效的认识 */
    current: MemoryItemView[];
    /** 等待确认的候选 */
    pending: MemoryPendingView[];
    /** 按认知时间倒序的非候选版本，候选单独展示 */
    versions: MemoryItemView[];
    /** 各栏匹配总数，不是当前页数量 */
    totals: { current: number; pending: number; versions: number };
    /** 下一页偏移；全部读完时为空 */
    nextOffset: number | null;
}

/** 一条认识的原话来源 */
export interface MemorySourceView {
    /** 事件标识 */
    id: string;
    /** 发生时间 */
    occurredFrom: string;
    /** 发出者 */
    actor: string;
    /** 事件类型 */
    type: string;
    /** 可展示的正文，工具输出等证据为空 */
    text: string | null;
}

/** 一条认识的来源与修订链 */
export interface MemoryDetailView {
    /** 当前查看的认识 */
    memory: MemoryItemView;
    /** 从最初到最新的全部版本 */
    history: MemoryItemView[];
    /** 最近的原话来源 */
    sources: MemorySourceView[];
    /** 来源总数 */
    sourceCount: number;
}

/** 在记忆页修正一条认识 */
export interface MemoryCorrectionInput {
    /** 修正后的认识 */
    content: string;
    /** 之前记错了，或者情况变了 */
    revisionKind: MemoryRevisionKind;
    /** 情况变化的开始日期 */
    validFrom?: string;
}
