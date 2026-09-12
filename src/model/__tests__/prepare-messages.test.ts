import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { prepareMessages } from '../prepare-messages';

describe('prepareMessages', () => {
    test('保留文本与工具闭环，移除私有推理信息且不改变原文', () => {
        const messages: ModelMessage[] = [
            { role: 'user', content: '查询' },
            { role: 'assistant', providerOptions: { openai: { itemId: 'old' } }, content: [
                { type: 'reasoning', text: '私有推理', providerOptions: { anthropic: { signature: 'signed' } } },
                { type: 'text', text: '查询中' },
                { type: 'tool-call', toolCallId: 'call-1', toolName: 'read', input: { path: 'a' } },
            ] },
            { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'read', output: { type: 'text', value: '结果' } }] },
        ];
        const original = structuredClone(messages);
        const prepared = prepareMessages(messages);
        expect(prepared).toHaveLength(3);
        expect(prepared[1]).not.toHaveProperty('providerOptions');
        expect(prepared[1].content).toHaveLength(2);
        expect(prepared[2]).toEqual(messages[2]);
        expect(messages).toEqual(original);
    });

    test('纯文本模型保留未读取标记，不让历史图片阻断对话', () => {
        const messages: ModelMessage[] = [{ role: 'user', content: [{ type: 'image', image: new URL('https://example.com/image.png') }] }];
        expect(JSON.stringify(prepareMessages(messages, false))).toContain('当前模型未读取像素');
        expect(prepareMessages(messages, true)).toEqual(messages);
    });
});
