import { canRepeatTool } from '../tools/tool-safety';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import type { ModelMessage, UserModelMessage } from 'ai';
import { userContentText } from '../model/user-content';
import { assertStateVersion } from '../supervisor/state-version';

/** 可跨进程接续的一轮执行 */
export interface ExecutionRecord {
    /** 稳定执行标识 */
    id: string;
    /** 原始输入 */
    input: UserModelMessage['content'];
    /** 执行入口 */
    channel: 'foreground' | 'background';
    /** 当前生命周期 */
    status: 'queued' | 'running' | 'completed' | 'blocked' | 'failed';
    /** 已完成步骤的完整响应 */
    messages: ModelMessage[];
    /** 模型最终输出，空字符串也是有效结果 */
    result: string | null;
    /** 内部事项事件不冒充用户消息 */
    kind: 'user' | 'event';
    /** 合并处理这条输入的主脑执行 */
    parentId: string | null;
    /** 是否为用户明确重试 */
    retry: boolean;
}

/** 持久输入、步骤检查点与工具结果；不重放结果未知的操作 */
export class ExecutionStore {
    private readonly database: Database;

    /** 打开状态库并建立执行表，返回可持久使用的存储 */
    constructor (databasePath: string) {
        fs.mkdirSync(path.dirname(databasePath), { recursive: true });
        this.database = new Database(databasePath);
        assertStateVersion(this.database);
        this.database.run('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
        this.database.run(`
            CREATE TABLE IF NOT EXISTS executions (
                id TEXT PRIMARY KEY, input TEXT NOT NULL, channel TEXT NOT NULL,
                status TEXT NOT NULL, messages TEXT NOT NULL DEFAULT '[]', result TEXT,
                retry INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, error TEXT
            );
            CREATE TABLE IF NOT EXISTS execution_tools (
                execution_id TEXT NOT NULL, call_id TEXT NOT NULL, name TEXT NOT NULL,
                input TEXT NOT NULL, output TEXT, settled INTEGER NOT NULL DEFAULT 0,
                checkpointed INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (execution_id, call_id)
            );
        `);
        const columns = this.database.query('PRAGMA table_info(executions)').all() as { name: string }[];
        if (!columns.some(column => column.name === 'kind')) {
            this.database.run("ALTER TABLE executions ADD COLUMN kind TEXT NOT NULL DEFAULT 'user'");
            this.database.run('ALTER TABLE executions ADD COLUMN parent_id TEXT');
        }
        if (!columns.some(column => column.name === 'input_content')) {
            this.database.run('ALTER TABLE executions ADD COLUMN input_content TEXT');
        }
    }

    /** 持久接收输入；相同标识只允许相同内容，返回原记录 */
    public accept (id: string, input: UserModelMessage['content'], channel: ExecutionRecord['channel'], retry = false, kind: ExecutionRecord['kind'] = 'user'): ExecutionRecord {
        this.database.query(`INSERT OR IGNORE INTO executions (id, input, channel, status, retry, created_at, input_content, kind)
            VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`).run(id, userContentText(input), channel, Number(retry), new Date().toISOString(), typeof input === 'string' ? null : JSON.stringify(input), kind);
        const record = this.get(id)!;
        if (JSON.stringify(record.input) !== JSON.stringify(input) || record.channel !== channel || record.kind !== kind || record.retry !== retry) {
            throw new Error('执行标识已被其他输入使用');
        }
        return record;
    }

    /** 按标识读取执行，不存在返回 null */
    public get (id: string): ExecutionRecord | null {
        const row = this.database.query('SELECT * FROM executions WHERE id = ?').get(id) as
            (Omit<ExecutionRecord, 'messages' | 'retry'> & { messages: string; retry: number; input_content: string | null; parent_id: string | null }) | null;
        return row ? { ...row, parentId: row.parent_id, input: row.input_content ? JSON.parse(row.input_content) : row.input, messages: JSON.parse(row.messages), retry: Boolean(row.retry) } : null;
    }

    /** 按接收顺序读取未完成前台输入，供启动恢复 */
    public pending (): ExecutionRecord[] {
        const rows = this.database.query(`SELECT id FROM executions WHERE channel = 'foreground'
            AND parent_id IS NULL AND status IN ('queued', 'running') ORDER BY created_at, rowid`).all() as { id: string }[];
        return rows.map(row => this.get(row.id)!);
    }

    /** 把新输入归入正在运行的主脑；恢复时一并返回已归入但尚未交付的输入 */
    public collect (parentId: string): ExecutionRecord[] {
        return this.database.transaction(() => {
            const changed = this.database.query(`UPDATE executions SET parent_id = ?, status = 'running'
                WHERE channel = 'foreground' AND status = 'queued' AND parent_id IS NULL AND id != ?`).run(parentId, parentId);
            if (changed.changes) this.database.query('UPDATE executions SET result = NULL WHERE id = ?').run(parentId);
            return (this.database.query('SELECT id FROM executions WHERE parent_id = ? ORDER BY created_at, rowid').all(parentId) as { id: string }[])
                .map(row => this.get(row.id)!);
        }).immediate();
    }

    /** 判断当前主脑是否收到新的输入，不调用模型 */
    public hasQueued (): boolean {
        return Boolean(this.database.query("SELECT 1 FROM executions WHERE channel = 'foreground' AND status = 'queued' AND parent_id IS NULL LIMIT 1").get());
    }

    /** 同一答复承接的消息一起结束，重复投递不会再运行 */
    public finishGroup (id: string, status: 'completed' | 'failed', error?: string): void {
        this.database.query('UPDATE executions SET status = ?, error = ? WHERE parent_id = ?').run(status, error ?? null, id);
    }

    /** 准备恢复步骤；未落入检查点的完整工具结果重建为消息，未知结果阻止执行 */
    public begin (id: string): ExecutionRecord {
        return this.database.transaction(() => {
            const record = this.get(id);
            if (!record) {
                throw new Error('执行不存在');
            }
            const tools = this.database.query(`SELECT * FROM execution_tools
                WHERE execution_id = ? AND checkpointed = 0 ORDER BY rowid`).all(id) as {
                    call_id: string; name: string; input: string; output: string; settled: number;
                }[];
            const interruptedReads = tools.filter(tool => !tool.settled && canRepeatTool(tool.name));
            for (const read of interruptedReads) {
                // 中断读取的结果未知，但不会改变用户状态；记录未收到结果，允许模型重新读取
                const result = { error: '上次只读工具的结果未收到，可以重新调用' };
                this.finishTool(id, read.call_id, result);
                read.settled = 1;
                read.output = JSON.stringify({ type: 'json', value: result });
            }
            if (tools.some(tool => !tool.settled)) {
                this.setStatus(id, 'blocked', '外部操作结果未知，需要检查实际状态后通过新请求处理');
                return this.get(id)!;
            }
            if ((record.status === 'blocked' && interruptedReads.length === 0) || record.status === 'completed') {
                return record;
            }
            if (tools.length > 0) {
                const recovered: ModelMessage[] = [
                    { role: 'assistant', content: tools.map(tool => ({
                        type: 'tool-call' as const, toolCallId: tool.call_id,
                        toolName: tool.name, input: JSON.parse(tool.input),
                    })) },
                    { role: 'tool', content: tools.map(tool => ({
                        type: 'tool-result' as const, toolCallId: tool.call_id,
                        toolName: tool.name, output: JSON.parse(tool.output),
                    })) },
                ];
                this.checkpoint(id, [...record.messages, ...recovered]);
            }
            this.setStatus(id, 'running');
            return this.get(id)!;
        }).immediate();
    }

    /** 在副作用之前记录确定的调用参数，返回已记录的结果或允许首次执行 */
    public startTool (id: string, callId: string, name: string, input: unknown): void {
        if (this.get(id)?.status !== 'running') {
            throw new Error('执行已停止，拒绝继续工具调用');
        }
        this.database.query(`INSERT INTO execution_tools (execution_id, call_id, name, input)
            VALUES (?, ?, ?, ?)`).run(id, callId, name, JSON.stringify(input));
    }

    /** 保存完整结果供恢复，工具异常默认保留未知状态，不猜测外部操作是否完成 */
    public finishTool (id: string, callId: string, result: unknown): void {
        this.database.query(`UPDATE execution_tools SET output = ?, settled = 1
            WHERE execution_id = ? AND call_id = ?`).run(
            JSON.stringify({ type: 'json', value: result ?? null }), id, callId,
        );
    }

    /** 原子提交完整步骤及其覆盖的工具结果 */
    public checkpoint (id: string, messages: ModelMessage[], result?: string): void {
        this.database.transaction(() => {
            const pending = this.database.query('SELECT call_id FROM execution_tools WHERE execution_id = ? AND settled = 0 LIMIT 1').get(id);
            if (pending) {
                throw new Error('工具结果未知，必须核实后通过新请求处理');
            }
            this.database.query('UPDATE executions SET messages = ?, result = ? WHERE id = ?')
                .run(JSON.stringify(messages), result ?? null, id);
            this.database.query(`UPDATE execution_tools SET checkpointed = 1
                WHERE execution_id = ? AND settled = 1`).run(id);
        }).immediate();
    }

    /** 返回最近需要核实的执行，供助理主动承接故障 */
    public issues (): { id: string; input: string; status: string; error: string | null }[] {
        return this.database.query(`SELECT id, substr(input, 1, 1000) AS input, status, error FROM executions
            WHERE status IN ('blocked', 'failed') ORDER BY created_at DESC LIMIT 10`).all() as
            { id: string; input: string; status: string; error: string | null }[];
    }

    /** 返回一次执行的工具证据；大结果由统一工具包装器落盘 */
    public inspect (id: string): { execution: ExecutionRecord | null; tools: unknown[] } {
        return { execution: this.get(id), tools: this.database.query(`SELECT call_id, name, input, output, settled
            FROM execution_tools WHERE execution_id = ? ORDER BY rowid`).all(id) };
    }

    /** 设置终态并保留错误说明，返回空值 */
    public setStatus (id: string, status: ExecutionRecord['status'], error?: string): void {
        this.database.query('UPDATE executions SET status = ?, error = ? WHERE id = ?')
            .run(status, error ?? null, id);
    }
}
