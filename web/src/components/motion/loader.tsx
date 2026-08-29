// Source adapted from https://beui.dev/r/loader/raw
import { motion, useReducedMotion } from 'motion/react';
import { EASE_IN_OUT } from '@/lib/ease';
import { cn } from '@/lib/utils';

export type LoaderVariant = 'dots' | 'dither';

const BAYER_4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** 渲染精简后的 BeUI 状态加载动画 */
export function Loader ({
    variant = 'dots',
    size = 20,
    speed = 1,
    label = '正在加载',
    className,
}: {
    variant?: LoaderVariant;
    size?: number;
    speed?: number;
    label?: string;
    className?: string;
}) {
    const reduce = useReducedMotion() ?? false;
    if (variant === 'dither') {
        const gap = Math.max(1, size * 0.05);
        const cell = (size - gap * 3) / 4;
        return (
            <span aria-label={label} className={cn('inline-grid grid-cols-4 text-primary', className)} role="status" style={{ gap }}>
                {BAYER_4.map((order, index) => (
                    <motion.span
                        animate={{ opacity: reduce ? [0.35, 0.8, 0.35] : [0.12, 1, 0.12] }}
                        className="bg-current"
                        key={index}
                        style={{ width: cell, height: cell }}
                        transition={{ duration: reduce ? speed * 1.8 : speed, ease: EASE_IN_OUT, repeat: Infinity, delay: order / BAYER_4.length * speed }}
                    />
                ))}
                <span className="sr-only">{label}</span>
            </span>
        );
    }
    const dot = size * 0.22;
    return (
        <span aria-label={label} className={cn('inline-flex items-center text-primary', className)} role="status" style={{ gap: size * 0.13 }}>
            {[0, 1, 2].map(index => (
                <motion.span
                    animate={reduce ? { opacity: [0.4, 1, 0.4] } : { y: [0, -size * 0.22, 0], opacity: [0.4, 1, 0.4] }}
                    className="rounded-full bg-current"
                    key={index}
                    style={{ width: dot, height: dot }}
                    transition={{ duration: speed, ease: EASE_IN_OUT, repeat: Infinity, delay: index * speed * 0.16 }}
                />
            ))}
            <span className="sr-only">{label}</span>
        </span>
    );
}
