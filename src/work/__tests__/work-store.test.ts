import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkStore, WORK_STEP_BUDGET } from '../work-store';
import { NotificationInbox } from '../../notification/notification-inbox';

const roots: string[] = [];
/** 创建隔离事项库与原始目标 */
function fixture () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-work-'));
    roots.push(root);
    const file = path.join(root, 'state.sqlite');
    const works = new WorkStore(file);
    const work = works.create({ goal: '整理报告', acceptance: '核实资料并交付文件', authority: '仅本地整理', sourceEventId: 'user:1', next: '等待资料' });
    return { root, file, works, work };
}
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

test('事项等待跨重启保留，时间未到不唤醒，时间到只推进一次', () => {
    const { works, work, file } = fixture();
    const waiting = works.update(work.id, 1, { status: 'waiting', waitFor: 'time', wakeAt: '2099-01-01T00:00:00Z', next: '核实资料' });
    const restored = new WorkStore(file);
    restored.wake(() => null, Date.parse('2098-01-01'));
    expect(restored.claim()).toBeNull();
    restored.wake(() => null, Date.parse('2099-01-01'));
    restored.wake(() => null, Date.parse('2099-01-01'));
    expect(restored.claim()?.revision).toBe(waiting.revision + 1);
});

test('用户改变要求后拒绝旧执行完成事项，原 Job 结果不能覆盖新目标', () => {
    const { works, work } = fixture();
    const waiting = works.update(work.id, 1, { status: 'waiting', waitFor: 'job', jobId: 'job:1', next: '等执行结果' });
    works.update(work.id, waiting.revision, { status: 'ready', goal: '改为简报', next: '按新要求处理' }, true);
    expect(() => works.update(work.id, waiting.revision, { status: 'completed', evidence: '旧报告完成' })).toThrow('事项已改变');
    works.wake(() => ({ status: 'completed', evidence: '旧报告' }));
    expect(works.get(work.id)?.goal).toBe('改为简报');
    expect(works.get(work.id)?.evidence).toBe('');
});

test('后台成功只唤醒验收，不直接完成用户目标', () => {
    const { works, work } = fixture();
    works.update(work.id, 1, { status: 'waiting', waitFor: 'job', jobId: 'job:1', next: '验收报告' });
    works.wake(() => ({ status: 'completed', evidence: 'files/report.md' }));
    expect(works.get(work.id)?.status).toBe('ready');
    expect(works.get(work.id)?.evidence).toContain('files/report.md');
    expect(() => works.update(work.id, 3, { status: 'completed' })).not.toThrow();
});

test('没有验证依据不能完成；完成与通知在同一事务保留且已读通知不重复出现', () => {
    const { root, works, work, file } = fixture();
    expect(() => works.update(work.id, 1, { status: 'completed' })).toThrow('验证依据');
    works.update(work.id, 1, { status: 'completed', evidence: '文件存在且已核对内容', next: '' });
    const restored = new WorkStore(file);
    const [notification] = restored.notifications();
    const inbox = new NotificationInbox(path.join(root, 'notifications.jsonl'));
    inbox.pushOnce(notification.id, notification.title, notification.message);
    inbox.clear();
    // 模拟通知写入后、确认 outbox 前崩溃
    inbox.pushOnce(notification.id, notification.title, notification.message);
    restored.acknowledge(notification.id);
    expect(inbox.list()).toHaveLength(0);
    expect(restored.notifications()).toHaveLength(0);
});

test('同一条件下自动推进有预算，等待用户不会自行循环', () => {
    const { works, work } = fixture();
    const claimed = works.claim()!;
    for (let index = 0; index < WORK_STEP_BUDGET; index += 1) {
        works.recordStep(work.id);
    }
    works.update(work.id, claimed.revision, { status: 'ready', next: '继续' });
    expect(works.claim()).toBeNull();
    expect(works.get(work.id)?.status).toBe('blocked');
    expect(works.notifications()).toHaveLength(1);
});

test('创建时即可等待，不会提前领取；要求版本与执行进度独立', () => {
    const { works } = fixture();
    const work = works.create({ goal: '下周整理周报', acceptance: '写完周报', authority: '本地写入', sourceEventId: 'user:2', next: '到时开始',
        waitFor: 'time', wakeAt: '2099-01-01T00:00:00Z' });
    expect(work.status).toBe('waiting');
    works.recordStep(work.id);
    expect(works.get(work.id)?.instructionVersion).toBe(1);
    works.wake(() => null, Date.parse('2099-01-01'));
    const ready = works.get(work.id)!;
    expect(ready.status).toBe('ready');
    const progress = works.update(work.id, ready.revision, { evidence: '已开始' });
    expect(progress.instructionVersion).toBe(ready.instructionVersion);
    expect(works.notifications()).toHaveLength(0);
});

test('主脑主动取消不会再通知自己，重新开启沿用事项且获得新预算', () => {
    const { works, work } = fixture();
    works.recordStep(work.id);
    const cancelled = works.update(work.id, work.revision, { status: 'cancelled', next: '用户不再需要' }, true);
    expect(works.notifications()).toHaveLength(0);
    const reopened = works.update(work.id, cancelled.revision, { status: 'ready', next: '继续原事项' }, true);
    expect(reopened.id).toBe(work.id);
    expect(reopened.steps).toBe(0);
});
