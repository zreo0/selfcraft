import { useEffect, useRef, useState } from 'react';
import { TextCascade } from '@/components/motion/text-cascade';
import { ASSISTANT_MURMURS } from '@/lib/assistant-murmurs';

const MURMUR_INTERVAL_MS = 60_000;

/** 随机选择一条初始短句 */
function randomMurmurIndex (): number {
    return Math.floor(Math.random() * ASSISTANT_MURMURS.length);
}

/** 在输入框下方展示会随时间变化的助理短想法 */
export function AssistantMurmur () {
    const noteRef = useRef<HTMLParagraphElement>(null);
    const [murmurIndex, setMurmurIndex] = useState(randomMurmurIndex);

    useEffect(() => {
        let timer: ReturnType<typeof setInterval> | null = null;
        let inViewport = false;

        /** 停止当前短句轮换计时 */
        function stopRotation (): void {
            if (timer === null) {
                return;
            }
            clearInterval(timer);
            timer = null;
        }

        /** 随机换到另一条短句 */
        function showNextMurmur (): void {
            setMurmurIndex(current => {
                const offset = 1 + Math.floor(Math.random() * (ASSISTANT_MURMURS.length - 1));
                return (current + offset) % ASSISTANT_MURMURS.length;
            });
        }

        /** 根据页面和组件可见性同步计时器 */
        function syncRotation (): void {
            const shouldRotate = inViewport && document.visibilityState === 'visible';
            if (!shouldRotate) {
                stopRotation();
                return;
            }
            if (timer === null) {
                timer = setInterval(showNextMurmur, MURMUR_INTERVAL_MS);
            }
        }

        /** 记录短句是否处于当前视口 */
        function handleIntersection (entries: IntersectionObserverEntry[]): void {
            inViewport = entries[0]?.isIntersecting ?? false;
            syncRotation();
        }

        const note = noteRef.current;
        if (!note) {
            return;
        }

        const observer = new IntersectionObserver(handleIntersection);
        observer.observe(note);
        document.addEventListener('visibilitychange', syncRotation);

        return () => {
            observer.disconnect();
            document.removeEventListener('visibilitychange', syncRotation);
            stopRotation();
        };
    }, []);

    return (
        <p className="composer-note" ref={noteRef}>
            <TextCascade text={ASSISTANT_MURMURS[murmurIndex]} />
        </p>
    );
}
