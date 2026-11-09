import { Button } from '@/components/motion/button';
import type { ConfigView, ModelView, ProviderView } from '@/types/api.types';

/**
 * 返回模型的用途标签，包含跟随默认的后台用途
 * @param config 当前配置
 * @param providerId 所属渠道
 * @param modelId 目标模型
 * @returns 可读用途列表
 */
export function modelReferences (config: ConfigView, providerId: string, modelId: string): string[] {
    return (['agent', 'reflection', 'compression'] as const).flatMap(purpose => {
        const selection = purpose === 'agent' ? config.defaultModel : config.modelOverrides[purpose] ?? config.defaultModel;
        if (selection?.providerId !== providerId || selection.modelId !== modelId) return [];
        const label = { agent: '默认模型', reflection: '独处反思', compression: '上下文整理' }[purpose];
        return [label + (purpose !== 'agent' && !config.modelOverrides[purpose] ? '（跟随默认）' : '')];
    });
}

/**
 * 展示一个渠道下的模型及各自操作
 * @param props 渠道、配置、忙碌状态和操作回调
 * @returns 模型列表或空状态
 */
export function ModelList ({ provider, config, busy, onEdit, onDelete, onTest }: {
    provider: ProviderView;
    config: ConfigView;
    busy: boolean;
    onEdit: (model: ModelView) => void;
    onDelete: (model: ModelView) => void;
    onTest: (model: ModelView) => void;
}) {
    if (!provider.models.length) return <p className="py-5 text-sm text-muted-foreground">暂无模型。点击此渠道的“添加模型”继续配置。</p>;
    return (
        <div className="provider-models">
            {provider.models.map(model => (
                <div className="model-row" key={model.id}>
                    <div className="min-w-0">
                        <p className="break-all font-medium">{model.id}</p>
                        <p className="mt-1 text-xs text-muted-foreground">上下文 {model.contextWindow.toLocaleString()} · 最大输出 {model.maxOutputTokens.toLocaleString()}{model.vision ? ' · 支持图片' : ''}</p>
                        <div className="mt-2 flex flex-wrap gap-1.5">{modelReferences(config, provider.id, model.id).map(label => <span className="active-model" key={label}>{label}</span>)}</div>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-1">
                        <Button aria-label={`测试 ${provider.id}/${model.id}`} disabled={busy} onClick={() => onTest(model)} size="sm" variant="ghost">测试连接</Button>
                        <Button aria-label={`编辑 ${provider.id}/${model.id}`} disabled={busy} onClick={() => onEdit(model)} size="sm" variant="ghost">编辑</Button>
                        <Button aria-label={`删除 ${provider.id}/${model.id}`} disabled={busy} onClick={() => onDelete(model)} size="sm" variant="ghost">删除</Button>
                    </div>
                </div>
            ))}
        </div>
    );
}
