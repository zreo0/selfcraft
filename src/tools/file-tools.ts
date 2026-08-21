import * as fs from 'node:fs';
import * as path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import type { PathGuard } from './path-guard';

const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** 创建简洁的工作区文件工具集合 */
export function createFileTools (guard: PathGuard) {
    return {
        read: tool({
            description: '读取 workspace 内的 UTF-8 文本文件，支持按行分页',
            inputSchema: z.object({
                path: z.string().min(1),
                offset: z.number().int().min(1).optional(),
                limit: z.number().int().min(1).max(2000).optional(),
            }),
            execute: async ({ path: inputPath, offset = 1, limit = 500 }) => {
                const filePath = guard.resolveRead(inputPath);
                const stat = fs.statSync(filePath);
                if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
                    throw new Error('目标不是可读取的文本文件或文件过大');
                }
                const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
                const content = lines.slice(offset - 1, offset - 1 + limit).join('\n');
                return {
                    path: guard.relative(filePath),
                    content,
                    totalLines: lines.length,
                    hasMore: offset - 1 + limit < lines.length,
                };
            },
        }),
        list: tool({
            description: '列出 workspace 内目录的直接子项',
            inputSchema: z.object({
                path: z.string().optional(),
            }),
            execute: async ({ path: inputPath = '.' }) => {
                const directoryPath = guard.resolveRead(inputPath);
                if (!fs.statSync(directoryPath).isDirectory()) {
                    throw new Error('目标不是目录');
                }
                return fs.readdirSync(directoryPath, { withFileTypes: true })
                    .slice(0, 500)
                    .map(entry => {
                        const itemPath = guard.resolveRead(path.join(inputPath, entry.name));
                        const stat = fs.statSync(itemPath);
                        return {
                            path: guard.relative(itemPath),
                            type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
                            ...(stat.isFile() && { size: stat.size }),
                        };
                    });
            },
        }),
        search: tool({
            description: '在 workspace 的文本文件中搜索固定字符串',
            inputSchema: z.object({
                query: z.string().min(1),
                path: z.string().optional(),
            }),
            execute: async ({ query, path: inputPath = '.' }) => {
                const startPath = guard.resolveRead(inputPath);
                const pending = [startPath];
                const matches: Array<{ path: string, line: number, text: string }> = [];
                let scanned = 0;
                while (pending.length > 0 && scanned < 500 && matches.length < 200) {
                    const candidate = pending.pop()!;
                    const stat = fs.statSync(candidate);
                    if (stat.isDirectory()) {
                        for (const entry of fs.readdirSync(candidate)) {
                            try {
                                pending.push(guard.resolveRead(path.join(candidate, entry)));
                            } catch {
                                // 越界符号链接不属于工作区内容
                            }
                        }
                        continue;
                    }
                    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
                        continue;
                    }
                    scanned += 1;
                    const buffer = fs.readFileSync(candidate);
                    if (buffer.includes(0)) {
                        continue;
                    }
                    const lines = buffer.toString('utf8').split(/\r?\n/);
                    for (let index = 0; index < lines.length && matches.length < 200; index += 1) {
                        if (lines[index].includes(query)) {
                            matches.push({
                                path: guard.relative(candidate),
                                line: index + 1,
                                text: lines[index].slice(0, 500),
                            });
                        }
                    }
                }
                return { matches, scanned, truncated: pending.length > 0 || matches.length >= 200 };
            },
        }),
        write: tool({
            description: '完整写入 workspace 内文件，自动创建父目录',
            inputSchema: z.object({
                path: z.string().min(1),
                content: z.string().max(MAX_FILE_BYTES),
            }),
            execute: async ({ path: inputPath, content }) => {
                const filePath = guard.resolveWrite(inputPath);
                fs.mkdirSync(path.dirname(filePath), { recursive: true });
                fs.writeFileSync(filePath, content, 'utf8');
                return { path: guard.relative(filePath), bytesWritten: Buffer.byteLength(content) };
            },
        }),
        edit: tool({
            description: '精确替换 workspace 内文件的唯一文本片段',
            inputSchema: z.object({
                path: z.string().min(1),
                oldText: z.string().min(1),
                newText: z.string(),
            }),
            execute: async ({ path: inputPath, oldText, newText }) => {
                const filePath = guard.resolveWrite(inputPath);
                const content = fs.readFileSync(filePath, 'utf8');
                const first = content.indexOf(oldText);
                if (first === -1) {
                    throw new Error('未找到 oldText');
                }
                if (content.indexOf(oldText, first + oldText.length) !== -1) {
                    throw new Error('oldText 匹配多处，请提供更多上下文');
                }
                const next = content.slice(0, first) + newText + content.slice(first + oldText.length);
                if (Buffer.byteLength(next) > MAX_FILE_BYTES) {
                    throw new Error('编辑后的文件过大');
                }
                fs.writeFileSync(filePath, next, 'utf8');
                return { path: guard.relative(filePath), changed: true };
            },
        }),
    };
}
