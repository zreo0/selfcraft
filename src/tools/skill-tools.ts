import { tool } from 'ai';
import { z } from 'zod';
import type { SkillRegistry } from '../skills/skill-registry';

/** 创建按需加载技能说明的工具 */
export function createSkillTools (registry: SkillRegistry) {
    return {
        skills: tool({
            description: '列出当前安装的技能',
            inputSchema: z.object({}),
            execute: async () => registry.discover().map(skill => ({
                name: skill.name,
                description: skill.description,
            })),
        }),
        read_skill: tool({
            description: '读取一个技能的完整 SKILL.md；使用技能前应先调用',
            inputSchema: z.object({
                name: z.string().min(1),
            }),
            execute: async ({ name }) => ({ name, instructions: registry.read(name) }),
        }),
    };
}
