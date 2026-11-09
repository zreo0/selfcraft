import { useRef, useState } from 'react';
import { Combobox } from '@/components/motion/combobox';
import { useModel } from '@/services/runtime';
import type { ConfigView } from '@/types/api.types';

/**
 * 配置默认、反思和整理用途，模型数据以 Runtime 回执为准
 * @param props 当前配置、忙碌状态及配置更新回调
 * @returns 模型用途选择区
 */
export function ModelUsage ({ config, busy, onBusy, onChanged }: {
    config: ConfigView;
    busy: boolean;
    onBusy: (busy: boolean) => void;
    onChanged: (config: ConfigView) => void;
}) {
    const [error, setError] = useState<string | null>(null);
    const pending = useRef(false);
    const rows = config.providers.flatMap(provider => provider.models.map(model => ({ provider, model })));
    const options = rows.map(({ provider, model }) => ({ value: `${provider.id}/${model.id}`, label: `${provider.id} / ${model.id}`, disabled: !provider.credentialConfigured && provider.auth !== 'none' }));

    /**
     * 保存用途或推理设置，拒绝重复提交
     * @param value 渠道与模型组合或继承选项
     * @param purpose 目标用途
     * @param effort 可选推理强度
     * @returns 请求结束后释放忙碌状态
     */
    async function selectModel (value: string, purpose: 'agent' | 'reflection' | 'compression', effort?: 'low' | 'medium' | 'high'): Promise<void> {
        if (pending.current || busy) return;
        const row = rows.find(item => `${item.provider.id}/${item.model.id}` === value);
        if (!row && (purpose === 'agent' || value !== 'inherit')) return;
        pending.current = true;
        onBusy(true);
        setError(null);
        try {
            onChanged(await useModel(row?.provider.id || '', row?.model.id || '', purpose, effort));
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : '切换失败');
        } finally {
            pending.current = false;
            onBusy(false);
        }
    }

    if (!rows.length) return <p className="text-sm text-muted-foreground">还没有模型。请在下方创建渠道，再为渠道添加模型。</p>;
    return (
        <div className="settings-form">
            <div className="field-label">
                <span>默认模型</span>
                <Combobox ariaLabel="默认模型" disabled={busy} options={options} value={config.defaultModel ? `${config.defaultModel.providerId}/${config.defaultModel.modelId}` : ''} placeholder="请选择默认模型" onValueChange={value => void selectModel(value, 'agent')} />
            </div>
            <details className="provider-advanced">
                <summary>反思、整理与推理设置</summary>
                <p className="my-3 text-sm text-muted-foreground">反思和上下文整理默认跟随默认模型，也可以单独选择。</p>
                <div className="settings-grid">
                    {(['reflection', 'compression'] as const).map(purpose => {
                        const selection = config.modelOverrides[purpose];
                        const label = purpose === 'reflection' ? '独处反思' : '上下文整理';
                        return (
                            <div className="field-label" key={purpose}>
                                <span>{label}</span>
                                <Combobox ariaLabel={label} disabled={busy} options={[{ value: 'inherit', label: '跟随默认模型' }, ...options]} value={selection ? `${selection.providerId}/${selection.modelId}` : 'inherit'} onValueChange={value => void selectModel(value, purpose)} />
                            </div>
                        );
                    })}
                </div>
                <p className="my-3 text-sm text-muted-foreground">推理强度默认交给提供方；请仅在模型支持调节时修改。</p>
                <div className="settings-grid">
                    {(['agent', 'reflection', 'compression'] as const).map(purpose => {
                        const selection = purpose === 'agent' ? config.defaultModel : config.modelOverrides[purpose];
                        if (!selection) return null;
                        const label = { agent: '默认模型', reflection: '反思', compression: '上下文整理' }[purpose];
                        return (
                            <div className="field-label" key={purpose}>
                                <span>{label}推理强度</span>
                                <Combobox ariaLabel={`${label}推理强度`} disabled={busy} options={[{ value: 'default', label: '提供方默认' }, { value: 'low', label: '低' }, { value: 'medium', label: '中' }, { value: 'high', label: '高' }]} value={selection.reasoningEffort || 'default'} onValueChange={value => void selectModel(`${selection.providerId}/${selection.modelId}`, purpose, value === 'default' ? undefined : value as 'low' | 'medium' | 'high')} />
                            </div>
                        );
                    })}
                </div>
            </details>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
    );
}
