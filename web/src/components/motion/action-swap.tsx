// Source adapted from https://beui.dev/r/action-swap/raw
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'motion/react';
import type { ReactNode } from 'react';
import { EASE_OUT, SPRING_SWAP } from '@/lib/ease';
import { cn } from '@/lib/utils';

export type ActionSwapAnimation = 'blur' | 'roll' | 'cascade';

type CoreAnimation = 'blur' | 'roll';

export interface ActionSwapTextProps {
    value: string;
    children: ReactNode;
    animation?: ActionSwapAnimation;
    className?: string;
}

const BLUR_VARIANTS: Variants = {
    initial: { opacity: 0, scale: 0.25, filter: 'blur(8px)' },
    animate: {
        opacity: 1,
        scale: 1,
        filter: 'blur(0px)',
        transition: { duration: 0.2, ease: 'easeInOut' },
    },
    exit: {
        opacity: 0,
        scale: 0.25,
        filter: 'blur(8px)',
        transition: { duration: 0.18, ease: EASE_OUT },
    },
};

const ROLL_VARIANTS: Variants = {
    initial: { opacity: 0, y: 12, filter: 'blur(3px)' },
    animate: {
        opacity: 1,
        y: 0,
        filter: 'blur(0px)',
        transition: SPRING_SWAP,
    },
    exit: {
        opacity: 0,
        y: -12,
        filter: 'blur(3px)',
        transition: { duration: 0.14, ease: EASE_OUT },
    },
};

const CASCADE_STAGGER = 0.025;

const CASCADE_LETTER_VARIANTS: Variants = {
    initial: { opacity: 0, y: '105%', filter: 'blur(3px)' },
    animate: (delay: number = 0) => ({
        opacity: 1,
        y: '0%',
        filter: 'blur(0px)',
        transition: { ...SPRING_SWAP, delay },
    }),
    exit: (delay: number = 0) => ({
        opacity: 0,
        y: '-105%',
        filter: 'blur(3px)',
        transition: { duration: 0.16, ease: EASE_OUT, delay: delay * 0.5 },
    }),
};

const TEXT_VARIANTS: Record<CoreAnimation, Variants> = {
    blur: {
        initial: { opacity: 0, scale: 0.94, filter: 'blur(8px)' },
        animate: {
            opacity: 1,
            scale: 1,
            filter: 'blur(0px)',
            transition: { duration: 0.2, ease: 'easeInOut' },
        },
        exit: {
            opacity: 0,
            scale: 0.94,
            filter: 'blur(8px)',
            transition: { duration: 0.2, ease: 'easeInOut' },
        },
    },
    roll: ROLL_VARIANTS,
};

/** 在同一位置逐字或整体交换文本 */
export function ActionSwapText ({
    value,
    children,
    animation = 'blur',
    className,
}: ActionSwapTextProps) {
    const reduce = useReducedMotion();
    const label = typeof children === 'string' ? children : null;
    const cascade = animation === 'cascade' && label !== null && !reduce;
    const coreAnimation: CoreAnimation = animation === 'cascade' ? 'roll' : animation;

    return (
        <span
            className={cn(
                'relative my-[0.08em] inline-block max-w-full whitespace-nowrap py-[0.08em] align-bottom',
                className,
            )}
            style={{
                clipPath: 'inset(0 -999px)',
                WebkitClipPath: 'inset(0 -999px)',
            }}
        >
            <span aria-hidden className="invisible inline-block whitespace-nowrap">
                {cascade
                    ? label.split('').map((character, index) => (
                        <span className="inline-block whitespace-pre" key={index}>{character}</span>
                    ))
                    : children}
            </span>
            {cascade ? (
                <>
                    <span className="sr-only">{label}</span>
                    <AnimatePresence initial={false}>
                        <motion.span
                            animate="animate"
                            aria-hidden
                            className="absolute left-0 top-[0.08em] inline-block whitespace-pre"
                            exit="exit"
                            initial="initial"
                            key={`cascade-${value}`}
                        >
                            {label.split('').map((character, index) => (
                                <motion.span
                                    className="inline-block whitespace-pre will-change-[opacity,filter,transform]"
                                    custom={index * CASCADE_STAGGER}
                                    key={index}
                                    variants={CASCADE_LETTER_VARIANTS}
                                >
                                    {character}
                                </motion.span>
                            ))}
                        </motion.span>
                    </AnimatePresence>
                </>
            ) : (
                <AnimatePresence initial={false}>
                    <motion.span
                        animate={reduce ? { opacity: 1, filter: 'blur(0px)', scale: 1, y: 0 } : 'animate'}
                        className="absolute left-0 top-[0.08em] inline-block max-w-full truncate will-change-[opacity,filter,transform]"
                        exit={reduce ? undefined : 'exit'}
                        initial={reduce ? false : 'initial'}
                        key={`${animation}-${value}`}
                        variants={TEXT_VARIANTS[coreAnimation]}
                    >
                        {children}
                    </motion.span>
                </AnimatePresence>
            )}
        </span>
    );
}

/** 在同一位置平滑交换状态图标 */
export function ActionSwapIcon ({
    value,
    children,
    animation = 'blur',
    className,
}: {
    value: string;
    children: ReactNode;
    animation?: ActionSwapAnimation;
    className?: string;
}) {
    const reduce = useReducedMotion();
    const coreAnimation: CoreAnimation = animation === 'cascade' ? 'roll' : animation;
    return (
        <span className={cn('relative inline-grid shrink-0 place-items-center overflow-hidden', className)}>
            <AnimatePresence initial={false} mode="popLayout">
                <motion.span
                    animate={reduce ? { opacity: 1 } : 'animate'}
                    aria-hidden="true"
                    className="col-start-1 row-start-1 inline-flex items-center justify-center"
                    exit={reduce ? undefined : 'exit'}
                    initial={reduce ? false : 'initial'}
                    key={`${animation}-${value}`}
                    variants={coreAnimation === 'blur' ? BLUR_VARIANTS : ROLL_VARIANTS}
                >
                    {children}
                </motion.span>
            </AnimatePresence>
        </span>
    );
}
