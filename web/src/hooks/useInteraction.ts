import { useEffect, useRef, useState } from 'react';
import { getInteraction, interactionReceipt, InteractionRequestError, saveInteraction, submitInteraction } from '@/services/interaction';
import type { InteractionSubmission, InteractionValues, InteractionView } from '@/types/interaction.types';

/** 保存本轮填写与待确认提交；服务端仍是最终事实来源 */
export function useInteraction (incoming: InteractionView, instanceId: string) {
    const key = `selfcraft-ui:${instanceId}:${incoming.id}`;
    const [view, setView] = useState(incoming);
    const [values, setValues] = useState<InteractionValues>(incoming.values);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [pending, setPending] = useState<InteractionSubmission | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [conflicted, setConflicted] = useState(false);
    const baseRevision = useRef(incoming.revision);
    const mounted = useRef(true);
    const submitting = useRef(false);
    const dirty = useRef(false);
    const saving = useRef<Promise<void> | null>(null);
    const current = useRef({ view, values, pending });
    current.current = { view, values, pending };

    /** 先保存用户输入再发送，存储失败不能伪装为已经保存 */
    function persist (nextValues: InteractionValues, request: InteractionSubmission | null): void {
        localStorage.setItem(key, JSON.stringify({ values: nextValues, pending: request, revision: baseRevision.current }));
    }

    useEffect(() => {
        let alive = true; mounted.current = true;
        try {
            const saved = JSON.parse(localStorage.getItem(key) || 'null');
            if (saved) { setValues(saved.values); setPending(saved.pending); baseRevision.current = saved.revision; dirty.current = true; }
        } catch { setError('无法恢复本地填写，请核对后重新输入'); }
        void getInteraction(incoming.id).then(latest => {
            if (!alive) return;
            setView(latest);
            const saved = JSON.parse(localStorage.getItem(key) || 'null');
            if (latest.status !== 'ready') {
                dirty.current = false; setValues(latest.values); setPending(null); localStorage.removeItem(key);
            } else if (saved?.pending) {
                void interactionReceipt(saved.pending.submissionId).then(() => getInteraction(incoming.id)).then(done => {
                    if (alive) { setView(done); setValues(done.values); setPending(null); dirty.current = false; localStorage.removeItem(key); }
                }).catch(() => { if (alive) setError('提交回执尚未确认，请使用原提交重试'); });
            } else if (saved && saved.revision !== latest.revision) { setConflicted(true); setError('表单已变化，本地填写已保留，请先核对最新版本'); }
            else if (!saved) { setValues(latest.values); baseRevision.current = latest.revision; }
            setLoaded(true);
        }).catch(cause => { if (alive) setError(String(cause)); });
        return () => { alive = false; mounted.current = false; };
    }, [key, incoming.id]);

    useEffect(() => {
        if (incoming.revision <= current.current.view.revision) return;
        setView(incoming);
        if (incoming.status !== 'ready' || !dirty.current) {
            setValues(incoming.values); setPending(null); dirty.current = false; baseRevision.current = incoming.revision;
            if (incoming.status !== 'ready') localStorage.removeItem(key);
        } else if (!saving.current) { setConflicted(true); setError('其他客户端修改了表单，本地填写已保留，请核对最新版本'); }
    }, [incoming, key]);

    /** 更新本地字段并留下可恢复草稿 */
    function change (name: string, value: string | string[]): void {
        const next = { ...current.current.values, [name]: value };
        setValues(next); current.current.values = next; dirty.current = true;
        try { persist(next, current.current.pending); } catch { setError('本地保存失败，请勿关闭页面'); }
    }

    /** 串行保存当前快照，不覆盖版本冲突 */
    async function save (): Promise<void> {
        if (saving.current) return saving.current;
        const snapshot = { ...current.current, values: { ...current.current.values } };
        if (!loaded || conflicted || !dirty.current || snapshot.pending || snapshot.view.status !== 'ready') return;
        const operation = (async () => {
            const latest = await saveInteraction(snapshot.view.id, baseRevision.current, snapshot.values);
            if (!mounted.current) return;
            baseRevision.current = latest.revision;
            if (current.current.view.revision > latest.revision) { setConflicted(true); throw new Error('其他客户端修改了表单，请核对最新版本'); }
            setView(latest); current.current.view = latest;
            if (JSON.stringify(current.current.values) === JSON.stringify(snapshot.values)) dirty.current = false;
            persist(current.current.values, current.current.pending);
        })();
        saving.current = operation;
        try { await operation; } finally { saving.current = null; }
    }
    useEffect(() => {
        if (!loaded || conflicted || !dirty.current || error || pending || busy) return;
        const timer = setTimeout(() => { void save().catch(cause => setError(String(cause))); }, 500);
        return () => clearTimeout(timer);
    }, [values, view.revision, error, pending, busy, loaded, conflicted]);

    /** 明确核对最新版本后保留本地填写，不自动解决跨端冲突 */
    async function refresh (): Promise<void> {
        try {
            const latest = await getInteraction(view.id);
            setView(latest); current.current.view = latest; baseRevision.current = latest.revision;
            setConflicted(false); setLoaded(true);
            if (latest.status !== 'ready') { setValues(latest.values); setPending(null); dirty.current = false; localStorage.removeItem(key); }
            else persist(current.current.values, current.current.pending);
            setError(null);
        } catch (cause) { setError(String(cause)); }
    }

    /** 先持久化提交意图，再请求；超时重试复用原始内容 */
    async function submit (): Promise<void> {
        if (!loaded || submitting.current || (conflicted && !pending)) return;
        submitting.current = true;
        setBusy(true); setError(null);
        try {
            if (saving.current) await saving.current;
            const snapshot = current.current;
            const request = snapshot.pending || { submissionId: crypto.randomUUID(), expectedRevision: baseRevision.current,
                actionId: 'submit' as const, values: snapshot.values };
            persist(request.values, request); setPending(request); current.current.pending = request;
            await submitInteraction(view.id, request);
            const latest = await getInteraction(view.id);
            if (!mounted.current) return;
            setView(latest); setValues(latest.values); setPending(null); current.current.pending = null;
            dirty.current = false; localStorage.removeItem(key);
        } catch (cause) {
            if (!mounted.current) return;
            if (cause instanceof InteractionRequestError && [409, 422].includes(cause.status)) {
                setConflicted(cause.status === 409);
                setPending(null); current.current.pending = null;
                persist(current.current.values, null);
            }
            setError(cause instanceof Error ? cause.message : '提交结果未知，请重试确认');
        } finally { submitting.current = false; if (mounted.current) setBusy(false); }
    }
    return { view, values, error, busy, pending, loaded, conflicted, change, submit, refresh };
}
