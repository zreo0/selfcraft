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
