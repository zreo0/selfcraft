import { Palette as PaletteIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/motion/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/motion/tabs';
import { ThemeToggle } from '@/components/motion/theme-toggle';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { Palette, Theme } from '@/hooks/useTheme';

/** 提供独立的明暗模式与品牌配色切换 */
export function ThemeControls ({
    theme,
    palette,
    onToggleTheme,
    onPaletteChange,
}: {
    theme: Theme;
    palette: Palette;
    onToggleTheme: () => void;
    onPaletteChange: (palette: Palette) => void;
}) {
    const [paletteOpen, setPaletteOpen] = useState(false);
    return (
        <div className="theme-controls">
            <ThemeToggle onToggle={onToggleTheme} theme={theme} />
            <Popover onOpenChange={setPaletteOpen} open={paletteOpen}>
                <PopoverTrigger asChild>
                    <Button aria-label="选择主题配色" className="theme-icon-button" size="icon-sm" type="button" variant="ghost">
                        <PaletteIcon aria-hidden="true" className="size-4" />
                    </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="theme-popover" sideOffset={10}>
                    <div className="theme-popover-heading">
                        <strong>界面配色</strong>
                        <span>只改变视觉，不影响记忆与配置</span>
                    </div>
                    <Tabs
                        onValueChange={value => {
                            onPaletteChange(value as Palette);
                            setPaletteOpen(false);
                        }}
                        value={palette}
                        variant="segment"
                    >
                        <TabsList className="grid w-full grid-cols-2">
                            <TabsTrigger className="w-full" value="blue">
                                <span className="palette-swatch palette-swatch--blue" />澄蓝
                            </TabsTrigger>
                            <TabsTrigger className="w-full" value="ink">
                                <span className="palette-swatch palette-swatch--ink" />墨白
                            </TabsTrigger>
                        </TabsList>
                    </Tabs>
                </PopoverContent>
            </Popover>
        </div>
    );
}
