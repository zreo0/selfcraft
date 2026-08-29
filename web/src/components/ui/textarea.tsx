import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/** 渲染可调整高度的多行输入框 */
export function Textarea ({ className, ...props }: ComponentProps<'textarea'>) {
    return (
        <textarea
            className={cn(
                'min-h-24 w-full resize-y rounded-xl border border-input bg-background/58 px-3.5 py-3 text-sm text-foreground outline-none transition-[border-color,box-shadow,background-color] placeholder:text-muted-foreground/72 focus-visible:border-ring focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring/22 disabled:cursor-not-allowed disabled:opacity-50',
                className,
            )}
            data-slot="textarea"
            {...props}
        />
    );
}
