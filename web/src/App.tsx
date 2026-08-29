import { MessageCircle, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ChatView } from '@/components/ChatView';
import { Button } from '@/components/motion/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/motion/tabs';
import { OnboardingView } from '@/components/OnboardingView';
import { RuntimeStatus } from '@/components/RuntimeStatus';
import { SettingsView } from '@/components/SettingsView';
import { ThemeControls } from '@/components/ThemeControls';
import { useTheme } from '@/hooks/useTheme';
import { BRAND_IMAGE_PATH } from '@/lib/brand';
import { getBootstrap } from '@/services/runtime';
import type { BootstrapView, ConfigView } from '@/types/api.types';

type ViewName = 'chat' | 'settings';

/** Selfcraft Web 应用根组件 */
export function App () {
    const [bootstrap, setBootstrap] = useState<BootstrapView | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [view, setView] = useState<ViewName>('chat');
    const [onboardingOpen, setOnboardingOpen] = useState(false);
    const [firstMessage, setFirstMessage] = useState<string | undefined>();
    const { theme, palette, toggleTheme, setPalette } = useTheme();

    /** 从唯一 Runtime 读取页面初始状态 */
    async function load (): Promise<void> {
        setLoadError(null);
        try {
            const next = await getBootstrap();
            setBootstrap(next);
            if (!next.config?.configured && !next.configurationError) {
                setOnboardingOpen(true);
            } else if (next.configurationError) {
                setView('settings');
            }
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : '无法连接 Runtime');
        }
    }

    useEffect(() => {
        void load();
    }, []);

    /** 接收设置页保存后的脱敏配置 */
    function handleConfigChanged (config: ConfigView): void {
        setBootstrap(current => current ? {
            ...current,
            config,
            configurationError: null,
        } : current);
    }

    /** 从认识流程进入真实对话，并把可选的第一句话交给 Chat */
    function handleOnboardingComplete (message?: string): void {
        setFirstMessage(message);
        setOnboardingOpen(false);
        setView('chat');
    }

    if (!bootstrap) {
        return (
            <main className="app-background grid min-h-screen place-items-center px-6">
                <div className="text-center">
                    <div className="brand-core brand-core--loading"><img alt="" src={BRAND_IMAGE_PATH} /></div>
                    <p className="mt-5 text-sm text-muted-foreground">{loadError || '正在连接 Runtime'}</p>
                    {loadError && <Button className="mt-4" onClick={() => void load()} type="button" variant="outline">重新连接</Button>}
                </div>
            </main>
        );
    }

    if (onboardingOpen && bootstrap.config) {
        return (
            <OnboardingView
                config={bootstrap.config}
                onChanged={handleConfigChanged}
                onComplete={handleOnboardingComplete}
                onOpenSettings={() => {
                    setOnboardingOpen(false);
                    setView('settings');
                }}
                onPaletteChange={setPalette}
                onToggleTheme={toggleTheme}
                palette={palette}
                theme={theme}
            />
        );
    }

    return (
        <main className="app-background min-h-screen">
            <div className="app-shell">
                <header className="global-header">
                    <button aria-label="打开对话" className="brand-lockup" onClick={() => setView('chat')} type="button">
                        <span className="brand-core"><img alt="" src={BRAND_IMAGE_PATH} /></span>
                        <span className="brand-copy">
                            <strong>Selfcraft</strong>
                            <small>只为你存在</small>
                        </span>
                    </button>
                    <Tabs className="global-navigation" onValueChange={value => setView(value as ViewName)} value={view} variant="pill">
                        <TabsList>
                            <TabsTrigger value="chat"><MessageCircle aria-hidden="true" className="size-3.5" />对话</TabsTrigger>
                            <TabsTrigger value="settings"><Settings aria-hidden="true" className="size-3.5" />设置</TabsTrigger>
                        </TabsList>
                    </Tabs>
                    <div className="global-actions">
                        <RuntimeStatus config={bootstrap.config} runtime={bootstrap.runtime} />
                        <ThemeControls
                            onPaletteChange={setPalette}
                            onToggleTheme={toggleTheme}
                            palette={palette}
                            theme={theme}
                        />
                    </div>
                </header>
                <div className="app-body">
                    <div className="app-surface">
                        <div className={view === 'chat' ? 'contents' : 'hidden'}>
                            <ChatView
                                config={bootstrap.config}
                                initialMessage={firstMessage}
                                initialCursor={bootstrap.messages.nextCursor}
                                initialMessages={bootstrap.messages.items}
                                onInitialMessageSent={() => setFirstMessage(undefined)}
                                onRequestSettings={() => setView('settings')}
                            />
                        </div>
                        <div className={view === 'settings' ? 'contents' : 'hidden'}>
                            <SettingsView
                                config={bootstrap.config}
                                configurationError={bootstrap.configurationError}
                                onChanged={handleConfigChanged}
                            />
                        </div>
                    </div>
                </div>
            </div>
        </main>
    );
}
