/*
 * THESIS: 记忆是一本正在书写的账本，而不是后台表格。左边是助理此刻对你的认识，右边是一条贴着页面流动的变化之河
 * OWN-WORLD: 沿用「安静运行的仪器」：近白与深灰底面、一像素细线、衬线只用于页面标题；节点的实心与空心是贯穿两栏的唯一图形语言
 * STORY: 你看到它记住了什么、为什么这样认为，并能就地确认、纠正或忘记；每次修正都会作为新的一段流进河里
 * FIRST VIEWPORT: 左栏为标题、检索与唯一的焦点面「常驻档案」；右栏为粘附的「流变」，河口是等你确认的变化
 * FORM: 此刻与流变（候选第 3 位，seed ed619b82）
 */
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { MessageCircle, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageTitle } from '@/components/PageTitle';
import { Button } from '@/components/motion/button';
import { Input } from '@/components/motion/input';
import { Loader } from '@/components/motion/loader';
import { Tabs, TabsList, TabsTrigger } from '@/components/motion/tabs';
import { BRAND_IMAGE_PATH } from '@/lib/brand';
import { EASE_OUT } from '@/lib/ease';
import { isCurrentMemory, MEMORY_KIND_LABELS } from '@/lib/memory-labels';
import {
    confirmMemory,
    correctMemory,
    forgetMemory,
    getMemoryDetail,
    getMemoryOverview,
    setMemoryResident,
} from '@/services/memory';
import type {
    MemoryCorrectionInput,
    MemoryDetailView,
    MemoryItemView,
    MemoryOverview,
} from '@/types/memory.types';
import { MemoryEntry } from './MemoryEntry';
import { MemoryRiver } from './MemoryRiver';

type MemoryPane = 'now' | 'flow';
type MemoryLoadState = 'refresh' | 'search' | 'more';

/** 检索输入停顿多久后再请求 Runtime */
const SEARCH_DELAY_MS = 260;

/**
 * 记忆页：把助理此刻的认识与它们的变化并排展开，并支持就地修正
 *
 * @param props.active 页面是否可见，可见时重新读取最新记忆
 * @param props.timezone 用户时区
 * @param props.onOpenChat 空状态下回到对话
 */
export function MemoryView ({
    active,
    timezone,
    onOpenChat,
}: {
    active: boolean;
    timezone: string;
    onOpenChat: () => void;
}) {
    const reduce = useReducedMotion();
    const [overview, setOverview] = useState<MemoryOverview | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [loadState, setLoadState] = useState<MemoryLoadState | null>(null);
    const [showLoadStatus, setShowLoadStatus] = useState(false);
    const [overviewQuery, setOverviewQuery] = useState('');
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [detail, setDetail] = useState<MemoryDetailView | null>(null);
    const [detailError, setDetailError] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
    const [pane, setPane] = useState<MemoryPane>('now');
    const [announcement, setAnnouncement] = useState('');
    const detailRequest = useRef(0);
    const overviewRef = useRef<MemoryOverview | null>(null);
    const overviewRequest = useRef(0);
    const queryRef = useRef('');
    const overviewQueryRef = useRef('');
    queryRef.current = query.trim();
    const loading = loadState !== null;

    /** 按当前检索词刷新或追加一页，旧请求晚到时不覆盖新结果 */
    const load = useCallback(async (text = queryRef.current, offset = 0): Promise<MemoryOverview | null> => {
        const request = ++overviewRequest.current;
        setLoadState(offset > 0 ? 'more' : text !== overviewQueryRef.current ? 'search' : 'refresh');
        try {
            const next = await getMemoryOverview(text, offset);
            if (request !== overviewRequest.current || text !== queryRef.current) return null;
            const previous = overviewRef.current;
            if (previous && offset === 0 && text === overviewQueryRef.current) {
                const known = new Set(previous.versions.map(item => item.id));
                setFreshIds(new Set(next.versions.filter(item => !known.has(item.id)).map(item => item.id)));
            } else {
                setFreshIds(new Set());
            }
            if (previous && offset > 0) {
                next.current = mergeEntries(previous.current, next.current);
                next.pending = mergeEntries(previous.pending, next.pending);
                next.versions = mergeEntries(previous.versions, next.versions);
            }
            overviewRef.current = next;
            overviewQueryRef.current = text;
            setOverviewQuery(text);
            setOverview(next);
            setLoadError(null);
            return next;
        } catch (error) {
            if (request === overviewRequest.current) setLoadError(error instanceof Error ? error.message : '无法读取记忆');
            return null;
        } finally {
            if (request === overviewRequest.current) setLoadState(null);
        }
    }, []);

    useEffect(() => {
        if (!active) return;
        setLoadState(query.trim() !== overviewQueryRef.current ? 'search' : 'refresh');
        const timer = window.setTimeout(() => void load(query.trim()), query.trim() ? SEARCH_DELAY_MS : 0);
        return () => {
            window.clearTimeout(timer);
            overviewRequest.current++;
        };
    }, [active, query, load]);

    useEffect(() => {
        setShowLoadStatus(false);
        if (!active || !loading) return;
        // 快速刷新不打断阅读，较慢请求只在固定位置显示一处提示
        const timer = window.setTimeout(() => setShowLoadStatus(true), 400);
        return () => window.clearTimeout(timer);
    }, [active, loading]);

    /** 读取一条认识的出处与修订链，旧请求晚到时丢弃 */
    const loadDetail = useCallback(async (id: string): Promise<MemoryDetailView | null> => {
        const request = ++detailRequest.current;
        setDetailError(null);
        try {
            const next = await getMemoryDetail(id);
            if (request !== detailRequest.current) return null;
            setDetail(next);
            return next;
        } catch (error) {
            if (request === detailRequest.current) {
                setDetail(null);
                setDetailError(error instanceof Error ? error.message : '无法读取出处');
            }
            return null;
        }
    }, []);

    /** 展开或收起一条认识；展开时让右侧的河点亮它的整条痕迹 */
    const select = useCallback((id: string | null): void => {
        setSelectedId(id);
        setDetail(null);
        setDetailError(null);
        detailRequest.current++;
    }, []);

    useEffect(() => {
        select(null);
    }, [query, select]);

    useEffect(() => {
        if (!active || !selectedId) return;
        // 列表刷新或重新进入页面时也重读详情，避免继续展示旧的遗忘状态
        void loadDetail(selectedId);
        return () => { detailRequest.current++; };
    }, [active, selectedId, overview, loadDetail]);

    useEffect(() => {
        if (!selectedId) return;
        /** Esc 收起当前展开的认识 */
        function handleKey (event: KeyboardEvent): void {
            if (event.key === 'Escape' && !(event.target instanceof HTMLTextAreaElement)) {
                select(null);
            }
        }
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [select, selectedId]);

    /**
     * 提交一次修正并刷新全部记忆，让新版本流进河里
     *
     * @param id 目标认识
     * @param action 实际请求
     * @param message 完成后读给辅助技术的提示
     * @returns 操作后的认识
     */
    async function act (id: string, action: () => Promise<MemoryItemView>, message: string): Promise<MemoryItemView> {
        setBusyId(id);
        try {
            const result = await action();
            if (!await load()) throw new Error('修改已保存，但列表未能刷新，请重试加载');
            setAnnouncement(message);
            return result;
        } finally {
            setBusyId(null);
        }
    }

    /** 从河中的某个版本回到它此刻对应的认识 */
    async function handleSelectVersion (item: MemoryItemView): Promise<void> {
        // 旧版本沿修订链找到仍然成立的那一版；整条链都已失效时只点亮痕迹
        const request = ++detailRequest.current;
        const next = await getMemoryDetail(item.id).catch(() => null);
        if (!next || request !== detailRequest.current) return;
        const head = [...next.history].reverse().find(isCurrentMemory);
        if (head) {
            focusEntry(head);
        } else {
            setSelectedId(null);
            setDetail(next);
        }
    }

    /** 展开指定认识，并在窄屏上切回「此刻」 */
    function focusEntry (item: MemoryItemView): void {
        const id = item.id;
        if (id === selectedId) void loadDetail(id);
        else select(id);
        setPane('now');
        window.requestAnimationFrame(() => {
            document.getElementById(`memory-${id}`)?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
        });
    }

    const view = useMemo(() => {
        if (!overview) return null;
        const profileOrder = new Map(overview.profileIds.map((id, index) => [id, index]));
        const profile = overview.current
            .filter(item => profileOrder.has(item.id))
            .sort((left, right) => profileOrder.get(left.id)! - profileOrder.get(right.id)!);
        const others = overview.current.filter(item => !profileOrder.has(item.id));
        return {
            stated: profile.filter(item => item.basis === 'stated'),
            observed: profile.filter(item => item.basis !== 'stated'),
            profileCount: profile.length,
            // 标记常驻但因档案篇幅没有放入的认识，如实告诉用户
            overflow: others.filter(item => item.resident && (!item.validFrom || Date.parse(item.validFrom) <= Date.now())).length,
            groups: MEMORY_KIND_LABELS
                .map(([kind, label]) => ({ kind, label, items: others.filter(item => item.kind === kind) }))
                .filter(group => group.items.length > 0),
            pending: overview.pending,
            versions: overview.versions,
            currentIds: new Set([...overview.current, ...overview.versions].filter(isCurrentMemory).map(item => item.id)),
            total: overview.totals.current,
            empty: Object.values(overview.totals).every(total => total === 0),
        };
    }, [overview]);

    const litIds = useMemo(() => new Set(detail?.history.map(item => item.id) || []), [detail]);

    if (!overview || !view) {
        return (
            <section className="memory-view memory-view--status">
                {loadError ? (
                    <div className="chat-error memory-load-error" role="alert">
                        <div className="chat-error-copy"><strong>记忆暂时读不出来</strong><p>{loadError}</p></div>
                        <Button onClick={() => void load()} size="sm" type="button" variant="outline">重试</Button>
                    </div>
                ) : (
                    <div className="memory-quiet memory-loading-line"><Loader size={16} />正在翻阅记忆</div>
                )}
            </section>
        );
    }

    if (view.empty && !query.trim() && !overviewQuery && !loadError) {
        return (
            <section className="memory-view memory-view--status">
                <div className="memory-empty">
                    <span className="brand-core brand-core--large"><img alt="" src={BRAND_IMAGE_PATH} /></span>
                    <h1>我们还不太熟</h1>
                    <p>聊得越久，我会慢慢记下关于你的事。每一条都会出现在这里，你随时可以纠正或让我忘记。</p>
                    <Button onClick={onOpenChat} type="button"><MessageCircle aria-hidden="true" className="size-4" />去聊聊</Button>
                </div>
            </section>
        );
    }

    const searching = Boolean(query.trim());
    const nothingFound = searching && !loading && !loadError && view.empty;

    /** 为每条认识绑定展开与修正操作 */
    const renderEntry = (item: MemoryItemView, inProfile = false) => (
        <MemoryEntry
            busy={busyId !== null || loadState === 'search' || Boolean(loadError)}
            detail={selectedId === item.id ? detail : null}
            detailError={selectedId === item.id ? detailError : null}
            item={item}
            key={item.id}
            onCorrect={async (input: MemoryCorrectionInput) => {
                const next = await act(item.id, () => correctMemory(item.id, input), '已修正，新的说法流进了变化之河');
                select(next.id);
            }}
            onForget={async () => {
                await act(item.id, () => forgetMemory(item.id), '已经忘记');
                select(null);
            }}
            onResident={async resident => {
                await act(item.id, () => setMemoryResident(item.id, resident), resident ? '已放进常驻档案' : '已移出常驻档案');
            }}
            onToggle={() => select(selectedId === item.id ? null : item.id)}
            selected={selectedId === item.id}
            showPin={!inProfile}
            timezone={timezone}
        />
    );

    return (
        <section aria-labelledby="memory-title" className="memory-view">
            <div className="memory-layout" data-pane={pane}>
                <div className="memory-now">
                    <header className="memory-header">
                        <PageTitle active={active} id="memory-title" variant="flow">记忆</PageTitle>
                        <p className="memory-lede">这是我此刻对你的认识。每一条都来自我们说过的话，你可以随时纠正，或者让我忘记。</p>
                        <Input
                            aria-label="检索记忆"
                            className="memory-search"
                            leftIcon={<Search aria-hidden="true" />}
                            onChange={setQuery}
                            placeholder="找一段记忆，比如「咖啡」"
                            rightIcon={query ? (
                                <button aria-label="清除检索" onClick={() => setQuery('')} type="button"><X aria-hidden="true" /></button>
                            ) : undefined}
                            value={query}
                        />
                        <div className="memory-summary">
                            <p>
                                {overviewQuery
                                    ? `找到 ${overview.totals.current} 条当前认识 · ${overview.totals.pending} 条候选 · ${overview.totals.versions} 条版本记录`
                                    : `${view.total} 条认识 · ${view.profileCount} 条常驻${overview.totals.pending ? ` · ${overview.totals.pending} 条等你确认` : ''}`}
                            </p>
                            <span className="memory-refresh-status" role="status">
                                {loading && showLoadStatus && (loadState === 'search' ? '正在检索…' : loadState === 'more' ? '正在加载更多…' : '正在更新…')}
                            </span>
                        </div>
                    </header>
                    {loadError && (
                        <div className="chat-error" role="alert">
                            <p>{loadError}</p>
                            <Button disabled={loading} onClick={() => void load()} size="sm" type="button" variant="outline">重试加载</Button>
                        </div>
                    )}

                    <div className="memory-panes">
                        <Tabs onValueChange={value => setPane(value as MemoryPane)} value={pane} variant="segment">
                            <TabsList>
                                <TabsTrigger value="now">此刻</TabsTrigger>
                                <TabsTrigger value="flow">
                                    流变{view.pending.length > 0 && <span className="memory-count-chip">{view.pending.length}</span>}
                                </TabsTrigger>
                            </TabsList>
                        </Tabs>
                    </div>

                    <div className="memory-ledger">
                        {nothingFound && <p className="memory-quiet memory-no-match">没有找到和「{query.trim()}」有关的认识。</p>}

                        {detail && selectedId === detail.memory.id && isCurrentMemory(detail.memory)
                            && !overview.current.some(item => item.id === selectedId) && (
                            <section className="memory-others" aria-label="选中的认识">
                                <div className="memory-section-title"><h2>选中的认识</h2></div>
                                <ul>{renderEntry(detail.memory)}</ul>
                            </section>
                        )}

                        {(!searching || view.stated.length + view.observed.length > 0) && (
                            <section aria-labelledby="memory-profile-title" className="memory-profile">
                                <div className="memory-section-title">
                                    <h2 id="memory-profile-title">常驻档案</h2>
                                    <p>每次对话，我都会带着这些。</p>
                                </div>
                                {view.stated.length > 0 && (
                                    <div className="memory-group">
                                        <h3>你告诉我的</h3>
                                        <ul>{view.stated.map(item => renderEntry(item, true))}</ul>
                                    </div>
                                )}
                                {view.observed.length > 0 && (
                                    <div className="memory-group">
                                        <h3>我观察到的</h3>
                                        <ul>{view.observed.map(item => renderEntry(item, true))}</ul>
                                    </div>
                                )}
                                {view.profileCount === 0 && (
                                    <p className="memory-quiet">还没有常驻的认识。展开任意一条，可以把它放进档案。</p>
                                )}
                                {view.overflow > 0 && !searching && (
                                    <p className="memory-quiet">另有 {view.overflow} 条常驻认识，因为档案篇幅有限，这次没有带上。</p>
                                )}
                            </section>
                        )}

                        {view.groups.length > 0 && (
                            <section aria-labelledby="memory-others-title" className="memory-others">
                                <div className="memory-section-title">
                                    <h2 id="memory-others-title">其他认识</h2>
                                    <p>只在相关的时候，我才会想起它们。</p>
                                </div>
                                {view.groups.map(group => (
                                    <div className="memory-group" key={group.kind}>
                                        <h3>{group.label}<span>{group.items.length}</span></h3>
                                        <ul>{group.items.map(item => renderEntry(item))}</ul>
                                    </div>
                                ))}
                            </section>
                        )}
                    </div>
                </div>

                <MemoryRiver
                    busy={busyId !== null || loadState === 'search' || Boolean(loadError)}
                    currentIds={view.currentIds}
                    freshIds={freshIds}
                    litIds={litIds}
                    onConfirm={async (id, validFrom) => {
                        await act(id, () => confirmMemory(id, validFrom), '已确认，这条认识开始生效');
                    }}
                    onReject={async id => {
                        await act(id, () => forgetMemory(id), '已否定，我不会再从这段话里学到它');
                    }}
                    onSelectVersion={item => void handleSelectVersion(item)}
                    pending={view.pending}
                    searching={searching}
                    timezone={timezone}
                    versions={view.versions}
                />
            </div>

            <div className="memory-pagination">
                <p className="memory-quiet">已加载 {overview.current.length}/{overview.totals.current} 条当前认识 · {overview.pending.length}/{overview.totals.pending} 条候选 · {overview.versions.length}/{overview.totals.versions} 条版本记录</p>
                {overview.nextOffset !== null && (
                    <Button disabled={loading || busyId !== null} onClick={() => void load(query.trim(), overview.nextOffset!)} type="button" variant="outline">
                        {loadState === 'more' ? '正在加载' : '加载更多记忆'}
                    </Button>
                )}
            </div>

            <AnimatePresence>
                {detail && !selectedId && (
                    <motion.div
                        animate={{ opacity: 1, y: 0 }}
                        className="memory-lit-note"
                        exit={{ opacity: 0, y: 8 }}
                        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
                        transition={{ duration: 0.28, ease: EASE_OUT }}
                    >
                        <span>这条认识已经不再成立，河里点亮的是它曾经的样子。</span>
                        <button className="memory-text-button" onClick={() => select(null)} type="button">收起</button>
                    </motion.div>
                )}
            </AnimatePresence>
            <p aria-live="polite" className="sr-only">{announcement}</p>
        </section>
    );
}

/** 追加一页或一个定位记录，保留原顺序并以最新内容替换同一标识 */
function mergeEntries<T extends { id: string }> (previous: T[], next: T[]): T[] {
    return [...new Map([...previous, ...next].map(item => [item.id, item])).values()];
}
