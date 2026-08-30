import { createInterface } from 'node:readline/promises';
import { OnboardingCancelledError, type Onboarding } from '../onboarding/onboarding';
import type { RuntimeClient } from './runtime-client';

const MODEL_SETUP_RESULT = -2;
const WEB_SETUP_RESULT = -3;

/** 通过 HTTP 访问唯一 Runtime 的终端客户端 */
export class Cli {
    /**
     * 创建 CLI 客户端
     *
     * @param dependencies Runtime 客户端与终端 onboarding
     */
    constructor (private readonly dependencies: {
        client: RuntimeClient;
        onboarding: Onboarding;
    }) {}

    /**
     * 启动交互循环
     *
     * @param args CLI 子命令
     * @returns 进程退出码
     */
    public async start (args: string[]): Promise<number> {
        if (!process.stdin.isTTY) {
            throw new Error('CLI 需要交互式终端；服务本身请运行 bun run start');
        }
        if (args[0] === 'reset-config') {
            await this.dependencies.onboarding.reset();
            return 0;
        }

        const bootstrap = await this.dependencies.client.bootstrap();
        if (!bootstrap.config) {
            throw new Error(`现有配置无效：${bootstrap.configurationError || '未知错误'}。请运行 bun run cli reset-config`);
        }
        if (args[0] === 'setup' || !bootstrap.config.configured) {
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
            console.log('Selfcraft CLI 已连接。输入 /help 查看命令。');
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
                if (commandResult === WEB_SETUP_RESULT) {
                    terminal.close();
                    try {
                        await this.dependencies.onboarding.configureWebSearch();
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
                await this.runConversation(input);
            }
        } finally {
            terminal.close();
        }
    }

    /** 把一轮 Runtime 流式响应写到终端 */
    private async runConversation (input: string): Promise<void> {
        let wroteText = false;
        let lineOpen = false;
        try {
            await this.dependencies.client.chat(input, event => {
                if (event.type === 'text-delta') {
                    wroteText = true;
                    process.stdout.write(event.delta);
                    lineOpen = !event.delta.endsWith('\n');
                    return;
                }
                if (lineOpen) {
                    process.stdout.write('\n');
                }
                if (event.type === 'status') {
                    console.log(`→ ${event.label}`);
                } else if (event.type === 'activity') {
                    const marker = event.activity.state === 'running'
                        ? '→'
                        : event.activity.state === 'success'
                            ? '✓'
                            : event.activity.state === 'error' ? '×' : '?';
                    const target = event.activity.target ? ` · ${event.activity.target}` : '';
                    console.log(`${marker} ${event.activity.label}${target}`);
                } else {
                    console.log(`↳ 已读取 ${event.source.title}`);
                }
                lineOpen = false;
            });
            if (wroteText && lineOpen) {
                process.stdout.write('\n');
            }
        } catch (error) {
            if (wroteText && lineOpen) {
                process.stdout.write('\n');
            }
            console.error(`执行失败：${error instanceof Error ? error.message : String(error)}`);
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
            this.printHelp();
            return -1;
        }
        if (command === '/model') {
            return await this.handleModelCommand(args) ? MODEL_SETUP_RESULT : -1;
        }
        if (command === '/web') {
            return await this.handleWebCommand(args);
        }
        if (command === '/skills') {
            const skills = await this.dependencies.client.listSkills();
            console.log(skills.length > 0
                ? skills.map(skill => `${skill.name}: ${skill.description}`).join('\n')
                : '尚未安装技能');
            return -1;
        }
        if (command === '/jobs') {
            await this.printJobs(args[0]);
            return -1;
        }
        if (command === '/job') {
            const action = args[0];
            const id = args[1];
            if (!id || !['cancel', 'resume'].includes(action)) {
                throw new Error('用法: /job cancel|resume <id>');
            }
            const changed = await this.dependencies.client.updateJob(id, action as 'cancel' | 'resume');
            console.log(changed ? '任务状态已更新' : '任务不存在或当前状态不支持该操作');
            return -1;
        }
        if (command === '/tasks') {
            const tasks = await this.dependencies.client.listTasks();
            console.table(tasks.map(task => ({
                id: task.id,
                status: task.status,
                dueAt: task.dueAt,
                timezone: task.timezone,
                title: task.title,
            })));
            return -1;
        }
        if (command === '/task') {
            const action = args[0];
            const id = args[1];
            if (action !== 'cancel' || !id) {
                throw new Error('用法: /task cancel <id>');
            }
            const changed = await this.dependencies.client.cancelTask(id);
            console.log(changed ? '提醒已取消' : '提醒不存在或已进入终态');
            return -1;
        }
        if (command === '/topics') {
            const topics = await this.dependencies.client.searchTopics(args.join(' '));
            console.log(topics.length > 0
                ? topics.map(topic => `[${topic.id}] (${topic.kind || 'general'}) ${topic.title}`).join('\n')
                : '尚无匹配的持续事项');
            return -1;
        }
        if (command === '/memory') {
            const memories = await this.dependencies.client.searchMemories(args.join(' '));
            console.log(memories.length > 0
                ? memories.map(item => [
                    `[${item.id}] (${item.kind}/${item.status}) ${item.content}`,
                    `  valid=${item.validFrom || '?'}..${item.validTo || 'now'} known=${item.knownFrom}..${item.knownTo || 'now'}`,
                    `  topics=${item.topicIds.join(',') || '-'} sources=${item.sourceEventIds.join(',') || '-'}`,
                ].join('\n')).join('\n')
                : '尚无匹配的长期记忆');
            return -1;
        }
        if (command === '/growth') {
            const proposals = await this.dependencies.client.listGrowth();
            console.log(proposals.length > 0
                ? proposals.map(item => `[${item.id}] (${item.kind}, evidence=${item.evidenceCount}) ${item.title}\n${item.observation}`).join('\n\n')
                : '尚无待评估的成长候选');
            return -1;
        }
        if (command === '/notifications') {
            const notifications = await this.dependencies.client.listNotifications();
            console.log(notifications.length > 0
                ? notifications.map(item => `[${item.createdAt}] ${item.title}\n${item.message}`).join('\n\n')
                : '没有通知');
            await this.dependencies.client.clearNotifications();
            return -1;
        }
        if (command === '/status') {
            const bootstrap = await this.dependencies.client.bootstrap();
            console.log(JSON.stringify({
                environment: bootstrap.runtime.environment,
                home: bootstrap.runtime.home,
                workspace: bootstrap.runtime.workspace,
                pendingForegroundRuns: bootstrap.runtime.pendingForegroundRuns,
                checks: bootstrap.runtime.checks,
            }, null, 4));
            return -1;
        }
        console.log(`未知命令: ${command}`);
        return -1;
    }

    /** 输出 CLI 命令帮助 */
    private printHelp (): void {
        console.log([
            '/model list                  查看模型',
            '/model add                   新增渠道与模型',
            '/model use <provider/model>  切换模型',
            '/web status|setup|disable    查看、配置或关闭网络搜索',
            '/skills                      查看技能',
            '/jobs [id]                   查看后台任务或任务日志',
            '/job cancel|resume <id>      取消或恢复后台任务',
            '/tasks                       查看一次性定时提醒',
            '/task cancel <id>            取消尚未触发的提醒',
            '/topics [query]              查看持续事项',
            '/memory [query]              查看或检索长期记忆',
            '/growth                      查看 Reflection 成长候选',
            '/notifications               查看并清空通知',
            '/status                       查看路径与健康状态',
            '/exit                         退出 CLI，Runtime 继续运行',
        ].join('\n'));
    }

    /** 输出后台任务列表或单个任务日志 */
    private async printJobs (id?: string): Promise<void> {
        if (id) {
            const result = await this.dependencies.client.readJob(id);
            console.log(JSON.stringify(result.job, null, 4));
            if (result.log) {
                console.log(result.log);
            }
            return;
        }
        const jobs = await this.dependencies.client.listJobs();
        console.table(jobs.map(job => ({
            id: job.id,
            type: job.type,
            status: job.status,
            attempts: job.attempts,
            title: job.title,
        })));
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
            await this.dependencies.client.useModel({
                providerId: value.slice(0, separator),
                modelId: value.slice(separator + 1),
            });
            console.log(`已切换到 ${value}`);
            return false;
        }
        if (action !== 'list') {
            throw new Error('用法: /model list|add|use');
        }
        const bootstrap = await this.dependencies.client.bootstrap();
        if (!bootstrap.config) {
            throw new Error(bootstrap.configurationError || '配置无效');
        }
        const rows = bootstrap.config.providers.flatMap(provider =>
            provider.models.map(model => ({
                model: `${provider.id}/${model.id}`,
                active: bootstrap.config?.activeModel?.providerId === provider.id
                    && bootstrap.config.activeModel.modelId === model.id,
                protocol: provider.type,
                baseURL: provider.baseURL || 'official',
            })),
        );
        console.table(rows);
        return false;
    }

    /**
     * 处理网络搜索状态、配置与关闭
     *
     * @param args 网络搜索命令参数
     * @returns 是否进入独立交互流程
     */
    private async handleWebCommand (args: string[]): Promise<number> {
        const action = args[0] || 'status';
        if (action === 'setup') {
            return WEB_SETUP_RESULT;
        }
        if (action === 'disable') {
            await this.dependencies.client.disableWebAccess();
            console.log('网络搜索已关闭，凭证已删除');
            return -1;
        }
        if (action !== 'status') {
            throw new Error('用法: /web status|setup|disable');
        }
        const bootstrap = await this.dependencies.client.bootstrap();
        console.log(bootstrap.config?.webAccess?.configured
            ? `网络搜索已启用（${bootstrap.config.webAccess.provider}）`
            : '网络搜索尚未配置');
        return -1;
    }
}
