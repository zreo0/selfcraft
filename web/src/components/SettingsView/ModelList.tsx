import { Check, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/motion/button';
import { useModel } from '@/services/runtime';
import type { ConfigView } from '@/types/api.types';

/** 展示全部模型并允许切换唯一活动模型 */
export function ModelList ({ config, onChanged }: { config: ConfigView; onChanged: (config: ConfigView) => void }) {
    const [switching, setSwitching] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    /** 切换后续对话使用的模型 */
    async function handleUseModel (providerId: string, modelId: string): Promise<void> {
        const key = `${providerId}/${modelId}`;
        setSwitching(key);
        setError(null);
        try {
            onChanged(await useModel(providerId, modelId));
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : '切换失败');
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
                const active = config.activeModel?.providerId === provider.id && config.activeModel.modelId === model.id;
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
                                <span className="inline-flex items-center gap-1"><KeyRound aria-hidden="true" className="size-3" />{provider.credentialConfigured ? '凭证已保存' : '缺少凭证'}</span>
                            </p>
                        </div>
                        {!active && (
                            <Button
                                disabled={switching !== null || !provider.credentialConfigured}
                                onClick={() => void handleUseModel(provider.id, model.id)}
                                size="sm"
                                type="button"
                                variant="outline"
                            >
                                {switching === key ? '切换中' : '设为活动模型'}
                            </Button>
                        )}
                    </div>
                );
            })}
            {error && <p className="pt-2 text-sm text-destructive">{error}</p>}
        </div>
    );
}
