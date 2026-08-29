// Source adapted from https://beui.dev/r/theme-toggle/raw
import { Moon, Sun } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import { useEffect, type ComponentPropsWithoutRef, type MouseEvent } from 'react';
import { ActionSwapIcon } from '@/components/motion/action-swap';
import { cn } from '@/lib/utils';

const VIEW_TRANSITION_STYLE_ID = 'beui-theme-toggle-transition';
const VIEW_TRANSITION_CSS = `
html[data-beui-vt="circle-blur"]::view-transition-old(root) {
    animation: none;
    mix-blend-mode: normal;
}
html[data-beui-vt="circle-blur"]::view-transition-new(root) {
    animation: beui-theme-reveal 620ms cubic-bezier(0.16, 1, 0.3, 1);
    mix-blend-mode: normal;
}
@keyframes beui-theme-reveal {
    from { clip-path: circle(0% at var(--beui-vt-origin)); filter: blur(8px); }
    to { clip-path: circle(150% at var(--beui-vt-origin)); filter: blur(0); }
}`;

/** 向页面注册 BeUI 主题转场样式 */
function ensureTransitionStyles (): void {
    if (document.getElementById(VIEW_TRANSITION_STYLE_ID)) {
        return;
    }
    const style = document.createElement('style');
    style.id = VIEW_TRANSITION_STYLE_ID;
    style.textContent = VIEW_TRANSITION_CSS;
    document.head.appendChild(style);
}

/** 使用 BeUI 圆形模糊转场切换浅色与深色主题 */
export function ThemeToggle ({
    theme,
    onToggle,
    className,
    ...props
}: Omit<ComponentPropsWithoutRef<'button'>, 'onClick'> & {
    theme: 'light' | 'dark';
    onToggle: () => void;
}) {
    const reduce = useReducedMotion() ?? false;
    useEffect(ensureTransitionStyles, []);

    /** 从真实按钮位置开始执行页面主题揭示 */
    function handleClick (event: MouseEvent<HTMLButtonElement>): void {
        const root = document.documentElement;
        const bounds = event.currentTarget.getBoundingClientRect();
        root.style.setProperty('--beui-vt-origin', `${bounds.left + bounds.width / 2}px ${bounds.top + bounds.height / 2}px`);
        if (reduce || !('startViewTransition' in document)) {
            onToggle();
            return;
        }
        root.dataset.beuiVt = 'circle-blur';
        const transition = (document as Document & {
            startViewTransition: (callback: () => void) => { finished: Promise<void> };
        }).startViewTransition(onToggle);
        void transition.finished.finally(() => {
            delete root.dataset.beuiVt;
        });
    }

    return (
        <button
            aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
            className={cn('theme-icon-button', className)}
            onClick={handleClick}
            type="button"
            {...props}
        >
            <ActionSwapIcon animation="roll" className="size-4" value={theme}>
                {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </ActionSwapIcon>
        </button>
    );
}
