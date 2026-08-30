// Source adapted from https://beui.dev/components/agent-disclosure
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ChevronDown } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { cn } from '@/lib/utils';

export interface AgentDisclosureProps {
    /** 折叠区标题 */
    title: ReactNode;
    /** 标题右侧的简短状态 */
    detail?: ReactNode;
    /** 未受控模式下是否展开 */
    defaultOpen?: boolean;
    /** 受控模式的展开状态 */
    open?: boolean;
    /** 展开状态变化回调 */
    onOpenChange?: (open: boolean) => void;
    /** 折叠区内容 */
    children: ReactNode;
    className?: string;
}

/** 渲染适合 Agent 过程信息的轻量折叠区 */
export function AgentDisclosure ({
    title,
    detail,
    defaultOpen = false,
    open,
    onOpenChange,
    children,
    className,
}: AgentDisclosureProps) {
    const reduce = useReducedMotion() ?? false;
    const [internalOpen, setInternalOpen] = useState(defaultOpen);
    const expanded = open ?? internalOpen;

    /** 同步受控或未受控的展开状态 */
    function handleToggle (): void {
        const next = !expanded;
        if (open === undefined) {
            setInternalOpen(next);
        }
        onOpenChange?.(next);
    }

    return (
        <div className={cn('agent-disclosure', className)} data-slot="agent-disclosure">
            <button
                aria-expanded={expanded}
                className="agent-disclosure-trigger"
                onClick={handleToggle}
                type="button"
            >
                <span className="agent-disclosure-title">{title}</span>
                {detail && <span className="agent-disclosure-detail">{detail}</span>}
                <ChevronDown
                    aria-hidden="true"
                    className={cn('agent-disclosure-chevron', expanded && 'agent-disclosure-chevron--open')}
                />
            </button>
            <AnimatePresence initial={false}>
                {expanded && (
                    <motion.div
                        animate={{ height: 'auto', opacity: 1 }}
                        className="agent-disclosure-panel"
                        exit={{ height: 0, opacity: 0 }}
                        initial={reduce ? false : { height: 0, opacity: 0 }}
                        transition={reduce ? { duration: 0 } : { duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                    >
                        <div className="agent-disclosure-content">{children}</div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
