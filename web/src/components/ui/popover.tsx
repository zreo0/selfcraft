import * as PopoverPrimitive from '@radix-ui/react-popover';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/** 创建 Popover 状态根节点 */
export function Popover (props: ComponentProps<typeof PopoverPrimitive.Root>) {
    return <PopoverPrimitive.Root {...props} />;
}

/** 创建 Popover 触发器 */
export function PopoverTrigger (props: ComponentProps<typeof PopoverPrimitive.Trigger>) {
    return <PopoverPrimitive.Trigger {...props} />;
}

/** 渲染 Popover 浮层 */
export function PopoverContent ({ className, align = 'start', sideOffset = 8, ...props }: ComponentProps<typeof PopoverPrimitive.Content>) {
    return (
        <PopoverPrimitive.Portal>
            <PopoverPrimitive.Content
                align={align}
                className={cn(
                    'z-50 w-80 rounded-2xl border border-border bg-popover/96 p-2 text-popover-foreground shadow-[0_24px_65px_-28px_var(--shadow)] backdrop-blur-2xl outline-none',
                    className,
                )}
                sideOffset={sideOffset}
                {...props}
            />
        </PopoverPrimitive.Portal>
    );
}
