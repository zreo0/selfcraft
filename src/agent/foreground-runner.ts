import type { UserModelMessage } from 'ai';
import { randomUUID } from 'node:crypto';
import type { ExecutionStore } from '../execution/execution-store';
import type { AgentRunOptions, AgentRunResult } from './agent-runtime';
import type { AgentRunEvent } from './run-events';

/** 前台 Agent 需要提供的最小执行接口 */
export interface ForegroundAgent {
    /** 新输入接收后立即中断后台整理 */
    onInputAccepted?(): void;
    /** 执行一轮前台对话 */
    run (
        input: UserModelMessage['content'],
        onEvent?: (event: AgentRunEvent) => void,
        options?: AgentRunOptions,
    ): Promise<AgentRunResult>;
}

/** 在多个通信入口之间串行执行前台对话 */
export class ForegroundRunner {
    private tail: Promise<void> = Promise.resolve();
    private pending = 0;
    private stopping = false;
    private active?: AbortController;

    /**
     * 创建共享前台执行器
     *
     * @param agent 唯一的 Agent Runtime
     */
    constructor (
        private readonly agent: ForegroundAgent,
        private readonly executions?: ExecutionStore,
        private readonly onRestart: () => void = () => undefined,
    ) {}

    /** 启动时恢复已接收的输入；由调用方持久投递完成或失败通知 */
    public recover (onResult: (id: string, error?: unknown, result?: AgentRunResult) => void): void {
        for (const execution of this.executions?.pending() || []) {
            void this.run(execution.input, () => undefined, {
                executionId: execution.id, retry: execution.retry,
            }).then(result => onResult(execution.id, undefined, result), error => onResult(execution.id, error));
        }
    }

    /**
     * 排队执行一轮对话，避免多个入口交错写入同一长期会话
     *
     * @param input 用户输入
     * @param onEvent 统一运行事件回调
     * @param options 取消信号等执行选项
     * @returns Agent 执行结果
     */
    public async run (
        input: UserModelMessage['content'],
        onEvent: (event: AgentRunEvent) => void = () => undefined,
        options: AgentRunOptions = {},
    ): Promise<AgentRunResult> {
        if (this.executions) {
            options = { ...options, executionId: options.executionId || randomUUID(), signal: undefined };
            this.executions.accept(options.executionId!, input, 'foreground', options.retry);
        }
        this.agent.onInputAccepted?.();
        const observer = onEvent;
        onEvent = event => {
            try {
                observer(event);
            } catch {
                // 客户端观察失败不能取消已经接收的责任
            }
        };
        if (this.pending > 0) {
            onEvent({
                type: 'status',
                phase: 'queued',
                label: '正在等待上一轮对话结束',
            });
        }
        this.pending += 1;
        const operation = this.tail.then(async () => {
            if (this.stopping) {
                throw new Error('Runtime 正在停止，输入已保留');
            }
            const controller = new AbortController();
            this.active = controller;
            // 视觉分析可能超过一分钟，前台预算需覆盖主模型、辅助读取与最终回答
            const deadline = this.executions ? setTimeout(() => controller.abort(new Error('前台执行超时，步骤已保留')), 180_000) : undefined;
            const executionOptions = this.executions ? { ...options, signal: controller.signal } : options;
            if (options.signal?.aborted) {
                throw new DOMException('对话已取消', 'AbortError');
            }
            try {
                const result = await this.agent.run(input, onEvent, executionOptions);
                if (result.restartRequired) {
                    // 让调用方先结束响应；重启仍不依赖客户端继续读取
                    setTimeout(this.onRestart, 100);
                }
                return result;
            } catch (error) {
                if (!this.stopping && options.executionId) {
                    const recovered = this.executions?.begin(options.executionId);
                    if (recovered?.status !== 'blocked') {
                        this.executions?.setStatus(options.executionId, 'failed', String(error));
                    }
                }
                throw error;
            } finally {
                clearTimeout(deadline);
                this.active = undefined;
            }
        });
        this.tail = operation.then(() => undefined, () => undefined);
        try {
            return await operation;
        } finally {
            this.pending -= 1;
        }
    }

    /** 停止当前执行与新领取，持久队列留待下一 Runtime 恢复 */
    public stop (): void {
        this.stopping = true;
        this.active?.abort(new Error('Runtime 正在停止'));
    }

    /** 返回正在执行和等待中的前台请求数量 */
    public getPendingCount (): number {
        return this.pending;
    }
}
