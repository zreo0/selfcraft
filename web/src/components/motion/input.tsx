// Source adapted from https://beui.dev/r/input/raw
import { AnimatePresence, animate, motion, useReducedMotion } from 'motion/react';
import {
    forwardRef,
    useEffect,
    useId,
    useRef,
    useState,
    type InputHTMLAttributes,
    type ReactNode,
} from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'defaultValue' | 'onChange'> {
    /** 可选字段标题 */
    label?: string;
    /** 受控值 */
    value?: string | number;
    /** 非受控初始值 */
    defaultValue?: string | number;
    /** 值变化回调 */
    onChange?: (value: string) => void;
    /** 错误状态或错误文案 */
    error?: string | boolean;
    /** 是否预留错误文案高度 */
    reserveErrorLine?: boolean;
    /** 是否展示成功状态 */
    success?: boolean;
    /** 左侧图标 */
    leftIcon?: ReactNode;
    /** 右侧图标 */
    rightIcon?: ReactNode;
}

/** 渲染带错误反馈与成功反馈的 BeUI 输入框 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input ({
    label,
    value: valueProp,
    defaultValue,
    onChange,
    onFocus,
    onBlur,
    error,
    reserveErrorLine = false,
    success,
    leftIcon,
    rightIcon,
    className,
    disabled,
    id: idProp,
    type,
    ...props
}, ref) {
    const generatedId = useId();
    const id = idProp ?? generatedId;
    const reduce = useReducedMotion();
    const controlled = valueProp !== undefined;
    const [internalValue, setInternalValue] = useState(String(defaultValue ?? ''));
    const [focused, setFocused] = useState(false);
    const fieldRef = useRef<HTMLDivElement>(null);
    const value = controlled ? String(valueProp ?? '') : internalValue;
    const hasError = Boolean(error);
    const errorMessage = typeof error === 'string' ? error : null;

    useEffect(() => {
        if (!fieldRef.current || reduce || !hasError) {
            return;
        }
        animate(fieldRef.current, { x: [0, -6, 6, -4, 4, -2, 0] }, { duration: 0.45 });
    }, [hasError, reduce]);

    /** 同步输入值，并兼容受控与非受控使用方式 */
    function handleChange (next: string): void {
        if (!controlled) {
            setInternalValue(next);
        }
        onChange?.(next);
    }

    return (
        <div className={cn('flex flex-col gap-1.5', className)}>
            {label && <label className="px-0.5 text-sm font-medium text-foreground" htmlFor={id}>{label}</label>}
            <div
                className={cn(
                    'relative h-11 overflow-hidden rounded-xl border border-input bg-background outline-none transition-[border-color,box-shadow,background-color]',
                    focused && !hasError && 'border-ring ring-2 ring-ring/20',
                    hasError && 'border-destructive ring-2 ring-destructive/20',
                    disabled && 'opacity-50',
                )}
                data-state={hasError ? 'error' : success ? 'success' : focused ? 'focused' : 'idle'}
                ref={fieldRef}
            >
                {leftIcon && <span className="pointer-events-none absolute top-1/2 left-3.5 flex -translate-y-1/2 items-center text-muted-foreground [&_svg]:size-4">{leftIcon}</span>}
                <input
                    aria-describedby={errorMessage ? `${id}-error` : undefined}
                    aria-invalid={hasError || undefined}
                    className={cn(
                        'h-full w-full bg-transparent text-sm leading-6 text-foreground caret-foreground outline-none placeholder:text-muted-foreground/72 disabled:cursor-not-allowed',
                        leftIcon ? 'pl-10' : 'pl-3.5',
                        rightIcon || success ? 'pr-10' : 'pr-3.5',
                    )}
                    disabled={disabled}
                    id={id}
                    onBlur={event => {
                        setFocused(false);
                        onBlur?.(event);
                    }}
                    onChange={event => handleChange(event.target.value)}
                    onFocus={event => {
                        setFocused(true);
                        onFocus?.(event);
                    }}
                    ref={ref}
                    type={type}
                    value={value}
                    {...props}
                />
                {success ? (
                    <motion.svg aria-hidden="true" className="absolute top-1/2 right-3.5 size-5 -translate-y-1/2 text-primary" fill="none" viewBox="0 0 24 24">
                        <motion.path
                            animate={{ pathLength: 1 }}
                            d="M5 12.5l4.5 4.5L19 7.5"
                            initial={reduce ? { pathLength: 1 } : { pathLength: 0 }}
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2.5}
                            transition={{ duration: 0.35, ease: 'easeOut' }}
                        />
                    </motion.svg>
                ) : rightIcon ? (
                    <span className="absolute top-0 right-0 flex h-full items-center text-muted-foreground [&_button]:grid [&_button]:size-11 [&_button]:place-items-center [&_svg]:size-4">{rightIcon}</span>
                ) : null}
            </div>
            <div className={reserveErrorLine ? 'min-h-4' : 'contents'}>
                <AnimatePresence initial={false}>
                    {errorMessage && (
                        <motion.p
                            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                            className="px-0.5 text-xs text-destructive"
                            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4, filter: 'blur(4px)' }}
                            id={`${id}-error`}
                            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4, filter: 'blur(4px)' }}
                            role="alert"
                            transition={{ duration: 0.2 }}
                        >
                            {errorMessage}
                        </motion.p>
                    )}
                </AnimatePresence>
            </div>
        </div>
    );
});
