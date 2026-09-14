/** 仅允许已核实不会修改用户状态的工具重试；未列出的工具仍按可能有副作用处理 */
export function canRepeatTool (name: string): boolean {
    return ['image_analyze', 'history_search', 'history_read'].includes(name);
}
