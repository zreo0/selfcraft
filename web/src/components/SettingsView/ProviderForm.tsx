import { useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import { Button } from '@/components/motion/button';
import { Combobox } from '@/components/motion/combobox';
import { Input } from '@/components/motion/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/motion/select';
import { Switch } from '@/components/motion/switch';
import { saveProvider } from '@/services/runtime';
import type { ConfigView, ProviderInput } from '@/types/api.types';

const INITIAL_PROVIDER: ProviderInput = {
    providerId: 'default',
    type: 'openai-compatible',
    baseURL: '',
    apiKey: '',
    modelId: '',
    vision: false,
    contextWindow: 128000,
    maxOutputTokens: 8192,
};

/** 配置一个模型渠道及其首个模型 */
export function ProviderForm ({
    compact = false,
    onSaved,
    submitLabel = '保存渠道',
    config,
}: {
    compact?: boolean;
    onSaved: (config: ConfigView) => void;
    submitLabel?: string;
    config?: ConfigView | null;
}) {
    const [input, setInput] = useState<ProviderInput>(INITIAL_PROVIDER);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<string | null>(null);

    /** 提交渠道配置且不在页面保留凭证 */
    async function handleSubmit (event: FormEvent<HTMLFormElement>): Promise<void> {
        event.preventDefault();
        setSaving(true);
        setMessage(null);
        try {
            const config = await saveProvider(input);
            onSaved(config);
            setInput(current => ({ ...current, apiKey: '' }));
            setMessage('渠道已保存，可以开始对话');
        } catch (error) {
            setMessage(error instanceof Error ? error.message : '保存失败');
        } finally {
            setSaving(false);
        }
    }

    return (
        <form className="settings-form" onSubmit={handleSubmit}>
            {Boolean(config?.providers.length) && (
                <label className="field-label">
                    <span>编辑已有模型，或直接填写下方内容添加</span>
                    <Combobox
                        ariaLabel="载入模型配置"
                        onValueChange={value => {
                            const provider = config?.providers.find(item => value.startsWith(`${item.id}/`));
                            const model = provider?.models.find(item => value === `${provider.id}/${item.id}`);
                            if (provider && model) {
                                setInput({ providerId: provider.id, type: provider.type, baseURL: provider.baseURL || '', apiKey: '', modelId: model.id, vision: model.vision, contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens });
                            }
                        }}
                        options={config?.providers.flatMap(provider => provider.models.map(model => ({ value: `${provider.id}/${model.id}`, label: `${provider.id}/${model.id}` }))) || []}
                        placeholder="搜索已保存的模型"
                    />
                </label>
            )}
            <div className="settings-grid">
                <label className="field-label">
                    <span>渠道标识</span>
                    <Input
                        autoComplete="off"
                        onChange={value => setInput(current => ({ ...current, providerId: value }))}
                        placeholder="例如 default"
                        required
                        value={input.providerId}
                    />
                </label>
                <label className="field-label">
                    <span>协议</span>
                    <Select
                        onValueChange={value => setInput(current => ({ ...current, type: value as ProviderInput['type'] }))}
                        value={input.type}
                    >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="openai-compatible">OpenAI Compatible</SelectItem>
                            <SelectItem value="openai">OpenAI</SelectItem>
                            <SelectItem value="anthropic">Anthropic</SelectItem>
                        </SelectContent>
                    </Select>
                </label>
            </div>
            {(
                <label className="field-label">
                    <span>API 根地址{input.type !== 'openai-compatible' && '（可选）'}</span>
                    <Input
                        inputMode="url"
                        onChange={value => setInput(current => ({ ...current, baseURL: value }))}
                        placeholder="http://127.0.0.1:3000/v1"
                        required={input.type === 'openai-compatible'}
                        value={input.baseURL}
                    />
                </label>
            )}
            <div className="settings-grid">
                <label className="field-label">
                    <span>模型标识</span>
                    <Input
                        autoComplete="off"
                        onChange={value => setInput(current => ({ ...current, modelId: value }))}
                        placeholder="模型提供方给出的 ID"
                        required
                        value={input.modelId}
                    />
                </label>
                <label className="field-label">
                    <span>API Key</span>
                    <Input
                        autoComplete="new-password"
                        onChange={value => setInput(current => ({ ...current, apiKey: value }))}
                        placeholder="留空保留已有凭证；本地接口可不填"
                        type="password"
                        value={input.apiKey}
                    />
                </label>
            </div>
            {compact ? (
                <details className="provider-advanced">
                    <summary>模型能力与上下文</summary>
                    <ProviderCapabilities input={input} onChange={setInput} />
                </details>
            ) : (
                <ProviderCapabilities input={input} onChange={setInput} />
            )}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <p aria-live="polite" className="min-h-5 text-sm text-muted-foreground">{message}</p>
                <Button disabled={saving} type="submit">{saving ? '正在保存' : submitLabel}</Button>
            </div>
        </form>
    );
}

/** 渲染模型能力设置，并保持首次流程与完整设置使用同一组字段 */
function ProviderCapabilities ({
    input,
    onChange,
}: {
    input: ProviderInput;
    onChange: Dispatch<SetStateAction<ProviderInput>>;
}) {
    return (
        <div className="provider-capabilities">
            <div className="settings-grid">
                <label className="field-label">
                    <span>上下文窗口</span>
                    <Input
                        min={1}
                        onChange={value => onChange(current => ({ ...current, contextWindow: Number(value) }))}
                        required
                        type="number"
                        value={input.contextWindow}
                    />
                </label>
                <label className="field-label">
                    <span>最大输出 Token</span>
                    <Input
                        min={1}
                        onChange={value => onChange(current => ({ ...current, maxOutputTokens: Number(value) }))}
                        required
                        type="number"
                        value={input.maxOutputTokens}
                    />
                </label>
            </div>
            <label className="flex items-center justify-between gap-4 rounded-xl border border-border/75 px-3.5 py-3 text-sm">
                <span>
                    <strong className="font-medium text-foreground">支持图片输入</strong>
                    <small className="mt-0.5 block text-xs text-muted-foreground">仅在模型支持视觉时开启；也会供当前模型按需分析图片</small>
                </span>
                <Switch ariaLabel="支持图片输入" checked={input.vision} onCheckedChange={vision => onChange(current => ({ ...current, vision }))} />
            </label>
        </div>
    );
}
