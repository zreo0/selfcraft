import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';
export type Palette = 'blue' | 'ink';

/** 读取持久主题，未选择时跟随系统 */
function resolveInitialTheme (): Theme {
    const saved = window.localStorage.getItem('selfcraft-theme');
    if (saved === 'light' || saved === 'dark') {
        return saved;
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** 读取持久品牌配色，未选择时使用澄蓝方案 */
function resolveInitialPalette (): Palette {
    return window.localStorage.getItem('selfcraft-palette') === 'ink' ? 'ink' : 'blue';
}

/** 管理页面明暗外观与品牌配色 */
export function useTheme (): {
    theme: Theme;
    palette: Palette;
    toggleTheme: () => void;
    setPalette: (palette: Palette) => void;
} {
    const [theme, setTheme] = useState<Theme>(resolveInitialTheme);
    const [palette, setPalette] = useState<Palette>(resolveInitialPalette);
    useEffect(() => {
        document.documentElement.classList.toggle('dark', theme === 'dark');
        document.documentElement.style.colorScheme = theme;
        document.querySelector('meta[name="theme-color"]')?.setAttribute(
            'content',
            theme === 'dark' ? '#151515' : '#f8f9fa',
        );
        window.localStorage.setItem('selfcraft-theme', theme);
    }, [theme]);
    useEffect(() => {
        document.documentElement.dataset.palette = palette;
        window.localStorage.setItem('selfcraft-palette', palette);
    }, [palette]);
    const toggleTheme = useCallback(() => {
        setTheme(current => current === 'light' ? 'dark' : 'light');
    }, []);
    return { theme, palette, toggleTheme, setPalette };
}
