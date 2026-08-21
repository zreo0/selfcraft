<h1 align="center">Selfcraft</h1>

<p align="center"><strong>一个能够发现自身问题、提出改进，并在验证后更新自己的个人智能体</strong></p>

<p align="center">
    <img alt="Bun 1.3+" src="https://img.shields.io/badge/Bun-1.3%2B-14151A?logo=bun&logoColor=white">
    <img alt="TypeScript 5.9" src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white">
    <img alt="Vercel AI SDK 7" src="https://img.shields.io/badge/AI_SDK-7-000000">
    <img alt="Local first" src="https://img.shields.io/badge/storage-local--first-2F855A">
    <img alt="Experimental" src="https://img.shields.io/badge/status-experimental-D97706">
</p>

<p align="center"><code>Remember · Reflect · Learn · Evolve · Roll back</code></p>

<p align="center">
    <a href="#为什么是-selfcraft">为什么</a> ·
    <a href="#快速开始">开始使用</a> ·
    <a href="#架构">架构</a> ·
    <a href="#它如何改进自己">自我改进</a> ·
    <a href="#开发与验证">开发</a>
</p>

---

## 为什么是 Selfcraft？

Selfcraft 始于一个很直接的念头：

> 既然我们在不断改进 Agent 的工作流，为什么这件事不能由 AI 自己做？
>
> 一个系统的升级，为什么必须来自上游？

传统的软件升级从开发者流向用户：修改代码、发布版本、重新部署。这当然可靠，但对于一个长期运行的个人智能体，它也有明显的局限——真正的问题往往发生在具体的人、具体的环境和一段持续的相处中，而不是发生在框架作者预先设想的场景里。

Agent 离这些问题最近。它知道哪些工作流反复失败，哪些步骤总要重新解释，也知道自己缺少什么能力，也知道上游的更新内容，判断自己是否需要进行更新。Selfcraft 想做的，是让它不只完成任务，还能把这些经历变成记忆、技能和经过验证的 Runtime 改进。

> [!IMPORTANT]
> 这不等于让 AI 随意重写自己。改变必须有证据，修改必须经过测试，失败必须能够回滚。并且应该相信，未来的模型能力完全能够支持 Agent 的自我改进。

**成长发生在 Runtime，生存底线留在 Supervisor。**

与此同时，一个新实例没有预设姓名或人格。身份、关系和行为方式不从模板继承，而是在 onboarding、长期记忆与持续使用中逐渐形成。

## 现在能做什么

Selfcraft 当前是一个基于 Bun、TypeScript 和 Vercel AI SDK v7 的实验性内核，以 CLI 作为第一版入口：

- **Remember** — 保留长期会话，从经历中形成有来源的结构化记忆
- **Reflect** — 在对话后异步整理事实、失败和成长候选
- **Work** — 使用 workspace 工具，并运行可持久化的后台 Agent / Shell 任务
- **Learn** — 通过可发现、可修改的 `SKILL.md` 扩展能力
- **Evolve** — 在隔离环境验证候选源码，通过后再更新 Runtime
- **Recover** — 由独立 Supervisor 观察新版本，并在失败时自动回滚

模型渠道支持 OpenAI-compatible、OpenAI 和 Anthropic。

目前仍是实验版本，并没有过多的安全约束。请不要在对话或 workspace 中粘贴真实凭证，也不要在生产环境中直接运行未经验证的 Runtime。

## 快速开始

需要 Bun 1.3 或更高版本。

```bash
bun install
bun run start
```

第一次启动会进入 onboarding，依次配置模型协议、Base URL、API key、Model ID 和上下文参数，也可以选择是否给实例一个初始称呼。

如果不设置名字，它就保持未命名。Selfcraft 不会根据项目名替自己决定身份。

API key 只写入权限为 `0600` 的 `config/secrets.json`，不会进入普通配置和日志。

> 不要把真实凭证粘贴进对话或 workspace 文件。对话记录本身是长期数据，不属于凭证存储。

## 架构

```text
Supervisor（稳定）
  └─ 启动 · 健康观察 · 发布状态 · 自动回滚

Runtime（可演化）
  ├─ Agent Loop / CLI
  ├─ 长期会话与上下文
  ├─ 后台 Job 与通知
  ├─ 结构化记忆与 Reflection
  ├─ workspace 工具与技能
  └─ 候选版本提案与验证
```

Supervisor 和 Runtime 的边界是刻意留下的：

- **Runtime** 可以学习技能、积累记忆，并在发现可复现问题时提出源码修改
- **Supervisor** 不参与智能行为，只判断新 Runtime 能否健康运行，并在失败时回滚
- `src/supervisor/`、`src/index.ts` 和 `src/doctor.ts` 不能被 Runtime 自我修改

一个能够升级自己的系统，首先需要保留一部分自己不能随意升级的东西。

## 它如何改进自己

```text
对话或任务
  → 记录结果与失败
  → Reflection 提取记忆和成长候选
  → 筛选后的记忆与候选进入后续上下文
  → Agent 检查真实问题
  → 修改技能，或提出 Runtime 候选版本
  → 验证、激活、观察；失败则回滚
```

### 记忆与 Reflection

Selfcraft 同时保留两类信息：

- `transcript.jsonl` 记录发生过什么，不因上下文压缩删除
- SQLite 结构化记忆保存未来仍有用的事实，并记录来源、可信度、重要性和证据数

用户明确要求“记住”时，Agent 使用 `memory_remember`；要求忘记时使用 `memory_forget`。前台对话和后台 Agent Job 结束后还会进入持久 Reflection 队列，由当前模型异步提取：

- 身份、用户事实、偏好、关系、承诺、方法和经验
- 可复用技能的改进候选
- 可复现 Runtime 缺陷的演化候选

Reflection 采用经过校验的纯文本 JSON 协议，不要求模型渠道支持 structured outputs。它只写入结构化记忆和成长候选，不直接创建技能，也不直接修改 Runtime。

### 技能与 Runtime 演化

技能是 workspace 中的 `SKILL.md`。它可以随时新增或修改，下一轮对话自动发现，不需要中心注册或重启。

Runtime 修改则必须经过完整候选流程：

1. 在隔离目录复制当前项目并应用修改
2. 执行类型检查、单元测试和代码健康检查
3. 备份受影响文件并原子激活候选版本
4. 请求 Supervisor 重启 Runtime
5. 通过启动前检查和运行期健康观察
6. 检查失败或进程崩溃时恢复备份

## Workspace：开始生长的地方

```text
~/.selfcraft/workspace/
├── HANDBOOK.md     # 工作方式与安全约定
├── IDENTITY.md     # 当前身份与自我描述
├── USER.md         # 与用户有关的信息
├── MEMORY.md       # 共同维护的长期核心记忆
├── files/          # 任务产物与大型工具结果
└── skills/         # 可发现、可修改的技能
```

新增技能只需创建：

```text
~/.selfcraft/workspace/skills/<name>/SKILL.md
```

文件工具统一限制在 workspace。Shell 同样从 workspace 启动，但保留正常命令能力；生产环境仍应使用独立 VM 或容器作为主要隔离边界。

## 后台任务

短操作由 Agent 在当前轮次直接完成。只有需要较长时间、能够独立推进或不应阻塞对话的工作才进入后台。

Job 默认最多并发执行两个：

- Agent Job 复用前台 Agent Loop、工具和记忆，但不写入主会话历史
- Runtime 重启后，未完成 Agent Job 根据日志和 workspace 真实状态继续
- Shell Job 使用独立进程；状态无法确认时标记中断，不盲目重放
- 完成、失败和中断都会写入持久通知收件箱

## 模型与 CLI

支持三种模型协议：

| 协议 | Base URL |
|:---|:---|
| `openai-compatible` | 必填 |
| `openai` | 可选，留空使用官方地址 |
| `anthropic` | 可选，留空使用官方地址 |

常用命令：

```text
/model list|add|use
/skills
/jobs [id]
/job cancel|resume <id>
/memory [query]
/growth
/notifications
/status
/exit
```

模型切换从下一次 Agent run 生效。CLI 只是当前通信入口，其他入口可以复用 Runtime 的单轮执行边界。

## 数据与上下文

| 环境 | 默认数据目录 |
|:---|:---|
| development | `<project>/.selfcraft/` |
| production | `~/.selfcraft/` |

可以显式覆盖：

```bash
SELFCRAFT_ENV=development SELFCRAFT_HOME=/custom/data bun run start
```

上下文摘要保存在 `context.json`，它是可以重建的派生数据；原始会话仍持续追加。超过 8 KiB 的工具结果会写入 `workspace/files/tool-results/`，上下文只保留路径和预览。

## 开发与验证

```bash
bun run dev
```

开发模式默认把实例数据保存在项目内的 `.selfcraft/`。

基础检查：

```bash
bun run typecheck
bun test
bun run doctor
```

关键闭环验收：

```bash
bun run smoke:evolution
bun run smoke:provider
```

真实模型端到端验收：

```bash
SELFCRAFT_TEST_BASE_URL=http://provider.example/v1 \
SELFCRAFT_TEST_API_KEY=... \
SELFCRAFT_TEST_MODEL_ID=model-id \
bun run smoke
```

验收数据写入临时目录，凭证不会写入脚本或仓库。

## Docker 开发环境

<details>
<summary>展开 Docker Compose 使用说明</summary>

`docker-compose.dev.yml` 启动常驻开发容器，但不会自动启动 Runtime：

```bash
docker compose -f docker-compose.dev.yml up -d --build
docker compose -f docker-compose.dev.yml exec selfcraft bun run start
```

宿主源码挂载到 `/app`；依赖和实例数据分别保存在 Compose 命名卷。Selfcraft 通过 `docker compose exec` 运行，输出属于当前终端，不会出现在 `docker compose logs`。

停止容器但保留数据：

```bash
docker compose -f docker-compose.dev.yml down
```

删除容器和命名卷，从全新实例开始：

```bash
docker compose -f docker-compose.dev.yml down -v --remove-orphans
```

`down -v` 不会删除宿主源码。不要在同一个数据卷上同时启动多个 Runtime；需要隔离源码演化时，应使用独立 Git worktree 或项目副本。

</details>

生产环境默认使用 `~/.selfcraft/`：

```bash
SELFCRAFT_ENV=production bun run start
```

如果允许 Runtime 自我演化，数据目录和项目源码目录都需要持久化。

## 日志与诊断

日志默认写入 `~/.selfcraft/logs/selfcraft.log`，使用 JSONL 格式，单个文件达到 5 MiB 后轮转并保留最近五份。常见 API key 和 Authorization 字段会被脱敏。

```bash
bun run doctor
```

`doctor` 确定性检查必需源码、数据目录读写能力与模型配置状态，不会调用模型。
