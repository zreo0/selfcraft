import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/** 创建 Dialog 状态根节点 */
export function Dialog (props: ComponentProps<typeof DialogPrimitive.Root>) {
    return <DialogPrimitive.Root {...props} />;
}

/** 创建 Dialog 触发器 */
export function DialogTrigger (props: ComponentProps<typeof DialogPrimitive.Trigger>) {
    return <DialogPrimitive.Trigger {...props} />;
}

/** 创建 Dialog 关闭触发器 */
export function DialogClose (props: ComponentProps<typeof DialogPrimitive.Close>) {
    return <DialogPrimitive.Close {...props} />;
}

/** 渲染带遮罩的 Dialog 内容 */
export function DialogContent ({ className, children, ...props }: ComponentProps<typeof DialogPrimitive.Content>) {
    return (
        <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-foreground/22 backdrop-blur-sm data-[state=closed]:animate-out data-[state=open]:animate-in" />
            <DialogPrimitive.Content
                className={cn(
                    'fixed top-1/2 left-1/2 z-50 grid w-[min(92vw,30rem)] -translate-x-1/2 -translate-y-1/2 gap-5 rounded-[1.5rem] border border-border bg-popover/96 p-6 text-popover-foreground shadow-[0_35px_90px_-38px_var(--shadow)] backdrop-blur-2xl outline-none',
                    className,
                )}
                {...props}
            >
                {children}
                <DialogPrimitive.Close className="absolute top-4 right-4 grid size-8 place-items-center rounded-lg text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                    <X aria-hidden="true" className="size-4" />
                    <span className="sr-only">关闭</span>
                </DialogPrimitive.Close>
            </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
    );
}

/** 渲染 Dialog 标题区域 */
export function DialogHeader ({ className, ...props }: ComponentProps<'div'>) {
    return <div className={cn('space-y-2 pr-8', className)} {...props} />;
}

/** 渲染 Dialog 操作区域 */
export function DialogFooter ({ className, ...props }: ComponentProps<'div'>) {
    return <div className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} />;
}

/** 渲染 Dialog 标题 */
export function DialogTitle ({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
    return <DialogPrimitive.Title className={cn('text-lg font-semibold tracking-[-0.02em]', className)} {...props} />;
}

/** 渲染 Dialog 描述 */
export function DialogDescription ({ className, ...props }: ComponentProps<typeof DialogPrimitive.Description>) {
    return <DialogPrimitive.Description className={cn('text-sm leading-6 text-muted-foreground', className)} {...props} />;
}
