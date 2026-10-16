import { createContext, useContext, useState } from 'react';
import { Renderer, createLibrary, defineComponent } from '@openuidev/react-lang';
import { uiLibrary } from '@interaction/protocol';
import { Button } from '@/components/motion/button';
import { Input } from '@/components/motion/input';
import { useInteraction } from '@/hooks/useInteraction';
import { supportsInteraction, type InteractionView } from '@/types/interaction.types';

type FormState = ReturnType<typeof useInteraction>;
const FormContext = createContext<FormState | null>(null);

/** 将受控字段映射为现有 BeUI 控件，字段语义以 Runtime 描述为准 */
function Field ({ name }: { name: string }) {
    const state = useContext(FormContext)!;
    const field = state.view.interaction.fields.find(item => item.name === name);
    if (!field) return null;
    const disabled = !state.loaded || state.view.status !== 'ready' || state.busy || Boolean(state.pending);
    const value = state.values[name];
    return <fieldset className="space-y-2" disabled={disabled}>
        <legend className="mb-2 text-sm font-medium">{field.label}{field.required ? '（必填）' : ''}</legend>
        {field.type === 'text' ? <Input aria-label={field.label} maxLength={2000} value={typeof value === 'string' ? value : ''}
            onChange={next => state.change(name, next)} /> : <div className="grid gap-2 sm:grid-cols-2">
            {field.options?.map(option => {
                const selected = Array.isArray(value) ? value.includes(option.value) : value === option.value;
                return <Button className="h-auto min-h-12 justify-start whitespace-normal px-3 py-3 text-left" key={option.value}
                    aria-pressed={selected} type="button" variant={selected ? 'secondary' : 'outline'} onClick={() => {
                        state.change(name, field.type === 'single-select' ? option.value : selected
                            ? (Array.isArray(value) ? value : []).filter(item => item !== option.value)
                            : [...(Array.isArray(value) ? value : []), option.value]);
                    }}>
                    <span><span className="block">{option.label}{selected ? ' · 已选' : ''}</span>
                        {option.description && <span className="mt-1 block text-xs font-normal text-muted-foreground">{option.description}</span>}</span>
                </Button>;
            })}
        </div>}
    </fieldset>;
}

/** 复用服务端组件 Schema，React 只负责平台展示 */
const library = createLibrary({ root: 'Form', components: Object.values(uiLibrary.components).map(definition => defineComponent({
    ...definition,
    component: ({ props, renderNode }) => definition.name === 'Form'
        ? <div className="space-y-5"><div><h3 className="font-medium">{String(props.title)}</h3><p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{String(props.description)}</p></div>{renderNode(props.fields)}</div>
        : <Field name={String(props.name)} />,
})) });

/** 渲染已确认的交互；版本未知时保留相邻的文字替代内容 */
export function InteractionCard ({ value, instanceId }: { value: InteractionView; instanceId: string }) {
    const state = useInteraction(value, instanceId);
    const [renderError, setRenderError] = useState(false);
    const supported = supportsInteraction(value);
    if (!supported) return <p className="text-sm text-muted-foreground">此版本暂不支持该表单，可以直接用文字回答</p>;
    return <FormContext.Provider value={state}><section className="my-3 space-y-4 rounded-xl border border-border bg-background p-4 sm:p-5" aria-label={value.interaction.title}>
        <Renderer response={value.source} library={library} publishObservability={false} onError={errors => setRenderError(errors.some(error => error.severity !== 'warning'))} />
        {renderError && <p role="alert">表单无法显示，请直接用文字回答</p>}
        {state.error && <div role="alert" className="text-sm text-destructive">{state.error}</div>}
        {state.view.status === 'ready' ? <div className="flex flex-wrap gap-2">
            <Button disabled={!state.loaded || state.busy || renderError || (state.conflicted && !state.pending)} onClick={() => void state.submit()} type="button">{state.busy ? '正在确认' : state.pending ? '确认原提交结果' : '提交回答'}</Button>
            {state.error && (!state.pending || !state.loaded) && <Button variant="outline" onClick={() => void state.refresh()} type="button">核对最新版本并保留填写</Button>}
        </div> : <p role="status" className="text-sm text-muted-foreground">{state.view.status === 'submitted' ? '回答已接收，处理结果见后续对话' : '此交互已关闭'}</p>}
    </section></FormContext.Provider>;
}
