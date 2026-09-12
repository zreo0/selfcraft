// Source adapted from https://beui.dev/r/prompt-input/raw
import type { FileUIPart } from 'ai';
import { ArrowUp, Square, ImagePlus, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    type FormEvent,
    type KeyboardEvent,
    type TextareaHTMLAttributes,
} from 'react';
import { Button } from '@/components/motion/button';
import { SPRING_SWAP } from '@/lib/ease';
import { cn } from '@/lib/utils';

export interface PromptInputProps extends Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    'value' | 'defaultValue' | 'onChange' | 'onSubmit'
> {
    /** 当前输入内容 */
    value: string;
    /** 输入变化回调 */
    onValueChange: (value: string) => void;
    /** 提交非空内容 */
    onSubmit: (value: string) => void | Promise<void>;
    /** 已上传的图片，由对话页面管理 */
    files?: FileUIPart[];
    /** 接收选择或粘贴的图片 */
    onFilesAdded?: (files: File[]) => void;
    /** 移除待发送图片 */
    onRemoveFile?: (index: number) => void;
    /** 上传期间禁止发送，保留文字草稿 */
    uploading?: boolean;
    /** 上传失败的可操作说明 */
    uploadError?: string | null;
    /** 是否正在生成 */
    loading?: boolean;
    /** 停止生成 */
    onStop?: () => void;
    /** 最少行数 */
    minRows?: number;
    /** 最大行数 */
    maxRows?: number;
}

/** 渲染自动增高并原位交换发送状态的 BeUI Prompt Input */
export function PromptInput ({
    value,
    onValueChange,
    onSubmit,
    files = [],
    onFilesAdded,
    onRemoveFile,
    uploading = false,
    uploadError,
    loading = false,
    onStop,
    minRows = 2,
    maxRows = 8,
    className,
    disabled,
    placeholder = '说说你正在想什么…',
    'aria-label': ariaLabel = '输入消息',
    onKeyDown,
    onPaste,
    ...props
}: PromptInputProps) {
    const reduce = useReducedMotion() ?? false;
    const fileInputRef = useRef<HTMLInputElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const measurementRef = useRef<HTMLDivElement>(null);
    const canSubmit = (Boolean(value.trim()) || files.length > 0) && !disabled && !loading && !uploading;

    /** 按真实文本高度调整输入区，避免固定大文本框 */
    const resizeTextarea = useCallback(() => {
        const textarea = textareaRef.current;
        const measurement = measurementRef.current;
        if (!textarea || !measurement || textarea.value !== value) {
            return;
        }
        const lineHeight = 24;
        const nextHeight = Math.min(
            Math.max(measurement.scrollHeight, minRows * lineHeight),
            maxRows * lineHeight,
        );
        textarea.style.height = `${nextHeight}px`;
    }, [maxRows, minRows, value]);

    useLayoutEffect(resizeTextarea, [resizeTextarea]);

    useEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea) {
            return;
        }
        const observer = new ResizeObserver(resizeTextarea);
        observer.observe(textarea);
        return () => observer.disconnect();
    }, [resizeTextarea]);

    /** 提交当前内容并保持输入焦点 */
    function submit (event?: FormEvent): void {
        event?.preventDefault();
        const prompt = value.trim();
        if (!canSubmit) {
            return;
        }
        void onSubmit(prompt);
        textareaRef.current?.focus({ preventScroll: true });
    }

    /** 处理 Enter 发送和 Shift + Enter 换行 */
    function handleKeyDown (event: KeyboardEvent<HTMLTextAreaElement>): void {
        onKeyDown?.(event);
        if (
            event.defaultPrevented
            || event.key !== 'Enter'
            || event.shiftKey
            || event.nativeEvent.isComposing
        ) {
            return;
        }
        event.preventDefault();
        submit();
    }

    return (
        <form
            className={cn(
                'relative w-full rounded-2xl border border-border bg-background p-2 transition-[border-color,box-shadow] focus-within:border-foreground/20 focus-within:shadow-[0_22px_54px_-36px_var(--shadow)]',
                disabled && 'opacity-60',
                className,
            )}
            onSubmit={submit}
        >
            <div
                aria-hidden="true"
                className="pointer-events-none invisible absolute inset-x-2 top-0 whitespace-pre-wrap px-2 text-sm leading-6 [overflow-wrap:break-word]"
                ref={measurementRef}
            >
                {value + '\u200b'}
            </div>
            {files.length > 0 && (
                <ul aria-label="待发送图片" className="flex flex-wrap gap-2 p-2">
                    {files.map((file, index) => (
                        <li className="relative rounded-lg border border-border bg-card p-1" key={`${file.url}:${index}`}>
                            <img alt={file.filename || '待发送图片'} className="h-20 w-24 rounded-md object-contain" src={file.url} />
                            <Button aria-label={`移除${file.filename || '图片'}`} className="absolute -right-1 -top-1 rounded-full" disabled={loading} onClick={() => onRemoveFile?.(index)} size="icon-sm" type="button" variant="secondary">
                                <X aria-hidden="true" className="size-3.5" />
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
            {uploading && <p className="px-2 py-1 text-sm text-muted-foreground" role="status">正在上传图片…</p>}
            {uploadError && <p className="px-2 py-1 text-sm text-destructive" role="alert">{uploadError}</p>}
            <textarea
                aria-label={ariaLabel}
                className="block w-full resize-none overflow-y-auto bg-transparent px-2 pt-1.5 text-[0.98rem] leading-6 text-foreground caret-foreground outline-none placeholder:text-muted-foreground/72"
                disabled={disabled}
                onChange={event => onValueChange(event.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={event => {
                    onPaste?.(event);
                    if (event.defaultPrevented || !onFilesAdded || disabled || loading || uploading) {
                        return;
                    }
                    const images = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'));
                    if (images.length) {
                        event.preventDefault();
                        onFilesAdded(images);
                    }
                }}
                placeholder={placeholder}
                ref={textareaRef}
                rows={minRows}
                value={value}
                {...props}
            />
            <div className="mt-1 flex min-h-9 items-center gap-2 pl-2">
                {onFilesAdded && (
                    <>
                        <input accept="image/png,image/jpeg,image/gif,image/webp" aria-label="选择图片文件" className="hidden" multiple onChange={event => {
                            const selected = Array.from(event.target.files || []);
                            event.target.value = '';
                            onFilesAdded(selected);
                        }} ref={fileInputRef} tabIndex={-1} type="file" />
                        <Button aria-label="添加图片" disabled={disabled || loading || uploading || files.length >= 4} onClick={() => fileInputRef.current?.click()} size="icon-sm" type="button" variant="ghost">
                            <ImagePlus aria-hidden="true" className="size-4" />
                        </Button>
                    </>
                )}
                <span className="text-[0.7rem] text-muted-foreground">
                    <span className="hidden sm:inline">Enter 发送 · Shift + Enter 换行</span>
                    <span className="sm:hidden">输入消息</span>
                </span>
                <Button
                    aria-label={loading ? '停止回应' : '发送消息'}
                    className="ml-auto rounded-full"
                    disabled={loading ? !onStop : !canSubmit}
                    onClick={loading ? onStop : undefined}
                    size="icon-sm"
                    type={loading ? 'button' : 'submit'}
                >
                    <AnimatePresence initial={false} mode="popLayout">
                        <motion.span
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            className="grid place-items-center"
                            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3, scale: 0.8 }}
                            initial={reduce ? { opacity: 1 } : { opacity: 0, y: 3, scale: 0.8 }}
                            key={loading ? 'stop' : 'send'}
                            transition={reduce ? { duration: 0 } : SPRING_SWAP}
                        >
                            {loading
                                ? <Square aria-hidden="true" className="size-3 fill-current" />
                                : <ArrowUp aria-hidden="true" className="size-4" />}
                        </motion.span>
                    </AnimatePresence>
                </Button>
            </div>
        </form>
    );
}
