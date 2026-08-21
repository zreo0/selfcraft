import { generateText } from 'ai';
import { z } from 'zod';
import type { Logger } from '../logging/logger';
import type { ModelSnapshot } from '../model/model-factory';
import {
    MemoryStore,
    type ReflectionInput,
    type ReflectionJob,
    type ReflectionResult,
} from './memory-store';

const unitScoreSchema = z.preprocess(normalizeUnitScore, z.number().min(0).max(1));

const reflectionSchema = z.object({
    memories: z.array(z.object({
        kind: z.enum(['identity', 'user', 'preference', 'relationship', 'commitment', 'procedure', 'experience']),
        content: z.string().min(4).max(1000),
        confidence: unitScoreSchema,
        importance: unitScoreSchema,
        sensitive: z.boolean(),
    })).max(12),
    growth: z.array(z.object({
        kind: z.enum(['skill', 'runtime']),
        title: z.string().min(4).max(160),
        observation: z.string().min(4).max(1500),
        evidence: z.string().min(4).max(1500),
        confidence: unitScoreSchema,
    })).max(8),
});

const SECRET_PATTERNS = [
    /\b(?:sk|tvly|ghp|github_pat)-[A-Za-z0-9_-]{12,}\b/i,
    /\b(?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*\S+/i,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
];

/** 持久队列驱动的异步反思工作器 */
export class ReflectionWorker {
    private running = false;
    private started = false;
    private timer?: ReturnType<typeof setInterval>;

    /**
     * 创建 Reflection Worker
     *
     * @param store 记忆与 Reflection 存储
     * @param resolveModel 每次处理时解析当前模型
     * @param logger 结构化日志
     */
    constructor (
        private readonly store: MemoryStore,
        private readonly resolveModel: () => ModelSnapshot,
        private readonly logger: Logger,
    ) {}

    /** 恢复中断队列并启动低频轮询 */
    public start (): void {
        if (this.started) {
            return;
        }
        this.started = true;
        this.store.recoverReflections();
        this.timer = setInterval(() => this.kick(), 5000);
        this.timer.unref();
        this.kick();
    }

    /**
     * 持久化一次交互并在后台反思
     *
     * @param input 交互输入、输出和结果
     * @returns Reflection 标识
     */
    public enqueue (input: ReflectionInput): string {
        const id = this.store.enqueueReflection(input);
        this.start();
        this.kick();
        return id;
    }

    /**
     * 等待当前队列空闲，仅用于确定性验收
     *
     * @param timeoutMs 最长等待时间
     */
    public async waitForIdle (timeoutMs = 5000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (this.running && Date.now() < deadline) {
            await Bun.sleep(10);
        }
        if (this.running) {
            throw new Error('Reflection 在期限内未结束');
        }
    }

    /** 停止轮询定时器 */
    public stop (): void {
        if (this.timer) {
            clearInterval(this.timer);
        }
        this.timer = undefined;
        this.started = false;
    }

    /** 非阻塞地触发单工作器排空队列 */
    private kick (): void {
        if (this.running) {
            return;
        }
        this.running = true;
        void this.drain().finally(() => {
            this.running = false;
        });
    }

    /** 顺序处理 Reflection，避免后台反思抢占过多模型并发 */
    private async drain (): Promise<void> {
        while (true) {
            const job = this.store.claimReflection();
            if (!job) {
                return;
            }
            let responseText = '';
            try {
                const active = this.resolveModel();
                const response = await generateText({
                    model: active.model,
                    instructions: buildReflectionInstructions(),
                    prompt: renderInteraction(job),
                    maxOutputTokens: Math.min(active.maxOutputTokens, 2500),
                });
                responseText = response.text;
                const parsed = parseReflection(responseText);
                this.store.completeReflection(job.id, protectSecrets(parsed));
                this.logger.info('Reflection completed', {
                    reflectionId: job.id,
                    providerId: active.providerId,
                    modelId: active.modelId,
                    memories: parsed.memories.length,
                    growth: parsed.growth.length,
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.store.failReflection(job.id, message, responseText);
                this.logger.warn('Reflection failed', {
                    reflectionId: job.id,
                    attempts: job.attempts,
                    error: message,
                });
            }
        }
    }
}

/** 生成不依赖 provider structuredOutputs 的 JSON 反思指令 */
function buildReflectionInstructions (): string {
    return [
        '你是个人智能体的 Reflection 程序，只做事实提取和成长证据累积。',
        '仅返回一个 JSON 对象，不要 Markdown 代码块或解释。',
        'JSON 格式：{"memories":[],"growth":[]}。',
        'memories 元素包含 kind、content、confidence、importance、sensitive。',
        'confidence 和 importance 应使用 0 到 1 的 JSON 数字，例如 0.8，不要写成文字描述。',
        'kind 只能是 identity/user/preference/relationship/commitment/procedure/experience。',
        '只保留未来交互仍有用的稳定事实、承诺、偏好或可复用经验；不要记录寒暄、临时结果或未证实推测。',
        '凭证、密钥、令牌、密码和高度私密原文必须 sensitive=true，且不要在 content 复制原值。',
        'growth 元素包含 kind、title、observation、evidence、confidence，kind 只能是 skill 或 runtime。',
        '只有可复现的失败、反复需要的工作流或明确的底层缺陷才是成长候选。',
        'Reflection 只产生候选，不宣称已经创建技能或修改 Runtime。',
    ].join('\n');
}

/** 渲染有界的交互文本 */
function renderInteraction (input: ReflectionJob): string {
    const text = [
        `session: ${input.sessionId}`,
        `outcome: ${input.outcome}`,
        `input:\n${input.input}`,
        `output:\n${input.output}`,
        ...(input.error ? [`error:\n${input.error}`] : []),
        ...(input.previousOutput ? [
            'previous-invalid-reflection-output:',
            input.previousOutput,
        ] : []),
        ...(input.previousError ? [
            'previous-reflection-validation-error:',
            input.previousError,
            '修复上一次输出的格式错误，不要仅为了通过校验而删除原本有效的候选。',
        ] : []),
    ].join('\n\n');
    if (text.length <= 30000) {
        return text;
    }
    return `${text.slice(0, 22000)}\n\n[content truncated]\n\n${text.slice(-8000)}`;
}

/** 只将明确数字或百分比字符串转为 0 到 1 分数 */
function normalizeUnitScore (value: unknown): unknown {
    if (typeof value !== 'string') {
        return value;
    }
    const normalized = value.trim();
    if (/^(?:\d+(?:\.\d+)?|\.\d+)%$/.test(normalized)) {
        return Number(normalized.slice(0, -1)) / 100;
    }
    if (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) {
        return Number(normalized);
    }
    return value;
}

/** 从纯文本中解析并验证 Reflection JSON */
function parseReflection (text: string): ReflectionResult {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) {
        throw new Error('Reflection 未返回 JSON 对象');
    }
    let value: unknown;
    try {
        value = JSON.parse(text.slice(start, end + 1));
    } catch (error) {
        throw new Error(`Reflection JSON 无法解析: ${error instanceof Error ? error.message : String(error)}`);
    }
    return reflectionSchema.parse(value);
}

/** 使用确定性规则阻止模型漏标的凭证进入记忆 */
function protectSecrets (result: ReflectionResult): ReflectionResult {
    return {
        ...result,
        memories: result.memories.map(memory => ({
            ...memory,
            sensitive: memory.sensitive || SECRET_PATTERNS.some(pattern => pattern.test(memory.content)),
        })),
    };
}
