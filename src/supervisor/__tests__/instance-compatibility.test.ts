import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import { assertStateVersion } from '../state-version';
import { backupInstance, inspectDatabases, assertCompatibleData } from '../instance-backup';
import { acquireRuntimeLease } from '../runtime-lease';
import { WorkStore } from '../../work/work-store';
import { ExecutionStore } from '../../execution/execution-store';
import { SessionStore } from '../../session/session-store';

const roots: string[] = [];
/** 创建受保护的升级契约测试目录 */
function fixture (): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-compatible-'));
    roots.push(root);
    return root;
}
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

test('新版本数据被明确拒绝，不静默创建或降级', () => {
    const database = new Database(':memory:');
    database.run('PRAGMA user_version = 999');
    expect(() => assertStateVersion(database)).toThrow('超出当前支持范围');
    expect(database.query('PRAGMA user_version').get()).toEqual({ user_version: 999 });
    database.close();
});

test('活动 WAL 的一致性备份保留事项、执行、会话和实例技能，旧数据改写被拒绝', () => {
    const home = fixture();
    const databasePath = path.join(home, 'state.sqlite');
    const works = new WorkStore(databasePath);
    const work = works.create({ goal: '报告', acceptance: '文件核实', authority: '本地', sourceEventId: 'user:1', next: '等资料' });
    works.update(work.id, 1, { status: 'waiting', waitFor: 'user' });
    const executions = new ExecutionStore(databasePath);
    executions.accept('received', '已经接收的输入', 'foreground');
    const session = new SessionStore(path.join(home, 'sessions'));
    session.appendOnce('user:1', { role: 'user', content: '历史原文' });
    fs.mkdirSync(path.join(home, 'workspace', 'skills', 'custom'), { recursive: true });
    fs.writeFileSync(path.join(home, 'workspace', 'skills', 'custom', 'SKILL.md'), '实例自己的技能');
    const copy = fixture();
    backupInstance(home, copy);
    expect(new WorkStore(path.join(copy, 'state.sqlite')).get(work.id)?.status).toBe('waiting');
    expect(new ExecutionStore(path.join(copy, 'state.sqlite')).pending()).toHaveLength(1);
    expect(new SessionStore(path.join(copy, 'sessions')).loadTranscript()[0].content).toBe('历史原文');
    expect(fs.readFileSync(path.join(copy, 'workspace', 'skills', 'custom', 'SKILL.md'), 'utf8')).toBe('实例自己的技能');
    const before = inspectDatabases(copy);
    const database = new Database(path.join(copy, 'state.sqlite'));
    database.run('ALTER TABLE works ADD COLUMN future TEXT');
    expect(() => assertCompatibleData(before, inspectDatabases(copy))).not.toThrow();
    database.run("UPDATE works SET status = 'completed'");
    expect(() => assertCompatibleData(before, inspectDatabases(copy))).toThrow('不能改写');
    database.close();
});

test('同一实例只允许一个活动写入者', () => {
    const home = fixture();
    const release = acquireRuntimeLease(home);
    expect(() => acquireRuntimeLease(home)).toThrow('已有 Runtime');
    release();
    const next = acquireRuntimeLease(home);
    next();
});
