// Source adapted from https://beui.dev/r/animated-badge/raw
import { AlertTriangle, Check, Circle, LoaderCircle, X, type LucideIcon } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'motion/react';
import type { ReactNode } from 'react';
import { EASE_OUT } from '@/lib/ease';
import { cn } from '@/lib/utils';

export type AnimatedBadgeStatus = 'neutral' | 'info' | 'success' | 'danger' | 'loading';

const STATUS_CLASS: Record<AnimatedBadgeStatus, string> = {
    neutral: 'border-border bg-card text-muted-foreground',
    info: 'border-primary/22 bg-primary/8 text-primary',
    success: 'border-primary/22 bg-primary/8 text-primary',
    danger: 'border-destructive/25 bg-destructive/8 text-destructive',
    loading: 'border-primary/22 bg-primary/8 text-primary',
};

const ICONS: Record<AnimatedBadgeStatus, LucideIcon> = {
    neutral: Circle,
    info: Circle,
    success: Check,
    danger: X,
    loading: LoaderCircle,
};

const CONTENT_VARIANTS: Variants = {
    initial: { opacity: 0, y: '80%', filter: 'blur(5px)' },
    animate: {
        opacity: 1,
        y: 0,
        filter: 'blur(0px)',
        transition: { type: 'spring', stiffness: 210, damping: 24, mass: 0.85 },
    },
    exit: {
        opacity: 0,
        y: '-80%',
        filter: 'blur(5px)',
        transition: { duration: 0.18, ease: EASE_OUT },
    },
};

/** 展示会平滑响应状态变化的 BeUI 徽章 */
export function AnimatedBadge ({
    status = 'neutral',
    children,
    icon,
    contentKey,
    className,
}: {
    status?: AnimatedBadgeStatus;
    children: ReactNode;
    icon?: ReactNode;
    contentKey?: string | number;
    className?: string;
}) {
    const reduce = useReducedMotion();
    const Icon = ICONS[status] ?? AlertTriangle;
    const key = contentKey ?? (typeof children === 'string' ? children : status);
    return (
        <motion.span
            className={cn('relative inline-flex h-7 shrink-0 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full border px-2.5 text-xs font-medium tabular-nums', STATUS_CLASS[status], className)}
            layout
        >
            <AnimatePresence initial={false} mode="popLayout">
                <motion.span
                    animate={reduce ? { opacity: 1 } : 'animate'}
                    aria-hidden="true"
                    className="inline-flex"
                    exit={reduce ? undefined : 'exit'}
                    initial={reduce ? false : 'initial'}
                    key={status}
                    variants={CONTENT_VARIANTS}
                >
                    {status === 'loading' && !reduce && !icon ? (
                        <motion.span animate={{ rotate: 360 }} className="inline-flex" transition={{ duration: 1, ease: 'linear', repeat: Infinity }}>
                            <Icon className="size-3" />
                        </motion.span>
                    ) : (icon ?? <Icon className="size-3" />)}
                </motion.span>
            </AnimatePresence>
            <AnimatePresence initial={false} mode="popLayout">
                <motion.span
                    animate={reduce ? { opacity: 1 } : 'animate'}
                    exit={reduce ? undefined : 'exit'}
                    initial={reduce ? false : 'initial'}
                    key={key}
                    variants={CONTENT_VARIANTS}
                >
                    {children}
                </motion.span>
            </AnimatePresence>
        </motion.span>
    );
}
