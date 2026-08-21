import { spawn } from 'node:child_process';
import { tool } from 'ai';
import { z } from 'zod';
import type { PathGuard } from './path-guard';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const ABSOLUTE_DANGER = [
    /(?:^|\s)(?:sudo\s+)?(?:shutdown|reboot|poweroff|halt)(?:\s|$)/i,
    /(?:^|\s)mkfs(?:\.|\s)/i,
    /(?:^|\s)rm\s+(?:-[A-Za-z]*r[A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*r)\s+\/(?:\s|$)/i,
    /(?:^|\s)dd\s+[^\n]*\bof=\/dev\//i,
];

/** 创建保留完整 Shell 表达力的工作区命令工具 */
export function createShellTool (guard: PathGuard) {
    return tool({
        description: '在 workspace 内执行 shell 命令。仅拦截会破坏宿主机的明确危险操作',
        inputSchema: z.object({
            command: z.string().min(1).max(100000),
            cwd: z.string().optional(),
            timeoutSeconds: z.number().int().min(1).max(600).optional(),
        }),
        execute: async ({ command, cwd = '.', timeoutSeconds = 60 }, { abortSignal }) => {
            assertSafeShellCommand(command);
            const workingDirectory = guard.resolveRead(cwd);
            return await new Promise((resolve, reject) => {
                const child = spawn('sh', ['-lc', command], {
                    cwd: workingDirectory,
                    env: createShellEnvironment(),
                    detached: process.platform !== 'win32',
                });
                let stdout = '';
                let stderr = '';
                let truncated = false;
                const append = (current: string, chunk: Buffer): string => {
                    const combined = Buffer.from(current + chunk.toString('utf8'));
                    if (combined.length <= MAX_OUTPUT_BYTES) {
                        return combined.toString('utf8');
                    }
                    truncated = true;
                    return combined.subarray(combined.length - MAX_OUTPUT_BYTES).toString('utf8');
                };
                child.stdout?.on('data', chunk => {
                    stdout = append(stdout, chunk);
                });
                child.stderr?.on('data', chunk => {
                    stderr = append(stderr, chunk);
                });
                const stop = () => {
                    if (child.pid && process.platform !== 'win32') {
                        process.kill(-child.pid, 'SIGTERM');
                    } else {
                        child.kill('SIGTERM');
                    }
                };
                const timer = setTimeout(stop, timeoutSeconds * 1000);
                abortSignal?.addEventListener('abort', stop, { once: true });
                child.once('error', error => {
                    clearTimeout(timer);
                    reject(error);
                });
                child.once('close', code => {
                    clearTimeout(timer);
                    abortSignal?.removeEventListener('abort', stop);
                    resolve({
                        success: code === 0,
                        exitCode: code ?? -1,
                        stdout,
                        stderr,
                        truncated,
                    });
                });
            });
        },
    });
}

/**
 * 拒绝少量可确定破坏宿主环境的命令
 *
 * @param command 待执行 Shell 文本
 */
export function assertSafeShellCommand (command: string): void {
    if (ABSOLUTE_DANGER.some(pattern => pattern.test(command))) {
        throw new Error('命令命中宿主机绝对危险操作，已拒绝执行');
    }
}

/** 模型请求凭证不应通过 shell 环境重新暴露给工具输出 */
function createShellEnvironment (): NodeJS.ProcessEnv {
    return Object.fromEntries(Object.entries(process.env).filter(([key]) => ![
        'SELFCRAFT_TEST_API_KEY',
        'OPENAI_API_KEY',
        'ANTHROPIC_API_KEY',
    ].includes(key)));
}
