# Selfcraft Web

Selfcraft Web 是唯一 Runtime 的浏览器通信入口。Vite 负责本地开发与静态构建，生产环境由同一个 Bun 进程提供 `/api` 和 `web/dist`，前端不持有独立 Agent Loop。首次认识同样发生在这个入口：页面根据 Runtime 的配置状态呈现 Web onboarding，不依赖 CLI 先行配置。

## 技术栈

- React 19 + TypeScript
- Vite 6
- Tailwind CSS 4
- shadcn/ui 源码组件
- BeUI 组件
- Vercel AI SDK `useChat` 与 UI Message Stream

## 目录

```text
web/src/
├── components/
│   ├── ChatView/             # 业务组件：PascalCase 目录 + index.tsx
│   ├── OnboardingView/       # Web 渠道的首次认识与第一句话
│   ├── SettingsView/         # 较小子组件使用 PascalCase 文件名
│   ├── ThemeControls/        # 配色与明暗主题入口
│   ├── agents/               # 按需适配的 BeUI Agent 源码
│   ├── motion/               # 按需适配的 BeUI Motion 源码
│   └── ui/                   # 按需保留的 shadcn/ui 源码
├── hooks/                    # use*.ts 可复用状态
├── lib/                      # 无业务含义的轻量工具
├── services/                 # Runtime HTTP API
├── styles/                   # 全局主题与布局
└── types/                    # *.types.ts 共享接口
```

## 代码约定

- 使用4个空格、单引号、分号与尾逗号
- 组件名使用 PascalCase；函数和变量使用 camelCase；常量使用 UPPER_SNAKE_CASE
- 业务组件每个目录一个 `index.tsx`；同目录独立小组件使用 `PascalCase.tsx`
- shadcn/ui、BeUI Agent 与 BeUI Motion 是上游源码组件，保留 `kebab-case.tsx` 文件名作为明确例外
- 跨目录导入使用 `@/`，同目录子组件使用相对路径
- API 请求只放在 `services/`；不要在展示组件中散落 `fetch`
- 服务端返回结构集中在 `types/*.types.ts`；组件私有 Props 留在组件文件中
- CSS 使用有意义的 className；除运行时尺寸等必要场景外不写内联样式
- 不新增没有调用方的组件、Provider、状态库或扩展点
- API Key 不进入 React 状态之外的持久浏览器存储，也不会从服务端回显

## 组件原则

- Popover、Dialog 等结构性浮层复用 `components/ui` 中已有的 shadcn 组件
- 对话区域统一复用 `components/agents` 中的 BeUI Message、Message Scroller 与 Prompt Input
- 导航、状态反馈和主题转场优先组合 `components/motion` 中已适配的 BeUI 组件
- 表单按钮、输入框、选择器与开关统一复用 `components/motion` 中的 BeUI 基础组件
- 大量选项需要搜索时统一使用 `components/motion/combobox.tsx`，不要临时拼装按钮、Popover 和命令列表
- 只复制真实使用的上游组件；禁止一次性安装完整 shadcn 或 BeUI 注册表
- BeUI 组件属于项目内源码：保留来源注释，适配后接受同等的类型检查、可访问性和维护约束
- 动效只解释状态变化或空间关系，不给普通内容批量添加入场动画
- 页面组件负责业务编排，基础组件不读取 Runtime API
- 异步操作必须覆盖 loading、error、disabled 与空状态
- 图标统一使用 Lucide，不用 emoji 或 Unicode 字符模拟图标

## 主题与可访问性

- 提供“澄蓝”和“墨白”两套配色；墨白只使用水墨中性色，不引入其他彩色强调
- 配色与明暗模式保存在浏览器本地，只保存界面偏好，不保存 Runtime 事实
- 四种组合共用语义 token，不为单个组件维护主题分支
- 磨砂只用于真实覆盖内容的顶栏和浮层，不用于页面背景、输入区或普通内容块
- 所有按钮和表单具有可见键盘焦点；纯图标按钮必须提供可访问名称
- 正文对比度至少 4.5:1；支持 `prefers-reduced-motion`
- 桌面和移动端必须实际验证，不以缩小桌面布局代替响应式设计

## 本地开发

在项目根目录运行：

```bash
bun run dev
```

- Web：`http://127.0.0.1:5173`
- Runtime API：`http://127.0.0.1:3210`
- Vite 将 `/api` 代理到 Runtime

生产构建：

```bash
bun run build:web
```

构建产物写入 `web/dist`，由 Bun WebServer 与 Runtime 一起提供。
