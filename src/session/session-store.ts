import * as fs from 'node:fs';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { assertStateVersion } from '../supervisor/state-version';
import { modelMessageSchema, type ModelMessage } from 'ai';

/** 持久会话快照 */
export interface SessionSnapshot {
    /** 最近一次交接的工作笔记，原文和旧笔记另存 */
    summary: string;
    /** 当前快照版本，用于交接时核对原文是否变化 */
    revision?: number;
    /** 活跃消息在原文表中的稳定 ID */
    messageIds?: number[];
    /** 仍保留原文的近期消息 */
    messages: ModelMessage[];
}

/** 在 SQLite 事务中保存原文和派生上下文，旧 JSONL 只导入一次 */
export class SessionStore {
    private readonly database: Database;
    private readonly contextPath: string;
    private readonly transcriptPath: string;

    /**
     * 创建指定会话的存储
     *
     * @param sessionsPath 会话根目录
     * @param sessionId 会话标识
     */
    constructor (private readonly sessionsPath: string, sessionId = 'main') {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(sessionId)) {
            throw new Error('会话标识无效');
        }
        const sessionPath = path.join(sessionsPath, sessionId);
        fs.mkdirSync(sessionPath, { recursive: true });
        this.contextPath = path.join(sessionPath, 'context.json');
        this.transcriptPath = path.join(sessionPath, 'transcript.jsonl');
        this.database = new Database(path.join(sessionPath, 'session.sqlite'));
        assertStateVersion(this.database);
        this.database.run('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
        this.database.run(`
            CREATE TABLE IF NOT EXISTS session_context (id INTEGER PRIMARY KEY, snapshot TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS session_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS session_appends (id TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS context_notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                first_message_id INTEGER NOT NULL, last_message_id INTEGER NOT NULL,
                content TEXT NOT NULL, created_at TEXT NOT NULL
            );
        `);
        if (!this.database.query('SELECT id FROM session_context WHERE id = 1').get()) {
            this.migrateLegacy(sessionPath);
            let snapshot: SessionSnapshot;
            try {
                snapshot = JSON.parse(fs.readFileSync(this.contextPath, 'utf8')) as SessionSnapshot;
                if (typeof snapshot.summary !== 'string' || !Array.isArray(snapshot.messages)) {
                    throw new Error('旧会话快照无效');
                }
                snapshot.messages.forEach(message => modelMessageSchema.parse(message));
            } catch (error) {
                if (!fs.existsSync(this.transcriptPath)) {
                    throw error;
                }
                snapshot = { summary: '', messages: fs.readFileSync(this.transcriptPath, 'utf8')
                    .split(/\r?\n/).filter(Boolean).map(line => modelMessageSchema.parse(JSON.parse(line))) };
            }
            const transcript = fs.existsSync(this.transcriptPath)
                ? fs.readFileSync(this.transcriptPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
                : snapshot.messages;
            [...snapshot.messages, ...transcript].forEach(message => modelMessageSchema.parse(message));
            this.database.transaction(() => {
                this.database.query('INSERT INTO session_context VALUES (1, ?)').run(JSON.stringify(snapshot));
                for (const message of transcript) {
                    this.database.query('INSERT INTO session_messages (message) VALUES (?)').run(JSON.stringify(message));
                }
            }).immediate();
        }
    }

    /**
     * 加载摘要与所有有效消息
     *
     * @returns 当前会话快照
     */
    public load (): SessionSnapshot {
        const row = this.database.query('SELECT snapshot FROM session_context WHERE id = 1').get() as { snapshot: string };
        const snapshot = JSON.parse(row.snapshot) as SessionSnapshot;
        snapshot.messages.forEach(message => modelMessageSchema.parse(message));
        // 旧快照的活跃消息是原文后缀，首次读取补出 ID 即可，不重写旧数据
        snapshot.messageIds ??= (this.database.query(`SELECT id FROM (
            SELECT id FROM session_messages ORDER BY id DESC LIMIT ?
        ) ORDER BY id`).all(snapshot.messages.length) as { id: number }[]).map(row => row.id);
        snapshot.revision ??= 0;
        return snapshot;
    }

    /**
     * 向会话追加消息
     *
     * @param messages AI SDK 标准消息
     */
    public append (...messages: ModelMessage[]): void {
        this.appendOnce(randomUUID(), ...messages);
    }

    /** 以稳定提交标识原子追加上下文和原文，恢复后不会重复写入 */
    public appendOnce (id: string, ...messages: ModelMessage[]): void {
        messages.forEach(message => modelMessageSchema.parse(message));
        this.database.transaction(() => {
            const inserted = this.database.query('INSERT OR IGNORE INTO session_appends VALUES (?)').run(id);
            if (!inserted.changes) {
                return;
            }
            const snapshot = this.load();
            const ids = messages.map(message => Number(this.database.query('INSERT INTO session_messages (message) VALUES (?)')
                .run(JSON.stringify(message)).lastInsertRowid));
            this.database.query('UPDATE session_context SET snapshot = ? WHERE id = 1')
                .run(JSON.stringify({ ...snapshot, revision: snapshot.revision! + 1,
                    messages: [...snapshot.messages, ...messages], messageIds: [...snapshot.messageIds!, ...ids] }));
        }).immediate();
    }

    /**
     * 用压缩后的摘要和近期消息替换当前快照
     *
     * @param summary 新摘要
     * @param messages 保留消息
     */
    public replace (summary: string, messages: ModelMessage[]): void {
        for (const message of messages) {
            modelMessageSchema.parse(message);
        }
        this.database.query('UPDATE session_context SET snapshot = ? WHERE id = 1')
            .run(JSON.stringify({ summary: summary.trim(), messages, revision: this.load().revision! + 1 }));
    }

    /** 释放短期工作窗口的数据库连接 */
    public [Symbol.dispose] (): void {
        this.database.close();
    }

    /** 为后台执行提供独立工作窗口，前台对话仍使用 main */
    public forExecution (executionId: string): SessionStore {
        return new SessionStore(this.sessionsPath, `execution-${createHash('sha256').update(executionId).digest('hex').slice(0, 32)}`);
    }

    /** 以原请求和响应序号去重保存每个完整步骤，执行重试共用同一来源 */
    public appendResponses (sourceRunId: string, messages: ModelMessage[]): void {
        this.database.transaction(() => {
            messages.forEach((message, index) => this.appendOnce(`run:${sourceRunId}:response:${index}`, message));
        }).immediate();
    }

    /** 保存笔记并原子替换工作窗口；失败或过期提交均保留原快照 */
    public handoff (expected: SessionSnapshot, content: string, retainedIds: number[]): SessionSnapshot {
        return this.database.transaction(() => {
            const current = this.load();
            if (current.revision !== expected.revision) {
                throw new Error('上下文已变化，请在下一步骤重新整理');
            }
            const ids = current.messageIds!;
            if (!content.trim() || !ids.length || retainedIds.some(id => !ids.includes(id))) {
                throw new Error('工作笔记或保留消息无效');
            }
            const references = [...content.matchAll(/\[message:(\d+)\]/g)].map(match => Number(match[1]));
            if (!references.length || references.some(id => !this.database.query('SELECT id FROM session_messages WHERE id = ?').get(id))) {
                throw new Error('工作笔记缺少有效的原文引用');
            }
            this.database.query(`INSERT INTO context_notes (first_message_id, last_message_id, content, created_at)
                VALUES (?, ?, ?, ?)`).run(Math.min(...ids), Math.max(...ids), content.trim(), new Date().toISOString());
            const retained = new Set(retainedIds);
            const snapshot: SessionSnapshot = { summary: content.trim(), revision: current.revision! + 1,
                messages: current.messages.filter((_, index) => retained.has(ids[index]!)),
                messageIds: ids.filter(id => retained.has(id)) };
            this.database.query('UPDATE session_context SET snapshot = ? WHERE id = 1').run(JSON.stringify(snapshot));
            return snapshot;
        }).immediate();
    }

    /** 搜索原文或笔记，返回稳定引用和有限预览，before 用于向前翻页 */
    public searchHistory (kind: 'message' | 'note', query = '', before?: number, limit = 10): { id: number; preview: string }[] {
        const table = kind === 'message' ? 'session_messages' : 'context_notes';
        const column = kind === 'message' ? 'message' : 'content';
        return this.database.query(`SELECT id, substr(${column}, 1, 600) AS preview FROM ${table}
            WHERE instr(${column}, ?) > 0 AND id < ? ORDER BY id DESC LIMIT ?`)
            .all(query, before ?? Number.MAX_SAFE_INTEGER, Math.min(20, Math.max(1, limit))) as { id: number; preview: string }[];
    }

    /** 按稳定引用分页读取原文或笔记，原文包含完整 AI SDK 内容和附件引用 */
    public readHistory (kind: 'message' | 'note', id: number, offset = 0, limit = 4000): { id: number; content: string; totalCharacters: number; nextOffset: number | null; firstMessageId?: number; lastMessageId?: number } {
        const table = kind === 'message' ? 'session_messages' : 'context_notes';
        const column = kind === 'message' ? 'message' : 'content';
        const sourceColumns = kind === 'note' ? ', first_message_id AS firstMessageId, last_message_id AS lastMessageId' : '';
        const row = this.database.query(`SELECT ${column} AS content${sourceColumns} FROM ${table} WHERE id = ?`).get(id) as { content: string; firstMessageId?: number; lastMessageId?: number } | null;
        if (!row) {
            throw new Error('历史引用不存在');
        }
        const content = row.content.slice(offset, offset + Math.min(8000, limit));
        return { ...row, id, content, totalCharacters: row.content.length,
            nextOffset: offset + content.length < row.content.length ? offset + content.length : null };
    }

    /** 清空当前会话但保留目录 */
    public clear (): void {
        this.database.transaction(() => {
            this.replace('', []);
            this.database.run('DELETE FROM session_messages; DELETE FROM session_appends; DELETE FROM context_notes');
        }).immediate();
    }

    /**
     * 读取不受上下文压缩影响的原始记录
     *
     * @param limit 最多返回最近消息数
     * @returns 按原始顺序排列的消息
     */
    public loadTranscript (limit = 1000): ModelMessage[] {
        const rows = this.database.query(`SELECT message FROM (
            SELECT id, message FROM session_messages ORDER BY id DESC LIMIT ?
        ) ORDER BY id`).all(Math.max(1, limit)) as { message: string }[];
        return rows.map(row => modelMessageSchema.parse(JSON.parse(row.message)));
    }

    /** 使用单文件原子替换上下文快照 */
    private writeContext (snapshot: SessionSnapshot): void {
        const temporaryPath = `${this.contextPath}.${process.pid}.tmp`;
        fs.writeFileSync(temporaryPath, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(temporaryPath, this.contextPath);
    }

    /** 一次性导入最早版的 messages.jsonl 和 summary.md */
    private migrateLegacy (sessionPath: string): void {
        if (fs.existsSync(this.contextPath)) {
            return;
        }
        if (fs.existsSync(this.transcriptPath)) {
            const messages = fs.readFileSync(this.transcriptPath, 'utf8').split(/\r?\n/).filter(Boolean)
                .map(line => modelMessageSchema.parse(JSON.parse(line)));
            this.writeContext({ summary: '', messages });
            return;
        }
        const messagesPath = path.join(sessionPath, 'messages.jsonl');
        const summaryPath = path.join(sessionPath, 'summary.md');
        const messages: ModelMessage[] = [];
        if (fs.existsSync(messagesPath)) {
            for (const line of fs.readFileSync(messagesPath, 'utf8').split(/\r?\n/).filter(Boolean)) {
                const parsed = modelMessageSchema.safeParse(JSON.parse(line));
                if (!parsed.success) {
                    throw new Error('旧版会话文件包含无效消息');
                }
                messages.push(parsed.data);
            }
        }
        const summary = fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf8') : '';
        this.writeContext({ summary, messages });
        if (!fs.existsSync(this.transcriptPath) && messages.length > 0) {
            fs.writeFileSync(
                this.transcriptPath,
                `${messages.map(message => JSON.stringify(message)).join('\n')}\n`,
                'utf8',
            );
        }
    }
}
