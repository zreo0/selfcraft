import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { ContextManager } from '../context-manager';

describe('ContextManager', () => {
    test('溢出恢复从完整 user 边界保留最近交互', () => {
        const messages: ModelMessage[] = [
            { role: 'user', content: 'old '.repeat(3000) },
            { role: 'assistant', content: 'old response '.repeat(3000) },
            { role: 'user', content: 'recent request' },
            { role: 'assistant', content: 'recent response' },
        ];

        const recovered = new ContextManager().recoverFromOverflow(
            { summary: 'earlier summary', messages },
            4000,
            'system context',
        );

        expect(recovered.summary).toBe('earlier summary');
        expect(recovered.messages).toEqual(messages.slice(2));
        expect(recovered.messages[0].role).toBe('user');
    });

    test('只把 provider 的上下文类错误判定为可恢复溢出', () => {
        const context = new ContextManager();

        expect(context.isOverflowError(new Error('maximum context length exceeded'))).toBe(true);
        expect(context.isOverflowError(new Error('authentication failed'))).toBe(false);
    });
});
