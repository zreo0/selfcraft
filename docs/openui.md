# OpenUI 交互

首期用于澄清问题和选择方案：单选、多选、补充文字。模型可选用 `present_ui`，普通回答仍使用文字。OpenUI 负责静态表单描述与 Web 渲染，Runtime 负责验证、持久化和用户输入处理；CLI、Web、iOS 共用同一 Agent Loop。

## 三端使用

| 入口 | 展示与操作 | 恢复 |
| --- | --- | --- |
| Web | 消息内表单；顶部「查看待回答交互」可分页找回旧表单；文字版本可展开 | 按实例及 UI 标识保存 localStorage 草稿和完整提交；加载时查询最新状态与回执 |
| CLI | 文字替代内容；`/ui` 列表、`/ui <id>` 查看、`/ui <id> submit` 逐项填写 | `SELFCRAFT_HOME/client-interactions/` 原子保存草稿和待确认请求，文件权限 0600 |
| iOS 18+ | 原生 SwiftUI 卡片，点击打开表单；对话工具栏「待回答」分页入口 | 按实例隔离、受系统数据保护的原子文件；回到前台同步状态，待确认请求复用原标识 |

选项持久值与显示标签分离。CLI 支持输入编号，多选用逗号分隔，回车保留，`/clear` 清空，`/cancel` 返回。跨端版本冲突保留本地内容，要求核对最新版本后继续，不自动覆盖另一端的填写。

三端均可直接用普通文字回答。未知 UI 版本或组件不能执行，保留完整文字替代内容。普通文字回答不会自动消费旧表单；首期不推断两者的对应关系。

## 统一消息

沿用现有 `ConversationMessage` 和持久 SSE，不替换 AI SDK 消息协议。每张表单作为独立 assistant 消息持久保存：

```json
{
    "id": "assistant:ui:ui_<stable-hash>",
    "role": "assistant",
    "parts": [
        { "type": "text", "text": "完整问题、选项与交互状态" },
        {
            "type": "data-ui",
            "id": "ui_<stable-hash>",
            "data": {
                "id": "ui_<stable-hash>",
                "protocolVersion": 1,
                "libraryVersion": "selfcraft-ui@1",
                "revision": 1,
                "status": "ready",
                "source": "已校验的静态 OpenUI 源码",
                "interaction": {
                    "kind": "clarification",
                    "title": "目标",
                    "description": "补充说明",
                    "fields": [{ "name": "note", "type": "text", "label": "说明", "required": true }],
                    "actions": [{ "id": "submit", "label": "提交回答" }]
                },
                "values": { "note": "" },
                "submissionId": null
            }
        }
    ]
}
```

UI ID 由执行 ID 与 tool call ID 派生，同一工具重放不会创建另一张卡片。消息保持原始序号；草稿或提交改变时生成新的持久变更游标。独立 UI 消息不参与正文流检查点重建，恢复正文不会清空交互。`interaction` 是 Runtime 从同一组件契约派生的原生语义，客户端不能提交自己的组件定义。

`GET /api/bootstrap` 返回稳定 `instanceId` 和 `interaction` 协议能力。状态 `ready` 可编辑，`submitted` 已消费；`closed` 为只读兼容状态，首期没有关闭动作接口。

## 回传和幂等

| 接口 | 含义 |
| --- | --- |
| `GET /api/conversation/ui?after=0` | 待回答列表，每页最多 50 条，返回 `nextCursor` |
| `GET /api/conversation/ui/:id` | 最新快照 |
| `PATCH /api/conversation/ui/:id/state` | `{expectedRevision, values}` 草稿保存 |
| `POST /api/conversation/ui/:id/actions` | `{submissionId, expectedRevision, actionId:"submit", values}` |
| `GET /api/conversation/ui/submissions/:submissionId` | 查询持久接收回执，404 表示尚未接收 |

客户端先落盘完整提交，再发送。超时保留原 `submissionId`、版本和内容；查询回执或人工重试均不生成新意图。服务端事务同时保存回执、消费表单、更新字段与版本。相同提交标识和规范化内容返回原回执；更换内容、不同请求再次消费同一表单、旧版本写入返回 409；字段校验失败返回 422。

回执 `accepted` 只表示已持久接收，不表示模型已完成。Runtime 将规范化回答转为一次用户输入，执行 ID 固定为 `ui-submit:<submissionId>`，通过既有 `ForegroundRunner` 投递。交互提交幂等不等于任意外部工具具备 exactly-once 保证；模型处理失败或未知副作用仍遵守原执行恢复规则。

接口沿用已有鉴权、同源写入检查和密钥隔离规则。请求限制 40000 字符，字段最多 10 个、选项 2–12 个、补充文字最多 2000 字符；表单源码最多 32000 字符、嵌套不超过 32 层。

## 持久化和断线

仍使用本地 `state.sqlite`：`conversation_ui` 保存源码、语义、字段、版本及消息投影进度；`conversation_ui_submissions` 保存幂等内容、回执和待投递状态。

- 展示工具中断：启动先补齐已经记录的 `present_ui` 结果，再走原执行恢复
- 保存 UI 后、发布消息前中断：按稳定消息 ID 补齐投影
- 接收提交后、进入执行队列前中断：根据持久提交补投
- 执行已经接收、尚未标记投递时中断：读取原执行回执，不创建新执行
- 临时投影或投递失败：服务运行期间每秒重试未完成记录，重启也会恢复
- SSE 断线：沿用原持久变更游标补读；消息更新覆盖同 ID，避免重复卡片
- 客户端关闭：本地填写和原提交意图保留；不会因关闭页面取消 Runtime 已接收执行

表单草稿采用版本冲突检查。请求成功但响应丢失可能要求核对最新版本，这属于保守恢复，不会静默覆盖另一端。磁盘写入失败会显示错误，不将未落盘意图当作可靠提交。

## 安装与运行无遥测

固定 `@openuidev/lang-core@1.0.1` 和 `@openuidev/react-lang@1.0.1`，提交 Bun 锁文件及 `patches/`：

1. lang-core 安装入口为空操作；ESM/CJS 遥测判定强制关闭，即使启用变量被误设也不发送
2. react-lang 的开发模式远程 DevTools 启动路径强制关闭
3. Web Renderer 设置 `publishObservability={false}`；原生 iOS 不引入 OpenUI JS、WebView 或统计 SDK
4. Docker 在安装前复制补丁，并设置禁用变量；`.env.example` 提供相同默认值

安装使用：

```bash
OPENUI_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 bun install --frozen-lockfile --ignore-scripts
```

运行可使用原来的 `bun run start` / `bun run dev` / `bun run cli`。不要使用上游脚手架、远程 DevTools 或 `bun pm trust` 开启安装脚本。升级 OpenUI 必须同步审查补丁和重新验证，不能删除补丁后只依赖可被覆盖的环境变量。

无遥测不等于离线：依赖下载、用户选择的模型服务、用户启用的搜索与业务请求仍正常联网。验证范围是本集成及锁定依赖中的遥测路径，不改变操作系统或用户自行部署的模型服务的数据政策。

## 验证

```bash
bun run typecheck
bun test
bun run doctor
bun run smoke:evolution
bun run smoke:provider
bun run smoke:interaction
```

`smoke:interaction` 需要已安装的 `agent-browser`，创建临时本机实例，验证真实 Web 渲染、草稿重载、跨端冲突、丢失回执恢复、窄屏和同源资源请求。`src/interaction/__tests__` 验证数据库恢复及遥测补丁；CLI 测试覆盖请求送达前与接收后断线。

真实模型验收继续使用显式 `SELFCRAFT_TEST_BASE_URL`、`SELFCRAFT_TEST_API_KEY`、`SELFCRAFT_TEST_MODEL_ID` 执行 `bun run smoke`，已包含生成表单、回答回传、重启读取和幂等断言。iOS 使用 `Selfcraft` scheme 的模拟器测试，新增协议兼容、意图落盘和跨端冲突用例。密钥不得写入测试夹具或仓库。

首期不支持任意 HTML/JavaScript、Query/Mutation、远程组件、图表、表格或动态表达式；不流式启用未校验的表单。表单动作只提交回答，不能直接获得文件写入、部署或其他工具权限。

### 本次验收记录（2026-10-16）

- TypeScript 检查、Web 生产构建通过；构建仍提示主 JS 包超过 500 kB（约 1.01 MB，gzip 317 kB）
- Bun 全量 221 项测试通过；iOS 18.6 模拟器 29 项测试通过
- `doctor` 使用独立临时 home 通过；演化候选验证、激活、回滚及渠道 HTTP 冒烟通过
- 真实模型 `ay-agent-flash` 的 `smoke` 通过，包含交互生成、回答回传与恢复，同时保留原工具和上下文验收
- 浏览器验收通过：草稿重载、跨端冲突后重载、回执丢失、键盘提交、390/1280 宽度、实际浅深色切换、减少动效；恢复后服务端只接收一次提交，测试页面外部资源请求为 0
- 聊天历史显示回归通过；干净目录 frozen install 验证 ESM/CJS 补丁、空安装入口和开发工具禁用均生效
- 本地测试容器已按无遥测方式安装依赖并重启，保留原数据卷；原有 135 条消息、配置、凭证与实例身份校验通过，实际 Web 表单生成、草稿持久化和刷新恢复验证通过
- 尚未做 iPhone 真机和局域网网络切换验收

### 提交摘要

用户提交消息新增 `data-ui-submission`，保存 `version: 1`、`uiId`、`submissionId`、标题与有序的字段/答案快照。Web 和 iOS 在用户气泡内显示“标题 · 已提交”及逐项答案，CLI 输出同义文字；多选保留选项顺序，空答案显示“未填写”，iOS 复制使用摘要正文。

原始文本和模型输入保留。Runtime 启动时仅根据持久提交回执补齐旧消息摘要，并核对消息原文，不猜测或解析任意用户聊天内容。补齐沿用消息 ID、时间和序号，通过既有增量游标同步到在线客户端；重复恢复不增加消息，也不重新执行已投递提交。未知摘要版本或损坏内容回退到原文。

提交摘要验收（2026-10-16）：223 项 Bun 测试、31 项 iOS 模拟器测试、类型检查、doctor、演化/渠道冒烟和真实模型 `ay-agent-flash` 验收通过。浏览器验证摘要显示、草稿与丢失回执恢复、390/1280 宽度及浅深色，外部资源请求为 0。本地容器已更新，既有 140 条消息原文和元数据、提交回执及配置凭证保持不变，补齐 1 条旧提交摘要；实际 Web、CLI 与在线 iOS 模拟器均确认展示更新，容器内遥测禁用测试通过。
