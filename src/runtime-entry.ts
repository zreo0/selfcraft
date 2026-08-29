import * as path from 'node:path';
import { AgentRuntime } from './agent/agent-runtime';
import { Cli } from './cli/cli';
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
import { Onboarding } from './onboarding/onboarding';
import { SessionStore } from './session/session-store';
import { SkillRegistry } from './skills/skill-registry';
import { ReleaseStore } from './supervisor/release-store';
import { ScheduledTaskManager } from './task/scheduled-task-manager';
import { createTools } from './tools';
import { PathGuard } from './tools/path-guard';
import { WorkspaceService } from './workspace/workspace-service';

/** 组装可变 Runtime 并启动当前 CLI 适配器 */
async function main (): Promise<void> {
    const paths = resolvePaths();
    const args = process.argv.slice(2);
    if (args[0] === 'reset-config') {
        if (!process.stdin.isTTY) {
            throw new Error('重置配置需要交互式终端，请运行 bun run start reset-config');
        }
        const config = new ConfigStore(paths.config);
        await new Onboarding(paths, config).reset();
        return;
    }

    const logger = new Logger(paths.logs);
    const workspace = new WorkspaceService(paths.workspace, path.join(paths.project, 'workspace-template'));
    workspace.initialize();
    const config = new ConfigStore(paths.config);
    const skills = new SkillRegistry(path.join(paths.workspace, 'skills'));
    const session = new SessionStore(paths.sessions);
    const context = new ContextManager();
    const notifications = new NotificationInbox(paths.notifications);
    const memory = new MemoryStore(paths.state);
    const scheduledTasks = new ScheduledTaskManager(paths.state, notifications, memory);
    const reflection = new ReflectionWorker(memory, () => ModelFactory.create(config), logger);
    const jobs = new JobManager(
        paths.state,
        paths.jobs,
        new PathGuard(paths.workspace),
        notifications,
        logger,
    );
    const releases = new ReleaseStore(paths.supervisor, paths.evolution);
    const evolution = new EvolutionService(paths, releases, logger);
    const tools = createTools(
        paths.workspace,
        skills,
        notifications,
        evolution,
        jobs,
        memory,
        scheduledTasks,
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
    );
    jobs.setAgentExecutor((job, signal, onLog) => agent.runBackground(job, signal, onLog));
    jobs.start();
    scheduledTasks.start();
    if (config.isConfigured()) {
        reflection.start();
    }
    const onboarding = new Onboarding(paths, config);
    const cli = new Cli({
        paths,
        config,
        onboarding,
        agent,
        skills,
        notifications,
        jobs,
        scheduledTasks,
        memory,
        health: new HealthChecker(),
    });
    try {
        process.exitCode = await cli.start(args);
    } finally {
        scheduledTasks.stop();
        reflection.stop();
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
