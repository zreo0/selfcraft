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
                    maxOutputTokens: 4096,
                },
            },
        });
        const logger = new Logger(paths.logs, 'debug');
        const skills = new SkillRegistry(path.join(paths.workspace, 'skills'));
        const notifications = new NotificationInbox(paths.notifications);
        const evolution = new EvolutionService(
            paths,
            new ReleaseStore(paths.supervisor, paths.evolution),
            logger,
        );
        const memory = new MemoryStore(paths.state);
        const jobs = new JobManager(
            paths.state,
            paths.jobs,
            new PathGuard(paths.workspace),
            notifications,
            logger,
        );
        const tools = createTools(paths.workspace, skills, notifications, evolution, jobs, memory);
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
        );
        let firstReply = '';
        await createAgent().run(
            '记住验收代号 SC-2718。使用 write 工具创建 files/smoke.txt，内容必须是 SC-2718；再读取确认，最后只回复 SELFCRAFT_SMOKE_OK。',
            text => {
                firstReply += text;
            },
        );
        const artifact = fs.readFileSync(path.join(paths.workspace, 'files', 'smoke.txt'), 'utf8').trim();
        if (artifact !== 'SC-2718' || !firstReply.includes('SELFCRAFT_SMOKE_OK')) {
            throw new Error(`工具闭环验收失败: artifact=${artifact}, reply=${firstReply}`);
        }

        let secondReply = '';
        await createAgent().run('我们刚才的验收代号是什么？只回复代号。', text => {
            secondReply += text;
        });
        if (!secondReply.includes('SC-2718')) {
            throw new Error(`会话恢复验收失败: ${secondReply}`);
        }
        console.log(JSON.stringify({
            healthy: true,
            model: model.modelId,
            toolRoundTrip: true,
            sessionRestore: true,
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
