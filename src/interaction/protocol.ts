import { z } from 'zod';
import { createLibrary, createParser, defineComponent } from '@openuidev/lang-core';

/** 跨端交互协议和组件版本 */
export const UI_PROTOCOL = 1;
export const UI_LIBRARY = 'selfcraft-ui@1';
const name = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const label = z.string().trim().min(1).max(200);
const option = z.object({ value: name, label, description: z.string().max(1000) });
const choices = z.object({ name, label, required: z.boolean(), options: z.array(option).min(2).max(12) });
const answer = z.object({ name, label, required: z.boolean() });
const Choice = defineComponent({ name: 'Choice', description: '单选字段，选项含 value、label、description', props: choices, component: null });
const Multiple = defineComponent({ name: 'Multiple', description: '多选字段', props: choices.extend({}), component: null });
const Answer = defineComponent({ name: 'Answer', description: '最多 2000 字的补充说明', props: answer, component: null });
const Form = defineComponent({ name: 'Form', description: '一个需要用户回答的澄清或方案选择表单', component: null,
    props: z.object({ kind: z.enum(['clarification', 'selection']), title: label, description: z.string().max(2000),
        fields: z.array(z.union([Choice.ref, Multiple.ref, Answer.ref])).min(1).max(10) }) });
/** 同一份组件契约生成模型提示、服务端验证和 Web 组件定义 */
export const uiLibrary = createLibrary({ root: 'Form', components: [Form, Choice, Multiple, Answer] });

/** 各端使用的静态字段，不携带执行代码 */
export interface InteractionField {
    /** 稳定字段名 */
    name: string;
    /** 原生控件种类 */
    type: 'single-select' | 'multi-select' | 'text';
    /** 用户可读标签 */
    label: string;
    /** 提交是否必填 */
    required: boolean;
    /** 选择字段的稳定值与说明 */
    options?: Array<{ value: string; label: string; description: string }>;
}
/** 原生客户端和服务端共享的表单语义 */
export interface Interaction {
    /** 场景 */
    kind: 'clarification' | 'selection';
    /** 标题 */
    title: string;
    /** 说明 */
    description: string;
    /** 按显示顺序排列的字段 */
    fields: InteractionField[];
    /** 首期只提供一次性提交 */
    actions: Array<{ id: 'submit'; label: string }>;
}
/** 已确认的字段值，不使用 OpenUI 内部状态结构 */
export type InteractionValues = Record<string, string | string[]>;
/** 消息中的持久 UI 快照 */
export interface InteractionView {
    /** 稳定标识 */
    id: string;
    /** 语义版本 */
    protocolVersion: number;
    /** 组件版本 */
    libraryVersion: string;
    /** 乐观并发版本 */
    revision: number;
    /** 是否仍可提交 */
    status: 'ready' | 'submitted' | 'closed';
    /** 校验过的静态源码 */
    source: string;
    /** 跨端交互描述 */
    interaction: Interaction;
    /** 已保存字段值 */
    values: InteractionValues;
    /** 已接收提交 */
    submissionId: string | null;
}
/** 可安全呈现的协议失败 */
export class InteractionError extends Error {
    /** 根据 HTTP 状态和说明构造错误 */
    constructor (public status: number, message: string) { super(message); }
}
/** 解析受限静态 OpenUI，返回唯一的跨端交互描述 */
export function parseInteraction (source: string): Interaction {
    if (!source || source.length > 32_000) throw new InteractionError(422, '交互源码为空或过长');
    // 字符串以外禁止表达式、状态和工具，三端只解释相同的静态字段
    const syntax = source.replace(/"(?:\\.|[^"\\])*"/g, '""');
    if (/[$@?+*/<>!]|\b(?:Query|Mutation|Action)\s*\(/.test(syntax)) throw new InteractionError(422, '交互只允许静态表单');
    let nesting = 0;
    for (const character of syntax) {
        if ('([{'.includes(character) && ++nesting > 32) throw new InteractionError(422, '交互嵌套过深');
        if (')]}'.includes(character)) nesting--;
    }
    const parsed = createParser(uiLibrary.toJSONSchema(), 'Form').parse(source);
    if (!parsed.root || parsed.root.typeName !== 'Form' || parsed.meta.incomplete || parsed.meta.errors.length
        || parsed.meta.unresolved.length || parsed.meta.orphaned.length || parsed.queryStatements.length
        || parsed.mutationStatements.length || Object.keys(parsed.stateDeclarations).length || parsed.root.hasDynamicProps) {
        throw new InteractionError(422, '交互结构不完整或包含不支持的内容');
    }
    const props = z.object({ kind: z.enum(['clarification', 'selection']), title: label,
        description: z.string().max(2000), fields: z.array(z.object({ typeName: z.string(), props: z.unknown(), hasDynamicProps: z.boolean().optional() })).min(1).max(10) }).parse(parsed.root.props);
    const fields = (props.fields as Array<{ typeName: string; props: unknown; hasDynamicProps?: boolean }>).map(node => {
        if (node.hasDynamicProps) throw new InteractionError(422, '字段不能包含动态表达式');
        const type = node.typeName === 'Choice' ? 'single-select' : node.typeName === 'Multiple' ? 'multi-select' : 'text';
        if (!['Choice', 'Multiple', 'Answer'].includes(node.typeName)) throw new InteractionError(422, '不支持的字段');
        const field = { ...(type === 'text' ? answer.parse(node.props) : choices.parse(node.props)), type } as InteractionField;
        if (field.options && new Set(field.options.map(item => item.value)).size !== field.options.length) {
            throw new InteractionError(422, '选项值不能重复');
        }
        return { ...field, type } as InteractionField;
    });
    if (new Set(fields.map(field => field.name)).size !== fields.length) throw new InteractionError(422, '字段名不能重复');
    return { kind: props.kind as Interaction['kind'], title: String(props.title), description: String(props.description), fields,
        actions: [{ id: 'submit', label: '提交回答' }] };
}
/** 校验并规范化草稿或提交，固定字段与多选顺序用于幂等比较 */
export function normalizeValues (interaction: Interaction, input: unknown, complete: boolean): InteractionValues {
    const result: InteractionValues = {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InteractionError(422, '字段值格式无效');
    const values = input as Record<string, unknown>;
    if (Object.keys(values).some(key => !interaction.fields.some(field => field.name === key))) throw new InteractionError(422, '包含未知字段');
    for (const field of interaction.fields) {
        const raw = values[field.name] ?? (field.type === 'multi-select' ? [] : '');
        if (field.type === 'multi-select') {
            if (!Array.isArray(raw) || raw.length > 12 || raw.some(value => typeof value !== 'string' || !field.options?.some(option => option.value === value))) {
                throw new InteractionError(422, `${field.label}的选项无效`);
            }
            result[field.name] = field.options!.filter(option => raw.includes(option.value)).map(option => option.value);
        } else {
            if (typeof raw !== 'string' || raw.length > 2000) throw new InteractionError(422, `${field.label}的内容无效`);
            if (field.type === 'single-select' && raw && !field.options?.some(option => option.value === raw)) throw new InteractionError(422, `${field.label}的选项无效`);
            result[field.name] = raw.trim();
        }
        if (complete && field.required && !result[field.name]!.length) throw new InteractionError(422, `请填写${field.label}`);
    }
    return result;
}
/** 生成旧客户端也能独立理解的文字，不包含 OpenUI 源码 */
export function interactionText (interaction: Interaction): string {
    return [interaction.title, interaction.description, ...interaction.fields.map(field => `${field.label}${field.required ? '（必填）' : ''}${field.options
        ? '\n' + field.options.map((option, index) => `${index + 1}. ${option.label}${option.description ? '：' + option.description : ''}`).join('\n') : ''}`),
    '可以填写交互表单，也可以直接用文字回答。'].filter(Boolean).join('\n\n');
}
