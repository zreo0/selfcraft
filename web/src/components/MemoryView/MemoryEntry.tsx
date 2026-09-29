import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Eraser, PenLine, Pin } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/motion/button';
import { Input } from '@/components/motion/input';
import { Loader } from '@/components/motion/loader';
import { Switch } from '@/components/motion/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/motion/tabs';
import { Textarea } from '@/components/ui/textarea';
import { EASE_OUT } from '@/lib/ease';
import { basisLabel, formatMemoryDate, validityLabel, versionVerb } from '@/lib/memory-labels';
import type {
    MemoryCorrectionInput,
    MemoryDetailView,
    MemoryItemView,
    MemoryRevisionKind,
} from '@/types/memory.types';

type EntryMode = 'view' | 'correct' | 'forget';

/** 展开时最多直接展示的原话数量 */
const VISIBLE_SOURCES = 3;

/**
 * 一条可展开的认识：收起时是一句话，展开后显示出处、变化和修正操作
 *
 * @param props.item 当前认识
 * @param props.timezone 用户时区
 * @param props.selected 是否展开
 * @param props.detail 展开后读取的来源与修订链
 * @param props.detailError 读取详情失败的原因
 * @param props.busy 是否有操作正在提交
 * @param props.onToggle 展开或收起
 * @param props.onCorrect 提交修正
 * @param props.onForget 忘记这条认识
 * @param props.onResident 调整是否常驻
 * @param props.showPin 是否用图钉标出常驻；档案内的条目本身就是常驻，不再重复
 */
export function MemoryEntry ({
    item,
    timezone,
    selected,
    detail,
    detailError,
    busy,
    onToggle,
    onCorrect,
    onForget,
    onResident,
    showPin = true,
}: {
    item: MemoryItemView;
    timezone: string;
    selected: boolean;
    detail: MemoryDetailView | null;
    detailError: string | null;
    busy: boolean;
    onToggle: () => void;
    onCorrect: (input: MemoryCorrectionInput) => Promise<void>;
    onForget: () => Promise<void>;
    onResident: (resident: boolean) => Promise<void>;
    showPin?: boolean;
}) {
    const reduce = useReducedMotion();
    const [mode, setMode] = useState<EntryMode>('view');
    const [error, setError] = useState<string | null>(null);
    const panelId = `memory-panel-${item.id}`;
    const validity = validityLabel(item, timezone);

    useEffect(() => {
        if (!selected) {
            setMode('view');
            setError(null);
        }
    }, [selected]);

    /** 执行一次操作，失败时把原因留在这条认识旁边 */
    async function run (action: () => Promise<void>): Promise<void> {
        setError(null);
        try {
            await action();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : '操作没有完成，请稍后再试');
        }
    }

    return (
        <li className="memory-entry" data-selected={selected || undefined} id={`memory-${item.id}`}>
            <button
                aria-controls={panelId}
                aria-expanded={selected}
                className="memory-entry-line"
                onClick={onToggle}
                type="button"
            >
                <span aria-hidden="true" className="memory-node" data-basis={item.basis === 'stated' ? 'stated' : 'observed'} />
                <span className="memory-entry-copy">
                    <AnimatePresence initial={false} mode="popLayout">
                        <motion.span
                            animate={{ opacity: 1, filter: 'blur(0px)' }}
                            className="memory-entry-text"
                            exit={reduce ? { opacity: 0 } : { opacity: 0, filter: 'blur(4px)' }}
                            initial={reduce ? { opacity: 0 } : { opacity: 0, filter: 'blur(4px)' }}
                            key={item.content}
                            transition={{ duration: reduce ? 0 : 0.32, ease: EASE_OUT }}
                        >
                            {item.content}
                        </motion.span>
                    </AnimatePresence>
                    <span className="memory-entry-meta">
                        {basisLabel(item.basis)} · {formatMemoryDate(item.knownFrom, timezone)}
                        {validity && <span className="memory-validity">{validity}</span>}
                    </span>
                </span>
                {item.resident && showPin && <Pin aria-label="常驻档案" className="memory-entry-pin" />}
            </button>

            <AnimatePresence initial={false}>
                {selected && (
                    <motion.div
                        animate={{ height: 'auto', opacity: 1 }}
                        className="memory-entry-panel"
                        exit={{ height: 0, opacity: 0 }}
                        id={panelId}
                        initial={{ height: 0, opacity: 0 }}
                        transition={{ duration: reduce ? 0 : 0.36, ease: EASE_OUT }}
                    >
                        <div className="memory-entry-body">
                            {!detail && !detailError && (
                                <div className="memory-quiet memory-loading-line"><Loader size={14} />正在找出处</div>
                            )}
                            {detailError && <p className="memory-inline-error" role="alert">{detailError}</p>}
                            {detail && <MemoryEvidence detail={detail} timezone={timezone} />}

                            {item.status === 'superseded' && (
                                <p className="memory-quiet">这条认识已经约定会改变，到期后由新的说法接替。</p>
                            )}

                            {item.status === 'active' && mode === 'view' && (
                                <div className="memory-actions">
                                    <Button disabled={busy} onClick={() => setMode('correct')} size="sm" type="button" variant="outline">
                                        <PenLine aria-hidden="true" className="size-3.5" />纠正
                                    </Button>
                                    <label className="memory-resident-toggle">
                                        <Switch
                                            ariaLabel="放进常驻档案"
                                            checked={item.resident}
                                            disabled={busy}
                                            onCheckedChange={checked => void run(() => onResident(checked))}
                                        />
                                        <span>常驻档案</span>
                                    </label>
                                    <Button className="memory-forget-trigger" disabled={busy} onClick={() => setMode('forget')} size="sm" type="button" variant="ghost">
                                        <Eraser aria-hidden="true" className="size-3.5" />忘记
                                    </Button>
                                </div>
                            )}

                            {item.status === 'active' && mode === 'correct' && (
                                <CorrectionForm
                                    busy={busy}
                                    initialContent={item.content}
                                    onCancel={() => {
                                        setMode('view');
                                        setError(null);
                                    }}
                                    onSubmit={input => run(async () => {
                                        await onCorrect(input);
                                        setMode('view');
                                    })}
                                />
                            )}

                            {item.status === 'active' && mode === 'forget' && (
                                <div className="memory-forget-confirm" role="group" aria-label="确认忘记">
                                    <p>忘记之后，我不会再用到它，也不会从同一段对话里重新学到。</p>
                                    <div className="memory-form-actions">
                                        <Button disabled={busy} onClick={() => setMode('view')} size="sm" type="button" variant="ghost">保留</Button>
                                        <Button disabled={busy} onClick={() => void run(onForget)} size="sm" type="button" variant="destructive">
                                            {busy ? '正在忘记' : '忘记'}
                                        </Button>
                                    </div>
                                </div>
                            )}

                            {error && <p className="memory-inline-error" role="alert">{error}</p>}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </li>
    );
}

/**
 * 展示一条认识的原话出处与修订链
 *
 * @param props.detail 来源与修订链
 * @param props.timezone 用户时区
 */
function MemoryEvidence ({ detail, timezone }: { detail: MemoryDetailView; timezone: string }) {
    const [expanded, setExpanded] = useState(false);
    const sources = expanded ? detail.sources : detail.sources.slice(0, VISIBLE_SOURCES);
    const hidden = detail.sources.length - sources.length;

    return (
        <>
            <div className="memory-evidence">
                <h4>出处</h4>
                {detail.sources.length === 0 ? (
                    <p className="memory-quiet">原话已经不在记录里了。</p>
                ) : (
                    <ul className="memory-sources">
                        {sources.map(source => (
                            <li key={source.id}>
                                <blockquote>{source.text ? `「${source.text}」` : '一次工具结果'}</blockquote>
                                <span>{formatMemoryDate(source.occurredFrom, timezone, true)} · {source.actor === 'user' ? '你说' : '对话中'}</span>
                            </li>
                        ))}
                    </ul>
                )}
                {hidden > 0 && (
                    <button className="memory-text-button" onClick={() => setExpanded(true)} type="button">再看 {hidden} 处</button>
                )}
                {detail.sourceCount > detail.sources.length && (
                    <p className="memory-quiet">一共 {detail.sourceCount} 处出处，这里显示最近的 {detail.sources.length} 处。</p>
                )}
            </div>

            {detail.history.length > 1 && (
                <div className="memory-evidence">
                    <h4>变化</h4>
                    <ol className="memory-history">
                        {detail.history.map(version => (
                            <li data-status={version.status} key={version.id}>
                                <span className="memory-history-when">{formatMemoryDate(version.knownFrom, timezone)} · {versionVerb(version)}</span>
                                <span className="memory-history-text">
                                    {version.status === 'forgotten' ? '一条已忘记的认识' : version.content}
                                </span>
                            </li>
                        ))}
                    </ol>
                </div>
            )}
        </>
    );
}

/**
 * 纠正或更新一条认识，并说明两种修正对旧说法的不同处理
 *
 * @param props.initialContent 当前说法
 * @param props.busy 是否正在提交
 * @param props.onSubmit 提交修正
 * @param props.onCancel 放弃修正
 */
function CorrectionForm ({
    initialContent,
    busy,
    onSubmit,
    onCancel,
}: {
    initialContent: string;
    busy: boolean;
    onSubmit: (input: MemoryCorrectionInput) => Promise<void>;
    onCancel: () => void;
}) {
    const [content, setContent] = useState(initialContent);
    const [revisionKind, setRevisionKind] = useState<MemoryRevisionKind>('correction');
    const [validFrom, setValidFrom] = useState('');
    const trimmed = content.trim();
    const ready = trimmed.length >= 4 && trimmed !== initialContent.trim()
        && (revisionKind === 'correction' || Boolean(validFrom));

    /** 提交修正，情况变化时附带开始日期 */
    function handleSubmit (event: { preventDefault: () => void }): void {
        event.preventDefault();
        if (!ready) return;
        void onSubmit({ content: trimmed, revisionKind, ...(revisionKind === 'world_change' && { validFrom }) });
    }

    return (
        <form className="memory-correct-form" onSubmit={handleSubmit}>
            <Tabs onValueChange={value => setRevisionKind(value as MemoryRevisionKind)} value={revisionKind} variant="segment">
                <TabsList>
                    <TabsTrigger className="memory-segment" value="correction">之前记错了</TabsTrigger>
                    <TabsTrigger className="memory-segment" value="world_change">情况变了</TabsTrigger>
                </TabsList>
            </Tabs>
            <p className="memory-hint">
                {revisionKind === 'correction'
                    ? '旧的说法会被标记为记错了，之后不再使用。'
                    : '旧的说法会作为过去的事实保留，到你给出的日期为止。'}
            </p>
            <label className="field-label">
                <span>{revisionKind === 'correction' ? '应该是' : '现在是'}</span>
                <Textarea
                    autoFocus
                    className="memory-correct-text"
                    disabled={busy}
                    maxLength={1000}
                    onChange={event => setContent(event.target.value)}
                    rows={2}
                    value={content}
                />
            </label>
            {revisionKind === 'world_change' && (
                <Input
                    className="memory-date-field"
                    disabled={busy}
                    label="从哪天开始"
                    onChange={setValidFrom}
                    type="date"
                    value={validFrom}
                />
            )}
            <div className="memory-form-actions">
                <Button disabled={busy} onClick={onCancel} size="sm" type="button" variant="ghost">取消</Button>
                <Button disabled={busy || !ready} size="sm" type="submit">{busy ? '正在保存' : '保存修正'}</Button>
            </div>
        </form>
    );
}
