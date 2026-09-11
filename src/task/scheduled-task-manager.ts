import { assertStateVersion } from '../supervisor/state-version';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import type { EventInput } from '../memory/memory-store';
import type { NotificationInbox } from '../notification/notification-inbox';

/** 一次性定时提醒状态 */
export type ScheduledTaskStatus = 'scheduled' | 'running' | 'completed' | 'cancelled' | 'failed';

/** 创建一次性定时提醒的输入 */
export interface CreateScheduledTaskInput {
    /** 通知标题 */
    title: string;
    /** 通知正文 */
    message: string;
    /** 标准化后的绝对到期时间 */
    dueAt: string;
    /** 解释原始时间表达式时使用的 IANA 时区 */
    timezone: string;
    /** 用户给出的原始时间表达式 */
    originalExpression: string;
    /** 外部工具调用的稳定幂等键 */
    idempotencyKey?: string;
    /** 创建提醒的来源事件 */
    sourceEventId?: string;
    /** 创建提醒的 Agent 运行 */
    runId?: string;
    /** 提醒相关的长期 Topic */
    topicIds?: string[];
}

/** 修改提醒时由 Runtime 注入的可信事件上下文 */
export interface ScheduledTaskOperationContext {
    /** 当前 Agent 运行 */
    runId?: string;
    /** 触发当前操作的来源事件 */
    sourceEventId?: string;
    /** 当前用户时区 */
    timezone?: string;
    /** 当前操作相关的 Topic */
    topicIds?: string[];
}

/** 已持久化的一次性定时提醒 */
export interface ScheduledTaskRecord {
    /** 提醒标识 */
    id: string;
    /** 通知标题 */
    title: string;
    /** 通知正文 */
    message: string;
    /** UTC 格式的绝对到期时间 */
    dueAt: string;
    /** 解释原始时间表达式时使用的 IANA 时区 */
    timezone: string;
    /** 用户给出的原始时间表达式 */
    originalExpression: string;
    /** 创建提醒的来源事件 */
    sourceEventId?: string;
    /** 创建提醒的 Agent 运行 */
    runId?: string;
    /** 提醒相关的长期 Topic */
    topicIds: string[];
    /** 当前状态 */
    status: ScheduledTaskStatus;
    /** 用于避免重复通知的稳定标识 */
    notificationId: string;
    /** 最后失败原因 */
    error?: string;
    /** 创建时间 */
    createdAt: string;
    /** 开始触发时间 */
    startedAt?: string;
    /** 进入终态的时间 */
    completedAt?: string;
    /** 最后更新时间 */
    updatedAt: string;
}

/** 定时提醒写入 Memory 时间线所需的最小接口 */
export interface ScheduledTaskEventStore {
    /**
     * 写入一条可幂等的生命周期事件
     *
     * @param event 生命周期事件
     * @returns 已保存事件
     */
    recordEvent (event: EventInput): { id: string };
}

type ScheduledTaskEventType =
    | 'task_created'
    | 'task_triggered'
    | 'task_completed'
    | 'task_cancelled'
    | 'task_failed';

interface ScheduledTaskRow {
    id: string;
    title: string;
    message: string;
    due_at: string;
    timezone: string;
    original_expression: string;
    idempotency_key: string | null;
    source_event_id: string | null;
    run_id: string | null;
    topic_ids: string;
    status: ScheduledTaskStatus;
    notification_id: string;
    error: string | null;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
    updated_at: string;
}

/** 使用 SQLite 持久化并触发一次性提醒 */
export class ScheduledTaskManager {
    private readonly database: Database;
    private readonly scanIntervalMs: number;
    private timer?: ReturnType<typeof setInterval>;
    private started = false;

    /**
     * 创建一次性定时提醒管理器
     *
     * @param databasePath 与 MemoryStore 共用的 SQLite 路径
     * @param notifications 持久通知收件箱
     * @param memory 生命周期事件存储边界
     * @param scanIntervalMs 到期任务扫描间隔
     */
    constructor (
        databasePath: string,
        private readonly notifications: NotificationInbox,
        private readonly memory: ScheduledTaskEventStore,
        scanIntervalMs = 1000,
    ) {
        fs.mkdirSync(path.dirname(databasePath), { recursive: true });
        this.database = new Database(databasePath, { create: true });
        assertStateVersion(this.database);
        this.database.run('PRAGMA journal_mode = WAL');
        this.database.run('PRAGMA busy_timeout = 5000');
        this.scanIntervalMs = Math.max(50, Math.trunc(scanIntervalMs));
        this.migrate();
    }

    /**
     * 创建并持久化一条一次性提醒
     *
     * @param input 提醒内容、到期时间与来源
     * @returns 已创建提醒
     */
    public create (input: CreateScheduledTaskInput): ScheduledTaskRecord {
        const title = requireText(input.title, '提醒标题');
        const message = requireText(input.message, '提醒正文');
        const dueAt = normalizeDate(input.dueAt, '提醒到期时间');
        const timezone = normalizeTimezone(input.timezone);
        const originalExpression = requireText(input.originalExpression, '原始时间表达式');
        const idempotencyKey = input.idempotencyKey?.trim() || null;
        if (idempotencyKey) {
            const existing = this.database.query(`
                SELECT * FROM scheduled_tasks WHERE idempotency_key = ?
            `).get(idempotencyKey) as ScheduledTaskRow | null;
            if (existing) {
                return toScheduledTaskRecord(existing);
            }
        }
        const id = randomUUID();
        const sourceEventId = input.sourceEventId?.trim() || null;
        const runId = input.runId?.trim() || null;
        const topicIds = uniqueText(input.topicIds || []);
        const notificationId = `scheduled-task:${id}`;
        const now = new Date().toISOString();
        this.database.query(`
            INSERT INTO scheduled_tasks (
                id, title, message, due_at, timezone, original_expression,
                idempotency_key, source_event_id, run_id, topic_ids, status, notification_id,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)
        `).run(
            id,
            title,
            message,
            dueAt,
            timezone,
            originalExpression,
            idempotencyKey,
            sourceEventId,
            runId,
            JSON.stringify(topicIds),
            notificationId,
            now,
            now,
        );
        const task = this.get(id)!;
        try {
            this.recordLifecycle(task, 'task_created', 'scheduled', now);
        } catch (error) {
            this.database.query('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
            throw error;
        }
        if (this.started) {
            this.runDue();
        }
        return this.get(id) || task;
    }

    /**
     * 列出到期时间最近的提醒
     *
     * @param limit 最多返回数量
     * @returns 按到期时间排列的提醒
     */
    public list (limit = 100): ScheduledTaskRecord[] {
        const rows = this.database.query(`
            SELECT * FROM scheduled_tasks
            ORDER BY status IN ('scheduled', 'running') DESC, due_at ASC, created_at ASC
            LIMIT ?
        `).all(Math.max(1, Math.min(Math.trunc(limit), 500))) as ScheduledTaskRow[];
        return rows.map(toScheduledTaskRecord);
    }

    /**
     * 查询一条定时提醒
     *
     * @param id 提醒标识
     * @returns 提醒不存在时返回 null
     */
    public get (id: string): ScheduledTaskRecord | null {
        const row = this.database.query('SELECT * FROM scheduled_tasks WHERE id = ?')
            .get(id) as ScheduledTaskRow | null;
        return row ? toScheduledTaskRecord(row) : null;
    }

    /**
     * 取消一条尚未触发的提醒
     *
     * @param id 提醒标识
     * @param context 当前操作的可信来源
     * @returns 是否成功取消
     */
    public cancel (id: string, context: ScheduledTaskOperationContext = {}): boolean {
        const task = this.get(id);
        if (!task || task.status !== 'scheduled') {
            return false;
        }
        const now = new Date().toISOString();
        const result = this.database.query(`
            UPDATE scheduled_tasks
            SET status = 'cancelled', completed_at = ?, updated_at = ?
            WHERE id = ? AND status = 'scheduled'
        `).run(now, now, id);
        if (result.changes === 0) {
            return false;
        }
        try {
            this.recordLifecycle(task, 'task_cancelled', 'cancelled', now, context);
        } catch (error) {
            this.database.query(`
                UPDATE scheduled_tasks
                SET status = 'scheduled', completed_at = NULL, updated_at = ?
                WHERE id = ? AND status = 'cancelled'
            `).run(new Date().toISOString(), id);
            throw error;
        }
        return true;
    }

    /** 恢复异常中断的提醒并开始扫描到期任务 */
    public start (): void {
        if (this.started) {
            return;
        }
        this.started = true;
        try {
            this.recoverRunning();
            this.runDue();
        } catch (error) {
            this.started = false;
            throw error;
        }
        this.timer = setInterval(() => this.runDue(), this.scanIntervalMs);
        this.timer.unref();
    }

    /** 停止扫描到期任务 */
    public stop (): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this.started = false;
    }

    /**
     * 领取并执行给定时间之前到期的全部提醒
     *
     * @param now 本轮扫描截止时间
     * @returns 本轮领取的提醒数量
     */
    public runDue (now = new Date()): number {
        if (Number.isNaN(now.getTime())) {
            throw new Error('扫描截止时间无效');
        }
        const cutoff = now.toISOString();
        let count = 0;
        while (true) {
            const task = this.claimDue(cutoff);
            if (!task) {
                return count;
            }
            count += 1;
            this.deliver(task);
        }
    }

    /** 初始化定时提醒表 */
    private migrate (): void {
        this.database.run(`
            CREATE TABLE IF NOT EXISTS scheduled_tasks (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                due_at TEXT NOT NULL,
                timezone TEXT NOT NULL,
                original_expression TEXT NOT NULL,
                idempotency_key TEXT UNIQUE,
                source_event_id TEXT,
                run_id TEXT,
                topic_ids TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('scheduled', 'running', 'completed', 'cancelled', 'failed')),
                notification_id TEXT NOT NULL UNIQUE,
                error TEXT,
                created_at TEXT NOT NULL,
                started_at TEXT,
                completed_at TEXT,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS scheduled_tasks_due
                ON scheduled_tasks(status, due_at);
        `);
    }

    /** 将 Runtime 中断时残留的 running 提醒恢复为可重试状态 */
    private recoverRunning (): void {
        this.database.query(`
            UPDATE scheduled_tasks
            SET status = 'scheduled', started_at = NULL, error = NULL, updated_at = ?
            WHERE status = 'running'
        `).run(new Date().toISOString());
    }

    /**
     * 原子领取一条到期提醒
     *
     * @param cutoff 截止时间
     * @returns 已转为 running 的提醒，暂无任务时返回 null
     */
    private claimDue (cutoff: string): ScheduledTaskRecord | null {
        const claim = this.database.transaction(() => {
            const row = this.database.query(`
                SELECT * FROM scheduled_tasks
                WHERE status = 'scheduled' AND due_at <= ?
                ORDER BY due_at ASC, created_at ASC
                LIMIT 1
            `).get(cutoff) as ScheduledTaskRow | null;
            if (!row) {
                return null;
            }
            const now = new Date().toISOString();
            const result = this.database.query(`
                UPDATE scheduled_tasks
                SET status = 'running', started_at = ?, updated_at = ?
                WHERE id = ? AND status = 'scheduled'
            `).run(now, now, row.id);
            return result.changes > 0
                ? {
                    ...toScheduledTaskRecord(row),
                    status: 'running' as const,
                    startedAt: now,
                    updatedAt: now,
                }
                : null;
        });
        return claim.immediate();
    }

    /**
     * 推送提醒并完成对应生命周期
     *
     * @param task 已领取的提醒
     */
    private deliver (task: ScheduledTaskRecord): void {
        try {
            this.notifications.pushOnce(task.notificationId, task.title, task.message);
        } catch (error) {
            this.fail(task, error);
            return;
        }
        const triggeredAt = new Date().toISOString();
        const completedAt = new Date().toISOString();
        this.database.query(`
            UPDATE scheduled_tasks
            SET status = 'completed', completed_at = ?, error = NULL, updated_at = ?
            WHERE id = ? AND status = 'running'
        `).run(completedAt, completedAt, task.id);
        for (const lifecycle of [
            { type: 'task_triggered', status: 'running', occurredAt: triggeredAt },
            { type: 'task_completed', status: 'completed', occurredAt: completedAt },
        ] as const) {
            try {
                this.recordLifecycle(task, lifecycle.type, lifecycle.status, lifecycle.occurredAt);
            } catch {
                // 通知与 Task 状态是主结果，审计 Event 失败不能改写投递事实
            }
        }
    }

    /**
     * 将触发异常写入任务状态与时间线
     *
     * @param task 失败提醒
     * @param error 失败原因
     */
    private fail (task: ScheduledTaskRecord, error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        const now = new Date().toISOString();
        this.database.query(`
            UPDATE scheduled_tasks
            SET status = 'failed', error = ?, completed_at = ?, updated_at = ?
            WHERE id = ? AND status = 'running'
        `).run(message.slice(0, 4000), now, now, task.id);
        try {
            this.recordLifecycle(task, 'task_failed', 'failed', now, {}, message.slice(0, 1000));
        } catch {
            // Task 已准确记录投递失败，审计 Event 不影响主状态
        }
    }

    /**
     * 写入一条幂等的提醒生命周期事件
     *
     * @param task 关联提醒
     * @param type 生命周期事件类型
     * @param status 事件对应的提醒状态
     * @param occurredAt 事件发生时间
     * @param context 当前操作的可信来源
     * @param error 失败原因
     */
    private recordLifecycle (
        task: ScheduledTaskRecord,
        type: ScheduledTaskEventType,
        status: ScheduledTaskStatus,
        occurredAt: string,
        context: ScheduledTaskOperationContext = {},
        error?: string,
    ): void {
        const sourceEventId = context.sourceEventId?.trim()
            || (type === 'task_created' ? task.sourceEventId : undefined);
        const runId = context.runId?.trim()
            || (type === 'task_created' ? task.runId : undefined);
        const timezone = context.timezone?.trim() || task.timezone;
        const topicIds = uniqueText([...task.topicIds, ...(context.topicIds || [])]);
        this.memory.recordEvent({
            type,
            actor: 'system',
            payload: {
                title: task.title,
                message: task.message,
                dueAt: task.dueAt,
                timezone: task.timezone,
                originalExpression: task.originalExpression,
                notificationId: task.notificationId,
                status,
                ...(error && { error }),
            },
            occurredFrom: occurredAt,
            recordedAt: occurredAt,
            timezone,
            taskId: task.id,
            ...(runId && { runId }),
            ...(sourceEventId && { sourceEventId }),
            topicIds,
            idempotencyKey: `scheduled-task:${task.id}:${type}`,
        });
    }
}

/**
 * 将数据库行转换为公开提醒结构
 *
 * @param row SQLite 提醒行
 * @returns 定时提醒
 */
function toScheduledTaskRecord (row: ScheduledTaskRow): ScheduledTaskRecord {
    return {
        id: row.id,
        title: row.title,
        message: row.message,
        dueAt: row.due_at,
        timezone: row.timezone,
        originalExpression: row.original_expression,
        ...(row.source_event_id && { sourceEventId: row.source_event_id }),
        ...(row.run_id && { runId: row.run_id }),
        topicIds: parseTopicIds(row.topic_ids),
        status: row.status,
        notificationId: row.notification_id,
        ...(row.error && { error: row.error }),
        createdAt: row.created_at,
        ...(row.started_at && { startedAt: row.started_at }),
        ...(row.completed_at && { completedAt: row.completed_at }),
        updatedAt: row.updated_at,
    };
}

/**
 * 校验必填文本
 *
 * @param value 原始文本
 * @param label 错误字段名称
 * @returns 去除首尾空白后的文本
 */
function requireText (value: string, label: string): string {
    const normalized = value.trim();
    if (!normalized) {
        throw new Error(`${label}不能为空`);
    }
    return normalized;
}

/**
 * 标准化绝对时间
 *
 * @param value 可由 Date 解析的时间文本
 * @param label 错误字段名称
 * @returns UTC ISO 时间
 */
function normalizeDate (value: string, label: string): string {
    const normalized = value.trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.exec(normalized);
    if (!match) {
        throw new Error(`${label}必须是包含时区的绝对 ISO 时间`);
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6] || 0);
    const timestamp = Date.parse(normalized);
    if (!isValidCalendarDate(year, month, day)
        || hour > 23
        || minute > 59
        || second > 59
        || !Number.isFinite(timestamp)) {
        throw new Error(`${label}无效`);
    }
    return new Date(timestamp).toISOString();
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

/**
 * 校验并标准化 IANA 时区
 *
 * @param value 原始时区
 * @returns 可供 Intl 使用的时区
 */
function normalizeTimezone (value: string): string {
    const timezone = requireText(value, '提醒时区');
    try {
        new Intl.DateTimeFormat('zh-CN', { timeZone: timezone }).format(0);
    } catch {
        throw new Error('提醒时区无效');
    }
    return timezone;
}

/**
 * 清理并去重文本列表
 *
 * @param values 原始文本列表
 * @returns 保留原始顺序的非空唯一文本
 */
function uniqueText (values: string[]): string[] {
    return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

/**
 * 解析持久化 Topic 标识
 *
 * @param value JSON 文本
 * @returns Topic 标识列表
 */
function parseTopicIds (value: string): string[] {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string')
        : [];
}
