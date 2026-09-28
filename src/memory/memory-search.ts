import type { Database } from 'bun:sqlite';

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const STOP_WORDS = new Set(['我', '你', '他', '她', '的', '了', '在', '是', '和', '也', '有', '什么', '怎么', '什么时候', '一下', '帮', '帮我', '请', '用户']);

/** 对写入与查询使用相同的中英文分词，返回可索引词 */
export function memoryWords (text: string): string[] {
    return [...segmenter.segment(text.normalize('NFKC').toLowerCase())]
        .filter(part => part.isWordLike && !STOP_WORDS.has(part.segment))
        .map(part => part.segment);
}

/** 把自然语言构造成仅包含字面词项的 FTS 查询 */
export function memoryQuery (text: string): string {
    return [...new Set(memoryWords(text))].slice(0, 64)
        .map(word => `"${word.replaceAll('"', '""')}"`).join(' OR ');
}

/** 提取适合自动召回的事件正文，完整工具结果只供主动核验 */
export function eventSearchText (event: { actor: string; type: string; payload?: unknown }): string | null {
    if (event.actor !== 'user' && !['assistant_message', 'work_notification', 'work_completed'].includes(event.type)) return null;
    if (typeof event.payload === 'string') return event.payload;
    if (event.payload && typeof event.payload === 'object') {
        const payload = event.payload as Record<string, unknown>;
        return [payload.text, payload.title, payload.result, payload.summary]
            .filter((value): value is string => typeof value === 'string').join('\n');
    }
    return '';
}

/** 建立索引并在启动时补齐旧版本留下的缺项，日常写入由存储事务维护 */
export function initializeMemorySearch (database: Database): void {
    for (const source of ['memories', 'events'] as const) {
        const table = source === 'memories' ? 'memory_fts' : 'event_fts';
        database.transaction(() => {
            database.run(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING fts5(text, tokenize='unicode61')`);
            database.run(`CREATE TRIGGER IF NOT EXISTS ${table}_delete AFTER DELETE ON ${source} BEGIN DELETE FROM ${table} WHERE rowid = old.rowid; END`);
            const eligible = source === 'events'
                ? "AND (s.actor = 'user' OR s.event_type IN ('assistant_message', 'work_notification', 'work_completed'))" : '';
            const rows = database.query(`SELECT s.rowid AS search_id, s.* FROM ${source} s
                WHERE NOT EXISTS (SELECT 1 FROM ${table} f WHERE f.rowid = s.rowid) ${eligible}`).all() as Array<{
                search_id: number; content: string; actor: string; event_type: string; payload: string;
            }>;
            for (const row of rows) {
                const text = source === 'memories' ? row.content
                    : eventSearchText({ actor: row.actor, type: row.event_type, payload: JSON.parse(row.payload) });
                if (text !== null) database.query(`INSERT INTO ${table}(rowid, text) VALUES (?, ?)`)
                    .run(row.search_id, memoryWords(text).join(' '));
            }
        }).immediate();
    }
}
