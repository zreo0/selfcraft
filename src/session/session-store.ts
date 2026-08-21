import * as fs from 'node:fs';
import * as path from 'node:path';
import { modelMessageSchema, type ModelMessage } from 'ai';

/** 持久会话快照 */
export interface SessionSnapshot {
    /** 已压缩的早期对话摘要 */
    summary: string;
    /** 仍保留原文的近期消息 */
    messages: ModelMessage[];
}

/** 使用 JSONL 保存一个长期连续会话 */
export class SessionStore {
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
        this.migrateLegacy(sessionPath);
    }

    /**
     * 加载摘要与所有有效消息
     *
     * @returns 当前会话快照
     */
    public load (): SessionSnapshot {
        if (!fs.existsSync(this.contextPath)) {
            return { summary: '', messages: [] };
        }
        const value = JSON.parse(fs.readFileSync(this.contextPath, 'utf8')) as {
            summary?: unknown;
            messages?: unknown;
        };
        if (typeof value.summary !== 'string' || !Array.isArray(value.messages)) {
            throw new Error('会话上下文文件无效');
        }
        const messages = value.messages.map(message => {
            const parsed = modelMessageSchema.safeParse(message);
            if (!parsed.success) {
                throw new Error('会话上下文包含无效消息');
            }
            return parsed.data;
        });
        return { summary: value.summary, messages };
    }

    /**
     * 向会话追加消息
     *
     * @param messages AI SDK 标准消息
     */
    public append (...messages: ModelMessage[]): void {
        if (messages.length === 0) {
            return;
        }
        const serialized = messages.map(message => {
            modelMessageSchema.parse(message);
            return JSON.stringify(message);
        });
        const snapshot = this.load();
        this.writeContext({
            summary: snapshot.summary,
            messages: [...snapshot.messages, ...messages],
        });
        fs.appendFileSync(this.transcriptPath, `${serialized.join('\n')}\n`, 'utf8');
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
        this.writeContext({ summary: summary.trim(), messages });
    }

    /** 清空当前会话但保留目录 */
    public clear (): void {
        this.writeContext({ summary: '', messages: [] });
        fs.writeFileSync(this.transcriptPath, '', 'utf8');
    }

    /**
     * 读取不受上下文压缩影响的原始记录
     *
     * @param limit 最多返回最近消息数
     * @returns 按原始顺序排列的消息
     */
    public loadTranscript (limit = 1000): ModelMessage[] {
        if (!fs.existsSync(this.transcriptPath)) {
            return [];
        }
        const lines = fs.readFileSync(this.transcriptPath, 'utf8').split(/\r?\n/).filter(Boolean);
        return lines.slice(-Math.max(1, limit)).map(line => {
            const parsed = modelMessageSchema.safeParse(JSON.parse(line));
            if (!parsed.success) {
                throw new Error('原始会话记录包含无效消息');
            }
            return parsed.data;
        });
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
