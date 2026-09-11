import * as fs from 'node:fs';
import * as path from 'node:path';

/** 获取实例唯一写入者资格，返回释放函数；已死亡进程的租约可恢复 */
export function acquireRuntimeLease (home: string): () => void {
    fs.mkdirSync(home, { recursive: true });
    const file = path.join(home, 'runtime.lock');
    if (fs.existsSync(file)) {
        const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number };
        let alive = true;
        try {
            process.kill(owner.pid, 0);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
                alive = false;
            }
        }
        if (alive) {
            throw new Error('该实例已有 Runtime 运行，不能同时写入同一份状态');
        }
        fs.unlinkSync(file);
    }
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
    return () => {
        if (fs.existsSync(file)) {
            const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number };
            if (owner.pid === process.pid) {
                fs.unlinkSync(file);
            }
        }
    };
}
