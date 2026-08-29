// Source adapted from https://beui.dev/r/button
import { motion, useReducedMotion, type HTMLMotionProps } from 'motion/react';
import {
    forwardRef,
    type ReactNode,
} from 'react';
import { useHoverCapable } from '@/hooks/useHoverCapable';
import { SPRING_PRESS } from '@/lib/ease';
import { cn } from '@/lib/utils';

export type ButtonVariant = 'default' | 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive';
export type ButtonSize = 'default' | 'sm' | 'lg' | 'icon' | 'icon-sm';

export interface ButtonProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
    /** 按钮的语义外观 */
    variant?: ButtonVariant;
    /** 按钮的尺寸 */
    size?: ButtonSize;
    /** 按压时的缩放比例 */
    pressScale?: number;
    /** 按钮内容 */
    children?: ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
    default: 'bg-primary text-primary-foreground shadow-[0_10px_24px_-14px_var(--shadow-accent)] hover:bg-primary/90',
    primary: 'bg-primary text-primary-foreground shadow-[0_10px_24px_-14px_var(--shadow-accent)] hover:bg-primary/90',
    secondary: 'border border-border bg-secondary text-secondary-foreground hover:bg-muted',
    outline: 'border border-border bg-transparent text-foreground hover:border-foreground/15 hover:bg-muted',
    ghost: 'bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
    destructive: 'bg-destructive text-white hover:bg-destructive/90',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
    default: 'h-10 gap-2 rounded-xl px-4 text-sm',
    sm: 'h-8 gap-1.5 rounded-lg px-3 text-xs',
    lg: 'h-12 gap-2 rounded-xl px-5 text-base',
    icon: 'size-10 rounded-full',
    'icon-sm': 'size-8 rounded-lg',
};

/** 渲染带 BeUI 弹簧按压反馈的统一按钮 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button ({
    variant = 'default',
    size = 'default',
    pressScale = 0.94,
    className,
    children,
    type,
    ...props
}, ref) {
    const reduce = useReducedMotion();
    const canHover = useHoverCapable();

    return (
        <motion.button
            className={cn(
                'inline-flex shrink-0 select-none items-center justify-center font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-45',
                VARIANT_CLASS[variant],
                SIZE_CLASS[size],
                className,
            )}
            ref={ref}
            transition={SPRING_PRESS}
            type={type ?? 'button'}
            whileHover={reduce || !canHover ? undefined : { scale: 1.015 }}
            whileTap={reduce ? undefined : { scale: pressScale }}
            {...props}
        >
            {children}
        </motion.button>
    );
});
