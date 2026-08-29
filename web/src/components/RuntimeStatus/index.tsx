import { Activity, Database, FolderOpen } from 'lucide-react';
import { AnimatedBadge } from '@/components/motion/animated-badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { ConfigView, RuntimeView } from '@/types/api.types';

/** 在导航侧栏展示唯一 Runtime 的健康与持久目录 */
export function RuntimeStatus ({ runtime, config }: { runtime: RuntimeView; config: ConfigView | null }) {
    const healthy = runtime.checks.every(check => check.healthy);
    return (
        <Popover>
            <PopoverTrigger asChild>
                <button className="runtime-trigger" type="button">
                    <AnimatedBadge status={healthy ? 'success' : 'danger'}>
                        {healthy ? 'Runtime 在线' : 'Runtime 异常'}
                    </AnimatedBadge>
                </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="runtime-popover" sideOffset={10}>
                <div className="runtime-popover-heading">
                    <div>
                        <strong>{healthy ? '运行正常' : '需要检查'}</strong>
                        <span>{config?.configured ? `${config.activeModel?.providerId}/${config.activeModel?.modelId}` : '等待模型配置'}</span>
                    </div>
                    <span className={healthy ? 'status-light status-light--healthy' : 'status-light status-light--error'} />
                </div>
                <div className="runtime-details">
                    <p className="flex items-start gap-2"><Activity aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />{runtime.environment}</p>
                    <p className="flex items-start gap-2"><Database aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" /><code className="break-all">{runtime.home}</code></p>
                    <p className="flex items-start gap-2"><FolderOpen aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" /><code className="break-all">{runtime.workspace}</code></p>
                </div>
            </PopoverContent>
        </Popover>
    );
}
