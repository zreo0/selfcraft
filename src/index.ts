#!/usr/bin/env bun

import { resolvePaths } from './config/paths';
import { Logger } from './logging/logger';
import { Supervisor } from './supervisor/supervisor';

/** 启动稳定 Supervisor，并把退出码传回宿主环境 */
async function main (): Promise<void> {
    const paths = resolvePaths();
    const logger = new Logger(paths.logs);
    const supervisor = new Supervisor(paths, logger);
    const handleSigint = (): void => supervisor.stop('SIGINT');
    const handleSigterm = (): void => supervisor.stop('SIGTERM');
    process.once('SIGINT', handleSigint);
    process.once('SIGTERM', handleSigterm);
    try {
        process.exitCode = await supervisor.run(process.argv.slice(2));
    } finally {
        process.off('SIGINT', handleSigint);
        process.off('SIGTERM', handleSigterm);
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
