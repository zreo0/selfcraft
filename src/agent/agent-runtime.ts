import { isStepCount, ToolLoopAgent, type ModelMessage } from 'ai';
import type { ConfigStore } from '../config/config-store';
import type { ContextManager } from '../context/context-manager';
import type { EvolutionService } from '../evolution/evolution-service';
import type { AgentJobPayload, JobRecord } from '../job/job-manager';
import type { Logger } from '../logging/logger';
import type { MemoryStore } from '../memory/memory-store';
import type { ReflectionWorker } from '../memory/reflection-worker';
import { ModelFactory, type ModelSnapshot } from '../model/model-factory';
import type { SessionStore } from '../session/session-store';
import type { SkillRegistry } from '../skills/skill-registry';
import type { WorkspaceService } from '../workspace/workspace-service';

/** Selfcraft 的最小 Agent 循环 */
export class AgentRuntime {
    /**
     * 创建 Agent Runtime
     *
     * @param config 模型配置
     * @param workspace 长期工作区
     * @param skills 动态技能注册表
     * @param session 长期会话
     * @param context 上下文压缩器
     * @param evolution 自我修改服务
     * @param memory 结构化长期记忆
     * @param reflection 异步反思队列
     * @param tools 本轮可用工具
     * @param logger 结构化日志
     * @param resolveModel 模型解析函数，测试可注入确定性模型
     */
    constructor (
        private readonly config: ConfigStore,
        private readonly workspace: WorkspaceService,
        private readonly skills: SkillRegistry,
        private readonly session: SessionStore,
        private readonly context: ContextManager,
        private readonly evolution: EvolutionService,
        private readonly memory: MemoryStore,
        private readonly reflection: Pick<ReflectionWorker, 'enqueue'>,
        private readonly tools: Record<string, any>,
        private readonly logger: Logger,
        private readonly resolveModel: () => ModelSnapshot = () => ModelFactory.create(this.config),
    ) {}

    /**
     * 执行一轮对话并流式返回文本
     *
     * @param input 用户输入
     * @param onText 文本增量回调
     * @param onStatus 工具执行状态回调
     * @returns 是否需要 Supervisor 重启
     */
    public async run (
        input: string,
        onText: (text: string) => void,
        onStatus: (status: string) => void = () => undefined,
    ): Promise<{ restartRequired: boolean }> {
        const active = this.resolveModel();
        let snapshot = this.session.load();
        const reservedContext = this.buildInstructions('', input);
        try {
            const compacted = await this.context.compactIfNeeded(
                snapshot,
                active.model,
                active.contextWindow,
                reservedContext,
            );
            if (compacted.compacted) {
                snapshot = compacted.snapshot;
                this.session.replace(snapshot.summary, snapshot.messages);
                this.logger.info('长期会话已压缩', { retainedMessages: snapshot.messages.length });
            }
        } catch (error) {
            this.logger.warn('会话摘要生成失败，保留原上下文继续', {
                error: error instanceof Error ? error.message : String(error),
            });
        }
        const userMessage: ModelMessage = { role: 'user', content: input };
        this.session.append(userMessage);
        let messages = [...snapshot.messages, userMessage];
        const instructions = this.buildInstructions(snapshot.summary, input);
        this.logger.info('Agent run started', {
            providerId: active.providerId,
            modelId: active.modelId,
            historyMessages: snapshot.messages.length,
        });
        try {
            let execution;
            try {
                execution = await this.executeAgent('selfcraft-main', active, instructions, messages, onText, onStatus);
            } catch (error) {
                if (!this.context.isOverflowError(error)) {
                    throw error;
                }
                const recovered = this.context.recoverFromOverflow(
                    { summary: snapshot.summary, messages },
                    active.contextWindow,
                    reservedContext,
                );
                messages = recovered.messages;
                this.session.replace(recovered.summary, recovered.messages);
                this.logger.warn('模型拒绝过长上下文，已紧急裁剪并重试', {
                    retainedMessages: recovered.messages.length,
                });
                execution = await this.executeAgent(
                    'selfcraft-main-recovery',
                    active,
                    this.buildInstructions(recovered.summary, input),
                    recovered.messages,
                    onText,
                    onStatus,
                );
            }
            this.session.append(...execution.responseMessages);
            this.enqueueReflection({
                sessionId: 'main',
                input,
                output: this.renderReflectionOutput(execution.text, execution.responseMessages),
                outcome: 'completed',
            });
            this.logger.info('Agent run completed', {
                providerId: active.providerId,
                modelId: active.modelId,
                responseMessages: execution.responseMessages.length,
            });
            return { restartRequired: this.evolution.hasPendingRelease() };
        } catch (error) {
            this.enqueueReflection({
                sessionId: 'main',
                input,
                output: '',
                outcome: 'failed',
                error: error instanceof Error ? error.message : String(error),
            });
            this.logger.error('Agent run failed', {
                providerId: active.providerId,
                modelId: active.modelId,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    /**
     * 使用与前台相同的 Agent Loop 执行隔离的后台任务
     *
     * @param job 持久后台任务
     * @param signal 取消信号
     * @param onLog 日志增量回调
     * @returns 后台 Agent 最终文本
     */
    public async runBackground (
        job: JobRecord,
        signal: AbortSignal,
        onLog: (text: string) => void,
    ): Promise<string> {
        const active = this.resolveModel();
        const prompt = (job.payload as AgentJobPayload).prompt;
        const instructions = [
            this.buildInstructions('', prompt),
            '',
            '<background-job>',
            `job-id: ${job.id}`,
            `title: ${job.title}`,
            '这是独立后台任务。持续执行到可验证终点，把重要进度和最终结果写入输出。',
            '</background-job>',
        ].join('\n');
        try {
            const execution = await this.executeAgent(
                `selfcraft-job-${job.id}`,
                active,
                instructions,
                [{ role: 'user', content: prompt }],
                onLog,
                status => onLog(`\n[${status}]\n`),
                signal,
            );
            this.enqueueReflection({
                sessionId: `job:${job.id}`,
                input: prompt,
                output: this.renderReflectionOutput(execution.text, execution.responseMessages),
                outcome: 'completed',
            });
            return execution.text;
        } catch (error) {
            this.enqueueReflection({
                sessionId: `job:${job.id}`,
                input: prompt,
                output: '',
                outcome: 'failed',
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    /** 组装稳定原则、当前身份、记忆、会话摘要与技能目录 */
    private buildInstructions (summary: string, query: string): string {
        return [
            '# Selfcraft Runtime',
            '你是一个持续存在于独立环境中的个人智能体。你的名字、人格和关系由用户与经历决定，不要从项目名推断身份。',
            '首要目标是理解意图并尽可能完成任务。工具调用不需要逐步申请批准。',
            '文件工具只访问 workspace。Shell 保留完整能力，但不要执行会破坏宿主机、泄露凭证或冒充用户对外表态的操作。',
            '能在当前轮次快速完成的操作直接使用工具；只有需要长时间运行、可独立进行或不应阻塞用户的工作才用 job_start。',
            '后台任务不需要用户逐步批准；创建后立即告知任务 ID，完成或失败由通知汇报。',
            '技能是工作区中可持续修改的能力说明。使用技能前调用 read_skill；需要新能力时可以创建或改进 skills/<name>/SKILL.md。',
            '只有在发现可复现的 Runtime 缺陷、明确收益并能提供完整测试时，才用 runtime_files、runtime_read 检查当前实现，再使用 evolve_runtime 修改自身代码。',
            'Reflection 会在对话后异步提取记忆和成长候选。用户明确说“记住”时使用 memory_remember，要求忘记时使用 memory_forget。',
            'USER.md、MEMORY.md 和 IDENTITY.md 是人和 Agent 可共同编辑的策展文档，结构化记忆才是可追溯的持久事实层。',
            '成长候选只是观察证据。改进技能或 Runtime 前要检查实际问题；完成验证后再用 growth_resolve 标记结果。',
            '',
            this.workspace.readCoreContext(),
            '',
            this.memory.buildContext(query),
            '',
            '<conversation-summary>',
            summary || '尚无早期会话摘要',
            '</conversation-summary>',
            '',
            '<available-skills>',
            this.skills.buildCatalog(),
            '</available-skills>',
        ].join('\n');
    }

    /** 执行一次可复用的 AI SDK 工具循环 */
    private async executeAgent (
        id: string,
        active: ModelSnapshot,
        instructions: string,
        messages: ModelMessage[],
        onText: (text: string) => void,
        onStatus: (status: string) => void,
        abortSignal?: AbortSignal,
    ): Promise<{ text: string, responseMessages: ModelMessage[] }> {
        const agent = new ToolLoopAgent({
            id,
            model: active.model,
            instructions,
            tools: this.tools,
            stopWhen: isStepCount(this.config.read().maxSteps),
            maxOutputTokens: active.maxOutputTokens,
        });
        const result = await agent.stream({
            messages,
            abortSignal,
            onToolExecutionStart: ({ toolCall }) => {
                this.logger.info('Tool execution started', { toolName: toolCall.toolName });
                onStatus(`使用工具 ${toolCall.toolName}`);
            },
            onStepEnd: ({ toolCalls, usage }) => {
                this.logger.info('Agent step finished', {
                    providerId: active.providerId,
                    modelId: active.modelId,
                    tools: toolCalls.map(call => call.toolName),
                    tokens: usage.totalTokens,
                });
            },
        });
        let text = '';
        for await (const delta of result.textStream) {
            text += delta;
            onText(delta);
        }
        return {
            text,
            responseMessages: await result.responseMessages,
        };
    }

    /** 保证 Reflection 存储故障不影响用户的前台回复 */
    private enqueueReflection (input: Parameters<ReflectionWorker['enqueue']>[0]): void {
        try {
            this.reflection.enqueue(input);
        } catch (error) {
            this.logger.warn('无法创建 Reflection', {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    /** 为 Reflection 提供最终回复和有界工具成败证据 */
    private renderReflectionOutput (text: string, messages: ModelMessage[]): string {
        const events: string[] = [];
        for (const message of messages) {
            if (!Array.isArray(message.content)) {
                continue;
            }
            for (const rawPart of message.content) {
                const part = rawPart as any;
                if (part.type === 'tool-call') {
                    events.push(`[tool-call] ${part.toolName || 'unknown'}`);
                }
                if (part.type === 'tool-result') {
                    const serialized = JSON.stringify(part.output ?? part.result ?? '');
                    events.push(`[tool-result] ${part.toolName || 'unknown'}: ${redactReflectionText(serialized).slice(0, 800)}`);
                }
            }
        }
        return [
            `final-response:\n${text}`,
            ...(events.length > 0 ? [`tool-events:\n${events.slice(0, 20).join('\n')}`] : []),
        ].join('\n\n');
    }
}

/** 在反思输入中遮盖常见凭证形态 */
function redactReflectionText (value: string): string {
    return value
        .replace(/\b(?:sk|tvly|ghp|github_pat)-[A-Za-z0-9_-]{12,}\b/gi, '[REDACTED]')
        .replace(/((?:api[_-]?key|access[_-]?token|password)["'\s]*[:=]["'\s]*)[^,"'\s}]+/gi, '$1[REDACTED]');
}
