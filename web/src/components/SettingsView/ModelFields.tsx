import { Input } from '@/components/motion/input';
import { Switch } from '@/components/motion/switch';
import type { ModelInput } from '@/types/api.types';

/** 模型能力默认值，沿用现有配置表单 */
export const INITIAL_MODEL: Omit<ModelInput, 'providerId'> = { modelId: '', vision: false, contextWindow: 128000, maxOutputTokens: 8192 };

/**
 * 展示模型标识和能力，不包含渠道连接字段
 * @param props 当前模型、编辑状态及变化回调
 * @returns 模型字段
 */
export function ModelFields ({ input, editing = false, onChange }: {
    input: Omit<ModelInput, 'providerId'>;
    editing?: boolean;
    onChange: (input: Omit<ModelInput, 'providerId'>) => void;
}) {
    return (
        <div className="settings-form">
            <Input label="模型 ID" autoComplete="off" required readOnly={editing} maxLength={128} placeholder="模型提供方给出的 ID" value={input.modelId} onChange={modelId => onChange({ ...input, modelId })} />
            <div className="settings-grid">
                <Input label="上下文窗口" min={1} max={10000000} step={1} required type="number" value={input.contextWindow || ''} onChange={value => onChange({ ...input, contextWindow: Number(value) })} />
                <Input label="最大输出 Token" min={1} max={1000000} step={1} required type="number" value={input.maxOutputTokens || ''} onChange={value => onChange({ ...input, maxOutputTokens: Number(value) })} />
            </div>
            <div className="flex items-center justify-between gap-4 rounded-xl border border-border px-3.5 py-3 text-sm">
                <div><p className="font-medium">支持图片输入</p><p className="mt-1 text-xs text-muted-foreground">仅在模型支持视觉时开启，也会用于按需图片分析</p></div>
                <Switch ariaLabel="支持图片输入" checked={input.vision} onCheckedChange={vision => onChange({ ...input, vision })} />
            </div>
        </div>
    );
}
