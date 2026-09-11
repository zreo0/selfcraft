import { fingerprintProject } from '../supervisor/release-store';
import { validateCandidate } from '../supervisor/candidate-validator';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from '../logging/logger';
import type { SelfcraftPaths } from '../config/paths';
import type { ReleaseStore } from '../supervisor/release-store';

/** 候选版本中的一个完整文件修改 */
export interface EvolutionChange {
    /** 项目相对路径 */
    path: string;
    /** 修改后的完整正文 */
    content: string;
}

/** 候选版本校验结果 */
export interface ValidationResult {
    /** 是否通过所有校验 */
    healthy: boolean;
    /** 可供诊断的简短输出 */
    output: string;
}

export type CandidateValidator = (candidatePath: string) => Promise<ValidationResult>;

const PROTECTED_PATHS = [
    'src/index.ts',
    'src/doctor.ts',
    'src/supervisor/',
];

/** 负责提案式自我修改，不允许绕过验证直接覆盖运行代码 */
export class EvolutionService {
    private proposing = false;
    /**
     * 创建演化服务
     *
     * @param paths 项目与持久数据路径
     * @param releases Supervisor 发布状态
     * @param logger 结构化日志
     * @param validator 候选版本验证器
     */
    constructor (
        private readonly paths: SelfcraftPaths,
        private readonly releases: ReleaseStore,
        private readonly logger: Logger,
        private readonly validator: CandidateValidator = candidatePath => validateCandidate(candidatePath, this.paths.home),
    ) {}

    /**
     * 验证并暂存一组源码修改，由 Supervisor 激活
     *
     * @param changes 完整文件修改
     * @param rationale 修改原因与预期收益
     * @returns 发布标识与验证信息
     */
    public async propose (changes: EvolutionChange[], rationale: string, growthId?: string): Promise<{
        releaseId: string;
        restartRequired: true;
        validation: string;
    }> {
        if (this.proposing) {
            throw new Error('已有候选正在验证，请等待该发布完成');
        }
        this.proposing = true;
        try {
            return await this.stage(changes, rationale, growthId);
        } finally {
            this.proposing = false;
        }
    }

    /** 在单一发布通道中构建并暂存候选 */
    private async stage (changes: EvolutionChange[], rationale: string, growthId?: string): Promise<{
        releaseId: string;
        restartRequired: true;
        validation: string;
    }> {
        if (this.releases.read()?.status === 'pending') {
            throw new Error('已有版本等待重启健康验证');
        }
        if (changes.length === 0 || changes.length > 12) {
            throw new Error('一次演化需要包含 1 到 12 个文件');
        }
        const normalized = changes.map(change => ({
            path: this.validateChangePath(change.path),
            content: change.content,
        }));
        if (new Set(normalized.map(change => change.path)).size !== normalized.length) {
            throw new Error('候选包含重复文件');
        }
        const baseFingerprint = fingerprintProject(this.paths.project);
        const baseHashes = Object.fromEntries(normalized.map(change => {
            const file = path.join(this.paths.project, change.path);
            return [change.path, fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null];
        }));
        const releaseId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
        const candidatePath = path.join(this.paths.evolution, 'candidates', releaseId);
        this.copyProject(this.paths.project, candidatePath);
        for (const change of normalized) {
            const targetPath = path.join(candidatePath, change.path);
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.writeFileSync(targetPath, change.content, 'utf8');
        }

        const validation = await this.validator(candidatePath);
        if (!validation.healthy) {
            this.logger.warn('演化候选验证失败', { releaseId, output: validation.output });
            fs.rmSync(candidatePath, { recursive: true, force: true });
            throw new Error(`候选版本未通过验证：${validation.output.slice(-2000)}`);
        }

        for (const change of normalized) {
            const file = path.join(this.paths.project, change.path);
            const current = fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
            if (current !== baseHashes[change.path]) {
                fs.rmSync(candidatePath, { recursive: true, force: true });
                throw new Error('候选验证期间基础源码已变化，请基于最新版本重新提案');
            }
        }
        if (fingerprintProject(this.paths.project) !== baseFingerprint) {
            fs.rmSync(candidatePath, { recursive: true, force: true });
            throw new Error('候选验证期间项目基础已改变，请重新合并后验证');
        }
        if (this.releases.read()?.status === 'pending') {
            fs.rmSync(candidatePath, { recursive: true, force: true });
            throw new Error('验证期间出现另一待发布版本，已取消当前候选');
        }
        const backupDirectory = path.join('backups', releaseId);
        const backupPath = path.join(this.paths.evolution, backupDirectory);
        const files = normalized.map(change => {
            const sourcePath = path.join(this.paths.project, change.path);
            const existed = fs.existsSync(sourcePath);
            if (existed) {
                const backupFile = path.join(backupPath, change.path);
                fs.mkdirSync(path.dirname(backupFile), { recursive: true });
                fs.copyFileSync(sourcePath, backupFile);
            }
            return { path: change.path, existed, baseHash: baseHashes[change.path], candidateHash: createHash('sha256').update(change.content).digest('hex') };
        });

        // 先持久化回滚信息，确保多文件激活中途崩溃后 Supervisor 仍能恢复
        this.releases.recordPending({
            id: releaseId,
            rationale: rationale.trim(),
            createdAt: new Date().toISOString(),
            backupDirectory,
            files,
            candidateDirectory: path.join('candidates', releaseId),
            validation: validation.output.slice(-12000),
            baseFingerprint,
            parentId: this.releases.read()?.status === 'rolled_back' ? this.releases.read()?.parentId : this.releases.read()?.id,
            ...(growthId && { growthId }),
        });
        this.logger.info('演化候选已暂存，等待 Supervisor 验证和切换', {
            releaseId,
            files: files.map(file => file.path),
        });
        return {
            releaseId,
            restartRequired: true,
            validation: validation.output.slice(-2000),
        };
    }

    /** 返回最新发布来源与状态，供助理确认升级是否真正生效 */
    public releaseStatus () {
        return this.releases.read();
    }

    /** 返回是否有版本等待 Supervisor 重启验证 */
    public hasPendingRelease (): boolean {
        return this.releases.read()?.status === 'pending';
    }

    /**
     * 列出允许 Runtime 演化的源码文件
     *
     * @returns 项目相对路径列表
     */
    public listMutableFiles (): string[] {
        const files: string[] = [];
        const pending = [path.join(this.paths.project, 'src'), path.join(this.paths.project, 'workspace-template')];
        while (pending.length > 0 && files.length < 1000) {
            const candidate = pending.pop()!;
            if (!fs.existsSync(candidate)) {
                continue;
            }
            for (const entry of fs.readdirSync(candidate, { withFileTypes: true })) {
                const itemPath = path.join(candidate, entry.name);
                if (entry.isDirectory()) {
                    pending.push(itemPath);
                    continue;
                }
                const relativePath = path.relative(this.paths.project, itemPath).split(path.sep).join('/');
                try {
                    files.push(this.validateChangePath(relativePath));
                } catch {
                    // Supervisor 和入口文件不向可变 Runtime 暴露为演化目标
                }
            }
        }
        return files.sort();
    }

    /**
     * 读取允许演化的源码文件
     *
     * @param input 项目相对路径
     * @returns 文件正文
     */
    public readMutableFile (input: string): string {
        const relativePath = this.validateChangePath(input);
        const filePath = path.join(this.paths.project, relativePath);
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size > 512 * 1024) {
            throw new Error('目标不是可读取的源码文件或文件过大');
        }
        return fs.readFileSync(filePath, 'utf8');
    }

    /** 只允许修改 Runtime 与工作区模板，Supervisor 边界保持不可变 */
    private validateChangePath (input: string): string {
        const normalized = path.posix.normalize(input.replaceAll('\\', '/')).replace(/^\.\//, '');
        if (
            normalized.includes('../') ||
            normalized.startsWith('/') ||
            (!normalized.startsWith('src/') && !normalized.startsWith('workspace-template/')) ||
            PROTECTED_PATHS.some(protectedPath => normalized === protectedPath || normalized.startsWith(protectedPath))
        ) {
            throw new Error(`不可演化的路径: ${input}`);
        }
        let current = this.paths.project;
        for (const part of normalized.split('/')) {
            current = path.join(current, part);
            if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
                throw new Error('演化路径不能经过符号链接');
            }
        }
        return normalized;
    }

    /** 复制候选需要的项目文件，并复用已安装依赖 */
    private copyProject (source: string, destination: string): void {
        fs.cpSync(source, destination, {
            recursive: true,
            filter: item => {
                const relative = path.relative(source, item).split(path.sep);
                return !['.git', '.selfcraft', 'node_modules', 'coverage'].includes(relative[0]);
            },
        });
        const nodeModules = path.join(source, 'node_modules');
        if (fs.existsSync(nodeModules)) {
            fs.symlinkSync(nodeModules, path.join(destination, 'node_modules'), 'dir');
        }
    }

}
