import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SelfcraftPaths } from '../config/paths';
import { ConfigStore } from '../config/config-store';

/** 健康检查中的单项结果 */
export interface HealthCheck {
    /** 检查名称 */
    name: string;
    /** 是否通过 */
    healthy: boolean;
    /** 失败或状态说明 */
    message: string;
}

/** 不调用模型的确定性健康检查 */
export class HealthChecker {
    /**
     * 检查源码边界和可选的实例状态
     *
     * @param paths 当前路径
     * @param codeOnly 是否跳过实例状态
     * @returns 全部检查结果
     */
    public check (paths: SelfcraftPaths, codeOnly = false): HealthCheck[] {
        const requiredFiles = [
            'package.json',
            'src/runtime-entry.ts',
            'src/agent/agent-runtime.ts',
            'src/context/context-manager.ts',
            'src/job/job-manager.ts',
            'src/memory/memory-store.ts',
            'src/memory/reflection-worker.ts',
            'src/supervisor/supervisor.ts',
            'workspace-template/HANDBOOK.md',
        ];
        const checks: HealthCheck[] = requiredFiles.map(fileName => ({
            name: `source:${fileName}`,
            healthy: fs.existsSync(path.join(paths.project, fileName)),
            message: fs.existsSync(path.join(paths.project, fileName)) ? 'ok' : 'missing',
        }));
        if (codeOnly) {
            return checks;
        }
        try {
            fs.mkdirSync(paths.home, { recursive: true });
            fs.accessSync(paths.home, fs.constants.R_OK | fs.constants.W_OK);
            checks.push({ name: 'home', healthy: true, message: paths.home });
        } catch (error) {
            checks.push({ name: 'home', healthy: false, message: String(error) });
        }
        try {
            const configStore = new ConfigStore(paths.config);
            configStore.read();
            checks.push({
                name: 'model',
                healthy: true,
                message: configStore.isConfigured() ? 'configured' : 'onboarding required',
            });
        } catch (error) {
            checks.push({ name: 'model', healthy: false, message: String(error) });
        }
        return checks;
    }
}
