import * as path from 'node:path';
import type { BootstrapView, SelfcraftMessage } from '../web/src/types/api.types';

/** 用合成对话和真实浏览器验证历史消息在连续发送后仍可见，不连接实际 Runtime */
async function main (): Promise<void> {
    if (!Bun.which('agent-browser')) throw new Error('请先安装 agent-browser CLI 及其浏览器，再执行此验收');
    const dist = path.resolve(import.meta.dir, '../web/dist');
    if (!await Bun.file(path.join(dist, 'index.html')).exists()) throw new Error('请先执行 bun run build:web');
    const session = `selfcraft-message-${crypto.randomUUID()}`;
    const messages: SelfcraftMessage[] = [];
    const readers = new Set<ReadableStreamDefaultController<Uint8Array>>();
    const encoder = new TextEncoder();
    let version = 0;

    /** 创建有稳定序号的合成消息，并返回保存的记录 */
    function append (role: 'user' | 'assistant', text: string): SelfcraftMessage {
        const seq = messages.length + 1;
        const message: SelfcraftMessage = { id: `${role}:${seq}`, role, parts: [{ type: 'text', text }],
            metadata: { seq, state: 'completed', occurredAt: new Date().toISOString() } };
        messages.push(message);
        return message;
    }

    /** 按真实 SSE 结构广播消息快照，供页面按 ID 合并 */
    function publish (items: SelfcraftMessage[]): void {
        const cursor = ++version;
        const data = encoder.encode(`id: ${cursor}\ndata: ${JSON.stringify({ items, cursor })}\n\n`);
        for (const reader of readers) reader.enqueue(data);
    }

    append('user', '其他入口提交的历史消息');
    append('assistant', '历史回复应始终可见');
    const server = Bun.serve({
        hostname: '127.0.0.1', port: 0, idleTimeout: 0,
        async fetch (request) {
            const pathname = new URL(request.url).pathname;
            if (pathname === '/api/bootstrap') return Response.json({
                product: 'Selfcraft', instanceId: 'web-smoke', configurationError: null,
                config: { configured: true, timezone: 'Asia/Shanghai', providers: [], defaultModel: null, modelOverrides: {}, webAccess: null },
                messages: { items: messages, nextCursor: null },
                runtime: { environment: 'test', home: '/test', workspace: '/test', pendingForegroundRuns: 0, checks: [] },
            } satisfies BootstrapView);
            if (pathname === '/api/conversation/events') {
                let reader: ReadableStreamDefaultController<Uint8Array>;
                return new Response(new ReadableStream<Uint8Array>({
                    start (controller) { reader = controller; readers.add(reader); publish(messages); },
                    cancel () { readers.delete(reader); },
                }), { headers: { 'Content-Type': 'text/event-stream' } });
            }
            if (pathname === '/api/conversation/messages') {
                // 保留真实请求等待阶段，覆盖旧末尾消息从 submitted 到非末尾的动画切换
                await Bun.sleep(200);
                const input = append('user', '网页发送的新消息');
                const reply = append('assistant', '新回复同样保持可见');
                reply.metadata!.state = 'streaming';
                publish([input, reply]);
                await Bun.sleep(200);
                reply.metadata!.state = 'completed';
                publish([reply]);
                return Response.json({ accepted: true });
            }
            if (pathname.startsWith('/api/')) return new Response('not found', { status: 404 });
            const file = path.resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
            if (!file.startsWith(`${dist}${path.sep}`)) return new Response('not found', { status: 404 });
            return new Response(Bun.file(file));
        },
    });

    /** 在独立浏览器会话执行命令，返回 JSON 结果并传播失败 */
    async function browser (...args: string[]): Promise<unknown> {
        const child = Bun.spawn(['agent-browser', '--session', session, '--json', ...args], { stdout: 'pipe', stderr: 'pipe' });
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        if (code) throw new Error(`${args[0]}: ${stderr || stdout}`);
        const response = JSON.parse(stdout) as { success: boolean; error?: string; data?: { result?: unknown } };
        if (!response.success) throw new Error(response.error || stdout);
        return response.data?.result;
    }

    /** 等待动画结束后检查每一条消息的实际尺寸，不能只检查 DOM 中存在文字 */
    async function assertVisible (): Promise<void> {
        await browser('wait', '--fn', `document.querySelectorAll('article[data-slot="message"]').length === ${messages.length} && document.querySelector('[role="log"]').getAttribute('aria-busy') === 'false'`);
        const failures = await browser('eval', `(async () => {
            const messages = [...document.querySelectorAll('article[data-slot="message"]')];
            await Promise.all(messages.flatMap(message => message.getAnimations().map(animation => animation.finished.catch(() => {}))));
            return messages.filter(message => {
                const rect = message.getBoundingClientRect();
                return rect.width < 1 || rect.height < 1 || Number(getComputedStyle(message).opacity) < 0.99;
            }).map(message => ({ text: message.textContent, transform: getComputedStyle(message).transform }));
        })()`);
        if (!Array.isArray(failures) || failures.length) throw new Error(`消息被隐藏：${JSON.stringify(failures)}`);
    }

    try {
        await browser('set', 'media', 'dark');
        await browser('open', server.url.href);
        await assertVisible();
        for (let turn = 0; turn < 2; turn++) {
            await browser('fill', 'textarea[aria-label="输入消息"]', '继续对话');
            await browser('press', 'Enter');
            await browser('wait', '--fn', `document.querySelectorAll('article[data-slot="message"]').length === ${4 + turn * 2}`);
            await assertVisible();
        }
        // 模拟其他入口推送后刷新页面，再从 Web 发送，覆盖用户报告的跨端路径
        publish([append('user', '其他入口的新消息'), append('assistant', '其他入口的新回复')]);
        await assertVisible();
        await browser('open', server.url.href);
        await assertVisible();
        await browser('fill', 'textarea[aria-label="输入消息"]', '刷新后继续');
        await browser('press', 'Enter');
        await browser('wait', '--fn', 'document.querySelectorAll(\'article[data-slot="message"]\').length === 10');
        await assertVisible();
        await browser('set', 'viewport', '390', '844');
        await browser('set', 'media', 'light', 'reduced-motion');
        await browser('open', server.url.href);
        await assertVisible();
        await browser('fill', 'textarea[aria-label="输入消息"]', '减少动态效果时继续');
        await browser('press', 'Enter');
        await browser('wait', '--fn', 'document.querySelectorAll(\'article[data-slot="message"]\').length === 12');
        await assertVisible();
        console.log(JSON.stringify({ healthy: true, historyVisible: true, repeatedSubmit: true, crossClientReload: true, mobileReducedMotion: true }));
    } finally {
        try { await browser('close'); } finally { server.stop(true); }
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
