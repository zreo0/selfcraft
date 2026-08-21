import { createEvolutionTools } from './evolution-tool';
import { createFileTools } from './file-tools';
import { createJobTools } from './job-tools';
import { createMemoryTools } from './memory-tools';
import { createNotifyTool } from './notify-tool';
import { PathGuard } from './path-guard';
import { createShellTool } from './shell-tool';
import { createSkillTools } from './skill-tools';
import { wrapToolsWithResultOffload } from '../context/result-store';
import type { EvolutionService } from '../evolution/evolution-service';
import type { JobManager } from '../job/job-manager';
import type { MemoryStore } from '../memory/memory-store';
import type { NotificationInbox } from '../notification/notification-inbox';
import type { SkillRegistry } from '../skills/skill-registry';

/**
 * 创建 Runtime 的完整基础工具集合
 *
 * @param workspacePath 工作区路径
 * @param skills 技能注册表
 * @param notifications 本地通知收件箱
 * @param evolution 演化服务
 * @param jobs 持久后台任务
 * @param memory 结构化长期记忆
 * @returns AI SDK 工具集合
 */
export function createTools (
    workspacePath: string,
    skills: SkillRegistry,
    notifications: NotificationInbox,
    evolution: EvolutionService,
    jobs: JobManager,
    memory: MemoryStore,
) {
    const guard = new PathGuard(workspacePath);
    const tools = {
        ...createFileTools(guard),
        shell: createShellTool(guard),
        ...createSkillTools(skills),
        ...createJobTools(jobs),
        ...createMemoryTools(memory),
        notify: createNotifyTool(notifications),
        ...createEvolutionTools(evolution),
    };
    return wrapToolsWithResultOffload(tools, workspacePath);
}
