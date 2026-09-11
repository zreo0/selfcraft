import type { AgentRuntime } from '../agent/agent-runtime';
import type { ForegroundRunner } from '../agent/foreground-runner';
import type { JobManager, JobRecord } from '../job/job-manager';
import type { Logger } from '../logging/logger';
import type { MemoryStore } from '../memory/memory-store';
import type { NotificationInbox } from '../notification/notification-inbox';
import type { WorkStore, WorkRecord } from './work-store';

/** 时间、后台结果和成长候选驱动的有界助理接续器 */
export class WorkRunner {
    private timer?: ReturnType<typeof setInterval>;
    private active?: { work: WorkRecord; controller: AbortController };
    private lastGrowthScan = 0;
    private stopped = true;

    /** 绑定现有执行、记忆和通知边界，不创建第二个用户身份 */
    constructor (
        private readonly works: WorkStore,
        private readonly agent: Pick<AgentRuntime, 'runBackground'>,
        private readonly foreground: Pick<ForegroundRunner, 'getPendingCount'>,
        private readonly jobs: Pick<JobManager, 'get' | 'readLog' | 'cancel' | 'unfinished'>,
        private readonly memory: Pick<MemoryStore, 'listGrowth' | 'recordEvent'>,
        private readonly notifications: NotificationInbox,
        private readonly logger: Logger,
        private readonly onRestart: () => void,
        private readonly needsRestart: () => boolean,
        private readonly isReady: () => boolean = () => true,
    ) {}

    /** 恢复事项并启动确定性扫描；空闲时不调用模型 */
    public start (): void {
        this.stopped = false;
        this.works.recover();
        this.timer = setInterval(() => this.tick(), 1000);
        this.timer.unref();
    }

    /** 停止新调度并取消当前模型调用，保留持久恢复状态 */
    public stop (): void {
        this.stopped = true;
        clearInterval(this.timer);
        this.active?.controller.abort();
    }

    /** 扫描条件并至多启动一次接续，公开以便确定性验收 */
    public tick (): void {
        if (this.stopped) {
            return;
        }
        try {
            if (this.active && this.works.get(this.active.work.id)?.revision !== this.active.work.revision) {
                this.active.controller.abort(new Error('事项版本已改变'));
            }
            for (const job of this.jobs.unfinished()) {
                if (job.workId && this.works.get(job.workId)?.revision !== job.workRevision) {
                    this.jobs.cancel(job.id);
                }
            }
            for (const notification of this.works.notifications()) {
                this.notifications.pushOnce(notification.id, notification.title, notification.message);
                this.works.acknowledge(notification.id);
            }
            this.works.wake(id => {
                const job = this.jobs.get(id);
                return job ? { status: job.status, evidence: this.jobs.readLog(id, 16000).log } : null;
            });
            if (this.active || this.foreground.getPendingCount() > 0 || !this.isReady()) {
                return;
            }
            if (Date.now() - this.lastGrowthScan >= 60_000) {
                this.lastGrowthScan = Date.now();
                const candidate = this.memory.listGrowth('proposed', 20)
                    .find(item => item.evidenceCount >= 2 && item.confidence >= 0.8 && !this.works.get(`growth:${item.id}`));
                if (candidate) {
                    const source = this.memory.recordEvent({
                        actor: 'system', type: 'growth_work_created',
                        payload: { growthId: candidate.id, evidence: candidate.evidence },
                        timezone: 'UTC', idempotencyKey: `growth:${candidate.id}:work`,
                    });
                    this.works.create({
                        goal: `核实并处理成长候选 ${candidate.id}：${candidate.title}`,
                        acceptance: '记录复现依据、改进内容和针对原问题的验证；无法证实则记录原因并结束',
                        authority: '仅维护本地技能或经 EvolutionService 验证的 Runtime；不得改变用户事实、扩大权限或执行外部业务操作',
                        sourceEventId: source.id,
                        next: `${candidate.observation}\n证据：${candidate.evidence}\n使用 growth_list 核对候选，验证后 growth_resolve，并完成此事项`,
                    }, `growth:${candidate.id}`);
                }
            }
            const work = this.works.claim();
            if (work) {
                const controller = new AbortController();
                this.active = { work, controller };
                void this.advance(work, controller);
            }
        } catch (error) {
            this.logger.error('事项扫描失败', { error: String(error) });
        }
    }

    /** 用同一个助理执行有界接续；结束后必须留下明确状态 */
    private async advance (work: WorkRecord, controller: AbortController): Promise<void> {
        const { turns: _turns, ...stableWork } = work;
        const job: JobRecord = {
            id: `work:${work.id}:${work.revision}`, workId: work.id, workRevision: work.revision,
            title: work.goal, type: 'agent', status: 'running', attempts: 1,
            payload: { prompt: `继续以下持久事项。先核对证据，在原授权内推进；完成前用 work_update 留下下一状态。\n${JSON.stringify(stableWork)}` },
            logPath: '', createdAt: new Date().toISOString(), timeoutSeconds: 120,
        };
        const timer = setTimeout(() => controller.abort(new Error('本轮接续超时')), 120_000);
        try {
            const text = await this.agent.runBackground(job, controller.signal, () => undefined);
            const latest = this.works.get(work.id)!;
            if (latest.revision === work.revision && latest.status === 'running') {
                this.works.update(work.id, work.revision, {
                    status: 'blocked', next: '本轮未留下明确下一步，需要核实后继续', evidence: text.slice(-24000),
                });
            }
        } catch (error) {
            if (!this.stopped && this.works.get(work.id)?.revision === work.revision) {
                this.works.update(work.id, work.revision, { status: 'blocked', next: String(error).slice(0, 4000) });

            }
        } finally {
            clearTimeout(timer);
            this.active = undefined;
            if (!this.stopped && this.needsRestart()) {
                this.onRestart();
            }
        }
    }
}
