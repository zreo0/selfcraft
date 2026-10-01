import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateText } from 'ai';
import { ConfigStore } from '../src/config/config-store';
import { Logger } from '../src/logging/logger';
import { MemoryStore } from '../src/memory/memory-store';
import { ReflectionWorker } from '../src/memory/reflection-worker';
import { ModelFactory } from '../src/model/model-factory';

/** 用真实模型验证陈述、跨轮反馈、执行纠错及后续使用的学习闭环 */
async function main (): Promise<void> {
    const baseURL = process.env.SELFCRAFT_TEST_BASE_URL;
    const apiKey = process.env.SELFCRAFT_TEST_API_KEY;
    const modelId = process.env.SELFCRAFT_TEST_MODEL_ID;
    if (!baseURL || !apiKey || !modelId) throw new Error('需要 SELFCRAFT_TEST_BASE_URL、SELFCRAFT_TEST_API_KEY、SELFCRAFT_TEST_MODEL_ID');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-memory-smoke-'));
    let worker: ReflectionWorker | undefined;
    try {
        const config = new ConfigStore(path.join(root, 'config'));
        config.addProvider({ providerId: 'test', type: 'openai-compatible', baseURL, apiKey,
            models: { [modelId]: { vision: false, contextWindow: 128000, maxOutputTokens: 12800 } } });
        const logger = new Logger(path.join(root, 'logs'));
        const memory = new MemoryStore(path.join(root, 'state.sqlite'));
        worker = new ReflectionWorker(memory, () => ModelFactory.create(config, 'reflection', logger), logger, 0);
        /** 提交一次真实用户陈述并等待空闲学习完成 */
        const learn = async (text: string) => {
            const runId = crypto.randomUUID();
            const event = memory.recordEvent({ actor: 'user', type: 'user_message', payload: { text }, runId });
            worker!.enqueue({ runId, eventIds: [event.id], outcome: 'completed' });
            await worker!.waitForIdle(180000);
            return event;
        };
        await learn('我现在长期住在上海。以后请始终用简短中文回答我，这是我的长期偏好。');
        const first = memory.search('上海').find(item => item.status === 'active' && item.content.includes('上海'));
        if (!first) throw new Error('明确住址未自动学到');
        if (!memory.buildProfile().includes('简短')) throw new Error('跨话题偏好未进入档案');
        console.log(`${modelId}: explicit statement and resident profile passed`);
        await learn('关于我现在住在上海这件事，我只是考虑以后搬去杭州，还没有决定，更没有搬家。');
        if (memory.getMemory(first.id)?.status !== 'active'
            || memory.search('杭州').some(item => item.status === 'active')) throw new Error(`计划校验失败: ${JSON.stringify({ original: memory.getMemory(first.id), related: memory.search('杭州') })}`);
        console.log(`${modelId}: hypothetical move preserved current fact`);
        await learn('纠正之前说我住在上海的信息，是我刚才说错了。我其实一直住在苏州，并没有发生搬家。请纠正长期住址。');
        const corrected = memory.search('苏州').find(item => item.status === 'active' && item.content.includes('苏州'));
        if (!corrected || memory.getMemory(first.id)?.status !== 'retracted') throw new Error('纠错没有形成有效修订链');
        const repeated = await learn('再确认一下：我一直住在苏州。');
        const current = memory.search('苏州').filter(item => item.status === 'active');
        if (current.length !== 1 || !current[0]!.sourceEventIds.includes(repeated.id)) throw new Error('重复陈述未补充证据或产生了重复认识');
        memory.recordEvent({ actor: 'agent', type: 'assistant_message', runId: 'previous-offer',
            payload: { text: '要不要以后都在周报结尾附上完整英文翻译？', channel: 'foreground' } });
        await learn('不用，以后这类都不要自动附上，除非我明确要求。');
        const refusal = memory.search('周报 英文翻译').find(item => item.status === 'active'
            && /英文|翻译/.test(item.content));
        if (!refusal) throw new Error('跨轮反馈没有结合所回应的具体建议形成认识');
        console.log(`${modelId}: cross-turn feedback passed`);

        const runId = crypto.randomUUID();
        const request = memory.recordEvent({ actor: 'user', type: 'user_message', runId,
            payload: { text: '请读取 example.test 的今日新闻榜单，给我前两条标题' } });
        const failedCall = memory.recordEvent({ actor: 'agent', type: 'tool_call', runId,
            payload: { toolName: 'web_fetch', input: { url: 'https://example.test/old-news' } } });
        memory.recordEvent({ actor: 'tool:web_fetch', type: 'tool_error', runId, sourceEventId: failedCall.id,
            payload: { error: '404，旧新闻榜单地址已失效' } });
        const correctedCall = memory.recordEvent({ actor: 'agent', type: 'tool_call', runId,
            payload: { toolName: 'web_fetch', input: { url: 'https://example.test/news-board' } } });
        memory.recordEvent({ actor: 'tool:web_fetch', type: 'tool_result', runId, sourceEventId: correctedCall.id,
            payload: { result: { url: 'https://example.test/news-board', title: '今日新闻榜单',
                items: [{ rank: 1, title: '城市图书馆开放' }, { rank: 2, title: '气象卫星成功发射' }] } } });
        memory.recordEvent({ actor: 'agent', type: 'assistant_message', runId, sourceEventId: request.id,
            payload: { text: '旧地址失效，改用 /news-board 取得实际榜单：城市图书馆开放；气象卫星成功发射', channel: 'foreground' } });
        worker.enqueue({ runId, eventIds: memory.listEventsByRun(runId).map(event => event.id), outcome: 'completed' });
        await worker.waitForIdle(180000);
        const lesson = memory.search('example.test news-board').find(item => item.kind === 'lesson'
            && item.status === 'active' && item.basis === 'observed' && item.content.includes('news-board'));
        if (!lesson) throw new Error('具体纠错经验没有保留条件并以 observed 生效');
        const context = memory.buildContext('再次读取 example.test 今日新闻榜单');
        if (!context.includes(lesson.content)) throw new Error('有效执行经验没有进入下一次相关上下文');
        // 隔离已生效记忆验证后续使用，避免原始事件直接泄露成功路径使测试误通过
        const structured = context.match(/<structured-memory>[\s\S]*?<\/structured-memory>/)?.[0] || '';
        const active = ModelFactory.create(config, 'reflection', logger);
        const next = await generateText({ model: active.model,
            instructions: '根据已验证记忆选择实际操作路径，只返回下一次读取所用的 URL。',
            prompt: `${structured}\n请再次读取 example.test 今日新闻榜单。`, maxOutputTokens: 1000 });
        if (!next.text.includes('example.test/news-board')) throw new Error('后续模型没有采用已验证的地址');
        console.log(JSON.stringify({ modelId, passed: ['statement', 'resident', 'hypothesis', 'correction',
            'reinforce', 'cross-turn-feedback', 'verified-lesson', 'subsequent-use'] }));
    } finally {
        worker?.stop();
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
