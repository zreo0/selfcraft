// Source adapted from https://beui.dev/components/agent-activity
import {
    Check,
    CircleHelp,
    CircleX,
    ExternalLink,
    LoaderCircle,
    Search,
    Wrench,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { AgentDisclosure } from '@/components/agents/agent-disclosure';
import { ThinkingShimmer } from '@/components/agents/loading-states/thinking-shimmer';
import type { AgentActivityGroup, AgentActivityView } from '@/types/api.types';

export interface AgentActivityProps {
    /** 当前回复的结构化活动组 */
    group: AgentActivityGroup;
}

/** 格式化短暂工具耗时 */
function formatDuration (durationMs: number | undefined): string | null {
    if (durationMs === undefined) {
        return null;
    }
    return durationMs < 1000
        ? `${Math.round(durationMs)}ms`
        : `${(durationMs / 1000).toFixed(1)}s`;
}

/** 返回活动状态使用的统一图标 */
function ActivityStateIcon ({ activity }: { activity: AgentActivityView }) {
    if (activity.state === 'running') {
        return <LoaderCircle aria-hidden="true" className="agent-activity-spinner" />;
    }
    if (activity.state === 'error') {
        return <CircleX aria-hidden="true" className="agent-activity-error" />;
    }
    if (activity.state === 'unknown') {
        return <CircleHelp aria-hidden="true" className="agent-activity-unknown" />;
    }
    return <Check aria-hidden="true" className="agent-activity-success" />;
}

/** 展示 Runtime 真实输出的搜索、工具与完成状态 */
export function AgentActivity ({ group }: AgentActivityProps) {
    const [open, setOpen] = useState(group.status === 'working');
    const running = group.items.find(item => item.state === 'running');
    const unfinished = group.items.filter(item => item.state !== 'success').length;
    const summary = group.status === 'working'
        ? running?.label || '正在组织回答'
        : unfinished > 0
            ? `${group.items.length} 项活动，${unfinished} 项未完成`
            : `完成 ${group.items.length} 项活动`;

    useEffect(() => {
        setOpen(group.status === 'working');
    }, [group.status]);

    if (group.items.length === 0) {
        return null;
    }
    return (
        <AgentDisclosure
            className="agent-activity"
            detail={group.status === 'working' ? '进行中' : undefined}
            onOpenChange={setOpen}
            open={open}
            title={group.status === 'working'
                ? <ThinkingShimmer>{summary}</ThinkingShimmer>
                : summary}
        >
            <ol className="agent-activity-list">
                {group.items.map(activity => {
                    const duration = formatDuration(activity.durationMs);
                    return (
                        <li data-state={activity.state} key={activity.id}>
                            <span className="agent-activity-kind">
                                {activity.kind === 'search'
                                    ? <Search aria-hidden="true" />
                                    : <Wrench aria-hidden="true" />}
                            </span>
                            <div className="agent-activity-copy">
                                <div className="agent-activity-heading">
                                    <span>{activity.label}</span>
                                    {duration && <time>{duration}</time>}
                                </div>
                                {activity.target && <p>{activity.target}</p>}
                                {activity.results && activity.results.length > 0 && (
                                    <ul className="agent-search-results">
                                        {activity.results.map(result => (
                                            <li key={result.id}>
                                                <a href={result.url} rel="noreferrer" target="_blank">
                                                    <span>{result.title}</span>
                                                    <small>{result.domain}</small>
                                                    <ExternalLink aria-hidden="true" />
                                                </a>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                            <ActivityStateIcon activity={activity} />
                        </li>
                    );
                })}
            </ol>
        </AgentDisclosure>
    );
}
