// Source adapted from https://beui.dev/r/message-scroller/raw
import { useReducedMotion } from 'motion/react';
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    type ComponentPropsWithRef,
    type Ref,
} from 'react';
import { cn } from '@/lib/utils';

export interface MessageScrollerProps extends ComponentPropsWithRef<'div'> {
    /** 阅读者位于末端时是否跟随流式输出 */
    followOutput?: boolean;
    /** 仍被视作位于末端的距离 */
    followThreshold?: number;
    /** 是否平滑跟随增长中的内容 */
    smooth?: boolean;
    /** 阅读者离开或返回最新位置时触发 */
    onFollowChange?: (following: boolean) => void;
    /** 可访问名称 */
    label?: string;
    /** 是否仍在等待新内容 */
    busy?: boolean;
    /** 滚动视口样式 */
    viewportClassName?: string;
    /** 消息内容样式 */
    contentClassName?: string;
    /** 暴露滚动视口 */
    viewportRef?: Ref<HTMLElement>;
}

/** 渲染会尊重阅读位置的 BeUI Message Scroller */
export function MessageScroller ({
    followOutput = true,
    followThreshold = 56,
    smooth = true,
    onFollowChange,
    label = '持续对话',
    busy,
    viewportClassName,
    contentClassName,
    viewportRef: externalViewportRef,
    className,
    children,
    ...props
}: MessageScrollerProps) {
    const reduce = useReducedMotion() ?? false;
    const viewportRef = useRef<HTMLElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const followingRef = useRef(followOutput);
    const programmaticScrollRef = useRef(false);
    const scrollTimerRef = useRef<number | undefined>(undefined);
    const frameRef = useRef<number | undefined>(undefined);

    /** 同步内部与外部滚动容器引用 */
    const setViewportRef = useCallback((node: HTMLElement | null) => {
        viewportRef.current = node;
        if (typeof externalViewportRef === 'function') {
            externalViewportRef(node);
        } else if (externalViewportRef) {
            externalViewportRef.current = node;
        }
    }, [externalViewportRef]);

    /** 更新是否跟随最新内容 */
    const setFollowing = useCallback((next: boolean) => {
        if (followingRef.current === next) {
            return;
        }
        followingRef.current = next;
        onFollowChange?.(next);
    }, [onFollowChange]);

    /** 将时间线滚动到最新位置 */
    const scrollToEnd = useCallback((behavior: ScrollBehavior) => {
        const viewport = viewportRef.current;
        if (!viewport) {
            return;
        }
        programmaticScrollRef.current = true;
        viewport.scrollTo({ top: viewport.scrollHeight, behavior });
        if (scrollTimerRef.current) {
            window.clearTimeout(scrollTimerRef.current);
        }
        scrollTimerRef.current = window.setTimeout(() => {
            programmaticScrollRef.current = false;
        }, behavior === 'smooth' ? 320 : 0);
    }, []);

    /** 根据读者当前距离决定是否继续跟随输出 */
    function handleScroll (): void {
        const viewport = viewportRef.current;
        if (!viewport || programmaticScrollRef.current) {
            return;
        }
        const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
        setFollowing(distance <= followThreshold);
    }

    useLayoutEffect(() => {
        followingRef.current = followOutput;
        if (!followOutput) {
            return;
        }
        frameRef.current = requestAnimationFrame(() => scrollToEnd('auto'));
        return () => {
            if (frameRef.current) {
                cancelAnimationFrame(frameRef.current);
            }
        };
    }, [followOutput, scrollToEnd]);

    useEffect(() => {
        const content = contentRef.current;
        if (!content) {
            return;
        }
        const observer = new ResizeObserver(() => {
            if (followOutput && followingRef.current) {
                scrollToEnd(reduce || !smooth ? 'auto' : 'smooth');
            }
        });
        observer.observe(content);
        return () => observer.disconnect();
    }, [followOutput, reduce, scrollToEnd, smooth]);

    useEffect(() => () => {
        if (scrollTimerRef.current) {
            window.clearTimeout(scrollTimerRef.current);
        }
        if (frameRef.current) {
            cancelAnimationFrame(frameRef.current);
        }
    }, []);

    return (
        <div className={cn('min-h-0', className)} data-slot="message-scroller" {...props}>
            <section
                aria-label={label}
                className={cn(
                    'h-full overflow-y-auto overscroll-contain outline-none [overflow-anchor:none] [scrollbar-gutter:stable] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                    viewportClassName,
                )}
                onKeyDown={event => {
                    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) {
                        programmaticScrollRef.current = false;
                    }
                }}
                onScroll={handleScroll}
                onTouchStart={() => {
                    programmaticScrollRef.current = false;
                }}
                onWheel={() => {
                    programmaticScrollRef.current = false;
                }}
                ref={setViewportRef}
            >
                <div
                    aria-busy={busy}
                    aria-live="polite"
                    aria-relevant="additions text"
                    className={contentClassName}
                    ref={contentRef}
                    role="log"
                >
                    {children}
                </div>
            </section>
        </div>
    );
}
