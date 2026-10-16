import { Database } from 'bun:sqlite';
import { isSubmissionSummary, messageSubmission, receiptSummary, submissionText } from '../submission-summary';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { InteractionStore } from '../interaction-store';
import { normalizeValues, parseInteraction } from '../protocol';
import { ConversationStore } from '../../conversation/conversation-store';
import { ExecutionStore } from '../../execution/execution-store';
import { ForegroundRunner } from '../../agent/foreground-runner';

const roots: string[] = [];
const source = 'root = Form("selection", "选择目标", "请选择", [Choice("goal", "目标", true, [{value:"speed",label:"速度",description:"快"},{value:"quality",label:"质量",description:"好"}]), Multiple("extras", "附加项", false, [{value:"a",label:"甲",description:""},{value:"b",label:"乙",description:""}]), Answer("note", "说明", false)])';

/** 创建独立数据库以模拟进程重开和多连接竞争 */
function fixture () {
    const root = mkdtempSync(join(tmpdir(), 'selfcraft-ui-'));
    roots.push(root);
    const file = join(root, 'state.sqlite');
    return { file, store: new InteractionStore(file), conversation: new ConversationStore(file), executions: new ExecutionStore(file) };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('静态组件正确派生三端字段，拒绝未知组件、动态表达式、重复字段和不完整内容', () => {
    const parsed = parseInteraction(source);
    expect(parsed.fields.map(field => field.type)).toEqual(['single-select', 'multi-select', 'text']);
    expect(normalizeValues(parsed, { goal: 'speed', extras: ['b', 'a', 'a'], note: '  hi  ' }, true))
        .toEqual({ goal: 'speed', extras: ['a', 'b'], note: 'hi' });
    for (const invalid of [source.replace('Choice(', 'Script('), source.replace('true,', '$enabled,'), source.slice(0, -3),
        source.replace('"note"', '"goal"'), source.replace('value:"quality"', 'value:"speed"'),
        'root = Form("selection", "标题", "", [])']) expect(() => parseInteraction(invalid)).toThrow();
    expect(() => normalizeValues(parsed, { goal: 'unknown' }, true)).toThrow();
    expect(() => normalizeValues(parsed, {}, true)).toThrow();
    expect(() => normalizeValues(parsed, { goal: 'speed', execute: 'rm' }, true)).toThrow();
});

test('草稿按版本互斥；提交持久幂等、内容绑定与一次性消费', () => {
    const { file, store } = fixture();
    const view = store.present('run', 'call', source);
    const other = new InteractionStore(file);
    const draft = store.saveDraft(view.id, { expectedRevision: 1, values: { goal: 'quality' } });
    expect(() => other.saveDraft(view.id, { expectedRevision: 1, values: { goal: 'speed' } })).toThrow('交互已变化');
    const request = { submissionId: randomUUID(), expectedRevision: draft.revision, actionId: 'submit', values: { goal: 'quality', extras: ['b', 'a'] } };
    const receipt = store.submit(view.id, request);
    expect(other.submit(view.id, { ...request, values: { extras: ['a', 'b', 'a'], goal: 'quality' } })).toEqual(receipt);
    expect(other.receipt(request.submissionId)).toEqual(receipt);
    expect(() => other.submit(view.id, { ...request, values: { goal: 'speed' } })).toThrow('提交标识');
    expect(() => other.submit(view.id, { ...request, submissionId: randomUUID() })).toThrow('交互已变化');
    expect(other.present('run', 'call', source).status).toBe('submitted');
    expect(other.list().items).toHaveLength(0);
});

test('崩溃后补齐消息和提交投递，重复恢复不再次执行且 SSE 游标能补读旧卡片更新', async () => {
    const { file, store, conversation, executions } = fixture();
    const view = store.present('run', 'call', source);
    expect(conversation.page().items).toHaveLength(0);
    new InteractionStore(file).reconcile(conversation);
    const cursor = conversation.changes(0).cursor;
    const receipt = store.submit(view.id, { submissionId: randomUUID(), expectedRevision: 1, actionId: 'submit', values: { goal: 'speed' } });
    let runs = 0;
    const runner = new ForegroundRunner({ async run (_input, emit, options) {
        runs++; executions.begin(options!.executionId!);
        emit?.({ type: 'text-delta', delta: '收到回答' });
        executions.setStatus(options!.executionId!, 'completed');
        return { restartRequired: false };
    } }, executions, undefined, conversation);
    const restored = new InteractionStore(file);
    restored.reconcile(conversation, runner);
    restored.reconcile(conversation, runner);
    await Bun.sleep(10);
    new InteractionStore(file).reconcile(new ConversationStore(file), runner);
    expect(runs).toBe(1);
    expect(runner.receipt(receipt.executionId)?.status).toBe('completed');
    expect(conversation.page().items.filter(message => message.id === `assistant:ui:${view.id}`)).toHaveLength(1);
    const update = conversation.changes(cursor).items.find(message => message.id === `assistant:ui:${view.id}`)!;
    expect(update.parts.find(part => part.type === 'data-ui')?.data.status).toBe('submitted');
    conversation.begin('run', '恢复中的正文');
    expect(conversation.page().items.find(message => message.id === update.id)?.parts).toEqual(update.parts);
});

test('已接收执行与未标记投递的间隙恢复也不重复执行', async () => {
    const { file, store, conversation, executions } = fixture();
    const view = store.present('run', 'call', source);
    const receipt = store.submit(view.id, { submissionId: randomUUID(), expectedRevision: 1, actionId: 'submit', values: { goal: 'speed' } });
    executions.accept(receipt.executionId, receipt.input, 'foreground');
    let runs = 0;
    const runner = new ForegroundRunner({ async run (_input, _emit, options) {
        runs++; executions.begin(options!.executionId!); return { restartRequired: false };
    } }, executions, undefined, conversation);
    new InteractionStore(file).reconcile(conversation, runner);
    expect(runs).toBe(0);
    runner.recover(() => undefined);
    await Bun.sleep(10);
    expect(runs).toBe(1);
});

test('展示工具在持久化前后中断均可恢复，历史外待回答列表可分页', () => {
    const { store, conversation, executions } = fixture();
    executions.accept('run', '展示问题', 'foreground');
    executions.begin('run');
    executions.startTool('run', 'call', 'present_ui', { source });
    store.recoverTools();
    store.recoverTools();
    store.reconcile(conversation);
    expect(executions.begin('run')?.status).not.toBe('blocked');
    for (let index = 0; index < 55; index++) store.present('run', String(index), source);
    const first = store.list();
    expect(first.items).toHaveLength(50);
    expect(store.list(first.nextCursor!).items).toHaveLength(6);
    expect(conversation.page().items).toHaveLength(1);
});

test('新旧提交摘要持久化并通过增量恢复，保留原文及顺序，不误识别普通消息', () => {
    const { file, store, conversation } = fixture();
    const view = store.present('run', 'call', source);
    const request = { submissionId: randomUUID(), expectedRevision: 1, actionId: 'submit',
        values: { goal: 'quality', extras: ['b', 'a'], note: '长答案\n第二行 <script>' } };
    const receipt = store.submit(view.id, request);
    // 模拟旧版已经投递但没有摘要的消息，以及粘贴相同内容的普通用户消息
    conversation.receive(receipt.executionId, receipt.input);
    conversation.receive('ordinary', receipt.input);
    const database = new Database(file);
    database.query('UPDATE conversation_ui_submissions SET delivered = 1 WHERE id = ?').run(receipt.submissionId);
    database.close();
    const before = conversation.get(`user:${receipt.executionId}`)!;
    const cursor = conversation.changes(0).cursor;
    store.reconcile(conversation);
    const restored = new ConversationStore(file);
    const message = restored.get(before.id)!;
    const summary = messageSubmission(message)!;
    expect(summary.title).toBe('选择目标');
    expect(summary.answers).toEqual([
        { field: '目标', answer: ['质量'] }, { field: '附加项', answer: ['甲', '乙'] },
        { field: '说明', answer: ['长答案\n第二行 <script>'] },
    ]);
    expect(submissionText(summary)).toBe('选择目标 · 已提交\n目标：质量\n附加项：甲、乙\n说明：长答案\n第二行 <script>');
    expect(message.metadata).toEqual(before.metadata);
    expect(message.parts[0]).toEqual(before.parts[0]);
    expect(messageSubmission(restored.get('user:ordinary')!)).toBeNull();
    expect(restored.changes(cursor).items.some(item => item.id === message.id)).toBe(true);
    const updated = restored.changes(0).cursor;
    new InteractionStore(file).reconcile(restored);
    expect(restored.changes(updated).items).toEqual([]);
    expect(store.submit(view.id, request)).toEqual(receipt);
    expect(restored.page().items.filter(item => item.id === message.id)).toHaveLength(1);
});

test('摘要只接受关联正确的持久回执，未知版本和损坏数据保留原文', () => {
    const { store, conversation } = fixture();
    const view = store.present('run', 'call', source);
    const receipt = store.submit(view.id, { submissionId: randomUUID(), expectedRevision: 1, actionId: 'submit', values: { goal: 'speed' } });
    const summary = receiptSummary(receipt)!;
    expect(submissionText(summary)).toContain('说明：未填写');
    expect(receiptSummary({ ...receipt, submissionId: randomUUID() })).toBeNull();
    expect(receiptSummary({ ...receipt, input: '{bad json' })).toBeNull();
    expect(isSubmissionSummary({ ...summary, version: 2 })).toBe(false);
    expect(isSubmissionSummary({ ...summary, answers: [{ field: '损坏', answer: [1] }] })).toBe(false);
    expect(messageSubmission({ role: 'assistant', parts: [{ type: 'data-ui-submission', data: summary }] })).toBeNull();
    // 在模型收件之前已保存摘要，崩溃重开后 receive 不覆盖它
    store.reconcile(conversation);
    conversation.receive(receipt.executionId, receipt.input);
    expect(messageSubmission(conversation.get(`user:${receipt.executionId}`)!)).toEqual(summary);
    conversation.receive('collision', '另一条普通消息');
    conversation.publishSubmission('collision', receipt.input, summary);
    expect(messageSubmission(conversation.get('user:collision')!)).toBeNull();
});
