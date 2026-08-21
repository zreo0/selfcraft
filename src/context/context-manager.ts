import { generateText, type LanguageModel, type ModelMessage } from 'ai';
import type { SessionSnapshot } from '../session/session-store';

/** 为长期会话提供有界上下文和可持久摘要 */
export class ContextManager {
    /**
     * 判断并压缩过长历史
     *
     * @param snapshot 当前会话
     * @param model 摘要使用的模型
     * @param contextWindow 当前上下文窗口
     * @param reservedContext 身份、记忆、技能和工具需要预留的上下文
     * @returns 是否压缩及新快照
     */
    public async compactIfNeeded (
        snapshot: SessionSnapshot,
        model: LanguageModel,
        contextWindow: number,
        reservedContext = '',
    ): Promise<{ compacted: boolean, snapshot: SessionSnapshot }> {
        const estimatedTokens = this.estimate(snapshot.summary)
            + this.estimate(reservedContext)
            + this.estimateMessages(snapshot.messages);
        if (estimatedTokens < contextWindow * 0.6 || snapshot.messages.length < 16) {
            return { compacted: false, snapshot };
        }

        const keepFrom = this.findRecentBoundary(snapshot.messages);
        const olderMessages = snapshot.messages.slice(0, keepFrom);
        const recentMessages = snapshot.messages.slice(keepFrom);
        const result = await generateText({
            model,
            instructions: [
                '你负责压缩一段长期个人助理会话。',
                '保留事实、决定、承诺、偏好、未完成事项、重要原因和可追溯的工具结果。',
                '将已有摘要和新历史改写成一份新摘要，不要无限追加。',
                '不要添加原文中没有的信息，不要把会话摘要冒充长期记忆，使用紧凑 Markdown。',
            ].join('\n'),
            prompt: `已有摘要：\n${snapshot.summary || '无'}\n\n待压缩消息：\n${this.renderMessages(olderMessages)}`,
            maxOutputTokens: Math.min(2500, Math.max(800, Math.floor(contextWindow * 0.025))),
        });
        return {
            compacted: true,
            snapshot: {
                summary: result.text.trim(),
                messages: recentMessages,
            },
        };
    }

    /**
     * 在 provider 拒绝过长请求时保留最近完整交互
     *
     * @param snapshot 当前上下文
     * @param contextWindow 模型窗口
     * @param reservedContext 非会话提示内容
     * @returns 可用于单次重试的紧急快照
     */
    public recoverFromOverflow (
        snapshot: SessionSnapshot,
        contextWindow: number,
        reservedContext = '',
    ): SessionSnapshot {
        const budget = Math.max(1000, Math.floor(contextWindow * 0.52)
            - this.estimate(snapshot.summary)
            - this.estimate(reservedContext));
        const userBoundaries = snapshot.messages
            .map((message, index) => message.role === 'user' ? index : -1)
            .filter(index => index >= 0);
        for (const index of userBoundaries) {
            const candidate = snapshot.messages.slice(index);
            if (this.estimateMessages(candidate) <= budget) {
                return { summary: snapshot.summary, messages: candidate };
            }
        }
        const lastUser = userBoundaries.at(-1);
        return {
            summary: snapshot.summary,
            messages: lastUser === undefined ? snapshot.messages.slice(-1) : snapshot.messages.slice(lastUser),
        };
    }

    /**
     * 判断 provider 错误是否属于上下文溢出
     *
     * @param error 模型请求错误
     * @returns 是否值得紧急裁剪后重试
     */
    public isOverflowError (error: unknown): boolean {
        const message = error instanceof Error ? error.message : String(error);
        return /context(?:_|\s|-)*(?:length|window)|maximum context|too many tokens|prompt is too long/i.test(message);
    }

    /** 以字符数保守近似 token，中文不再按三字符一 token 低估 */
    private estimate (value: string): number {
        return Math.ceil(value.length / 2);
    }

    /** 估算标准消息的序列化体积 */
    private estimateMessages (messages: ModelMessage[]): number {
        return messages.reduce((total, message) => total + this.estimate(JSON.stringify(message)), 0);
    }

    /** 保留约四成最新消息，并尽量从 user 消息开始 */
    private findRecentBoundary (messages: ModelMessage[]): number {
        const target = Math.max(1, Math.floor(messages.length * 0.6));
        for (let index = target; index < messages.length; index += 1) {
            if (messages[index].role === 'user') {
                return index;
            }
        }
        return target;
    }

    /** 将模型消息转为有界的摘要输入 */
    private renderMessages (messages: ModelMessage[]): string {
        return messages.map(message => {
            const serialized = JSON.stringify(message.content);
            const content = serialized.length <= 4000
                ? serialized
                : `${serialized.slice(0, 3000)}...[message truncated]...${serialized.slice(-1000)}`;
            return `${message.role}: ${content}`;
        }).join('\n');
    }
}
