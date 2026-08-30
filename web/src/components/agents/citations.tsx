// Source adapted from https://beui.dev/components/citations
import { BookOpenText, ExternalLink } from 'lucide-react';
import { AgentDisclosure } from '@/components/agents/agent-disclosure';

export interface CitationItem {
    /** 来源标识 */
    id: string;
    /** 来源名称 */
    title: string;
    /** 来源地址 */
    url: string;
}

export interface CitationsProps {
    /** Runtime 确认实际读取过的来源 */
    items: CitationItem[];
}

/** 展示本轮回答实际读取过的网页来源 */
export function Citations ({ items }: CitationsProps) {
    if (items.length === 0) {
        return null;
    }
    return (
        <AgentDisclosure
            className="citations"
            detail={`${items.length} 个`}
            title={<><BookOpenText aria-hidden="true" />参考来源</>}
        >
            <ol className="citation-list">
                {items.map((item, index) => (
                    <li key={item.id}>
                        <a href={item.url} rel="noreferrer" target="_blank">
                            <span className="citation-index">{index + 1}</span>
                            <span className="citation-title">{item.title}</span>
                            <ExternalLink aria-hidden="true" />
                        </a>
                    </li>
                ))}
            </ol>
        </AgentDisclosure>
    );
}
