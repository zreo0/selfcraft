// Source adapted from https://beui.dev/r/select/raw
import { Check, ChevronDown } from 'lucide-react';
import { motion, useReducedMotion, type Transition, type Variants } from 'motion/react';
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import { EASE_OUT } from '@/lib/ease';
import { cn } from '@/lib/utils';

const INSTANT_TRANSITION: Transition = { duration: 0 };
const CHEVRON_TRANSITION: Transition = { type: 'spring', duration: 0.4, bounce: 0.3 };
const LIST_VARIANTS: Variants = {
    hidden: {},
    show: { transition: { staggerChildren: 0.035, delayChildren: 0.05 } },
};
const ITEM_VARIANTS: Variants = {
    hidden: { opacity: 0, y: -6, filter: 'blur(3px)' },
    show: { opacity: 1, y: 0, filter: 'blur(0px)' },
};

type Placement = 'bottom' | 'top';

type SelectContextValue = {
    value: string | undefined;
    open: boolean;
    setOpen: (open: boolean) => void;
    select: (value: string) => void;
    register: (value: string, label: string) => void;
    unregister: (value: string) => void;
    labelFor: (value: string | undefined) => string | undefined;
    reduce: boolean;
    triggerId: string;
    listId: string;
    disabled: boolean;
    placement: Placement;
    setPlacement: (placement: Placement) => void;
};

const SelectContext = createContext<SelectContextValue | null>(null);

/** 读取 BeUI Select 上下文并校验组件层级 */
function useSelectContext (component: string): SelectContextValue {
    const context = useContext(SelectContext);
    if (!context) {
        throw new Error(`${component} 必须位于 Select 内部`);
    }
    return context;
}

/** 管理 BeUI Select 的值、浮层和标签注册 */
export function Select ({
    value,
    defaultValue,
    onValueChange,
    disabled = false,
    className,
    children,
}: {
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    disabled?: boolean;
    className?: string;
    children: ReactNode;
}) {
    const reduce = useReducedMotion() ?? false;
    const baseId = useId();
    const rootRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [internalValue, setInternalValue] = useState(defaultValue);
    const [labels, setLabels] = useState<Map<string, string>>(new Map());
    const [placement, setPlacement] = useState<Placement>('bottom');
    const controlled = value !== undefined;
    const currentValue = controlled ? value : internalValue;

    /** 选择一个值并关闭浮层 */
    const select = useCallback((next: string) => {
        if (!controlled) {
            setInternalValue(next);
        }
        onValueChange?.(next);
        setOpen(false);
    }, [controlled, onValueChange]);

    /** 注册选项文案，供关闭状态的触发器显示 */
    const register = useCallback((nextValue: string, label: string) => {
        setLabels(current => current.get(nextValue) === label ? current : new Map(current).set(nextValue, label));
    }, []);

    /** 移除已经卸载的选项文案 */
    const unregister = useCallback((nextValue: string) => {
        setLabels(current => {
            if (!current.has(nextValue)) {
                return current;
            }
            const next = new Map(current);
            next.delete(nextValue);
            return next;
        });
    }, []);

    useEffect(() => {
        if (!open) {
            return;
        }
        /** 处理关闭键 */
        function handleKeyDown (event: KeyboardEvent): void {
            if (event.key === 'Escape') {
                setOpen(false);
            }
        }
        /** 点击组件外部时关闭选项 */
        function handlePointerDown (event: PointerEvent): void {
            if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
                setOpen(false);
            }
        }
        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('pointerdown', handlePointerDown);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('pointerdown', handlePointerDown);
        };
    }, [open]);

    const context = useMemo<SelectContextValue>(() => ({
        value: currentValue,
        open,
        setOpen,
        select,
        register,
        unregister,
        labelFor: nextValue => nextValue === undefined ? undefined : labels.get(nextValue),
        reduce,
        triggerId: `${baseId}-trigger`,
        listId: `${baseId}-list`,
        disabled,
        placement,
        setPlacement,
    }), [baseId, currentValue, disabled, labels, open, placement, reduce, register, select, unregister]);

    return (
        <SelectContext.Provider value={context}>
            <div className={cn('relative', className)} ref={rootRef}>{children}</div>
        </SelectContext.Provider>
    );
}

/** 渲染会与选项浮层分离的 BeUI Select 触发器 */
export function SelectTrigger ({ className, children }: { className?: string; children: ReactNode }) {
    const context = useSelectContext('SelectTrigger');
    const top = context.placement === 'top';
    const radius = context.open ? [0, 0, 12] : [12, 0, 12];
    const radiusTransition: Transition = context.reduce
        ? { duration: 0 }
        : context.open
            ? { duration: 0.6, times: [0, 0.4, 1], ease: EASE_OUT }
            : { duration: 0.42, times: [0, 0.5, 1], ease: EASE_OUT };

    return (
        <motion.button
            animate={{
                borderTopLeftRadius: top ? radius : 12,
                borderTopRightRadius: top ? radius : 12,
                borderBottomLeftRadius: top ? 12 : radius,
                borderBottomRightRadius: top ? 12 : radius,
            }}
            aria-controls={context.listId}
            aria-expanded={context.open}
            aria-haspopup="listbox"
            className={cn(
                'relative z-10 flex h-11 w-full items-center justify-between gap-2 rounded-xl border border-input bg-background px-3.5 text-sm text-foreground outline-none transition-colors hover:border-foreground/18 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
                className,
            )}
            disabled={context.disabled}
            id={context.triggerId}
            initial={false}
            onClick={() => context.setOpen(!context.open)}
            transition={{
                borderTopLeftRadius: top ? radiusTransition : INSTANT_TRANSITION,
                borderTopRightRadius: top ? radiusTransition : INSTANT_TRANSITION,
                borderBottomLeftRadius: top ? INSTANT_TRANSITION : radiusTransition,
                borderBottomRightRadius: top ? INSTANT_TRANSITION : radiusTransition,
            }}
            type="button"
        >
            {children}
            <motion.span
                animate={{ rotate: context.open ? 180 : 0 }}
                aria-hidden="true"
                className="text-muted-foreground"
                transition={context.reduce ? { duration: 0 } : CHEVRON_TRANSITION}
            >
                <ChevronDown className="size-4" />
            </motion.span>
        </motion.button>
    );
}

/** 展示当前选择的 BeUI Select 文案 */
export function SelectValue ({ placeholder, className }: { placeholder?: string; className?: string }) {
    const context = useSelectContext('SelectValue');
    const label = context.labelFor(context.value);
    return <span className={cn(label ? 'text-foreground' : 'text-muted-foreground', className)}>{label ?? placeholder ?? '请选择'}</span>;
}

/** 渲染 BeUI Select 的弹性选项浮层 */
export function SelectContent ({ className, children }: { className?: string; children: ReactNode }) {
    const context = useSelectContext('SelectContent');
    const innerRef = useRef<HTMLDivElement>(null);
    const [height, setHeight] = useState(0);

    useLayoutEffect(() => {
        const node = innerRef.current;
        if (!node) {
            return;
        }
        const element = node;
        /** 测量选项内容高度，使浮层动画不依赖固定尺寸 */
        function measure (): void {
            setHeight(element.offsetHeight);
        }
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    useLayoutEffect(() => {
        if (!context.open) {
            return;
        }
        const trigger = document.getElementById(context.triggerId);
        const node = innerRef.current;
        if (!trigger || !node) {
            return;
        }
        const bounds = trigger.getBoundingClientRect();
        const below = window.innerHeight - bounds.bottom;
        const above = bounds.top;
        context.setPlacement(below < node.offsetHeight + 16 && above > below ? 'top' : 'bottom');
    }, [context]);

    const top = context.placement === 'top';
    const nearGap = context.open ? 8 : 0;
    const nearRadius = context.open ? 12 : 0;

    return (
        <motion.div
            animate={{
                opacity: context.open ? 1 : 0,
                height: context.open ? height : 0,
                marginTop: top ? 0 : nearGap,
                marginBottom: top ? nearGap : 0,
                borderTopLeftRadius: top ? 12 : nearRadius,
                borderTopRightRadius: top ? 12 : nearRadius,
                borderBottomLeftRadius: top ? nearRadius : 12,
                borderBottomRightRadius: top ? nearRadius : 12,
            }}
            aria-hidden={!context.open}
            aria-labelledby={context.triggerId}
            className={cn(
                'absolute right-0 left-0 z-40 rounded-xl border border-border bg-popover text-popover-foreground shadow-[0_22px_60px_-30px_var(--shadow)]',
                top ? 'bottom-full' : 'top-full',
                className,
            )}
            id={context.listId}
            inert={!context.open}
            initial={false}
            role="listbox"
            style={{ overflow: 'hidden', pointerEvents: context.open ? 'auto' : 'none' }}
            transition={context.reduce ? { duration: 0.12 } : { type: 'spring', duration: 0.42, bounce: 0.14 }}
        >
            <motion.div
                animate={context.open ? 'show' : 'hidden'}
                className="p-1"
                initial={false}
                ref={innerRef}
                variants={context.reduce ? undefined : LIST_VARIANTS}
            >
                {children}
            </motion.div>
        </motion.div>
    );
}

/** 渲染 BeUI Select 的单个选项 */
export function SelectItem ({
    value,
    disabled = false,
    className,
    children,
}: {
    value: string;
    disabled?: boolean;
    className?: string;
    children: ReactNode;
}) {
    const context = useSelectContext('SelectItem');
    const selected = context.value === value;
    const label = typeof children === 'string' ? children : value;
    const { register, unregister } = context;

    useLayoutEffect(() => {
        register(value, label);
        return () => unregister(value);
    }, [label, register, unregister, value]);

    return (
        <motion.li variants={context.reduce ? undefined : ITEM_VARIANTS}>
            <button
                aria-selected={selected}
                className={cn(
                    'flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-sm outline-none transition-colors',
                    selected ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground',
                    'disabled:pointer-events-none disabled:opacity-50',
                    className,
                )}
                disabled={disabled}
                onClick={() => context.select(value)}
                role="option"
                type="button"
            >
                {children}
                {selected && <Check aria-hidden="true" className="size-3.5 shrink-0" />}
            </button>
        </motion.li>
    );
}
