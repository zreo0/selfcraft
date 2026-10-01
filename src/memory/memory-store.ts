import { assertStateVersion } from '../supervisor/state-version';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { eventSearchText, initializeMemorySearch, memoryQuery, memoryWords } from './memory-search';

/** 可持久记忆的语义类型 */
export type MemoryKind = 'identity' | 'fact' | 'preference' | 'relationship' | 'decision' | 'lesson';

/** 记忆在当前认知中的状态 */
export type MemoryStatus = 'candidate' | 'active' | 'superseded' | 'retracted' | 'forgotten';

/** 新记忆与旧记忆之间的修订语义 */
export type MemoryRevisionKind = 'correction' | 'world_change';

/** 事件时间的表达精度 */
export type TimePrecision = 'instant' | 'minute' | 'hour' | 'day' | 'month' | 'year' | 'range' | 'unknown';

/** 写入时间线的原始事件 */
export interface EventInput {
    /** 事件参与者 */
    actor: string;
    /** 事件类型 */
    type: string;
    /** 事件内容或结构化负载 */
    payload?: unknown;
    /** 事件开始发生的时间，省略时使用记录时间 */
    occurredFrom?: string;
    /** 事件结束时间 */
    occurredTo?: string;
    /** 系统记录该事件的时间 */
    recordedAt?: string;
    /** 事件时间精度 */
    precision?: TimePrecision;
    /** 解释事件本地时间使用的时区 */
    timezone?: string;
    /** 便于日历召回的本地日期 */
    localDate?: string;
    /** 一次 Agent 运行或工具链标识 */
    runId?: string;
    /** 相关后台任务标识 */
    taskId?: string;
    /** 产生当前事件的上游事件 */
    sourceEventId?: string;
    /** 上游投递或重试的幂等标识 */
    idempotencyKey?: string;
    /** 写入后立即关联的 Topic */
    topicIds?: string[];
}

/** 时间线中的持久事件 */
export interface EventRecord extends Omit<EventInput, 'recordedAt' | 'occurredFrom' | 'precision' | 'topicIds'> {
    /** 事件标识 */
    id: string;
    /** 单调递增的时间线顺序 */
    seq: number;
    /** 事件开始发生的时间 */
    occurredFrom: string;
    /** 系统记录该事件的时间 */
    recordedAt: string;
    /** 事件时间精度 */
    precision: TimePrecision;
    /** 关联的 Topic 标识 */
    topicIds: string[];
}

/** 创建 Topic 的输入 */
export interface TopicInput {
    /** 展示名称，允许与其他 Topic 同名 */
    title: string;
    /** 可选的事项类别 */
    kind?: string;
}

/** 跨时间持续事项的稳定标识 */
export interface TopicRecord extends TopicInput {
    /** Topic 标识 */
    id: string;
    /** 创建时间 */
    createdAt: string;
    /** 最后更新时间 */
    updatedAt: string;
}

/** Reflection 或显式操作产生的记忆内容 */
export interface MemoryCandidate {
    /** 具体执行纠错的证据，不用于用户偏好或概括规律 */
    verifiedCorrection?: {
        /** 原做法失败的事件 */
        failureEventId: string;
        /** 改正后的工具调用 */
        correctionEventId: string;
        /** 改正后确实取得所需结果的事件 */
        resultEventId: string;
        /** 必须同时出现在记忆正文中的适用条件 */
        applicability: string;
        /** 结果为何能证明原问题已解决 */
        explanation: string;
        /** 是否包含对用户的推断，此类认识仍需确认 */
        aboutUser: boolean;
    };
    /** 是否适合跨任务常驻 */
    resident?: boolean;
    /** 内容依据，不代表指令权限 */
    basis?: 'stated' | 'observed' | 'inferred';
    /** 事实、计划与假设影响自动生效 */
    assertion?: 'established' | 'planned' | 'hypothetical';
    /** 尚有未解决的矛盾时等待确认 */
    needsConfirmation?: boolean;
    /** Reflection 对已有认识的操作 */
    operation?: 'add' | 'update' | 'reinforce';
    /** 本次提供给 Reflection 的目标认识 */
    targetId?: string;
    /** 更新代表纠错还是现实变化 */
    revisionKind?: MemoryRevisionKind;
    /** 记忆类型 */
    kind: MemoryKind;
    /** 独立、可理解的认识 */
    content: string;
    /** 内容可信度，仅用于排序，不决定激活 */
    confidence: number;
    /** 对未来互动的重要性 */
    importance: number;
    /** 是否包含不应自动持久化的敏感信息 */
    sensitive: boolean;
    /** 该认识在现实世界中开始有效的时间 */
    validFrom?: string;
    /** 该认识在现实世界中结束有效的时间 */
    validTo?: string;
    /** 系统从何时开始持有该认识 */
    knownFrom?: string;
    /** 系统从何时不再持有该版本认识 */
    knownTo?: string;
    /** 支撑该认识的原始事件 */
    sourceEventIds?: string[];
    /** 该认识涉及的持续事项 */
    topicIds?: string[];
}

/** 显式修订一条记忆的输入 */
export interface MemoryRevisionInput extends Omit<MemoryCandidate, 'sensitive'> {
    /** 修订是纠错还是现实变化 */
    revisionKind: MemoryRevisionKind;
}

/** 对 Agent 可见的长期记忆 */
export interface MemoryItem {
    /** 是否适合跨任务常驻 */
    resident: boolean;
    /** 认识的依据类别 */
    basis?: MemoryCandidate['basis'];
    /** 记忆标识 */
    id: string;
    /** 记忆类型 */
    kind: MemoryKind;
    /** 记忆正文 */
    content: string;
    /** 可信度 */
    confidence: number;
    /** 重要性 */
    importance: number;
    /** 记忆状态 */
    status: MemoryStatus;
    /** 现实有效时间起点 */
    validFrom?: string;
    /** 现实有效时间终点 */
    validTo?: string;
    /** 系统认知时间起点 */
    knownFrom: string;
    /** 系统认知时间终点 */
    knownTo?: string;
    /** 被当前版本修订的记忆 */
    supersedesId?: string;
    /** 当前版本的修订语义 */
    revisionKind?: MemoryRevisionKind;
    /** 支撑当前认识的事件 */
    sourceEventIds: string[];
    /** 当前认识涉及的 Topic */
    topicIds: string[];
    /** 最后更新时间 */
    updatedAt: string;
}

/** 按需重建 Episode 的检索条件 */
export interface EpisodeRecallInput {
    /** 语义检索文本 */
    query?: string;
    /** 限定持续事项 */
    topicIds?: string[];
    /** 限定发生时间下界 */
    from?: string;
    /** 限定发生时间上界 */
    to?: string;
    /** 以 MM-DD 表示的日历日期 */
    calendarMonthDay?: string;
    /** 查询在某个现实时间有效的认识 */
    validAt?: string;
    /** 查询系统在某个认知时间持有的认识 */
    knownAt?: string;
    /** 最多返回的直接命中事件数，Memory 来源证据会在限额后补齐 */
    limitEvents?: number;
    /** 最多返回的记忆数 */
    limitMemories?: number;
}

/** 从持久事实按需重建的 Episode 视图 */
export interface EpisodeView {
    /** 按发生时间排序的证据事件 */
    events: EventRecord[];
    /** 与查询匹配的认识 */
    memories: MemoryItem[];
    /** 当前 Episode 涉及的持续事项 */
    topics: TopicRecord[];
    /** 视图生成时间 */
    generatedAt: string;
}

/** Reflection 产生的成长候选 */
export interface GrowthCandidate {
    /** 增强本次提供的同一个成长候选，不按标题猜测目标 */
    targetId?: string;
    /** 候选作用的层级 */
    kind: 'skill' | 'runtime';
    /** 简短标题 */
    title: string;
    /** 从交互中观察到的问题或机会 */
    observation: string;
    /** 支持候选的实际证据 */
    evidence: string;
    /** 候选成立的可信度 */
    confidence: number;
    /** 支撑该候选的原始事件 */
    sourceEventIds?: string[];
}

/** 一次 Reflection 的结构化结果 */
export interface ReflectionResult {
    /** 值得长期保留的记忆候选 */
    memories: MemoryCandidate[];
    /** 需要继续积累证据的改进候选 */
    growth: GrowthCandidate[];
}

/** 需要被后台反思的一次交互 */
export interface ReflectionInput {
    /** 一次前台或后台运行的稳定标识 */
    runId: string;
    /** 本轮真实产生的来源事件 */
    eventIds: string[];
    /** 执行是否成功 */
    outcome: 'completed' | 'failed';
    /** 失败时的错误信息 */
    error?: string;
}

/** 持久化的 Reflection 队列项 */
export interface ReflectionJob extends ReflectionInput {
    /** Reflection 标识 */
    id: string;
    /** 已尝试次数 */
    attempts: number;
    /** 上一次 Reflection 的无效输出 */
    previousOutput?: string;
    /** 上一次 Reflection 的校验错误 */
    previousError?: string;
}

/** 待评估的技能或 Runtime 改进候选 */
export interface GrowthProposal {
    /** 候选标识 */
    id: string;
    /** 候选层级 */
    kind: 'skill' | 'runtime';
    /** 标题 */
    title: string;
    /** 观察 */
    observation: string;
    /** 证据 */
    evidence: string;
    /** 可信度 */
    confidence: number;
    /** 重复出现的证据数 */
    evidenceCount: number;
    /** 处理状态 */
    status: 'proposed' | 'accepted' | 'dismissed';
    /** 最后更新时间 */
    updatedAt: string;
}

/** 硬删除事件后的级联结果 */
export interface EventEraseResult {
    /** 事件是否存在且已删除 */
    erased: boolean;
    /** 因引用该事件而一并删除的派生记忆 */
    erasedMemoryIds: string[];
}

interface EventRow {
    search_rank?: number;
    seq: number;
    id: string;
    actor: string;
    event_type: string;
    payload: string;
    occurred_from: string;
    occurred_to: string | null;
    recorded_at: string;
    precision: TimePrecision;
    timezone: string | null;
    local_date: string | null;
    run_id: string | null;
    task_id: string | null;
    source_event_id: string | null;
    idempotency_key: string | null;
}

interface TopicRow {
    id: string;
    title: string;
    kind: string | null;
    created_at: string;
    updated_at: string;
}

interface MemoryRow {
    search_rank?: number;
    resident: number;
    basis: MemoryCandidate['basis'] | null;
    id: string;
    kind: MemoryKind;
    content: string;
    normalized_content: string;
    confidence: number;
    importance: number;
    status: MemoryStatus;
    valid_from: string | null;
    valid_to: string | null;
    known_from: string;
    known_to: string | null;
    supersedes_id: string | null;
    revision_kind: MemoryRevisionKind | null;
    updated_at: string;
}

interface GrowthRow {
    id: string;
    kind: GrowthProposal['kind'];
    title: string;
    observation: string;
    evidence: string;
    confidence: number;
    evidence_count: number;
    status: GrowthProposal['status'];
    updated_at: string;
}

interface ReflectionRow {
    id: string;
    run_id: string;
    event_ids: string;
    outcome: ReflectionInput['outcome'];
    error: string | null;
    reflection_output: string | null;
    reflection_error: string | null;
    attempts: number;
}

const MAX_CONTEXT_MEMORIES = 16;
const MAX_CONTEXT_EVENTS = 6;

/** 使用 SQLite 保存事件、Topic、记忆、Reflection 队列与成长候选 */
export class MemoryStore {
    private readonly database: Database;

    /**
     * 打开并初始化记忆数据库
     *
     * @param databasePath SQLite 文件路径
     */
    constructor (databasePath: string) {
        fs.mkdirSync(path.dirname(databasePath), { recursive: true });
        this.database = new Database(databasePath, { create: true });
        assertStateVersion(this.database);
        this.database.run('PRAGMA journal_mode = WAL');
        this.database.run('PRAGMA busy_timeout = 5000');
        this.database.run('PRAGMA foreign_keys = ON');
        this.migrate();
        initializeMemorySearch(this.database);
    }

    /**
     * 向证据时间线追加事件
     *
     * @param input 原始事件及其时间、来源和关联信息
     * @returns 新事件，同一幂等键已存在时返回原事件
     */
    public recordEvent (input: EventInput): EventRecord {
        const commit = this.database.transaction(() => this.insertEvent(input));
        return commit.immediate();
    }

    /**
     * 按标识读取一个事件
     *
     * @param id 事件标识
     * @returns 事件不存在时返回 null
     */
    public getEvent (id: string): EventRecord | null {
        const row = this.database.query('SELECT * FROM events WHERE id = ?').get(id) as EventRow | null;
        return row ? this.toEventRecord(row) : null;
    }

    /**
     * 按给定标识读取事件并保持时间线顺序
     *
     * @param ids 事件标识
     * @returns 存在的事件
     */
    public getEvents (ids: string[]): EventRecord[] {
        const uniqueIds = uniqueStrings(ids);
        if (uniqueIds.length === 0) {
            return [];
        }
        const rows = this.database.query(`
            SELECT * FROM events
            WHERE id IN (${placeholders(uniqueIds.length)})
            ORDER BY seq ASC
        `).all(...uniqueIds) as EventRow[];
        return rows.map(row => this.toEventRecord(row));
    }

    /**
     * 读取一次 Agent 运行产生的完整事件序列
     *
     * @param runId 运行标识
     * @returns 按写入顺序排列的事件
     */
    public listEventsByRun (runId: string): EventRecord[] {
        const rows = this.database.query(`
            SELECT * FROM events WHERE run_id = ? ORDER BY seq ASC
        `).all(requireText(runId, '运行标识')) as EventRow[];
        return rows.map(row => this.toEventRecord(row));
    }

    /** 为当前前台用户事件寻找此前最近的前台回复，仅作理解反馈的背景 */
    public previousAssistantReply (event: EventRecord): EventRecord | null {
        if (event.actor !== 'user' || event.taskId || (event.payload as { channel?: string } | null)?.channel === 'background') return null;
        const rows = this.database.query(`SELECT * FROM events
            WHERE seq < ? AND actor = 'agent' AND event_type = 'assistant_message'
                AND task_id IS NULL AND json_extract(payload, '$.channel') = 'foreground'
            ORDER BY seq DESC LIMIT 1`).all(event.seq) as EventRow[];
        const row = rows[0];
        // 被忘记的最近回复不能退回到更早、无关的回复
        return row && !this.isSourceForgotten(row.id) ? this.toEventRecord(row) : null;
    }

    /**
     * 读取一次用户交互及所有直接重试运行产生的事件
     *
     * @param sourceEventId 原始用户事件标识
     * @returns 原始运行与重试运行的完整事件序列
     */
    public listInteractionRunEvents (sourceEventId: string): EventRecord[] {
        const sourceId = requireText(sourceEventId, '交互来源事件');
        const rows = this.database.query(`
            SELECT * FROM events
            WHERE run_id IN (
                SELECT DISTINCT run_id FROM events
                WHERE (id = ? OR source_event_id = ?) AND run_id IS NOT NULL
            )
            ORDER BY seq ASC
        `).all(sourceId, sourceId) as EventRow[];
        return rows.map(row => this.toEventRecord(row));
    }

    /**
     * 分页读取前台用户与助理消息
     *
     * @param limit 本页最多返回的消息数
     * @param beforeSeq 只返回该时间线序号之前的消息
     * @returns 按时间线正序排列的消息事件
     */
    public listConversationEvents (limit = 50, beforeSeq?: number): EventRecord[] {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
            throw new Error('消息分页大小必须是 1 到 100 的整数');
        }
        if (beforeSeq !== undefined && (!Number.isInteger(beforeSeq) || beforeSeq < 1)) {
            throw new Error('消息游标必须是正整数');
        }
        const cursorCondition = beforeSeq === undefined ? '' : 'AND seq < ?';
        const parameters = beforeSeq === undefined ? [limit] : [beforeSeq, limit];
        const rows = this.database.query(`
            SELECT * FROM (
                SELECT * FROM events
                WHERE event_type IN ('user_message', 'assistant_message')
                    AND json_extract(payload, '$.channel') = 'foreground'
                    ${cursorCondition}
                ORDER BY seq DESC
                LIMIT ?
            ) ORDER BY seq ASC
        `).all(...parameters) as EventRow[];
        return rows.map(row => this.toEventRecord(row));
    }

    /**
     * 创建一个允许同名的持续事项
     *
     * @param input Topic 展示名称和可选类别
     * @returns 新 Topic
     */
    public createTopic (input: TopicInput): TopicRecord {
        const title = requireText(input.title, 'Topic 名称');
        const id = randomUUID();
        const now = new Date().toISOString();
        this.database.query(`
            INSERT INTO topics (id, title, normalized_title, kind, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, title, normalize(title), optionalText(input.kind), now, now);
        return this.getTopic(id)!;
    }

    /**
     * 按标识读取 Topic
     *
     * @param id Topic 标识
     * @returns Topic 不存在时返回 null
     */
    public getTopic (id: string): TopicRecord | null {
        const row = this.database.query(`
            SELECT id, title, kind, created_at, updated_at FROM topics WHERE id = ?
        `).get(id) as TopicRow | null;
        return row ? toTopicRecord(row) : null;
    }

    /**
     * 按展示名称检索 Topic
     *
     * @param query 检索文本
     * @param limit 最多返回数
     * @returns 允许包含同名 Topic 的结果
     */
    public searchTopics (query = '', limit = 20): TopicRecord[] {
        const normalizedQuery = normalize(query);
        const rows = this.database.query(`
            SELECT id, title, kind, created_at, updated_at
            FROM topics
            ORDER BY updated_at DESC
            LIMIT 500
        `).all() as TopicRow[];
        return rows
            .filter(row => !normalizedQuery || textMatchesQuery(row.title, normalizedQuery))
            .slice(0, boundedLimit(limit, 100))
            .map(toTopicRecord);
    }

    /**
     * 显式关联 Event 与 Topic
     *
     * @param eventId 事件标识
     * @param topicId Topic 标识
     * @returns 是否新增了关联
     */
    public linkEventTopic (eventId: string, topicId: string): boolean {
        const result = this.database.query(`
            INSERT OR IGNORE INTO event_topics (event_id, topic_id)
            VALUES (?, ?)
        `).run(eventId, topicId);
        return result.changes > 0;
    }

    /**
     * 显式关联 Memory 与 Topic
     *
     * @param memoryId 记忆标识
     * @param topicId Topic 标识
     * @returns 是否新增了关联
     */
    public linkMemoryTopic (memoryId: string, topicId: string): boolean {
        const result = this.database.query(`
            INSERT OR IGNORE INTO memory_topics (memory_id, topic_id)
            VALUES (?, ?)
        `).run(memoryId, topicId);
        return result.changes > 0;
    }

    /**
     * 显式保存一条已确认记忆
     *
     * @param candidate 记忆内容、时间和来源
     * @returns 保存后的 active 记忆
     */
    public remember (candidate: Omit<MemoryCandidate, 'sensitive'>): MemoryItem {
        requireSourceEventIds(candidate.sourceEventIds);
        const commit = this.database.transaction(() => this.insertMemory({
            ...candidate,
            sensitive: false,
            basis: candidate.basis || 'stated',
        }, 'active'));
        return commit.immediate();
    }

    /**
     * 用当前用户确认事件激活一条 Reflection 候选
     *
     * @param memoryId 候选记忆标识
     * @param sourceEventIds 本次确认的来源事件
     * @param details 确认时补充的现实有效时间与 Topic
     * @returns 激活后的记忆
     */
    public confirmMemory (
        memoryId: string,
        sourceEventIds: string[],
        details: Pick<MemoryCandidate, 'validFrom' | 'validTo' | 'topicIds'> = {},
    ): MemoryItem {
        requireSourceEventIds(sourceEventIds);
        const commit = this.database.transaction(() => {
            const memory = this.getMemory(memoryId);
            if (!memory || memory.status !== 'candidate') {
                throw new Error('待确认记忆不是 Reflection 候选');
            }
            const confirmationEventIds = uniqueStrings(sourceEventIds);
            const confirmationEvents = this.getEvents(confirmationEventIds);
            if (confirmationEvents.length !== confirmationEventIds.length) {
                throw new Error('记忆确认来源事件不存在');
            }
            const knownFrom = confirmationEvents
                .map(event => event.recordedAt)
                .sort()[0]!;
            const validFrom = details.validFrom
                ? normalizeTime(details.validFrom, '现实有效时间')
                : memory.validFrom;
            const validTo = details.validTo
                ? normalizeTime(details.validTo, '现实失效时间')
                : memory.validTo;
            assertOrderedInterval(validFrom, validTo, '现实有效时间');
            if (memory.supersedesId) {
                const previous = this.getMemory(memory.supersedesId);
                if (!previous || !memory.revisionKind) throw new Error('候选修订目标不存在');
                this.closeRevision(previous, memory.revisionKind, validFrom, knownFrom);
            }

            for (const eventId of confirmationEventIds) {
                this.database.query(`
                    INSERT OR IGNORE INTO memory_sources (memory_id, event_id)
                    VALUES (?, ?)
                `).run(memoryId, eventId);
            }
            this.database.query(`
                UPDATE memories
                SET status = 'active', basis = 'stated', valid_from = ?, valid_to = ?, known_from = ?, updated_at = ?
                WHERE id = ?
            `).run(validFrom || null, validTo || null, knownFrom, new Date().toISOString(), memoryId);
            for (const topicId of uniqueStrings(details.topicIds || [])) {
                this.linkMemoryTopic(memoryId, topicId);
            }
            return this.getMemory(memoryId)!;
        });
        return commit.immediate();
    }

    /**
     * 以纠错或现实变化语义创建一个新记忆版本
     *
     * @param memoryId 被修订的记忆标识
     * @param replacement 新认识与修订类型
     * @returns 新的 active 记忆版本
     */
    public reviseMemory (memoryId: string, replacement: MemoryRevisionInput): MemoryItem {
        requireSourceEventIds(replacement.sourceEventIds);
        if (replacement.revisionKind === 'world_change' && !replacement.validFrom) {
            throw new Error('现实变化必须提供开始生效时间');
        }
        const commit = this.database.transaction(() => {
            const previous = this.getMemory(memoryId);
            if (!previous || previous.status !== 'active') throw new Error('只能修订当前 active 记忆');
            const now = replacement.knownFrom ? normalizeTime(replacement.knownFrom, '认知时间') : new Date().toISOString();
            const replacementValidFrom = replacement.validFrom ? normalizeTime(replacement.validFrom, '现实有效时间') : undefined;
            this.closeRevision(previous, replacement.revisionKind, replacementValidFrom, now);
            const topicIds = replacement.topicIds === undefined ? previous.topicIds : replacement.topicIds;
            return this.insertMemory({
                ...replacement,
                resident: replacement.resident ?? previous.resident,
                basis: replacement.basis || 'stated',
                sensitive: false,
                ...(replacementValidFrom && { validFrom: replacementValidFrom }),
                knownFrom: now,
                topicIds,
            }, 'active', memoryId, replacement.revisionKind);
        });
        return commit.immediate();
    }

    /** 在调用方事务中关闭旧版本，候选确认与即时修订共用同一规则 */
    private closeRevision (previous: MemoryItem, kind: MemoryRevisionKind, validFrom: string | undefined, knownFrom: string): void {
        if (previous.status !== 'active') throw new Error('修订目标已变化，请重新核对最新认识');
        if (kind === 'world_change' && (!validFrom || (previous.validFrom && validFrom <= previous.validFrom))) {
            throw new Error('现实变化生效时间必须晚于旧版本起点');
        }
        const validTo = kind === 'world_change' && (!previous.validTo || previous.validTo > validFrom!)
            ? validFrom : previous.validTo;
        this.database.query('UPDATE memories SET status = ?, valid_to = ?, known_to = ?, updated_at = ? WHERE id = ?')
            .run(kind === 'correction' ? 'retracted' : 'superseded', validTo || null, knownFrom, knownFrom, previous.id);
    }

    /**
     * 按标识读取一条记忆
     *
     * @param id 记忆标识
     * @returns 记忆不存在时返回 null
     */
    public getMemory (id: string): MemoryItem | null {
        const row = this.database.query('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | null;
        return row ? this.toMemoryItem(row) : null;
    }

    /**
     * 按内容检索当前可见的长期记忆
     *
     * @param query 检索文本
     * @param limit 最多返回数
     * @returns active 和 candidate 记忆，按相关性排序
     */
    public search (query = '', limit = 20): MemoryItem[] {
        const match = memoryQuery(query);
        if (query.trim() && !match) return [];
        const rows = this.database.query(`
            SELECT m.* FROM memories m
            ${match ? 'JOIN memory_fts f ON f.rowid = m.rowid' : ''}
            WHERE m.status IN ('active', 'candidate') ${match ? 'AND memory_fts MATCH ?' : ''}
            ORDER BY ${match ? 'f.rank ASC,' : ''} m.importance DESC, m.id ASC LIMIT ?
        `).all(...(match ? [match] : []), boundedLimit(limit, 100)) as MemoryRow[];
        return rows.map(row => this.toMemoryItem(row));
    }

    /**
     * 软忘记一条记忆并保留审计关系
     *
     * @param id 记忆标识
     * @returns 是否存在且已忘记
     */
    public forget (id: string): boolean {
        const now = new Date().toISOString();
        const result = this.database.query(`
            UPDATE memories
            SET status = 'forgotten', known_to = COALESCE(known_to, ?), updated_at = ?
            WHERE id = ? AND status != 'forgotten'
        `).run(now, now, id);
        return result.changes > 0;
    }

    /**
     * 硬删除事件和直接由它支撑的派生记忆
     *
     * @param id 事件标识
     * @returns 删除结果和级联记忆标识
     */
    public eraseEvent (id: string): EventEraseResult {
        const commit = this.database.transaction(() => {
            const event = this.getEvent(id);
            if (!event) {
                return { erased: false, erasedMemoryIds: [] };
            }
            const rows = this.database.query(`
                SELECT DISTINCT memory_id FROM memory_sources WHERE event_id = ?
            `).all(id) as Array<{ memory_id: string }>;
            const memoryIds = rows.map(row => row.memory_id);
            for (const memoryId of memoryIds) {
                this.database.query('DELETE FROM memories WHERE id = ?').run(memoryId);
            }
            this.database.query('DELETE FROM events WHERE id = ?').run(id);
            return { erased: true, erasedMemoryIds: memoryIds };
        });
        return commit.immediate();
    }

    /**
     * 根据语义、Topic 与时间条件按需重建 Episode
     *
     * @param input 召回条件
     * @param excludeEventIds 当前运行中不应被当作历史召回的事件
     * @returns 有序事件、匹配记忆和相关 Topic
     */
    public recallEpisode (input: EpisodeRecallInput = {}, excludeEventIds: string[] = [], automatic = false): EpisodeView {
        const query = normalize(input.query || '');
        const excludedEvents = new Set(excludeEventIds);
        const explicitTopicIds = uniqueStrings(input.topicIds || []);
        const queryTopicIds = query
            ? this.searchTopics(query, 50).map(topic => topic.id)
            : [];
        const calendarMonthDay = input.calendarMonthDay
            ? normalizeMonthDay(input.calendarMonthDay)
            : undefined;
        const eventRows = this.loadRecallEvents(input, explicitTopicIds, calendarMonthDay, queryTopicIds, excludeEventIds, automatic);
        const memoryRows = this.loadRecallMemories(input, explicitTopicIds, queryTopicIds, automatic, excludeEventIds);
        const eventById = new Map(eventRows.map(row => [row.id, row]));
        const selectedEvents = new Map<string, EventRow>();
        const selectedMemories = new Map<string, MemoryRow>();
        const hasEventCue = Boolean(input.from || input.to || calendarMonthDay || explicitTopicIds.length > 0);
        const hasDirectMemoryCue = Boolean(input.validAt || input.knownAt || explicitTopicIds.length > 0);
        const hasAnyCue = Boolean(query || hasEventCue || hasDirectMemoryCue);

        for (const row of eventRows) {
            if (excludedEvents.has(row.id)) {
                continue;
            }
            const rowTopicIds = this.readEventTopicIds(row.id);
            const hasQuery = Boolean(query);
            const topicMatch = intersects(rowTopicIds, queryTopicIds);
            if ((!query && (hasEventCue || !hasAnyCue)) || hasQuery || topicMatch) {
                selectedEvents.set(row.id, row);
            }
        }
        for (const row of memoryRows) {
            const sourceEventIds = this.readMemorySourceIds(row.id);
            if (sourceEventIds.length === 0
                || sourceEventIds.every(eventId => excludedEvents.has(eventId))) {
                continue;
            }
            const rowTopicIds = this.readMemoryTopicIds(row.id);
            const hasQuery = Boolean(query);
            const topicMatch = intersects(rowTopicIds, queryTopicIds);
            if ((!query && (hasDirectMemoryCue || !hasAnyCue)) || hasQuery || topicMatch) {
                selectedMemories.set(row.id, row);
            }
        }

        const limitEvents = boundedLimit(input.limitEvents ?? 100, 500);
        const directEvents = [...selectedEvents.values()]
            .sort(query ? compareSearchRank : compareEvents)
            .slice(query ? 0 : -limitEvents, query ? limitEvents : undefined);
        selectedEvents.clear();
        directEvents.forEach(row => selectedEvents.set(row.id, row));

        // 证据命中也能带回认识，先按来源收窄，避免近期无关记忆占满限额
        if (selectedEvents.size) {
            const linked = this.loadRecallMemories({ ...input, query: undefined }, explicitTopicIds, [], automatic,
                excludeEventIds, [...selectedEvents.keys()]);
            for (const row of linked) if (!selectedMemories.has(row.id)) selectedMemories.set(row.id, row);
        }

        const limitMemories = boundedLimit(input.limitMemories ?? 50, 200);
        const memoryRowsWithinLimit = [...selectedMemories.values()]
            .sort(query ? compareSearchRank : compareMemories)
            .slice(query ? 0 : -limitMemories, query ? limitMemories : undefined);
        selectedMemories.clear();
        memoryRowsWithinLimit.forEach(row => selectedMemories.set(row.id, row));

        // Memory 来源是 provenance closure，可能位于直接时间或 Topic 过滤之外
        for (const memoryId of automatic ? [] : selectedMemories.keys()) {
            for (const eventId of this.readMemorySourceIds(memoryId)) {
                if (excludedEvents.has(eventId)) {
                    continue;
                }
                const row = eventById.get(eventId) || this.database.query(`
                    SELECT * FROM events WHERE id = ?
                `).get(eventId) as EventRow | null;
                if (row) {
                    selectedEvents.set(eventId, row);
                }
            }
        }

        const eventRowsWithinEpisode = [...selectedEvents.values()].sort(compareEvents);
        const finalTopicIds = new Set([...explicitTopicIds, ...queryTopicIds]);
        eventRowsWithinEpisode.forEach(row => {
            this.readEventTopicIds(row.id).forEach(topicId => finalTopicIds.add(topicId));
        });
        memoryRowsWithinLimit.forEach(row => {
            this.readMemoryTopicIds(row.id).forEach(topicId => finalTopicIds.add(topicId));
        });
        const events = eventRowsWithinEpisode.map(row => this.toEventRecord(row));
        const memories = memoryRowsWithinLimit.map(row => this.toMemoryItem(row));
        const topics = [...finalTopicIds]
            .map(id => this.getTopic(id))
            .filter((topic): topic is TopicRecord => topic !== null)
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
        return {
            events,
            memories,
            topics,
            generatedAt: new Date().toISOString(),
        };
    }

    /**
     * 把交互追加到持久 Reflection 队列
     *
     * @param input 运行标识、真实事件来源和结果
     * @returns Reflection 标识
     */
    public enqueueReflection (input: ReflectionInput): string {
        const runId = requireText(input.runId, 'Reflection 运行标识');
        const eventIds = uniqueStrings(input.eventIds);
        const events = this.getEvents(eventIds);
        if (eventIds.length === 0
            || events.length !== eventIds.length
            || events.some(event => event.runId !== runId)) {
            throw new Error('Reflection 必须引用本轮存在的来源事件');
        }
        const commit = this.database.transaction(() => {
            const existing = this.database.query(`
                SELECT id FROM memory_reflections WHERE run_id = ?
            `).get(runId) as { id: string } | null;
            if (existing) {
                return existing.id;
            }
            const id = randomUUID();
            const now = new Date().toISOString();
            this.database.query(`
                INSERT INTO memory_reflections (
                    id, run_id, event_ids, outcome, error,
                    status, attempts, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?)
            `).run(
                id,
                runId,
                JSON.stringify(eventIds),
                input.outcome,
                input.error || null,
                now,
                now,
            );
            return id;
        });
        return commit.immediate();
    }

    /**
     * 原子领取一条待处理 Reflection
     *
     * @returns 当前队列项，队列为空时返回 null
     */
    public claimReflection (): ReflectionJob | null {
        return this.claimReflections(1)[0] || null;
    }

    /**
     * 原子领取一批待处理 Reflection
     *
     * @param limit 单次空闲回看的最大运行数
     * @returns 按入队时间排序的队列项
     */
    public claimReflections (limit = 12): ReflectionJob[] {
        const claim = this.database.transaction(() => {
            const rows = this.database.query(`
                SELECT id, run_id, event_ids, outcome, error,
                    reflection_output, reflection_error, attempts
                FROM memory_reflections
                WHERE status = 'queued'
                ORDER BY created_at ASC
                LIMIT ?
            `).all(boundedLimit(limit, 50)) as ReflectionRow[];
            if (rows.length === 0) {
                return [];
            }
            const now = new Date().toISOString();
            for (const row of rows) {
                this.database.query(`
                    UPDATE memory_reflections
                    SET status = 'running', attempts = attempts + 1, updated_at = ?
                    WHERE id = ? AND status = 'queued'
                `).run(now, row.id);
            }
            return rows.map(row => ({
                id: row.id,
                runId: row.run_id,
                eventIds: parseStringArray(row.event_ids),
                outcome: row.outcome,
                ...(row.error && { error: row.error }),
                attempts: row.attempts + 1,
                ...(row.reflection_output && { previousOutput: row.reflection_output }),
                ...(row.reflection_error && { previousError: row.reflection_error }),
            } satisfies ReflectionJob));
        });
        return claim.immediate();
    }

    /**
     * 提交单次 Reflection 结果，缺少明确陈述依据时保留候选
     *
     * @param jobId Reflection 标识
     * @param result 结构化结果
     */
    public completeReflection (jobId: string, result: ReflectionResult): void {
        const job = this.database.query(`
            SELECT event_ids FROM memory_reflections WHERE id = ?
        `).get(jobId) as { event_ids: string } | null;
        if (!job) {
            throw new Error('Reflection 不存在');
        }
        const sourceEventIds = parseStringArray(job.event_ids);
        this.completeReflections([jobId], {
            memories: result.memories.map(memory => ({
                ...memory,
                sourceEventIds: memory.sourceEventIds || sourceEventIds,
            })),
            growth: result.growth.map(growth => ({
                ...growth,
                sourceEventIds: growth.sourceEventIds || sourceEventIds,
            })),
        });
    }

    /**
     * 提交一次空闲回看的批量结果，并校验模型只能引用本批真实事件
     *
     * @param jobIds 本次一起回看的 Reflection 标识
     * @param result 带事件级来源的结构化结果
     * @param visibleMemories 本次展示给 Reflection 的记忆快照
     * @param visibleGrowth 本次展示给 Reflection 的成长候选快照
     * @returns 被跳过或降级为候选的操作说明，不包含记忆正文
     */
    public completeReflections (jobIds: string[], result: ReflectionResult, visibleMemories: MemoryItem[] = [], visibleGrowth: GrowthProposal[] = []): Array<{ targetId?: string; reason: string }> {
        const ids = uniqueStrings(jobIds);
        if (ids.length === 0) {
            throw new Error('Reflection 批次不能为空');
        }
        const commit = this.database.transaction(() => {
            const notices: Array<{ targetId?: string; reason: string }> = [];
            const jobs = this.database.query(`
                SELECT id, event_ids FROM memory_reflections
                WHERE id IN (${placeholders(ids.length)}) AND status = 'running'
            `).all(...ids) as Array<{ id: string; event_ids: string }>;
            if (jobs.length !== ids.length) {
                throw new Error('Reflection 批次不存在或不在运行中');
            }
            const allowedEvents = new Set(jobs.flatMap(job => parseStringArray(job.event_ids)));
            const reflectionIdsByEvent = new Map<string, string[]>();
            for (const job of jobs) {
                for (const eventId of parseStringArray(job.event_ids)) {
                    const reflectionIds = reflectionIdsByEvent.get(eventId) || [];
                    reflectionIds.push(job.id);
                    reflectionIdsByEvent.set(eventId, reflectionIds);
                }
            }
            for (const memory of result.memories) {
                if (memory.sensitive || memory.content.trim().length < 4) {
                    continue;
                }
                const sourceEventIds = requireReflectionSources(memory.sourceEventIds, allowedEvents);
                if (sourceEventIds.some(id => this.isSourceForgotten(id))) continue;
                const operation = memory.operation || 'add';
                const target = memory.targetId ? this.getMemory(memory.targetId) : null;
                if (operation !== 'add') {
                    const shown = visibleMemories.find(item => item.id === memory.targetId);
                    if (!shown || !target || !['active', 'candidate'].includes(target.status)
                        || target.updatedAt !== shown.updatedAt || target.status !== shown.status) {
                        notices.push({ targetId: memory.targetId, reason: '跳过：Reflection 修订目标不可用或已变化' });
                        continue;
                    }
                }
                const stated = memory.basis === 'stated' && memory.assertion === 'established'
                    && memory.needsConfirmation === false && this.getEvents(sourceEventIds).every(event => event.actor === 'user');
                const verified = this.isVerifiedCorrection(memory, sourceEventIds)
                    && (!target || (target.kind === 'lesson' && target.basis === 'observed'));
                const canActivate = stated || verified;
                if (operation === 'reinforce') {
                    for (const eventId of sourceEventIds) this.database.query(
                        'INSERT OR IGNORE INTO memory_sources (memory_id, event_id) VALUES (?, ?)',
                    ).run(target!.id, eventId);
                    // 补证据只能激活同一条认识，不能借 reinforce 偷换内容或绕过修订链
                    if (target!.status === 'candidate' && !target!.supersedesId && canActivate
                        && target!.kind === memory.kind && target!.content === memory.content) {
                        if (stated) this.confirmMemory(target!.id, sourceEventIds);
                        else this.activateObservedMemory(target!.id);
                    }
                    continue;
                }
                const candidate = { ...memory, sourceEventIds };
                // 仅隔离可预期的日期校验错误；数据库写入仍由外层事务统一保证
                try {
                    for (const field of ['validFrom', 'validTo', 'knownFrom', 'knownTo'] as const) {
                        if (candidate[field]) candidate[field] = normalizeTime(candidate[field], field);
                    }
                    assertOrderedInterval(candidate.validFrom, candidate.validTo, '现实有效时间');
                    assertOrderedInterval(candidate.knownFrom || new Date().toISOString(), candidate.knownTo, '认知时间');
                    if (operation === 'update' && memory.revisionKind === 'world_change'
                        && candidate.validFrom && target!.validFrom && candidate.validFrom <= target!.validFrom) {
                        throw new Error('现实变化生效时间必须晚于旧版本起点');
                    }
                } catch (error) {
                    notices.push({ targetId: memory.targetId, reason: `跳过：${error instanceof Error ? error.message : String(error)}` });
                    continue;
                }
                if (operation === 'update') {
                    if (target!.status !== 'active' || !memory.revisionKind) {
                        notices.push({ targetId: memory.targetId, reason: '跳过：修订需要 active 目标和修订类型' });
                        continue;
                    }
                    candidate.resident ??= target!.resident;
                    candidate.topicIds ??= target!.topicIds;
                    const missingChangeTime = memory.revisionKind === 'world_change' && !memory.validFrom;
                    if (missingChangeTime) notices.push({ targetId: memory.targetId, reason: '保留候选：现实变化缺少生效时间' });
                    if (canActivate && !missingChangeTime) {
                        this.reviseMemory(target!.id, { ...candidate, revisionKind: memory.revisionKind });
                    } else {
                        this.insertMemory(candidate, 'candidate', target!.id, memory.revisionKind);
                    }
                    continue;
                }
                // 同一事件已被修订的提取结果不能通过重复 add 恢复旧认识
                const prior = this.findMemoryFromEvent(memory.kind, memory.content, sourceEventIds[0]!);
                if (prior && (!['active', 'candidate'].includes(prior.status)
                    || (prior.status === 'candidate' && prior.supersedesId))) continue;
                const existing = this.findDuplicateMemory(candidate);
                if (!existing) {
                    this.insertMemory(candidate, canActivate ? 'active' : 'candidate');
                } else if (existing.status === 'candidate' && (stated || (verified && existing.basis === 'observed'))) {
                    // 重复证据本身不构成确认；只有本次陈述满足原有生效条件才激活
                    if (stated) this.confirmMemory(existing.id, sourceEventIds);
                    else {
                        for (const eventId of sourceEventIds) this.database.query(
                            'INSERT OR IGNORE INTO memory_sources (memory_id, event_id) VALUES (?, ?)',
                        ).run(existing.id, eventId);
                        this.activateObservedMemory(existing.id);
                    }
                } else {
                    for (const eventId of sourceEventIds) this.database.query(
                        'INSERT OR IGNORE INTO memory_sources (memory_id, event_id) VALUES (?, ?)',
                    ).run(existing.id, eventId);
                }
            }
            for (const growth of result.growth) {
                if (growth.confidence < 0.5 || growth.title.trim().length < 4) {
                    continue;
                }
                const sourceEventIds = requireReflectionSources(growth.sourceEventIds, allowedEvents);
                if (sourceEventIds.some(id => this.isSourceForgotten(id))) continue;
                if (growth.targetId) {
                    const shown = visibleGrowth.find(item => item.id === growth.targetId);
                    const current = this.listGrowth(undefined, 200).find(item => item.id === growth.targetId);
                    if (!shown || !current || current.status !== 'proposed' || shown.status !== 'proposed'
                        || current.kind !== growth.kind || current.updatedAt !== shown.updatedAt) {
                        notices.push({ targetId: growth.targetId, reason: '跳过：成长候选目标不可用或已变化' });
                        continue;
                    }
                }
                const reflectionIds = uniqueStrings(sourceEventIds.flatMap(
                    eventId => reflectionIdsByEvent.get(eventId) || [],
                ));
                this.upsertGrowth(growth, reflectionIds);
            }
            this.database.query(`
                UPDATE memory_reflections
                SET status = 'completed', updated_at = ?,
                    reflection_output = NULL, reflection_error = NULL
                WHERE id IN (${placeholders(ids.length)})
            `).run(new Date().toISOString(), ...ids);
            return notices;
        });
        return commit.immediate();
    }

    /** 校验具体执行纠错的事件链；是否真正解决问题仍由 Reflection 结合结果内容判断 */
    private isVerifiedCorrection (memory: MemoryCandidate, sources: string[]): boolean {
        const proof = memory.verifiedCorrection;
        if (!proof || proof.aboutUser !== false || memory.kind !== 'lesson' || memory.basis !== 'observed'
            || memory.assertion !== 'established' || memory.needsConfirmation !== false
            || !proof.applicability.trim() || !proof.explanation.trim()
            || !memory.content.includes(proof.applicability)) return false;
        const ids = [proof.failureEventId, proof.correctionEventId, proof.resultEventId];
        if (new Set(ids).size !== 3 || ids.some(id => !sources.includes(id))) return false;
        const failure = this.getEvent(ids[0]!)!;
        const correction = this.getEvent(ids[1]!)!;
        const result = this.getEvent(ids[2]!)!;
        if (!failure || !correction || !result || !failure.runId || failure.runId !== correction.runId
            || result.runId !== correction.runId || failure.seq >= correction.seq || correction.seq >= result.seq
            || !failure.actor.startsWith('tool:') || !['tool_error', 'tool_result'].includes(failure.type)
            || correction.actor !== 'agent' || correction.type !== 'tool_call'
            || result.type !== 'tool_result' || !result.actor.startsWith('tool:')
            || result.sourceEventId !== correction.id) return false;
        const payload = result.payload as { result?: unknown } | null;
        const output = payload?.result;
        if (output === undefined || output === null || output === '') return false;
        if (typeof output === 'object') {
            const details = output as Record<string, unknown>;
            if (details.error || details.success === false || details.ok === false
                || (typeof details.exitCode === 'number' && details.exitCode !== 0)) return false;
        }
        return true;
    }

    /** 激活已有的执行经验并保留 observed 依据，认知时间从本次验证开始 */
    private activateObservedMemory (id: string): void {
        const now = new Date().toISOString();
        this.database.query(`UPDATE memories SET status = 'active', basis = 'observed', known_from = ?, updated_at = ?
            WHERE id = ? AND status = 'candidate' AND supersedes_id IS NULL`).run(now, now, id);
    }

    /**
     * 记录 Reflection 失败，最多自动尝试三次
     *
     * @param jobId Reflection 标识
     * @param error 失败信息
     * @param output 本次无效的模型输出
     */
    public failReflection (jobId: string, error: string, output = ''): void {
        this.failReflections([jobId], error, output);
    }

    /**
     * 记录一批 Reflection 失败，最多自动尝试三次
     *
     * @param jobIds Reflection 标识
     * @param error 失败信息
     * @param output 本次无效的模型输出
     */
    public failReflections (jobIds: string[], error: string, output = ''): void {
        const ids = uniqueStrings(jobIds);
        if (ids.length === 0) {
            return;
        }
        this.database.query(`
            UPDATE memory_reflections
            SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'queued' END,
                reflection_error = ?, reflection_output = ?, updated_at = ?
            WHERE id IN (${placeholders(ids.length)})
        `).run(error.slice(0, 4000), output.slice(0, 30000), new Date().toISOString(), ...ids);
    }

    /**
     * 释放因 Agent 活动而暂停的 Reflection，不消耗一次失败重试
     *
     * @param jobId Reflection 标识
     */
    public releaseReflection (jobId: string): void {
        this.releaseReflections([jobId]);
    }

    /**
     * 释放因 Agent 活动而暂停的一批 Reflection，不消耗失败重试
     *
     * @param jobIds Reflection 标识
     */
    public releaseReflections (jobIds: string[]): void {
        const ids = uniqueStrings(jobIds);
        if (ids.length === 0) {
            return;
        }
        this.database.query(`
            UPDATE memory_reflections
            SET status = 'queued', attempts = MAX(0, attempts - 1), updated_at = ?
            WHERE id IN (${placeholders(ids.length)}) AND status = 'running'
        `).run(new Date().toISOString(), ...ids);
    }

    /** 判断是否仍有等待处理的 Reflection */
    public hasQueuedReflections (): boolean {
        return Boolean(this.database.query(`
            SELECT 1 FROM memory_reflections WHERE status = 'queued' LIMIT 1
        `).get());
    }

    /** 将崩溃时留下的 running Reflection 放回队列 */
    public recoverReflections (): void {
        this.database.query(`
            UPDATE memory_reflections
            SET status = 'queued', updated_at = ?
            WHERE status = 'running'
        `).run(new Date().toISOString());
    }

    /**
     * 列出成长候选
     *
     * @param status 可选状态过滤
     * @param limit 最多返回数
     * @returns 候选列表
     */
    public listGrowth (status?: GrowthProposal['status'], limit = 50): GrowthProposal[] {
        const rows = status
            ? this.database.query(`
                SELECT id, kind, title, observation, evidence, confidence, evidence_count, status, updated_at
                FROM growth_proposals WHERE status = ?
                ORDER BY evidence_count DESC, confidence DESC, updated_at DESC LIMIT ?
            `).all(status, boundedLimit(limit, 200)) as GrowthRow[]
            : this.database.query(`
                SELECT id, kind, title, observation, evidence, confidence, evidence_count, status, updated_at
                FROM growth_proposals
                ORDER BY status = 'proposed' DESC, evidence_count DESC, confidence DESC, updated_at DESC LIMIT ?
            `).all(boundedLimit(limit, 200)) as GrowthRow[];
        return rows.map(toGrowthProposal);
    }

    /**
     * 标记成长候选的处理结果
     *
     * @param id 候选标识
     * @param status 接受或忽略
     * @returns 是否成功更新
     */
    public resolveGrowth (id: string, status: 'accepted' | 'dismissed'): boolean {
        const result = this.database.query(`
            UPDATE growth_proposals SET status = ?, updated_at = ?
            WHERE id = ? AND status = 'proposed'
        `).run(status, new Date().toISOString(), id);
        return result.changes > 0;
    }

    /**
     * 为当前交互构建有界的相关记忆和事件上下文
     *
     * @param query 当前用户输入或任务
     * @param excludeEventIds 本轮已在用户消息中提供、不应重复注入的事件
     * @returns 可注入系统提示的结构化文本
     */
    public buildContext (query: string, excludeEventIds: string[] = []): string {
        const episode = this.recallEpisode({ query, limitEvents: MAX_CONTEXT_EVENTS, limitMemories: MAX_CONTEXT_MEMORIES }, excludeEventIds, true);
        const residentIds = new Set(this.profileMemories().map(memory => memory.id));
        const sections: string[] = [];
        let remaining = 6000;
        for (const memory of episode.memories.filter(memory => !residentIds.has(memory.id))) {
            const line = `- [${memory.id}] (${memory.kind}; ${memory.basis || '未分类依据'}) ${memory.content} sources=${memory.sourceEventIds.length}`;
            if (line.length > remaining) continue;
            remaining -= line.length;
            sections.push(line);
        }
        const events: string[] = [];
        for (const event of episode.events) {
            const text = eventSearchText(event);
            if (text === null) continue;
            const line = `- [${event.id}] ${event.occurredFrom} ${event.actor}/${event.type}: ${truncate(text, 600)}`;
            if (line.length > remaining) continue;
            remaining -= line.length;
            events.push(line);
        }
        return `<structured-memory>\n${sections.join('\n') || '暂无相关认识'}\n</structured-memory>\n<relevant-events>\n${events.join('\n') || '暂无相关事件'}\n</relevant-events>`;
    }

    /** 为前台提供少量相关推测；不改变状态、不进入档案，也不把计划当事实 */
    public buildHypothesisContext (query: string, excludeEventIds: string[] = []): string {
        const match = memoryQuery(query);
        if (!match) return '';
        const now = new Date().toISOString();
        const rows = this.database.query(`SELECT m.* FROM memories m JOIN memory_fts f ON f.rowid = m.rowid
            WHERE m.status = 'candidate' AND m.basis = 'inferred' AND m.supersedes_id IS NULL
                AND m.known_to IS NULL AND (m.valid_from IS NULL OR m.valid_from <= ?)
                AND (m.valid_to IS NULL OR m.valid_to > ?) AND memory_fts MATCH ?
            ORDER BY f.rank ASC, m.importance DESC LIMIT 12`).all(now, now, match) as MemoryRow[];
        const candidates = rows.map(row => this.toMemoryItem(row)).filter(memory => memory.sourceEventIds.length
            && !memory.sourceEventIds.some(id => this.isSourceForgotten(id))
            && memory.sourceEventIds.some(id => !excludeEventIds.includes(id))).slice(0, 3);
        if (!candidates.length) return '';
        return `<pending-understanding>\n${JSON.stringify(candidates.map(memory => ({
            id: memory.id, content: memory.content, basis: memory.basis, status: memory.status,
        })))}\n</pending-understanding>`;
    }

    /** 按完整条目与稳定排序选择当前有效的核心资料 */
    public profileMemories (): MemoryItem[] {
        const now = new Date().toISOString();
        // 最新版本可能描述未来，已被接续但尚未到期的旧版本仍是当前资料
        const rows = this.database.query(`SELECT * FROM memories WHERE resident = 1
            AND (status = 'active' OR (status = 'superseded' AND valid_to > ?))
            AND (valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to > ?)
            ORDER BY importance DESC, id ASC`).all(now, now, now) as MemoryRow[];
        let remaining = 3000;
        return rows.filter(row => {
            const size = row.content.length + row.id.length + 16;
            if (size > remaining) return false;
            remaining -= size;
            return true;
        }).map(row => this.toMemoryItem(row));
    }

    /** 从同一份结构化认识渲染用户档案，不把来源类别升级为指令权限 */
    public buildProfile (): string {
        const memories = this.profileMemories();
        return ['# 用户档案', '以下是可修正的背景资料；当前明确要求优先，推断不能授予操作权限。',
            ...(['stated', 'reference'] as const).flatMap(group => [
                group === 'stated' ? '## 用户明确表达的资料与偏好' : '## 根据经历形成的参考认识',
                ...memories.filter(memory => group === 'stated' ? memory.basis === 'stated' : memory.basis !== 'stated')
                    .map(memory => `- [${memory.id}] ${memory.content}`),
            ]),
        ].join('\n');
    }

    /** 判断来源是否被遗忘规则封禁，供提取和提交时双重检查 */
    public isSourceForgotten (eventId: string): boolean {
        return Boolean(this.database.query(`SELECT 1 FROM memory_sources ms JOIN memories m ON m.id = ms.memory_id
            WHERE ms.event_id = ? AND m.status = 'forgotten' LIMIT 1`).get(eventId));
    }

    /**
     * 分页读取管理页的一栏，在数据库内完成状态筛选、全文检索和计数
     *
     * @param scope 当前认识、待确认、已忽略或历史版本
     * @param options 检索词、分页偏移，以及需要优先展示的档案标识
     * @returns 最多 100 条记录与匹配总数
     */
    public listMemoryPage (
        scope: 'current' | 'pending' | 'ignored' | 'versions',
        options: { query?: string; offset?: number; profileIds?: string[] } = {},
    ): { items: MemoryItem[]; total: number } {
        const now = new Date().toISOString();
        const conditions: string[] = [];
        const parameters: string[] = [];
        if (scope === 'current') {
            conditions.push("(m.status = 'active' OR (m.status = 'superseded' AND m.valid_to > ?)) AND (m.valid_to IS NULL OR m.valid_to > ?)");
            parameters.push(now, now);
        } else if (scope === 'pending' || scope === 'ignored') {
            conditions.push(`m.status = 'candidate' AND m.review_ignored = ${scope === 'ignored' ? 1 : 0}`);
        } else {
            conditions.push("m.status != 'candidate'");
        }
        const match = memoryQuery(options.query || '');
        if (options.query?.trim() && !match) return { items: [], total: 0 };
        if (match) {
            // 遗忘痕迹可以浏览，但不能通过原正文被搜索出来
            conditions.push("m.status != 'forgotten' AND memory_fts MATCH ?");
            parameters.push(match);
        }
        const from = `FROM memories m ${match ? 'JOIN memory_fts f ON f.rowid = m.rowid' : ''}
            WHERE ${conditions.join(' AND ')}`;
        const total = (this.database.query(`SELECT count(*) AS total ${from}`).get(...parameters) as { total: number }).total;
        const profileIds = scope === 'current' ? options.profileIds || [] : [];
        // 档案预算最多容纳几十条，让实际常驻资料完整出现在第一页
        const profileOrder = profileIds.length ? `CASE WHEN m.id IN (${placeholders(profileIds.length)}) THEN 0 ELSE 1 END,` : '';
        const order = scope === 'current' ? `${profileOrder} m.resident DESC, m.importance DESC,` : '';
        const rows = this.database.query(`SELECT m.* ${from}
            ORDER BY ${order} ${match ? 'f.rank ASC,' : ''} m.known_from DESC, m.id ASC LIMIT 100 OFFSET ?`)
            .all(...parameters, ...profileIds, options.offset || 0) as MemoryRow[];
        return { items: rows.map(row => this.toMemoryItem(row)), total };
    }

    /**
     * 只调整候选在确认列表中的可见性，不作为记忆判断或学习证据
     *
     * @param id 候选标识
     * @param ignored 是否忽略
     * @returns 状态和来源保持不变的候选
     */
    public setReviewIgnored (id: string, ignored: boolean): MemoryItem {
        // 不改 updated_at，避免纯显示操作使 Reflection 的证据快照过期
        const result = this.database.query(`UPDATE memories SET review_ignored = ?
            WHERE id = ? AND status = 'candidate'`).run(ignored ? 1 : 0, id);
        if (!result.changes) throw new Error('只能忽略或恢复待确认的认识');
        return this.getMemory(id)!;
    }

    /**
     * 读取一条认识所在的完整修订链
     *
     * @param id 链上任意一个版本
     * @returns 按认知时间升序排列的版本，包含尚待确认的修订
     */
    public memoryHistory (id: string): MemoryItem[] {
        let root = this.getMemory(id);
        if (!root) return [];
        const visited = new Set([root.id]);
        while (root.supersedesId) {
            const previous = this.getMemory(root.supersedesId);
            if (!previous || visited.has(previous.id)) break;
            visited.add(previous.id);
            root = previous;
        }
        // 同一版本可能同时挂着已生效的修订和待确认的修订，因此向后按分支展开
        const chain = [root];
        const seen = new Set([root.id]);
        for (let index = 0; index < chain.length; index++) {
            const rows = this.database.query('SELECT * FROM memories WHERE supersedes_id = ? ORDER BY known_from ASC, id ASC')
                .all(chain[index]!.id) as MemoryRow[];
            for (const row of rows) {
                if (seen.has(row.id)) continue;
                seen.add(row.id);
                chain.push(this.toMemoryItem(row));
            }
        }
        return chain.sort((left, right) => left.knownFrom.localeCompare(right.knownFrom) || left.id.localeCompare(right.id));
    }

    /**
     * 调整一条认识是否常驻用户档案
     *
     * @param id 当前或待确认的认识
     * @param resident 是否常驻
     * @returns 更新后的认识
     */
    public setResident (id: string, resident: boolean): MemoryItem {
        const result = this.database.query(`UPDATE memories SET resident = ?, updated_at = ?
            WHERE id = ? AND status IN ('active', 'candidate')`).run(resident ? 1 : 0, new Date().toISOString(), id);
        if (!result.changes) throw new Error('只能调整当前或待确认的认识');
        return this.getMemory(id)!;
    }

    /**
     * 把用户在入口上的直接操作记为事件，并在同一事务中完成记忆修改
     *
     * @param input 用户操作事件
     * @param apply 以该事件为来源执行的修改
     * @returns 修改结果；修改失败时事件一并回滚，不留下未生效的陈述
     */
    public applyUserEdit<T> (input: EventInput, apply: (eventId: string) => T): T {
        const commit = this.database.transaction(() => apply(this.recordEvent({ ...input, actor: 'user' }).id));
        return commit.immediate();
    }

    /** 初始化目标模型需要的最小数据表 */
    private migrate (): void {
        this.database.run(`
            CREATE TABLE IF NOT EXISTS events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT NOT NULL UNIQUE,
                actor TEXT NOT NULL,
                event_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                occurred_from TEXT NOT NULL,
                occurred_to TEXT,
                recorded_at TEXT NOT NULL,
                precision TEXT NOT NULL,
                timezone TEXT,
                local_date TEXT,
                run_id TEXT,
                task_id TEXT,
                source_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
                idempotency_key TEXT UNIQUE
            );
            CREATE INDEX IF NOT EXISTS events_occurred ON events(occurred_from, occurred_to);
            CREATE INDEX IF NOT EXISTS events_calendar ON events(local_date);
            CREATE INDEX IF NOT EXISTS events_run ON events(run_id, task_id);

            CREATE TABLE IF NOT EXISTS topics (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                normalized_title TEXT NOT NULL,
                kind TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS topics_search ON topics(normalized_title);

            CREATE TABLE IF NOT EXISTS event_topics (
                event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
                topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
                PRIMARY KEY(event_id, topic_id)
            );
            CREATE INDEX IF NOT EXISTS event_topics_topic ON event_topics(topic_id, event_id);

            CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                content TEXT NOT NULL,
                normalized_content TEXT NOT NULL,
                confidence REAL NOT NULL,
                importance REAL NOT NULL,
                status TEXT NOT NULL CHECK (
                    status IN ('candidate', 'active', 'superseded', 'retracted', 'forgotten')
                ),
                valid_from TEXT,
                valid_to TEXT,
                known_from TEXT NOT NULL,
                known_to TEXT,
                supersedes_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
                revision_kind TEXT CHECK (revision_kind IS NULL OR revision_kind IN ('correction', 'world_change')),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS memories_context
                ON memories(status, importance DESC, updated_at DESC);
            CREATE INDEX IF NOT EXISTS memories_valid_time ON memories(valid_from, valid_to);
            CREATE INDEX IF NOT EXISTS memories_known_time ON memories(known_from, known_to);

            CREATE TABLE IF NOT EXISTS memory_sources (
                memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
                event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
                PRIMARY KEY(memory_id, event_id)
            );
            CREATE INDEX IF NOT EXISTS memory_sources_event ON memory_sources(event_id, memory_id);

            CREATE TABLE IF NOT EXISTS memory_topics (
                memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
                topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
                PRIMARY KEY(memory_id, topic_id)
            );
            CREATE INDEX IF NOT EXISTS memory_topics_topic ON memory_topics(topic_id, memory_id);

            CREATE TABLE IF NOT EXISTS memory_reflections (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL UNIQUE,
                event_ids TEXT NOT NULL,
                outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed')),
                error TEXT,
                reflection_output TEXT,
                reflection_error TEXT,
                status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
                attempts INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS memory_reflections_queue
                ON memory_reflections(status, created_at);

            CREATE TABLE IF NOT EXISTS growth_proposals (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL CHECK (kind IN ('skill', 'runtime')),
                title TEXT NOT NULL,
                normalized_key TEXT NOT NULL,
                observation TEXT NOT NULL,
                evidence TEXT NOT NULL,
                confidence REAL NOT NULL,
                evidence_count INTEGER NOT NULL DEFAULT 1,
                source_reflections TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'dismissed')),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(kind, normalized_key)
            );
        `);
        const columns = this.database.query('PRAGMA table_info(memories)').all() as Array<{ name: string }>;
        if (!columns.some(column => column.name === 'resident')) this.database.run('ALTER TABLE memories ADD COLUMN resident INTEGER NOT NULL DEFAULT 0');
        if (!columns.some(column => column.name === 'basis')) this.database.run('ALTER TABLE memories ADD COLUMN basis TEXT');
        if (!columns.some(column => column.name === 'review_ignored')) this.database.run('ALTER TABLE memories ADD COLUMN review_ignored INTEGER NOT NULL DEFAULT 0');
    }

    /** 在当前事务中写入一个事件 */
    private insertEvent (input: EventInput): EventRecord {
        const actor = requireText(input.actor, '事件 actor');
        const type = requireText(input.type, '事件 type');
        const idempotencyKey = optionalText(input.idempotencyKey);
        if (idempotencyKey) {
            const existing = this.database.query(`
                SELECT * FROM events WHERE idempotency_key = ?
            `).get(idempotencyKey) as EventRow | null;
            if (existing) {
                for (const topicId of uniqueStrings(input.topicIds || [])) {
                    this.linkEventTopic(existing.id, topicId);
                }
                return this.toEventRecord(existing);
            }
        }
        const recordedAt = normalizeTime(input.recordedAt || new Date().toISOString(), '事件记录时间');
        const occurredInput = input.occurredFrom || recordedAt;
        const occurredFrom = normalizeTime(occurredInput, '事件发生时间');
        const occurredTo = input.occurredTo ? normalizeTime(input.occurredTo, '事件结束时间') : undefined;
        assertOrderedInterval(occurredFrom, occurredTo, '事件时间');
        const timezone = normalizeTimezone(input.timezone);
        const localDate = deriveLocalDate(occurredInput, timezone);
        if (input.localDate && normalizeLocalDate(input.localDate) !== localDate) {
            throw new Error('事件 localDate 与 timezone 不一致');
        }
        const id = randomUUID();
        this.database.query(`
            INSERT INTO events (
                id, actor, event_type, payload, occurred_from, occurred_to, recorded_at,
                precision, timezone, local_date, run_id, task_id, source_event_id, idempotency_key
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id,
            actor,
            type,
            serializeJson(input.payload ?? null),
            occurredFrom,
            occurredTo || null,
            recordedAt,
            input.precision || 'instant',
            timezone,
            localDate,
            optionalText(input.runId),
            optionalText(input.taskId),
            optionalText(input.sourceEventId),
            idempotencyKey,
        );
        for (const topicId of uniqueStrings(input.topicIds || [])) {
            this.linkEventTopic(id, topicId);
        }
        const indexedText = eventSearchText(input);
        if (indexedText !== null) this.database.query('INSERT INTO event_fts(rowid, text) SELECT rowid, ? FROM events WHERE id = ?')
            .run(memoryWords(indexedText).join(' '), id);
        return this.getEvent(id)!;
    }

    /** 在当前事务中写入一个记忆版本 */
    private insertMemory (
        candidate: MemoryCandidate,
        status: Extract<MemoryStatus, 'candidate' | 'active'>,
        supersedesId?: string,
        revisionKind?: MemoryRevisionKind,
    ): MemoryItem {
        const content = requireText(candidate.content, '记忆内容');
        const now = new Date().toISOString();
        const knownFrom = normalizeTime(candidate.knownFrom || now, '认知开始时间');
        const knownTo = candidate.knownTo ? normalizeTime(candidate.knownTo, '认知结束时间') : undefined;
        const validFrom = candidate.validFrom ? normalizeTime(candidate.validFrom, '现实有效时间') : undefined;
        const validTo = candidate.validTo ? normalizeTime(candidate.validTo, '现实失效时间') : undefined;
        assertOrderedInterval(validFrom, validTo, '现实有效时间');
        assertOrderedInterval(knownFrom, knownTo, '认知时间');
        const id = randomUUID();
        this.database.query(`
            INSERT INTO memories (
                id, kind, content, normalized_content, confidence, importance, status,
                valid_from, valid_to, known_from, known_to, supersedes_id,
                revision_kind, created_at, updated_at, resident, basis
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id,
            candidate.kind,
            content,
            normalize(content),
            clamp(candidate.confidence),
            clamp(candidate.importance),
            status,
            validFrom || null,
            validTo || null,
            knownFrom,
            knownTo || null,
            supersedesId || null,
            revisionKind || null,
            now,
            now,
            candidate.resident ? 1 : 0,
            candidate.basis || null,
        );
        this.database.query('INSERT INTO memory_fts(rowid, text) SELECT rowid, ? FROM memories WHERE id = ?')
            .run(memoryWords(content).join(' '), id);
        for (const eventId of uniqueStrings(candidate.sourceEventIds || [])) {
            this.database.query(`
                INSERT INTO memory_sources (memory_id, event_id)
                VALUES (?, ?)
            `).run(id, eventId);
        }
        for (const topicId of uniqueStrings(candidate.topicIds || [])) {
            this.linkMemoryTopic(id, topicId);
        }
        return this.getMemory(id)!;
    }

    /** 读取满足 Episode 硬约束的事件候选 */
    private loadRecallEvents (
        input: EpisodeRecallInput,
        topicIds: string[],
        calendarMonthDay?: string,
        queryTopicIds: string[] = [],
        excludeEventIds: string[] = [],
        automatic = false,
    ): EventRow[] {
        const conditions: string[] = [];
        const parameters: string[] = [];
        if (input.from) {
            const from = normalizeTime(input.from, 'Episode 开始时间');
            conditions.push('COALESCE(e.occurred_to, e.occurred_from) >= ?');
            parameters.push(from);
        }
        if (input.to) {
            const to = normalizeTime(input.to, 'Episode 结束时间');
            conditions.push('e.occurred_from <= ?');
            parameters.push(to);
        }
        if (calendarMonthDay) {
            conditions.push("substr(e.local_date, 6, 5) = ?");
            parameters.push(calendarMonthDay);
        }
        if (topicIds.length > 0) {
            conditions.push(`EXISTS (
                SELECT 1 FROM event_topics et
                WHERE et.event_id = e.id AND et.topic_id IN (${placeholders(topicIds.length)})
            )`);
            parameters.push(...topicIds);
        }
        if (excludeEventIds.length) {
            conditions.push(`e.id NOT IN (${placeholders(excludeEventIds.length)})`);
            parameters.push(...excludeEventIds);
        }
        if (automatic) {
            conditions.push('e.rowid IN (SELECT rowid FROM event_fts)');
            conditions.push("NOT EXISTS (SELECT 1 FROM memory_sources ms JOIN memories m ON m.id = ms.memory_id WHERE ms.event_id = e.id AND m.status = 'forgotten')");
        }
        const match = memoryQuery(input.query || '');
        if (input.query?.trim() && !match && !queryTopicIds.length) return [];
        if (match) {
            const topicMatch = queryTopicIds.length ? ` OR EXISTS (SELECT 1 FROM event_topics et WHERE et.event_id = e.id AND et.topic_id IN (${placeholders(queryTopicIds.length)}))` : '';
            conditions.push(`(f.rowid IS NOT NULL${topicMatch})`);
            parameters.push(...queryTopicIds);
        }
        if (!match && input.query?.trim() && queryTopicIds.length) {
            conditions.push(`EXISTS (SELECT 1 FROM event_topics et WHERE et.event_id = e.id AND et.topic_id IN (${placeholders(queryTopicIds.length)}))`);
            parameters.push(...queryTopicIds);
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        return this.database.query(`
            SELECT e.* ${match ? ', f.rank AS search_rank' : ''} FROM events e
            ${match ? `${queryTopicIds.length ? 'LEFT JOIN' : 'JOIN'} (SELECT rowid, rank FROM event_fts WHERE event_fts MATCH ?) f ON f.rowid = e.rowid` : ''}
            ${where} ORDER BY ${match ? 'COALESCE(f.rank, 0) ASC,' : ''} e.seq DESC LIMIT ?
        `).all(...(match ? [match] : []), ...parameters, boundedLimit(input.limitEvents ?? 100, 500)) as EventRow[];
    }

    /** 读取满足 Episode 时态和 Topic 约束的记忆候选 */
    private loadRecallMemories (input: EpisodeRecallInput, topicIds: string[], queryTopicIds: string[] = [], automatic = false, excluded: string[] = [], linkedEvents: string[] = []): MemoryRow[] {
        const conditions: string[] = ["m.status NOT IN ('candidate', 'forgotten')"];
        const parameters: string[] = [];
        conditions.push(`EXISTS (SELECT 1 FROM memory_sources ms WHERE ms.memory_id = m.id${excluded.length ? ` AND ms.event_id NOT IN (${placeholders(excluded.length)})` : ''})`);
        parameters.push(...excluded);
        if (linkedEvents.length) {
            conditions.push(`EXISTS (SELECT 1 FROM memory_sources ms WHERE ms.memory_id = m.id AND ms.event_id IN (${placeholders(linkedEvents.length)}))`);
            parameters.push(...linkedEvents);
        }
        if (automatic) {
            const residentIds = this.profileMemories().map(memory => memory.id);
            if (residentIds.length) {
                conditions.push(`m.id NOT IN (${placeholders(residentIds.length)})`);
                parameters.push(...residentIds);
            }
        }
        if (input.knownAt) {
            conditions.push("m.status IN ('active', 'superseded', 'retracted')");
            const knownAt = normalizeTime(input.knownAt, '认知查询时间');
            conditions.push('m.known_from <= ? AND (m.known_to IS NULL OR m.known_to > ?)');
            parameters.push(knownAt, knownAt);
        } else if (input.validAt || input.from || input.to) {
            conditions.push("m.status IN ('active', 'superseded')");
        } else if (automatic) {
            conditions.push("(m.status = 'active' OR (m.status = 'superseded' AND m.valid_to > ?))");
            parameters.push(new Date().toISOString());
        } else {
            conditions.push("m.status = 'active'");
        }
        if (input.validAt) {
            const validAt = normalizeTime(input.validAt, '现实查询时间');
            conditions.push('(m.valid_from IS NULL OR m.valid_from <= ?)');
            conditions.push('(m.valid_to IS NULL OR m.valid_to > ?)');
            parameters.push(validAt, validAt);
        } else {
            if (input.from) {
                const from = normalizeTime(input.from, 'Episode 开始时间');
                conditions.push('(m.valid_to IS NULL OR m.valid_to >= ?)');
                parameters.push(from);
            }
            if (input.to) {
                const to = normalizeTime(input.to, 'Episode 结束时间');
                conditions.push('(m.valid_from IS NULL OR m.valid_from <= ?)');
                parameters.push(to);
            }
        }
        if (topicIds.length > 0) {
            conditions.push(`EXISTS (
                SELECT 1 FROM memory_topics mt
                WHERE mt.memory_id = m.id AND mt.topic_id IN (${placeholders(topicIds.length)})
            )`);
            parameters.push(...topicIds);
        }
        if (automatic) {
            const now = new Date().toISOString();
            conditions.push('(m.valid_from IS NULL OR m.valid_from <= ?) AND (m.valid_to IS NULL OR m.valid_to > ?)');
            parameters.push(now, now);
        }
        const match = memoryQuery(input.query || '');
        if (input.query?.trim() && !match && !queryTopicIds.length) return [];
        if (match) {
            const topicMatch = queryTopicIds.length ? ` OR EXISTS (SELECT 1 FROM memory_topics mt WHERE mt.memory_id = m.id AND mt.topic_id IN (${placeholders(queryTopicIds.length)}))` : '';
            conditions.push(`(f.rowid IS NOT NULL${topicMatch})`);
            parameters.push(...queryTopicIds);
        }
        if (!match && input.query?.trim() && queryTopicIds.length) {
            conditions.push(`EXISTS (SELECT 1 FROM memory_topics mt WHERE mt.memory_id = m.id AND mt.topic_id IN (${placeholders(queryTopicIds.length)}))`);
            parameters.push(...queryTopicIds);
        }
        return this.database.query(`
            SELECT m.* ${match ? ', f.rank AS search_rank' : ''} FROM memories m
            ${match ? `${queryTopicIds.length ? 'LEFT JOIN' : 'JOIN'} (SELECT rowid, rank FROM memory_fts WHERE memory_fts MATCH ?) f ON f.rowid = m.rowid` : ''}
            WHERE ${conditions.join(' AND ')}
            ORDER BY ${match ? 'COALESCE(f.rank, 0) ASC,' : ''} COALESCE(m.valid_from, m.known_from) DESC, m.id ASC LIMIT ?
        `).all(...(match ? [match] : []), ...parameters, boundedLimit(input.limitMemories ?? 50, 200)) as MemoryRow[];
    }

    /** 将事件数据库行转换为公开结构 */
    private toEventRecord (row: EventRow): EventRecord {
        return {
            id: row.id,
            seq: row.seq,
            actor: row.actor,
            type: row.event_type,
            payload: parseJson(row.payload),
            occurredFrom: row.occurred_from,
            ...(row.occurred_to && { occurredTo: row.occurred_to }),
            recordedAt: row.recorded_at,
            precision: row.precision,
            ...(row.timezone && { timezone: row.timezone }),
            ...(row.local_date && { localDate: row.local_date }),
            ...(row.run_id && { runId: row.run_id }),
            ...(row.task_id && { taskId: row.task_id }),
            ...(row.source_event_id && { sourceEventId: row.source_event_id }),
            ...(row.idempotency_key && { idempotencyKey: row.idempotency_key }),
            topicIds: this.readEventTopicIds(row.id),
        };
    }

    /** 将记忆数据库行转换为公开结构 */
    private toMemoryItem (row: MemoryRow): MemoryItem {
        return {
            id: row.id,
            kind: row.kind,
            content: row.content,
            resident: Boolean(row.resident),
            ...(row.basis && { basis: row.basis }),
            confidence: row.confidence,
            importance: row.importance,
            status: row.status,
            ...(row.valid_from && { validFrom: row.valid_from }),
            ...(row.valid_to && { validTo: row.valid_to }),
            knownFrom: row.known_from,
            ...(row.known_to && { knownTo: row.known_to }),
            ...(row.supersedes_id && { supersedesId: row.supersedes_id }),
            ...(row.revision_kind && { revisionKind: row.revision_kind }),
            sourceEventIds: this.readMemorySourceIds(row.id),
            topicIds: this.readMemoryTopicIds(row.id),
            updatedAt: row.updated_at,
        };
    }

    /** 读取事件关联的 Topic */
    private readEventTopicIds (eventId: string): string[] {
        const rows = this.database.query(`
            SELECT topic_id FROM event_topics WHERE event_id = ? ORDER BY topic_id
        `).all(eventId) as Array<{ topic_id: string }>;
        return rows.map(row => row.topic_id);
    }

    /** 读取记忆关联的 Topic */
    private readMemoryTopicIds (memoryId: string): string[] {
        const rows = this.database.query(`
            SELECT topic_id FROM memory_topics WHERE memory_id = ? ORDER BY topic_id
        `).all(memoryId) as Array<{ topic_id: string }>;
        return rows.map(row => row.topic_id);
    }

    /** 读取支撑记忆的来源事件 */
    private readMemorySourceIds (memoryId: string): string[] {
        const rows = this.database.query(`
            SELECT event_id FROM memory_sources WHERE memory_id = ? ORDER BY event_id
        `).all(memoryId) as Array<{ event_id: string }>;
        return rows.map(row => row.event_id);
    }

    /** 查找同一来源已生成的同文认识，防止旧提取结果复活已修订版本 */
    private findMemoryFromEvent (kind: MemoryKind, content: string, eventId: string): MemoryItem | null {
        const rows = this.database.query(`
            SELECT m.* FROM memories m JOIN memory_sources ms ON ms.memory_id = m.id
            WHERE m.kind = ? AND m.normalized_content = ? AND ms.event_id = ?
        `).all(kind, normalize(content), eventId) as MemoryRow[];
        const fullContent = content.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
        const row = rows.find(item => item.content.trim().toLocaleLowerCase().replace(/\s+/g, ' ') === fullContent);
        return row ? this.toMemoryItem(row) : null;
    }

    /** 查找同文、同事项与同有效区间的认识；待确认修订必须继续走修订流程 */
    private findDuplicateMemory (candidate: MemoryCandidate): MemoryItem | null {
        const rows = this.database.query(`
            SELECT * FROM memories
            WHERE kind = ? AND normalized_content = ? AND status IN ('active', 'candidate')
                AND (status = 'active' OR supersedes_id IS NULL)
                AND valid_from IS ? AND valid_to IS ? AND known_to IS ?
            ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, id
        `).all(candidate.kind, normalize(candidate.content), candidate.validFrom || null,
            candidate.validTo || null, candidate.knownTo || null) as MemoryRow[];
        const content = candidate.content.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
        const topics = uniqueStrings(candidate.topicIds || []).sort();
        const row = rows.find(item => {
            // normalized_content 有长度上限，不能用相同前缀代替全文一致
            if (item.content.trim().toLocaleLowerCase().replace(/\s+/g, ' ') !== content) return false;
            if (candidate.knownFrom && candidate.knownFrom !== item.known_from) return false;
            const existingTopics = this.readMemoryTopicIds(item.id);
            return topics.length === existingTopics.length && topics.every((id, index) => id === existingTopics[index]);
        });
        return row ? this.toMemoryItem(row) : null;
    }

    /** 提交或增强一条成长候选 */
    private upsertGrowth (candidate: GrowthCandidate, reflectionIds: string[]): void {
        const candidateSources = uniqueStrings(reflectionIds);
        if (candidateSources.length === 0) {
            throw new Error('成长候选必须引用来源 Reflection');
        }
        const key = normalize(candidate.title);
        const existing = this.database.query(`
            SELECT id, kind, title, observation, evidence, confidence,
                evidence_count, status, updated_at, source_reflections
            FROM growth_proposals WHERE ${candidate.targetId ? 'id = ?' : 'kind = ? AND normalized_key = ?'}
        `).get(...(candidate.targetId ? [candidate.targetId] : [candidate.kind, key])) as (GrowthRow & { source_reflections: string }) | null;
        const now = new Date().toISOString();
        if (existing) {
            // 已处理候选不能因再次提取旧认识而重新打开
            if (existing.status !== 'proposed') return;
            const previousSources = parseStringArray(existing.source_reflections);
            const sources = uniqueStrings([...previousSources, ...candidateSources]);
            if (sources.length === previousSources.length) return;
            const evidenceCount = existing.evidence_count + sources.length - previousSources.length;
            this.database.query(`
                UPDATE growth_proposals
                SET observation = ?, evidence = ?, confidence = ?, evidence_count = ?,
                    source_reflections = ?, status = 'proposed', updated_at = ?
                WHERE id = ?
            `).run(
                candidate.observation.trim(),
                candidate.evidence.trim(),
                Math.max(existing.confidence, clamp(candidate.confidence)),
                evidenceCount,
                JSON.stringify(sources),
                now,
                existing.id,
            );
            return;
        }
        this.database.query(`
            INSERT INTO growth_proposals (
                id, kind, title, normalized_key, observation, evidence, confidence,
                evidence_count, source_reflections, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)
        `).run(
            randomUUID(),
            candidate.kind,
            candidate.title.trim(),
            key,
            candidate.observation.trim(),
            candidate.evidence.trim(),
            clamp(candidate.confidence),
            candidateSources.length,
            JSON.stringify(candidateSources),
            now,
            now,
        );
    }
}

/** 将 Topic 数据库行转换为公开结构 */
function toTopicRecord (row: TopicRow): TopicRecord {
    return {
        id: row.id,
        title: row.title,
        ...(row.kind && { kind: row.kind }),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/** 将成长候选数据库行转换为公开结构 */
function toGrowthProposal (row: GrowthRow): GrowthProposal {
    return {
        id: row.id,
        kind: row.kind,
        title: row.title,
        observation: row.observation,
        evidence: row.evidence,
        confidence: row.confidence,
        evidenceCount: row.evidence_count,
        status: row.status,
        updatedAt: row.updated_at,
    };
}

/** 生成稳定检索文本 */
function normalize (value: string): string {
    return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ').slice(0, 4000);
}

/** 把模型分数限制在 0 到 1 */
function clamp (value: number): number {
    return Math.max(0, Math.min(1, value));
}

/** 解析 JSON 字符串数组 */
function parseStringArray (value: string): string[] {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
    } catch {
        return [];
    }
}

/** 按原有次序去重字符串 */
function uniqueStrings (values: string[]): string[] {
    return [...new Set(values.filter(Boolean))];
}

/** 验证并返回必填文本 */
function requireText (value: string, name: string): string {
    const normalized = value.trim();
    if (!normalized) {
        throw new Error(`${name}不能为空`);
    }
    return normalized;
}

/** 规范化可选文本 */
function optionalText (value?: string): string | null {
    const normalized = value?.trim();
    return normalized ? normalized : null;
}

/** 要求 active 记忆至少引用一个真实来源事件 */
function requireSourceEventIds (values?: string[]): void {
    if (uniqueStrings(values || []).length === 0) {
        throw new Error('已确认记忆必须引用来源事件');
    }
}

/** 校验 Reflection 候选只引用本次空闲回看中的真实事件 */
function requireReflectionSources (values: string[] | undefined, allowed: Set<string>): string[] {
    const sources = uniqueStrings(values || []);
    if (sources.length === 0 || sources.some(id => !allowed.has(id))) {
        throw new Error('Reflection 候选必须引用本批真实事件');
    }
    return sources;
}

/** 验证时间并统一为 UTC ISO */
function normalizeTime (value: string, name: string): string {
    const normalized = value.trim();
    const timestamp = Date.parse(normalized);
    if (!normalized || !isStrictTimeText(normalized) || Number.isNaN(timestamp)) {
        throw new Error(`${name}无效`);
    }
    return new Date(timestamp).toISOString();
}

/** 验证时间区间先后关系 */
function assertOrderedInterval (from: string | undefined, to: string | undefined, name: string): void {
    if (from && to && Date.parse(to) < Date.parse(from)) {
        throw new Error(`${name}结束时间早于开始时间`);
    }
}

/** 验证并返回 YYYY-MM-DD 本地日期 */
function normalizeLocalDate (value: string): string {
    const normalized = value.trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
    if (!match || !isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
        throw new Error('事件 localDate 无效');
    }
    return normalized;
}

/** 验证 IANA 时区，省略时使用 UTC */
function normalizeTimezone (value?: string): string {
    const timezone = optionalText(value) || 'UTC';
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
    } catch {
        throw new Error('事件 timezone 必须是有效的 IANA 时区');
    }
    return timezone;
}

/** 按指定 IANA 时区计算事件本地日期 */
function deriveLocalDate (value: string, timezone: string): string {
    const normalized = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
        return normalizeLocalDate(normalized);
    }
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date(value));
    const values = new Map(parts.map(part => [part.type, part.value]));
    return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
}

/** 验证并返回 MM-DD 日历日期 */
function normalizeMonthDay (value: string): string {
    const normalized = value.trim();
    const match = /^(\d{2})-(\d{2})$/.exec(normalized);
    if (!match || !isValidCalendarDate(2024, Number(match[1]), Number(match[2]))) {
        throw new Error('calendarMonthDay 必须是有效的 MM-DD');
    }
    return normalized;
}

/**
 * 验证时间文本是日期或携带明确 offset 的 ISO 时间
 *
 * @param value 待解析时间文本
 * @returns 文本格式、日期和时间均有效时返回 true
 */
function isStrictTimeText (value: string): boolean {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (dateOnly) {
        return isValidCalendarDate(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]));
    }
    const dateTime = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.exec(value);
    if (!dateTime
        || !isValidCalendarDate(Number(dateTime[1]), Number(dateTime[2]), Number(dateTime[3]))) {
        return false;
    }
    const hour = Number(dateTime[4]);
    const minute = Number(dateTime[5]);
    const second = Number(dateTime[6] || 0);
    return hour <= 23 && minute <= 59 && second <= 59;
}

/**
 * 验证一个公历年月日组合
 *
 * @param year 公历年份
 * @param month 月份
 * @param day 日期
 * @returns 该日期真实存在时返回 true
 */
function isValidCalendarDate (year: number, month: number, day: number): boolean {
    if (month < 1 || month > 12 || day < 1) {
        return false;
    }
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day <= daysInMonth[month - 1]!;
}

/** 安全序列化事件负载 */
function serializeJson (value: unknown): string {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
        throw new Error('事件 payload 无法序列化');
    }
    return serialized;
}

/** 解析持久化的事件负载 */
function parseJson (value: string): unknown {
    return JSON.parse(value);
}

/** 生成参数化 IN 查询占位符 */
function placeholders (count: number): string {
    return Array.from({ length: count }, () => '?').join(', ');
}

/** 限制公开查询的返回数量 */
function boundedLimit (value: number, maximum: number): number {
    return Math.max(1, Math.min(Math.floor(value), maximum));
}

/** 判断两个标识集合是否相交 */
function intersects (left: string[], right: string[]): boolean {
    const rightSet = new Set(right);
    return left.some(value => rightSet.has(value));
}

/** FTS 负分越小越相关；Topic 命中在直接文本命中之后 */
function compareSearchRank (left: { search_rank?: number }, right: { search_rank?: number }): number {
    return (left.search_rank ?? 0) - (right.search_rank ?? 0);
}

/** 按发生时间和稳定序号排序事件 */
function compareEvents (left: EventRow, right: EventRow): number {
    return left.occurred_from.localeCompare(right.occurred_from) || left.seq - right.seq;
}

/** 按现实时间和认知时间排序记忆 */
function compareMemories (left: MemoryRow, right: MemoryRow): number {
    return (left.valid_from || left.known_from).localeCompare(right.valid_from || right.known_from)
        || left.known_from.localeCompare(right.known_from);
}

/** 判断文本是否匹配完整查询或足够多的中英文片段 */
function textMatchesQuery (text: string, query: string): boolean {
    const normalizedText = normalize(text);
    const normalizedQuery = normalize(query);
    if (!normalizedQuery) {
        return true;
    }
    if (normalizedText.includes(normalizedQuery) || normalizedQuery.includes(normalizedText)) {
        return true;
    }
    const fragments = queryFragments(normalizedQuery);
    const matches = fragments.filter(fragment => normalizedText.includes(fragment)).length;
    return hasEnoughFragmentMatches(matches, fragments.length);
}

/** 提取英文词与连续中文的双字片段 */
function queryFragments (query: string): string[] {
    const normalized = normalize(query);
    const words = normalized.match(/[a-z0-9]{2,}/g) || [];
    const cjkBigrams = [...normalized.matchAll(/[\p{Script=Han}]+/gu)]
        .flatMap(match => {
            const characters = [...match[0]];
            return characters.length === 1
                ? characters
                : characters.slice(0, -1).map((character, index) => `${character}${characters[index + 1]}`);
        });
    return uniqueStrings([...words, ...cjkBigrams]);
}

/** 要求至少命中一个短查询，较长查询则命中一半且不少于两个片段 */
function hasEnoughFragmentMatches (matches: number, fragmentCount: number): boolean {
    if (fragmentCount === 0) {
        return false;
    }
    const required = fragmentCount === 1 ? 1 : Math.max(2, Math.ceil(fragmentCount / 2));
    return matches >= required;
}

/** 截断注入上下文的原始事件内容 */
function truncate (value: string, maximum: number): string {
    return value.length <= maximum ? value : `${value.slice(0, maximum - 16)}...[truncated]`;
}
