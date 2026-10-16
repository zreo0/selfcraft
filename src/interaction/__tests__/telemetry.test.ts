import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

test('OpenUI 安装和运行补丁在误设启用变量时仍禁止外联，开发模式不加载远程 DevTools', async () => {
    const core = dirname(import.meta.resolve('@openuidev/lang-core').replace('file://', ''));
    const reactEntry = Bun.resolveSync('@openuidev/react-lang', join(import.meta.dir, '../../../web'));
    const react = dirname(reactEntry);
    expect(readFileSync(join(core, '../postinstall.cjs'), 'utf8')).not.toContain('require(');
    for (const extension of ['mjs', 'cjs']) {
        const entry = readFileSync(join(react, `index.${extension}`), 'utf8');
        expect(entry).toContain('if (false) { // Selfcraft: never load remote DevTools');
    }
    // 单独进程不污染其他测试；开启上游遥测变量，捕获任何潜在请求
    const script = `
        let requests = 0;
        globalThis.fetch = async () => { requests++; throw new Error('unexpected egress'); };
        globalThis.document = { createElement() { throw new Error('remote devtools'); } };
        const { uiLibrary, parseInteraction } = await import('./src/interaction/protocol.ts');
        await import(${JSON.stringify(reactEntry)});
        uiLibrary.prompt();
        parseInteraction('root = Form("clarification", "问题", "", [Answer("note", "说明", true)])');
        await import('./node_modules/@openuidev/lang-core/postinstall.cjs');
        await Bun.sleep(100);
        if (requests) throw new Error('telemetry emitted');
    `;
    const child = Bun.spawn(['bun', '-e', script], { env: { ...process.env, NODE_ENV: 'development',
        OPENUI_RUNTIME_TELEMETRY_ENABLED: '1', OPENUI_TELEMETRY_DISABLED: '0', DO_NOT_TRACK: '0' }, stdout: 'pipe', stderr: 'pipe' });
    const error = await new Response(child.stderr).text();
    expect({ code: await child.exited, error }).toEqual({ code: 0, error: '' });
});
