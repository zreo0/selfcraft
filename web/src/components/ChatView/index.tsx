import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { ArrowDown, Compass, History, RotateCcw, Settings2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
    Message,
    MessageContent,
    MessageHeader,
    MessageResponse,
} from '@/components/agents/message';
import { ThinkingShimmer } from '@/components/agents/loading-states/thinking-shimmer';
import { MessageScroller } from '@/components/agents/message-scroller';
import {
    PromptInput,
} from '@/components/agents/prompt-input';
import { Button } from '@/components/motion/button';
import { AssistantMurmur } from '@/components/AssistantMurmur';
import { BRAND_IMAGE_PATH } from '@/lib/brand';
import { getMessages } from '@/services/runtime';
import type { ConfigView, MessagePage, SelfcraftMessage } from '@/types/api.types';

const chatTransport = new DefaultChatTransport<SelfcraftMessage>({ api: '/api/chat' });

/** 从 AI SDK 消息中读取所有文本内容 */
function messageText (message: SelfcraftMessage): string {
    return message.parts
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('');
}

/** 使用本地时区显示消息时间 */
function messageTime (message: SelfcraftMessage): string | null {
    if (!message.metadata?.occurredAt) {
        return null;
    }
    return new Intl.DateTimeFormat('zh-CN', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    }).format(new Date(message.metadata.occurredAt));
}

/** Selfcraft 的持续对话主界面 */
export function ChatView ({
    config,
    initialMessage,
    initialMessages,
    initialCursor,
    onInitialMessageSent,
    onRequestSettings,
}: {
    config: ConfigView | null;
    initialMessage?: string;
    initialMessages: SelfcraftMessage[];
    initialCursor: number | null;
    onInitialMessageSent: () => void;
    onRequestSettings: () => void;
}) {
    const initialized = useRef(false);
    const initialMessageSent = useRef(false);
    const scrollerRef = useRef<HTMLElement>(null);
    const [input, setInput] = useState('');
    const [statusText, setStatusText] = useState<string | null>(null);
    const [nextCursor, setNextCursor] = useState(initialCursor);
    const [loadingHistory, setLoadingHistory] = useState(false);
    const [following, setFollowing] = useState(true);
    const {
        messages,
        setMessages,
        sendMessage,
        status,
        error,
        stop,
        clearError,
    } = useChat<SelfcraftMessage>({
        transport: chatTransport,
        onData: part => {
            if (
                part.type === 'data-status'
                && typeof part.data === 'object'
                && part.data !== null
                && typeof (part.data as { label?: unknown }).label === 'string'
            ) {
                setStatusText((part.data as { label: string }).label);
            }
        },
        onFinish: () => setStatusText(null),
        onError: () => setStatusText(null),
    });

    useEffect(() => {
        if (initialized.current) {
            return;
        }
        initialized.current = true;
        setMessages(initialMessages);
        setNextCursor(initialCursor);
    }, [initialCursor, initialMessages, setMessages]);

    useEffect(() => {
        if (!initialMessage || initialMessageSent.current) {
            return;
        }
        initialMessageSent.current = true;
        clearError();
        setStatusText('正在接住这句话');
        onInitialMessageSent();
        void sendMessage({
            text: initialMessage,
            metadata: { occurredAt: new Date().toISOString() },
        });
    }, [clearError, initialMessage, onInitialMessageSent, sendMessage]);

    /** 提交本轮新输入，历史上下文仍由服务端持有 */
    function handleSubmit (value: string): void {
        const text = value.trim();
        if (!text || status === 'submitted' || status === 'streaming') {
            return;
        }
        if (!config?.configured) {
            onRequestSettings();
            return;
        }
        clearError();
        setInput('');
        setStatusText('正在接住这句话');
        void sendMessage({
            text,
            metadata: { occurredAt: new Date().toISOString() },
        });
    }

    /** 让读者主动返回持续对话的最新位置 */
    function handleScrollToLatest (): void {
        const scroller = scrollerRef.current;
        if (!scroller) {
            return;
        }
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
        setFollowing(true);
    }

    /** 直接发送空状态中的建议问题 */
    function handleSuggestion (text: string): void {
        if (!config?.configured) {
            onRequestSettings();
            return;
        }
        clearError();
        setStatusText('正在接住这句话');
        void sendMessage({
            text,
            metadata: { occurredAt: new Date().toISOString() },
        });
    }

    /** 向时间线前方加载一页历史消息 */
    async function handleLoadEarlier (): Promise<void> {
        if (!nextCursor || loadingHistory) {
            return;
        }
        setLoadingHistory(true);
        try {
            const page: MessagePage = await getMessages(nextCursor);
            setMessages(current => {
                const existing = new Set(current.map(message => message.id));
                return [...page.items.filter(message => !existing.has(message.id)), ...current];
            });
            setNextCursor(page.nextCursor);
        } finally {
            setLoadingHistory(false);
        }
    }

    const generating = status === 'submitted' || status === 'streaming';
    const lastMessage = messages.at(-1);
    const lastMessageId = lastMessage?.id;
    const pendingAssistantId = generating && lastMessage?.role === 'assistant'
        ? lastMessage.id
        : null;
    return (
        <section className="chat-view">
            <h1 className="sr-only">持续对话</h1>

            <div className="conversation-stage">
                <MessageScroller
                    busy={generating}
                    className="h-full"
                    contentClassName="mx-auto flex w-full max-w-3xl flex-col gap-8 px-5 py-8 sm:px-8 sm:py-12"
                    onFollowChange={setFollowing}
                    viewportRef={scrollerRef}
                >
                    {nextCursor && (
                        <Button className="mx-auto" disabled={loadingHistory} onClick={() => void handleLoadEarlier()} size="sm" type="button" variant="ghost">
                            <History aria-hidden="true" className="size-3.5" />{loadingHistory ? '正在回想' : '查看更早的对话'}
                        </Button>
                    )}
                    {messages.length === 0 && (
                        <div className="conversation-empty-state">
                            <div className="empty-state-core"><span className="brand-core brand-core--large"><img alt="" src={BRAND_IMAGE_PATH} /></span></div>
                            <h2>{config?.configured ? '此刻，想从哪里开始？' : '先让我拥有思考的能力'}</h2>
                            <p>不必先整理成完整的问题。说一件正在发生的事，或者把一个还没想明白的念头放在这里。</p>
                            <div className="conversation-suggestions">
                                {config?.configured ? (
                                    <>
                                        <button onClick={() => handleSuggestion('帮我梳理一下今天最值得推进的事情')} type="button"><Compass aria-hidden="true" />梳理今天最值得推进的事</button>
                                        <button onClick={() => handleSuggestion('根据我们过去聊过的内容，你现在最想提醒我什么？')} type="button"><RotateCcw aria-hidden="true" />从过往里找一件值得提醒的事</button>
                                    </>
                                ) : (
                                    <Button onClick={onRequestSettings} type="button"><Settings2 aria-hidden="true" className="size-4" />配置模型</Button>
                                )}
                            </div>
                        </div>
                    )}
                    {messages.map(message => {
                        const from = message.role === 'user' ? 'user' : 'assistant';
                        const text = messageText(message);
                        const showThinking = message.id === pendingAssistantId && !text;
                        return (
                            <Message animateIn={message.id === lastMessageId && generating} from={from} key={message.id}>
                                <MessageContent>
                                    <MessageHeader>
                                        {from === 'assistant' && <span className="assistant-mark"><img alt="" src={BRAND_IMAGE_PATH} /></span>}
                                        <span>{from === 'user' ? '你' : 'Selfcraft'}</span>
                                        {messageTime(message) && <time>{messageTime(message)}</time>}
                                    </MessageHeader>
                                    {from === 'assistant' ? (
                                        showThinking ? (
                                            <div aria-live="polite" className="thinking-state">
                                                <ThinkingShimmer>{statusText || '正在思考'}</ThinkingShimmer>
                                            </div>
                                        ) : (
                                            <MessageResponse
                                                animated
                                                isAnimating={status === 'streaming' && message.id === lastMessageId}
                                            >
                                                {text}
                                            </MessageResponse>
                                        )
                                    ) : (
                                        <p className="message-user-surface whitespace-pre-wrap">{text}</p>
                                    )}
                                </MessageContent>
                            </Message>
                        );
                    })}
                    {(statusText || status === 'submitted') && !pendingAssistantId && (
                        <Message from="assistant">
                            <MessageContent>
                                <MessageHeader><span className="assistant-mark"><img alt="" src={BRAND_IMAGE_PATH} /></span><span>Selfcraft</span></MessageHeader>
                                <div aria-live="polite" className="thinking-state">
                                    <ThinkingShimmer>{statusText || '正在思考'}</ThinkingShimmer>
                                </div>
                            </MessageContent>
                        </Message>
                    )}
                    {error && (
                        <div className="chat-error" role="alert">
                            <strong>这次回应没有完成</strong>
                            <p>{error.message}</p>
                        </div>
                    )}
                </MessageScroller>
                {!following && (
                    <Button
                        aria-label="回到最新消息"
                        className="conversation-scroll-button"
                        onClick={handleScrollToLatest}
                        size="icon-sm"
                        type="button"
                        variant="outline"
                    >
                        <ArrowDown aria-hidden="true" className="size-4" />
                    </Button>
                )}
            </div>

            <div className="composer-dock">
                <div className="mx-auto w-full max-w-3xl">
                    <PromptInput
                        aria-label="输入消息"
                        disabled={!config?.configured}
                        loading={generating}
                        onStop={stop}
                        onSubmit={handleSubmit}
                        onValueChange={setInput}
                        placeholder={config?.configured ? '说说你正在想什么…' : '配置模型后就可以开始对话'}
                        value={input}
                    />
                    <AssistantMurmur />
                </div>
            </div>
        </section>
    );
}
