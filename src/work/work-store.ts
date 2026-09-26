import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { assertStateVersion } from '../supervisor/state-version';

/** 助理承接的一项持续责任 */
export interface WorkRecord {
    /** 永久事项标识 */
    id: string;
    /** 当前目标 */
    goal: string;
    /** 可核实的完成条件 */
    acceptance: string;
    /** 用户授予的范围；外部内容不得扩展 */
    authority: string;
    /** 原始请求证据 */
    sourceEventId: string;
    /** 用于拒绝过期执行的版本 */
    revision: number;
    /** 要求或唤醒条件的版本，普通进展不改变 */
    instructionVersion: number;
    /** 分身累计模型调用次数 */
    steps: number;
    /** 派发时明确允许修改的工作区文件 */
    writablePaths: string[];
    /** 创建和最近进展时间 */
    createdAt: string;
    updatedAt: string;
    /** 当前状态 */
    status: 'ready' | 'running' | 'waiting' | 'completed' | 'cancelled' | 'blocked';
    /** 下一步或等待的具体说明 */
    next: string;
    /** 结果、检验依据及重要进展 */
    evidence: string;
    /** 等待条件 */
    waitFor: 'user' | 'time' | 'job' | null;
    /** 时间触发点 */
    wakeAt: string | null;
    /** 已关联执行的标识 */
    jobId: string | null;
    /** 尚未结束的执行片段，重启继续复用工具检查点 */
    executionId: string | null;
    /** 当前条件触发的累计思考次数 */
    turns: number;
}

/** 一次主脑授权下的累计模型调用预算 */
export const WORK_STEP_BUDGET = 128;

/** 持久事项及其版本；Job 和时间只是唤醒条件 */
export class WorkStore {
    private readonly database: Database;

    /** 在已有实例状态库建立事项表 */
    constructor (databasePath: string) {
        this.database = new Database(databasePath);
        assertStateVersion(this.database);
        this.database.run('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
        this.database.run(`CREATE TABLE IF NOT EXISTS works (
            id TEXT PRIMARY KEY, record TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL
        ); CREATE INDEX IF NOT EXISTS works_status ON works(status, updated_at);
        CREATE TABLE IF NOT EXISTS work_outbox (id TEXT PRIMARY KEY, title TEXT NOT NULL, message TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);`);
    }

    /** 保存有来源的目标，指定标识用于成长候选去重 */
    public create (input: Pick<WorkRecord, 'goal' | 'acceptance' | 'authority' | 'sourceEventId' | 'next'> & { writablePaths?: string[]; waitFor?: 'user' | 'time'; wakeAt?: string }, id: string = randomUUID()): WorkRecord {
        if (input.waitFor === 'time' && (!input.wakeAt || !Number.isFinite(Date.parse(input.wakeAt)))) {
            throw new Error('时间等待必须包含有效的绝对时间');
        }
        const record: WorkRecord = {
            ...input, id, revision: 1, instructionVersion: 1, steps: 0, writablePaths: input.writablePaths || [],
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: input.waitFor ? 'waiting' : 'ready', evidence: '', waitFor: input.waitFor || null, executionId: null,
            wakeAt: input.waitFor === 'time' ? input.wakeAt! : null, jobId: null, turns: 0,
        };
        this.database.query('INSERT OR IGNORE INTO works VALUES (?, ?, ?, ?)')
            .run(id, JSON.stringify(record), record.status, new Date().toISOString());
        return this.get(id)!;
    }

    /** 获取事项，不存在返回 null */
    public get (id: string): WorkRecord | null {
        const row = this.database.query('SELECT record FROM works WHERE id = ?').get(id) as { record: string } | null;
        return row ? this.decode(row.record) : null;
    }

    /** 返回有界事项列表，默认只列未结束事项 */
    public list (includeFinished = false, limit = 50): WorkRecord[] {
        const rows = this.database.query(`SELECT record FROM works
            ${includeFinished ? '' : "WHERE status NOT IN ('completed', 'cancelled')"}
            ORDER BY updated_at DESC LIMIT ?`).all(Math.max(1, Math.min(limit, 200))) as { record: string }[];
        return rows.map(row => this.decode(row.record));
    }

    /** 按预期版本修改事项；完成必须带依据，等待必须有明确条件 */
    public update (
        id: string,
        revision: number,
        patch: Partial<Pick<WorkRecord, 'goal' | 'acceptance' | 'authority' | 'status' | 'next' | 'evidence' | 'waitFor' | 'wakeAt' | 'jobId' | 'writablePaths'>>,
        userChange = false,
    ): WorkRecord {
        return this.database.transaction(() => {
            const current = this.get(id);
            if (!current || current.revision !== revision) throw new Error('事项已改变，请读取最新状态后处理');
            const updated = { ...current, ...patch, revision: revision + 1,
                instructionVersion: current.instructionVersion + Number(userChange),
                steps: userChange ? 0 : current.steps, turns: userChange ? 0 : current.turns,
                updatedAt: new Date().toISOString() };
            if (updated.status === 'completed' && !updated.evidence.trim()) {
                throw new Error('完成事项必须记录结果与验证依据');
            }
            if (updated.status === 'waiting') {
                if (!updated.waitFor || !updated.next.trim()) {
                    throw new Error('等待事项必须说明等待条件和下一步');
                }
                if (updated.waitFor === 'time' && (!updated.wakeAt || !Number.isFinite(Date.parse(updated.wakeAt)))) {
                    throw new Error('时间等待必须包含有效的绝对时间');
                }
                if (updated.waitFor === 'job' && !updated.jobId) {
                    throw new Error('后台等待必须关联实际 Job');
                }
            } else {
                updated.waitFor = null;
                updated.wakeAt = null;
            }
            this.save(updated);
            if (!userChange && (['completed', 'blocked', 'cancelled'].includes(updated.status)
                || (updated.status === 'waiting' && updated.waitFor === 'user'))) {
                this.database.query('INSERT OR IGNORE INTO work_outbox (id, title, message) VALUES (?, ?, ?)')
                    .run(`work:${id}:${updated.revision}`, updated.goal.slice(0, 120),
                        `事项 ${id}，要求版本 ${updated.instructionVersion}，状态 ${updated.status}：\n${[updated.evidence, updated.next].filter(Boolean).join('\n')}`);
            }
            return updated;
        }).immediate();
    }

    /** 验证执行仍属于当前事项版本 */
    public requireCurrent (id: string, revision: number): WorkRecord {
        const record = this.get(id);
        if (!record || record.revision !== revision || ['completed', 'cancelled'].includes(record.status)) {
            throw new Error('事项已改变或结束，请读取最新状态后处理');
        }
        return record;
    }

    /** 启动时保留同一版本恢复运行中的事项，不重置自动执行预算 */
    public recover (): void {
        const rows = this.database.query("SELECT record FROM works WHERE status = 'running'").all() as { record: string }[];
        for (const row of rows) {
            const record = this.decode(row.record);
            this.save({ ...record, status: 'ready' });
        }
    }

    /** 原子领取一个就绪事项，累计预算用完后交回主脑 */
    public claim (exclude: string[] = []): WorkRecord | null {
        return this.database.transaction(() => {
            const row = this.database.query(`SELECT record FROM works WHERE status = 'ready' AND id NOT IN (${exclude.map(() => '?').join(',') || "''"}) ORDER BY updated_at, rowid LIMIT 1`)
                .get(...exclude) as { record: string } | null;
            if (!row) {
                return null;
            }
            const record = this.decode(row.record);
            if (record.steps >= WORK_STEP_BUDGET) {
                this.update(record.id, record.revision, { status: 'blocked', next: '事项累计执行预算已用完，请主脑检查已有进展后调整要求或允许继续' });
                return null;
            }
            const claimed: WorkRecord = { ...record, status: 'running', turns: record.turns + Number(!record.executionId), executionId: record.executionId || `work:${record.id}:${randomUUID()}` };
            this.save(claimed);
            return claimed;
        }).immediate();
    }

    /** 把到期或后台终态转换为持久就绪状态；轮询不调用模型 */
    public wake (readJob: (id: string) => { status: string; evidence: string } | null, now = Date.now()): void {
        const rows = this.database.query("SELECT record FROM works WHERE status = 'waiting'").all() as { record: string }[];
        for (const row of rows) {
            const record = this.decode(row.record);
            const job = record.waitFor === 'job' && record.jobId ? readJob(record.jobId) : null;
            const due = record.waitFor === 'time' && record.wakeAt && Date.parse(record.wakeAt) <= now;
            if (due || (job && !['queued', 'running'].includes(job.status))) {
                this.update(record.id, record.revision, {
                    status: 'ready',
                    ...(job && { jobId: null }),
                    evidence: [record.evidence, job ? `Job ${record.jobId}: ${job.status}\n${job.evidence}` : '等待时间已到'].filter(Boolean).join('\n').slice(-24000),
                }, true);
            }
        }
    }

    /** 执行片段结束后释放标识；停止进程时保留它以供恢复 */
    public release (id: string): void {
        const work = this.get(id)!;
        this.save({ ...work, executionId: null });
    }

    /** 保存累计用量；不改变要求版本，也不产生通知 */
    public recordStep (id: string): void {
        const work = this.get(id)!;
        this.save({ ...work, steps: work.steps + 1, updatedAt: new Date().toISOString() });
    }

    /** 主动向主脑报告重要进展，普通步骤不调用此方法 */
    public report (id: string, message: string): void {
        const work = this.get(id)!;
        this.database.query('INSERT OR IGNORE INTO work_outbox (id, title, message) VALUES (?, ?, ?)')
            .run(`work:${id}:${work.revision}`, work.goal.slice(0, 120), `事项 ${id}，要求版本 ${work.instructionVersion}：\n${message}`);
    }

    /** 恢复旧测试数据中未记录的事项元数据 */
    private decode (value: string): WorkRecord {
        return { executionId: null, instructionVersion: 1, steps: 0, writablePaths: [], createdAt: '', updatedAt: '', ...JSON.parse(value) };
    }

    /** 读取尚未投递的事项结果；状态与输出在同一事务中提交 */
    public notifications (): { id: string; title: string; message: string }[] {
        return this.database.query('SELECT id, title, message FROM work_outbox WHERE delivered = 0 LIMIT 100').all() as
            { id: string; title: string; message: string }[];
    }

    /** 在持久通知成功后确认投递 */
    public acknowledge (id: string): void {
        this.database.query('UPDATE work_outbox SET delivered = 1 WHERE id = ?').run(id);
    }

    /** 在短事务内保存完整事项快照 */
    private save (record: WorkRecord): void {
        this.database.query('UPDATE works SET record = ?, status = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(record), record.status, new Date().toISOString(), record.id);
    }
}
