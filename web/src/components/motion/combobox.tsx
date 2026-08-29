// Source adapted from https://beui.dev/r/combobox
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { motion, useReducedMotion, type Transition } from 'motion/react';
import {
    type CSSProperties,
    type KeyboardEvent as ReactKeyboardEvent,
    type RefObject,
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { createPortal } from 'react-dom';
import { EASE_OUT } from '@/lib/ease';
import { cn } from '@/lib/utils';

const VIEWPORT_PADDING = 8;
const PANEL_OFFSET = 6;
const PANEL_TRANSITION: Transition = { duration: 0.18, ease: EASE_OUT };

type Placement = {
    /** 浮层左侧位置 */
    left: number;
    /** 浮层顶部位置 */
    top: number;
    /** 浮层宽度 */
    width: number;
    /** 浮层相对触发器的方向 */
    side: 'top' | 'bottom';
    /** 是否已经完成首次测量 */
    ready: boolean;
};

export type ComboboxOption = {
    /** 选项提交值 */
    value: string;
    /** 选项显示文案 */
    label: string;
    /** 参与搜索但不显示的补充词 */
    keywords?: string[];
    /** 是否禁止选择 */
    disabled?: boolean;
};

export type ComboboxProps = {
    /** 当前选择值 */
    value?: string;
    /** 可搜索的选项 */
    options: readonly ComboboxOption[];
    /** 选择变化回调 */
    onValueChange: (value: string) => void;
    /** 组件的可访问名称 */
    ariaLabel?: string;
    /** 没有选择时显示的文案 */
    placeholder?: string;
    /** 搜索状态下的输入提示 */
    searchPlaceholder?: string;
    /** 没有匹配项时显示的文案 */
    emptyText?: string;
    /** 是否禁止交互 */
    disabled?: boolean;
    /** 根节点附加样式 */
    className?: string;
};

/** 比较浮层位置，避免无变化时触发额外渲染 */
function samePlacement (current: Placement, next: Placement): boolean {
    return current.left === next.left
        && current.top === next.top
        && current.width === next.width
        && current.side === next.side
        && current.ready === next.ready;
}

/** 判断选项是否匹配当前搜索文本 */
function matchesOption (option: ComboboxOption, query: string): boolean {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) {
        return true;
    }
    return [option.label, option.value, ...(option.keywords ?? [])]
        .join(' ')
        .toLocaleLowerCase()
        .includes(needle);
}

/** 测量触发器与浮层，并在可用空间不足时切换展开方向 */
function useComboboxPlacement (
    triggerRef: RefObject<HTMLDivElement | null>,
    panelRef: RefObject<HTMLDivElement | null>,
    open: boolean,
    portalReady: boolean,
): Placement {
    const [placement, setPlacement] = useState<Placement>({
        left: VIEWPORT_PADDING,
        top: VIEWPORT_PADDING,
        width: 288,
        side: 'bottom',
        ready: false,
    });

    /** 根据视口和内容尺寸更新浮层位置 */
    const update = useCallback(() => {
        const trigger = triggerRef.current;
        const panel = panelRef.current;
        if (!trigger || !panel) {
            return;
        }
        const triggerBounds = trigger.getBoundingClientRect();
        const panelHeight = panel.offsetHeight;
        const below = window.innerHeight - triggerBounds.bottom;
        const above = triggerBounds.top;
        const side = below < panelHeight + PANEL_OFFSET && above > below ? 'top' : 'bottom';
        const width = Math.min(triggerBounds.width, window.innerWidth - VIEWPORT_PADDING * 2);
        const left = Math.min(
            Math.max(triggerBounds.left, VIEWPORT_PADDING),
            window.innerWidth - width - VIEWPORT_PADDING,
        );
        const desiredTop = side === 'bottom'
            ? triggerBounds.bottom + PANEL_OFFSET
            : triggerBounds.top - panelHeight - PANEL_OFFSET;
        const top = Math.min(
            Math.max(desiredTop, VIEWPORT_PADDING),
            Math.max(VIEWPORT_PADDING, window.innerHeight - panelHeight - VIEWPORT_PADDING),
        );
        const next = { left, top, width, side, ready: true } satisfies Placement;
        setPlacement(current => samePlacement(current, next) ? current : next);
    }, [panelRef, triggerRef]);

    useLayoutEffect(() => {
        if (!portalReady) {
            return;
        }
        update();
        if (!open) {
            return;
        }
        const observer = new ResizeObserver(update);
        if (triggerRef.current) {
            observer.observe(triggerRef.current);
        }
        if (panelRef.current) {
            observer.observe(panelRef.current);
        }
        window.addEventListener('scroll', update, true);
        window.addEventListener('resize', update);
        return () => {
            observer.disconnect();
            window.removeEventListener('scroll', update, true);
            window.removeEventListener('resize', update);
        };
    }, [open, panelRef, portalReady, triggerRef, update]);

    return placement;
}

/** 渲染可复用的 BeUI 风格搜索选择器 */
export function Combobox ({
    value,
    options,
    onValueChange,
    ariaLabel = '搜索并选择',
    placeholder = '请选择',
    searchPlaceholder = '输入关键词搜索',
    emptyText = '没有匹配的选项',
    disabled = false,
    className,
}: ComboboxProps) {
    const reduce = useReducedMotion() ?? false;
    const baseId = useId();
    const inputId = `${baseId}-input`;
    const listId = `${baseId}-list`;
    const rootRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const [portalReady, setPortalReady] = useState(false);
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [panelQuery, setPanelQuery] = useState('');
    const [activeValue, setActiveValue] = useState<string | null>(null);
    const filteredOptions = useMemo(
        () => options.filter(option => matchesOption(option, open ? query : panelQuery)),
        [open, options, panelQuery, query],
    );
    const selectedLabel = options.find(option => option.value === value)?.label ?? value ?? '';
    const activeIndex = filteredOptions.findIndex(option => option.value === activeValue);
    const activeItemId = activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined;
    const placement = useComboboxPlacement(triggerRef, panelRef, open, portalReady);

    useEffect(() => {
        setPortalReady(true);
    }, []);

    useEffect(() => {
        if (!open) {
            return;
        }
        const selected = filteredOptions.find(option => option.value === value && !option.disabled);
        const first = filteredOptions.find(option => !option.disabled);
        setActiveValue(selected?.value ?? first?.value ?? null);
    }, [filteredOptions, open, value]);

    useEffect(() => {
        if (!open || !activeItemId) {
            return;
        }
        document.getElementById(activeItemId)?.scrollIntoView({ block: 'nearest' });
    }, [activeItemId, open]);

    useEffect(() => {
        if (!open) {
            return;
        }
        /** 点击或聚焦组件外部时关闭浮层 */
        function closeFromOutside (target: EventTarget | null): void {
            if (!(target instanceof Node)) {
                return;
            }
            if (!rootRef.current?.contains(target) && !panelRef.current?.contains(target)) {
                setOpen(false);
                setQuery('');
            }
        }
        /** 处理组件外部的指针事件 */
        function handlePointerDown (event: PointerEvent): void {
            closeFromOutside(event.target);
        }
        /** 处理组件外部的焦点变化 */
        function handleFocusIn (event: FocusEvent): void {
            closeFromOutside(event.target);
        }
        window.addEventListener('pointerdown', handlePointerDown);
        window.addEventListener('focusin', handleFocusIn);
        return () => {
            window.removeEventListener('pointerdown', handlePointerDown);
            window.removeEventListener('focusin', handleFocusIn);
        };
    }, [open]);

    /** 打开搜索并保持输入焦点 */
    function openSearch (): void {
        if (disabled) {
            return;
        }
        if (!open) {
            setQuery('');
            setPanelQuery('');
        }
        setOpen(true);
        requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    }

    /** 关闭搜索并清空临时查询 */
    function closeSearch (): void {
        setOpen(false);
        setQuery('');
    }

    /** 提交选项并回到选中值展示 */
    function selectOption (option: ComboboxOption): void {
        if (option.disabled) {
            return;
        }
        onValueChange(option.value);
        closeSearch();
    }

    /** 按当前方向移动键盘高亮项 */
    function moveActive (direction: 1 | -1 | 'first' | 'last'): void {
        const enabled = filteredOptions.filter(option => !option.disabled);
        if (enabled.length === 0) {
            setActiveValue(null);
            return;
        }
        if (direction === 'first' || direction === 'last') {
            setActiveValue(enabled[direction === 'first' ? 0 : enabled.length - 1].value);
            return;
        }
        const current = enabled.findIndex(option => option.value === activeValue);
        const next = current < 0
            ? direction === 1 ? 0 : enabled.length - 1
            : (current + direction + enabled.length) % enabled.length;
        setActiveValue(enabled[next].value);
    }

    /** 处理搜索输入框的键盘选择 */
    function handleKeyDown (event: ReactKeyboardEvent<HTMLInputElement>): void {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) {
                openSearch();
                return;
            }
            moveActive(event.key === 'ArrowDown' ? 1 : -1);
        } else if (event.key === 'Home' && open) {
            event.preventDefault();
            moveActive('first');
        } else if (event.key === 'End' && open) {
            event.preventDefault();
            moveActive('last');
        } else if (event.key === 'Enter') {
            event.preventDefault();
            if (!open) {
                openSearch();
                return;
            }
            const active = filteredOptions.find(option => option.value === activeValue && !option.disabled)
                ?? filteredOptions.find(option => !option.disabled);
            if (active) {
                selectOption(active);
            }
        } else if (event.key === 'Escape' && open) {
            event.preventDefault();
            closeSearch();
        }
    }

    const panel = portalReady ? createPortal(
        <motion.div
            animate={{
                opacity: open ? 1 : 0,
                y: open ? 0 : placement.side === 'bottom' ? -4 : 4,
            }}
            aria-hidden={!open}
            className="fixed z-[9999] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-[0_22px_60px_-30px_var(--shadow)]"
            data-side={placement.side}
            data-state={open ? 'open' : 'closed'}
            inert={!open}
            initial={false}
            ref={panelRef}
            style={{
                left: placement.left,
                top: placement.top,
                width: placement.width,
                pointerEvents: open ? 'auto' : 'none',
                visibility: placement.ready ? 'visible' : 'hidden',
            } satisfies CSSProperties}
            transition={reduce ? { duration: 0 } : PANEL_TRANSITION}
        >
            <div aria-label={ariaLabel} className="max-h-64 overflow-y-auto overscroll-contain p-1.5" id={listId} role="listbox">
                {filteredOptions.length === 0 && (
                    <div className="px-3 py-8 text-center text-sm text-muted-foreground" role="status">{emptyText}</div>
                )}
                {filteredOptions.map((option, index) => {
                    const active = option.value === activeValue;
                    const selected = option.value === value;
                    return (
                        <button
                            aria-selected={selected}
                            className={cn(
                                'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm outline-none transition-colors duration-150',
                                active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                                'focus-visible:bg-muted focus-visible:text-foreground disabled:pointer-events-none disabled:opacity-45',
                            )}
                            disabled={option.disabled}
                            id={`${listId}-option-${index}`}
                            key={option.value}
                            onClick={() => selectOption(option)}
                            onPointerDown={event => event.preventDefault()}
                            onPointerMove={() => !option.disabled && setActiveValue(option.value)}
                            role="option"
                            tabIndex={-1}
                            type="button"
                        >
                            <span className="min-w-0 flex-1 truncate">{option.label}</span>
                            <motion.span
                                animate={{ opacity: selected ? 1 : 0, scale: selected ? 1 : 0.9 }}
                                aria-hidden="true"
                                className="grid size-5 shrink-0 place-items-center text-foreground"
                                initial={false}
                                transition={reduce ? { duration: 0 } : { duration: 0.12, ease: EASE_OUT }}
                            >
                                <Check className="size-4" />
                            </motion.span>
                        </button>
                    );
                })}
            </div>
        </motion.div>,
        document.body,
    ) : null;

    return (
        <div className={cn('relative w-full', className)} ref={rootRef}>
            <div
                className={cn(
                    'relative z-20 flex h-11 w-full cursor-text items-center gap-2 rounded-xl border border-input bg-background px-3.5 text-sm text-foreground transition-colors',
                    'hover:border-foreground/18 focus-within:ring-2 focus-within:ring-ring',
                    disabled && 'pointer-events-none opacity-50',
                )}
                data-state={open ? 'open' : 'closed'}
                onPointerDown={event => {
                    if (event.target === inputRef.current) {
                        return;
                    }
                    event.preventDefault();
                    openSearch();
                }}
                ref={triggerRef}
            >
                <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                <input
                    aria-activedescendant={open ? activeItemId : undefined}
                    aria-autocomplete="list"
                    aria-controls={listId}
                    aria-expanded={open}
                    aria-label={ariaLabel}
                    autoComplete="off"
                    className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
                    disabled={disabled}
                    id={inputId}
                    onChange={event => {
                        setQuery(event.target.value);
                        setPanelQuery(event.target.value);
                        openSearch();
                    }}
                    onClick={openSearch}
                    onFocus={openSearch}
                    onKeyDown={handleKeyDown}
                    placeholder={open ? searchPlaceholder : placeholder}
                    ref={inputRef}
                    role="combobox"
                    value={open ? query : selectedLabel}
                />
                <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            </div>
            {panel}
        </div>
    );
}
