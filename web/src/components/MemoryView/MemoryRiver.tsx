import { motion, useReducedMotion } from 'motion/react';
import { ArrowDown } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/motion/button';
import { Input } from '@/components/motion/input';
import { EASE_OUT } from '@/lib/ease';
import { basisLabel, formatMemoryDate, formatMemoryMonth, versionVerb } from '@/lib/memory-labels';
import type { MemoryItemView, MemoryPendingView } from '@/types/memory.types';

/**
 * 一个版本在河中的标记，决定节点的形状
 *
 * @param item 记忆版本
 * @param currentIds 此刻成立的认识
 * @returns 节点类别
 */
function versionMark (item: MemoryItemView, currentIds: Set<string>): string {
    if (item.status === 'forgotten') return 'forgotten';
    if (item.status === 'candidate') return 'pending';
    if (!currentIds.has(item.id)) return 'replaced';
    return item.supersedesId ? 'revised' : 'learned';
}

/**
 * 右侧的变化之河：河口是等你确认的变化，河道按时间记录每个版本
 *
 * @param props.pending 待确认候选
 * @param props.versions 全部版本，按认知时间倒序
 * @param props.currentIds 此刻成立的认识
 * @param props.timezone 用户时区
 * @param props.litIds 当前选中认识的整条修订链
 * @param props.freshIds 刚刚流入的新版本
 * @param props.busy 是否暂时禁止提交操作
 * @param props.searching 是否处于检索结果中
 * @param props.onConfirm 确认候选
 * @param props.onReject 否定候选
 * @param props.onSelectVersion 从河中回到对应的认识
 */
export function MemoryRiver ({
    pending,
    versions,
    currentIds,
    timezone,
    litIds,
    freshIds,
    busy,
    searching,
    onConfirm,
    onReject,
    onSelectVersion,
}: {
    pending: MemoryPendingView[];
    versions: MemoryItemView[];
    currentIds: Set<string>;
    timezone: string;
    litIds: Set<string>;
    freshIds: Set<string>;
    busy: boolean;
    searching: boolean;
    onConfirm: (id: string, validFrom?: string) => Promise<void>;
    onReject: (id: string) => Promise<void>;
    onSelectVersion: (item: MemoryItemView) => void;
}) {
    const reduce = useReducedMotion();
    const flowRef = useRef<HTMLElement>(null);
    const streamRef = useRef<HTMLOListElement>(null);
    const [trail, setTrail] = useState<{ top: number; height: number } | null>(null);
    const lit = litIds.size > 0;
    // 待确认的候选已经在河口出现，河道里不再重复
    const stream = versions.filter(item => item.status !== 'candidate');

    useEffect(() => {
        const container = flowRef.current;
        const first = container?.querySelector<HTMLElement>('.memory-stream-item[data-lit]');
        // 只滚动河道自身；窄屏上河道不独立滚动，也不应带动整页跳转
        if (!container || !first || container.scrollHeight <= container.clientHeight) return;
        const bounds = container.getBoundingClientRect();
        const target = first.getBoundingClientRect();
        if (target.top >= bounds.top && target.bottom <= bounds.bottom) return;
        container.scrollTo({
            top: container.scrollTop + target.top - bounds.top - container.clientHeight / 3,
            behavior: reduce ? 'auto' : 'smooth',
        });
    }, [litIds, reduce]);

    // 用一段主色河线连接被点亮的首尾节点，让选中认识的整条修订链在河道中连成一段
    useLayoutEffect(() => {
        const list = streamRef.current;
        const nodes = list ? [...list.querySelectorAll<HTMLElement>('.memory-stream-item[data-lit] .memory-stream-node')] : [];
        if (!list || nodes.length < 2) {
            setTrail(null);
            return;
        }
        const origin = list.getBoundingClientRect().top;
        const center = (node: HTMLElement) => {
            const bounds = node.getBoundingClientRect();
            return bounds.top + bounds.height / 2 - origin;
        };
        const top = center(nodes[0]!);
        setTrail({ top, height: center(nodes[nodes.length - 1]!) - top });
    }, [litIds, versions]);

    let month = '';
    return (
        <aside aria-labelledby="memory-flow-title" className="memory-flow" ref={flowRef}>
            <header className="memory-section-title">
                <h2 id="memory-flow-title">流变</h2>
                <p>认识出现、被确认、被改写的时刻。</p>
            </header>

            {pending.length > 0 && (
                <section aria-labelledby="memory-mouth-title" className="memory-mouth">
                    <h3 id="memory-mouth-title">等你确认<span className="memory-count-chip">{pending.length}</span></h3>
                    <p className="memory-quiet">我从对话里学到了这些，但还不确定。</p>
                    <ul>
                        {pending.map(item => (
                            <PendingItem
                                busy={busy}
                                item={item}
                                key={item.id}
                                onConfirm={validFrom => onConfirm(item.id, validFrom)}
                                onReject={() => onReject(item.id)}
                                timezone={timezone}
                            />
                        ))}
                    </ul>
                </section>
            )}

            {stream.length === 0 ? (
                <p className="memory-quiet memory-stream-empty">{searching ? '河里没有相关的痕迹。' : '还没有变化的痕迹。'}</p>
            ) : (
                <ol className="memory-stream" data-lit={lit || undefined} ref={streamRef}>
                    {trail && (
                        <motion.li
                            animate={{ scaleY: 1 }}
                            aria-hidden="true"
                            className="memory-stream-trail"
                            initial={reduce ? false : { scaleY: 0 }}
                            key={[...litIds].join(',')}
                            style={{ top: trail.top, height: trail.height }}
                            transition={{ duration: 0.7, ease: EASE_OUT }}
                        />
                    )}
                    {stream.map(item => {
                        const itemMonth = formatMemoryMonth(item.knownFrom, timezone);
                        const heading = itemMonth !== month;
                        month = itemMonth;
                        const mark = versionMark(item, currentIds);
                        const forgotten = mark === 'forgotten';
                        const fresh = freshIds.has(item.id);
                        return [
                            heading && <li aria-hidden="true" className="memory-stream-month" key={`month-${itemMonth}`}>{itemMonth}</li>,
                            <motion.li
                                animate={{ opacity: 1, y: 0 }}
                                className="memory-stream-item"
                                data-fresh={fresh || undefined}
                                data-lit={litIds.has(item.id) || undefined}
                                data-mark={mark}
                                data-status={item.status}
                                initial={fresh && !reduce ? { opacity: 0, y: -14 } : false}
                                key={item.id}
                                transition={{ duration: 0.6, ease: EASE_OUT }}
                            >
                                <button
                                    aria-label={forgotten ? undefined : `查看：${item.content}`}
                                    className="memory-stream-entry"
                                    disabled={forgotten}
                                    onClick={() => onSelectVersion(item)}
                                    type="button"
                                >
                                    <span aria-hidden="true" className="memory-stream-node" />
                                    <span className="memory-stream-when">
                                        {formatMemoryDate(item.knownFrom, timezone)}
                                        <strong>{versionVerb(item)}</strong>
                                    </span>
                                    <span className="memory-stream-text">
                                        {forgotten ? '一条已经忘记的认识' : item.content}
                                    </span>
                                </button>
                            </motion.li>,
                        ];
                    })}
                </ol>
            )}
        </aside>
    );
}

/**
 * 河口里的一条候选：新认识直接显示，修订候选显示旧说法流向新说法
 *
 * @param props.item 候选
 * @param props.timezone 用户时区
 * @param props.busy 是否正在提交
 * @param props.onConfirm 确认候选
 * @param props.onReject 否定候选
 */
function PendingItem ({
    item,
    timezone,
    busy,
    onConfirm,
    onReject,
}: {
    item: MemoryPendingView;
    timezone: string;
    busy: boolean;
    onConfirm: (validFrom?: string) => Promise<void>;
    onReject: () => Promise<void>;
}) {
    // 情况变化必须知道从哪天开始；候选没有给出时，先按说这句话的日期填好，由用户确认或修改
    const needsDate = item.revisionKind === 'world_change' && !item.validFrom;
    const [validFrom, setValidFrom] = useState(() => new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(item.knownFrom)));
    const [error, setError] = useState<string | null>(null);
    const [pendingAction, setPendingAction] = useState<'confirm' | 'reject' | null>(null);
    const reason = item.previous
        ? item.revisionKind === 'world_change'
            ? `情况可能变了${item.validFrom ? ` · ${formatMemoryDate(item.validFrom, timezone)}起` : ''}`
            : '之前可能记错了'
        : basisLabel(item.basis);

    /** 执行确认或否定，失败时保留在这条候选旁边 */
    async function run (kind: 'confirm' | 'reject', action: () => Promise<void>): Promise<void> {
        setError(null);
        setPendingAction(kind);
        try {
            await action();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : '操作没有完成，请稍后再试');
        } finally {
            setPendingAction(null);
        }
    }

    return (
        <li className="memory-pending">
            <span aria-hidden="true" className="memory-stream-node" data-mark="pending" />
            <div className="memory-pending-body">
                {item.previous ? (
                    <p className="memory-pending-change">
                        <s>{item.previous.status === 'forgotten' ? '一条已忘记的认识' : item.previous.content}</s>
                        <ArrowDown aria-label="改为" className="memory-pending-arrow" />
                        <span>{item.content}</span>
                    </p>
                ) : (
                    <p className="memory-pending-text">{item.content}</p>
                )}
                <p className="memory-pending-meta">{reason} · {formatMemoryDate(item.knownFrom, timezone)}</p>
                {item.confirmable && needsDate && (
                    <>
                        <Input
                            className="memory-date-field"
                            disabled={busy}
                            label="从哪天开始"
                            onChange={setValidFrom}
                            type="date"
                            value={validFrom}
                        />
                        <p className="memory-hint">先按你说这句话的日期填好了，不对可以改。</p>
                    </>
                )}
                {!item.confirmable && <p className="memory-hint">原认识已变化或被忘记，请通过对话重新核对，也可以移除此候选。</p>}
                <div className="memory-form-actions memory-pending-actions">
                    <Button
                        disabled={busy || !item.confirmable || (needsDate && !validFrom)}
                        onClick={() => void run('confirm', () => onConfirm(needsDate ? validFrom : undefined))}
                        size="sm"
                        type="button"
                        variant="outline"
                    >
                        {pendingAction === 'confirm' ? '正在确认' : '确认'}
                    </Button>
                    <Button disabled={busy} onClick={() => void run('reject', onReject)} size="sm" type="button" variant="ghost">
                        {pendingAction === 'reject' ? '正在移除' : item.confirmable ? '不对' : '移除候选'}
                    </Button>
                </div>
                {error && <p className="memory-inline-error" role="alert">{error}</p>}
            </div>
        </li>
    );
}
