import * as os from 'node:os';
import * as path from 'node:path';

/** Selfcraft 使用的所有本地路径 */
export interface SelfcraftPaths {
    /** 运行环境 */
    environment: 'development' | 'production';
    /** 项目源码根目录 */
    project: string;
    /** 持久数据根目录 */
    home: string;
    /** 智能体工作区 */
    workspace: string;
    /** 配置目录 */
    config: string;
    /** 会话目录 */
    sessions: string;
    /** Runtime 的结构化状态库 */
    state: string;
    /** 后台任务日志与运行文件 */
    jobs: string;
    /** 日志目录 */
    logs: string;
    /** Supervisor 状态目录 */
    supervisor: string;
    /** 演化候选与备份目录 */
    evolution: string;
    /** 通知文件 */
    notifications: string;
}

/**
 * 解析当前运行环境的项目与数据路径
 *
 * @param environment 当前环境
 * @param homeOverride 显式数据目录
 * @returns 规范化后的路径集合
 */
export function resolvePaths (
    environment = process.env.SELFCRAFT_ENV || 'production',
    homeOverride = process.env.SELFCRAFT_HOME,
): SelfcraftPaths {
    const resolvedEnvironment = environment === 'development' ? 'development' : 'production';
    const project = path.resolve(process.env.SELFCRAFT_PROJECT_ROOT || path.join(import.meta.dir, '../..'));
    const home = path.resolve(homeOverride || (
        resolvedEnvironment === 'development'
            ? path.join(project, '.selfcraft')
            : path.join(os.homedir(), '.selfcraft')
    ));
    return {
        environment: resolvedEnvironment,
        project,
        home,
        workspace: path.join(home, 'workspace'),
        config: path.join(home, 'config'),
        sessions: path.join(home, 'sessions'),
        state: path.join(home, 'state.sqlite'),
        jobs: path.join(home, 'jobs'),
        logs: path.join(home, 'logs'),
        supervisor: path.join(home, 'supervisor'),
        evolution: path.join(home, 'evolution'),
        notifications: path.join(home, 'notifications.jsonl'),
    };
}
