import { tool } from 'ai';
import { z } from 'zod';
import { uiLibrary } from '../interaction/protocol';
import type { InteractionStore } from '../interaction/interaction-store';
import type { ConversationStore } from '../conversation/conversation-store';
import type { ToolRuntimeContext } from './index';

/** 创建可选的静态澄清表单工具，返回已持久交付的 UI 标识 */
export function createInteractionTool (store: InteractionStore, conversation: ConversationStore) {
    return tool({
        description: '仅在需要用户选择方案或填写澄清问题时展示表单；正常回答使用文字。不等待用户也不冒充用户提交。\n' + uiLibrary.prompt({
            toolCalls: false, bindings: false, builtinFunctions: false,
            additionalRules: ['只允许静态 Form、Choice、Multiple、Answer，所有字段名称使用小写英文，选项说明没有内容时写空字符串',
                '示例：root = Form("clarification", "选择目标", "请选择", [Choice("goal", "目标", true, [{value:"speed",label:"速度",description:"尽快完成"},{value:"quality",label:"质量",description:"充分验证"}])])'],
        }),
        inputSchema: z.object({ source: z.string().min(1).max(32_000) }),
        execute: async ({ source }, options) => {
            const context = options.context as ToolRuntimeContext;
            if (context.channel !== 'foreground') return { error: '后台任务不能创建交互表单' };
            try {
                const view = store.present(context.runId, options.toolCallId, source);
                store.reconcile(conversation);
                return { uiId: view.id, message: '表单已交付，用户可在 Web、CLI 或 iOS 回答，无需重复列出整张表单' };
            } catch {
                return { error: '交互未完成，请检查静态组件结构，或改用普通文字提问' };
            }
        },
    });
}
