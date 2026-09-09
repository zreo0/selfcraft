import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { ContextManager } from '../context-manager';

describe('ContextManager', () => {
    test('只在需要整理时解析模型，并按整理模型窗口分批请求', async () => {
        const model = new MockLanguageModelV4({ doGenerate: {
            content: [{ type: 'text', text: '保留的重要事实' }],
            finishReason: { unified: 'stop', raw: undefined },
            usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
            warnings: [],
        } });
        let resolutions = 0;
        /** 为本次整理解析一个小窗口模型 */
        function resolveCompression () {
            resolutions += 1;
            return { model, providerId: 'local', modelId: 'small', contextWindow: 4096, maxOutputTokens: 1000 };
        }
        const context = new ContextManager();
        await context.compactIfNeeded({ summary: '', messages: [] }, 16000, '', resolveCompression);
        expect(resolutions).toBe(0);
        const messages: ModelMessage[] = Array.from({ length: 20 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant', content: `${index}: ${'长历史'.repeat(1000)}`,
        }));
        const result = await context.compactIfNeeded({ summary: '', messages }, 16000, '', resolveCompression);
        expect(result.compacted).toBeTrue();
        expect(resolutions).toBe(1);
        expect(model.doGenerateCalls.length).toBeGreaterThan(1);
        for (const call of model.doGenerateCalls) {
            expect(JSON.stringify(call.prompt).length / 2 + (call.maxOutputTokens || 0)).toBeLessThan(4096);
        }
        expect(result.snapshot.messages).toEqual(messages.slice(12));
        expect(messages).toHaveLength(20);
    });
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
