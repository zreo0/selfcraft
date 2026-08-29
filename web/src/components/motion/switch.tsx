// Source adapted from https://beui.dev/r/switch/raw
import { animate, motion, MotionConfig, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

const THUMB_SPRING = {
    type: 'spring',
    stiffness: 800,
    damping: 80,
    mass: 4,
} as const;

export interface SwitchProps {
    /** 当前开关状态 */
    checked: boolean;
    /** 状态变化回调 */
    onCheckedChange: (checked: boolean) => void;
    /** 是否禁用 */
    disabled?: boolean;
    /** 无可见标题时使用的可访问名称 */
    ariaLabel?: string;
    /** 自定义样式 */
    className?: string;
}

/** 渲染具有重量感拇指反馈的 BeUI 开关 */
export function Switch ({
    checked,
    onCheckedChange,
    disabled,
    ariaLabel,
    className,
}: SwitchProps) {
    const thumbRef = useRef<HTMLDivElement>(null);
    const reduce = useReducedMotion();
    const [pressed, setPressed] = useState(false);

    useEffect(() => {
        if (!thumbRef.current || reduce || !disabled || !pressed) {
            return;
        }
        animate(thumbRef.current, { x: [0, -2, 2, -1, 0] }, { delay: 0.2, duration: 0.6 });
    }, [disabled, pressed, reduce]);

    return (
        <MotionConfig transition={reduce ? { duration: 0 } : THUMB_SPRING}>
            <motion.button
                aria-checked={checked}
                aria-label={ariaLabel}
                className={cn(
                    'inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full px-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
                    checked ? 'justify-end bg-primary' : 'justify-start bg-muted-foreground/45',
                    className,
                )}
                data-state={checked ? 'checked' : 'unchecked'}
                disabled={disabled}
                onClick={() => onCheckedChange(!checked)}
                onPointerDown={() => setPressed(true)}
                onPointerLeave={() => setPressed(false)}
                onPointerUp={() => setPressed(false)}
                role="switch"
                type="button"
            >
                <motion.div
                    animate={{ scale: pressed && !reduce ? 0.9 : 1 }}
                    className="pointer-events-none size-5 rounded-full bg-background shadow-[0_3px_8px_-4px_var(--shadow)]"
                    layout
                    ref={thumbRef}
                />
            </motion.button>
        </MotionConfig>
    );
}
