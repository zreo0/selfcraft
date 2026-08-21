import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Database } from 'bun:sqlite';
import type { Logger } from '../logging/logger';
import type { NotificationInbox } from '../notification/notification-inbox';
import type { PathGuard } from '../tools/path-guard';
import { assertSafeShellCommand } from '../tools/shell-tool';

/** 后台任务类型 */
export type JobType = 'agent' | 'shell';

/** 后台任务状态 */
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

/** Agent 后台任务输入 */
export interface AgentJobPayload {
    /** 需要独立完成的目标 */
    prompt: string;
}

/** Shell 后台任务输入 */
export interface ShellJobPayload {
    /** Shell 命令 */
    command: string;
    /** workspace 相对工作目录 */
    cwd: string;
}

/** 可持久化后台任务 */
export interface JobRecord {
    /** 任务标识 */
    id: string;
    /** 用户可读标题 */
    title: string;
    /** 任务类型 */
    type: JobType;
    /** 任务参数 */
    payload: AgentJobPayload | ShellJobPayload;
    /** 当前状态 */
    status: JobStatus;
    /** 已启动次数 */
    attempts: number;
    /** 子进程 PID */
    pid?: number;
    /** Shell 退出码 */
    exitCode?: number;
    /** 最后错误 */
    error?: string;
    /** 日志文件路径 */
    logPath: string;
    /** 任务创建时间 */
    createdAt: string;
    /** 最后启动时间 */
    startedAt?: string;
    /** 终态时间 */
    completedAt?: string;
    /** 最长执行秒数 */
    timeoutSeconds: number;
}

/** 后台 Agent 的执行边界 */
export type AgentJobExecutor = (
    job: JobRecord,
    signal: AbortSignal,
    onLog: (text: string) => void,
) => Promise<string>;

interface JobRow {
    id: string;
    title: string;
    type: JobType;
    payload: string;
    status: JobStatus;
    attempts: number;
    pid: number | null;
    exit_code: number | null;
    error: string | null;
    log_path: string;
    runner_path: string | null;
    result_path: string | null;
    timeout_seconds: number;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
}

interface ActiveJob {
    /** 取消 Agent 模型请求 */
    controller?: AbortController;
    /** 终止 Shell 进程组 */
    pid?: number;
}

/** 持久化、可并发、可恢复识别的后台任务管理器 */
export class JobManager {
    private readonly database: Database;
    private readonly active = new Map<string, ActiveJob>();
    private agentExecutor?: AgentJobExecutor;
    private started = false;
    private draining = false;

    /**
     * 创建后台任务管理器
     *
     * @param databasePath 结构化状态库
     * @param jobsPath 任务运行文件目录
     * @param guard workspace 路径边界
     * @param notifications 持久通知收件箱
     * @param logger 结构化日志
     * @param concurrency 最大并发数
     */
    constructor (
        databasePath: string,
        private readonly jobsPath: string,
        private readonly guard: PathGuard,
        private readonly notifications: NotificationInbox,
        private readonly logger: Logger,
        private readonly concurrency = 2,
    ) {
        fs.mkdirSync(path.dirname(databasePath), { recursive: true });
        fs.mkdirSync(jobsPath, { recursive: true });
        this.database = new Database(databasePath, { create: true });
        this.database.run('PRAGMA journal_mode = WAL');
        this.database.run('PRAGMA busy_timeout = 5000');
        this.migrate();
    }

    /**
     * 设置后台 Agent 执行函数
     *
     * @param executor 与前台共用内核但隔离会话的执行器
     */
    public setAgentExecutor (executor: AgentJobExecutor): void {
        this.agentExecutor = executor;
    }

    /** 恢复中断状态并开始处理持久队列 */
    public start (): void {
        if (this.started) {
            return;
        }
        this.started = true;
        this.recoverRunningJobs();
        this.drain();
    }

    /**
     * 创建一个后台 Agent 任务
     *
     * @param title 简短标题
     * @param prompt 独立目标
     * @param timeoutSeconds 最长执行时间
     * @returns 已持久化任务
     */
    public createAgent (title: string, prompt: string, timeoutSeconds = 3600): JobRecord {
        const job = this.create('agent', title, { prompt }, timeoutSeconds);
        this.drain();
        return job;
    }

    /**
     * 创建一个后台 Shell 任务
     *
     * @param title 简短标题
     * @param command Shell 命令
     * @param cwd workspace 相对目录
     * @param timeoutSeconds 最长执行时间
     * @returns 已持久化任务
     */
    public createShell (
        title: string,
        command: string,
        cwd = '.',
        timeoutSeconds = 3600,
    ): JobRecord {
        assertSafeShellCommand(command);
        const workingDirectory = this.guard.resolveRead(cwd);
        if (!fs.statSync(workingDirectory).isDirectory()) {
            throw new Error('后台 Shell 工作路径不是目录');
        }
        const job = this.create('shell', title, { command, cwd }, timeoutSeconds);
        this.drain();
        return job;
    }

    /**
     * 列出最近后台任务
     *
     * @param limit 最多返回数
     * @returns 按创建时间倒序排列的任务
     */
    public list (limit = 50): JobRecord[] {
        const rows = this.database.query(`
            SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?
        `).all(Math.max(1, Math.min(limit, 200))) as JobRow[];
        return rows.map(toJobRecord);
    }

    /**
     * 查询单个任务
     *
     * @param id 任务标识
     * @returns 任务不存在时返回 null
     */
    public get (id: string): JobRecord | null {
        const row = this.database.query('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | null;
        return row ? toJobRecord(row) : null;
    }

    /**
     * 读取任务日志尾部
     *
     * @param id 任务标识
     * @param maxBytes 最大字节数
     * @returns 任务与日志正文
     */
    public readLog (id: string, maxBytes = 32000): { job: JobRecord, log: string } {
        const job = this.get(id);
        if (!job) {
            throw new Error('后台任务不存在');
        }
        return {
            job,
            log: readTail(job.logPath, Math.max(1024, Math.min(maxBytes, 256000))),
        };
    }

    /**
     * 取消排队中或正在执行的任务
     *
     * @param id 任务标识
     * @returns 是否成功转为取消状态
     */
    public cancel (id: string): boolean {
        const job = this.get(id);
        if (!job || ['completed', 'failed', 'cancelled'].includes(job.status)) {
            return false;
        }
        const active = this.active.get(id);
        active?.controller?.abort(new Error('任务已取消'));
        if (active?.pid) {
            terminateProcess(active.pid);
        }
        this.finish(id, 'cancelled', undefined, '用户或 Agent 取消任务');
        this.appendLog(job.logPath, '\n[job cancelled]\n');
        this.active.delete(id);
        this.drain();
        return true;
    }

    /**
     * 重新排队一个中断或失败任务
     *
     * @param id 任务标识
     * @returns 是否成功重新排队
     */
    public resume (id: string): boolean {
        const result = this.database.query(`
            UPDATE jobs
            SET status = 'queued', pid = NULL, exit_code = NULL, error = NULL,
                completed_at = NULL, updated_at = ?
            WHERE id = ? AND status IN ('interrupted', 'failed')
        `).run(new Date().toISOString(), id);
        if (result.changes > 0) {
            const job = this.get(id);
            if (job) {
                this.appendLog(job.logPath, '\n[job manually resumed]\n');
            }
            this.drain();
            return true;
        }
        return false;
    }

    /**
     * 等待当前队列空闲，仅用于测试与关闭前检查
     *
     * @param timeoutMs 最长等待时间
     */
    public async waitForIdle (timeoutMs = 10000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while ((this.active.size > 0 || this.hasQueued()) && Date.now() < deadline) {
            await Bun.sleep(20);
        }
        if (this.active.size > 0 || this.hasQueued()) {
            throw new Error('后台任务在期限内未结束');
        }
    }

    /** 初始化后台任务表 */
    private migrate (): void {
        this.database.run(`
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                type TEXT NOT NULL CHECK (type IN ('agent', 'shell')),
                payload TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
                attempts INTEGER NOT NULL DEFAULT 0,
                pid INTEGER,
                exit_code INTEGER,
                error TEXT,
                log_path TEXT NOT NULL,
                runner_path TEXT,
                result_path TEXT,
                timeout_seconds INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                started_at TEXT,
                completed_at TEXT,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, created_at);
        `);
    }

    /** 写入一条初始任务 */
    private create (
        type: JobType,
        title: string,
        payload: AgentJobPayload | ShellJobPayload,
        timeoutSeconds: number,
    ): JobRecord {
        const id = randomUUID();
        const now = new Date().toISOString();
        const logPath = path.join(this.jobsPath, `${id}.log`);
        fs.writeFileSync(logPath, `[${now}] queued ${type} job: ${title.trim()}\n`, { encoding: 'utf8', flag: 'wx' });
        this.database.query(`
            INSERT INTO jobs (
                id, title, type, payload, status, attempts, log_path,
                timeout_seconds, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)
        `).run(
            id,
            title.trim(),
            type,
            JSON.stringify(payload),
            logPath,
            Math.max(1, Math.min(timeoutSeconds, 86400)),
            now,
            now,
        );
        return this.get(id)!;
    }

    /** 恢复上次 Runtime 留下的运行状态 */
    private recoverRunningJobs (): void {
        const running = this.database.query(`
            SELECT * FROM jobs WHERE status = 'running' ORDER BY started_at ASC
        `).all() as JobRow[];
        for (const row of running) {
            const job = toJobRecord(row);
            if (job.type === 'agent') {
                this.database.query(`
                    UPDATE jobs SET status = 'queued', pid = NULL,
                        error = 'Runtime 重启，Agent 任务将根据日志继续', updated_at = ?
                    WHERE id = ?
                `).run(new Date().toISOString(), job.id);
                this.appendLog(job.logPath, '\n[runtime restarted; agent job requeued]\n');
                continue;
            }
            if (row.result_path && fs.existsSync(row.result_path)) {
                this.completeShellFromResult(job, row.result_path);
                continue;
            }
            if (job.pid && isProcessAlive(job.pid)) {
                this.active.set(job.id, { pid: job.pid });
                void this.monitorShell(job, row.result_path || '').finally(() => this.release(job.id));
                continue;
            }
            this.finish(job.id, 'interrupted', undefined, '宿主或进程已中断，Shell 任务未自动重放');
            this.appendLog(job.logPath, '\n[shell process missing after restart]\n');
            this.notifications.push(`后台任务中断：${job.title}`, `任务 ${job.id} 需要检查后手动恢复`);
        }
    }

    /** 在可用并发槽中领取持久队列 */
    private drain (): void {
        if (!this.started || this.draining) {
            return;
        }
        this.draining = true;
        try {
            while (this.active.size < this.concurrency) {
                const job = this.claimNext();
                if (!job) {
                    return;
                }
                if (job.type === 'agent') {
                    const controller = new AbortController();
                    this.active.set(job.id, { controller });
                    void this.runAgent(job, controller).finally(() => this.release(job.id));
                } else {
                    this.active.set(job.id, {});
                    void this.runShell(job).finally(() => this.release(job.id));
                }
            }
        } finally {
            this.draining = false;
        }
    }

    /** 原子领取一个排队任务 */
    private claimNext (): JobRecord | null {
        const claim = this.database.transaction(() => {
            const row = this.database.query(`
                SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1
            `).get() as JobRow | null;
            if (!row) {
                return null;
            }
            const now = new Date().toISOString();
            this.database.query(`
                UPDATE jobs SET status = 'running', attempts = attempts + 1,
                    started_at = ?, completed_at = NULL, error = NULL, updated_at = ?
                WHERE id = ? AND status = 'queued'
            `).run(now, now, row.id);
            return this.get(row.id);
        });
        return claim.immediate();
    }

    /** 执行一个后台 Agent 任务 */
    private async runAgent (job: JobRecord, controller: AbortController): Promise<void> {
        if (!this.agentExecutor) {
            this.finish(job.id, 'failed', undefined, '后台 Agent 执行器未初始化');
            return;
        }
        const timeout = setTimeout(() => controller.abort(new Error('后台 Agent 任务超时')), job.timeoutSeconds * 1000);
        timeout.unref();
        const previousLog = job.attempts > 1 ? readTail(job.logPath, 16000) : '';
        const executableJob = previousLog
            ? {
                ...job,
                payload: {
                    prompt: [
                        (job.payload as AgentJobPayload).prompt,
                        '',
                        '该任务曾因 Runtime 重启中断。先检查 workspace 实际状态，再从已完成处继续；不要重复不可逆操作。',
                        '<previous-job-log>',
                        previousLog,
                        '</previous-job-log>',
                    ].join('\n'),
                },
            }
            : job;
        this.appendLog(job.logPath, `[${new Date().toISOString()}] agent attempt ${job.attempts} started\n`);
        try {
            await this.agentExecutor(executableJob, controller.signal, text => {
                this.appendLog(job.logPath, text);
            });
            if (this.get(job.id)?.status !== 'running') {
                return;
            }
            this.finish(job.id, 'completed');
            this.notifications.push(`后台任务完成：${job.title}`, `任务 ${job.id} 已完成，可查看任务日志了解结果`);
        } catch (error) {
            if (this.get(job.id)?.status !== 'running') {
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            this.appendLog(job.logPath, `\n[agent failed] ${message}\n`);
            this.finish(job.id, 'failed', undefined, message);
            this.notifications.push(`后台任务失败：${job.title}`, `任务 ${job.id}: ${message}`);
        } finally {
            clearTimeout(timeout);
        }
    }

    /** 启动独立 Shell 进程并监视结果文件 */
    private async runShell (job: JobRecord): Promise<void> {
        const payload = job.payload as ShellJobPayload;
        const cwd = this.guard.resolveRead(payload.cwd);
        const runnerPath = path.join(this.jobsPath, `${job.id}.sh`);
        const resultPath = path.join(this.jobsPath, `${job.id}.exit`);
        fs.rmSync(resultPath, { force: true });
        fs.writeFileSync(runnerPath, [
            '#!/bin/sh',
            'set +e',
            '(',
            payload.command,
            ')',
            'code=$?',
            `printf '%s\\n' "$code" > ${quoteShell(resultPath)}`,
            'exit "$code"',
            '',
        ].join('\n'), { encoding: 'utf8', mode: 0o700 });
        const log = fs.openSync(job.logPath, 'a');
        let child;
        try {
            child = spawn('sh', [runnerPath], {
                cwd,
                env: createShellEnvironment(),
                detached: process.platform !== 'win32',
                stdio: ['ignore', log, log],
            });
        } finally {
            fs.closeSync(log);
        }
        if (!child.pid) {
            this.finish(job.id, 'failed', undefined, '无法启动 Shell 子进程');
            return;
        }
        child.once('error', error => {
            if (this.get(job.id)?.status === 'running') {
                this.finish(job.id, 'failed', undefined, error.message);
                this.notifications.push(`后台任务失败：${job.title}`, `任务 ${job.id}: ${error.message}`);
            }
        });
        child.unref();
        this.active.set(job.id, { pid: child.pid });
        this.database.query(`
            UPDATE jobs SET pid = ?, runner_path = ?, result_path = ?, updated_at = ? WHERE id = ?
        `).run(child.pid, runnerPath, resultPath, new Date().toISOString(), job.id);
        this.appendLog(job.logPath, `[${new Date().toISOString()}] shell pid ${child.pid} started\n`);
        await this.monitorShell({ ...job, pid: child.pid }, resultPath);
    }

    /** 监视可跨 Runtime 重启存活的 Shell 任务 */
    private async monitorShell (job: JobRecord, resultPath: string): Promise<void> {
        const startedAt = job.startedAt ? Date.parse(job.startedAt) : Date.now();
        while (this.get(job.id)?.status === 'running') {
            if (resultPath && fs.existsSync(resultPath)) {
                this.completeShellFromResult(job, resultPath);
                return;
            }
            if (Date.now() - startedAt > job.timeoutSeconds * 1000) {
                if (job.pid) {
                    terminateProcess(job.pid);
                }
                this.appendLog(job.logPath, '\n[shell job timed out]\n');
                this.finish(job.id, 'failed', undefined, '后台 Shell 任务超时');
                this.notifications.push(`后台任务失败：${job.title}`, `任务 ${job.id} 执行超时`);
                return;
            }
            if (job.pid && !isProcessAlive(job.pid)) {
                await Bun.sleep(100);
                if (resultPath && fs.existsSync(resultPath)) {
                    this.completeShellFromResult(job, resultPath);
                    return;
                }
                this.finish(job.id, 'interrupted', undefined, 'Shell 进程消失且未留下退出状态');
                this.notifications.push(`后台任务中断：${job.title}`, `任务 ${job.id} 需要检查后手动恢复`);
                return;
            }
            await Bun.sleep(500);
        }
    }

    /** 根据 Shell 退出文件完成任务 */
    private completeShellFromResult (job: JobRecord, resultPath: string): void {
        const exitCode = Number.parseInt(fs.readFileSync(resultPath, 'utf8').trim(), 10);
        const validExitCode = Number.isFinite(exitCode) ? exitCode : -1;
        if (validExitCode === 0) {
            this.finish(job.id, 'completed', validExitCode);
            this.notifications.push(`后台任务完成：${job.title}`, `任务 ${job.id} 已完成，可查看任务日志了解结果`);
            return;
        }
        this.finish(job.id, 'failed', validExitCode, `Shell 退出码 ${validExitCode}`);
        this.notifications.push(`后台任务失败：${job.title}`, `任务 ${job.id} 退出码 ${validExitCode}`);
    }

    /** 写入任务终态 */
    private finish (id: string, status: Exclude<JobStatus, 'queued' | 'running'>, exitCode?: number, error?: string): void {
        const now = new Date().toISOString();
        this.database.query(`
            UPDATE jobs SET status = ?, exit_code = ?, error = ?, completed_at = ?, updated_at = ?
            WHERE id = ?
        `).run(status, exitCode ?? null, error || null, now, now, id);
        this.logger.info('Background job finished', { jobId: id, status, exitCode, error });
    }

    /** 释放并发槽并继续领取队列 */
    private release (id: string): void {
        this.active.delete(id);
        this.drain();
    }

    /** 查询是否仍有排队任务 */
    private hasQueued (): boolean {
        const row = this.database.query(`
            SELECT COUNT(*) AS count FROM jobs WHERE status = 'queued'
        `).get() as { count: number };
        return row.count > 0;
    }

    /** 将文本追加到任务日志 */
    private appendLog (logPath: string, value: string): void {
        fs.appendFileSync(logPath, value, 'utf8');
    }
}

/** 将 SQLite 行转为公开任务结构 */
function toJobRecord (row: JobRow): JobRecord {
    return {
        id: row.id,
        title: row.title,
        type: row.type,
        payload: JSON.parse(row.payload) as AgentJobPayload | ShellJobPayload,
        status: row.status,
        attempts: row.attempts,
        ...(row.pid !== null && { pid: row.pid }),
        ...(row.exit_code !== null && { exitCode: row.exit_code }),
        ...(row.error && { error: row.error }),
        logPath: row.log_path,
        createdAt: row.created_at,
        ...(row.started_at && { startedAt: row.started_at }),
        ...(row.completed_at && { completedAt: row.completed_at }),
        timeoutSeconds: row.timeout_seconds,
    };
}

/** 只读文件尾部，避免长任务日志挤爆上下文 */
function readTail (filePath: string, maxBytes: number): string {
    if (!fs.existsSync(filePath)) {
        return '';
    }
    const stat = fs.statSync(filePath);
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const descriptor = fs.openSync(filePath, 'r');
    try {
        fs.readSync(descriptor, buffer, 0, length, stat.size - length);
    } finally {
        fs.closeSync(descriptor);
    }
    return buffer.toString('utf8');
}

/** 判断指定 PID 是否仍存活 */
function isProcessAlive (pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/** 终止后台 Shell 进程组 */
function terminateProcess (pid: number): void {
    try {
        process.kill(process.platform === 'win32' ? pid : -pid, 'SIGTERM');
    } catch {
        // 进程可能已经正常结束
    }
}

/** 对内部生成路径做 POSIX Shell 引号处理 */
function quoteShell (value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** 不向工作区 Shell 传递模型凭证 */
function createShellEnvironment (): NodeJS.ProcessEnv {
    return Object.fromEntries(Object.entries(process.env).filter(([key]) => ![
        'SELFCRAFT_TEST_API_KEY',
        'OPENAI_API_KEY',
        'ANTHROPIC_API_KEY',
    ].includes(key)));
}
