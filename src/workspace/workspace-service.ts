import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const TEMPLATE_FILES = ['IDENTITY.md', 'USER.md', 'HANDBOOK.md'];

/** 初始化并读取智能体的长期工作区 */
export class WorkspaceService {
    private profileConflictReported = false;

    /**
     * 创建工作区服务
     *
     * @param workspacePath 实例工作区
     * @param templatePath 随版本发布的初始模板
     */
    constructor (
        public readonly workspacePath: string,
        private readonly templatePath: string,
    ) {}

    /** 首次运行时只补齐缺失的模板内容 */
    public initialize (): void {
        fs.mkdirSync(this.workspacePath, { recursive: true });
        fs.mkdirSync(path.join(this.workspacePath, 'skills'), { recursive: true });
        fs.mkdirSync(path.join(this.workspacePath, 'files'), { recursive: true });
        for (const fileName of TEMPLATE_FILES) {
            const targetPath = path.join(this.workspacePath, fileName);
            const sourcePath = path.join(this.templatePath, fileName);
            if (!fs.existsSync(targetPath) && fs.existsSync(sourcePath)) {
                fs.copyFileSync(sourcePath, targetPath);
            }
        }
        const templateSkills = path.join(this.templatePath, 'skills');
        if (fs.existsSync(templateSkills)) {
            for (const entry of fs.readdirSync(templateSkills, { withFileTypes: true })) {
                const targetPath = path.join(this.workspacePath, 'skills', entry.name);
                if (entry.isDirectory() && !fs.existsSync(targetPath)) {
                    fs.cpSync(path.join(templateSkills, entry.name), targetPath, { recursive: true });
                }
            }
        }
    }

    /**
     * 读取系统上下文需要的核心文档
     *
     * @returns 按固定次序拼接的工作区上下文
     */
    public readCoreContext (): string {
        return ['IDENTITY.md', 'HANDBOOK.md'].map(fileName => {
            const filePath = path.join(this.workspacePath, fileName);
            const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').trim() : '';
            return `<document name="${fileName}">\n${content}\n</document>`;
        }).join('\n\n');
    }
    /** 仅更新未被手改的派生档案；返回冲突状态供调用方告知用户 */
    public writeUserProfile (profile: string): 'written' | 'unchanged' | 'conflict' {
        const file = path.join(this.workspacePath, 'USER.md');
        const digest = (text: string) => createHash('sha256').update(text).digest('hex');
        const body = `${profile.trim()}\n`;
        const generated = `<!-- selfcraft-profile:${digest(body)} 自动生成，请通过对话修改记忆 -->\n${body}`;
        const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        if (previous === generated) return 'unchanged';
        const header = previous.match(/^<!-- selfcraft-profile:([a-f0-9]{64})[^\n]*-->\n/);
        const template = path.join(this.templatePath, 'USER.md');
        const pristine = fs.existsSync(template) ? fs.readFileSync(template, 'utf8') : '';
        const originalTemplate = '# 用户与关系\n\n目前尚未记录长期有效的用户偏好或关系期待。';
        const edited = previous && (header ? digest(previous.slice(header[0].length)) !== header[1]
            : previous !== pristine && previous.trim() !== originalTemplate);
        if (edited || (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())) {
            if (this.profileConflictReported) return 'unchanged';
            this.profileConflictReported = true;
            return 'conflict';
        }
        fs.mkdirSync(this.workspacePath, { recursive: true });
        fs.writeFileSync(`${file}.tmp`, generated, 'utf8');
        fs.renameSync(`${file}.tmp`, file);
        this.profileConflictReported = false;
        return 'written';
    }

}
