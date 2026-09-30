import { Database } from 'bun:sqlite';
import type { UIMessage, UserModelMessage } from 'ai';
import type { AgentActivity, AgentRunEvent } from '../agent/run-events';
import { userContentFiles } from '../model/user-content';

/** UI 记录只描述交付，不参与模型上下文组装 */
export type ConversationMessage = UIMessage<{
    seq: number;
    occurredAt: string;
    state: 'streaming' | 'completed' | 'failed';
    executionId?: string;
    audio?: { id: string; url: string; duration: number; deleted: boolean };
}, { activity: { status: 'working' | 'complete'; items: AgentActivity[] } }>;

/** 与请求连接无关的持久消息视图，所有入口按版本补齐最新记录 */
export class ConversationStore {
    private readonly database: Database;

    /** 打开 Runtime 状态库，创建消息视图和递增版本 */
    constructor (databasePath: string) {
        this.database = new Database(databasePath);
        this.database.run(`CREATE TABLE IF NOT EXISTS conversation_messages (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
            message TEXT NOT NULL, version INTEGER NOT NULL
        ); CREATE TABLE IF NOT EXISTS conversation_clock (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
        INSERT OR IGNORE INTO conversation_clock VALUES (1, 0);
        CREATE INDEX IF NOT EXISTS conversation_execution ON conversation_messages (json_extract(message, '$.metadata.executionId'), seq);
        CREATE INDEX IF NOT EXISTS conversation_version ON conversation_messages (version);`);
    }

    /** 持久显示已接收输入；重复投递复用原消息 */
    public receive (id: string, content: UserModelMessage['content']): void {
        if (this.get(`user:${id}`)) return;
        const parts: ConversationMessage['parts'] = typeof content === 'string' ? [{ type: 'text', text: content }]
            : content.flatMap<ConversationMessage['parts'][number]>(part => part.type === 'text' ? [part] : userContentFiles([part]));
        this.save({ id: `user:${id}`, role: 'user', parts,
            metadata: { seq: 0, occurredAt: new Date().toISOString(), state: 'completed', executionId: id } });
    }

    /** 将原音关联到已接收的文字，附件不进入模型输入 */
    public attachAudio (id: string, audio: { id: string; url: string; duration: number; deleted: boolean }, capturedAt?: string): void {
        const message = this.get(`user:${id}`);
        if (!message) return;
        message.metadata!.audio = audio;
        if (capturedAt) message.metadata!.occurredAt = capturedAt;
        this.save(message);
    }

    /** 开始或恢复一次答复，未完成的模型文本不冒充已提交的执行结果 */
    public begin (id: string, committedText = ''): void {
        const replies = this.replies(id);
        const existing = replies.at(-1);
        const previousTextLength = replies.slice(0, -1).reduce((length, message) => length
            + message.parts.filter(part => part.type === 'text').map(part => part.text).join('').length, 0);
        this.save({ id: existing?.id || `assistant:${id}`, role: 'assistant',
            parts: [{ type: 'text', text: committedText.slice(previousTextLength) }],
            metadata: { seq: existing?.metadata?.seq || 0, occurredAt: existing?.metadata?.occurredAt || new Date().toISOString(), state: 'streaming', executionId: id } });
    }

    /** 在接收新输入的模型边界开始新气泡，保持显示顺序与对话发生顺序一致 */
    public continue (id: string, inputId: string): void {
        const messageId = `assistant:${id}:${inputId}`;
        if (this.get(messageId)) return;
        this.finish(id);
        this.save({ id: messageId, role: 'assistant', parts: [{ type: 'text', text: '' }],
            metadata: { seq: 0, occurredAt: new Date().toISOString(), state: 'streaming', executionId: id } });
    }

    /** 同一执行可以跨多条交付消息，内部仍共用一个模型会话 */
    private replies (id: string): ConversationMessage[] {
        const rows = this.database.query("SELECT message FROM conversation_messages WHERE json_extract(message, '$.metadata.executionId') = ? AND json_extract(message, '$.role') = 'assistant' ORDER BY seq")
            .all(id) as { message: string }[];
        return rows.map(row => JSON.parse(row.message));
    }

    /** 保存流式文字、工具状态和来源，断线不影响继续写入 */
    public append (id: string, event: AgentRunEvent): void {
        if (event.type === 'status') return;
        const message = this.replies(id).at(-1)!;
        if (event.type === 'text-delta') {
            const text = message.parts.find(part => part.type === 'text');
            if (text?.type === 'text') text.text += event.delta;
        } else if (event.type === 'activity') {
            let group = message.parts.find(part => part.type === 'data-activity');
            if (!group) {
                group = { type: 'data-activity', data: { status: 'working', items: [] } };
                message.parts.unshift(group);
            }
            if (group.type === 'data-activity') {
                const index = group.data.items.findIndex(item => item.id === event.activity.id);
                if (index < 0) group.data.items.push(event.activity);
                else group.data.items[index] = event.activity;
            }
        } else if (!message.parts.some(part => part.type === 'source-url' && part.sourceId === event.source.id)) {
            message.parts.push({ type: 'source-url', sourceId: event.source.id, url: event.source.url, title: event.source.title });
        }
        this.save(message);
    }

    /** 结束交付记录，失败时保留已输出内容 */
    public finish (id: string, failed = false): void {
        const message = this.replies(id).at(-1);
        if (!message) return;
        message.metadata!.state = failed ? 'failed' : 'completed';
        for (const part of message.parts) {
            if (part.type === 'data-activity') {
                part.data.status = 'complete';
                if (failed) for (const item of part.data.items) {
                    if (item.state === 'running') item.state = 'error';
                }
            }
        }
        this.save(message);
    }

    /** 幂等导入已有历史；新记录沿用当前数据库顺序 */
    public import (messages: UIMessage[]): void {
        for (const message of messages) {
            if (!this.get(message.id)) this.save({ ...message, metadata: {
                ...(message.metadata as ConversationMessage['metadata']), seq: 0, state: 'completed',
                occurredAt: (message.metadata as { occurredAt?: string })?.occurredAt || new Date().toISOString(),
            } } as ConversationMessage);
        }
    }

    /** 返回当前消息，没有记录时返回 null */
    public get (id: string): ConversationMessage | null {
        const row = this.database.query('SELECT message FROM conversation_messages WHERE id = ?').get(id) as { message: string } | null;
        return row ? JSON.parse(row.message) : null;
    }

    /** 找出尚未封口的交付，启动时与执行终态核对 */
    public unfinished (): ConversationMessage[] {
        const rows = this.database.query("SELECT message FROM conversation_messages WHERE json_extract(message, '$.metadata.state') = 'streaming'").all() as { message: string }[];
        return rows.map(row => JSON.parse(row.message));
    }

    /** 返回有序历史页，刷新时包含尚在生成的消息 */
    public page (limit = 50, before = Number.MAX_SAFE_INTEGER): { items: ConversationMessage[]; nextCursor: number | null } {
        limit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.trunc(limit))) : 50;
        const rows = this.database.query('SELECT message FROM conversation_messages WHERE seq < ? ORDER BY seq DESC LIMIT ?').all(before, limit) as { message: string }[];
        const items: ConversationMessage[] = rows.reverse().map(row => JSON.parse(row.message));
        return { items, nextCursor: items.length === limit ? items[0]!.metadata!.seq : null };
    }

    /** 返回上次订阅后改变的消息快照，重复接收按消息 ID 覆盖即可 */
    public changes (after: number): { items: ConversationMessage[]; cursor: number } {
        return this.database.transaction(() => {
            const { version } = this.database.query('SELECT version FROM conversation_clock WHERE id = 1').get() as { version: number };
            if (after === version) return { items: [], cursor: version };
            if (after <= 0 || after > version) {
                const rows = (this.database.query('SELECT message FROM conversation_messages ORDER BY seq DESC LIMIT 50').all() as { message: string }[]).reverse();
                return { items: rows.map(row => JSON.parse(row.message)), cursor: version };
            }
            // 按修改版本分页，游标只越过已交付内容；旧消息在补读期间再更新仍会被下一批读到
            const rows = this.database.query('SELECT message, version FROM conversation_messages WHERE version > ? ORDER BY version LIMIT 101')
                .all(after) as { message: string; version: number }[];
            const page = rows.slice(0, 100);
            return { items: page.map(row => JSON.parse(row.message)), cursor: rows.length > 100 ? page.at(-1)!.version : version };
        })();
    }

    /** 原子更新消息和版本，订阅不会跨过尚未保存的内容 */
    private save (message: ConversationMessage): void {
        this.database.transaction(() => {
            this.database.run('UPDATE conversation_clock SET version = version + 1 WHERE id = 1');
            const { version } = this.database.query('SELECT version FROM conversation_clock WHERE id = 1').get() as { version: number };
            this.database.query('INSERT INTO conversation_messages (id, message, version) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET message = excluded.message, version = excluded.version')
                .run(message.id, JSON.stringify(message), version);
            const { seq } = this.database.query('SELECT seq FROM conversation_messages WHERE id = ?').get(message.id) as { seq: number };
            message.metadata!.seq = seq;
            this.database.query('UPDATE conversation_messages SET message = ? WHERE id = ?').run(JSON.stringify(message), message.id);
        }).immediate();
    }
}
