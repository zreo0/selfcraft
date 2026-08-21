import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import { MockLanguageModelV4 } from 'ai/test';
import { Logger } from '../../logging/logger';
import { MemoryStore } from '../memory-store';
import { ReflectionWorker } from '../reflection-worker';

const temporaryDirectories: string[] = [];

/** 创建并追踪测试临时目录 */
function createTemporaryDirectory (): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-memory-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('MemoryStore', () => {
    test('旧数据库会补齐 Reflection 修复字段', () => {
        const root = createTemporaryDirectory();
        const databasePath = path.join(root, 'state.sqlite');
        const legacyDatabase = new Database(databasePath, { create: true });
        legacyDatabase.run(`
            CREATE TABLE reflection_jobs (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                input TEXT NOT NULL,
                output TEXT NOT NULL,
                outcome TEXT NOT NULL,
                error TEXT,
                status TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        `);
        legacyDatabase.close();

        const store = new MemoryStore(databasePath);
        store.enqueueReflection({
            sessionId: 'legacy',
            input: '验证旧数据库迁移',
            output: '已验证',
            outcome: 'completed',
        });

        const job = store.claimReflection();
        expect(job?.previousOutput).toBeUndefined();
        expect(job?.previousError).toBeUndefined();
    });

    test('Reflection 记忆可追溯去重并由重复证据激活', () => {
        const root = createTemporaryDirectory();
        const store = new MemoryStore(path.join(root, 'state.sqlite'));
        for (const sessionId of ['turn-1', 'turn-2']) {
            store.enqueueReflection({
                sessionId,
                input: '请记住我偏好简洁的设计',
                output: '好的',
                outcome: 'completed',
            });
            const job = store.claimReflection();
            expect(job).not.toBeNull();
            store.completeReflection(job!.id, {
                memories: [{
                    kind: 'preference',
                    content: '用户偏好简洁的设计',
                    confidence: 0.75,
                    importance: 0.8,
                    sensitive: false,
                }],
                growth: [{
                    kind: 'skill',
                    title: '建立简洁设计审查技能',
                    observation: '用户反复要求简洁的设计产出',
                    evidence: sessionId,
                    confidence: 0.7,
                }],
            });
        }

        const memories = store.search('简洁设计');
        expect(memories).toHaveLength(1);
        expect(memories[0].status).toBe('active');
        expect(memories[0].evidenceCount).toBe(2);
        expect(store.listGrowth('proposed')[0].evidenceCount).toBe(2);
        expect(store.buildContext('设计')).toContain('用户偏好简洁的设计');
    });

    test('Reflection Worker 使用纯文本 JSON 而非 provider structuredOutputs', async () => {
        const root = createTemporaryDirectory();
        const store = new MemoryStore(path.join(root, 'state.sqlite'));
        const model = new MockLanguageModelV4({
            doGenerate: {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        memories: [{
                            kind: 'user',
                            content: '用户正在创建长期个人助理',
                            confidence: '0.9',
                            importance: '90%',
                            sensitive: false,
                        }],
                        growth: [{
                            kind: 'skill',
                            title: '建立长期助理验收技能',
                            observation: '长期助理需要可重复的验收流程',
                            evidence: '用户正在实际验证个人助理',
                            confidence: '0.8',
                        }],
                    }),
                }],
                finishReason: { unified: 'stop', raw: undefined },
                usage: {
                    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
                    outputTokens: { total: 10, text: 10, reasoning: undefined },
                },
                warnings: [],
            },
        });
        const worker = new ReflectionWorker(
            store,
            () => ({
                model,
                providerId: 'mock',
                modelId: 'reflection',
                contextWindow: 128000,
                maxOutputTokens: 4096,
            }),
            new Logger(path.join(root, 'logs')),
        );

        worker.enqueue({
            sessionId: 'main',
            input: '我正在做一个长期个人助理',
            output: '已理解',
            outcome: 'completed',
        });
        await worker.waitForIdle();
        worker.stop();

        expect(store.search('个人助理')[0].content).toContain('长期个人助理');
        expect(store.search('个人助理')[0].importance).toBe(0.9);
        expect(store.listGrowth('proposed')[0].confidence).toBe(0.8);
        expect(model.doGenerateCalls).toHaveLength(1);
        expect(model.doGenerateCalls[0].responseFormat).toBeUndefined();
    });

    test('Reflection 重试会携带上一次无效输出和校验错误', async () => {
        const root = createTemporaryDirectory();
        const store = new MemoryStore(path.join(root, 'state.sqlite'));
        const baseResult = {
            finishReason: { unified: 'stop' as const, raw: undefined },
            usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 10, text: 10, reasoning: undefined },
            },
            warnings: [],
        };
        const model = new MockLanguageModelV4({
            doGenerate: [
                {
                    ...baseResult,
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            memories: [{
                                kind: 'preference',
                                content: '用户偏好可验证的结果',
                                confidence: 'high',
                                importance: 0.8,
                                sensitive: false,
                            }],
                            growth: [],
                        }),
                    }],
                },
                {
                    ...baseResult,
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            memories: [{
                                kind: 'preference',
                                content: '用户偏好可验证的结果',
                                confidence: 0.8,
                                importance: 0.8,
                                sensitive: false,
                            }],
                            growth: [],
                        }),
                    }],
                },
            ],
        });
        const worker = new ReflectionWorker(
            store,
            () => ({
                model,
                providerId: 'mock',
                modelId: 'reflection-retry',
                contextWindow: 128000,
                maxOutputTokens: 4096,
            }),
            new Logger(path.join(root, 'logs')),
        );

        worker.enqueue({
            sessionId: 'main',
            input: '我希望每次都给出可验证的结果',
            output: '已理解',
            outcome: 'completed',
        });
        await worker.waitForIdle();
        worker.stop();

        expect(model.doGenerateCalls).toHaveLength(2);
        expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain('previous-invalid-reflection-output');
        expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain('high');
        expect(store.search('可验证结果')).toHaveLength(1);
    });
});
