import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileUIPart } from 'ai';
import { stopConversation, submitConversation, subscribeConversation } from '@/services/runtime';
import type { SelfcraftMessage } from '@/types/api.types';

/** 同一个持久对话可随时提交输入，消息展示独立订阅 Runtime */
export function useConversation () {
    const [messages, setMessages] = useState<SelfcraftMessage[]>([]);
    const [error, setError] = useState<Error | null>(null);
    const [submitting, setSubmitting] = useState(0);
    const failures = useRef(new Set<string>());
    useEffect(() => subscribeConversation(items => {
        setMessages(current => {
            const combined = new Map(current.map(message => [message.id, message]));
            for (const message of items) combined.set(message.id, message);
            return [...combined.values()].sort((a, b) => (a.metadata?.seq || 0) - (b.metadata?.seq || 0));
        });
        const last = items.at(-1);
        if (last?.metadata?.state === 'failed' && !failures.current.has(last.id)) {
            failures.current.add(last.id);
            setError(new Error('本次回复未完成，已保留内容和执行记录。可以补充要求或重试。'));
        }
    }), []);

    /** 提交失败保留错误，后台失败由持久消息状态呈现 */
    const sendMessage = useCallback(async (input: { text: string; files?: FileUIPart[]; metadata?: SelfcraftMessage['metadata'] }) => {
        setSubmitting(count => count + 1);
        try {
            await submitConversation({ id: crypto.randomUUID(), role: 'user', parts: [
                ...(input.text ? [{ type: 'text' as const, text: input.text }] : []), ...(input.files || []),
            ], metadata: input.metadata });
        } catch (cause) {
            setError(cause instanceof Error ? cause : new Error(String(cause)));
        } finally {
            setSubmitting(count => count - 1);
        }
    }, []);

    /** 重试最后一条用户请求，Runtime 判断工具是否允许安全接续 */
    const regenerate = useCallback(async () => {
        const message = messages.findLast(item => item.role === 'user');
        if (!message) return;
        try { await submitConversation(message, true); }
        catch (cause) { setError(cause instanceof Error ? cause : new Error(String(cause))); }
    }, [messages]);

    /** 显式停止只改变 Runtime 当前生成 */
    const stop = useCallback(async () => {
        try { await stopConversation(); }
        catch (cause) { setError(cause instanceof Error ? cause : new Error(String(cause))); }
    }, []);

    const status = messages.some(message => message.metadata?.state === 'streaming') ? 'streaming' : submitting ? 'submitted' : 'ready';
    return { messages, setMessages, sendMessage, regenerate, stop, error, clearError: () => setError(null), status };
}
