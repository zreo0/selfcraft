import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** 合并条件 className 并解决 Tailwind 类冲突 */
export function cn (...inputs: ClassValue[]): string {
    return twMerge(clsx(inputs));
}
