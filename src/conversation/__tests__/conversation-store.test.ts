import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConversationStore } from '../conversation-store';
import { ExecutionStore } from '../../execution/execution-store';
import { ForegroundRunner } from '../../agent/foreground-runner';

test('插话后的输出位于新输入之后，恢复只重建当前气泡且已完成执行不留下生成状态', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-delivery-'));
    try {
        const file = path.join(root, 'state.sqlite');
        const view = new ConversationStore(file);
        const executions = new ExecutionStore(file);
        executions.accept('root', '年报', 'foreground');
        view.receive('root', '年报');
        view.begin('root');
        view.append('root', { type: 'text-delta', delta: '已开始查询。' });
        view.receive('correction', '改查前年');
        view.continue('root', 'correction');
        view.append('root', { type: 'text-delta', delta: '收到修改。未提交文字' });
        const restored = new ConversationStore(file);
        restored.begin('root', '已开始查询。收到修改。');
        restored.continue('root', 'correction');
        const page = restored.page();
        expect(page.items.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
        expect(page.items.at(-1)?.parts).toEqual([{ type: 'text', text: '收到修改。' }]);
        expect(page.items[1]?.parts).toEqual([{ type: 'text', text: '已开始查询。' }]);
        const cursor = restored.changes(0).cursor;
        executions.setStatus('root', 'completed');
        const runner = new ForegroundRunner({ run: async () => { throw new Error('已完成执行不得重新运行'); } }, executions, undefined, restored);
        runner.recover(() => undefined);
        expect(restored.unfinished()).toHaveLength(0);
        expect(restored.changes(cursor).items.at(-1)?.metadata?.state).toBe('completed');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('两个客户端和重连共享相同持久消息，重复提交只运行一次', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-multi-client-'));
    try {
        const file = path.join(root, 'state.sqlite');
        const store = new ConversationStore(file);
        const executions = new ExecutionStore(file);
        let runs = 0;
        const runner = new ForegroundRunner({
            async run (_input, emit) {
                runs++;
                executions.begin('shared-id');
                emit?.({ type: 'text-delta', delta: '前半段' });
                await Bun.sleep(10);
                emit?.({ type: 'text-delta', delta: '后半段' });
                executions.setStatus('shared-id', 'completed');
                return { restartRequired: false };
            },
        }, executions, undefined, store);
        const first = runner.run('来自 iPhone', undefined, { executionId: 'shared-id' });
        const duplicate = runner.run('来自 iPhone', undefined, { executionId: 'shared-id' });
        const web = store.changes(0);
        const ios = new ConversationStore(file).changes(0);
        expect(ios).toEqual(web);
        await Promise.all([first, duplicate]);
        expect(runs).toBe(1);
        expect(runner.receipt('shared-id')?.status).toBe('completed');
        const restored = new ConversationStore(file);
        expect(restored.page().items).toHaveLength(2);
        expect(restored.changes(web.cursor).items.at(-1)?.parts).toEqual([{ type: 'text', text: '前半段后半段' }]);
        await runner.run('来自 iPhone', undefined, { executionId: 'shared-id' });
        expect(runs).toBe(1);
        expect(() => runner.run('替换输入', undefined, { executionId: 'shared-id' })).toThrow('其他输入');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('断线补读有界且修改旧消息不会被分页游标跳过，历史接口限制单页大小', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-paged-changes-'));
    try {
        const store = new ConversationStore(path.join(root, 'state.sqlite'));
        store.receive('initial', '初始');
        let cursor = store.changes(0).cursor;
        for (let index = 0; index < 250; index++) store.receive(`input-${index}`, `输入 ${index}`);
        const first = store.changes(cursor);
        expect(first.items).toHaveLength(100);
        expect(first.cursor).toBeLessThan(store.changes(0).cursor);
        const seen = new Map(first.items.map(item => [item.id, item]));
        cursor = first.cursor;
        store.attachAudio('input-0', { id: 'input-0', url: '/api/audio/input-0/file', duration: 1, deleted: true });
        while (true) {
            const page = store.changes(cursor);
            expect(page.items.length).toBeLessThanOrEqual(100);
            if (!page.items.length) break;
            expect(page.cursor).toBeGreaterThan(cursor);
            for (const item of page.items) seen.set(item.id, item);
            cursor = page.cursor;
        }
        expect(seen.size).toBe(250);
        expect(seen.get('user:input-0')?.metadata?.audio?.deleted).toBe(true);
        expect(store.changes(cursor)).toEqual({ items: [], cursor });
        expect(store.page(10_000).items).toHaveLength(100);
        expect(store.page(-1).items).toHaveLength(1);
        expect(store.changes(cursor + 100).items).toHaveLength(50);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
