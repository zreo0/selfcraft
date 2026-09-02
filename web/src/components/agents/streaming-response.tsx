// Source adapted from https://beui.dev/components/streaming-response
import { Check, Copy } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Citations, type CitationItem } from '@/components/agents/citations';

export interface StreamingResponseProps {
    /** Markdown 正文 */
    children: ReactNode;
    /** 用于复制的纯文本 */
    copyText: string;
    /** Runtime 确认读取过的来源 */
    sources: CitationItem[];
    /** 回复是否仍在流式生成 */
    streaming: boolean;
}

/**
 * 生成可独立阅读的剪贴板文本
 *
 * @param text Runtime 生成的回答正文
 * @param sources Runtime 确认读取过的结构化来源
 * @returns 包含正文与来源地址的纯文本
 */
function buildCopyText (text: string, sources: CitationItem[]): string {
    if (sources.length === 0) {
        return text;
    }
    const sourceList = sources
        .map(source => `- ${source.title} — ${source.url}`)
        .join('\n');
    return `${text}\n\n参考来源：\n${sourceList}`;
}

/** 组织流式正文、来源和完成后的轻量操作 */
export function StreamingResponse ({
    children,
    copyText,
    sources,
    streaming,
}: StreamingResponseProps) {
    const [copied, setCopied] = useState(false);

    /** 将回复文本复制到系统剪贴板 */
    async function handleCopy (): Promise<void> {
        await navigator.clipboard.writeText(buildCopyText(copyText, sources));
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
    }

    return (
        <div className="streaming-response" data-streaming={streaming || undefined}>
            {children}
            {!streaming && (
                <div className="response-footer">
                    <Citations items={sources} />
                    <div aria-label="回答操作" className="response-actions" role="group">
                        <button aria-label="复制回答" onClick={() => void handleCopy()} type="button">
                            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                            <span>{copied ? '已复制' : '复制回答'}</span>
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
