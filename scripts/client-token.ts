import { randomBytes } from 'node:crypto';
import { ConfigStore } from '../src/config/config-store';
import { resolvePaths } from '../src/config/paths';

/** 显式本地操作生成或轮换访问凭证；仅在该终端显示一次 */
function main (): void {
    const config = new ConfigStore(resolvePaths().config);
    const token = randomBytes(32).toString('base64url');
    config.setCredential('client-access', token);
    console.log(token);
}

main();
