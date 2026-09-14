import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { SessionStore } from '../../session/session-store';
import { ContextManager } from '../context-manager';

const roots: string[] = [];
/** 创建包含多轮原文的工作窗口 */
function fixture () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-context-'));
    roots.push(root);
    const store = new SessionStore(root);
    for (let index = 0; index < 12; index++) {
        store.append({ role: 'user', content: `事项 ${index}：${'历史材料'.repeat(250)}` },
            { role: 'assistant', content: `处理 ${index}：${'执行证据'.repeat(250)}` });
    }
    store.append({ role: 'user', content: '预算改为 300，取消旧方案，继续验证新方案' });
    const model = new MockLanguageModelV4({ doGenerate: {
        content: [{ type: 'text', text: '最新要求：预算 300，旧方案已取消 [message:25]。旧事项原文可回查 [message:1]，下一步验证新方案。' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
        warnings: [],
    } });
    const active = { model, providerId: 'test', modelId: 'test', contextWindow: 16000, maxOutputTokens: 1000 };
    return { root, store, model, active };
}
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

test('按预算交接并跨重启恢复笔记，原文和最新纠正仍可读', async () => {
    const { root, store, model, active } = fixture();
    const context = new ContextManager(6000);
    const before = store.loadTranscript();
    const next = await context.handoff(store, active, 500, () => ({ ...active, contextWindow: 128000, maxOutputTokens: 8192 }));
    expect(next.summary).toContain('预算 300');
    expect(next.messages.at(-1)?.content).toContain('取消旧方案');
    expect(context.estimateMessages(next.messages) + context.estimate(next.summary) + 500).toBeLessThanOrEqual(context.budgets(active).target);
    expect(model.doGenerateCalls.length).toBeGreaterThan(0);
    expect(model.doGenerateCalls[0]!.maxOutputTokens).toBe(8192);
    const restored = new SessionStore(root);
    expect(restored.load()).toEqual(next);
    expect(restored.loadTranscript()).toEqual(before);
    expect(restored.readHistory('message', 1).content).toContain('事项 0');
    expect(restored.searchHistory('note', '旧方案')).toHaveLength(1);
});

test('跨多个窗口保留各版笔记，完整工具调用不会被拆开', async () => {
    const { store, active } = fixture();
    const context = new ContextManager(6000);
    await context.handoff(store, active, 500, () => active);
    for (let index = 0; index < 8; index++) {
        store.append({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: `call-${index}`, toolName: 'read', input: { path: 'result.txt' } }] },
            { role: 'tool', content: [{ type: 'tool-result', toolCallId: `call-${index}`, toolName: 'read', output: { type: 'text', value: '历史证据'.repeat(500) } }] });
    }
    const next = await context.handoff(store, active, 500, () => active);
    expect(store.searchHistory('note')).toHaveLength(2);
    const calls = next.messages.flatMap(message => message.role === 'assistant' && Array.isArray(message.content) ? message.content : [])
        .filter(part => part.type === 'tool-call').map(part => part.toolCallId);
    const results = next.messages.flatMap(message => message.role === 'tool' ? message.content : [])
        .filter(part => part.type === 'tool-result').map(part => part.toolCallId);
    expect(calls).toEqual(results);
    expect(next.messages.some(message => typeof message.content === 'string' && message.content.includes('预算改为 300'))).toBeTrue();
    expect(store.readHistory('note', 1).content).toContain('预算 300');
});

test('笔记失败、引用无效和过期交接不会替换现有窗口', async () => {
    const { store, active } = fixture();
    const before = store.load();
    const failing = { ...active, model: new MockLanguageModelV4({ doGenerate: async () => { throw new Error('模型失败'); } }) };
    await expect(new ContextManager().handoff(store, active, 500, () => failing)).rejects.toThrow();
    expect(store.load()).toEqual(before);
    expect(() => store.handoff(before, '不存在 [message:999999]', [])).toThrow('原文引用');
    expect(store.searchHistory('note')).toHaveLength(0);
    store.append({ role: 'user', content: '新消息' });
    const newer = store.load();
    expect(() => store.handoff(before, '旧状态 [message:1]', [])).toThrow('上下文已变化');
    expect(store.load()).toEqual(newer);
});

test('整理模型使用自己的小窗口分批处理，笔记输入带稳定原文引用', async () => {
    const { store, active, model } = fixture();
    await new ContextManager(6000).handoff(store, active, 500, () => ({ ...active, contextWindow: 4096 }));
    expect(model.doGenerateCalls.length).toBeGreaterThan(1);
    for (const call of model.doGenerateCalls) {
        expect(JSON.stringify(call.prompt)).toContain('[message:');
        expect(JSON.stringify(call.prompt).length / 2 + (call.maxOutputTokens || 0)).toBeLessThan(4096);
    }
});
