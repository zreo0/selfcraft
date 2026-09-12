import type { FileUIPart, UserModelMessage } from 'ai';

/** 将标准用户内容转换为检索和提示使用的文字，附件引用不代表已读取 */
export function userContentText (content: UserModelMessage['content']): string {
    if (typeof content === 'string') {
        return content;
    }
    return content.map(part => part.type === 'text' ? part.text
        : `[附件，内容尚需读取：${part.type === 'file' && typeof part.data === 'object' && 'url' in part.data ? part.data.url : part.type}]`).join('\n');
}

/** 从持久用户内容提取标准 UI 文件部分，用于历史展示 */
export function userContentFiles (content: UserModelMessage['content']): FileUIPart[] {
    if (typeof content === 'string') {
        return [];
    }
    return content.flatMap(part => part.type === 'file' && typeof part.data === 'object' && 'url' in part.data
        ? [{ type: 'file' as const, url: String(part.data.url).replace(/^http:\/\/selfcraft\.local(?=\/)/, ''), mediaType: part.mediaType, filename: part.filename }]
        : []);
}
