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
    const resultDirectory = path.join(workspacePath, 'files', 'tool-results');
    fs.mkdirSync(resultDirectory, { recursive: true });
    const safeName = toolName.replace(/[^A-Za-z0-9._-]+/g, '-');
    const filePath = path.join(resultDirectory, `${safeName}-${Date.now()}-${randomUUID()}.json`);
    fs.writeFileSync(filePath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return {
        offloaded: true,
        path: path.relative(workspacePath, filePath).split(path.sep).join('/'),
        bytes: Buffer.byteLength(serialized, 'utf8'),
        preview: serialized.slice(0, PREVIEW_CHARS),
        hint: '完整结果已保存到 workspace，需要时使用 read 分页查看',
    };
}
