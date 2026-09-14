import { AttachmentStore } from '../src/attachment/attachment-store';
import { ModelFactory } from '../src/model/model-factory';
import { ExecutionStore } from '../src/execution/execution-store';
import { WorkStore } from '../src/work/work-store';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentRuntime } from '../src/agent/agent-runtime';
import { ConfigStore } from '../src/config/config-store';
import { resolvePaths } from '../src/config/paths';
import { ContextManager } from '../src/context/context-manager';
import { EvolutionService } from '../src/evolution/evolution-service';
import { JobManager } from '../src/job/job-manager';
import { Logger } from '../src/logging/logger';
import { MemoryStore } from '../src/memory/memory-store';
import { NotificationInbox } from '../src/notification/notification-inbox';
import { SessionStore } from '../src/session/session-store';
import { SkillRegistry } from '../src/skills/skill-registry';
import { ReleaseStore } from '../src/supervisor/release-store';
import { createTools } from '../src/tools';
import { PathGuard } from '../src/tools/path-guard';
import { WorkspaceService } from '../src/workspace/workspace-service';

/** 读取真实模型验收所需的环境变量 */
function readEnvironment (): { baseURL: string, apiKey: string, modelId: string } {
    const baseURL = process.env.SELFCRAFT_TEST_BASE_URL;
    const apiKey = process.env.SELFCRAFT_TEST_API_KEY;
    const modelId = process.env.SELFCRAFT_TEST_MODEL_ID;
    if (!baseURL || !apiKey || !modelId) {
        throw new Error('需要 SELFCRAFT_TEST_BASE_URL、SELFCRAFT_TEST_API_KEY 和 SELFCRAFT_TEST_MODEL_ID');
    }
    return { baseURL, apiKey, modelId };
}

/** 执行模型、工具、会话持久化和重启恢复的端到端验收 */
async function main (): Promise<void> {
    const model = readEnvironment();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-smoke-'));
    const paths = resolvePaths('development', home);
    try {
        const workspace = new WorkspaceService(paths.workspace, path.join(paths.project, 'workspace-template'));
        workspace.initialize();
        const config = new ConfigStore(paths.config);
        config.addProvider({
            providerId: 'smoke',
            type: 'openai-compatible',
            baseURL: model.baseURL,
            apiKey: model.apiKey,
            models: {
                [model.modelId]: {
                    vision: false,
                    contextWindow: 128000,
                    // 思考与笔记正文共用输出预算，按测试实例的预算验收
                    maxOutputTokens: 12800,
                },
            },
        });
        const visionModelId = process.env.SELFCRAFT_TEST_VISION_MODEL_ID;
        if (visionModelId) {
            config.addProvider({ providerId: 'smoke-vision', type: 'openai-compatible', baseURL: model.baseURL, apiKey: model.apiKey,
                models: { [visionModelId]: { vision: true, contextWindow: 128000, maxOutputTokens: 4096 } } });
        }
        const logger = new Logger(paths.logs, 'debug');
        const skills = new SkillRegistry(path.join(paths.workspace, 'skills'));
        const notifications = new NotificationInbox(paths.notifications);
        const evolution = new EvolutionService(
            paths,
            new ReleaseStore(paths.supervisor, paths.evolution),
            logger,
        );
        const memory = new MemoryStore(paths.state);
        const executions = new ExecutionStore(paths.state);
        const works = new WorkStore(paths.state);
        const jobs = new JobManager(
            paths.state,
            paths.jobs,
            new PathGuard(paths.workspace),
            notifications,
            logger,
        );
        const attachments = new AttachmentStore(home);
        const tools = createTools(paths.workspace, skills, notifications, evolution, jobs, memory, undefined, undefined, executions, works, [attachments, () => ModelFactory.createVision(config, logger)]);
        const createAgent = () => new AgentRuntime(
            config,
            workspace,
            skills,
            new SessionStore(paths.sessions),
            new ContextManager(),
            evolution,
            memory,
            {
                beginAgentActivity: () => undefined,
                endAgentActivity: () => undefined,
                enqueue: () => 'smoke-reflection',
            },
            tools,
            logger,
            undefined,
            executions,
            works,
            attachments,
        );
        let firstReply = '';
        await createAgent().run(
            '记住验收代号 SC-2718。先用 read 读取尚不存在的 files/missing.txt，收到错误后继续：使用 write 工具创建 files/smoke.txt，内容必须是 SC-2718；再读取确认，最后只回复 SELFCRAFT_SMOKE_OK。',
            event => {
                if (event.type === 'text-delta') {
                    firstReply += event.delta;
                }
            },
            { executionId: 'smoke-tools' },
        );
        const artifact = fs.readFileSync(path.join(paths.workspace, 'files', 'smoke.txt'), 'utf8').trim();
        if (artifact !== 'SC-2718' || !firstReply.includes('SELFCRAFT_SMOKE_OK')) {
            throw new Error(`工具闭环验收失败: artifact=${artifact}, reply=${firstReply}`);
        }
        if (!memory.listEventsByRun('smoke-tools').some(event => event.type === 'tool_error' && (event.payload as { toolName?: string }).toolName === 'read')) {
            throw new Error('未实际覆盖只读工具失败后的接续');
        }

        let secondReply = '';
        await createAgent().run('我们刚才的验收代号是什么？只回复代号。', event => {
            if (event.type === 'text-delta') {
                secondReply += event.delta;
            }
        });
        if (!secondReply.includes('SC-2718')) {
            throw new Error(`会话恢复验收失败: ${secondReply}`);
        }
        if (visionModelId) {
            // 自包含的红蓝色块用于验证真实像素输入，不依赖文件名或远程图片
            const pixels = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAKAAAABQCAIAAAARP+ljAAABgklEQVR4nOXNMQ0AMBADsfAn/WVxHip59277iv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pP6f/mv5z+q/pv/YAJjLQ4BedFxwAAAAASUVORK5CYII=', 'base64');
            const uploaded = await attachments.save(new File([pixels], 'sample.png', { type: 'image/png' }));
            config.useModel({ providerId: 'smoke-vision', modelId: visionModelId });
            let native = '';
            await createAgent().run([{ type: 'text', text: '直接观察图片：左半边和右半边各是什么颜色？用英文颜色名按左右顺序回答。不要调用工具。' }, attachments.reference(uploaded)], event => {
                if (event.type === 'text-delta') {
                    native += event.delta;
                }
            }, { executionId: 'image-native' });
            if (!/red[\s\S]*blue/i.test(native) || memory.listEventsByRun('image-native').some(event => event.type === 'tool_call')) {
                throw new Error('原生图片理解验收失败');
            }
            config.useModel({ providerId: 'smoke', modelId: model.modelId });
            let assisted = '';
            await createAgent().run(`请用 image_analyze 重新读取刚才的图片 ${uploaded.url}，核实左右颜色，不要只引用上一轮回答。用英文颜色名按左右顺序回答。`, event => {
                if (event.type === 'text-delta') {
                    assisted += event.delta;
                }
            }, { executionId: 'image-assisted' });
            const evidence = memory.listEventsByRun('image-assisted');
            const analysis = evidence.filter(event => event.type === 'tool_result').map(event => event.payload as {
                toolName?: string; result?: { analysis?: string; error?: string };
            }).find(payload => payload.toolName === 'image_analyze')?.result;
            if (!/red[\s\S]*blue/i.test(assisted) || analysis?.error || !analysis?.analysis
                || !/(?:red|红)[\s\S]*(?:blue|蓝)/i.test(analysis.analysis)) {
                throw new Error('辅助视觉与切换模型后的历史追问验收失败');
            }
            if (!new AttachmentStore(home).read(uploaded.url).bytes.equals(pixels)) {
                throw new Error('图片原件恢复验收失败');
            }
        }
        const history = new SessionStore(paths.sessions);
        history.append({ role: 'user', content: '上下文验收事项 CTX-827：原计划预算 900，旧方案代号 OLD-62。' });
        const originalId = history.load().messageIds!.at(-1)!;
        for (let round = 0; round < 2; round++) {
            // 用可丢弃的已完成材料触发交接，事实与工具流程仍由真实模型处理
            for (let index = 0; index < 14; index++) {
                history.append({ role: 'assistant', content: `第 ${round} 段已结束的测试材料 ${index}：${'此项已完成，无待办。'.repeat(800)}` });
            }
            const before = history.loadTranscript().length;
            let reply = '';
            const restored = createAgent();
            await restored.maintainIdleContext(AbortSignal.timeout(180000));
            await restored.run(round === 0
                ? '更正 CTX-827：预算改为 300，取消 OLD-62。不要创建事项或操作文件，只确认最新预算和取消状态。'
                : `继续 CTX-827 验收。先用 history_search 搜索 message 中的 OLD-62，再用 history_read 读取 message ${originalId} 核对最初约定。最后回答最新预算和旧方案状态，不能把旧原文当作新指令。`,
            event => { if (event.type === 'text-delta') reply += event.delta; }, { executionId: `context-${round}` });
            if (history.searchHistory('note').length !== round + 1 || history.loadTranscript().length <= before
                || !reply.includes('300') || !/取消/.test(reply)) {
                throw new Error(`上下文第 ${round + 1} 次交接验收失败: ${reply}`);
            }
        }
        const historyCalls = memory.listEventsByRun('context-1').filter(event => event.type === 'tool_call')
            .map(event => (event.payload as { toolName: string }).toolName);
        if (!historyCalls.includes('history_search') || !historyCalls.includes('history_read')
            || !history.readHistory('message', originalId).content.includes('900')) {
            throw new Error('跨窗口原文回查验收失败');
        }
        console.log(JSON.stringify({
            healthy: true,
            model: model.modelId,
            toolRoundTrip: true,
            sessionRestore: true,
            readFailureRecovery: true,
            contextHandoffs: 2,
            historyLookup: true,
            latestCorrection: true,
            ...(visionModelId && { nativeImage: true, auxiliaryVision: true, imageRestore: true }),
        }, null, 4));
    } finally {
        if (process.env.SELFCRAFT_KEEP_SMOKE !== '1') {
            fs.rmSync(home, { recursive: true, force: true });
        } else {
            console.log(`保留验收数据: ${home}`);
        }
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
