import * as fs from 'node:fs';
import * as path from 'node:path';

/** 将文件工具限制在当前智能体工作区 */
export class PathGuard {
    private readonly workspaceRealPath: string;

    /**
     * 创建路径守卫
     *
     * @param workspacePath 工作区根目录
     */
    constructor (private readonly workspacePath: string) {
        fs.mkdirSync(workspacePath, { recursive: true });
        this.workspaceRealPath = fs.realpathSync(workspacePath);
    }

    /**
     * 解析必须存在的读取路径
     *
     * @param input 用户或模型给出的路径
     * @returns 工作区内真实路径
     */
    public resolveRead (input = '.'): string {
        const candidate = this.resolveLexical(input);
        const resolved = fs.realpathSync(candidate);
        this.assertInside(resolved);
        return resolved;
    }

    /**
     * 解析可尚未存在的写入路径
     *
     * @param input 用户或模型给出的路径
     * @returns 工作区内绝对路径
     */
    public resolveWrite (input: string): string {
        const candidate = this.resolveLexical(input);
        let ancestor = path.dirname(candidate);
        while (!fs.existsSync(ancestor)) {
            const parent = path.dirname(ancestor);
            if (parent === ancestor) {
                throw new Error('无法解析写入路径');
            }
            ancestor = parent;
        }
        this.assertInside(fs.realpathSync(ancestor));
        if (fs.existsSync(candidate)) {
            const stat = fs.lstatSync(candidate);
            if (stat.isSymbolicLink()) {
                throw new Error('不允许写入符号链接');
            }
            this.assertInside(fs.realpathSync(candidate));
        }
        return candidate;
    }

    /**
     * 转换为工作区相对路径
     *
     * @param absolutePath 工作区内绝对路径
     * @returns 使用正斜线的相对路径
     */
    public relative (absolutePath: string): string {
        this.assertInside(absolutePath);
        return path.relative(this.workspaceRealPath, absolutePath).split(path.sep).join('/') || '.';
    }

    /** 先做词法归一化，拒绝明显越界 */
    private resolveLexical (input: string): string {
        const candidate = path.resolve(this.workspaceRealPath, input);
        this.assertInside(candidate);
        return candidate;
    }

    /** 判断候选路径是否属于工作区本身或其子路径 */
    private assertInside (candidate: string): void {
        const relative = path.relative(this.workspaceRealPath, candidate);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error('路径超出 workspace');
        }
    }
}
