import type { ModelMessage, FilePart } from 'ai';

/**
 * 为新一轮模型请求准备可移植历史，不修改持久原文
 *
 * @param messages 标准历史消息
 * @param vision 目标模型是否支持图片，未声明时由提供方处理
 * @param materialize 将持久文件引用转换为本轮请求数据
 * @returns 移除提供方私有元数据与旧推理内容的消息副本
 */
export function prepareMessages (messages: ModelMessage[], vision?: boolean, materialize: (part: FilePart) => FilePart = part => part): ModelMessage[] {
    return messages.flatMap(message => {
        const { providerOptions: _options, ...portable } = message;
        if (typeof portable.content === 'string') {
            return [portable];
        }
        const parts: Exclude<ModelMessage['content'], string>[number][] = portable.content;
        const content = parts.filter(part => part.type !== 'reasoning' && part.type !== 'reasoning-file').map(part => {
            if ((part.type === 'image' || (part.type === 'file' && /^image(?:\/|$)/.test(part.mediaType))) && vision === false) {
                const reference = part.type === 'file' && typeof part.data === 'object' && 'url' in part.data
                    ? String(part.data.url) : '历史图片';
                return { type: 'text' as const, text: `[图片附件：${reference}；当前模型未读取像素，需要时使用 image_analyze，不能推测内容]` };
            }
            if (part.type === 'file') {
                try {
                    const { providerOptions: _fileOptions, ...file } = materialize(part);
                    return file;
                } catch {
                    return { type: 'text' as const, text: '[图片附件暂时无法读取，请说明这一情况，不得猜测图片内容]' };
                }
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
