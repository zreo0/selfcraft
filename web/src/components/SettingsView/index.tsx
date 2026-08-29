import { RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
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
import { ModelList } from './ModelList';
import { ProviderForm } from './ProviderForm';

/** Selfcraft 的模型、时区与本地配置页面 */
export function SettingsView ({
    config,
    configurationError,
    onChanged,
}: {
    config: ConfigView | null;
    configurationError: string | null;
    onChanged: (config: ConfigView) => void;
}) {
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
                        <h1>设置</h1>
                        <nav aria-label="设置分区" className="settings-index">
                            <a href="#settings-model">当前模型</a>
                            <a href="#settings-provider">模型渠道</a>
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
                            <h2>当前模型</h2>
                            <p>所有入口共用这里选择的同一个模型。</p>
                        </div>
                        {config ? <ModelList config={config} onChanged={onChanged} /> : <p className="text-sm text-muted-foreground">配置暂不可用</p>}
                    </div>

                    <div className="settings-section" id="settings-provider">
                        <div className="settings-section-title">
                            <h2>{config?.providers.length ? '添加或更新渠道' : '先给我一个可以思考的模型'}</h2>
                            <p>保存同名渠道会更新它。API Key 不会从服务端再次读回页面。</p>
                        </div>
                        <ProviderForm onSaved={onChanged} />
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
                            <p>只重置模型与时区设置。身份、记忆、会话、技能、任务和工作区不会被删除。</p>
                        </div>
                        <Dialog onOpenChange={setResetOpen} open={resetOpen}>
                            <DialogTrigger asChild>
                                <Button type="button" variant="outline"><RotateCcw aria-hidden="true" className="size-4" />备份并重置</Button>
                            </DialogTrigger>
                            <DialogContent>
                                <DialogHeader>
                                    <DialogTitle>重新初始化模型配置？</DialogTitle>
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
