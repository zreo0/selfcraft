import type { AgentRunOptions, AgentRunResult } from './agent-runtime';
import type { AgentRunEvent } from './run-events';

/** 前台 Agent 需要提供的最小执行接口 */
export interface ForegroundAgent {
    /** 执行一轮前台对话 */
    run (
        input: string,
        onEvent?: (event: AgentRunEvent) => void,
        options?: AgentRunOptions,
    ): Promise<AgentRunResult>;
}

/** 在多个通信入口之间串行执行前台对话 */
export class ForegroundRunner {
    private tail: Promise<void> = Promise.resolve();
    private pending = 0;

    /**
     * 创建共享前台执行器
     *
     * @param agent 唯一的 Agent Runtime
     */
    constructor (private readonly agent: ForegroundAgent) {}

    /**
     * 排队执行一轮对话，避免多个入口交错写入同一长期会话
     *
     * @param input 用户输入
     * @param onEvent 统一运行事件回调
     * @param options 取消信号等执行选项
     * @returns Agent 执行结果
     */
    public async run (
        input: string,
        onEvent: (event: AgentRunEvent) => void = () => undefined,
        options: AgentRunOptions = {},
    ): Promise<AgentRunResult> {
        if (this.pending > 0) {
            onEvent({
                type: 'status',
                phase: 'queued',
                label: '正在等待上一轮对话结束',
            });
        }
        this.pending += 1;
        const operation = this.tail.then(async () => {
            if (options.signal?.aborted) {
                throw new DOMException('对话已取消', 'AbortError');
            }
            return await this.agent.run(input, onEvent, options);
        });
        this.tail = operation.then(() => undefined, () => undefined);
        try {
            return await operation;
        } finally {
            this.pending -= 1;
        }
    }

    /** 返回正在执行和等待中的前台请求数量 */
    public getPendingCount (): number {
        return this.pending;
    }
}
