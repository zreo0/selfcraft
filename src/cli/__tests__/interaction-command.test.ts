import { expect, test, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { interactionCommand } from '../interaction-command';
import type { RuntimeClient } from '../runtime-client';
import { InteractionStore } from '../../interaction/interaction-store';

test('CLI 提交超时后复用落盘意图，重开先查询回执而不再次提问或提交', async () => {
    const root = mkdtempSync(join(tmpdir(), 'selfcraft-cli-ui-'));
    const previous = process.env.SELFCRAFT_HOME;
    process.env.SELFCRAFT_HOME = root;
    const output = spyOn(console, 'log').mockImplementation(() => undefined);
    try {
        const store = new InteractionStore(join(root, 'state.sqlite'));
        const view = store.present('run', 'call', 'root = Form("clarification", "问题", "", [Answer("note", "说明", true)])');
        let sent = 0;
        let identifier: string | undefined;
        const client = {
            bootstrap: async () => ({ instanceId: 'cli-test' }),
            interaction: async () => store.get(view.id),
            saveInteraction: async (id: string, expectedRevision: number, values: unknown) => store.saveDraft(id, { expectedRevision, values }),
            interactionReceipt: async (id: string) => store.receipt(id),
            submitInteraction: async (id: string, request: { submissionId: string }) => {
                sent++;
                if (identifier) expect(request.submissionId).toBe(identifier);
                identifier = request.submissionId;
                if (sent === 1) throw new Error('连接在送达前中断');
                store.submit(id, request);
                throw new Error('服务端已接收，但回执丢失');
            },
        } as unknown as RuntimeClient;
        const answers = ['本轮说明', 'y'];
        await expect(interactionCommand(client, [view.id, 'submit'], async () => answers.shift()!)).rejects.toThrow('送达前');
        await expect(interactionCommand(client, [view.id, 'submit'], async () => 'y')).rejects.toThrow('回执丢失');
        await interactionCommand(client, [view.id, 'submit'], async () => { throw new Error('已经接收不应再次询问'); });
        expect(output.mock.calls.some(call => call[0] === '问题 · 已提交\n说明：本轮说明')).toBe(true);
        expect(output.mock.calls.some(call => String(call[0]).includes('以下 JSON'))).toBe(false);
        output.mockClear();
        await interactionCommand(client, [view.id], async () => { throw new Error('查看已提交回答不应询问'); });
        expect(output.mock.calls[0]?.[0]).toBe('问题 · 已提交\n说明：本轮说明');
        expect(sent).toBe(2);
        expect(store.get(view.id)?.submissionId).toBe(identifier!);
    } finally {
        output.mockRestore();
        if (previous === undefined) delete process.env.SELFCRAFT_HOME; else process.env.SELFCRAFT_HOME = previous;
        rmSync(root, { recursive: true, force: true });
    }
});
