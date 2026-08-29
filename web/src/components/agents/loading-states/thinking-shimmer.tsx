// Source adapted from https://beui.dev/r/thinking-shimmer/raw
import type { ReactNode } from 'react';
import { TextShimmer } from '@/components/motion/text-shimmer';
import { cn } from '@/lib/utils';

export interface ThinkingShimmerProps {
    /** 展示给用户的思考状态 */
    children?: ReactNode;
    /** 单次流光经过的秒数 */
    duration?: number;
    className?: string;
}

/** 展示 Agent 正在思考的轻量状态 */
export function ThinkingShimmer ({
    children = '正在思考…',
    duration = 1.8,
    className,
}: ThinkingShimmerProps) {
    return (
        <TextShimmer as="span" className={cn('font-medium', className)} duration={duration}>
            {children}
        </TextShimmer>
    );
}
