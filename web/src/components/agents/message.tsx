// Source adapted from https://beui.dev/r/message/raw
import { motion, useReducedMotion, type HTMLMotionProps } from 'motion/react';
import { createContext, memo, useContext, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

export type MessageFrom = 'user' | 'assistant';

const MessageContext = createContext<{ from: MessageFrom }>({ from: 'assistant' });
const MESSAGE_POP_UP = {
    type: 'spring',
    stiffness: 480,
    damping: 32,
    mass: 0.62,
} as const;

export interface MessageProps extends Omit<HTMLMotionProps<'article'>, 'children'> {
    /** 消息发送方 */
    from: MessageFrom;
    /** 是否只在新增消息挂载时执行尾部弹出 */
    animateIn?: boolean;
    /** 消息内容 */
    children: ReactNode;
}

/** 渲染带发送方语义和新增反馈的 BeUI Message */
export function Message ({
    from,
    animateIn = false,
    children,
    className,
    initial,
    animate,
    transition,
    exit,
    style,
    ...props
}: MessageProps) {
    const reduce = useReducedMotion() ?? false;

    return (
        <MessageContext.Provider value={{ from }}>
            <motion.article
                animate={animate ?? (animateIn && !reduce
                    ? { opacity: 1, transform: 'translateY(0px) scale(1)' }
                    : { opacity: 1 })}
                aria-label={props['aria-label'] ?? (from === 'user' ? '用户消息' : 'Selfcraft 消息')}
                className={cn(
                    'group/message flex w-full items-start gap-2',
                    from === 'user' ? 'flex-row-reverse' : 'flex-row',
                    className,
                )}
                data-from={from}
                data-slot="message"
                exit={exit ?? (reduce
                    ? { opacity: 0 }
                    : { opacity: 0, transform: 'translateY(-3px) scale(0.99)' })}
                initial={initial ?? (animateIn && !reduce
                    ? { opacity: 0, transform: 'translateY(8px) scale(0.95)' }
                    : false)}
                style={{
                    transformOrigin: from === 'user' ? '100% 100%' : '0% 100%',
                    ...style,
                }}
                transition={transition ?? (reduce ? { duration: 0.12 } : MESSAGE_POP_UP)}
                {...props}
            >
                {children}
            </motion.article>
        </MessageContext.Provider>
    );
}

/** 组织 BeUI Message 的元信息和正文 */
export function MessageContent ({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
    const { from } = useContext(MessageContext);
    return (
        <div
            className={cn(
                'flex min-w-0 flex-1 flex-col gap-1.5',
                from === 'user' ? 'items-end' : 'items-start',
                className,
            )}
            data-slot="message-content"
            {...props}
        />
    );
}

/** 渲染与消息方向一致的 BeUI Message 元信息 */
export function MessageHeader ({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
    const { from } = useContext(MessageContext);
    return (
        <div
            className={cn(
                'flex items-center gap-1.5 text-[11px] leading-none text-muted-foreground',
                from === 'user' ? 'justify-end' : 'justify-start',
                className,
            )}
            data-slot="message-header"
            {...props}
        />
    );
}

/** 将 Agent Markdown 回复渲染为稳定的消息正文 */
export const MessageResponse = memo(function MessageResponse ({
    children,
    className,
}: {
    children: string;
    className?: string;
    animated?: boolean;
    isAnimating?: boolean;
}) {
    return (
        <div className={cn('message-response max-w-none text-pretty', className)}>
            <Markdown remarkPlugins={[remarkGfm]}>{children}</Markdown>
        </div>
    );
});
