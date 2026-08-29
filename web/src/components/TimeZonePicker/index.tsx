import { useMemo } from 'react';
import { Combobox, type ComboboxOption } from '@/components/motion/combobox';

/** 搜索并选择浏览器支持的 IANA 时区 */
export function TimeZonePicker ({ value, onChange }: { value: string; onChange: (value: string) => void }) {
    const timezones = useMemo(() => Array.from(new Set([
        value,
        'UTC',
        ...Intl.supportedValuesOf('timeZone'),
    ])).filter(Boolean), [value]);
    const options = useMemo<ComboboxOption[]>(
        () => timezones.map(timezone => ({ value: timezone, label: timezone })),
        [timezones],
    );
    return <Combobox ariaLabel="IANA 时区" emptyText="没有匹配的时区" onValueChange={onChange} options={options} searchPlaceholder="输入城市或时区，例如 Shanghai" value={value} />;
}
