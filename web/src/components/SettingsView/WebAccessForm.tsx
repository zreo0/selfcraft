import { useState, type FormEvent } from 'react';
import { Button } from '@/components/motion/button';
import { Input } from '@/components/motion/input';
import { disableWebAccess, saveWebAccess } from '@/services/runtime';
import type { ConfigView } from '@/types/api.types';

/** 配置 Tavily 搜索与网页读取能力 */
export function WebAccessForm ({
    config,
    onChanged,
}: {
    config: ConfigView;
    onChanged: (config: ConfigView) => void;
}) {
    const [apiKey, setApiKey] = useState('');
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const configured = config.webAccess?.configured === true;

    /** 保存新凭证且不在页面保留明文 */
    async function handleSubmit (event: FormEvent<HTMLFormElement>): Promise<void> {
        event.preventDefault();
        setSaving(true);
        setMessage(null);
        try {
            onChanged(await saveWebAccess(apiKey));
            setApiKey('');
            setMessage('网络搜索已经可用，下次对话立即生效');
        } catch (error) {
            setMessage(error instanceof Error ? error.message : '保存失败');
        } finally {
            setSaving(false);
        }
    }

    /** 关闭网络访问并删除本地凭证 */
    async function handleDisable (): Promise<void> {
        setSaving(true);
        setMessage(null);
        try {
            onChanged(await disableWebAccess());
            setApiKey('');
            setMessage('网络搜索已关闭，凭证已删除');
        } catch (error) {
            setMessage(error instanceof Error ? error.message : '关闭失败');
        } finally {
            setSaving(false);
        }
    }

    return (
        <form className="settings-form" onSubmit={handleSubmit}>
            <div className="settings-grid">
                <label className="field-label">
                    <span>搜索服务</span>
                    <Input disabled value="Tavily" />
                </label>
                <label className="field-label">
                    <span>API Key</span>
                    <Input
                        autoComplete="new-password"
                        onChange={setApiKey}
                        placeholder={configured ? '输入新 Key 可更新现有凭证' : '只写入本地 secrets.json'}
                        required
                        type="password"
                        value={apiKey}
                    />
                </label>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <p aria-live="polite" className="min-h-5 text-sm text-muted-foreground">
                    {message || (configured ? '已启用 · 搜索结果不会自动写入长期记忆' : '未启用 · 不影响本地工作区能力')}
                </p>
                <div className="flex items-center gap-2">
                    {configured && (
                        <Button disabled={saving} onClick={() => void handleDisable()} type="button" variant="outline">
                            关闭
                        </Button>
                    )}
                    <Button disabled={saving || !apiKey.trim()} type="submit">
                        {saving ? '正在保存' : configured ? '更新凭证' : '启用网络搜索'}
                    </Button>
                </div>
            </div>
        </form>
    );
}
