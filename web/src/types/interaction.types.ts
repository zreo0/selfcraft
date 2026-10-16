/** 共享协议只以类型形式进入客户端，避免导入 Runtime 实现 */
export type { Interaction, InteractionField, InteractionValues, InteractionView } from '@interaction/protocol';
/** 等待回执的用户提交，必须复用原标识 */
export interface InteractionSubmission {
    submissionId: string;
    expectedRevision: number;
    actionId: 'submit';
    values: import('./interaction.types').InteractionValues;
}

/** 未知数据部分仅在具备交互快照形状时进入专用组件 */
export function isInteractionView (value: unknown): value is import('@interaction/protocol').InteractionView {
    if (!value || typeof value !== 'object') return false;
    const view = value as import('@interaction/protocol').InteractionView;
    return typeof view.id === 'string' && typeof view.source === 'string' && Number.isInteger(view.revision)
        && Boolean(view.interaction) && Array.isArray(view.interaction.fields) && Boolean(view.values);
}

/** 只有首期组件和动作全部受支持时才启用交互 */
export function supportsInteraction (value: import('@interaction/protocol').InteractionView): boolean {
    return value.protocolVersion === 1 && value.libraryVersion === 'selfcraft-ui@1'
        && value.interaction.fields.every(field => ['single-select', 'multi-select', 'text'].includes(field.type))
        && value.interaction.actions?.length === 1 && value.interaction.actions[0]?.id === 'submit';
}
