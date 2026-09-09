import type { ModelMessage } from 'ai';

/**
 * 为新一轮模型请求准备可移植历史，不修改持久原文
 *
 * @param messages 标准历史消息
 * @param vision 目标模型是否支持图片，未声明时由提供方处理
 * @returns 移除提供方私有元数据与旧推理内容的消息副本
 */
export function prepareMessages (messages: ModelMessage[], vision?: boolean): ModelMessage[] {
    return messages.flatMap(message => {
        const { providerOptions: _options, ...portable } = message;
        if (typeof portable.content === 'string') {
            return [portable];
        }
        const parts: Exclude<ModelMessage['content'], string>[number][] = portable.content;
        const content = parts.filter(part => part.type !== 'reasoning' && part.type !== 'reasoning-file').map(part => {
            if (part.type === 'image' && vision === false) {
                throw new Error('当前模型不支持历史中的图片输入，请选择支持图片的模型');
            }
            if ('providerOptions' in part) {
                const { providerOptions: _partOptions, ...value } = part;
                return value;
            }
            return part;
        });
        return content.length ? [{ ...portable, content } as ModelMessage] : [];
    });
}
