import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from '../src/conversation/conversation-store';

/** 使用独立万条消息数据库测量空闲订阅和首批补读，不访问用户实例 */
function main (): void {
    const root = mkdtempSync(join(tmpdir(), 'selfcraft-conversation-perf-'));
    try {
        const file = join(root, 'state.sqlite');
        const store = new ConversationStore(file);
        const database = new Database(file);
        const insert = database.prepare('INSERT INTO conversation_messages(id,message,version) VALUES(?,?,?)');
        database.transaction(() => {
            for (let index = 1; index <= 10_000; index++) {
                insert.run(`message-${index}`, JSON.stringify({
                    id: `message-${index}`, role: 'user', parts: [{ type: 'text', text: 'x'.repeat(200) }], metadata: { seq: index },
                }), index);
            }
            database.run('UPDATE conversation_clock SET version = 10000');
        })();
        for (let index = 0; index < 20; index++) store.changes(10_000);
        const started = performance.now();
        for (let index = 0; index < 1000; index++) store.changes(10_000);
        const idleMs = performance.now() - started;
        const pending = store.changes(1);
        console.log(JSON.stringify({ rows: 10_000, idlePolls: 1000, idleMs, catchupFirstBatch: pending.items.length,
            cursor: pending.cursor, queryPlan: database.query('EXPLAIN QUERY PLAN SELECT message FROM conversation_messages WHERE version > ? ORDER BY version LIMIT 101').all(1) }));
        database.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
}

main();
