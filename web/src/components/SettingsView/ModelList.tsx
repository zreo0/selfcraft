import { Check, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/motion/button';
import { Combobox } from '@/components/motion/combobox';
import { testModel, useModel } from '@/services/runtime';
import type { ConfigView } from '@/types/api.types';

/** 展示全部模型并允许切换唯一活动模型 */
export function ModelList ({ config, onChanged }: { config: ConfigView; onChanged: (config: ConfigView) => void }) {
    const [switching, setSwitching] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [testResult, setTestResult] = useState<string | null>(null);

    /** 切换后续对话使用的模型 */
    async function handleUseModel (providerId: string, modelId: string, purpose: 'agent' | 'reflection' | 'compression' = 'agent', reasoningEffort?: 'low' | 'medium' | 'high'): Promise<void> {
        const key = `${providerId}/${modelId}`;
        setSwitching(key);
        setError(null);
        try {
            onChanged(await useModel(providerId, modelId, purpose, reasoningEffort));
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : '切换失败');
        } finally {
            setSwitching(null);
        }
    }

    /** 用户点击后发送一次有界测试请求，不修改模型选择 */
    async function handleTest (providerId: string, modelId: string): Promise<void> {
        setSwitching(`${providerId}/${modelId}`);
        setError(null);
        setTestResult(null);
        try {
            const result = await testModel(providerId, modelId);
            setTestResult(`${providerId}/${modelId} 流式连接成功 · ${(result.durationMs / 1000).toFixed(1)} 秒${result.warnings.length ? ' · 提供方返回参数支持警告' : ''}${result.finishReason === 'length' ? ' · 达到测试输出上限' : ''}`);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : '测试失败');
        } finally {
            setSwitching(null);
        }
    }

    const rows = config.providers.flatMap(provider => provider.models.map(model => ({ provider, model })));
    if (rows.length === 0) {
        return <p className="text-sm leading-6 text-muted-foreground">还没有模型。先在下方添加一个渠道。</p>;
    }
    return (
        <div className="space-y-1">
            {rows.map(({ provider, model }) => {
                const key = `${provider.id}/${model.id}`;
                const active = config.defaultModel?.providerId === provider.id && config.defaultModel.modelId === model.id;
                return (
                    <div className="model-row" key={key}>
                        <div className="min-w-0">
                            <div className="flex items-center gap-2">
                                <p className="truncate font-medium text-foreground">{key}</p>
                                {active && <span className="active-model"><Check aria-hidden="true" className="size-3" />使用中</span>}
                            </div>
                            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                <span>{provider.type}</span>
                                <span>{model.contextWindow.toLocaleString()} context</span>
                                <span className="inline-flex items-center gap-1"><KeyRound aria-hidden="true" className="size-3" />{provider.credentialConfigured ? '凭证已保存' : provider.auth === 'none' ? '无 Key 连接' : '缺少凭证'}</span>
                            </p>
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-2">
                            <Button disabled={switching !== null} onClick={() => void handleTest(provider.id, model.id)} size="sm" type="button" variant="ghost">测试连接</Button>
                        {!active && (
                            <Button
                                disabled={switching !== null || (!provider.credentialConfigured && provider.auth !== 'none')}
                                onClick={() => void handleUseModel(provider.id, model.id)}
                                size="sm"
                                type="button"
                                variant="outline"
                            >
                                {switching === key ? '切换中' : '设为默认'}
                            </Button>
                        )}
                        </div>
                    </div>
                );
            })}
            <details className="provider-advanced">
                <summary>用途与推理设置</summary>
                <p className="my-3 text-sm text-muted-foreground">不需要配置多套模型。只有确有需要时，才为独处反思或上下文整理另选模型。</p>
                <div className="settings-grid">
                    {(['reflection', 'compression'] as const).map(purpose => {
                        const selection = config.modelOverrides[purpose];
                        return (
                            <label className="field-label" key={purpose}>
                                <span>{purpose === 'reflection' ? '独处反思' : '上下文整理'}</span>
                                <Combobox
                                    ariaLabel={purpose === 'reflection' ? '反思模型' : '上下文整理模型'}
                                    disabled={switching !== null}
                                    onValueChange={value => {
                                        const row = rows.find(item => `${item.provider.id}/${item.model.id}` === value);
                                        void handleUseModel(row?.provider.id || '', row?.model.id || '', purpose);
                                    }}
                                    options={[
                                        { value: 'inherit', label: '跟随默认模型' },
                                        ...rows.map(({ provider, model }) => ({ value: `${provider.id}/${model.id}`, label: `${provider.id}/${model.id}` })),
                                    ]}
                                    value={selection ? `${selection.providerId}/${selection.modelId}` : 'inherit'}
                                />
                            </label>
                        );
                    })}
                </div>
                <p className="my-3 text-sm text-muted-foreground">推理强度默认交给提供方。会推理不等于支持调节强度，请按模型文档设置，不支持的参数可能被忽略。</p>
                <div className="settings-grid">
                    {(['agent', 'reflection', 'compression'] as const).map(purpose => {
                        const selection = purpose === 'agent' ? config.defaultModel : config.modelOverrides[purpose];
                        if (!selection) return null;
                        return (
                            <label className="field-label" key={purpose}>
                                <span>{{ agent: '默认模型', reflection: '反思', compression: '上下文整理' }[purpose]}推理强度</span>
                                <Combobox
                                    ariaLabel={`${purpose} 推理强度`}
                                    disabled={switching !== null}
                                    onValueChange={value => void handleUseModel(selection.providerId, selection.modelId, purpose, value === 'default' ? undefined : value as 'low' | 'medium' | 'high')}
                                    options={[{ value: 'default', label: '提供方默认' }, { value: 'low', label: '低' }, { value: 'medium', label: '中' }, { value: 'high', label: '高' }]}
                                    value={selection.reasoningEffort || 'default'}
                                />
                            </label>
                        );
                    })}
                </div>
            </details>
            {testResult && <p aria-live="polite" className="pt-2 text-sm text-muted-foreground">{testResult}</p>}
            {error && <p className="pt-2 text-sm text-destructive">{error}</p>}
        </div>
    );
}
