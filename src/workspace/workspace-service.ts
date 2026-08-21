import * as fs from 'node:fs';
import * as path from 'node:path';

const TEMPLATE_FILES = ['IDENTITY.md', 'USER.md', 'MEMORY.md', 'HANDBOOK.md'];

/** 初始化并读取智能体的长期工作区 */
export class WorkspaceService {
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
        return TEMPLATE_FILES.map(fileName => {
            const filePath = path.join(this.workspacePath, fileName);
            const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').trim() : '';
            return `<document name="${fileName}">\n${content}\n</document>`;
        }).join('\n\n');
    }

    /**
     * 保存 onboarding 产生的身份起点
     *
     * @param name 用户选择的称呼
     * @param description 用户描述的关系与期待
     */
    public setInitialIdentity (name: string, description: string): void {
        const identity = name.trim()
            ? `# Identity\n\n- Name: ${name.trim()}\n- Origin: Chosen during onboarding\n`
            : '# Identity\n\nNo name or persona has been chosen yet. Do not invent one; allow identity to emerge with the user.\n';
        fs.writeFileSync(path.join(this.workspacePath, 'IDENTITY.md'), identity, 'utf8');
        if (description.trim()) {
            fs.writeFileSync(
                path.join(this.workspacePath, 'USER.md'),
                `# User and relationship\n\n${description.trim()}\n`,
                'utf8',
            );
        }
    }
}
