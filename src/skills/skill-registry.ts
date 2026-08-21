import * as fs from 'node:fs';
import * as path from 'node:path';

/** 一个可由 Runtime 动态发现的技能 */
export interface SkillDescriptor {
    /** 技能目录名 */
    name: string;
    /** SKILL.md 首段摘要 */
    description: string;
    /** 技能说明文件绝对路径 */
    instructionPath: string;
}

/** 以工作区 SKILL.md 为唯一能力描述的技能注册表 */
export class SkillRegistry {
    /**
     * 创建技能注册表
     *
     * @param skillsPath 工作区技能目录
     */
    constructor (private readonly skillsPath: string) {}

    /**
     * 每次调用重新扫描目录，使新技能无需重启即可被发现
     *
     * @returns 当前技能列表
     */
    public discover (): SkillDescriptor[] {
        if (!fs.existsSync(this.skillsPath)) {
            return [];
        }
        return fs.readdirSync(this.skillsPath, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => {
                const instructionPath = path.join(this.skillsPath, entry.name, 'SKILL.md');
                if (!fs.existsSync(instructionPath)) {
                    return null;
                }
                const content = fs.readFileSync(instructionPath, 'utf8');
                return {
                    name: entry.name,
                    description: this.extractDescription(content),
                    instructionPath,
                };
            })
            .filter((skill): skill is SkillDescriptor => Boolean(skill))
            .sort((left, right) => left.name.localeCompare(right.name));
    }

    /**
     * 读取指定技能的完整说明
     *
     * @param name 技能目录名
     * @returns 技能说明正文
     */
    public read (name: string): string {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
            throw new Error('技能名称无效');
        }
        const skill = this.discover().find(item => item.name === name);
        if (!skill) {
            throw new Error(`技能不存在: ${name}`);
        }
        return fs.readFileSync(skill.instructionPath, 'utf8');
    }

    /**
     * 将技能摘要渲染到 Agent 系统上下文
     *
     * @returns 紧凑技能目录
     */
    public buildCatalog (): string {
        const skills = this.discover();
        if (skills.length === 0) {
            return '当前没有已安装技能。可以在 workspace/skills/<name>/SKILL.md 中学习新技能。';
        }
        return skills.map(skill => `- ${skill.name}: ${skill.description}`).join('\n');
    }

    /** 从 Markdown 的首个正文段落提取摘要 */
    private extractDescription (content: string): string {
        const lines = content.split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#') && line !== '---' && !line.includes(': '));
        return (lines[0] || '无摘要').slice(0, 240);
    }
}
