import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Notification } from '../../notification/notification-inbox';
import { MemoryStore } from '../../memory/memory-store';
import { NotificationInbox } from '../../notification/notification-inbox';
import {
    ScheduledTaskManager,
    type ScheduledTaskEventStore,
} from '../scheduled-task-manager';

const temporaryDirectories: string[] = [];

/** 创建并追踪测试临时目录 */
function createTemporaryDirectory (): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-scheduled-task-'));
    temporaryDirectories.push(directory);
    return directory;
}

/** 收集提醒生命周期事件的测试存储 */
class FakeEventStore implements ScheduledTaskEventStore {
    /** 已写入事件 */
    public readonly events: Array<Parameters<ScheduledTaskEventStore['recordEvent']>[0]> = [];

    /**
     * 保存一条测试事件
     *
     * @param event 生命周期事件
     * @returns 测试事件标识
     */
    public recordEvent (event: Parameters<ScheduledTaskEventStore['recordEvent']>[0]): { id: string } {
        this.events.push(event);
        return { id: `event-${this.events.length}` };
    }
}

/** 始终拒绝写入通知的测试收件箱 */
class FailingNotificationInbox extends NotificationInbox {
    /**
     * 模拟通知介质失败
     *
     * @returns 不会返回
     */
    public override pushOnce (): Notification {
        throw new Error('通知介质不可用');
    }
}

/** 在投递后模拟审计事件写入失败 */
class FailingLifecycleEventStore extends FakeEventStore {
    /**
     * 允许创建事件写入并拒绝后续审计事件
     *
     * @param event 待写入的生命周期事件
     * @returns 创建事件的测试标识
     */
    public override recordEvent (
        event: Parameters<ScheduledTaskEventStore['recordEvent']>[0],
    ): { id: string } {
        if (event.type !== 'task_created') {
            throw new Error('审计存储不可用');
        }
        return super.recordEvent(event);
    }
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('ScheduledTaskManager', () => {
    test('创建、查询并取消尚未到期的提醒', () => {
        const root = createTemporaryDirectory();
        const events = new FakeEventStore();
        const manager = new ScheduledTaskManager(
            path.join(root, 'state.sqlite'),
            new NotificationInbox(path.join(root, 'notifications.jsonl')),
            events,
        );

        const task = manager.create({
            title: '复查前准备材料',
            message: '带上检查报告和药物清单',
            dueAt: '2099-03-02T01:00:00+08:00',
            timezone: 'Asia/Shanghai',
            originalExpression: '2099 年 3 月 2 日上午 9 点',
            sourceEventId: 'event-source',
            topicIds: ['topic-health', 'topic-health', ''],
        });

        expect(manager.get(task.id)).toMatchObject({
            dueAt: '2099-03-01T17:00:00.000Z',
            timezone: 'Asia/Shanghai',
            originalExpression: '2099 年 3 月 2 日上午 9 点',
            sourceEventId: 'event-source',
            topicIds: ['topic-health'],
            status: 'scheduled',
        });
        expect(manager.list()).toHaveLength(1);
        expect(manager.cancel(task.id)).toBe(true);
        expect(manager.cancel(task.id)).toBe(false);
        expect(manager.get(task.id)?.status).toBe('cancelled');
        expect(events.events.map(event => event.type)).toEqual(['task_created', 'task_cancelled']);
        expect(events.events[0]?.idempotencyKey).toBe(`scheduled-task:${task.id}:task_created`);
    });

    test('执行到期提醒并写入完整生命周期', () => {
        const root = createTemporaryDirectory();
        const notifications = new NotificationInbox(path.join(root, 'notifications.jsonl'));
        const events = new FakeEventStore();
        const manager = new ScheduledTaskManager(
            path.join(root, 'state.sqlite'),
            notifications,
            events,
        );
        const task = manager.create({
            title: '喝水',
            message: '现在喝一杯水',
            dueAt: '2000-01-01T00:00:00Z',
            timezone: 'Asia/Shanghai',
            originalExpression: '现在',
        });

        expect(manager.runDue()).toBe(1);
        expect(manager.runDue()).toBe(0);
        expect(manager.get(task.id)?.status).toBe('completed');
        expect(notifications.list()).toEqual([
            expect.objectContaining({
                id: `scheduled-task:${task.id}`,
                title: '喝水',
                message: '现在喝一杯水',
            }),
        ]);
        expect(events.events.map(event => event.type)).toEqual([
            'task_created',
            'task_triggered',
            'task_completed',
        ]);
    });

    test('活动提醒优先于已经完成的历史记录', () => {
        const root = createTemporaryDirectory();
        const manager = new ScheduledTaskManager(
            path.join(root, 'state.sqlite'),
            new NotificationInbox(path.join(root, 'notifications.jsonl')),
            new FakeEventStore(),
        );
        manager.create({
            title: '旧提醒',
            message: '已经完成',
            dueAt: '2000-01-01T00:00:00Z',
            timezone: 'UTC',
            originalExpression: '很久以前',
        });
        manager.runDue();
        const future = manager.create({
            title: '未来提醒',
            message: '仍需处理',
            dueAt: '2099-01-01T00:00:00Z',
            timezone: 'UTC',
            originalExpression: '未来',
        });

        expect(manager.list(1).map(task => task.id)).toEqual([future.id]);
    });

    test('审计事件失败不会把已经送达的提醒改写成失败', () => {
        const root = createTemporaryDirectory();
        const notifications = new NotificationInbox(path.join(root, 'notifications.jsonl'));
        const events = new FailingLifecycleEventStore();
        const manager = new ScheduledTaskManager(
            path.join(root, 'state.sqlite'),
            notifications,
            events,
        );
        const task = manager.create({
            title: '已送达提醒',
            message: '审计失败也不能否认投递事实',
            dueAt: '2000-01-01T00:00:00Z',
            timezone: 'UTC',
            originalExpression: '现在',
        });

        expect(manager.runDue()).toBe(1);
        expect(manager.get(task.id)?.status).toBe('completed');
        expect(notifications.list()).toHaveLength(1);
        expect(events.events.map(event => event.type)).toEqual(['task_created']);
    });

    test('原始来源被删除后仍能按 taskId 投递提醒', () => {
        const root = createTemporaryDirectory();
        const statePath = path.join(root, 'state.sqlite');
        const memory = new MemoryStore(statePath);
        const source = memory.recordEvent({
            actor: 'user',
            type: 'user_message',
            payload: '提醒我喝水',
        });
        const notifications = new NotificationInbox(path.join(root, 'notifications.jsonl'));
        const manager = new ScheduledTaskManager(statePath, notifications, memory);
        const task = manager.create({
            title: '喝水',
            message: '现在喝一杯水',
            dueAt: '2000-01-01T00:00:00Z',
            timezone: 'UTC',
            originalExpression: '现在',
            sourceEventId: source.id,
            runId: 'run-create',
        });

        expect(memory.eraseEvent(source.id).erased).toBe(true);
        expect(manager.runDue()).toBe(1);
        expect(manager.get(task.id)?.status).toBe('completed');
        expect(memory.recallEpisode({ from: '1999-01-01', to: '2100-01-01' }).events
            .filter(event => event.taskId === task.id)
            .map(event => event.type)).toEqual([
            'task_created',
            'task_triggered',
            'task_completed',
        ]);
    });

    test('启动时恢复 running 并补扫过期提醒且不重复通知', () => {
        const root = createTemporaryDirectory();
        const statePath = path.join(root, 'state.sqlite');
        const notifications = new NotificationInbox(path.join(root, 'notifications.jsonl'));
        const events = new FakeEventStore();
        const manager = new ScheduledTaskManager(statePath, notifications, events, 50);
        const task = manager.create({
            title: '恢复后的提醒',
            message: 'Runtime 重启后仍应看到',
            dueAt: '2000-01-01T00:00:00Z',
            timezone: 'UTC',
            originalExpression: '很久以前',
            topicIds: ['topic-recovery'],
        });
        notifications.pushOnce(task.notificationId, task.title, task.message);
        const database = new Database(statePath);
        database.query(`
            UPDATE scheduled_tasks SET status = 'running', started_at = ? WHERE id = ?
        `).run(new Date().toISOString(), task.id);
        database.close();

        manager.start();
        manager.stop();

        expect(manager.get(task.id)?.status).toBe('completed');
        expect(notifications.list()).toHaveLength(1);
        expect(events.events.map(event => event.type)).toEqual([
            'task_created',
            'task_triggered',
            'task_completed',
        ]);
    });

    test('稳定通知标识使重复写入返回同一条记录', () => {
        const root = createTemporaryDirectory();
        const notifications = new NotificationInbox(path.join(root, 'notifications.jsonl'));

        const first = notifications.pushOnce('stable-notification', '第一次', '相同提醒');
        const second = notifications.pushOnce('stable-notification', '第二次', '不应覆盖');

        expect(second).toEqual(first);
        expect(notifications.list()).toEqual([first]);
    });

    test('通知失败时进入 failed 并记录失败事件', () => {
        const root = createTemporaryDirectory();
        const events = new FakeEventStore();
        const manager = new ScheduledTaskManager(
            path.join(root, 'state.sqlite'),
            new FailingNotificationInbox(path.join(root, 'notifications.jsonl')),
            events,
        );
        const task = manager.create({
            title: '无法投递的提醒',
            message: '通知介质将失败',
            dueAt: '2000-01-01T00:00:00Z',
            timezone: 'UTC',
            originalExpression: '现在',
        });

        expect(manager.runDue()).toBe(1);
        expect(manager.get(task.id)).toMatchObject({
            status: 'failed',
            error: '通知介质不可用',
        });
        expect(events.events.map(event => event.type)).toEqual(['task_created', 'task_failed']);
    });

    test('拒绝无效绝对时间和时区', () => {
        const root = createTemporaryDirectory();
        const manager = new ScheduledTaskManager(
            path.join(root, 'state.sqlite'),
            new NotificationInbox(path.join(root, 'notifications.jsonl')),
            new FakeEventStore(),
        );

        expect(() => manager.create({
            title: '无效时间',
            message: '不会创建',
            dueAt: '明天',
            timezone: 'Asia/Shanghai',
            originalExpression: '明天',
        })).toThrow('提醒到期时间必须是包含时区的绝对 ISO 时间');
        expect(() => manager.create({
            title: '无效时区',
            message: '不会创建',
            dueAt: '2099-01-01T00:00:00Z',
            timezone: 'Mars/Olympus',
            originalExpression: '火星时间',
        })).toThrow('提醒时区无效');
        expect(() => manager.create({
            title: '不存在的日期',
            message: '不会被静默延后到三月',
            dueAt: '2026-02-30T09:00:00Z',
            timezone: 'UTC',
            originalExpression: '二月三十日',
        })).toThrow('提醒到期时间无效');
        expect(() => manager.create({
            title: '缺少时区',
            message: '不会创建',
            dueAt: '2099-01-01T09:00:00',
            timezone: 'Asia/Shanghai',
            originalExpression: '2099 年元旦上午九点',
        })).toThrow('提醒到期时间必须是包含时区的绝对 ISO 时间');
    });
});
