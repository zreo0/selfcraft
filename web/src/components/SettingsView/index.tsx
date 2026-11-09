import { RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PageTitle } from '@/components/PageTitle';
import { Button } from '@/components/motion/button';
import { TimeZonePicker } from '@/components/TimeZonePicker';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog';
import { resetConfig, saveTimezone } from '@/services/runtime';
import type { ConfigView } from '@/types/api.types';
import { ModelUsage } from './ModelUsage';
import { ProviderManager } from './ProviderManager';
import { WebAccessForm } from './WebAccessForm';

/** Selfcraft 的模型、时区与本地配置页面 */
export function SettingsView ({
    active,
    config,
    configurationError,
    onChanged,
}: {
    active: boolean;
    config: ConfigView | null;
    configurationError: string | null;
    onChanged: (config: ConfigView) => void;
}) {
    const [modelBusy, setModelBusy] = useState(false);
    const [timezone, setTimezone] = useState(config?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    const [timezoneState, setTimezoneState] = useState<string | null>(null);
    const [resetting, setResetting] = useState(false);
    const [resetOpen, setResetOpen] = useState(false);
    const [resetMessage, setResetMessage] = useState<string | null>(null);

    useEffect(() => {
        if (config?.timezone) {
            setTimezone(config.timezone);
        }
    }, [config?.timezone]);

    /** 保存时区并更新父级配置 */
    async function handleTimezoneSave (): Promise<void> {
        setTimezoneState('正在保存');
        try {
            onChanged(await saveTimezone(timezone));
            setTimezoneState('已保存');
        } catch (error) {
            setTimezoneState(error instanceof Error ? error.message : '保存失败');
        }
    }

    /** 备份旧配置并恢复到未配置状态 */
    async function handleReset (): Promise<void> {
        setResetting(true);
        try {
            const result = await resetConfig();
            onChanged(result.config);
            setResetMessage(result.backupDirectory
                ? `旧配置已备份到 ${result.backupDirectory}`
                : '配置已重置');
            setResetOpen(false);
        } catch (error) {
            setResetMessage(error instanceof Error ? error.message : '重置失败');
        } finally {
            setResetting(false);
        }
    }

    return (
        <section className="settings-view">
            <div className="settings-layout">
                <header className="settings-header">
                    <div>
                        <PageTitle active={active} variant="assemble">设置</PageTitle>
                        <nav aria-label="设置分区" className="settings-index">
                            <a href="#settings-model">模型用途</a>
                            <a href="#settings-provider">渠道与模型</a>
                            <a href="#settings-web">网络搜索</a>
                            <a href="#settings-timezone">本地时间</a>
                            <a href="#settings-reset">重新初始化</a>
                        </nav>
                    </div>
                </header>

                <div className="settings-content">
                    {configurationError && (
                        <div className="configuration-error" role="alert">
                            <strong>现有配置无法读取</strong>
                            <p>{configurationError}</p>
                            <p>可以在页面底部备份旧配置后重新开始。</p>
                        </div>
                    )}

                    <div className="settings-section" id="settings-model">
                        <div className="settings-section-title">
                            <h2>模型用途</h2>
                            <p>对话与后台任务共用默认模型。新运行使用保存后的选择。</p>
                        </div>
                        {config ? <ModelUsage config={config} onChanged={onChanged} busy={modelBusy} onBusy={setModelBusy} /> : <p className="text-sm text-muted-foreground">配置暂不可用</p>}
                    </div>

                    <div className="settings-section" id="settings-provider">
                        <div className="settings-section-title">
                            <h2>渠道与模型</h2>
                            <p>渠道保存地址与 Key，模型保存能力与上下文参数。添加模型不会改变渠道连接。</p>
                        </div>
                        {config ? <ProviderManager config={config} onChanged={onChanged} busy={modelBusy} onBusy={setModelBusy} /> : <p className="text-sm text-muted-foreground">配置暂不可用</p>}
                    </div>

                    <div className="settings-section" id="settings-web">
                        <div className="settings-section-title">
                            <h2>网络搜索</h2>
                            <p>用于查找近期与外部信息，并按需读取原始网页。首版使用 Tavily，底层实现可以替换。</p>
                        </div>
                        {config ? <WebAccessForm config={config} onChanged={onChanged} /> : <p className="text-sm text-muted-foreground">配置暂不可用</p>}
                    </div>

                    <div className="settings-section" id="settings-timezone">
                        <div className="settings-section-title">
                            <h2>你的本地时间</h2>
                            <p>用于理解“明天”“上周”和提醒的准确日期。</p>
                        </div>
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                            <label className="field-label flex-1">
                                <span>IANA 时区</span>
                                <TimeZonePicker onChange={setTimezone} value={timezone} />
                            </label>
                            <Button onClick={() => void handleTimezoneSave()} type="button" variant="outline">保存时区</Button>
                        </div>
                        <p aria-live="polite" className="mt-2 min-h-5 text-sm text-muted-foreground">{timezoneState}</p>
                    </div>

                    <div className="settings-section settings-section--danger" id="settings-reset">
                        <div className="settings-section-title">
                            <h2>重新初始化配置</h2>
                            <p>只重置模型、网络搜索与时区设置。身份、记忆、会话、技能、任务和工作区不会被删除。</p>
                        </div>
                        <Dialog onOpenChange={setResetOpen} open={resetOpen}>
                            <DialogTrigger asChild>
                                <Button disabled={modelBusy} type="button" variant="outline"><RotateCcw aria-hidden="true" className="size-4" />备份并重置</Button>
                            </DialogTrigger>
                            <DialogContent>
                                <DialogHeader>
                                    <DialogTitle>重新初始化配置？</DialogTitle>
                                    <DialogDescription>非敏感配置会按时间备份，现有凭证将被清空。长期数据不会受到影响。</DialogDescription>
                                </DialogHeader>
                                <DialogFooter>
                                    <DialogClose asChild><Button type="button" variant="ghost">暂不重置</Button></DialogClose>
                                    <Button disabled={resetting} onClick={() => void handleReset()} type="button" variant="destructive">{resetting ? '正在重置' : '确认重置'}</Button>
                                </DialogFooter>
                            </DialogContent>
                        </Dialog>
                        <p aria-live="polite" className="mt-3 break-all text-sm text-muted-foreground">{resetMessage}</p>
                    </div>
                </div>
            </div>
        </section>
    );
}
