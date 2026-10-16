import type { SubmissionSummary as Summary } from '@interaction/submission-summary';

/** 在用户气泡内呈现已提交答案，保留长文本换行和多选顺序 */
export function SubmissionSummary ({ value }: { value: Summary }) {
    return (
        <section aria-label="已提交的回答" className="min-w-0 space-y-3 break-words text-foreground [overflow-wrap:anywhere]">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-muted-foreground">
                <span>{value.title}</span>
                <span className="text-xs">已提交</span>
            </div>
            <dl className="space-y-3">
                {value.answers.map((item, index) => (
                    <div className="space-y-1" key={index}>
                        <dt className="text-xs text-muted-foreground">{item.field}</dt>
                        <dd className="whitespace-pre-wrap">
                            {item.answer.filter(Boolean).length > 1 ? <ul className="list-disc space-y-1 pl-4">
                                {item.answer.filter(Boolean).map((answer, index) => <li key={index}>{answer}</li>)}
                            </ul> : item.answer.find(Boolean) || <span className="text-muted-foreground">未填写</span>}
                        </dd>
                    </div>
                ))}
            </dl>
        </section>
    );
}
