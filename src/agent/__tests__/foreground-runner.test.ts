import { describe, expect, test } from 'bun:test';
import { ForegroundRunner } from '../foreground-runner';

/** 创建由测试控制结束时机的 Promise */
function deferred (): { promise: Promise<void>; resolve: () => void } {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>(done => {
        resolve = done;
    });
    return { promise, resolve };
}

describe('ForegroundRunner', () => {
    test('多个入口的前台对话严格按提交顺序执行', async () => {
        const first = deferred();
        const order: string[] = [];
        const runner = new ForegroundRunner({
            async run (input) {
                order.push(`start:${input}`);
                if (input === 'cli') {
                    await first.promise;
                }
                order.push(`end:${input}`);
                return { restartRequired: false };
            },
        });
        const statuses: string[] = [];

        const cli = runner.run('cli');
        const web = runner.run('web', event => {
            if (event.type === 'status') {
                statuses.push(event.label);
            }
        });
        await Bun.sleep(0);

        expect(order).toEqual(['start:cli']);
        expect(statuses).toEqual(['正在等待上一轮对话结束']);
        expect(runner.getPendingCount()).toBe(2);
        first.resolve();
        await Promise.all([cli, web]);
        expect(order).toEqual(['start:cli', 'end:cli', 'start:web', 'end:web']);
        expect(runner.getPendingCount()).toBe(0);
    });

    test('等待期间取消的请求不会进入 Agent Runtime', async () => {
        const first = deferred();
        const calls: string[] = [];
        const runner = new ForegroundRunner({
            async run (input) {
                calls.push(input);
                if (input === 'first') {
                    await first.promise;
                }
                return { restartRequired: false };
            },
        });
        const controller = new AbortController();

        const running = runner.run('first');
        const cancelled = runner.run('cancelled', () => undefined, {
            signal: controller.signal,
        });
        controller.abort();
        first.resolve();

        await running;
        await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
        expect(calls).toEqual(['first']);
    });
});
