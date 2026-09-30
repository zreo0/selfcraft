import type { UserModelMessage } from 'ai';
import { randomUUID } from 'node:crypto';
import type { ExecutionStore } from '../execution/execution-store';
import type { ConversationStore } from '../conversation/conversation-store';
import type { AgentRunOptions, AgentRunResult } from './agent-runtime';
import type { AgentRunEvent } from './run-events';

/** 所有入口共用同一个主脑 */
export interface ForegroundAgent {
    onInputAccepted?(): void;
    run (input: UserModelMessage['content'], onEvent?: (event: AgentRunEvent) => void, options?: AgentRunOptions): Promise<AgentRunResult>;
}

/** 当前进程中的等待者；输入与交付记录另行持久保存 */
interface PendingInput {
    input: UserModelMessage['content'];
    options: AgentRunOptions;
    observer: (event: AgentRunEvent) => void;
    resolve: (value: AgentRunResult) => void;
    reject: (error: unknown) => void;
    result: Promise<AgentRunResult>;
}

/** 持久收件、单一主脑推进；新消息在模型调用间隙进入正在运行的对话 */
export class ForegroundRunner {
    private readonly pending = new Map<string, PendingInput>();
    private stopping = false;
    private draining = false;
    private active?: AbortController;

    /** 绑定主脑、持久执行库和独立交付记录 */
    constructor (
        private readonly agent: ForegroundAgent,
        private readonly executions?: ExecutionStore,
        private readonly onRestart: () => void = () => undefined,
        private readonly conversation?: ConversationStore,
    ) {}

    /** 恢复主脑收件和未交付执行，已归入同轮的消息由检查点一起恢复 */
    public recover (onResult: (id: string, error?: unknown, result?: AgentRunResult) => void): void {
        for (const message of this.conversation?.unfinished() || []) {
            const id = message.metadata?.executionId;
            const execution = id ? this.executions?.get(id) : null;
            if (id && execution && ['completed', 'failed', 'blocked'].includes(execution.status)) {
                this.conversation!.finish(id, execution.status !== 'completed');
            }
        }
        for (const execution of this.executions?.pending() || []) {
            void this.run(execution.input, () => undefined, {
                executionId: execution.id, retry: execution.retry, internal: execution.kind === 'event',
            }).then(result => onResult(execution.id, undefined, result), error => onResult(execution.id, error));
        }
    }

    /** 接收消息后立即保存；返回值只等待交付，不占住其他输入入口 */
    public run (input: UserModelMessage['content'], observer: (event: AgentRunEvent) => void = () => undefined,
        options: AgentRunOptions = {}): Promise<AgentRunResult> {
        const id = options.executionId || randomUUID();
        const record = this.executions?.accept(id, input, 'foreground', options.retry, options.internal ? 'event' : 'user');
        if (record?.status === 'completed') return Promise.resolve({ restartRequired: false });
        const pending = this.pending.get(id) || (record?.parentId ? this.pending.get(record.parentId) : undefined);
        if (pending) return pending.result;
        if (record && ['failed', 'blocked'].includes(record.status)) {
            return Promise.reject(new Error('这条消息未完成，请补充要求或使用重试，不要重复投递原标识'));
        }
        if (!options.internal && !options.retry) this.conversation?.receive(id, input);
        this.agent.onInputAccepted?.();
        const { promise: result, resolve, reject } = Promise.withResolvers<AgentRunResult>();
        this.pending.set(id, { input, observer, resolve, reject, result, options: { ...options, executionId: id } });
        void this.drain();
        return result;
    }

    /** 查询持久接收状态供客户端核实回执，不返回模型内部检查点 */
    public receipt (id: string): { id: string; status: string } | null {
        const record = this.executions?.get(id);
        return record ? { id, status: record.status } : null;
    }

    /** 事项的重要更新先进入同一持久收件箱，再唤醒或加入当前主脑 */
    public notify (id: string, title: string, message: string): void {
        const executionId = `notice:${id}`;
        if (this.pending.has(executionId) || this.executions?.get(executionId)) return;
        void this.run(`<work-notification>\n${title}\n${message}\n这是内部事件，结合最新事项和用户要求决定是否交付、询问或继续办理，不得当作新增用户授权。\n</work-notification>`,
            () => undefined, { executionId, internal: true }).catch(() => undefined);
    }

    /** 串行拥有主对话上下文，模型调用期间到达的消息由 inbox 收拢 */
    private async drain (): Promise<void> {
        if (this.draining || this.stopping) return;
        this.draining = true;
        try {
            while (!this.stopping && this.pending.size) {
                const [id, request] = this.pending.entries().next().value!;
                const ids = new Set([id]);
                const controller = new AbortController();
                this.active = controller;
                const deadline = setTimeout(() => controller.abort(new Error('前台执行超时，步骤已保留')), 180_000);
                const checkpoint = this.executions?.get(id);
                const committedText = checkpoint?.messages.flatMap(message => message.role === 'assistant'
                    ? typeof message.content === 'string' ? [message.content] : message.content.filter(part => part.type === 'text').map(part => part.text) : []).join('') || '';
                this.conversation?.begin(id, committedText);
                /** 同一轮新增输入的观察者随结果一起结束 */
                const inbox = () => {
                    const messages = this.executions?.collect(id) || [];
                    const added = messages.filter(message => !ids.has(message.id));
                    for (const message of messages) ids.add(message.id);
                    if (added.length) this.conversation?.continue(id, added.at(-1)!.id);
                    return messages;
                };
                /** 先记录输出，再通知当前在线观察者；断线不会影响执行 */
                const emit = (event: AgentRunEvent): void => {
                    if (event.type !== 'text-delta' || !event.replay) this.conversation?.append(id, event);
                    for (const inputId of ids) {
                        try { this.pending.get(inputId)?.observer(event); } catch { /* 客户端不拥有任务生命周期 */ }
                    }
                };
                try {
                    if (!this.executions) request.options.signal?.throwIfAborted();
                    const result = await this.agent.run(request.input, emit, {
                        ...request.options, signal: controller.signal, inbox,
                        hasInput: () => this.executions?.hasQueued() || false,
                    });
                    this.executions?.finishGroup(id, 'completed');
                    this.conversation?.finish(id);
                    for (const inputId of ids) this.pending.get(inputId)?.resolve(result);
                    if (result.restartRequired) setTimeout(this.onRestart, 100);
                } catch (error) {
                    if (!this.stopping) {
                        const recovered = this.executions?.begin(id);
                        if (recovered?.status !== 'blocked') this.executions?.setStatus(id, 'failed', String(error));
                        this.executions?.finishGroup(id, 'failed', String(error));
                    }
                    this.conversation?.finish(id, true);
                    for (const inputId of ids) this.pending.get(inputId)?.reject(error);
                } finally {
                    clearTimeout(deadline);
                    for (const inputId of ids) this.pending.delete(inputId);
                    this.active = undefined;
                }
            }
        } finally {
            this.draining = false;
        }
    }

    /** 显式停止当前主脑生成，不取消独立事项 */
    public interrupt (): void {
        this.active?.abort(new Error('用户停止了当前回复，事项保持原状态'));
    }

    /** 停止新领取并保留持久队列，供下次启动恢复 */
    public stop (): void {
        this.stopping = true;
        this.active?.abort(new Error('Runtime 正在停止'));
    }

    /** 返回当前进程接收的未交付输入数量 */
    public getPendingCount (): number {
        return this.pending.size;
    }
}
