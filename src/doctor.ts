import { resolvePaths } from './config/paths';
import { HealthChecker } from './health/health-checker';

/** 执行可供人和 Supervisor 使用的确定性健康检查 */
function main (): void {
    const codeOnly = process.argv.includes('--code-only');
    const checks = new HealthChecker().check(resolvePaths(), codeOnly);
    console.log(JSON.stringify({
        healthy: checks.every(check => check.healthy),
        checks,
    }, null, 4));
    if (checks.some(check => !check.healthy)) {
        process.exitCode = 1;
    }
}

main();
