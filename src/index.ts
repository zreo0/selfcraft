#!/usr/bin/env bun

import { resolvePaths } from './config/paths';
import { Logger } from './logging/logger';
import { Supervisor } from './supervisor/supervisor';

/** 启动稳定 Supervisor，并把退出码传回宿主环境 */
async function main (): Promise<void> {
    const paths = resolvePaths();
    const logger = new Logger(paths.logs);
    const supervisor = new Supervisor(paths, logger);
    process.exitCode = await supervisor.run(process.argv.slice(2));
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
