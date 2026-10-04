import { randomUUID } from 'node:crypto';
import { ConfigStore } from '../src/config/config-store';
import { resolvePaths } from '../src/config/paths';

/** 对测试容器验证录音幂等上传、转写、会话收件及 Web 共享历史，不替代真机 BLE 验收 */
async function main (): Promise<void> {
    const filename = process.env.SELFCRAFT_TEST_AUDIO;
    if (!filename) throw new Error('请用 SELFCRAFT_TEST_AUDIO 指定 16kHz 单声道 PCM WAV 测试录音');
    const address = process.env.SELFCRAFT_RUNTIME_URL || 'http://127.0.0.1:3210';
    const token = process.env.SELFCRAFT_ACCESS_TOKEN || new ConfigStore(resolvePaths().config).credential('client-access');
    if (!token) throw new Error('测试实例未配置客户端凭证');
    const headers = { Authorization: `Bearer ${token}` };
    const id = `pocket-${randomUUID().replaceAll('-', '')}`;
    const capturedAt = new Date().toISOString();
    const bytes = await Bun.file(filename).arrayBuffer();
    for (let attempt = 0; attempt < 2; attempt++) {
        const body = new FormData();
        body.set('capturedAt', capturedAt);
        body.set('file', new File([bytes], 'record.wav', { type: 'audio/wav' }));
        const response = await fetch(`${address}/api/audio/${id}`, { method: 'PUT', headers, body });
        if (!response.ok) throw new Error(`上传失败：${response.status}`);
    }
    const transcribed = await fetch(`${address}/api/audio/${id}/transcribe`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' });
    if (!transcribed.ok) {
        const result = await transcribed.json() as { error?: string };
        throw new Error(`转写失败：${transcribed.status} ${result.error || ''}`);
    }
    const record = await transcribed.json() as { text: string; duration: number };
    if (!record.text?.trim()) throw new Error('转写未返回文字');
    const body = JSON.stringify({ id, audioId: id, messages: [{ role: 'user', parts: [{ type: 'text', text: record.text }] }] });
    for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(`${address}/api/conversation/messages`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body });
        if (response.status !== 202) throw new Error(`收件失败：${response.status}`);
    }
    const receipt = await (await fetch(`${address}/api/conversation/receipts/${id}`, { headers })).json() as { status: string };
    if (!receipt.status) throw new Error('缺少持久回执');
    const login = await fetch(`${address}/api/access/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(address).origin }, body: JSON.stringify({ token }) });
    if (!login.ok) throw new Error('Web 登录失败');
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const page = await (await fetch(`${address}/api/messages`, { headers: { Cookie: cookie } })).json() as { items: { id: string; metadata?: { audio?: { id: string } } }[] };
    const messages = page.items.filter(message => message.id === `user:${id}`);
    if (messages.length !== 1 || messages[0]?.metadata?.audio?.id !== id) throw new Error('Web 历史缺少唯一语音消息');
    console.log(JSON.stringify({ success: true, id, duration: record.duration, transcription: record.text, receipt: receipt.status,
        assertions: ['idempotent audio upload', 'real transcription', 'idempotent conversation submission', 'Web sees one audio message'] }));
}

await main();
