import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/** 为全局 Tooltip 提供延迟与可访问性上下文 */
export function TooltipProvider ({ delayDuration = 320, ...props }: ComponentProps<typeof TooltipPrimitive.Provider>) {
    return <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />;
}

/** 创建 Tooltip 状态根节点 */
export function Tooltip (props: ComponentProps<typeof TooltipPrimitive.Root>) {
    return <TooltipPrimitive.Root {...props} />;
}

/** 创建 Tooltip 触发器 */
export function TooltipTrigger (props: ComponentProps<typeof TooltipPrimitive.Trigger>) {
    return <TooltipPrimitive.Trigger {...props} />;
}

/** 渲染 Tooltip 浮层内容 */
export function TooltipContent ({ className, sideOffset = 8, ...props }: ComponentProps<typeof TooltipPrimitive.Content>) {
    return (
        <TooltipPrimitive.Portal>
            <TooltipPrimitive.Content
                className={cn(
                    'z-50 rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-[0_12px_30px_-18px_var(--shadow)] data-[state=closed]:animate-out data-[state=open]:animate-in',
                    className,
                )}
                sideOffset={sideOffset}
                {...props}
            />
        </TooltipPrimitive.Portal>
    );
}
