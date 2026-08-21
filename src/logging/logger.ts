import * as fs from 'node:fs';
import * as path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

/** 对日志中的常见凭证形态做最小脱敏 */
function redact (value: unknown): unknown {
    if (typeof value === 'string') {
        return value
            .replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-***')
            .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1***');
    }
    if (Array.isArray(value)) {
        return value.map(redact);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [
            key,
            /key|secret|authorization|credential/i.test(key) ? '***' : redact(item),
        ]));
    }
    return value;
}

/** 结构化日志记录器，文件到达上限后保留最近五份 */
export class Logger {
    private readonly filePath: string;
    private readonly minimumLevel: LogLevel;

    /**
     * 创建日志记录器
     *
     * @param logDirectory 日志目录
     * @param minimumLevel 最低记录级别
     */
    constructor (logDirectory: string, minimumLevel?: LogLevel) {
        fs.mkdirSync(logDirectory, { recursive: true });
        this.filePath = path.join(logDirectory, 'selfcraft.log');
        this.minimumLevel = minimumLevel || this.parseLevel(process.env.SELFCRAFT_LOG_LEVEL);
    }

    /** 记录调试信息 */
    public debug (message: string, context?: Record<string, unknown>): void {
        this.write('debug', message, context);
    }

    /** 记录普通运行信息 */
    public info (message: string, context?: Record<string, unknown>): void {
        this.write('info', message, context);
    }

    /** 记录可恢复问题 */
    public warn (message: string, context?: Record<string, unknown>): void {
        this.write('warn', message, context);
    }

    /** 记录执行失败 */
    public error (message: string, context?: Record<string, unknown>): void {
        this.write('error', message, context);
    }

    /**
     * 写入一条 JSONL 日志
     *
     * @param level 日志级别
     * @param message 人类可读消息
     * @param context 附加上下文
     */
    private write (level: LogLevel, message: string, context?: Record<string, unknown>): void {
        if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minimumLevel]) {
            return;
        }
        this.rotateIfNeeded();
        const entry = {
            time: new Date().toISOString(),
            level,
            message: redact(message),
            ...(context && { context: redact(context) }),
        };
        fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
        if (level === 'error' || (level === 'warn' && process.env.SELFCRAFT_ENV === 'development')) {
            console.error(`[${level.toUpperCase()}] ${message}`);
        }
    }

    /** 超过 5 MiB 时轮转并保留五份历史 */
    private rotateIfNeeded (): void {
        if (!fs.existsSync(this.filePath) || fs.statSync(this.filePath).size < 5 * 1024 * 1024) {
            return;
        }
        fs.rmSync(`${this.filePath}.5`, { force: true });
        for (let index = 4; index >= 1; index -= 1) {
            const source = `${this.filePath}.${index}`;
            if (fs.existsSync(source)) {
                fs.renameSync(source, `${this.filePath}.${index + 1}`);
            }
        }
        fs.renameSync(this.filePath, `${this.filePath}.1`);
    }

    /** 将未知环境值解析为日志级别 */
    private parseLevel (value?: string): LogLevel {
        return value && Object.hasOwn(LEVEL_ORDER, value) ? value as LogLevel : 'info';
    }
}
