# AGENTS.md

## 项目定位

Selfcraft 是一个能够发现自身问题、提出改进，并在验证后更新自己的个人智能体。

默认实例没有预设姓名或人格。身份、关系、记忆与能力由 onboarding、持续对话、技能和经过验证的演化逐渐形成。

## 技术基线

- Bun + TypeScript
- Vercel AI SDK v7
- OpenAI-compatible、OpenAI、Anthropic 模型渠道
- CLI 作为第一版通信入口
- 文件系统作为本地持久化边界

## 架构边界

```text
Supervisor（稳定）
  └─ 启动、健康观察、发布状态、自动回滚

Runtime（可演化）
  ├─ Agent Loop
  ├─ CLI / onboarding
  ├─ 模型、上下文与长期会话
  ├─ 持久后台 Job 与通知
  ├─ 结构化记忆与异步 Reflection
  ├─ workspace 工具与技能
  └─ 候选版本提案与验证
```

`src/supervisor/`、`src/index.ts` 和 `src/doctor.ts` 是稳定边界，Runtime 的自我修改不能触碰这些文件。不要在可变 Runtime 中复制 Supervisor 的职责。

## 代码规范

- 使用4个空格缩进
- 文件使用 `kebab-case.ts`，类使用 PascalCase，函数和变量使用 camelCase
- 如无必要，勿增实体；优先使用简单模块和明确的数据结构
- 不引入无实际调用方的抽象、扩展点或配置项
- 每个函数和方法使用简短 JSDoc，说明目的、参数和返回值
- 非显而易见的逻辑说明原因和权衡，注释不使用分隔线
- 修改范围必须能直接追溯到当前需求，不顺手重构相邻代码

## 模块约定

- `src/<module>/` 保存业务实现
- 单元测试放在模块内的 `__tests__/` 目录，命名为 `*.test.ts`
- 工作区工具必须统一经过 `PathGuard`
- API key 只能写入 `config/secrets.json`，不得进入日志、普通配置、测试夹具或仓库
- 技能以 `workspace/skills/<name>/SKILL.md` 为入口，不为技能增加中心注册文件
- Runtime 修改源码必须走 `EvolutionService` 的候选验证流程，不得直接写项目源码
- Reflection 只提交可追溯记忆和成长候选，不得绕过 `EvolutionService` 直接修改 Runtime
- 原始会话记录不得因上下文压缩删除，摘要只是可重建派生数据

## 验证

代码变更完成后至少执行：

```bash
bun run typecheck
bun test
bun run doctor
bun run smoke:evolution
bun run smoke:provider
```

涉及 Agent Loop、工具或会话持久化时，使用显式环境变量执行真实模型验收：

```bash
SELFCRAFT_TEST_BASE_URL=... \
SELFCRAFT_TEST_API_KEY=... \
SELFCRAFT_TEST_MODEL_ID=... \
bun run smoke
```

不得把验收凭证写入脚本或提交到 Git。
