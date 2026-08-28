import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { MemoryStore } from '../../memory/memory-store';
import { NotificationInbox } from '../../notification/notification-inbox';
import { ScheduledTaskManager } from '../../task/scheduled-task-manager';
import { createScheduledTaskTools } from '../scheduled-task-tools';

const temporaryDirectories: string[] = [];

interface ToolTaskResult {
    /** 提醒标识 */
    id: string;
    /** 提醒标题 */
    title: string;
    /** 当前状态 */
    status: 'scheduled' | 'running' | 'completed' | 'cancelled' | 'failed';
    /** UTC 到期时间 */
    dueAt: string;
    /** 用户时区 */
    timezone: string;
    /** 用户原始时间表达式 */
    originalExpression: string;
}

/** 创建并追踪测试临时目录 */
function createTemporaryDirectory (): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-scheduled-task-tools-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('scheduled task tools', () => {
    test('使用可信工具上下文创建、列出和取消提醒', async () => {
        const root = createTemporaryDirectory();
        const statePath = path.join(root, 'state.sqlite');
        const memory = new MemoryStore(statePath);
        const topic = memory.createTopic({ title: '体检安排', kind: 'health' });
        const createSource = memory.recordEvent({
            actor: 'user',
            type: 'user_message',
            payload: '明年三月提醒我准备体检材料',
            runId: 'run-create-reminder',
            timezone: 'Asia/Shanghai',
        });
        const manager = new ScheduledTaskManager(
            statePath,
            new NotificationInbox(path.join(root, 'notifications.jsonl')),
            memory,
        );
        const tools = createScheduledTaskTools(manager);
        const createResult = await tools.task_schedule.execute!({
            title: '准备体检材料',
            message: '整理检查报告和药物清单',
            dueAt: '2099-03-02T09:00:00+08:00',
            originalExpression: '2099 年 3 月 2 日上午九点',
            sourceEventId: 'forged-source',
            timezone: 'Mars/Olympus',
        } as never, {
            toolCallId: 'tool-create',
            messages: [],
            context: {
                runId: 'run-create-reminder',
                sourceEventId: createSource.id,
                timezone: 'Asia/Shanghai',
                channel: 'foreground',
                topicIds: [topic.id],
            },
        }) as ToolTaskResult;

        expect(createResult).toEqual({
            id: expect.any(String),
            title: '准备体检材料',
            status: 'scheduled',
            dueAt: '2099-03-02T01:00:00.000Z',
            timezone: 'Asia/Shanghai',
            originalExpression: '2099 年 3 月 2 日上午九点',
        });
        const replayed = await tools.task_schedule.execute!({
            title: '准备体检材料',
            message: '整理检查报告和药物清单',
            dueAt: '2099-03-02T09:00:00+08:00',
            originalExpression: '2099 年 3 月 2 日上午九点',
        }, {
            toolCallId: 'tool-create',
            messages: [],
            context: {
                runId: 'run-create-reminder',
                sourceEventId: createSource.id,
                timezone: 'Asia/Shanghai',
                channel: 'foreground',
                topicIds: [topic.id],
            },
        }) as ToolTaskResult;
        expect(replayed).toEqual(createResult);
        expect(manager.list()).toHaveLength(1);
        const task = manager.get(createResult.id)!;
        expect(task).toMatchObject({
            runId: 'run-create-reminder',
            sourceEventId: createSource.id,
            timezone: 'Asia/Shanghai',
            topicIds: [topic.id],
        });
        const created = memory.listEventsByRun('run-create-reminder')
            .find(event => event.type === 'task_created');
        expect(created).toMatchObject({
            actor: 'system',
            sourceEventId: createSource.id,
            topicIds: [topic.id],
            payload: {
                title: '准备体检材料',
                status: 'scheduled',
                timezone: 'Asia/Shanghai',
            },
        });

        const listResult = await tools.task_list.execute!({ limit: 10 }, {
            toolCallId: 'tool-list',
            messages: [],
            context: {
                runId: 'run-list-reminder',
                sourceEventId: createSource.id,
                timezone: 'Asia/Shanghai',
                channel: 'foreground',
            },
        }) as ToolTaskResult[];
        expect(listResult).toEqual([createResult]);

        const cancelSource = memory.recordEvent({
            actor: 'user',
            type: 'user_message',
            payload: '取消刚才的提醒',
            runId: 'run-cancel-reminder',
            timezone: 'Asia/Tokyo',
        });
        const cancelResult = await tools.task_cancel.execute!({ id: task.id }, {
            toolCallId: 'tool-cancel',
            messages: [],
            context: {
                runId: 'run-cancel-reminder',
                sourceEventId: cancelSource.id,
                timezone: 'Asia/Tokyo',
                channel: 'foreground',
                topicIds: [topic.id],
            },
        }) as ToolTaskResult;
        expect(cancelResult).toEqual({
            ...createResult,
            status: 'cancelled',
        });
        expect(memory.listEventsByRun('run-cancel-reminder')
            .find(event => event.type === 'task_cancelled')).toMatchObject({
            sourceEventId: cancelSource.id,
            timezone: 'Asia/Tokyo',
            topicIds: [topic.id],
        });
    });

    test('模型输入 Schema 不暴露可信来源字段并拒绝相对时间', () => {
        const tools = createScheduledTaskTools({} as ScheduledTaskManager);
        const schema = tools.task_schedule.inputSchema as z.ZodType<{
            title: string;
            message: string;
            dueAt: string;
            originalExpression: string;
        }>;

        const parsed = schema.safeParse({
            title: '测试提醒',
            message: '测试正文',
            dueAt: '2099-01-01T00:00:00Z',
            originalExpression: '2099 年元旦',
            runId: 'forged-run',
            sourceEventId: 'forged-source',
            timezone: 'Mars/Olympus',
        });
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data).not.toHaveProperty('runId');
            expect(parsed.data).not.toHaveProperty('sourceEventId');
            expect(parsed.data).not.toHaveProperty('timezone');
        }
        expect(schema.safeParse({
            title: '测试提醒',
            message: '测试正文',
            dueAt: '明天上午九点',
            originalExpression: '明天上午九点',
        }).success).toBe(false);
    });
});
