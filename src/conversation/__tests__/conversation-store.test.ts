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
