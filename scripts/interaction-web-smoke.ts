import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { InteractionStore } from '../src/interaction/interaction-store';
import { InteractionError } from '../src/interaction/protocol';
import { ConversationStore } from '../src/conversation/conversation-store';

/** 用真实交互持久层和浏览器验证冲突、刷新、丢失回执及无遥测资源请求 */
async function main (): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'selfcraft-ui-web-'));
    const store = new InteractionStore(join(root, 'state.sqlite'));
    const conversation = new ConversationStore(join(root, 'state.sqlite'));
    const card = store.present('web-smoke', 'call', 'root = Form("selection", "选择验收目标", "三端共享同一份回答", [Choice("goal", "目标", true, [{value:"speed",label:"速度",description:"尽快完成"},{value:"quality",label:"质量",description:"充分验证"}]), Answer("note", "补充说明", false)])');
    store.reconcile(conversation);
    const dist = resolve(import.meta.dir, '../web/dist');
    const session = `selfcraft-ui-${crypto.randomUUID()}`;
    const readers = new Set<ReadableStreamDefaultController<Uint8Array>>();
    let submissions = 0;
    let interruptDrafts = false;

    /** 推送持久消息快照；重连可从数据库补读 */
    function publish (): void {
        const page = conversation.changes(0);
        const bytes = new TextEncoder().encode(`id: ${page.cursor}\ndata: ${JSON.stringify(page)}\n\n`);
        for (const reader of readers) reader.enqueue(bytes);
    }
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch (request) {
        const url = new URL(request.url);
        try {
            if (url.pathname === '/api/bootstrap') return Response.json({ product: 'Selfcraft', instanceId: 'interaction-smoke', configurationError: null,
                config: { configured: true, timezone: 'Asia/Shanghai', providers: [], defaultModel: null, modelOverrides: {}, webAccess: null },
                messages: conversation.page(), runtime: { environment: 'test', home: '/test', workspace: '/test', pendingForegroundRuns: 0, checks: [] } });
            if (url.pathname === '/api/conversation/events') {
                let current: ReadableStreamDefaultController<Uint8Array>;
                return new Response(new ReadableStream<Uint8Array>({ start (reader) { current = reader; readers.add(reader); publish(); },
                    cancel () { readers.delete(current); } }), { headers: { 'Content-Type': 'text/event-stream' } });
            }
            if (url.pathname === '/api/conversation/ui') return Response.json(store.list(Number(url.searchParams.get('after') || 0)));
            if (url.pathname.startsWith('/api/conversation/ui/submissions/')) {
                const receipt = store.receipt(url.pathname.split('/').at(-1)!);
                return Response.json(receipt || { error: '尚未接收' }, { status: receipt ? 200 : 404 });
            }
            if (url.pathname === `/api/conversation/ui/${card.id}`) return Response.json(store.get(card.id));
            if (url.pathname.endsWith('/state')) {
                if (interruptDrafts) return Response.json({ error: '其他客户端修改了表单，请核对最新版本' }, { status: 409 });
                const view = store.saveDraft(card.id, await request.json()); store.reconcile(conversation); publish(); return Response.json(view);
            }
            if (url.pathname.endsWith('/actions')) {
                submissions++; store.submit(card.id, await request.json()); store.reconcile(conversation);
                // 服务端已提交，故意丢失回执与本连接推送，验证客户端恢复而不生成新动作
                return Response.json({ error: '模拟接收后连接中断' }, { status: 503 });
            }
            if (url.pathname.startsWith('/api/')) return new Response('not found', { status: 404 });
            const file = resolve(dist, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
            return file.startsWith(dist + sep) ? new Response(Bun.file(file)) : new Response('not found', { status: 404 });
        } catch (error) { return Response.json({ error: String(error) }, { status: error instanceof InteractionError ? error.status : 500 }); }
    } });

    /** 在专用浏览器会话执行命令并传播失败 */
    async function browser (...args: string[]): Promise<unknown> {
        const child = Bun.spawn(['agent-browser', '--session', session, '--json', ...args], { stdout: 'pipe', stderr: 'pipe' });
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        if (code) throw new Error(`${JSON.stringify(args)}: ${stderr || stdout}`);
        const result = JSON.parse(stdout);
        if (!result.success) throw new Error(result.error);
        return result.data?.result ?? result.data;
    }

    /** 页面变化后重新读取可访问节点，避免使用旧的点击坐标 */
    async function pressButton (name: string): Promise<void> {
        const snapshot = await browser('snapshot', '-i') as { refs: Record<string, { role: string; name: string }> };
        const match = Object.entries(snapshot.refs).find(([, value]) => value.role === 'button' && value.name === name);
        if (!match) throw new Error(`找不到按钮 ${name}`);
        await browser('focus', '@' + match[0]);
        await browser('press', 'Enter');
    }

    try {
        await browser('open', server.url.href);
        await browser('wait', '--fn', `!!document.querySelector('input[aria-label="补充说明"]') && ![...document.querySelectorAll('button')].find(b => b.textContent === '提交回答')?.disabled`);
        await browser('snapshot', '-i');
        await pressButton('质量 充分验证');
        await browser('fill', 'input[aria-label="补充说明"]', '我的原始草稿');
        await browser('wait', '--fn', `JSON.parse(localStorage.getItem('selfcraft-ui:interaction-smoke:${card.id}')).revision > 1`);
        await browser('open', server.url.href);
        await browser('wait', '--fn', `document.querySelector('input[aria-label="补充说明"]')?.value === '我的原始草稿'`);
        interruptDrafts = true;
        await browser('fill', 'input[aria-label="补充说明"]', '本地未提交内容');
        const latest = store.get(card.id)!;
        store.saveDraft(card.id, { expectedRevision: latest.revision, values: { goal: 'speed', note: '另一端的草稿' } });
        store.reconcile(conversation); publish();
        await browser('wait', '--fn', `!![...document.querySelectorAll('button')].find(b => b.textContent === '核对最新版本并保留填写')`);
        await browser('open', server.url.href);
        await browser('wait', '--fn', `document.querySelector('input[aria-label="补充说明"]')?.value === '本地未提交内容' && !![...document.querySelectorAll('button')].find(b => b.textContent === '提交回答')?.disabled`);
        interruptDrafts = false;
        await pressButton('核对最新版本并保留填写');
        await browser('wait', '--fn', `![...document.querySelectorAll('button')].find(b => b.textContent === '提交回答')?.disabled`);
        await pressButton('提交回答');
        await browser('wait', '--fn', `!![...document.querySelectorAll('button')].find(b => b.textContent === '确认原提交结果')`);
        const pending = await browser('eval', `JSON.parse(localStorage.getItem('selfcraft-ui:interaction-smoke:${card.id}')).pending.submissionId`);
        if (pending !== store.get(card.id)!.submissionId) throw new Error('客户端未保留原提交标识');
        await browser('open', server.url.href);
        await browser('wait', '--fn', `document.body.textContent.includes('回答已接收，处理结果见后续对话')`);
        if (submissions !== 1) throw new Error('恢复后重复投递');
        await browser('wait', '--fn', `document.querySelector('[aria-label="已提交的回答"]')?.textContent.includes('本地未提交内容')`);
        const rawVisible = await browser('eval', `document.body.innerText.includes('以下 JSON 是用户数据') || document.body.innerText.includes('submissionId')`);
        if (rawVisible) throw new Error('用户气泡泄漏内部协议文字');
        for (const [width, theme] of [['1280', 'dark'], ['390', 'light']]) {
            await browser('set', 'viewport', width!, '844');
            await browser('set', 'media', theme!, 'reduced-motion');
            const dark = await browser('eval', "document.documentElement.classList.contains('dark')");
            if (dark !== (theme === 'dark')) await pressButton(theme === 'dark' ? '切换到深色主题' : '切换到浅色主题');
            await browser('wait', '--fn', `document.documentElement.classList.contains('dark') === ${theme === 'dark'}`);
            const overflow = await browser('eval', 'document.documentElement.scrollWidth > innerWidth');
            if (overflow) throw new Error('窄屏存在横向溢出');
            if (process.env.SELFCRAFT_UI_SCREENSHOT) await browser('screenshot', process.env.SELFCRAFT_UI_SCREENSHOT + `-${width}-${theme}.png`);
        }
        const external = await browser('eval', "performance.getEntriesByType('resource').map(r=>r.name).filter(url=>new URL(url).origin !== location.origin)");
        if (!Array.isArray(external) || external.length) throw new Error(`出现外部资源请求：${JSON.stringify(external)}`);
        if (process.env.SELFCRAFT_UI_SCREENSHOT) await browser('screenshot', process.env.SELFCRAFT_UI_SCREENSHOT);
        console.log(JSON.stringify({ healthy: true, draftReload: true, conflictReload: true, lostReceiptRecovery: true, submissionSummary: true, submissions, responsive: true, externalRequests: external.length }));
    } catch (error) {
        console.error(JSON.stringify({ server: store.get(card.id), submissions, browser: await browser('eval', `({ text: document.querySelector('[aria-label=\"选择验收目标\"]')?.innerText, local: localStorage.getItem('selfcraft-ui:interaction-smoke:${card.id}') })`) }));
        throw error;
    } finally {
        try { await browser('close'); } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
    }
}
main().catch(error => { console.error(String(error)); process.exitCode = 1; });
