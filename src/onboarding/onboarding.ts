import type { Interface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import type { ConfigStore } from '../config/config-store';
import type { ProviderType, ModelConfig } from '../config/types';
import type { SelfcraftPaths } from '../config/paths';
import type { WorkspaceService } from '../workspace/workspace-service';

/** 用户主动取消 onboarding */
export class OnboardingCancelledError extends Error {
    /** 创建稳定的取消错误 */
    constructor () {
        super('初始化已取消');
        this.name = 'OnboardingCancelledError';
    }
}

/** 首次启动与后续 /model add 共用的最小配置流程 */
export class Onboarding {
    /**
     * 创建 onboarding 流程
     *
     * @param paths 当前实例路径
     * @param config 模型配置存储
     * @param workspace 长期工作区
     */
    constructor (
        private readonly paths: SelfcraftPaths,
        private readonly config: ConfigStore,
        private readonly workspace: WorkspaceService,
    ) {}

    /**
     * 完成首次环境、模型和可选身份设置
     *
     * @param terminal readline 接口
     */
    public async run (terminal: Interface): Promise<void> {
        console.log('欢迎使用 Selfcraft。首次启动只配置运行所需的最小信息。');
        console.log(`运行环境: ${this.paths.environment}`);
        console.log(`数据目录: ${this.paths.home}`);
        console.log(`工作区: ${this.paths.workspace}`);
        await this.configureModel(terminal);
        const name = await terminal.question('如何称呼这个智能体？（可留空，稍后在对话中决定）: ');
        const description = await terminal.question('你希望它如何理解你们的关系？（可留空）: ');
        this.workspace.setInitialIdentity(name, description);
        console.log('Onboarding 完成。输入 /help 查看命令。');
    }

    /**
     * 交互式新增模型渠道
     *
     * @param terminal readline 接口
     */
    public async configureModel (terminal: Interface): Promise<void> {
        const providerId = (await terminal.question('渠道名称 [default]: ')).trim() || 'default';
        const rawType = (await terminal.question(
            '请求类型 openai-compatible/openai/anthropic [openai-compatible]: ',
        )).trim() || 'openai-compatible';
        if (!['openai-compatible', 'openai', 'anthropic'].includes(rawType)) {
            throw new Error('不支持的请求类型');
        }
        const type = rawType as ProviderType;
        const baseURL = (await terminal.question(
            type === 'openai-compatible'
                ? 'Base URL: '
                : 'Base URL（留空使用官方地址）: ',
        )).trim() || undefined;
        const apiKey = await this.askSecret(terminal, 'API key: ');
        const rawModels = (await terminal.question('Model ID（多个用逗号分隔）: ')).trim();
        const modelIds = [...new Set(rawModels.split(',').map(value => value.trim()).filter(Boolean))];
        if (modelIds.length === 0) {
            throw new Error('至少需要一个 Model ID');
        }
        const contextWindow = this.parsePositiveInteger(
            await terminal.question('上下文窗口 [128000]: '),
            128000,
        );
        const maxOutputTokens = this.parsePositiveInteger(
            await terminal.question('最大输出 token [8192]: '),
            8192,
        );
        const visionModels = new Set((await terminal.question(
            '支持图片的 Model ID（多个用逗号分隔；无则留空）: ',
        )).split(',').map(value => value.trim()).filter(Boolean));
        const models = Object.fromEntries(modelIds.map(modelId => [
            modelId,
            {
                vision: visionModels.has(modelId),
                contextWindow,
                maxOutputTokens,
            } satisfies ModelConfig,
        ]));
        this.config.addProvider({
            providerId,
            type,
            baseURL,
            apiKey,
            models,
        });
    }

    /**
     * 在 TTY 中隐藏凭证回显
     *
     * @param terminal readline 接口
     * @param prompt 提示文本
     * @returns 输入值
     */
    private async askSecret (terminal: Interface, prompt: string): Promise<string> {
        if (!process.stdin.isTTY) {
            return terminal.question(prompt);
        }
        const mutableTerminal = terminal as Interface & { output?: NodeJS.WritableStream };
        if (!mutableTerminal.output) {
            return terminal.question(prompt);
        }
        const originalOutput = mutableTerminal.output;
        const mutedOutput = new Writable({
            write (_chunk, _encoding, callback) {
                callback();
            },
        });
        const cancellation = new AbortController();
        let interrupted = false;
        const handleInterrupt = () => {
            interrupted = true;
            cancellation.abort();
        };
        process.stdout.write(prompt);
        mutableTerminal.output = mutedOutput;
        terminal.once('SIGINT', handleInterrupt);
        try {
            return await terminal.question('', { signal: cancellation.signal });
        } catch (error) {
            if (interrupted) {
                throw new OnboardingCancelledError();
            }
            throw error;
        } finally {
            terminal.off('SIGINT', handleInterrupt);
            mutableTerminal.output = originalOutput;
            process.stdout.write('\n');
        }
    }

    /** 将空值解析为默认正整数 */
    private parsePositiveInteger (value: string, defaultValue: number): number {
        if (!value.trim()) {
            return defaultValue;
        }
        const number = Number(value);
        if (!Number.isInteger(number) || number <= 0) {
            throw new Error('必须输入正整数');
        }
        return number;
    }
}
