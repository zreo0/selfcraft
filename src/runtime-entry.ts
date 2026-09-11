import { acquireRuntimeLease } from './supervisor/runtime-lease';
import { ExecutionStore } from './execution/execution-store';
import { WorkStore } from './work/work-store';
import { WorkRunner } from './work/work-runner';
import * as path from 'node:path';
import { AgentRuntime } from './agent/agent-runtime';
import { ForegroundRunner } from './agent/foreground-runner';
import { ConfigStore } from './config/config-store';
import { resolvePaths } from './config/paths';
import { ContextManager } from './context/context-manager';
import { EvolutionService } from './evolution/evolution-service';
import { HealthChecker } from './health/health-checker';
import { JobManager } from './job/job-manager';
import { Logger } from './logging/logger';
import { MemoryStore } from './memory/memory-store';
import { ReflectionWorker } from './memory/reflection-worker';
import { ModelFactory } from './model/model-factory';
import { NotificationInbox } from './notification/notification-inbox';
import { SessionStore } from './session/session-store';
import { SkillRegistry } from './skills/skill-registry';
import { ReleaseStore } from './supervisor/release-store';
import { ScheduledTaskManager } from './task/scheduled-task-manager';
import { createTools } from './tools';
import { PathGuard } from './tools/path-guard';
import { WorkspaceService } from './workspace/workspace-service';
import { WebServer } from './web/web-server';
import { TavilyWebProvider } from './web-access/tavily-web-provider';

const RESTART_EXIT_CODE = 75;

/** 组装唯一 Runtime，并启动供各通信入口共享的 HTTP 服务 */
async function main (): Promise<void> {
    const paths = resolvePaths();
    if (!process.argv.includes('--check-state')) {
        const releaseLease = acquireRuntimeLease(paths.home);
        process.once('exit', releaseLease);
    }
    const config = new ConfigStore(paths.config);
    const logger = new Logger(paths.logs);
    const workspace = new WorkspaceService(paths.workspace, path.join(paths.project, 'workspace-template'));
    workspace.initialize();
    const skills = new SkillRegistry(path.join(paths.workspace, 'skills'));
    const session = new SessionStore(paths.sessions);
    const context = new ContextManager();
    const notifications = new NotificationInbox(paths.notifications);
    const memory = new MemoryStore(paths.state);
    const executions = new ExecutionStore(paths.state);
    const works = new WorkStore(paths.state);
    const scheduledTasks = new ScheduledTaskManager(paths.state, notifications, memory);
    const reflection = new ReflectionWorker(memory, () => ModelFactory.create(config, 'reflection', logger), logger);
    const jobs = new JobManager(
        paths.state,
        paths.jobs,
        new PathGuard(paths.workspace),
        notifications,
        logger,
    );
    const releases = new ReleaseStore(paths.supervisor, paths.evolution);
    const evolution = new EvolutionService(paths, releases, logger);
    if (process.argv.includes('--check-state')) {
        console.log('实例状态兼容检查通过');
        return;
    }
    const webProvider = new TavilyWebProvider(() => config.getWebAccess().apiKey);
    const tools = createTools(
        paths.workspace,
        skills,
        notifications,
        evolution,
        jobs,
        memory,
        scheduledTasks,
        webProvider,
        executions,
        works,
    );
    const agent = new AgentRuntime(
        config,
        workspace,
        skills,
        session,
        context,
        evolution,
        memory,
        reflection,
        tools,
        logger,
        undefined,
        executions,
        works,
    );
    const foreground = new ForegroundRunner(agent, executions, () => requestShutdown(RESTART_EXIT_CODE));
    jobs.setAgentExecutor((job, signal, onLog) => agent.runBackground(job, signal, onLog),
        job => Boolean(executions.get(`job:${job.id}`)));
    jobs.start();
    scheduledTasks.start();
    reflection.start();
    let resolveShutdown: (exitCode: number) => void = () => undefined;
    let shuttingDown = false;
    const shutdown = new Promise<number>(resolve => {
        resolveShutdown = resolve;
    });
    const requestShutdown = (exitCode: number): void => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        resolveShutdown(exitCode);
    };
    const workRunner = new WorkRunner(works, agent, foreground, jobs, memory, notifications, logger,
        () => requestShutdown(RESTART_EXIT_CODE), () => evolution.hasPendingRelease(), () => config.isConfigured());
    foreground.recover((id, error, result) => {
        notifications.pushOnce(`recovered:${id}`, error ? '中断的请求需要处理' : '中断的请求已完成',
            error ? String(error) : '已恢复处理，请查看对话历史');
        if (result?.restartRequired) {
            requestShutdown(RESTART_EXIT_CODE);
        }
    });
    workRunner.start();
    const web = new WebServer({
        paths,
        config,
        agent: foreground,
        memory,
        skills,
        notifications,
        jobs,
        scheduledTasks,
        health: new HealthChecker(),
        logger,
        staticDirectory: path.join(paths.project, 'web', 'dist'),
        onRestart: () => requestShutdown(RESTART_EXIT_CODE),
    });
    const address = web.start();
    console.log(`Selfcraft Runtime 已就绪：${address.url}`);
    console.log('Web 可直接访问；终端入口请在另一个终端运行 bun run cli');
    const handleSigint = (): void => requestShutdown(0);
    const handleSigterm = (): void => requestShutdown(0);
    process.once('SIGINT', handleSigint);
    process.once('SIGTERM', handleSigterm);
    try {
        process.exitCode = await shutdown;
    } finally {
        process.off('SIGINT', handleSigint);
        process.off('SIGTERM', handleSigterm);
        foreground.stop();
        jobs.stop();
        workRunner.stop();
        web.stop();
        scheduledTasks.stop();
        reflection.stop();
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
