import { useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/motion/button';
import { createProvider, updateProvider } from '@/services/runtime';
import type { ConfigView, ProviderView } from '@/types/api.types';
import { INITIAL_PROVIDER, ProviderFields } from './ProviderFields';

/**
 * 创建渠道或显式编辑连接，初始草稿由每次打开表单时的渠道决定
 * @param props 目标渠道、保存及忙碌回调
 * @returns 独立渠道表单
 */
export function ProviderForm ({ provider, onSaved, onBusy }: {
    provider?: ProviderView;
    onSaved: (config: ConfigView, providerId: string) => void;
    onBusy: (busy: boolean) => void;
}) {
    const [input, setInput] = useState(provider ? { providerId: provider.id, type: provider.type, baseURL: provider.baseURL || '', apiKey: '' } : INITIAL_PROVIDER);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const pending = useRef(false);

    /**
     * 仅提交渠道字段并清空已提交的 Key
     * @param event 表单提交事件
     * @returns 保存完成后结束
     */
    async function handleSubmit (event: FormEvent<HTMLFormElement>): Promise<void> {
        event.preventDefault();
        if (pending.current) return;
        pending.current = true;
        setSaving(true);
        onBusy(true);
        setError(null);
        try {
            const next = provider ? await updateProvider(input) : await createProvider(input);
            setInput(current => ({ ...current, apiKey: '' }));
            onSaved(next, input.providerId);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : '保存失败，请刷新配置核对后重试');
        } finally {
            pending.current = false;
            setSaving(false);
            onBusy(false);
        }
    }

    return (
        <form className="settings-form" onSubmit={handleSubmit}>
            {provider && <p className="text-sm text-muted-foreground">修改连接会影响此渠道下的 {provider.models.length} 个模型。模型能力和用途保持不变。</p>}
            <fieldset className="min-w-0" disabled={saving}><ProviderFields input={input} editing={Boolean(provider)} onChange={setInput} /></fieldset>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button disabled={saving} type="submit">{saving ? '正在保存' : provider ? '保存渠道连接' : '创建渠道并添加模型'}</Button>
        </form>
    );
}
