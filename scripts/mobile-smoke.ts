import { randomUUID } from 'node:crypto';
import { ConfigStore } from '../src/config/config-store';
import { resolvePaths } from '../src/config/paths';
import { RuntimeClient } from '../src/cli/runtime-client';
import type { ConversationMessage } from '../src/conversation/conversation-store';

/** 检查真实测试实例的 Web Cookie、原生 Bearer、CLI 共享收件与订阅 */
async function main (): Promise<void> {
    const baseURL = process.env.SELFCRAFT_RUNTIME_URL || 'http://127.0.0.1:3210';
    const token = process.env.SELFCRAFT_ACCESS_TOKEN || new ConfigStore(resolvePaths().config).credential('client-access');
    if (!token) throw new Error('请先为测试实例配置连接凭证');
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const login = await fetch(`${baseURL}/api/access/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(baseURL).origin }, body: JSON.stringify({ token }) });
    if (!login.ok) throw new Error('Web 登录失败');
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const identity = await (await fetch(`${baseURL}/api/connection`, { headers })).json() as { instanceId: string };
    const webIdentity = await (await fetch(`${baseURL}/api/connection`, { headers: { Cookie: cookie } })).json() as { instanceId: string };
    if (identity.instanceId !== webIdentity.instanceId) throw new Error('各入口实例身份不一致');
    const id = randomUUID();
    const marker = `MULTI_CLIENT_${id.slice(0, 8)}`;
    const body = JSON.stringify({ id, messages: [{ role: 'user', parts: [{ type: 'text', text: `This is a temporary client integration test. Do not use tools or store memories. Reply exactly: ${marker}` }] }] });
    // 两个持久订阅先建立；断开其中一个不应停止服务端生成
    const controller = new AbortController();
    const observed = new Map<string, ConversationMessage>();
    const client = new RuntimeClient(baseURL, Object.assign((input: URL | RequestInfo, init?: RequestInit) => {
        const requestHeaders = new Headers(init?.headers);
        requestHeaders.set('Authorization', `Bearer ${token}`);
        return fetch(input, { ...init, headers: requestHeaders });
    }, { preconnect: fetch.preconnect }) as typeof fetch);
    const subscription = client.subscribe(items => { for (const item of items) observed.set(item.id, item); }, controller.signal);
    try {
        const results = await Promise.all([
            fetch(`${baseURL}/api/conversation/messages`, { method: 'POST', headers, body }),
            fetch(`${baseURL}/api/conversation/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body }),
        ]);
        if (results.some(result => result.status !== 202)) throw new Error('并发收件失败');
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
            const receipt = await (await fetch(`${baseURL}/api/conversation/receipts/${id}`, { headers })).json() as { status: string };
            if (receipt.status === 'completed') break;
            if (['failed', 'blocked'].includes(receipt.status)) throw new Error('模型执行未完成');
            await Bun.sleep(300);
        }
        const page = await (await fetch(`${baseURL}/api/messages`, { headers: { Cookie: cookie } })).json() as { items: ConversationMessage[] };
        const user = page.items.filter(item => item.id === `user:${id}`);
        const reply = page.items.filter(item => item.id === `assistant:${id}`);
        if (user.length !== 1 || reply.length !== 1 || reply[0]!.metadata?.state !== 'completed') throw new Error('持久历史重复或未完成');
        if (!JSON.stringify(reply[0]!.parts).includes(marker)) throw new Error('真实模型没有返回预期标识');
        const deliveryDeadline = Date.now() + 12_000;
        while (Date.now() < deliveryDeadline && observed.get(`assistant:${id}`)?.metadata?.state !== 'completed') await Bun.sleep(200);
        if (observed.get(`assistant:${id}`)?.metadata?.state !== 'completed') throw new Error(`CLI 订阅未收到最终快照: count=${observed.size}, status=${observed.get(`assistant:${id}`)?.metadata?.state}`);
        console.log(JSON.stringify({ success: true, instanceId: identity.instanceId, submissionId: id,
            assertions: ['Web Cookie and iOS Bearer share instance', 'duplicate submission produces one user message and reply', 'CLI live subscription receives completed reply', 'Web history retains reply after request completion'], marker }));
    } finally { controller.abort(); await subscription.catch(() => undefined); }
}

await main();
