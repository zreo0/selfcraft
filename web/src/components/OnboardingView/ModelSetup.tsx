import { useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/motion/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/motion/select';
import { INITIAL_PROVIDER, ProviderFields } from '@/components/SettingsView/ProviderFields';
import { INITIAL_MODEL, ModelFields } from '@/components/SettingsView/ModelFields';
import { createProvider, getBootstrap, saveModel } from '@/services/runtime';
import type { ConfigView } from '@/types/api.types';

/**
 * 首次配置新渠道和首个模型，或继续已有空渠道
 * @param props 当前配置、完成回调与完整设置入口
 * @returns 首次配置表单
 */
export function ModelSetup ({ config, onSaved, onOpenSettings }: {
    config: ConfigView;
    onSaved: (config: ConfigView) => void;
    onOpenSettings: () => void;
}) {
    const [selected, setSelected] = useState(config.providers[0]?.id || '__new__');
    const [connection, setConnection] = useState(INITIAL_PROVIDER);
    const [model, setModel] = useState(INITIAL_MODEL);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const pending = useRef(false);
    const provider = config.providers.find(item => item.id === selected);
    const duplicate = provider?.models.some(item => item.id === model.modelId);

    /**
     * 一次保存新渠道及模型，已有渠道只提交模型信息
     * @param event 提交事件
     * @returns 服务端确认后继续首次流程
     */
    async function submit (event: FormEvent<HTMLFormElement>): Promise<void> {
        event.preventDefault();
        if (pending.current || duplicate) return;
        pending.current = true;
        setBusy(true);
        setError(null);
        try {
            if (selected !== '__new__' && !provider) throw new Error('渠道不存在，请重新读取配置');
            const next = provider ? await saveModel({ providerId: provider.id, ...model }) : await createProvider(connection, model);
            setConnection(current => ({ ...current, apiKey: '' }));
            onSaved(next);
            if (!next.configured) setError('模型已保存，请在完整设置中选择默认模型或补全渠道凭证');
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : '保存失败');
        } finally {
            pending.current = false;
            setBusy(false);
        }
    }

    /**
     * 回执丢失时重新读取配置，不重复提交创建请求
     * @returns 最新状态交给首次流程判断
     */
    async function reload (): Promise<void> {
        if (pending.current) return;
        pending.current = true;
        setBusy(true);
        try {
            const next = await getBootstrap();
            if (!next.config) throw new Error(next.configurationError || '配置暂不可用');
            setConnection(current => ({ ...current, apiKey: '' }));
            onSaved(next.config);
            setError(next.config.configured ? null : '已读取最新配置，可继续添加模型或打开完整设置');
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : '读取失败');
        } finally {
            pending.current = false;
            setBusy(false);
        }
    }

    return (
        <form className="settings-form" onSubmit={submit}>
            <fieldset className="settings-form min-w-0" disabled={busy}>
                {config.providers.length > 0 && <div className="field-label">
                    <span id="setup-channel-label">模型所属渠道</span>
                    <Select value={selected} onValueChange={value => { setSelected(value); setConnection(INITIAL_PROVIDER); setModel(INITIAL_MODEL); setError(null); }}>
                        <SelectTrigger aria-labelledby="setup-channel-label"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            {config.providers.map(item => <SelectItem key={item.id} value={item.id}>使用已有渠道 {item.id}</SelectItem>)}
                            <SelectItem value="__new__">新增渠道</SelectItem>
                        </SelectContent>
                    </Select>
                </div>}
                {provider ? <p className="break-all text-sm text-muted-foreground">{provider.type} · {provider.baseURL || '官方默认地址'}<br />沿用此渠道的地址与凭证。</p> : <div className="settings-form"><h3 className="font-medium">渠道连接</h3><ProviderFields input={connection} onChange={setConnection} /></div>}
                <div className="settings-form border-t border-border pt-4"><h3 className="font-medium">{provider ? '添加模型' : '首个模型'}</h3><ModelFields input={model} onChange={setModel} /></div>
            </fieldset>
            {(duplicate || provider?.models.length) ? <div className="text-sm text-muted-foreground"><p>{duplicate ? '此渠道已有同名模型，请在完整设置中选择或编辑。' : '已有模型可直接在完整设置中设为默认。'}</p><Button disabled={busy} variant="ghost" onClick={onOpenSettings}>打开完整设置</Button></div> : null}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button disabled={busy || Boolean(duplicate)} type="submit">{busy ? '正在保存' : '保存模型并继续'}</Button>
            {error && <Button disabled={busy} variant="ghost" onClick={() => void reload()}>重新读取配置</Button>}
        </form>
    );
}
