import * as fs from 'node:fs';
import * as path from 'node:path';

/** 一次演化涉及的源码文件 */
export interface ReleaseFile {
    /** 项目相对路径 */
    path: string;
    /** 激活前文件是否存在 */
    existed: boolean;
}

/** Supervisor 持久化的发布状态 */
export interface ReleaseState {
    /** 发布标识 */
    id: string;
    /** 发布状态 */
    status: 'pending' | 'stable' | 'rolled_back';
    /** 提案原因 */
    rationale: string;
    /** 创建时间 */
    createdAt: string;
    /** 相对 evolution 目录的备份位置 */
    backupDirectory: string;
    /** 受影响文件 */
    files: ReleaseFile[];
    /** 回滚原因 */
    rollbackReason?: string;
}

/** Supervisor 与 Runtime 共享的最小发布状态存储 */
export class ReleaseStore {
    private readonly statePath: string;

    /**
     * 创建发布存储
     *
     * @param supervisorDirectory Supervisor 状态目录
     * @param evolutionDirectory 备份根目录
     */
    constructor (
        supervisorDirectory: string,
        private readonly evolutionDirectory: string,
    ) {
        fs.mkdirSync(supervisorDirectory, { recursive: true });
        fs.mkdirSync(evolutionDirectory, { recursive: true });
        this.statePath = path.join(supervisorDirectory, 'release.json');
    }

    /**
     * 读取最近一次发布状态
     *
     * @returns 发布状态，不存在时为空
     */
    public read (): ReleaseState | null {
        if (!fs.existsSync(this.statePath)) {
            return null;
        }
        return JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as ReleaseState;
    }

    /**
     * 记录等待新进程验证的版本
     *
     * @param state 发布状态
     */
    public recordPending (state: Omit<ReleaseState, 'status'>): void {
        this.write({ ...state, status: 'pending' });
    }

    /** 将当前 pending 版本标记为稳定 */
    public markStable (): void {
        const state = this.read();
        if (state?.status === 'pending') {
            this.write({ ...state, status: 'stable' });
            this.removeBackup(state.backupDirectory);
        }
    }

    /**
     * 从备份恢复当前 pending 版本
     *
     * @param projectPath 项目根目录
     * @param reason 回滚原因
     */
    public rollback (projectPath: string, reason: string): void {
        const state = this.read();
        if (!state || state.status !== 'pending') {
            return;
        }
        const backupPath = path.resolve(this.evolutionDirectory, state.backupDirectory);
        for (const file of state.files) {
            const targetPath = this.resolveProjectFile(projectPath, file.path);
            const sourcePath = path.join(backupPath, file.path);
            if (file.existed) {
                fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                fs.copyFileSync(sourcePath, targetPath);
            } else {
                fs.rmSync(targetPath, { force: true });
            }
        }
        this.write({
            ...state,
            status: 'rolled_back',
            rollbackReason: reason,
        });
        this.removeBackup(state.backupDirectory);
    }

    /** 原子保存状态 */
    private write (state: ReleaseState): void {
        const temporaryPath = `${this.statePath}.tmp`;
        fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 4), 'utf8');
        fs.renameSync(temporaryPath, this.statePath);
    }

    /** 防止损坏的状态文件把回滚目标指向项目外部 */
    private resolveProjectFile (projectPath: string, relativePath: string): string {
        const targetPath = path.resolve(projectPath, relativePath);
        const relative = path.relative(projectPath, targetPath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error('发布状态包含越界路径');
        }
        return targetPath;
    }

    /** 发布稳定或回滚完成后删除不再需要的版本备份 */
    private removeBackup (backupDirectory: string): void {
        const backupPath = path.resolve(this.evolutionDirectory, backupDirectory);
        const relative = path.relative(this.evolutionDirectory, backupPath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error('发布状态包含越界备份路径');
        }
        fs.rmSync(backupPath, { recursive: true, force: true });
    }
}
