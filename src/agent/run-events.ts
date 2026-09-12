/** Agent 工具活动的执行状态 */
export type AgentActivityState = 'running' | 'success' | 'error' | 'unknown';

/** 网络搜索活动中的一条候选结果 */
export interface AgentSearchResult {
    /** 当前结果在本轮活动中的稳定标识 */
    id: string;
    /** 页面标题 */
    title: string;
    /** 页面域名 */
    domain?: string;
    /** 页面地址 */
    url: string;
}

/** 一次可供各通信入口呈现的工具活动 */
export interface AgentActivity {
    /** 工具调用标识 */
    id: string;
    /** 搜索使用专用呈现，其余工具使用通用呈现 */
    kind: 'search' | 'tool';
    /** Runtime 工具名 */
    toolName: string;
    /** 面向用户的简短动作名称 */
    label: string;
    /** 不包含正文和凭证的目标摘要 */
    target?: string;
    /** 当前执行状态 */
    state: AgentActivityState;
    /** 执行耗时 */
    durationMs?: number;
    /** 搜索完成后返回的有界候选列表 */
    results?: AgentSearchResult[];
}

/** Agent 实际读取过的外部来源 */
export interface AgentSource {
    /** 来源在当前运行中的稳定标识 */
    id: string;
    /** 来源地址 */
    url: string;
    /** 可展示的来源名称 */
    title: string;
}

/** Runtime 向所有通信入口输出的统一事件 */
export type AgentRunEvent =
    | {
        type: 'status';
        phase: 'queued' | 'preparing' | 'thinking';
        label: string;
    }
    | {
        type: 'activity';
        activity: AgentActivity;
    }
    | {
        type: 'source';
        source: AgentSource;
    }
    | {
        type: 'text-delta';
        delta: string;
    };

/** 一次工具成功结束后得到的活动与来源 */
export interface AgentToolCompletion {
    /** 已完成的活动 */
    activity: AgentActivity;
    /** 本次工具实际读取的来源 */
    sources: AgentSource[];
}

const TOOL_LABELS: Record<string, string> = {
    read: '读取文件',
    image_analyze: '查看图片',
    list: '查看目录',
    search: '搜索工作区',
    write: '写入文件',
    edit: '修改文件',
    shell: '运行命令',
    skills: '查看技能',
    read_skill: '读取技能',
    job_start: '创建后台任务',
    job_list: '查看后台任务',
    job_status: '检查后台任务',
    job_cancel: '取消后台任务',
    job_resume: '恢复后台任务',
    memory_remember: '记住信息',
    memory_search: '搜索记忆',
    memory_confirm: '确认记忆',
    memory_recall: '回想过往',
    memory_correct: '修订记忆',
    memory_forget: '忘记记忆',
    memory_erase_event: '擦除事件',
    topic_create: '创建持续事项',
    topic_search: '查找持续事项',
    topic_link_event: '续接持续事项',
    growth_list: '查看成长候选',
    growth_resolve: '处理成长候选',
    task_schedule: '安排提醒',
    task_list: '查看提醒',
    task_cancel: '取消提醒',
    notify: '留下通知',
    runtime_files: '检查 Runtime 文件',
    runtime_read: '读取 Runtime 源码',
    evolve_runtime: '验证 Runtime 改进',
    web_search: '搜索网络',
    web_fetch: '阅读网页',
};

/** 为工具开始事件创建安全且有界的活动摘要 */
export function createAgentActivity (
    toolName: string,
    toolCallId: string,
    input: unknown,
): AgentActivity {
    const target = activityTarget(toolName, input);
    return {
        id: toolCallId,
        kind: toolName === 'web_search' ? 'search' : 'tool',
        toolName,
        label: TOOL_LABELS[toolName] || `使用 ${toolName}`,
        ...(target && { target }),
        state: 'running',
    };
}

/** 把成功工具输出转换成完成活动，并只提取实际读取的网页来源 */
export function completeAgentActivity (
    activity: AgentActivity,
    output: unknown,
    durationMs?: number,
): AgentToolCompletion {
    const results = activity.toolName === 'web_search' ? searchResults(output) : [];
    const source = activity.toolName === 'web_fetch' ? fetchedSource(activity.id, output) : null;
    return {
        activity: {
            ...activity,
            state: 'success',
            ...(durationMs !== undefined && { durationMs }),
            ...(results.length > 0 && { results }),
        },
        sources: source ? [source] : [],
    };
}

/** 把失败工具输出转换成不泄露内部错误的失败活动 */
export function failAgentActivity (
    activity: AgentActivity,
    durationMs?: number,
): AgentActivity {
    return {
        ...activity,
        state: 'error',
        ...(durationMs !== undefined && { durationMs }),
    };
}

/** 从已知工具输入中提取不会暴露正文或凭证的目标摘要 */
function activityTarget (toolName: string, input: unknown): string | undefined {
    const value = objectValue(input);
    if (!value) {
        return undefined;
    }
    const candidates: Record<string, unknown> = {
        web_search: value.query,
        web_fetch: value.url,
        read: value.path,
        list: value.path,
        search: value.query,
        write: value.path,
        edit: value.path,
        read_skill: value.name,
        job_start: value.title,
        memory_search: value.query,
        memory_recall: value.query,
        topic_create: value.title,
        topic_search: value.query,
        task_schedule: value.title,
        notify: value.title,
        runtime_read: value.path,
    };
    return boundedText(candidates[toolName]);
}

/** 从搜索工具结果中提取最多五条可展示候选 */
function searchResults (output: unknown): AgentSearchResult[] {
    const value = objectValue(output);
    if (!Array.isArray(value?.results)) {
        return [];
    }
    return value.results.flatMap((result, index) => {
        const item = objectValue(result);
        const title = boundedText(item?.title);
        const url = boundedUrl(item?.url);
        if (!title || !url) {
            return [];
        }
        return [{
            id: `${index + 1}:${url}`,
            title,
            url,
            ...(urlDomain(url) && { domain: urlDomain(url) }),
        }];
    }).slice(0, 5);
}

/** 从成功的网页读取结果中提取一个来源 */
function fetchedSource (toolCallId: string, output: unknown): AgentSource | null {
    const url = boundedUrl(objectValue(output)?.url);
    if (!url) {
        return null;
    }
    return {
        id: `${toolCallId}:source`,
        url,
        title: urlDomain(url) || url,
    };
}

/** 将未知值收窄为普通对象 */
function objectValue (value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null
        ? value as Record<string, unknown>
        : null;
}

/** 返回适合活动列表的有界单行文本 */
function boundedText (value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const text = value.trim().replace(/\s+/g, ' ');
    return text ? text.slice(0, 180) : undefined;
}

/** 只接受公开展示所需的 HTTP(S) 地址 */
function boundedUrl (value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length > 4096) {
        return undefined;
    }
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) ? url.toString() : undefined;
    } catch {
        return undefined;
    }
}

/** 从合法地址中读取展示域名 */
function urlDomain (value: string): string | undefined {
    try {
        return new URL(value).hostname.replace(/^www\./, '') || undefined;
    } catch {
        return undefined;
    }
}
