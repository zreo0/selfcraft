import { animate, useReducedMotion } from 'motion/react';
import { useEffect, useId, useRef, type CSSProperties } from 'react';

/**
 * 页面切入时让字形成形，保留原始文字的排版和可访问名称
 *
 * @param props.active 页面是否可见，仅切入时播放
 * @param props.variant flow 为流动汇聚，assemble 为碎块归位
 * @param props.children 标题文字
 * @param props.id 标题的可访问引用
 * @returns 带一次性成形动效的一级标题
 */
export function PageTitle ({
    active,
    variant,
    children,
    id,
}: {
    active: boolean;
    variant: 'flow' | 'assemble';
    children: string;
    id?: string;
}) {
    const flowing = variant === 'flow';
    const filterId = useId();
    const displacement = useRef<SVGFEDisplacementMapElement>(null);
    const reduce = useReducedMotion();

    useEffect(() => {
        const node = displacement.current;
        if (!node || !flowing || !active || reduce) return;
        // 只扭动标题的字形，切出页面或开启减少动态效果时停止计算
        const playback = animate(22, 0, {
            duration: 1.35,
            ease: [0.3, 0, 0.4, 1],
            onUpdate: value => node.setAttribute('scale', String(value)),
        });
        return () => {
            playback.stop();
            node.setAttribute('scale', '0');
        };
    }, [active, flowing, reduce]);

    return (
        <h1 className="page-title" data-active={active} data-variant={variant} id={id}>
            <span className="page-title-word" style={flowing ? { '--title-flow-filter': `url(#${filterId})` } as CSSProperties : undefined}>
                <span className="page-title-text">{children}</span>
                {flowing && (
                    <svg aria-hidden="true" className="page-title-filter" focusable="false">
                        <defs>
                            <filter colorInterpolationFilters="sRGB" height="160%" id={filterId} width="180%" x="-40%" y="-30%">
                                <feTurbulence baseFrequency="0.018 0.065" numOctaves="1" result="river" seed="8" type="fractalNoise" />
                                <feDisplacementMap in="SourceGraphic" in2="river" ref={displacement} scale="0" xChannelSelector="R" yChannelSelector="G" />
                            </filter>
                        </defs>
                    </svg>
                )}
                {!flowing && <span aria-hidden="true" className="page-title-pieces">
                    {Array.from({ length: 16 }, (_, index) => {
                        const row = Math.floor(index / 4);
                        const column = index % 4;
                        // 裁切同一份文字，最终字形与静态标题完全重合，不依赖字体轮廓或图片
                        const style = {
                            clipPath: `inset(${row * 25}% ${(3 - column) * 25}% ${(3 - row) * 25}% ${column * 25}%)`,
                            '--piece-x': `${(column - 1.5) * 0.18}em`,
                            '--piece-y': `${-0.42 - (3 - row) * 0.12}em`,
                            '--piece-turn': `${(column % 2 ? 1 : -1) * 9}deg`,
                            '--piece-delay': `${(3 - row) * 65 + column * 40}ms`,
                        } as CSSProperties;

                        return <span className="page-title-piece" key={index} style={style}>{children}</span>;
                    })}
                </span>}
            </span>
        </h1>
    );
}
