import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExecutionStore } from '../execution-store';

const roots: string[] = [];
/** 创建隔离执行库，返回路径供重启测试 */
function fixture (): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-execution-'));
    roots.push(root);
    return path.join(root, 'state.sqlite');
}
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

test('接收但尚未执行的前台输入跨重启保留顺序，重复标识不复制', () => {
    const file = fixture();
    const first = new ExecutionStore(file);
    first.accept('one', '先做一', 'foreground');
    first.accept('two', '再做二', 'foreground');
    first.accept('one', '先做一', 'foreground');
    expect(new ExecutionStore(file).pending().map(item => item.id)).toEqual(['one', 'two']);
    expect(() => first.accept('one', '其他输入', 'foreground')).toThrow('其他输入');
});

test('工具完成后模型响应未完成，重启能重建工具闭环而无需重放', () => {
    const file = fixture();
    const first = new ExecutionStore(file);
    first.accept('run', 'write file', 'foreground');
    first.begin('run');
    first.startTool('run', 'call', 'write', { path: 'files/a.txt' });
    first.finishTool('run', 'call', { written: true });
    const restored = new ExecutionStore(file);
    expect(restored.begin('run').messages).toEqual([
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call', toolName: 'write', input: { path: 'files/a.txt' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call', toolName: 'write', output: { type: 'json', value: { written: true } } }] },
    ]);
    expect(restored.begin('run').messages).toHaveLength(2);
});

test('并行工具中有未知结果时整体暂停，并保留已完成结果', () => {
    const file = fixture();
    const first = new ExecutionStore(file);
    first.accept('run', '外部工作', 'background');
    first.begin('run');
    first.startTool('run', 'a', 'shell', { command: 'something' });
    first.startTool('run', 'b', 'write', { path: 'b' });
    first.finishTool('run', 'b', { done: true });
    expect(() => first.checkpoint('run', [])).toThrow('结果未知');
    const restored = new ExecutionStore(file);
    expect(restored.begin('run').status).toBe('blocked');
    expect(() => restored.startTool('run', 'c', 'shell', {})).toThrow('执行已停止');
});

test('最终文本检查点在交付前崩溃仍可恢复', () => {
    const file = fixture();
    const first = new ExecutionStore(file);
    first.accept('run', 'hello', 'foreground');
    first.begin('run');
    first.checkpoint('run', [{ role: 'assistant', content: 'done' }], 'done');
    expect(new ExecutionStore(file).begin('run').result).toBe('done');
});
