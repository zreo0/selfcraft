import { useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/motion/button';
import { saveModel } from '@/services/runtime';
import type { ConfigView, ModelView, ProviderView } from '@/types/api.types';
import { INITIAL_MODEL, ModelFields } from './ModelFields';

/**
 * 在固定渠道内创建或编辑模型，每次打开重新初始化草稿
 * @param props 渠道、目标模型与保存回调
 * @returns 模型表单
 */
export function ModelForm ({ provider, model, onSaved, onBusy, onEdit }: {
    provider: ProviderView;
    model?: ModelView;
    onSaved: (config: ConfigView) => void;
    onBusy: (busy: boolean) => void;
    onEdit: (model: ModelView) => void;
}) {
    const [input, setInput] = useState(model ? { modelId: model.id, vision: model.vision, contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens } : INITIAL_MODEL);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const pending = useRef(false);
    const duplicate = !model && provider.models.find(item => item.id === input.modelId);

    /**
     * 只提交模型信息，重复新增不会自动转成编辑
     * @param event 表单提交事件
     * @returns 保存完成后结束
     */
    async function handleSubmit (event: FormEvent<HTMLFormElement>): Promise<void> {
        event.preventDefault();
        if (pending.current || duplicate) return;
        pending.current = true;
        setSaving(true);
        onBusy(true);
        setError(null);
        try {
            onSaved(await saveModel({ providerId: provider.id, ...input }, Boolean(model)));
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
            <p className="break-all text-sm text-muted-foreground">所属渠道：<strong className="text-foreground">{provider.id}</strong> · {provider.baseURL || '官方默认地址'}</p>
            <fieldset className="min-w-0" disabled={saving}><ModelFields input={input} editing={Boolean(model)} onChange={setInput} /></fieldset>
            {duplicate && <div role="alert" className="text-sm text-destructive">此渠道已有同名模型。<Button variant="ghost" onClick={() => onEdit(duplicate)}>编辑已有模型</Button></div>}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button disabled={saving || Boolean(duplicate)} type="submit">{saving ? '正在保存' : model ? '保存模型能力' : '添加模型'}</Button>
        </form>
    );
}
