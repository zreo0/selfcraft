import { receiptSummary, submissionText } from '../interaction/submission-summary';
import type { InteractionReceipt } from '../interaction/interaction-store';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { resolvePaths } from '../config/paths';
import { interactionText, normalizeValues, type InteractionValues } from '../interaction/protocol';
import type { RuntimeClient } from './runtime-client';

/** 在既有终端中逐项填写；提交前落盘，断线后先查询原回执 */
export async function interactionCommand (client: RuntimeClient, args: string[], ask: (prompt: string) => Promise<string>): Promise<void> {
    if (!args[0]) {
        let cursor: number | null = 0;
        let count = 0;
        do {
            const page = await client.interactions(cursor);
            for (const view of page.items) { console.log(`${view.id}  ${view.interaction.title}`); count++; }
            cursor = page.nextCursor;
        } while (cursor !== null);
        console.log(count ? '使用 /ui <id> submit 填写' : '没有待回答交互');
        return;
    }
    const id = args[0];
    let view = await client.interaction(id);
    if (view.status === 'submitted' && view.submissionId && args[1] !== 'submit') {
        const receipt = await client.interactionReceipt(view.submissionId);
        if (receipt) { printSubmission(receipt); return; }
    }
    console.log(`${interactionText(view.interaction)}\n状态：${view.status}`);
    for (const field of view.interaction.fields) {
        const value = view.values[field.name];
        if (!value?.length) continue;
        const selected = Array.isArray(value) ? value : [value];
        console.log(`${field.label}：${selected.map(item => field.options?.find(option => option.value === item)?.label ?? item).join('、')}`);
    }
    if (args[1] !== 'submit') return;
    if (view.protocolVersion !== 1 || view.libraryVersion !== 'selfcraft-ui@1'
        || view.interaction.actions.length !== 1 || view.interaction.actions[0]?.id !== 'submit'
        || view.interaction.fields.some(field => !['single-select', 'multi-select', 'text'].includes(field.type))) {
        throw new Error('当前 CLI 不支持此表单，请直接用文字回答');
    }
    const instance = (await client.bootstrap()).instanceId;
    if (!instance) throw new Error('服务端未提供稳定实例身份，无法安全保存提交');
    const directory = path.join(resolvePaths().home, 'client-interactions');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, createHash('sha256').update(`${instance}:${id}`).digest('hex') + '.json');
    const local: { revision: number; values: InteractionValues; pending?: { submissionId: string; expectedRevision: number; actionId: 'submit'; values: InteractionValues } }
        = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { revision: view.revision, values: view.values };
    /** 原子保存本轮意图，文件不包含连接凭证 */
    const save = (): void => { fs.writeFileSync(file + '.tmp', JSON.stringify(local), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); };
    if (local.pending) {
        const receipt = await client.interactionReceipt(local.pending.submissionId);
        if (receipt) { fs.rmSync(file); printSubmission(receipt); return; }
        if (view.status !== 'ready' || view.revision !== local.pending.expectedRevision) {
            delete local.pending; save();
            throw new Error('原提交未被接收，表单已变化；填写内容已保留，请重新打开核对');
        }
        if ((await ask('上次提交尚未确认，使用原内容重试？[y/N] ')).trim().toLowerCase() !== 'y') return;
    } else {
        if (view.status !== 'ready') throw new Error('此交互已提交或关闭');
        if (local.revision !== view.revision) {
            if ((await ask('其他客户端已修改表单。已显示最新问题，保留本地填写并继续？[y/N] ')).trim().toLowerCase() !== 'y') return;
            local.revision = view.revision; save();
        }
        for (const field of view.interaction.fields) {
            console.log(`\n${field.label}${field.required ? '（必填）' : ''}`);
            field.options?.forEach((option, index) => console.log(`${index + 1}. ${option.label}${option.description ? '：' + option.description : ''}`));
            console.log(`已保存：${JSON.stringify(local.values[field.name] ?? '')}`);
            const input = (await ask(field.type === 'multi-select' ? '编号用逗号分隔，回车保留，/clear 清空，/cancel 返回：' : '输入内容或编号，回车保留，/clear 清空，/cancel 返回：')).trim();
            if (input === '/cancel') return;
            if (input === '/clear') local.values[field.name] = field.type === 'multi-select' ? [] : '';
            else if (input) {
                if (field.type === 'text') local.values[field.name] = input;
                else {
                    const indexes = input.split(/[,，\s]+/).map(Number);
                    if (indexes.some(index => !Number.isInteger(index) || index < 1 || index > field.options!.length)
                        || (field.type === 'single-select' && indexes.length !== 1)) throw new Error('选项编号无效');
                    const selected = indexes.map(index => field.options![index - 1]!.value);
                    local.values[field.name] = field.type === 'multi-select' ? selected : selected[0]!;
                }
            }
            save();
            view = await client.saveInteraction(id, local.revision, local.values);
            local.revision = view.revision; save();
        }
        local.values = normalizeValues(view.interaction, local.values, true);
        if ((await ask('确认提交这些回答？[y/N] ')).trim().toLowerCase() !== 'y') return;
        local.pending = { submissionId: randomUUID(), expectedRevision: view.revision, actionId: 'submit', values: local.values };
        save();
    }
    const receipt = await client.submitInteraction(id, local.pending);
    fs.rmSync(file);
    printSubmission(receipt);
}

/** 提交及回执恢复使用相同可读摘要，不显示内部执行标识 */
function printSubmission (receipt: InteractionReceipt): void {
    const summary = receiptSummary(receipt);
    console.log(summary ? submissionText(summary) : '回答已接收');
    console.log('处理结果见后续对话');
}
