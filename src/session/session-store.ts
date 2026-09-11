import * as fs from 'node:fs';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { assertStateVersion } from '../supervisor/state-version';
import { modelMessageSchema, type ModelMessage } from 'ai';

/** 持久会话快照 */
export interface SessionSnapshot {
    /** 已压缩的早期对话摘要 */
    summary: string;
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
    constructor (sessionsPath: string, sessionId = 'main') {
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
            this.database.query('UPDATE session_context SET snapshot = ? WHERE id = 1')
                .run(JSON.stringify({ ...snapshot, messages: [...snapshot.messages, ...messages] }));
            for (const message of messages) {
                this.database.query('INSERT INTO session_messages (message) VALUES (?)').run(JSON.stringify(message));
            }
        }).immediate();
    }

    /** 判断稳定提交是否已经写入，避免恢复时重复组装用户输入 */
    public hasAppend (id: string): boolean {
        return Boolean(this.database.query('SELECT id FROM session_appends WHERE id = ?').get(id));
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
            .run(JSON.stringify({ summary: summary.trim(), messages }));
    }

    /** 清空当前会话但保留目录 */
    public clear (): void {
        this.database.transaction(() => {
            this.replace('', []);
            this.database.run('DELETE FROM session_messages; DELETE FROM session_appends');
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
