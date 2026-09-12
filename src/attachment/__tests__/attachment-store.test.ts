import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ModelMessage } from 'ai';
import { AttachmentStore, MAX_IMAGE_BYTES } from '../attachment-store';
import { ExecutionStore } from '../../execution/execution-store';
import { prepareMessages } from '../../model/prepare-messages';
import { SessionStore } from '../../session/session-store';

const roots: string[] = [];
/** 创建测试实例，退出时统一清理 */
function fixture () {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-images-'));
    roots.push(home);
    return { home, attachments: new AttachmentStore(home) };
}
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

test('图片经过执行队列和会话序列化后仍可物化，换成纯文本模型保留引用且不改原文', async () => {
    const { home, attachments } = fixture();
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1sAAAAASUVORK5CYII=', 'base64');
    const uploaded = await attachments.save(new File([bytes], 'pixel.png', { type: 'image/png' }));
    const part = attachments.reference(uploaded);
    const database = path.join(home, 'state.sqlite');
    const first = new ExecutionStore(database);
    first.accept('text', '原有文字', 'foreground');
    first.accept('image', [part], 'foreground');
    const restored = new ExecutionStore(database);
    const input = restored.get('image')!.input;
    expect(restored.get('text')!.input).toBe('原有文字');
    expect(() => restored.accept('image', input, 'foreground')).not.toThrow();
    expect(() => restored.accept('image', '其他输入', 'foreground')).toThrow();
    const session = new SessionStore(path.join(home, 'sessions'));
    session.appendOnce('image', { role: 'user', content: input });
    const history = new SessionStore(path.join(home, 'sessions')).load().messages;
    const original = JSON.stringify(history);
    const store = new AttachmentStore(home);
    const native = prepareMessages(history, true, file => store.materialize(file));
    expect(JSON.stringify(native)).toContain('"type":"data"');
    expect(store.read(uploaded.url).bytes).toEqual(bytes);
    const textOnly = prepareMessages(history, false);
    expect(JSON.stringify(textOnly)).toContain(uploaded.url);
    expect(JSON.stringify(textOnly)).toContain('未读取像素');
    expect(JSON.stringify(textOnly)).not.toContain('"type":"file"');
    expect(JSON.stringify(history)).toBe(original);
    const missing: ModelMessage[] = [{ role: 'user', content: [{ ...part, data: { type: 'url', url: new URL(`http://selfcraft.local/api/attachments/${'a'.repeat(64)}.png`) } }] }];
    expect(JSON.stringify(prepareMessages(missing, true, file => store.materialize(file)))).toContain('暂时无法读取');
});

test('附件边界拒绝非图片、超限、外部 URL 和越界路径，重复内容复用原件', async () => {
    const { attachments } = fixture();
    await expect(attachments.save(new File(['<svg/>'], 'fake.png', { type: 'image/png' }))).rejects.toThrow('仅支持');
    await expect(attachments.save(new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], 'large.png'))).rejects.toThrow('10 MB');
    expect(() => attachments.read('https://example.com/test.png')).toThrow();
    expect(() => attachments.read('/api/attachments/../../config/secrets.json')).toThrow();
    const bytes = new Uint8Array([255, 216, 255, 224]);
    const first = await attachments.save(new File([bytes], 'one.jpg'));
    const second = await attachments.save(new File([bytes], 'two.jpg'));
    expect(first.url).toBe(second.url);
    expect(first.mediaType).toBe('image/jpeg');
});


test('旧执行表增补文件内容列后保留既有文字与状态', () => {
    const { home } = fixture();
    const file = path.join(home, 'legacy.sqlite');
    const old = new Database(file);
    old.run("CREATE TABLE executions (id TEXT PRIMARY KEY, input TEXT NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL, messages TEXT NOT NULL DEFAULT '[]', result TEXT, retry INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, error TEXT)");
    old.query("INSERT INTO executions (id, input, channel, status, created_at) VALUES ('old', '原有输入', 'foreground', 'queued', '2026-09-12')").run();
    old.close();
    const upgraded = new ExecutionStore(file);
    expect(upgraded.get('old')?.input).toBe('原有输入');
    expect(upgraded.pending().map(item => item.id)).toEqual(['old']);
    expect(upgraded.accept('old', '原有输入', 'foreground').status).toBe('queued');
});
