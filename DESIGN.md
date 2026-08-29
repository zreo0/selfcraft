---
name: Selfcraft Web
description: 一个安静运行、持续陪伴的个人智能体界面
colors:
  light-background: "oklch(99% 0 0)"
  light-foreground: "oklch(15% 0 0)"
  light-card: "oklch(97% 0 0)"
  dark-background: "#151515"
  dark-foreground: "oklch(96% 0 0)"
  dark-card: "#1c1c1c"
  blue-light-primary: "oklch(55% 0.18 255)"
  blue-dark-primary: "oklch(70% 0.15 255)"
  ink-light-primary: "oklch(15% 0 0)"
  ink-light-accent: "oklch(28% 0 0)"
  ink-dark-primary: "oklch(96% 0 0)"
  ink-dark-accent: "oklch(82% 0 0)"
  destructive: "oklch(62% 0.22 25)"
typography:
  display:
    fontFamily: "Noto Serif SC Variable, Noto Serif SC, serif"
    fontSize: "clamp(2.7rem, 5vw, 4.6rem)"
    fontWeight: 650
    lineHeight: 1.05
    letterSpacing: "-0.04em"
  title:
    fontFamily: "Avenir Next, SF Pro Display, Segoe UI Variable, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "clamp(1.25rem, 2.4vw, 1.65rem)"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.03em"
  body:
    fontFamily: "Avenir Next, SF Pro Display, Segoe UI Variable, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "0.94rem"
    fontWeight: 400
    lineHeight: 1.75
  label:
    fontFamily: "Avenir Next, SF Pro Display, Segoe UI Variable, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "0.78rem"
    fontWeight: 600
    lineHeight: 1.4
rounded:
  compact: "0.65rem"
  control: "0.75rem"
  row: "0.85rem"
  surface: "1.45rem"
spacing:
  xs: "0.5rem"
  sm: "0.75rem"
  md: "1rem"
  lg: "2rem"
  xl: "3rem"
components:
  button-primary:
    backgroundColor: "{colors.blue-light-primary}"
    textColor: "{colors.light-background}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 1rem"
    height: "2.5rem"
  input:
    backgroundColor: "{colors.light-card}"
    textColor: "{colors.light-foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 0.875rem"
    height: "2.75rem"
  conversation-composer:
    backgroundColor: "{colors.light-card}"
    textColor: "{colors.light-foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.surface}"
    padding: "0.5rem"
---

# Design System: Selfcraft Web

## Overview

**Creative North Star: “安静运行的仪器”**

Selfcraft 不是聊天产品的侧栏集合，也不是运维仪表盘。它像一件长期放在桌面上的精密仪器：状态始终可见但不抢注意力，对话占据唯一主舞台，设置与主题在需要时展开。

视觉以近白和深灰中性色建立稳定环境，用细边界、宽阔留白和清新的云朵角色表达安静陪伴。BeUI Agent 与 Motion 统一消息、滚动、输入、表单和状态变化；运动说明“什么变了”，不装饰静止内容。

**Key Characteristics:**

- 顶部统一承载品牌、入口、Runtime 状态和视觉偏好
- 对话是宽阔连续的平面，不拆成卡片式信息墙
- 澄蓝与墨白是两套可选声部；墨白只使用水墨中性色
- 衬线只在首次认识和设置标题中形成编辑感，正文保持高可读
- 磨砂只用于真实悬浮层和顶栏

## Colors

系统使用同一组中性背景与两套强调色。浅色以低刺激近白为底，深色以相邻深灰建立层级，不使用纯白或纯黑。

### Primary

- **澄蓝**：用于主要动作、选中导航、焦点和 Runtime 的积极状态；深色模式使用更明亮、较低饱和的对应色
- **墨色主声部**：墨白配色用近黑或近白承担主要动作，让界面保持纯粹的水墨关系

### Secondary

- **水墨灰**：只在墨白配色中承担关键状态、细小标记和选中反馈，不引入任何彩色倾向

### Neutral

- **雾白底面**：浅色页面背景，卡片比页面略深，避免绝对白色造成眩光
- **深灰底面**：暗色页面与表面使用相邻深灰建立可见深度
- **柔和文本**：正文使用高对比前景色，辅助文字使用中等明度中性色；正文与背景对比度不得低于 4.5:1

### Named Rules

**The Two-Axis Theme Rule.** 配色和明暗是两个独立维度；组件只消费语义 token，不编写四套分支样式。

**The Ten Percent Rule.** 强调色只用于动作、选择和状态，不扩散到大面积背景。

## Typography

**Display Font:** Noto Serif SC Variable（自托管，Noto Serif SC 回退）  
**Body Font:** Avenir Next / SF Pro Display / Segoe UI Variable / 中文系统无衬线  
**Label/Mono Font:** 标签沿用正文；代码使用 SFMono-Regular / Consolas 回退

**Character:** 展示字体提供安静而有分量的中文编辑感，无衬线正文负责持续阅读和操作准确性。层级来自字形、尺度与留白，不依赖全大写或装饰性字距。

### Hierarchy

- **Display**：只用于 onboarding 与设置页的核心标题，最大不超过 4.6rem，字距下限为 -0.04em
- **Title**：用于对话式步骤和设置区块，尺寸克制、字重明确
- **Body**：用于解释和消息正文，长文行宽控制在约 65ch
- **Label**：用于状态、表单和辅助操作，保持中高字重与清晰对比

### Named Rules

**The Two Voices Rule.** 衬线字体只承担展示级标题；正文、按钮、状态和导航全部使用无衬线字体。

## Layout

页面直接占满视口，没有额外外壳、外边距或外围边框；顶部 4.4rem 是唯一全局导航。对话时间线和输入区控制在约 48rem 的可读宽度；设置使用紧凑左栏导航与宽内容栏，onboarding 使用不对称双栏。

800px 以下双栏折为单栏；560px 以下只保留导航图标和核心操作。空间节奏以 0.5rem、0.75rem、1rem、2rem、3rem 为主，相关控件紧密成组，分区使用留白和一像素边界分隔。

## Elevation & Depth

深度来自相邻中性色、低对比边界和带偏移的柔和阴影。页面背景必须是纯净色面，不使用环境渐变；静止内容保持平面，输入区、浮层和 onboarding 操作面才允许抬升。只有真实覆盖下层内容的顶栏和浮层可以使用 backdrop-filter。

### Shadow Vocabulary

- **Composer Lift**：向下偏移的柔和阴影，使输入区稳定悬浮在时间线上
- **Action Response**：带当前强调色的短距离阴影，仅用于主操作和选中指示

### Named Rules

**The Layer Before Blur Rule.** 只有表面真实覆盖内容时才能使用磨砂；先有层级，再有模糊。

## Shapes

形状语言以 0.65–0.85rem 的紧凑控件圆角和 1.45rem 的焦点表面为主。页面自身没有容器圆角；状态徽章和发送动作可以使用完整胶囊或圆形，普通内容区不做胶囊化。品牌核心使用浅蜜桃背景上的白色云朵角色，在顶栏、首次认识、空状态与对话头像中重复出现。

## Components

### Buttons

- **Shape:** 默认为柔和 0.75rem 圆角，图标与发送操作可使用圆形
- **Primary:** 当前配色的 primary 底与对应反色文字，只保留一个页面级主动作
- **Hover / Focus:** hover 调整色面；focus 使用两像素 ring；active 只下移一像素
- **Secondary / Ghost:** 保持透明或中性色表面，只在 hover 时显现层级

### Chips

- **Style:** 只承载 Runtime、活动模型和简短确认状态，以低对比边界和轻染色面呈现
- **State:** 动态状态使用 BeUI AnimatedBadge 在原位交换内容，不创建永久状态面板

### Cards / Containers

- **Corner Style:** 焦点操作面使用 1.45rem 圆角；普通设置区不包卡片
- **Background:** 只使用 background、card 与 popover 三个语义层级
- **Shadow Strategy:** 默认无阴影，只有真实浮层遵循 Elevation 词汇
- **Border:** 一像素低对比边界

### Inputs / Fields

- **Style:** 2.75rem 基础高度，半透明中性色背景和柔和边界
- **Focus:** 边界转向 ring 并显示清晰焦点环
- **Search Select:** 大量选项使用 BeUI 风格 Combobox；浮层只做 180ms 淡入和 4px 位移，不使用弹性回弹或触发器缩放
- **Error / Disabled:** 错误使用 destructive 轻染表面；禁用降低透明度并阻止交互

### Navigation

全局导航使用 BeUI 共享布局指示器在“对话”和“设置”之间移动。桌面显示图标与文字，窄屏只保留带可访问名称的图标。活动项使用 primary 色面；主题配色在 popover 内使用分段选择。

### Conversation Composer

输入区是对话的持续锚点。BeUI Prompt Input 负责自动增高、键盘提交和发送/停止状态；BeUI Message Scroller 只在读者停留于最新位置时跟随流式内容；Message 与 Message Typing 统一消息结构和等待反馈。

### First Meeting

首次认识使用同一顶栏和品牌语言。左侧解释关系与边界，右侧以真实对话节奏依次完成模型、时区和第一句话；确定性输入使用标准表单，不伪造已经发生的 Agent 对话。

## Do's and Don'ts

### Do:

- **Do** 让用户进入页面后先识别对话、当前 Runtime 与唯一下一步
- **Do** 在澄蓝和墨白配色中分别验证浅色、深色与移动端
- **Do** 使用 BeUI Agent 与 Motion 统一消息、表单、状态交换和主题变化，并尊重 `prefers-reduced-motion`
- **Do** 使用 Lucide 或明确绘制的 SVG，并为纯图标按钮提供可访问名称
- **Do** 让设置保持完整，但在视觉上始终从属于对话

### Don't:

- **Don't** 把主页做成侧栏、指标墙、卡片网格或多面板控制台
- **Don't** 使用纯白、纯黑、环境渐变、彩色水墨主题、高饱和暗色强调或硬偏移阴影
- **Don't** 为静止内容批量添加入场动画，或让加载动画持续争夺注意力
- **Don't** 把磨砂、光晕和圆角矩形当作无语义装饰
- **Don't** 在浏览器持久化 API Key、会话事实、记忆或任务副本
