import type { Subprocess } from 'bun';
import type { SelfcraftPaths } from '../config/paths';
import type { Logger } from '../logging/logger';
import { ReleaseStore } from './release-store';

const RESTART_EXIT_CODE = 75;
const HEALTH_GRACE_MS = 5000;

/** 稳定 Supervisor：启动 Runtime，并监测自修改版本是否能健康存活 */
export class Supervisor {
    private readonly releases: ReleaseStore;
    private activeRuntime?: Subprocess;
    private stopping = false;

    /**
     * 创建 Supervisor
     *
     * @param paths 项目与状态路径
     * @param logger 日志记录器
     */
    constructor (
        private readonly paths: SelfcraftPaths,
        private readonly logger: Logger,
    ) {
        this.releases = new ReleaseStore(paths.supervisor, paths.evolution);
    }

    /**
     * 运行并按需重启 Runtime
     *
     * @param runtimeArgs 透传给 Runtime 的 CLI 参数
     * @returns 最终退出码
     */
    public async run (runtimeArgs: string[] = []): Promise<number> {
        while (!this.stopping) {
            const pending = this.releases.read()?.status === 'pending';
            if (pending && !(await this.preflightCurrentCode())) {
                this.logger.error('新版本启动前健康检查失败，执行回滚');
                this.releases.rollback(this.paths.project, '启动前健康检查失败');
                continue;
            }
            if (this.stopping) {
                return 0;
            }
            const child = this.spawnRuntime(runtimeArgs);
            this.activeRuntime = child;
            if (pending) {
                const early = await Promise.race([
                    child.exited.then(exitCode => ({ type: 'exit' as const, exitCode })),
                    Bun.sleep(HEALTH_GRACE_MS).then(() => ({ type: 'healthy' as const })),
                ]);
                if (this.stopping) {
                    await child.exited;
                    this.clearActiveRuntime(child);
                    return 0;
                }
                if (early.type === 'healthy') {
                    this.releases.markStable();
                    this.logger.info('新版本通过运行期健康观察');
                } else if (early.exitCode === RESTART_EXIT_CODE) {
                    this.clearActiveRuntime(child);
                    // 新 Runtime 已完成一次请求但赶在观察窗口前请求重启，可视为更强的存活证明
                    this.releases.markStable();
                    this.logger.info('新版本完成请求并再次启动');
                    continue;
                } else if (early.exitCode !== 0 && early.exitCode !== RESTART_EXIT_CODE) {
                    this.clearActiveRuntime(child);
                    this.logger.error('新版本在健康观察期崩溃，执行回滚', { exitCode: early.exitCode });
                    this.releases.rollback(this.paths.project, `运行期提前退出: ${early.exitCode}`);
                    continue;
                } else {
                    this.clearActiveRuntime(child);
                    return early.exitCode;
                }
            }
            const exitCode = await child.exited;
            this.clearActiveRuntime(child);
            if (this.stopping) {
                return 0;
            }
            if (exitCode === RESTART_EXIT_CODE) {
                this.logger.info('Runtime 请求重启以加载新版本');
                continue;
            }
            return exitCode;
        }
        return 0;
    }

    /**
     * 停止重启循环，并把终止信号转发给当前 Runtime
     *
     * @param signal 需要转发的系统信号
     */
    public stop (signal: NodeJS.Signals = 'SIGTERM'): void {
        this.stopping = true;
        this.activeRuntime?.kill(signal);
    }

    /** 启动继承当前终端的 Runtime 子进程 */
    private spawnRuntime (runtimeArgs: string[]): Subprocess {
        return Bun.spawn(['bun', 'run', 'src/runtime-entry.ts', ...runtimeArgs], {
            cwd: this.paths.project,
            env: {
                ...process.env,
                SELFCRAFT_PROJECT_ROOT: this.paths.project,
                SELFCRAFT_HOME: this.paths.home,
            },
            stdin: 'inherit',
            stdout: 'inherit',
            stderr: 'inherit',
        });
    }

    /** 仅清除仍指向指定子进程的活动引用 */
    private clearActiveRuntime (child: Subprocess): void {
        if (this.activeRuntime === child) {
            this.activeRuntime = undefined;
        }
    }

    /** 在独立进程加载受保护 doctor，避免当前进程模块缓存掩盖错误 */
    private async preflightCurrentCode (): Promise<boolean> {
        const doctor = Bun.spawn(['bun', 'run', 'src/doctor.ts', '--code-only'], {
            cwd: this.paths.project,
            env: {
                ...process.env,
                SELFCRAFT_PROJECT_ROOT: this.paths.project,
            },
            stdout: 'ignore',
            stderr: 'ignore',
        });
        return await doctor.exited === 0;
    }
}
