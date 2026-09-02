// Source adapted from https://beui.dev/r/message-bubble.json
import { ChevronDown } from 'lucide-react';
import { motion, useReducedMotion, type HTMLMotionProps } from 'motion/react';
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useId,
    useLayoutEffect,
    useRef,
    useState,
    type ComponentPropsWithRef,
    type ReactNode,
} from 'react';
import { EASE_OUT, SPRING_LAYOUT, SPRING_SWAP } from '@/lib/ease';
import { cn } from '@/lib/utils';

/** 消息气泡支持的表面样式 */
export type MessageBubbleVariant = 'solid' | 'soft' | 'tint' | 'outline' | 'ghost' | 'danger';

/** 消息气泡在消息行中的对齐方向 */
export type MessageBubbleAlign = 'start' | 'end';

interface MessageBubbleContextValue {
    /** 气泡在消息行中的对齐方向 */
    align: MessageBubbleAlign;
    /** 是否播放首次出现动画 */
    animateIn: boolean;
    /** 气泡使用的表面样式 */
    variant: MessageBubbleVariant;
}

const MessageBubbleContext = createContext<MessageBubbleContextValue>({
    align: 'start',
    animateIn: false,
    variant: 'soft',
});

const MessageBubbleLayoutContext = createContext<() => void>(() => {});

export interface MessageBubbleProps extends Omit<HTMLMotionProps<'div'>, 'children'> {
    /** 气泡使用的表面样式 */
    variant?: MessageBubbleVariant;
    /** 气泡在消息行中的对齐方向 */
    align?: MessageBubbleAlign;
    /** 是否播放首次出现动画 */
    animateIn?: boolean;
    /** 气泡正文 */
    children?: ReactNode;
}

export interface MessageBubbleCollapsibleProps extends ComponentPropsWithRef<'div'> {
    /** 受控展开状态 */
    open?: boolean;
    /** 非受控模式下的初始展开状态 */
    defaultOpen?: boolean;
    /** 展开状态变化回调 */
    onOpenChange?: (open: boolean) => void;
    /** 收起时保留的正文行数 */
    collapsedLines?: 2 | 3 | 4 | 5 | 6;
    /** 展开按钮文案 */
    moreLabel?: ReactNode;
    /** 收起按钮文案 */
    lessLabel?: ReactNode;
    /** 正文区域样式 */
    contentClassName?: string;
    /** 展开按钮样式 */
    triggerClassName?: string;
    /** 可折叠正文 */
    children?: ReactNode;
}

/** 气泡正文出现时使用的轻量淡入参数 */
const BUBBLE_CONTENT_REVEAL = {
    duration: 0.12,
    ease: EASE_OUT,
    delay: 0.04,
} as const;

/** 新消息气泡落位时使用的克制弹簧参数 */
const BUBBLE_POP = {
    type: 'spring',
    stiffness: 520,
    damping: 27,
    mass: 0.52,
} as const;

/** 不同折叠行数对应的 Tailwind 行截断类 */
const LINE_CLAMP_CLASS = {
    2: 'line-clamp-2',
    3: 'line-clamp-3',
    4: 'line-clamp-4',
    5: 'line-clamp-5',
    6: 'line-clamp-6',
} as const;

/** 渲染可独立对齐并响应布局变化的 BeUI 消息气泡 */
export function MessageBubble ({
    variant = 'soft',
    align = 'start',
    animateIn = false,
    className,
    children,
    initial,
    animate,
    exit,
    transition,
    layout,
    ...props
}: MessageBubbleProps) {
    const reduce = useReducedMotion() ?? false;

    return (
        <MessageBubbleContext.Provider value={{ align, animateIn, variant }}>
            <motion.div
                animate={animate}
                className={cn(
                    'group/bubble flex w-full flex-col',
                    align === 'end' ? 'items-end' : 'items-start',
                    className,
                )}
                data-align={align}
                data-slot="message-bubble"
                data-variant={variant}
                exit={exit ?? (reduce ? { opacity: 0 } : { opacity: 0, y: -3, scale: 0.99 })}
                initial={initial ?? false}
                layout={layout}
                transition={transition ?? (reduce ? { duration: 0.12 } : SPRING_LAYOUT)}
                {...props}
            >
                {children}
            </motion.div>
        </MessageBubbleContext.Provider>
    );
}

/** 组合不同视觉层级下的气泡正文样式 */
function bubbleContentClass (variant: MessageBubbleVariant): string {
    return cn(
        'relative z-0 min-w-9 max-w-[82%] rounded-2xl px-3.5 py-2.5 text-sm leading-6 text-foreground',
        variant === 'solid' && 'text-background',
        variant === 'ghost' && 'w-full max-w-none rounded-none px-0 py-0',
        variant === 'danger' && 'text-destructive',
    );
}

/** 组合不同视觉层级下的气泡表面样式 */
function bubbleSurfaceClass (variant: MessageBubbleVariant, align: MessageBubbleAlign): string {
    return cn(
        'pointer-events-none absolute inset-0 -z-10 rounded-[inherit]',
        align === 'end' ? 'origin-bottom-right' : 'origin-bottom-left',
        variant === 'solid' && 'bg-foreground',
        variant === 'soft' && 'bg-muted',
        variant === 'tint' && 'bg-user-message',
        variant === 'outline' && 'border border-border/70 bg-background',
        variant === 'danger' && 'bg-destructive/10',
    );
}

/** 渲染会随正文高度平滑变化的气泡表面与内容 */
export function MessageBubbleContent ({
    className,
    children,
    ref,
    ...props
}: ComponentPropsWithRef<'div'>) {
    const reduce = useReducedMotion() ?? false;
    const { align, animateIn, variant } = useContext(MessageBubbleContext);
    const [layoutVersion, setLayoutVersion] = useState(0);

    /** 通知表面重新计算正文展开后的尺寸 */
    const notifyLayout = useCallback(() => {
        setLayoutVersion(version => version + 1);
    }, []);

    return (
        <div
            className={cn(bubbleContentClass(variant), className)}
            data-slot="message-bubble-content"
            ref={ref}
            {...props}
        >
            {variant !== 'ghost' && (
                <motion.span
                    animate={{ opacity: 1, scale: 1 }}
                    aria-hidden="true"
                    className={bubbleSurfaceClass(variant, align)}
                    initial={animateIn && !reduce ? { opacity: 0, scale: 0.92 } : false}
                    layout={reduce ? false : 'size'}
                    layoutDependency={layoutVersion}
                    transition={reduce
                        ? { duration: 0 }
                        : {
                            opacity: { duration: 0.12, ease: EASE_OUT },
                            scale: BUBBLE_POP,
                            layout: SPRING_LAYOUT,
                        }}
                />
            )}
            <MessageBubbleLayoutContext.Provider value={notifyLayout}>
                <motion.div
                    animate={{ opacity: 1 }}
                    className="relative"
                    initial={animateIn ? { opacity: 0 } : false}
                    transition={reduce ? { duration: 0.12, ease: EASE_OUT } : BUBBLE_CONTENT_REVEAL}
                >
                    {children}
                </motion.div>
            </MessageBubbleLayoutContext.Provider>
        </div>
    );
}

/** 渲染只在正文实际超出行数时出现的展开与收起控件 */
export function MessageBubbleCollapsible ({
    open,
    defaultOpen = false,
    onOpenChange,
    collapsedLines = 4,
    moreLabel = '展开',
    lessLabel = '收起',
    contentClassName,
    triggerClassName,
    className,
    children,
    ...props
}: MessageBubbleCollapsibleProps) {
    const reduce = useReducedMotion() ?? false;
    const contentId = useId();
    const contentRef = useRef<HTMLDivElement>(null);
    const notifyLayout = useContext(MessageBubbleLayoutContext);
    const [internalOpen, setInternalOpen] = useState(defaultOpen);
    const [canCollapse, setCanCollapse] = useState(false);
    const currentOpen = open ?? internalOpen;

    /** 根据折叠状态下的真实高度判断正文是否需要展开按钮 */
    const measureOverflow = useCallback(() => {
        const content = contentRef.current;
        if (!content || currentOpen) {
            return;
        }
        setCanCollapse(content.scrollHeight > content.clientHeight + 1);
    }, [currentOpen]);

    useLayoutEffect(() => {
        measureOverflow();
    }, [children, collapsedLines, measureOverflow]);

    useEffect(() => {
        const content = contentRef.current;
        if (!content) {
            return;
        }
        const observer = new ResizeObserver(measureOverflow);
        observer.observe(content);
        return () => observer.disconnect();
    }, [measureOverflow]);

    /** 更新展开状态并通知气泡表面同步尺寸 */
    const setOpen = useCallback((next: boolean) => {
        notifyLayout();
        if (open === undefined) {
            setInternalOpen(next);
        }
        onOpenChange?.(next);
    }, [notifyLayout, onOpenChange, open]);

    return (
        <div
            className={cn('w-full', className)}
            data-slot="message-bubble-collapsible"
            data-state={currentOpen ? 'open' : 'closed'}
            {...props}
        >
            <div
                className={cn(
                    'transition-[mask-image] duration-200',
                    !currentOpen && LINE_CLAMP_CLASS[collapsedLines],
                    !currentOpen && canCollapse && '[mask-image:linear-gradient(to_bottom,#000_68%,transparent_100%)]',
                    contentClassName,
                )}
                id={contentId}
                ref={contentRef}
            >
                {children}
            </div>
            {canCollapse && (
                <button
                    aria-controls={contentId}
                    aria-expanded={currentOpen}
                    className={cn(
                        'mt-2 inline-flex h-7 items-center gap-1 rounded-full px-2 text-xs font-medium text-foreground/65 outline-none transition-colors hover:bg-primary/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
                        triggerClassName,
                    )}
                    onClick={() => setOpen(!currentOpen)}
                    type="button"
                >
                    <span>{currentOpen ? lessLabel : moreLabel}</span>
                    <motion.span
                        animate={{ rotate: currentOpen ? 180 : 0 }}
                        aria-hidden="true"
                        transition={reduce ? { duration: 0 } : SPRING_SWAP}
                    >
                        <ChevronDown className="size-3.5" />
                    </motion.span>
                </button>
            )}
        </div>
    );
}
