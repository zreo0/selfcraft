<h1 align="center">Selfcraft</h1>

<p align="center">
    <img alt="Selfcraft 云朵角色" src="web/public/brand/selfcraft-cloud.png" width="160">
</p>

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

Selfcraft 当前是一个基于 Bun、TypeScript 和 Vercel AI SDK v7 的实验性内核。CLI 与 Web 是同一个 Runtime 的两个通信入口：

- **Remember** — 保存完整事件时间线，按时间、事项与证据重新想起经历
- **Reflect** — 在对话后异步整理事实、失败和成长候选
- **Work** — 使用 workspace 工具，运行后台 Job，并持久化一次性定时提醒
- **Research** — 搜索外部与近期信息，沿原始网页核验重要结论
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

Selfcraft 始终只有一个 Runtime。Web 和 CLI 只是连接它的不同入口，不会分别启动两套 Agent：

| 目的 | 使用方式 |
|:---|:---|
| 启动完整服务 | `bun run start` |
| 使用 Web | 浏览器打开 `http://127.0.0.1:3210` |
| 使用 CLI | 在另一个终端运行 `bun run cli` |
| 开发 Web 与 Runtime | `bun run dev`，浏览器打开 `http://127.0.0.1:5173` |

`bun run start` 会构建 Web，然后启动 Supervisor、唯一 Runtime 和 HTTP 服务；它只负责让系统运行，不会在启动终端中进入 onboarding。

CLI 是可选客户端，必须在 Runtime 已经启动后使用：

```bash
bun run cli
```

CLI 默认连接 `http://127.0.0.1:3210`，也可以通过 `SELFCRAFT_RUNTIME_URL` 指向其他地址。退出 CLI 不会停止 Runtime；停止服务请回到运行 `bun run start` 的终端按 `Ctrl-C`。

Onboarding 不属于启动器，而属于通信入口。首次使用时任选 Web 或 CLI 完成即可，两者写入同一份模型与时区配置；完成后，另一个入口会直接使用这份配置。请避免同时在两个入口执行首次配置。

Web 会在页面内提供对话式引导，优先采用浏览器检测到的时区，并保留可输入城市名筛选的 IANA 时区选择器。CLI 则使用对应的终端交互，不要求先完成 Web onboarding。

首次流程只询问开始思考所必需的信息。姓名、人格和相处方式不会被做成问卷；完成配置后写下的第一句话会直接进入真实 Agent Loop，而不是停在一张“初始化成功”页面。

如果不设置名字，它就保持未命名。Selfcraft 不会根据项目名替自己决定身份。

模型与网络服务的 API key 只写入权限为 `0600` 的 `config/secrets.json`，不会进入普通配置和日志。

网络搜索是可选基础能力。设置页可以配置 Tavily；CLI 使用 `/web setup`。保存后同一个 Runtime 的下一轮对话立即获得 `web_search` 与 `web_fetch`，无需重启。搜索结果只是外部证据，不会自动写入长期记忆。

需要从一份新配置重新开始时，可以运行：

```bash
bun run reset-config
```

该命令同样通过正在运行的 Runtime 操作。确认后，旧的非敏感 `config.json` 会备份到 `config/backups/<UTC 时间>/`，再进入 CLI onboarding。API key 不会写入历史备份，会被清空并需要重新输入；记忆、会话、任务、技能和 workspace 均保持不变。Web 设置页也提供相同能力。

> 不要把真实凭证粘贴进对话或 workspace 文件。对话记录本身是长期数据，不属于凭证存储。

## 架构

```text
Supervisor（稳定）
  └─ 启动 · 健康观察 · 发布状态 · 自动回滚

Runtime（可演化）
  ├─ Agent Loop
  ├─ HTTP / AI SDK 流式通信边界
  ├─ 长期会话与上下文
  ├─ 后台 Job、定时 Task 与通知
  ├─ 事件时间线、结构化记忆与 Reflection
  ├─ workspace、网络访问工具与技能
  └─ 候选版本提案与验证

通信入口
  ├─ Web ──HTTP──┐
  └─ CLI ──HTTP──┴─> 同一个 Runtime
```

Supervisor 和 Runtime 的边界是刻意留下的：

- **Runtime** 可以学习技能、积累记忆，并在发现可复现问题时提出源码修改
- **Supervisor** 不参与智能行为，只判断新 Runtime 能否健康运行，并在失败时回滚
- `src/supervisor/`、`src/index.ts` 和 `src/doctor.ts` 不能被 Runtime 自我修改

一个能够升级自己的系统，首先需要保留一部分自己不能随意升级的东西。

## 它如何改进自己

```text
对话或任务
  → 记录用户、工具、结果与失败 Event
  → Reflection 提取记忆和成长候选
  → 当前有效且相关的记忆进入后续上下文
  → Agent 检查真实问题
  → 修改技能，或提出 Runtime 候选版本
  → 验证、激活、观察；失败则回滚
```

### 记忆与 Reflection

Selfcraft 没有单独保存一份不断膨胀的 Episode 摘要。它只保留几种不可互相替代的东西：

```text
Event ──证据──> Memory
  │               │
  └──关联──> Topic ┘  ──按查询重建──> Episode

Task ──到期──> Notification + Event
```

- **Event** 是发生过什么的追加式时间线，区分发生时间与记录时间
- **Memory** 是未来仍有用的认识，必须能回到来源 Event，并保留纠错或现实变化形成的版本
- **Topic** 是跨多轮、跨月份甚至跨年份的稳定事项 ID；允许同名，不靠标题强行合并
- **Episode** 不是另一张表，而是按文本、时间、日历日期或 Topic 临时重建的一段经历

`session.sqlite` 保存模型会话原文、历次工作笔记与当前工作窗口。笔记只是可回查的派生数据，不是事实来源；旧 JSONL 仅一次性导入。

用户明确要求“记住”时，Agent 使用 `memory_remember` 写入 active Memory；普通对话结束后只进入持久 Reflection 队列。Runtime 在所有 Agent 工作结束并持续空闲一分钟后，才把尚未回看的连续经历合并为一次 Reflection，由当前模型提取 candidate；如果用户或后台 Agent 在反思期间开始工作，Reflection 会主动中断、放回队列，等下一次空闲继续：

- 身份、事实、偏好、关系、决定和经验教训
- 可复用技能的改进候选
- 可复现 Runtime 缺陷的演化候选

Reflection 只读取本轮真实 Event，模型不能伪造来源。即使置信度很高，candidate 也不会自动成为 active Memory；只有用户明确确认后，Agent 才会用 `memory_confirm` 激活它，并在需要时补充现实有效时间与 Topic。后台 Job 可以读取 Memory，但不能代替用户确认、修订或删除 active Memory。Reflection 同样不会直接创建技能、修改 Runtime，或把未来提醒混进记忆。

### 技能与 Runtime 演化

技能是 workspace 中的 `SKILL.md`。它可以随时新增或修改，下一轮对话自动发现，不需要中心注册或重启。

Runtime 修改则必须经过完整候选流程：

1. 在隔离目录复制当前项目并应用修改
2. 执行类型检查、单元测试和代码健康检查
3. 记录源码基础、验证结果和改进来源，暂存候选
4. 请求 Supervisor 重启，在旧 Runtime 退出后再次验证实例兼容性
5. 备份实例并切换源码，通过启动前检查和运行期健康观察
6. 验证或切换失败时恢复旧源码，保留最近两份完整恢复备份

首版的事项、执行恢复、成长和升级边界见 [最小首版约定](docs/first-version-contract.md)。

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

## 持续事项、后台任务与提醒

持续事项记录目标、完成条件、授权、进展和等待条件。助理通过 `work_create`、`work_list`、`work_update` 管理它们，用户不需要管理 session。时间到达或关联 Job 结束后，Runtime 会唤醒助理核实结果并继续原事项；Job 完成不直接等于事项完成。

前台输入持久接收，完整执行步骤和工具结果可以跨重启恢复。外部操作结果未知时暂停核实，不自动重放。通知已读后保留去重记录。

短操作由 Agent 在当前轮次直接完成。需要较长时间、能够独立推进或不应阻塞对话的工作进入 **Job**；“某个时间提醒我”进入独立的 **Task**。两者不是记忆。

Job 默认最多并发执行两个：

- Agent Job 复用前台 Agent Loop、工具和记忆，但不写入主会话历史
- Runtime 重启后，未完成 Agent Job 根据日志和 workspace 真实状态继续
- Shell Job 使用独立进程；状态无法确认时标记中断，不盲目重放
- 完成、失败和中断都会写入持久通知收件箱

定时 Task 第一版只支持一次性绝对时间，不包含 Cron、重复规则或任意延迟动作。Runtime 启动时会补扫已经到期的提醒，通知使用稳定 ID，避免重启后重复投递；创建、触发、完成、取消和失败都会留下时间线 Event。

## 模型与通信入口

支持三种模型协议：

| 协议 | Base URL |
|:---|:---|
| `openai-compatible` | 必填 |
| `openai` | 可选，留空使用官方地址 |
| `anthropic` | 可选，留空使用官方地址 |

首次认识只需要接入一个模型。它是对话和后台 Agent 的默认模型，反思、上下文整理也默认跟随它；需要时再在 Web 设置的「用途与推理设置」中单独选择。用途覆盖只引用渠道中的模型，不复制地址或凭证。

推理强度默认由提供方决定，可以显式调整，但模型是否会推理与是否支持强度调节是两回事。连接测试会发送一次有界的流式请求，不写入会话或触发反思，也不代表完整工具能力验收。

添加同名渠道会合并模型，更新一个模型不会删除其他模型。Key 留空会保留已有凭证；首次连接无认证的本地 OpenAI-compatible 服务可以不填 Key。Web 可载入已有模型再编辑，凭证始终不会回传。模型 ID 仍可直接输入，不依赖在线目录。

CLI 也可以配置用途与推理强度：

```text
/model use <provider/model> [agent|reflection|compression] [low|medium|high]
/model inherit reflection|compression
```

每次运行固定使用开始时的模型快照，之后修改配置只影响下一次运行；反思在真正开始时解析模型。上下文整理按整理模型的窗口分批处理，原始记录不删除。请求日志标明用途、模型、耗时、用量与结束原因。

Web 支持选择或粘贴 PNG、JPEG、GIF、WebP 图片，每张最多 10 MB，每轮最多 4 张，可以只发送图片。图片原件保存在实例的 `attachments/`，消息使用 AI SDK 标准文件部分；刷新、重启和切换模型后仍可查看原图。

当前模型开启 `vision` 时直接接收原图；纯文本模型通过 `image_analyze` 按具体问题调用已配置且凭证可用的视觉模型。辅助读取优先使用当前视觉模型，否则按渠道与模型 ID 的稳定顺序选择，不修改默认模型；配置的视觉模型可能因此收到图片和当前分析问题。没有视觉模型时保留附件并说明无法理解，不阻断后续文字对话。图片分析最多等待两分钟，前台单轮最多三分钟；只读图片分析失败可以安全重试，已有成功分析结果会复用，涉及写入或其他可能有副作用的工具仍禁止盲目重试。视频、音频和文档输入暂不开放，CLI 暂时保留文字交互。

图片验收可在既有 `smoke` 环境变量之外设置 `SELFCRAFT_TEST_VISION_MODEL_ID`，使用同一测试渠道的视觉模型验证直接输入、辅助分析和切换模型后的追问。

常用命令：

```text
/model list|add|use
/web status|setup|disable
/skills
/jobs [id]
/job cancel|resume <id>
/tasks
/task cancel <id>
/topics [query]
/memory [query]
/growth
/notifications
/status
/exit
```

模型切换从下一次 Agent run 生效。CLI 是独立进程中的 HTTP 客户端，Web 是由 Runtime 提供的静态客户端；两者都不持有 Agent Loop。它们共用同一个前台执行队列、长期会话、Event 时间线和记忆，多个入口同时提交时会按顺序执行，不会产生两个“大脑”。入口只发送本轮新输入，历史上下文始终由 Runtime 组装。

网络访问首版使用 Tavily 的 Search 与 Extract API，并通过内部统一结果与 Agent 工具隔离具体服务。搜索默认采用基础深度、最多返回五条候选；重要事实再读取原文。未来替换服务实现不需要改变 Agent 的工具名、技能规则或记忆边界。

## 数据与上下文

| 环境 | 默认数据目录 |
|:---|:---|
| development | `<project>/.selfcraft/` |
| production | `~/.selfcraft/` |

可以显式覆盖：

```bash
SELFCRAFT_ENV=development SELFCRAFT_HOME=/custom/data bun run start
```

普通对话持续追加到当前工作窗口，不逐轮生成摘要。Runtime 在每个模型请求前检查指令、工具和消息的估算预算；达到工作预算时生成带 `[message:ID]` 原文引用的笔记，原子保存笔记与较小窗口，再继续执行。用户不需要新建会话。

默认工作预算约 48,000 tokens，小窗口模型会提前触发；交接尽量降至触发预算的一半，固定指令与笔记决定最低开销。保留近期完整工具交互并尽量保留当前用户原话。笔记失败保留原窗口，超出安全预算则暂停，不静默丢弃历史。Token 使用字符估算并预留余量，无法保证所有模型的精确上限。

`history_search` 按字面文本检索当前会话的原文或旧笔记，`history_read` 按稳定 ID 分页读取，包括附件引用。它们按需调用，不引入每轮额外检索模型。后台执行有各自内部工作窗口；承诺、取消和执行结果仍以 Work、Execution 等持久状态为准。完整步骤先保存执行检查点再去重追加原文，交接不会清除恢复依据。

超过 8 KiB 的工具结果会写入 `workspace/files/tool-results/`，上下文只保留路径和预览。模型仍使用 AI SDK 标准消息；图片保持持久引用，请求时再读取原件。

## 开发与验证

```bash
bun run dev
```

开发模式默认把实例数据保存在项目内的 `.selfcraft/`。Vite Web 位于 `http://127.0.0.1:5173`，并把 `/api` 代理到 `http://127.0.0.1:3210`。生产构建可以单独执行 `bun run build:web`。

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

第二条命令由开发者手动启动 Runtime，便于修改代码后自行控制重启。随后在宿主机访问 `http://127.0.0.1:3210`，或从另一个终端进入 CLI：

```bash
docker compose -f docker-compose.dev.yml exec selfcraft bun run cli
```

开发容器只把 Web/API 端口绑定到宿主回环地址。

如果命名卷里保留了旧配置，可以在容器中备份并重新配置：

```bash
docker compose -f docker-compose.dev.yml exec selfcraft bun run reset-config
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

直接运行时，生产环境默认使用 `~/.selfcraft/`：

```bash
SELFCRAFT_ENV=production bun run start
```

生产 Compose 会自动启动 Runtime，并使用 Docker 的 `restart: unless-stopped` 管理容器生命周期；容器内仍只有 Supervisor 与其唯一 Runtime，不需要 PM2：

```bash
docker compose up -d --build
```

如果允许 Runtime 自我演化，数据目录和项目源码目录都需要持久化。

## 日志与诊断

日志默认写入 `~/.selfcraft/logs/selfcraft.log`，使用 JSONL 格式，单个文件达到 5 MiB 后轮转并保留最近五份。常见 API key 和 Authorization 字段会被脱敏。

```bash
bun run doctor
```

`doctor` 确定性检查必需源码、数据目录读写能力与模型配置状态，不会调用模型。
