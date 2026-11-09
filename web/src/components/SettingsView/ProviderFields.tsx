import { Input } from '@/components/motion/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/motion/select';
import type { ProviderInput } from '@/types/api.types';

/** 新渠道不预填标识，避免误将新增视为更新 */
export const INITIAL_PROVIDER: ProviderInput = { providerId: '', type: 'openai-compatible', baseURL: '', apiKey: '' };

/**
 * 展示渠道连接字段，编辑时固定渠道标识
 * @param props 当前连接、编辑状态与字段变化回调
 * @returns 渠道字段
 */
export function ProviderFields ({ input, editing = false, onChange }: {
    input: ProviderInput;
    editing?: boolean;
    onChange: (input: ProviderInput) => void;
}) {
    return (
        <div className="settings-form">
            <div className="settings-grid">
                <Input label="渠道标识" autoComplete="off" required readOnly={editing} maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,63}" placeholder="例如 dev" value={input.providerId} onChange={providerId => onChange({ ...input, providerId })} />
                <div className="field-label">
                    <span id="provider-protocol-label">协议</span>
                    <Select value={input.type} onValueChange={type => onChange({ ...input, type: type as ProviderInput['type'] })}>
                        <SelectTrigger aria-labelledby="provider-protocol-label"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="openai-compatible">OpenAI Compatible</SelectItem>
                            <SelectItem value="openai">OpenAI</SelectItem>
                            <SelectItem value="anthropic">Anthropic</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
            </div>
            <Input label={`API 根地址${input.type !== 'openai-compatible' ? '（可选）' : ''}`} inputMode="url" required={input.type === 'openai-compatible'} placeholder={input.type === 'openai-compatible' ? 'https://api.example.com/v1' : '留空使用官方默认地址'} value={input.baseURL || ''} onChange={baseURL => onChange({ ...input, baseURL })} />
            <Input label={editing ? '新 API Key（留空保留）' : 'API Key'} autoComplete="new-password" type="password" placeholder={editing ? '不显示已保存的 Key' : '本地兼容接口可不填'} value={input.apiKey} onChange={apiKey => onChange({ ...input, apiKey })} />
        </div>
    );
}
