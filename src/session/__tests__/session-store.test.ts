import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionStore } from '../session-store';

const temporaryDirectories: string[] = [];

/** 创建并追踪测试临时目录 */
function createTemporaryDirectory (): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-session-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('SessionStore', () => {
    test('重启后保留长期会话和压缩摘要', () => {
        const sessionsPath = createTemporaryDirectory();
        const first = new SessionStore(sessionsPath);
        first.append({ role: 'user', content: 'remember this' });
        first.replace('Earlier facts', first.load().messages);

        const restored = new SessionStore(sessionsPath).load();
        expect(restored.summary).toBe('Earlier facts');
        expect(restored.messages).toEqual([{ role: 'user', content: 'remember this' }]);
    });

    test('上下文压缩不会删除原始会话记录', () => {
        const sessionsPath = createTemporaryDirectory();
        const store = new SessionStore(sessionsPath);
        store.append(
            { role: 'user', content: 'old request' },
            { role: 'assistant', content: 'old response' },
            { role: 'user', content: 'recent request' },
        );

        store.replace('old request was completed', [{ role: 'user', content: 'recent request' }]);

        expect(store.load().messages).toHaveLength(1);
        expect(store.loadTranscript().map(message => message.content)).toEqual([
            'old request',
            'old response',
            'recent request',
        ]);
    });
});

test('旧实例一次性迁移保留原文，后续稳定提交跨重启去重', () => {
    const root = createTemporaryDirectory();
    const directory = path.join(root, 'main');
    fs.mkdirSync(directory);
    const user = { role: 'user', content: '以前交代的事项' };
    fs.writeFileSync(path.join(directory, 'context.json'), JSON.stringify({ summary: '摘要', messages: [user] }));
    const original = `${JSON.stringify(user)}\n`;
    fs.writeFileSync(path.join(directory, 'transcript.jsonl'), original);
    const first = new SessionStore(root);
    first.appendOnce('reply:1', { role: 'assistant', content: '已接续' });
    const restored = new SessionStore(root);
    restored.appendOnce('reply:1', { role: 'assistant', content: '已接续' });
    expect(restored.loadTranscript()).toHaveLength(2);
    expect(restored.load().summary).toBe('摘要');
    expect(fs.readFileSync(path.join(directory, 'transcript.jsonl'), 'utf8')).toBe(original);
});


test('历史按稳定 ID 分页，窗口交接后仍能读取完整消息与附件引用', () => {
    const store = new SessionStore(createTemporaryDirectory());
    const first = { role: 'user' as const, content: [
        { type: 'text' as const, text: '验收关键词' + 'A'.repeat(9000) },
        { type: 'file' as const, data: '/api/attachments/example.png', mediaType: 'image/png' },
    ] };
    store.append(first, { role: 'assistant', content: '已处理验收关键词' });
    const snapshot = store.load();
    store.handoff(snapshot, '已处理 [message:1]', [2]);
    expect(store.searchHistory('message', '验收关键词', undefined, 1)[0]?.id).toBe(2);
    expect(store.searchHistory('message', '验收关键词', 2)[0]?.id).toBe(1);
    let content = '';
    let offset: number | null = 0;
    while (offset !== null) {
        const page = store.readHistory('message', 1, offset, 1000);
        content += page.content;
        offset = page.nextOffset;
    }
    expect(JSON.parse(content)).toEqual(first);
    expect(store.load().messageIds).toEqual([2]);
    expect(store.searchHistory('message', '%')).toHaveLength(0);
});
