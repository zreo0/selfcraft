import { createHash } from 'node:crypto';
import { backupInstance } from './instance-backup';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 一次演化涉及的源码文件 */
export interface ReleaseFile {
    /** 项目相对路径 */
    path: string;
    /** 激活前文件是否存在 */
    existed: boolean;
    /** 基础文件内容摘要，用于拒绝覆盖实例已有修改 */
    baseHash?: string | null;
    /** 已验证候选的文件摘要 */
    candidateHash?: string;
}

/** Supervisor 持久化的发布状态 */
export interface ReleaseState {
    /** 发布标识 */
    id: string;
    /** 发布状态 */
    status: 'pending' | 'stable' | 'rolled_back';
    /** 暂存源码目录；旧记录没有此字段 */
    candidateDirectory?: string;
    /** 是否已由 Supervisor 应用源码 */
    activated?: boolean;
    /** 所有文件是否已完整切换 */
    activationComplete?: boolean;
    /** 演化前一版本 */
    parentId?: string;
    /** 关联的经验改进候选 */
    growthId?: string;
    /** 整个源码基础的内容指纹，独立于 Git 是否存在 */
    baseFingerprint?: string;
    /** 可追溯验证结果 */
    validation?: string;
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
        private readonly supervisorDirectory: string,
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
        this.write({ ...state, status: 'pending', ...(state.candidateDirectory && { activated: false }) });
    }

    /** 将当前 pending 版本标记为稳定 */
    public markStable (): void {
        const state = this.read();
        if (state?.status === 'pending') {
            this.write({ ...state, status: 'stable' });
            // 保留稳定版本的备份，后续行为退化仍可人工回退
            this.pruneBackups(state.id);
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
        if (!state || state.status === 'rolled_back') {
            return;
        }
        const backupPath = path.resolve(this.evolutionDirectory, state.backupDirectory);
        for (const file of state.activated === false ? [] : state.files) {
            const targetPath = this.resolveProjectFile(projectPath, file.path);
            const sourcePath = path.join(backupPath, file.path);
            if (file.existed) {
                fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                fs.copyFileSync(sourcePath, targetPath);
            } else {
                fs.rmSync(targetPath, { force: true });
            }
        }
        for (const file of state.files) {
            fs.rmSync(`${this.resolveProjectFile(projectPath, file.path)}.${state.id}.tmp`, { force: true });
        }
        this.write({
            ...state,
            status: 'rolled_back',
            rollbackReason: reason,
        });
        // 回滚只恢复源码，升级后产生的用户数据与外部操作记录继续保留
    }

    /** 原子保存状态 */
    private write (state: ReleaseState): void {
        const temporaryPath = `${this.statePath}.tmp`;
        fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 4), 'utf8');
        fs.renameSync(temporaryPath, this.statePath);
        const history = path.join(this.supervisorDirectory, 'history');
        fs.mkdirSync(history, { recursive: true });
        fs.writeFileSync(path.join(history, `${state.id}.json`), JSON.stringify(state, null, 4), { mode: 0o600 });
    }

    /** 取得可信暂存目录，拒绝目录穿越 */
    public candidatePath (): string | null {
        const relative = this.read()?.candidateDirectory;
        return relative ? this.resolveProjectFile(this.evolutionDirectory, relative) : null;
    }

    /** Supervisor 在 Runtime 停止后核对基础文件，备份实例并切换候选 */
    public activate (projectPath: string, home?: string): void {
        const state = this.read();
        const candidate = this.candidatePath();
        if (!state || state.status !== 'pending' || !candidate || state.activated) {
            return;
        }
        if (state.baseFingerprint && fingerprintProject(projectPath) !== state.baseFingerprint) {
            throw new Error('项目基础已改变，必须重新合并并验证候选');
        }
        for (const file of state.files) {
            const target = this.resolveProjectFile(projectPath, file.path);
            const source = this.resolveProjectFile(candidate, file.path);
            const actual = fs.existsSync(target) ? createHash('sha256').update(fs.readFileSync(target)).digest('hex') : null;
            if (actual !== file.baseHash || createHash('sha256').update(fs.readFileSync(source)).digest('hex') !== file.candidateHash) {
                throw new Error(`发布基础或候选发生变化，拒绝覆盖：${file.path}`);
            }
        }
        if (home && fs.existsSync(home)) {
            backupInstance(home, path.join(this.evolutionDirectory, state.backupDirectory, 'instance'));
        }
        // 先登记进入切换过程，任一文件替换后中断仍能恢复全部旧文件
        this.write({ ...state, activated: true });
        if (state.baseFingerprint && fingerprintProject(projectPath) !== state.baseFingerprint) {
            throw new Error('项目基础已改变，必须重新合并并验证候选');
        }
        for (const file of state.files) {
            const target = this.resolveProjectFile(projectPath, file.path);
            const source = this.resolveProjectFile(candidate, file.path);
            const archive = path.join(this.supervisorDirectory, 'history', state.id, file.path);
            fs.mkdirSync(path.dirname(archive), { recursive: true });
            fs.copyFileSync(source, archive);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            const temporary = `${target}.${state.id}.tmp`;
            fs.copyFileSync(source, temporary);
            fs.renameSync(temporary, target);
        }
        this.write({ ...state, activated: true, activationComplete: true });
        fs.rmSync(candidate, { recursive: true, force: true });
    }

    /** 只保留最近两份完整恢复备份，历史来源与修改记录不删除 */
    private pruneBackups (currentId: string): void {
        const history = path.join(this.supervisorDirectory, 'history');
        const records = fs.readdirSync(history).filter(name => name.endsWith('.json')).sort().reverse()
            .map(name => JSON.parse(fs.readFileSync(path.join(history, name), 'utf8')) as ReleaseState)
            .filter(record => record.activationComplete || record.status === 'stable');
        for (const record of records.slice(2)) {
            if (record.id !== currentId) {
                this.removeBackup(record.backupDirectory);
            }
        }
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

/** 计算发布所依赖源码与依赖声明的稳定指纹，不包含实例数据或构建产物 */
export function fingerprintProject (projectPath: string): string {
    const digest = createHash('sha256');
    /** 按稳定路径顺序读取普通源码文件 */
    const visit = (relative: string): void => {
        const file = path.join(projectPath, relative);
        if (!fs.existsSync(file)) {
            return;
        }
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) {
            digest.update(relative).update(fs.readlinkSync(file));
        } else if (stat.isDirectory()) {
            for (const name of fs.readdirSync(file).sort()) {
                visit(path.join(relative, name));
            }
        } else {
            digest.update(relative).update('\0').update(fs.readFileSync(file));
        }
    };
    for (const relative of ['src', 'workspace-template', 'package.json', 'bun.lock', 'tsconfig.json']) {
        visit(relative);
    }
    return digest.digest('hex');
}
