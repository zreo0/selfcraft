import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AudioStore, wavDuration } from '../audio-store';
import { ConfigStore } from '../../config/config-store';

/** 生成真实结构的短 PCM 文件，不包含真实录音 */
function wav (seconds = 1): Buffer {
    const bytes = Buffer.alloc(44 + seconds * 32000);
    bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
    return bytes;
}

test('音频按真实格式和数据大小校验两分钟边界', () => {
    expect(wavDuration(wav(120))).toBe(120);
    expect(() => wavDuration(wav(121))).toThrow('两分钟');
    expect(() => wavDuration(wav().subarray(0, 80))).toThrow('不完整');
    expect(() => wavDuration(Buffer.alloc(100))).toThrow('WAV');
});

test('录音重复上传校验摘要，转写失败保留原件，删除后不能复活', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-audio-'));
    try {
        const store = new AudioStore(root, path.join(root, 'state.sqlite'), new ConfigStore(path.join(root, 'config')));
        const file = new File([new Uint8Array(wav())], 'test.wav');
        const first = await store.save('same', file, new Date().toISOString());
        expect(await store.save('same', file, first.capturedAt)).toEqual(first);
        await expect(store.save('same', new File([new Uint8Array(wav(2))], 'other.wav'), first.capturedAt)).rejects.toThrow('不能替换');
        await expect(store.transcribe('same')).rejects.toThrow('配置');
        expect(store.read('same').length).toBe(file.size);
        store.delete('same');
        expect(() => store.read('same')).toThrow('删除');
        await expect(store.save('same', file, first.capturedAt)).rejects.toThrow('不能替换');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('并发上传同一标识不同音频只能保留一个原件', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-audio-race-'));
    try {
        const store = new AudioStore(root, path.join(root, 'state.sqlite'), new ConfigStore(path.join(root, 'config')));
        const results = await Promise.allSettled([1, 2].map(seconds => store.save('same', new File([new Uint8Array(wav(seconds))], 'audio.wav'), new Date().toISOString())));
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(wavDuration(store.read('same'))).toBe(store.get('same')!.duration);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('AI SDK 转写契约兼容、并发复用、结果跨重启保留', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcraft-asr-'));
    let calls = 0;
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch (request) {
        calls++;
        expect(new URL(request.url).pathname).toBe('/audio/transcriptions');
        const form = await request.formData();
        expect([...form.keys()].sort()).toEqual(['file', 'model']);
        expect(form.get('model')).toBe('FunAudioLLM/SenseVoiceSmall');
        await Bun.sleep(10);
        return Response.json({ text: '这是一条模拟语音' });
    } });
    try {
        const config = new ConfigStore(path.join(root, 'config'));
        config.configureTranscription({ baseURL: `http://127.0.0.1:${server.port}`, modelId: 'FunAudioLLM/SenseVoiceSmall', apiKey: 'test-only' });
        const file = path.join(root, 'state.sqlite');
        const store = new AudioStore(root, file, config);
        await store.save('recording', new File([new Uint8Array(wav())], 'test.wav'), new Date().toISOString());
        const [first, second] = await Promise.all([store.transcribe('recording'), store.transcribe('recording')]);
        expect(calls).toBe(1);
        expect(first).toEqual(second);
        expect(first.text).toBe('这是一条模拟语音');
        const restored = new AudioStore(root, file, config);
        expect((await restored.transcribe('recording')).text).toBe(first.text);
        expect(calls).toBe(1);
        restored.delete('recording');
        expect(restored.get('recording')?.text).toBe(first.text);
    } finally { server.stop(true); fs.rmSync(root, { recursive: true, force: true }); }
});
