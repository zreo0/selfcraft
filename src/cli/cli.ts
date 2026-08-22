import { createInterface } from 'node:readline/promises';
import type { AgentRuntime } from '../agent/agent-runtime';
import type { ConfigStore } from '../config/config-store';
import type { SelfcraftPaths } from '../config/paths';
import type { HealthChecker } from '../health/health-checker';
import type { JobManager } from '../job/job-manager';
import type { MemoryStore } from '../memory/memory-store';
import type { NotificationInbox } from '../notification/notification-inbox';
import { OnboardingCancelledError, type Onboarding } from '../onboarding/onboarding';
import type { SkillRegistry } from '../skills/skill-registry';

const RESTART_EXIT_CODE = 75;
const MODEL_SETUP_RESULT = -2;

/** 当前版本的 CLI 通信入口 */
export class Cli {
    /**
     * 创建 CLI
     *
     * @param dependencies Runtime 命令依赖
     */
    constructor (private readonly dependencies: {
        paths: SelfcraftPaths;
        config: ConfigStore;
        onboarding: Onboarding;
        agent: AgentRuntime;
        skills: SkillRegistry;
        notifications: NotificationInbox;
        jobs: JobManager;
        memory: MemoryStore;
        health: HealthChecker;
    }) {}

    /**
     * 启动交互循环
     *
     * @param args Runtime CLI 参数
     * @returns 进程退出码
     */
    public async start (args: string[]): Promise<number> {
        if (args[0] === 'setup' || !this.dependencies.config.isConfigured()) {
            if (!process.stdin.isTTY) {
                throw new Error('首次配置需要交互式终端，请运行 bun run start setup');
            }
            try {
                await this.dependencies.onboarding.run();
            } catch (error) {
                if (error instanceof OnboardingCancelledError) {
                    return 0;
                }
                throw error;
            }
            if (args[0] === 'setup') {
                return 0;
            }
        }

        let terminal = createInterface({ input: process.stdin, output: process.stdout });
        try {
            console.log('Selfcraft 已就绪。输入 /help 查看命令。');
            while (true) {
                const input = (await terminal.question('selfcraft> ')).trim();
                if (!input) {
                    continue;
                }
                let commandResult: number | null;
                try {
                    commandResult = await this.handleCommand(input);
                } catch (error) {
                    console.error(`命令失败：${error instanceof Error ? error.message : String(error)}`);
                    continue;
                }
                if (commandResult === MODEL_SETUP_RESULT) {
                    terminal.close();
                    try {
                        await this.dependencies.onboarding.configureModel();
                    } catch (error) {
                        if (!(error instanceof OnboardingCancelledError)) {
                            console.error(`命令失败：${error instanceof Error ? error.message : String(error)}`);
                        }
                    } finally {
                        terminal = createInterface({ input: process.stdin, output: process.stdout });
                    }
                    continue;
                }
                if (commandResult !== null) {
                    if (commandResult >= 0) {
                        return commandResult;
                    }
                    continue;
                }
                let wroteText = false;
                let lineOpen = false;
                try {
                    const result = await this.dependencies.agent.run(input, text => {
                        wroteText = true;
                        process.stdout.write(text);
                        lineOpen = !text.endsWith('\n');
                    }, status => {
                        if (lineOpen) {
                            process.stdout.write('\n');
                        }
                        console.log(`→ ${status}`);
                        lineOpen = false;
                    });
                    if (wroteText && lineOpen) {
                        process.stdout.write('\n');
                    }
                    if (result.restartRequired) {
                        console.log('新版本已通过候选验证，Runtime 将重启并接受 Supervisor 健康观察。');
                        return RESTART_EXIT_CODE;
                    }
                } catch (error) {
                    if (wroteText && lineOpen) {
                        process.stdout.write('\n');
                    }
                    console.error(`执行失败：${error instanceof Error ? error.message : String(error)}`);
                }
            }
        } finally {
            terminal.close();
        }
    }

    /**
     * 处理斜杠命令
     *
     * @param input 完整输入
     * @returns null 表示普通对话，负数表示继续，非负数表示退出
     */
    private async handleCommand (input: string): Promise<number | null> {
        if (!input.startsWith('/')) {
            return null;
        }
        const [command, ...args] = input.split(/\s+/);
        if (command === '/exit' || command === '/quit') {
            return 0;
        }
        if (command === '/help') {
            console.log([
                '/model list                  查看模型',
                '/model add                   新增渠道与模型',
                '/model use <provider/model>  切换模型',
                '/skills                      查看技能',
                '/jobs [id]                   查看后台任务或任务日志',
                '/job cancel|resume <id>      取消或恢复后台任务',
                '/memory [query]              查看或检索长期记忆',
                '/growth                      查看 Reflection 成长候选',
                '/notifications               查看并清空通知',
                '/status                       查看路径与健康状态',
                '/exit                         退出',
            ].join('\n'));
            return -1;
        }
        if (command === '/model') {
            return await this.handleModelCommand(args) ? MODEL_SETUP_RESULT : -1;
        }
        if (command === '/skills') {
            const skills = this.dependencies.skills.discover();
            console.log(skills.length > 0
                ? skills.map(skill => `${skill.name}: ${skill.description}`).join('\n')
                : '尚未安装技能');
            return -1;
        }
        if (command === '/jobs') {
            if (args[0]) {
                const result = this.dependencies.jobs.readLog(args[0]);
                console.log(JSON.stringify(result.job, null, 4));
                if (result.log) {
                    console.log(result.log);
                }
            } else {
                const jobs = this.dependencies.jobs.list();
                console.table(jobs.map(job => ({
                    id: job.id,
                    type: job.type,
                    status: job.status,
                    attempts: job.attempts,
                    title: job.title,
                })));
            }
            return -1;
        }
        if (command === '/job') {
            const action = args[0];
            const id = args[1];
            if (!id || !['cancel', 'resume'].includes(action)) {
                throw new Error('用法: /job cancel|resume <id>');
            }
            const changed = action === 'cancel'
                ? this.dependencies.jobs.cancel(id)
                : this.dependencies.jobs.resume(id);
            console.log(changed ? '任务状态已更新' : '任务不存在或当前状态不支持该操作');
            return -1;
        }
        if (command === '/memory') {
            const memories = this.dependencies.memory.search(args.join(' '), 50);
            console.log(memories.length > 0
                ? memories.map(item => `[${item.id}] (${item.kind}/${item.status}) ${item.content}`).join('\n')
                : '尚无匹配的长期记忆');
            return -1;
        }
        if (command === '/growth') {
            const proposals = this.dependencies.memory.listGrowth('proposed');
            console.log(proposals.length > 0
                ? proposals.map(item => `[${item.id}] (${item.kind}, evidence=${item.evidenceCount}) ${item.title}\n${item.observation}`).join('\n\n')
                : '尚无待评估的成长候选');
            return -1;
        }
        if (command === '/notifications') {
            const notifications = this.dependencies.notifications.list();
            console.log(notifications.length > 0
                ? notifications.map(item => `[${item.createdAt}] ${item.title}\n${item.message}`).join('\n\n')
                : '没有通知');
            this.dependencies.notifications.clear();
            return -1;
        }
        if (command === '/status') {
            const checks = this.dependencies.health.check(this.dependencies.paths);
            console.log(JSON.stringify({
                environment: this.dependencies.paths.environment,
                home: this.dependencies.paths.home,
                workspace: this.dependencies.paths.workspace,
                checks,
            }, null, 4));
            return -1;
        }
        console.log(`未知命令: ${command}`);
        return -1;
    }

    /**
     * 处理模型新增、查看和切换
     *
     * @param args 模型命令参数
     * @returns 是否需要离开 readline 进入模型配置
     */
    private async handleModelCommand (args: string[]): Promise<boolean> {
        const action = args[0] || 'list';
        if (action === 'add') {
            return true;
        }
        if (action === 'use') {
            const value = args[1] || '';
            const separator = value.indexOf('/');
            if (separator <= 0 || separator === value.length - 1) {
                throw new Error('用法: /model use <provider/model>');
            }
            this.dependencies.config.useModel({
                providerId: value.slice(0, separator),
                modelId: value.slice(separator + 1),
            });
            console.log(`已切换到 ${value}`);
            return false;
        }
        if (action !== 'list') {
            throw new Error('用法: /model list|add|use');
        }
        const config = this.dependencies.config.read();
        const rows = Object.entries(config.providers).flatMap(([providerId, provider]) =>
            Object.keys(provider.models).map(modelId => ({
                model: `${providerId}/${modelId}`,
                active: config.activeModel?.providerId === providerId && config.activeModel.modelId === modelId,
                protocol: provider.type,
                baseURL: provider.baseURL || 'official',
            })),
        );
        console.table(rows);
        return false;
    }
}
