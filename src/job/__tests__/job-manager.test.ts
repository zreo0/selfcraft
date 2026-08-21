import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JobManager } from '../job-manager';
import { Logger } from '../../logging/logger';
import { NotificationInbox } from '../../notification/notification-inbox';
import { PathGuard } from '../../tools/path-guard';

const temporaryDirectories: string[] = [];

/** 创建并追踪测试临时目录 */
function createTemporaryDirectory (): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-job-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('JobManager', () => {
    test('并发执行多个 Agent 任务并持久化通知', async () => {
        const root = createTemporaryDirectory();
        const workspace = path.join(root, 'workspace');
        fs.mkdirSync(workspace, { recursive: true });
        const notifications = new NotificationInbox(path.join(root, 'notifications.jsonl'));
        const manager = new JobManager(
            path.join(root, 'state.sqlite'),
            path.join(root, 'jobs'),
            new PathGuard(workspace),
            notifications,
            new Logger(path.join(root, 'logs')),
            2,
        );
        let active = 0;
        let maximumActive = 0;
        manager.setAgentExecutor(async (job, _signal, onLog) => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            onLog(`working ${job.id}\n`);
            await Bun.sleep(30);
            active -= 1;
            return 'done';
        });
        manager.start();

        const first = manager.createAgent('第一个长任务', '完成第一个目标');
        const second = manager.createAgent('第二个长任务', '完成第二个目标');
        await manager.waitForIdle();

        expect(maximumActive).toBe(2);
        expect(manager.get(first.id)?.status).toBe('completed');
        expect(manager.get(second.id)?.status).toBe('completed');
        expect(manager.readLog(first.id).log).toContain('working');
        expect(notifications.list()).toHaveLength(2);
    });

    test('Shell 任务在 workspace 后台执行并记录退出状态', async () => {
        const root = createTemporaryDirectory();
        const workspace = path.join(root, 'workspace');
        fs.mkdirSync(path.join(workspace, 'files'), { recursive: true });
        const manager = new JobManager(
            path.join(root, 'state.sqlite'),
            path.join(root, 'jobs'),
            new PathGuard(workspace),
            new NotificationInbox(path.join(root, 'notifications.jsonl')),
            new Logger(path.join(root, 'logs')),
        );
        manager.start();

        const job = manager.createShell('写入后台文件', "printf 'background-ok' > files/job.txt");
        await manager.waitForIdle();

        expect(manager.get(job.id)?.status).toBe('completed');
        expect(manager.get(job.id)?.exitCode).toBe(0);
        expect(fs.readFileSync(path.join(workspace, 'files', 'job.txt'), 'utf8')).toBe('background-ok');
    });

    test('未启动的持久队列可由新 Runtime 继续', async () => {
        const root = createTemporaryDirectory();
        const workspace = path.join(root, 'workspace');
        fs.mkdirSync(workspace, { recursive: true });
        const statePath = path.join(root, 'state.sqlite');
        const jobsPath = path.join(root, 'jobs');
        const inboxPath = path.join(root, 'notifications.jsonl');
        const first = new JobManager(
            statePath,
            jobsPath,
            new PathGuard(workspace),
            new NotificationInbox(inboxPath),
            new Logger(path.join(root, 'logs')),
        );
        const job = first.createAgent('跨重启任务', '继续执行');
        expect(first.get(job.id)?.status).toBe('queued');

        const restored = new JobManager(
            statePath,
            jobsPath,
            new PathGuard(workspace),
            new NotificationInbox(inboxPath),
            new Logger(path.join(root, 'logs')),
        );
        restored.setAgentExecutor(async () => '恢复完成');
        restored.start();
        await restored.waitForIdle();

        expect(restored.get(job.id)?.status).toBe('completed');
    });
});
