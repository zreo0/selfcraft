// Source adapted from https://beui.dev/r/tabs/raw
import { motion, MotionConfig, useReducedMotion, type Transition } from 'motion/react';
import {
    createContext,
    useCallback,
    useContext,
    useId,
    useMemo,
    useState,
    type ReactNode,
} from 'react';
import { cn } from '@/lib/utils';

type TabsVariant = 'pill' | 'segment';

type TabsContextValue = {
    value: string;
    setValue: (value: string) => void;
    layoutId: string;
    variant: TabsVariant;
};

const TabsContext = createContext<TabsContextValue | null>(null);
const TAB_TRANSITION: Transition = {
    type: 'spring',
    stiffness: 170,
    damping: 24,
    mass: 1.2,
};

/** 读取当前 BeUI Tabs 上下文 */
function useTabs (): TabsContextValue {
    const context = useContext(TabsContext);
    if (!context) {
        throw new Error('Tabs 子组件必须位于 Tabs 内部');
    }
    return context;
}

/** 管理带共享布局指示器的 BeUI Tabs */
export function Tabs ({
    defaultValue,
    value,
    onValueChange,
    variant = 'pill',
    children,
    className,
}: {
    defaultValue?: string;
    value?: string;
    onValueChange?: (value: string) => void;
    variant?: TabsVariant;
    children: ReactNode;
    className?: string;
}) {
    const [internalValue, setInternalValue] = useState(defaultValue ?? '');
    const layoutId = useId();
    const reduce = useReducedMotion();
    const controlled = value !== undefined;
    const current = controlled ? value : internalValue;
    const setValue = useCallback((next: string) => {
        if (!controlled) {
            setInternalValue(next);
        }
        onValueChange?.(next);
    }, [controlled, onValueChange]);
    const context = useMemo(() => ({
        value: current,
        setValue,
        layoutId,
        variant,
    }), [current, layoutId, setValue, variant]);
    return (
        <MotionConfig transition={reduce ? { duration: 0 } : TAB_TRANSITION}>
            <TabsContext.Provider value={context}>
                <motion.div className={className} layoutRoot>{children}</motion.div>
            </TabsContext.Provider>
        </MotionConfig>
    );
}

/** 渲染 BeUI Tabs 的选项容器 */
export function TabsList ({ children, className }: { children: ReactNode; className?: string }) {
    const { variant } = useTabs();
    return (
        <div
            className={cn(
                'inline-flex items-center',
                variant === 'pill' ? 'gap-1 rounded-full bg-muted p-1' : 'gap-0 rounded-xl bg-muted p-1',
                className,
            )}
            role="tablist"
        >
            {children}
        </div>
    );
}

/** 渲染带共享弹簧指示器的 BeUI Tab */
export function TabsTrigger ({
    value,
    children,
    className,
    indicatorClassName,
}: {
    value: string;
    children: ReactNode;
    className?: string;
    indicatorClassName?: string;
}) {
    const { value: current, setValue, layoutId, variant } = useTabs();
    const active = current === value;
    const radius = variant === 'pill' ? 'rounded-full' : 'rounded-lg';
    return (
        <div className="relative">
            {active && (
                <motion.span
                    className={cn('absolute inset-0 bg-primary shadow-[0_8px_22px_-14px_var(--shadow-accent)]', radius, indicatorClassName)}
                    layout="position"
                    layoutId={layoutId}
                    style={{ borderRadius: variant === 'pill' ? 9999 : 8 }}
                />
            )}
            <button
                aria-selected={active}
                className={cn(
                    'relative z-10 inline-flex min-h-9 items-center justify-center gap-2 whitespace-nowrap bg-transparent px-3.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                    active ? 'text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                    radius,
                    className,
                )}
                onClick={() => setValue(value)}
                role="tab"
                type="button"
            >
                {children}
            </button>
        </div>
    );
}
