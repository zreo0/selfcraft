import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { transcribe } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import type { ConfigStore } from '../config/config-store';
import { PathGuard } from '../tools/path-guard';

/** 可恢复的录音处理记录，文本不因原音删除而清除 */
export interface AudioRecord {
    /** 客户端稳定提交标识 */
    id: string;
    /** 音频真实时长 */
    duration: number;
    /** 客户端采集时间 */
    capturedAt: string;
    /** 音频摘要，防止相同标识被替换 */
    digest: string;
    /** Runtime 本地处理阶段 */
    status: 'saved' | 'transcribing' | 'ready' | 'failed' | 'deleted';
    /** 已识别文本 */
    text?: string;
}

/** PCM 录音最长两分钟，预留 WAV 头空间 */
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

/** 保存音频与转写结果，网络重试不产生另一条语音消息 */
export class AudioStore {
    private readonly database: Database;
    private readonly guard: PathGuard;
    private readonly running = new Map<string, Promise<AudioRecord>>();

    /** 打开实例音频目录并恢复被进程退出打断的转写 */
    constructor (home: string, databasePath: string, private readonly config: ConfigStore) {
        const directory = path.join(home, 'audio');
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        this.guard = new PathGuard(directory);
        this.database = new Database(databasePath);
        this.database.run('CREATE TABLE IF NOT EXISTS audio_records (id TEXT PRIMARY KEY, record TEXT NOT NULL)');
        this.database.run(`UPDATE audio_records SET record = json_set(record, '$.status', 'saved') WHERE json_extract(record, '$.status') = 'transcribing'`);
    }

    /** 校验标识后读取状态，不存在返回 null */
    public get (id: string): AudioRecord | null {
        if (!/^[a-zA-Z0-9-]{1,128}$/.test(id)) throw new Error('录音标识无效');
        const row = this.database.query('SELECT record FROM audio_records WHERE id = ?').get(id) as { record: string } | null;
        return row ? JSON.parse(row.record) : null;
    }

    /** 验证真实 WAV 内容后持久保存，重复请求校验内容摘要 */
    public async save (id: string, file: File, capturedAt: string): Promise<AudioRecord> {
        this.get(id);
        if (!file.size || file.size > MAX_AUDIO_BYTES) throw new Error('录音大小无效');
        if (!Number.isFinite(Date.parse(capturedAt))) throw new Error('录音时间无效');
        const bytes = Buffer.from(await file.arrayBuffer());
        const duration = wavDuration(bytes);
        const digest = createHash('sha256').update(bytes).digest('hex');
        // 读取文件是异步边界，返回后重新检查，避免并发上传替换同一标识
        const previous = this.get(id);
        if (previous) {
            if (previous.digest !== digest || previous.status === 'deleted') throw new Error('录音标识已使用，不能替换原件');
            return previous;
        }
        fs.writeFileSync(this.guard.resolveWrite(`${id}.wav`), bytes, { mode: 0o600 });
        const record: AudioRecord = { id, capturedAt, duration, digest, status: 'saved' };
        this.put(record);
        return record;
    }

    /** 枚举已转写的原音关联，补齐接收后意外退出造成的 UI 附件缺失 */
    public completed (): AudioRecord[] {
        const rows = this.database.query("SELECT record FROM audio_records WHERE json_extract(record, '$.text') IS NOT NULL").all() as { record: string }[];
        return rows.map(row => JSON.parse(row.record));
    }

    /** 读取原始录音，删除后不可播放 */
    public read (id: string): Buffer {
        const record = this.get(id);
        if (!record || record.status === 'deleted') throw new Error('原始录音不存在或已删除');
        return fs.readFileSync(this.guard.resolveRead(`${id}.wav`));
    }

    /** 复用进程内同一识别任务；完成结果持久缓存 */
    public transcribe (id: string): Promise<AudioRecord> {
        const existing = this.running.get(id);
        if (existing) return existing;
        const promise = this.performTranscription(id).finally(() => this.running.delete(id));
        this.running.set(id, promise);
        return promise;
    }

    /** 删除音频原件，保留文本与幂等记录 */
    public delete (id: string): AudioRecord {
        if (this.running.has(id)) throw new Error('请等待转写结束后删除');
        const record = this.get(id);
        if (!record) throw new Error('录音不存在');
        if (record.status !== 'deleted') fs.rmSync(this.guard.resolveWrite(`${id}.wav`), { force: true });
        return this.put({ ...record, status: 'deleted' });
    }

    /** 调用共享 SDK，失败仅保留阶段，不把供应商敏感错误写入消息 */
    private async performTranscription (id: string): Promise<AudioRecord> {
        const record = this.get(id);
        if (!record) throw new Error('请先上传录音');
        if (record.text) return record;
        const config = this.config.read().transcription;
        const apiKey = config && this.config.credential(config.credentialRef);
        if (!config || !apiKey) throw new Error('请先在设置中配置语音识别服务');
        const audio = this.read(id);
        this.put({ ...record, status: 'transcribing' });
        try {
            const provider = createOpenAI({ baseURL: config.baseURL, apiKey });
            const result = await transcribe({ model: provider.transcription(config.modelId), audio, maxRetries: 0, abortSignal: AbortSignal.timeout(90_000) });
            if (!result.text.trim()) throw new Error('未识别到文字');
            return this.put({ ...record, status: 'ready', text: result.text.trim() });
        } catch {
            this.put({ ...record, status: 'failed' });
            throw new Error('语音识别失败，录音已保留，请检查配置后重试');
        }
    }

    /** 原子替换单条处理记录并返回最新值 */
    private put (record: AudioRecord): AudioRecord {
        this.database.query('INSERT INTO audio_records VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record').run(record.id, JSON.stringify(record));
        return record;
    }
}

/** 从实际 PCM 块计算时长，拒绝格式伪装、截断和超长录音 */
export function wavDuration (bytes: Buffer): number {
    if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('请上传 WAV 录音');
    let rate = 0;
    let size = 0;
    for (let offset = 12; offset + 8 <= bytes.length;) {
        const tag = bytes.toString('ascii', offset, offset + 4);
        const length = bytes.readUInt32LE(offset + 4);
        const start = offset + 8;
        if (start + length > bytes.length) throw new Error('录音文件不完整');
        if (tag === 'fmt ') {
            if (length < 16 || bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 2) !== 1
                || bytes.readUInt32LE(start + 4) !== 16000 || bytes.readUInt16LE(start + 14) !== 16) throw new Error('录音须为 16kHz 单声道 16bit PCM');
            rate = 32000;
        }
        if (tag === 'data') size += length;
        offset = start + length + (length % 2);
    }
    const duration = size / rate;
    if (!Number.isFinite(duration) || duration <= 0 || duration > 120.1) throw new Error('录音须在两分钟以内');
    return duration;
}
