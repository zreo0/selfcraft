import { useEffect, useState } from 'react';

/** 判断当前设备是否具有不会粘滞的真实悬停能力 */
export function useHoverCapable (): boolean {
    const [canHover, setCanHover] = useState(false);

    useEffect(() => {
        const query = window.matchMedia('(hover: hover) and (pointer: fine)');
        /** 将媒体查询结果同步到 React 状态 */
        function update (): void {
            setCanHover(query.matches);
        }
        update();
        query.addEventListener('change', update);
        return () => query.removeEventListener('change', update);
    }, []);

    return canHover;
}
