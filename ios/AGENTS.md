# iOS 约定

- 遵循根目录 AGENTS.md，Swift 使用4空格、双引号、UpperCamelCase 文件名
- 原生 SwiftUI + Observation，UI 状态使用 MainActor，异步结果必须核对实例身份
- 每个手写函数使用中文多行文档注释；凭证只进入 Keychain，不进入日志、偏好或普通缓存
- 以 Runtime 为事实来源，只保存必要缓存、草稿与待发送内容
- 修改后使用共享 Selfcraft scheme 构建并执行核心测试，关键流程连接测试容器验证
