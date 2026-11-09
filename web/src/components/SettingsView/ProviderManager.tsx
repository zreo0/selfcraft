import { KeyRound, Plus, RefreshCw } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/motion/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { deleteModel, getBootstrap, testModel } from '@/services/runtime';
import type { ConfigView, ModelView, ProviderView } from '@/types/api.types';
import { ModelForm } from './ModelForm';
import { ModelList, modelReferences } from './ModelList';
import { ProviderForm } from './ProviderForm';

/** 当前操作的固定目标；不从草稿标识推断编辑意图 */
type Editor = { kind: 'provider'; providerId?: string } | { kind: 'model' | 'delete'; providerId: string; modelId?: string };

/**
 * 在渠道列表中编排连接、模型及删除操作
 * @param props Runtime 配置、忙碌状态和更新回调
 * @returns 渠道管理区域
 */
export function ProviderManager ({ config, busy, onBusy, onChanged }: {
    config: ConfigView;
    busy: boolean;
    onBusy: (busy: boolean) => void;
    onChanged: (config: ConfigView) => void;
}) {
    const [editor, setEditor] = useState<Editor | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const pending = useRef(false);
    const opener = useRef<HTMLElement | null>(null);
    const addButton = useRef<HTMLButtonElement>(null);
    const provider = editor?.providerId ? config.providers.find(item => item.id === editor.providerId) : undefined;
    const model = editor && editor.kind !== 'provider' ? provider?.models.find(item => item.id === editor.modelId) : undefined;
    const references = provider && model ? modelReferences(config, provider.id, model.id) : [];
    const onlyModel = config.providers.reduce((count, item) => count + item.models.length, 0) === 1;

    /**
     * 打开指定操作并记住键盘返回位置
     * @param next 操作目标
     */
    function openEditor (next: Editor): void {
        opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setError(null);
        setMessage(null);
        setEditor(next);
    }

    /**
     * 接收成功保存的配置并关闭表单
     * @param next 服务端配置
     */
    function saved (next: ConfigView): void {
        onChanged(next);
        setEditor(null);
        setMessage('已保存');
    }

    /**
     * 执行测试、删除或刷新，防止重复请求
     * @param action 当前操作
     * @param targetProvider 测试或删除的渠道
     * @param targetModel 测试或删除的模型
     * @returns 操作完成后释放忙碌状态
     */
    async function runAction (action: 'test' | 'delete' | 'refresh', targetProvider?: ProviderView, targetModel?: ModelView): Promise<void> {
        if (pending.current || busy) return;
        pending.current = true;
        onBusy(true);
        setError(null);
        setMessage(null);
        try {
            if (action === 'refresh') {
                const next = await getBootstrap();
                if (!next.config) throw new Error(next.configurationError || '配置暂不可用');
                onChanged(next.config);
                setEditor(null);
                setMessage('已读取最新配置');
            } else if (targetProvider && targetModel) {
                if (action === 'delete') {
                    onChanged(await deleteModel(targetProvider.id, targetModel.id));
                    setEditor(null);
                    setMessage(`已删除 ${targetProvider.id} / ${targetModel.id}`);
                } else {
                    const result = await testModel(targetProvider.id, targetModel.id);
                    setMessage(`${targetProvider.id} / ${targetModel.id} 连接成功 · ${(result.durationMs / 1000).toFixed(1)} 秒${result.warnings.length ? ' · 提供方返回参数支持警告' : ''}${result.finishReason === 'length' ? ' · 达到测试输出上限' : ''}`);
                }
            }
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : '操作失败，请刷新配置核对后重试');
        } finally {
            pending.current = false;
            onBusy(false);
        }
    }

    return (
        <div className="settings-form">
            <div className="flex flex-wrap gap-2">
                <Button disabled={busy} onClick={() => openEditor({ kind: 'provider' })} ref={addButton}><Plus aria-hidden="true" className="size-4" />新增渠道</Button>
                <Button disabled={busy} onClick={() => void runAction('refresh')} variant="ghost"><RefreshCw aria-hidden="true" className="size-4" />刷新配置</Button>
            </div>
            {!config.providers.length && <p className="py-4 text-sm text-muted-foreground">先创建一个渠道，保存地址与 Key，再添加该渠道提供的模型。</p>}
            {config.providers.map(item => (
                <section aria-label={`渠道 ${item.id}`} className="provider-section" key={item.id}>
                    <div className="provider-heading">
                        <div className="min-w-0">
                            <h3 className="break-all font-semibold">{item.id}</h3>
                            <p className="mt-1 break-all text-xs leading-6 text-muted-foreground">{item.type} · {item.baseURL || '官方默认地址'}</p>
                            <p className="flex items-center gap-1 text-xs text-muted-foreground"><KeyRound aria-hidden="true" className="size-3" />{item.credentialConfigured ? '凭证已保存' : item.auth === 'none' ? '无 Key 连接' : '缺少凭证'}</p>
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-2">
                            <Button aria-label={`编辑渠道 ${item.id}`} disabled={busy} onClick={() => openEditor({ kind: 'provider', providerId: item.id })} variant="ghost">编辑渠道</Button>
                            <Button aria-label={`为 ${item.id} 添加模型`} disabled={busy} onClick={() => openEditor({ kind: 'model', providerId: item.id })} variant="outline">添加模型</Button>
                        </div>
                    </div>
                    <ModelList provider={item} config={config} busy={busy} onEdit={target => openEditor({ kind: 'model', providerId: item.id, modelId: target.id })} onDelete={target => openEditor({ kind: 'delete', providerId: item.id, modelId: target.id })} onTest={target => void runAction('test', item, target)} />
                </section>
            ))}
            {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
            {error && !editor && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Dialog open={Boolean(editor)} onOpenChange={open => { if (!open && !busy) setEditor(null); }}>
                <DialogContent className="max-h-[85dvh] overflow-y-auto" onCloseAutoFocus={event => {
                    event.preventDefault();
                    const target = opener.current?.isConnected ? opener.current : addButton.current;
                    target?.focus();
                }}>
                    <DialogHeader>
                        <DialogTitle>{editor?.kind === 'provider' ? provider ? `编辑渠道 ${provider.id}` : '新增渠道' : editor?.kind === 'delete' ? '删除模型' : model ? '编辑模型' : '添加模型'}</DialogTitle>
                        <DialogDescription>{editor?.kind === 'provider' ? '渠道保存连接信息，同一渠道下的模型共用地址与 Key。' : '模型属于一个固定渠道，模型操作不会修改渠道连接。'}</DialogDescription>
                    </DialogHeader>
                    {editor?.kind === 'provider' && <ProviderForm key={provider?.id || 'new'} provider={provider} onBusy={onBusy} onSaved={(next, providerId) => {
                        if (provider) saved(next);
                        else {
                            onChanged(next);
                            setEditor({ kind: 'model', providerId });
                        }
                    }} />}
                    {editor?.kind === 'model' && provider && <ModelForm key={`${provider.id}/${model?.id || ''}`} provider={provider} model={model} onBusy={onBusy} onSaved={saved} onEdit={target => setEditor({ kind: 'model', providerId: provider.id, modelId: target.id })} />}
                    {editor?.kind === 'delete' && provider && model && (
                        <>
                            <p className="break-all font-medium">{provider.id} / {model.id}</p>
                            {references.length ? <div className="space-y-2 text-sm"><p>此模型仍用于：{references.join('、')}。</p><p className="text-muted-foreground">{onlyModel ? '请先添加替代模型并切换默认模型，再删除。' : '请先切换这些用途，或让反思、整理恢复跟随默认模型，再删除。'}</p></div> : <p className="text-sm text-muted-foreground">只移除此模型配置。渠道、凭证、历史会话和记忆都会保留。</p>}
                            {model.vision && <p className="text-sm text-muted-foreground">此模型也可能用于图片分析，删除后将尝试使用其他可用的视觉模型。</p>}
                            <DialogFooter>
                                <Button disabled={busy} variant="ghost" onClick={() => setEditor(null)}>取消</Button>
                                {references.length ? <Button onClick={() => {
                                    opener.current = document.querySelector<HTMLInputElement>('input[aria-label="默认模型"]');
                                    setEditor(null);
                                }}>前往模型用途</Button> : <Button disabled={busy} variant="destructive" onClick={() => void runAction('delete', provider, model)}>{busy ? '正在删除' : '确认删除模型'}</Button>}
                            </DialogFooter>
                        </>
                    )}
                    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                    <Button disabled={busy} variant="ghost" onClick={() => void runAction('refresh')}>重新读取配置并关闭</Button>
                </DialogContent>
            </Dialog>
        </div>
    );
}
