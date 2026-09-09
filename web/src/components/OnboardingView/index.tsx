import { ArrowRight, Check, Settings2 } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/motion/button';
import { ThemeControls } from '@/components/ThemeControls';
import { TimeZonePicker } from '@/components/TimeZonePicker';
import { Textarea } from '@/components/ui/textarea';
import type { Palette, Theme } from '@/hooks/useTheme';
import { BRAND_IMAGE_PATH } from '@/lib/brand';
import { EASE_OUT } from '@/lib/ease';
import { saveTimezone } from '@/services/runtime';
import type { ConfigView } from '@/types/api.types';
import { ProviderForm } from '../SettingsView/ProviderForm';

type OnboardingStep = 'model' | 'timezone' | 'ready';

/** Web 渠道中从模型接入走向第一段真实对话的认识流程 */
export function OnboardingView ({
    config,
    theme,
    palette,
    onChanged,
    onComplete,
    onOpenSettings,
    onToggleTheme,
    onPaletteChange,
}: {
    config: ConfigView;
    theme: Theme;
    palette: Palette;
    onChanged: (config: ConfigView) => void;
    onComplete: (firstMessage?: string) => void;
    onOpenSettings: () => void;
    onToggleTheme: () => void;
    onPaletteChange: (palette: Palette) => void;
}) {
    const reduce = useReducedMotion();
    const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || config.timezone || 'UTC';
    const [step, setStep] = useState<OnboardingStep>('model');
    const [timezone, setTimezone] = useState(browserTimezone);
    const [timezoneError, setTimezoneError] = useState<string | null>(null);
    const [savingTimezone, setSavingTimezone] = useState(false);
    const [firstMessage, setFirstMessage] = useState('');

    /** 接收模型配置，并继续询问用户的时间语境 */
    function handleModelSaved (next: ConfigView): void {
        onChanged(next);
        setStep('timezone');
    }

    /** 保存浏览器用户确认过的时区 */
    async function handleTimezoneSave (): Promise<void> {
        setSavingTimezone(true);
        setTimezoneError(null);
        try {
            onChanged(await saveTimezone(timezone));
            setStep('ready');
        } catch (error) {
            setTimezoneError(error instanceof Error ? error.message : '时区保存失败');
        } finally {
            setSavingTimezone(false);
        }
    }

    /** 把用户的第一句话交给真实对话，而不是生成一段演示内容 */
    function handleFirstMessage (event: FormEvent<HTMLFormElement>): void {
        event.preventDefault();
        const message = firstMessage.trim();
        if (message) {
            onComplete(message);
        }
    }

    const defaultModel = config.defaultModel
        ? `${config.defaultModel.providerId}/${config.defaultModel.modelId}`
        : null;

    const stepCopy = {
        model: {
            title: '先给我思考的能力',
            description: '接通一个模型渠道。凭证只写入我所在的工作区，不会再返回到页面。',
        },
        timezone: {
            title: '我们怎样理解时间？',
            description: '确认你通常生活的时区，这会影响我理解“明天”“上周”和提醒。',
        },
        ready: {
            title: '现在，真正认识一下吧',
            description: '第一句话会直接进入真实对话。它不是演示，也不会在流程结束后消失。',
        },
    }[step];

    return (
        <main className="app-background onboarding-view">
            <header className="onboarding-topbar">
                <div className="brand-lockup brand-lockup--onboarding">
                    <span className="brand-core"><img alt="" src={BRAND_IMAGE_PATH} /></span>
                    <span className="brand-copy"><strong>Selfcraft</strong><small>初次见面</small></span>
                </div>
                <div className="onboarding-actions">
                    <ThemeControls
                        onPaletteChange={onPaletteChange}
                        onToggleTheme={onToggleTheme}
                        palette={palette}
                        theme={theme}
                    />
                    <Button onClick={onOpenSettings} size="sm" type="button" variant="ghost">
                        <Settings2 aria-hidden="true" className="size-3.5" />完整设置
                    </Button>
                </div>
            </header>

            <div className="onboarding-layout">
                <section className="onboarding-intro">
                    <div className="onboarding-core"><span className="brand-core brand-core--large"><img alt="" src={BRAND_IMAGE_PATH} /></span></div>
                    <h1>你好，<br />初次见面。</h1>
                    <p>我不会先替自己决定名字和性格。现在先帮我完成一些基础的配置，其余的应该在相处中慢慢形成。</p>
                    <ol aria-label="初始化进度" className="onboarding-progress">
                        <li aria-current={step === 'model' ? 'step' : undefined} className={step !== 'model' ? 'is-complete' : 'is-current'}><span />模型</li>
                        <li aria-current={step === 'timezone' ? 'step' : undefined} className={step === 'ready' ? 'is-complete' : step === 'timezone' ? 'is-current' : ''}><span />位置</li>
                        <li aria-current={step === 'ready' ? 'step' : undefined} className={step === 'ready' ? 'is-current' : ''}><span />对话</li>
                    </ol>
                </section>

                <section aria-live="polite" className="onboarding-thread">
                    {(defaultModel || step === 'ready') && (
                        <div className="onboarding-confirmations">
                            {defaultModel && <span><Check aria-hidden="true" />{defaultModel}</span>}
                            {step === 'ready' && <span><Check aria-hidden="true" />{timezone}</span>}
                        </div>
                    )}
                    <AnimatePresence initial={false} mode="wait">
                        <motion.div
                            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                            className="onboarding-step"
                            exit={reduce ? undefined : { opacity: 0, y: -12, filter: 'blur(6px)' }}
                            initial={reduce ? false : { opacity: 0, y: 18, filter: 'blur(8px)' }}
                            key={step}
                            transition={{ duration: 0.36, ease: EASE_OUT }}
                        >
                            <div className="onboarding-message">
                                <div><strong>Selfcraft</strong><h2>{stepCopy.title}</h2><p>{stepCopy.description}</p></div>
                            </div>

                            {step === 'model' && (
                                <div className="onboarding-response">
                                    <ProviderForm compact onSaved={handleModelSaved} submitLabel="接通这个模型" />
                                </div>
                            )}

                            {step === 'timezone' && (
                                <div className="onboarding-response onboarding-timezone">
                                    <label className="field-label">
                                        <span>你的本地时间</span>
                                        <TimeZonePicker onChange={setTimezone} value={timezone} />
                                    </label>
                                    <Button disabled={savingTimezone} onClick={() => void handleTimezoneSave()} type="button">
                                        {savingTimezone ? '正在记住' : '确认这个时区'}
                                    </Button>
                                    {timezoneError && <p className="onboarding-inline-error" role="alert">{timezoneError}</p>}
                                </div>
                            )}

                            {step === 'ready' && (
                                <form className="onboarding-first-message" onSubmit={handleFirstMessage}>
                                    <Textarea
                                        aria-label="第一句话"
                                        autoFocus
                                        onChange={event => setFirstMessage(event.target.value)}
                                        placeholder="此刻，你最希望我知道什么？"
                                        value={firstMessage}
                                    />
                                    <div className="onboarding-first-actions">
                                        <Button onClick={() => onComplete()} type="button" variant="ghost">先进入对话</Button>
                                        <Button disabled={!firstMessage.trim()} type="submit">
                                            从这句话开始<ArrowRight aria-hidden="true" className="size-4" />
                                        </Button>
                                    </div>
                                </form>
                            )}
                        </motion.div>
                    </AnimatePresence>
                </section>
            </div>
        </main>
    );
}
