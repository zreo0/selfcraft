import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { FilePart, FileUIPart } from 'ai';
import { PathGuard } from '../tools/path-guard';

/** 首版图片上限，与入口校验共用 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** 每轮最多接收的图片数量 */
export const MAX_IMAGES = 4;

/** 保存原始附件，标准消息仅引用稳定的本地 API 地址 */
export class AttachmentStore {
    private readonly guard: PathGuard;

    /** 创建实例附件目录的访问边界 */
    constructor (home: string) {
        const directory = path.join(home, 'attachments');
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        this.guard = new PathGuard(directory);
    }

    /** 校验图片真实格式并按内容去重保存，返回标准 UI 文件部分 */
    public async save (file: File): Promise<FileUIPart> {
        if (!file.size || file.size > MAX_IMAGE_BYTES) {
            throw new Error('图片不能为空，且每张不能超过 10 MB');
        }
        const bytes = Buffer.from(await file.arrayBuffer());
        const format = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png'
            : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'jpeg'
                : ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString()) ? 'gif'
                    : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'webp' : null;
        if (!format) {
            throw new Error('当前仅支持 PNG、JPEG、GIF 和 WebP 图片');
        }
        const id = `${createHash('sha256').update(bytes).digest('hex')}.${format}`;
        const target = this.guard.resolveWrite(id);
        // 排他创建避免并发上传覆盖同一原件
        try {
            fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw error;
            }
        }
        return { type: 'file', url: `/api/attachments/${id}`, mediaType: `image/${format}`, filename: path.basename(file.name).slice(0, 200) };
    }

    /** 读取本实例附件；拒绝远程 URL、任意路径和不存在的文件 */
    public read (url: string): { bytes: Buffer; mediaType: string } {
        url = url.replace(/^http:\/\/selfcraft\.local(?=\/)/, '');
        const match = /^\/api\/attachments\/([a-f0-9]{64}\.(png|jpeg|gif|webp))$/.exec(url);
        if (!match) {
            throw new Error('请使用本实例已上传的图片');
        }
        const bytes = fs.readFileSync(this.guard.resolveRead(match[1]!));
        return { bytes, mediaType: `image/${match[2]}` };
    }

    /** 验证入口附件并生成可持久保存的 AI SDK 文件部分 */
    public reference (part: FileUIPart): FilePart {
        const { mediaType } = this.read(part.url);
        // 使用与端口无关的标准 URL 保存引用，模型请求前始终在本地物化，不访问该主机
        return { type: 'file', mediaType, filename: part.filename?.slice(0, 200), data: { type: 'url', url: new URL(part.url, 'http://selfcraft.local') } };
    }

    /** 请求模型前将本地附件引用物化为标准文件数据，原始消息保持不变 */
    public materialize (part: FilePart): FilePart {
        if (typeof part.data === 'object' && 'url' in part.data && /^(?:http:\/\/selfcraft\.local)?\/api\/attachments\//.test(String(part.data.url))) {
            const { bytes, mediaType } = this.read(String(part.data.url));
            return { ...part, mediaType, data: { type: 'data', data: bytes } };
        }
        return part;
    }
}
