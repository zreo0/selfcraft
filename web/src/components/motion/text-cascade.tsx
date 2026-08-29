// Source adapted from https://beui.dev/r/text-cascade/raw
import { ActionSwapText } from '@/components/motion/action-swap';

export interface TextCascadeProps {
    /** 当前需要展示的文本 */
    text: string;
    className?: string;
}

/** 在文本变化时逐字切换内容 */
export function TextCascade ({ text, className }: TextCascadeProps) {
    return (
        <ActionSwapText animation="cascade" className={className} value={text}>
            {text}
        </ActionSwapText>
    );
}
