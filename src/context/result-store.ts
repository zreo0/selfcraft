import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const OFFLOAD_BYTES = 8 * 1024;
const PREVIEW_CHARS = 2000;

/**
 * 为工具集合增加大结果落盘，避免挤占模型上下文
 *
 * @param tools AI SDK 工具集合
 * @param workspacePath 持久工作区
 * @returns 保持原工具 schema 的包装工具
 */
export function wrapToolsWithResultOffload (
    tools: Record<string, any>,
    workspacePath: string,
): Record<string, any> {
    return Object.fromEntries(Object.entries(tools).map(([name, definition]) => {
        if (typeof definition.execute !== 'function') {
            return [name, definition];
        }
        return [name, {
            ...definition,
            execute: async (...args: any[]) => {
                const result = await definition.execute(...args);
                return maybeOffload(name, result, workspacePath);
            },
        }];
    }));
}

/** 将过大的可序列化结果保存到 workspace */
function maybeOffload (toolName: string, result: unknown, workspacePath: string): unknown {
    let serialized: string;
    try {
        serialized = JSON.stringify(result);
    } catch {
        throw new Error(`工具 ${toolName} 返回了无法序列化的结果`);
    }
    if (serialized === undefined) {
        return null;
    }
    if (Buffer.byteLength(serialized, 'utf8') <= OFFLOAD_BYTES) {
        return JSON.parse(serialized);
    }
    if (hasLargeContent(result)) {
        const contentBytes = Buffer.byteLength(result.content, 'utf8');
        if (toolName === 'read' && typeof result.path === 'string') {
            return {
                ...result,
                content: result.content.slice(0, PREVIEW_CHARS),
                contentTruncated: true,
                contentBytes,
                hint: `当前分页仍然过大；继续 read ${result.path}，缩小 limit 并调整 offset`,
            };
        }
        const contentPath = writeResultFile(
            toolName,
            result.content,
            workspacePath,
            toolName === 'web_fetch' ? 'md' : 'txt',
        );
        return {
            ...result,
            content: result.content.slice(0, PREVIEW_CHARS),
            contentTruncated: true,
            contentPath,
            contentBytes,
            hint: '完整正文已保存到 workspace，需要时使用 read 的 offset 与 limit 分页读取',
        };
    }
    const filePath = writeResultFile(toolName, serialized, workspacePath, 'json');
    return {
        offloaded: true,
        path: filePath,
        bytes: Buffer.byteLength(serialized, 'utf8'),
        preview: serialized.slice(0, PREVIEW_CHARS),
        hint: '完整结果已保存到 workspace，需要时使用 read 分页查看',
    };
}

/** 判断工具结果是否包含应独立落盘的大段正文 */
function hasLargeContent (result: unknown): result is Record<string, unknown> & { content: string } {
    return typeof result === 'object'
        && result !== null
        && 'content' in result
        && typeof result.content === 'string'
        && Buffer.byteLength(result.content, 'utf8') > OFFLOAD_BYTES;
}

/**
 * 把工具结果写入 workspace 并返回相对路径
 *
 * @param toolName 工具名
 * @param content 文件正文
 * @param workspacePath 工作区根目录
 * @param extension 文件扩展名
 * @returns workspace 内相对路径
 */
function writeResultFile (
    toolName: string,
    content: string,
    workspacePath: string,
    extension: 'json' | 'md' | 'txt',
): string {
    const resultDirectory = path.join(workspacePath, 'files', 'tool-results');
    fs.mkdirSync(resultDirectory, { recursive: true });
    const safeName = toolName.replace(/[^A-Za-z0-9._-]+/g, '-');
    const filePath = path.join(resultDirectory, `${safeName}-${Date.now()}-${randomUUID()}.${extension}`);
    fs.writeFileSync(filePath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return path.relative(workspacePath, filePath).split(path.sep).join('/');
}
