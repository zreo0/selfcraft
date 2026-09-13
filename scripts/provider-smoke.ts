import { ForegroundRunner } from '../src/agent/foreground-runner';
import { RuntimeClient } from '../src/cli/runtime-client';
import { ExecutionStore } from '../src/execution/execution-store';
import { HealthChecker } from '../src/health/health-checker';
import { ScheduledTaskManager } from '../src/task/scheduled-task-manager';
import { WebServer } from '../src/web/web-server';
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

/** 将 OpenAI-compatible chunk 编码为 SSE 响应 */
function createStreamResponse (chunks: unknown[]): Response {
    const payload = [
        ...chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`),
        'data: [DONE]\n\n',
    ].join('');
    return new Response(payload, {
        headers: { 'Content-Type': 'text/event-stream' },
    });
}

/** 创建只覆盖工具调用闭环的本地 OpenAI-compatible 服务 */
function createTestServer () {
    let requestCount = 0;
    const server = Bun.serve({
        port: 0,
        idleTimeout: 30,
        async fetch (request) {
            if (new URL(request.url).pathname !== '/v1/chat/completions') {
                return new Response('not found', { status: 404 });
            }
            if (request.headers.get('authorization') !== 'Bearer provider-smoke-secret') {
                return new Response('unauthorized', { status: 401 });
            }
            const body = await request.json() as {
                model?: string;
                messages?: Array<{ role?: string }>;
                tools?: unknown[];
                reasoning_effort?: string;
            };
            if (body.model !== 'provider-smoke' || !body.tools?.length || body.reasoning_effort !== 'high') {
                return new Response('invalid request', { status: 400 });
            }
            requestCount += 1;
            const base = {
                id: `chatcmpl-${requestCount}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: 'provider-smoke',
            };
            const hasToolResult = body.messages?.some(message => message.role === 'tool');
            if (!hasToolResult) {
                return createStreamResponse([
                    {
                        ...base,
                        choices: [{
                            index: 0,
                            delta: {
                                role: 'assistant',
                                tool_calls: [{
                                    index: 0,
                                    id: 'call-provider-smoke',
                                    type: 'function',
                                    function: {
                                        name: 'write',
                                        arguments: JSON.stringify({
                                            path: 'files/provider-smoke.txt',
                                            content: 'provider-ok',
                                        }),
                                    },
                                }],
                            },
                            finish_reason: null,
                        }],
                    },
                    {
                        ...base,
                        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
                    },
                ]);
            }
            // 模拟工具之后模型长时间思考，覆盖浏览器流超过 Bun 默认十秒空闲期的情况
            await Bun.sleep(13_000);
            return createStreamResponse([
                {
                    ...base,
                    choices: [{
                        index: 0,
                        delta: { role: 'assistant', content: 'SELFCRAFT_PROVIDER_OK' },
                        finish_reason: null,
                    }],
                },
                {
                    ...base,
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
                },
            ]);
        },
    });
    return { server, getRequestCount: () => requestCount };
}

/** 验证真实 HTTP Provider 编解码和 Agent 工具循环 */
async function main (): Promise<void> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-provider-smoke-'));
    const { server, getRequestCount } = createTestServer();
    const paths = resolvePaths('development', path.join(root, 'home'));
    let web: WebServer | undefined;
    try {
        const workspace = new WorkspaceService(paths.workspace, path.join(paths.project, 'workspace-template'));
        workspace.initialize();
        const config = new ConfigStore(paths.config);
        config.addProvider({
            providerId: 'local-smoke',
            type: 'openai-compatible',
            baseURL: new URL('/v1', server.url).toString().replace(/\/$/, ''),
            apiKey: 'provider-smoke-secret',
            models: {
                'provider-smoke': {
                    vision: false,
                    contextWindow: 128000,
                    maxOutputTokens: 4096,
                },
            },
        });
        const logger = new Logger(paths.logs);
        config.useModel({ providerId: 'local-smoke', modelId: 'provider-smoke', reasoningEffort: 'high' });
        const skills = new SkillRegistry(path.join(paths.workspace, 'skills'));
        const evolution = new EvolutionService(
            paths,
            new ReleaseStore(paths.supervisor, paths.evolution),
            logger,
        );
        const notifications = new NotificationInbox(paths.notifications);
        const memory = new MemoryStore(paths.state);
        const jobs = new JobManager(
            paths.state,
            paths.jobs,
            new PathGuard(paths.workspace),
            notifications,
            logger,
        );
        const executions = new ExecutionStore(paths.state);
        const agent = new AgentRuntime(
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
                enqueue: () => 'provider-smoke-reflection',
            },
            createTools(paths.workspace, skills, notifications, evolution, jobs, memory, undefined, undefined, executions),
            logger,
            undefined,
            executions,
        );
        web = new WebServer({ paths, config, agent: new ForegroundRunner(agent, executions), memory, skills, notifications, jobs,
            scheduledTasks: new ScheduledTaskManager(paths.state, notifications, memory), health: new HealthChecker(), logger,
            staticDirectory: path.join(paths.project, 'web', 'dist'), onRestart: () => undefined });
        const address = web.start('127.0.0.1', 0);
        let reply = '';
        await new RuntimeClient(address.url).chat('创建 provider 验收文件', event => {
            if (event.type === 'text-delta') {
                reply += event.delta;
            }
        });
        if (
            reply !== 'SELFCRAFT_PROVIDER_OK' ||
            getRequestCount() !== 2 ||
            fs.readFileSync(path.join(paths.workspace, 'files', 'provider-smoke.txt'), 'utf8') !== 'provider-ok'
        ) {
            throw new Error('OpenAI-compatible Provider 闭环不符合预期');
        }
        console.log(JSON.stringify({
            healthy: true,
            openAICompatibleHTTP: true,
            toolLoop: true,
            webStreamSurvivesIdle: true,
            requests: getRequestCount(),
        }, null, 4));
    } finally {
        web?.stop();
        server.stop(true);
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
