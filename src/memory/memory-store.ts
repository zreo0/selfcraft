import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';

/** 可持久记忆的语义类型 */
export type MemoryKind = 'identity' | 'user' | 'preference' | 'relationship' | 'commitment' | 'procedure' | 'experience';

/** Reflection 产生的记忆候选 */
export interface MemoryCandidate {
    /** 记忆类型 */
    kind: MemoryKind;
    /** 独立、可理解的事实或经验 */
    content: string;
    /** 内容可信度 */
    confidence: number;
    /** 对未来互动的重要性 */
    importance: number;
    /** 是否包含不应自动持久化的敏感信息 */
    sensitive: boolean;
}

/** Reflection 产生的成长候选 */
export interface GrowthCandidate {
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
}

/** 一次 Reflection 的结构化结果 */
export interface ReflectionResult {
    /** 值得长期保留的记忆 */
    memories: MemoryCandidate[];
    /** 需要继续积累证据的技能或 Runtime 改进候选 */
    growth: GrowthCandidate[];
}

/** 需要被后台反思的一次交互 */
export interface ReflectionInput {
    /** 交互所属会话或任务 */
    sessionId: string;
    /** 用户输入或后台任务目标 */
    input: string;
    /** 智能体的最终输出 */
    output: string;
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

/** 对 Agent 可见的长期记忆 */
export interface MemoryItem {
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
    /** 支持该记忆的独立证据数 */
    evidenceCount: number;
    /** 记忆状态 */
    status: 'candidate' | 'active' | 'forgotten';
    /** 最后更新时间 */
    updatedAt: string;
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

interface MemoryRow {
    id: string;
    kind: MemoryKind;
    content: string;
    normalized_content: string;
    confidence: number;
    importance: number;
    evidence_count: number;
    sources: string;
    status: MemoryItem['status'];
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
    session_id: string;
    input: string;
    output: string;
    outcome: ReflectionInput['outcome'];
    error: string | null;
    reflection_output: string | null;
    reflection_error: string | null;
    attempts: number;
}

const MAX_CONTEXT_MEMORIES = 24;
const MAX_CONTEXT_GROWTH = 8;

/** 使用 SQLite 保存可追溯记忆、Reflection 队列与成长候选 */
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
        this.database.run('PRAGMA journal_mode = WAL');
        this.database.run('PRAGMA busy_timeout = 5000');
        this.migrate();
    }

    /**
     * 把交互追加到持久 Reflection 队列
     *
     * @param input 交互内容与结果
     * @returns Reflection 标识
     */
    public enqueueReflection (input: ReflectionInput): string {
        const id = randomUUID();
        const now = new Date().toISOString();
        this.database.query(`
            INSERT INTO reflection_jobs (
                id, session_id, input, output, outcome, error, status, attempts, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)
        `).run(id, input.sessionId, input.input, input.output, input.outcome, input.error || null, now, now);
        return id;
    }

    /**
     * 原子领取一条待处理 Reflection
     *
     * @returns 当前队列项，队列为空时返回 null
     */
    public claimReflection (): ReflectionJob | null {
        const claim = this.database.transaction(() => {
            const row = this.database.query(`
                SELECT id, session_id, input, output, outcome, error,
                    reflection_output, reflection_error, attempts
                FROM reflection_jobs
                WHERE status = 'queued'
                ORDER BY created_at ASC
                LIMIT 1
            `).get() as ReflectionRow | null;
            if (!row) {
                return null;
            }
            this.database.query(`
                UPDATE reflection_jobs
                SET status = 'running', attempts = attempts + 1, updated_at = ?
                WHERE id = ? AND status = 'queued'
            `).run(new Date().toISOString(), row.id);
            return {
                id: row.id,
                sessionId: row.session_id,
                input: row.input,
                output: row.output,
                outcome: row.outcome,
                ...(row.error && { error: row.error }),
                attempts: row.attempts + 1,
                ...(row.reflection_output && { previousOutput: row.reflection_output }),
                ...(row.reflection_error && { previousError: row.reflection_error }),
            } satisfies ReflectionJob;
        });
        return claim.immediate();
    }

    /**
     * 提交 Reflection 结果并去重累积证据
     *
     * @param jobId Reflection 标识
     * @param result 结构化结果
     */
    public completeReflection (jobId: string, result: ReflectionResult): void {
        const commit = this.database.transaction(() => {
            for (const memory of result.memories) {
                if (memory.sensitive || memory.content.trim().length < 4) {
                    continue;
                }
                this.upsertMemory(memory, `reflection:${jobId}`);
            }
            for (const growth of result.growth) {
                if (growth.confidence < 0.5 || growth.title.trim().length < 4) {
                    continue;
                }
                this.upsertGrowth(growth, jobId);
            }
            this.database.query(`
                UPDATE reflection_jobs
                SET status = 'completed', updated_at = ?,
                    reflection_output = NULL, reflection_error = NULL
                WHERE id = ?
            `).run(new Date().toISOString(), jobId);
        });
        commit.immediate();
    }

    /**
     * 记录 Reflection 失败，最多自动尝试三次
     *
     * @param jobId Reflection 标识
     * @param error 失败信息
     * @param output 本次无效的模型输出
     */
    public failReflection (jobId: string, error: string, output = ''): void {
        this.database.query(`
            UPDATE reflection_jobs
            SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'queued' END,
                reflection_error = ?, reflection_output = ?, updated_at = ?
            WHERE id = ?
        `).run(error.slice(0, 4000), output.slice(0, 30000), new Date().toISOString(), jobId);
    }

    /** 将崩溃时留下的 running Reflection 放回队列 */
    public recoverReflections (): void {
        this.database.query(`
            UPDATE reflection_jobs
            SET status = 'queued', updated_at = ?
            WHERE status = 'running'
        `).run(new Date().toISOString());
    }

    /**
     * 显式保存一条已确认记忆
     *
     * @param candidate 记忆内容
     * @param source 记忆来源
     * @returns 保存后的记忆
     */
    public remember (candidate: Omit<MemoryCandidate, 'sensitive'>, source = 'agent'): MemoryItem {
        return this.upsertMemory({ ...candidate, sensitive: false }, source, true);
    }

    /**
     * 按内容检索长期记忆
     *
     * @param query 检索文本
     * @param limit 最多返回数
     * @returns 按相关性和重要性排列的记忆
     */
    public search (query = '', limit = 20): MemoryItem[] {
        const rows = this.database.query(`
            SELECT id, kind, content, normalized_content, confidence, importance,
                evidence_count, sources, status, updated_at
            FROM memory_items
            WHERE status IN ('active', 'candidate')
            ORDER BY status = 'active' DESC, importance DESC, updated_at DESC
            LIMIT 500
        `).all() as MemoryRow[];
        const normalizedQuery = normalize(query);
        return rows.map(row => ({
            item: toMemoryItem(row),
            score: scoreMemory(row, normalizedQuery),
        })).filter(entry => !normalizedQuery || entry.score > 0)
            .sort((left, right) => right.score - left.score || right.item.importance - left.item.importance)
            .slice(0, Math.max(1, Math.min(limit, 100)))
            .map(entry => entry.item);
    }

    /**
     * 忘记一条指定记忆
     *
     * @param id 记忆标识
     * @returns 是否存在且已忘记
     */
    public forget (id: string): boolean {
        const result = this.database.query(`
            UPDATE memory_items SET status = 'forgotten', updated_at = ?
            WHERE id = ? AND status != 'forgotten'
        `).run(new Date().toISOString(), id);
        return result.changes > 0;
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
            `).all(status, limit) as GrowthRow[]
            : this.database.query(`
                SELECT id, kind, title, observation, evidence, confidence, evidence_count, status, updated_at
                FROM growth_proposals
                ORDER BY status = 'proposed' DESC, evidence_count DESC, confidence DESC, updated_at DESC LIMIT ?
            `).all(limit) as GrowthRow[];
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
     * 为当前交互构建有界的记忆与成长上下文
     *
     * @param query 当前用户输入或任务
     * @returns 可注入系统提示的 Markdown
     */
    public buildContext (query: string): string {
        const memories = this.search(query, MAX_CONTEXT_MEMORIES).filter(item => item.status === 'active');
        const fallback = memories.length < 6
            ? this.search('', MAX_CONTEXT_MEMORIES).filter(item => item.status === 'active')
            : memories;
        const unique = [...new Map([...memories, ...fallback].map(item => [item.id, item])).values()]
            .slice(0, MAX_CONTEXT_MEMORIES);
        const growth = this.listGrowth('proposed', 50)
            .filter(item => item.evidenceCount >= 2 || item.confidence >= 0.85)
            .slice(0, MAX_CONTEXT_GROWTH);
        return [
            '<structured-memory>',
            unique.length > 0
                ? unique.map(item => `- [${item.id}] (${item.kind}, evidence=${item.evidenceCount}) ${item.content}`).join('\n')
                : '尚无结构化长期记忆',
            '</structured-memory>',
            '',
            '<growth-proposals>',
            growth.length > 0
                ? growth.map(item => `- [${item.id}] (${item.kind}, evidence=${item.evidenceCount}) ${item.title}: ${item.observation}`).join('\n')
                : '尚无待评估的成长候选',
            '</growth-proposals>',
        ].join('\n');
    }

    /** 初始化最小数据表 */
    private migrate (): void {
        this.database.run(`
            CREATE TABLE IF NOT EXISTS reflection_jobs (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                input TEXT NOT NULL,
                output TEXT NOT NULL,
                outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed')),
                error TEXT,
                reflection_output TEXT,
                reflection_error TEXT,
                status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
                attempts INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS reflection_jobs_queue
                ON reflection_jobs(status, created_at);
            CREATE TABLE IF NOT EXISTS memory_items (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                content TEXT NOT NULL,
                normalized_content TEXT NOT NULL,
                confidence REAL NOT NULL,
                importance REAL NOT NULL,
                evidence_count INTEGER NOT NULL DEFAULT 1,
                sources TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('candidate', 'active', 'forgotten')),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(kind, normalized_content)
            );
            CREATE INDEX IF NOT EXISTS memory_items_context
                ON memory_items(status, importance DESC, updated_at DESC);
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
        this.ensureColumn('reflection_jobs', 'reflection_output');
        this.ensureColumn('reflection_jobs', 'reflection_error');
    }

    /** 为已存在的早期数据库补齐 Reflection 修复字段 */
    private ensureColumn (table: string, column: string): void {
        const columns = this.database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        if (!columns.some(item => item.name === column)) {
            this.database.run(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
        }
    }

    /** 提交或增强一条记忆 */
    private upsertMemory (
        candidate: MemoryCandidate,
        source: string,
        confirmed = false,
    ): MemoryItem {
        const normalized = normalize(candidate.content);
        const existing = this.database.query(`
            SELECT id, kind, content, normalized_content, confidence, importance,
                evidence_count, sources, status, updated_at
            FROM memory_items WHERE kind = ? AND normalized_content = ?
        `).get(candidate.kind, normalized) as MemoryRow | null;
        const now = new Date().toISOString();
        if (existing) {
            const sources = uniqueStrings([...parseStringArray(existing.sources), source]);
            const evidenceCount = existing.evidence_count + (sources.length > parseStringArray(existing.sources).length ? 1 : 0);
            const status = confirmed || existing.status === 'active' || evidenceCount >= 2 || candidate.confidence >= 0.82
                ? 'active'
                : 'candidate';
            this.database.query(`
                UPDATE memory_items
                SET content = ?, confidence = ?, importance = ?, evidence_count = ?,
                    sources = ?, status = ?, updated_at = ?
                WHERE id = ?
            `).run(
                candidate.content.trim(),
                Math.max(existing.confidence, candidate.confidence),
                Math.max(existing.importance, candidate.importance),
                evidenceCount,
                JSON.stringify(sources),
                status,
                now,
                existing.id,
            );
            return {
                ...toMemoryItem(existing),
                content: candidate.content.trim(),
                confidence: Math.max(existing.confidence, candidate.confidence),
                importance: Math.max(existing.importance, candidate.importance),
                evidenceCount,
                status,
                updatedAt: now,
            };
        }
        const id = randomUUID();
        const status = confirmed || candidate.confidence >= 0.82 ? 'active' : 'candidate';
        this.database.query(`
            INSERT INTO memory_items (
                id, kind, content, normalized_content, confidence, importance,
                evidence_count, sources, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
        `).run(
            id,
            candidate.kind,
            candidate.content.trim(),
            normalized,
            clamp(candidate.confidence),
            clamp(candidate.importance),
            JSON.stringify([source]),
            status,
            now,
            now,
        );
        return {
            id,
            kind: candidate.kind,
            content: candidate.content.trim(),
            confidence: clamp(candidate.confidence),
            importance: clamp(candidate.importance),
            evidenceCount: 1,
            status,
            updatedAt: now,
        };
    }

    /** 提交或增强一条成长候选 */
    private upsertGrowth (candidate: GrowthCandidate, reflectionId: string): void {
        const key = normalize(candidate.title);
        const existing = this.database.query(`
            SELECT id, kind, title, observation, evidence, confidence,
                evidence_count, status, updated_at, source_reflections
            FROM growth_proposals WHERE kind = ? AND normalized_key = ?
        `).get(candidate.kind, key) as (GrowthRow & { source_reflections: string }) | null;
        const now = new Date().toISOString();
        if (existing) {
            const sources = uniqueStrings([...parseStringArray(existing.source_reflections), reflectionId]);
            const evidenceCount = existing.evidence_count + (
                sources.length > parseStringArray(existing.source_reflections).length ? 1 : 0
            );
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
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'proposed', ?, ?)
        `).run(
            randomUUID(),
            candidate.kind,
            candidate.title.trim(),
            key,
            candidate.observation.trim(),
            candidate.evidence.trim(),
            clamp(candidate.confidence),
            JSON.stringify([reflectionId]),
            now,
            now,
        );
    }
}

/** 将记忆行转为公开结构 */
function toMemoryItem (row: MemoryRow): MemoryItem {
    return {
        id: row.id,
        kind: row.kind,
        content: row.content,
        confidence: row.confidence,
        importance: row.importance,
        evidenceCount: row.evidence_count,
        status: row.status,
        updatedAt: row.updated_at,
    };
}

/** 将成长行转为公开结构 */
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

/** 生成稳定去重文本 */
function normalize (value: string): string {
    return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ').slice(0, 2000);
}

/** 把模型分数限制在 0 到 1 */
function clamp (value: number): number {
    return Math.max(0, Math.min(1, value));
}

/** 安全解析字符串数组 */
function parseStringArray (value: string): string[] {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
    } catch {
        return [];
    }
}

/** 按原有次序去重 */
function uniqueStrings (values: string[]): string[] {
    return [...new Set(values)];
}

/** 使用简单文本匹配计算无向量依赖的召回分数 */
function scoreMemory (row: MemoryRow, query: string): number {
    const base = row.importance * 2 + row.confidence + Math.min(row.evidence_count, 3) * 0.2;
    if (!query) {
        return base;
    }
    if (row.normalized_content.includes(query) || query.includes(row.normalized_content)) {
        return base + 5;
    }
    const words = query.match(/[A-Za-z0-9]{2,}/g) || [];
    const cjk = [...query.replace(/[^\p{Script=Han}]/gu, '')];
    const cjkBigrams = cjk.slice(0, -1).map((character, index) => `${character}${cjk[index + 1]}`);
    const fragments = uniqueStrings([...words, ...cjkBigrams]);
    const matches = fragments.filter(fragment => row.normalized_content.includes(fragment)).length;
    return matches > 0 ? base + matches : 0;
}
