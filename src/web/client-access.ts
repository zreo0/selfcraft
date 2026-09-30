import { Database } from 'bun:sqlite';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ConfigStore } from '../config/config-store';

/** 单用户各入口共享的实例身份和可轮换访问凭证 */
export class ClientAccess {
    public readonly instanceId: string;

    /** 从实例状态库读取稳定身份；地址和进程重启不影响身份 */
    constructor (databasePath: string, private readonly config: ConfigStore) {
        const database = new Database(databasePath);
        database.run('CREATE TABLE IF NOT EXISTS client_identity (id INTEGER PRIMARY KEY, instance_id TEXT NOT NULL)');
        database.query('INSERT OR IGNORE INTO client_identity VALUES (1, ?)').run(randomUUID());
        this.instanceId = (database.query('SELECT instance_id FROM client_identity WHERE id = 1').get() as { instance_id: string }).instance_id;
        database.close();
    }

    /** 尚未启用凭证的旧本地实例保留兼容；远程访问前必须启用 */
    public enabled (): boolean {
        return Boolean(this.config.credential('client-access'));
    }

    /** 恒定时间比较凭证，不在日志或响应中泄漏原文 */
    public matches (token: string): boolean {
        const expected = this.config.credential('client-access');
        if (!expected) return false;
        const a = Buffer.from(token);
        const b = Buffer.from(expected);
        return a.length === b.length && timingSafeEqual(a, b);
    }

    /** 浏览器使用短期签名 HttpOnly 会话，原始令牌不进入 Cookie */
    public session (): string {
        const expires = String(Date.now() + 7 * 86400_000);
        return `${expires}.${this.signature(expires)}`;
    }

    /** 校验原生 Bearer 或浏览器签名会话 */
    public authorized (request: Request): boolean {
        if (!this.enabled()) return true;
        const bearer = request.headers.get('authorization');
        if (bearer?.startsWith('Bearer ')) return this.matches(bearer.slice(7));
        const cookie = request.headers.get('cookie')?.split(';').map(value => value.trim())
            .find(value => value.startsWith('selfcraft_session='))?.slice('selfcraft_session='.length);
        if (!cookie) return false;
        const [expires, signature] = cookie.split('.');
        if (!expires || !signature || !Number.isFinite(Number(expires)) || Number(expires) < Date.now()) return false;
        const expected = Buffer.from(this.signature(expires));
        const actual = Buffer.from(signature);
        return actual.length === expected.length && timingSafeEqual(actual, expected);
    }

    /** 将会话有效期绑定到当前实例与凭证，轮换后旧会话自动失效 */
    private signature (expires: string): string {
        return createHmac('sha256', this.config.credential('client-access') || '').update(`${this.instanceId}:${expires}`).digest('hex');
    }
}
