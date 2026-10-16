import { useState } from 'react';
import { Button } from '@/components/motion/button';
import { listInteractions } from '@/services/interaction';
import type { InteractionView } from '@/types/interaction.types';
import { InteractionCard } from '@/components/InteractionCard';

/** 为聊天窗口之外的待回答表单提供有界分页入口 */
export function InteractionInbox ({ instanceId }: { instanceId: string }) {
    const [open, setOpen] = useState(false);
    const [items, setItems] = useState<InteractionView[]>([]);
    const [cursor, setCursor] = useState<number | null>(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    /** 打开时刷新首页，后续按稳定游标追加 */
    async function load (after: number): Promise<void> {
        setBusy(true); setError(null);
        try {
            const page = await listInteractions(after);
            setItems(previous => after === 0 ? page.items : [...previous, ...page.items.filter(item => !previous.some(old => old.id === item.id))]);
            setCursor(page.nextCursor);
        } catch (cause) { setError(String(cause)); }
        finally { setBusy(false); }
    }

    return <div className="space-y-3">
        <Button variant="ghost" size="sm" aria-expanded={open} type="button" onClick={() => {
            setOpen(!open); if (!open) void load(0);
        }}>{open ? '收起待回答' : '查看待回答交互'}</Button>
        {open && <section aria-label="待回答交互" className="space-y-3 rounded-xl border border-border p-3">
            {items.map(item => <InteractionCard key={instanceId + item.id} value={item} instanceId={instanceId} />)}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {!busy && !error && !items.length && <p className="text-sm text-muted-foreground">没有待回答交互</p>}
            {cursor !== null && <Button disabled={busy} variant="outline" type="button" onClick={() => void load(cursor)}>{busy ? '正在读取' : error ? '重试' : '加载更多'}</Button>}
        </section>}
    </div>;
}
