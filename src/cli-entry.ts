#!/usr/bin/env bun

import { Cli } from './cli/cli';
import { RuntimeClient } from './cli/runtime-client';
import { Onboarding } from './onboarding/onboarding';

/** 启动独立终端客户端，不创建第二个 Runtime */
async function main (): Promise<void> {
    const client = new RuntimeClient();
    const cli = new Cli({
        client,
        onboarding: new Onboarding(client),
    });
    process.exitCode = await cli.start(process.argv.slice(2));
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
