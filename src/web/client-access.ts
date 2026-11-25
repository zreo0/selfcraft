import { Database } from 'bun:sqlite';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ConfigStore } from '../config/config-store';

/** Web 登录与对话续期共用的有效秒数 */
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

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

    /**
     * 为登录或对话响应签发会话 Cookie
     * @param url 当前请求地址
     * @param token 已通过校验的连接凭证
     * @returns 供 Set-Cookie 使用的完整值
     */
    public sessionCookie (url: URL, token: string): string {
        const expires = String(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
        const session = `${expires}.${this.signature(expires, token)}`;
        return `selfcraft_session=${session}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SECONDS}${url.protocol === 'https:' ? '; Secure' : ''}`;
    }

    /**
     * 对话提交成功后为使用 Cookie 的浏览器续期
     * @param request 提交对话的请求
     * @param response 对话入口返回的响应
     * @returns 携带适用会话头的原响应
     */
    public renewSession (request: Request, response: Response): Response {
        if (!response.ok || request.headers.get('authorization')?.startsWith('Bearer ')) return response;
        // 消息处理期间凭证可能已轮换，须用同一份凭证校验旧会话并签发新会话
        const token = this.config.credential('client-access');
        if (token && this.validSession(request, token)) {
            response.headers.set('Set-Cookie', this.sessionCookie(new URL(request.url), token));
        }
        return response;
    }

    /** 校验原生 Bearer 或浏览器签名会话 */
    public authorized (request: Request): boolean {
        const token = this.config.credential('client-access');
        if (!token) return true;
        const bearer = request.headers.get('authorization');
        if (bearer?.startsWith('Bearer ')) return this.matches(bearer.slice(7));
        return this.validSession(request, token);
    }

    /**
     * 检查请求携带的浏览器会话是否仍然有效
     * @param request 待校验的请求
     * @param token 当前连接凭证
     * @returns 会话是否有效
     */
    private validSession (request: Request, token: string): boolean {
        const cookie = request.headers.get('cookie')?.split(';').map(value => value.trim())
            .find(value => value.startsWith('selfcraft_session='))?.slice('selfcraft_session='.length);
        if (!cookie) return false;
        const [expires, signature] = cookie.split('.');
        if (!expires || !signature || !Number.isFinite(Number(expires)) || Number(expires) <= Date.now()) return false;
        const expected = Buffer.from(this.signature(expires, token));
        const actual = Buffer.from(signature);
        return actual.length === expected.length && timingSafeEqual(actual, expected);
    }

    /**
     * 将会话绑定到当前实例与连接凭证
     * @param expires 会话到期时间戳
     * @param token 用于签名的连接凭证
     * @returns 十六进制签名
     */
    private signature (expires: string, token: string): string {
        return createHmac('sha256', token).update(`${this.instanceId}:${expires}`).digest('hex');
    }
}
