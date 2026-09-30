import SwiftUI
import MarkdownView

/** 完成态复用解析结果，流式态增量更新，两者共享字体与组件样式 */
struct MessageText: View, Equatable {
    let text: String
    var streaming = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var sharedRenderer: MessageMarkdownRenderer? = nil
    @State private var localRenderer = MessageMarkdownRenderer()
    private var renderer: MessageMarkdownRenderer { sharedRenderer ?? localRenderer }

    /** 仅正文和生成状态变化时更新输入，字号与主题仍由环境驱动 */
    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.text == rhs.text && lhs.streaming == rhs.streaming && lhs.sharedRenderer === rhs.sharedRenderer
    }

    var body: some View {
        Group {
            if streaming {
                StreamingMarkdownReader(renderer.source) { result in
                    MarkdownView(result)
                }
            } else if let result = renderer.completed(for: text) {
                MarkdownView(result)
            } else {
                // 完成态首次布局就提供正文，避免空白行随后撑高并改变滚动位置
                MarkdownReader(text) { result in
                    MarkdownView(renderer.retain(result))
                }
            }
        }
        .font(.body, for: .body)
        .font(.title3.weight(.semibold), for: .h1)
        .font(.headline, for: .h2)
        .font(.body.weight(.semibold), for: .h3)
        .markdownComponentSpacing(12)
        .markdownCodeBlockStyle(MessageCodeStyle())
        .markdownTableStyle(MessageTableStyle())
        .textSelection(.enabled)
        .markdownStreamingRenderThrottle(.milliseconds(40))
        .frame(maxWidth: .infinity, alignment: .leading)
        .onChange(of: text, initial: true) { _, _ in update() }
        .onChange(of: streaming) { _, _ in update() }
        .onChange(of: reduceMotion) { _, _ in update() }
        .onDisappear { renderer.suspend() }
    }

    /** 完成与减少动态效果时立即显示服务端全文 */
    private func update() {
        renderer.update(text, streaming: streaming, animated: !reduceMotion)
    }
}

/** 宽表格只在自身区域横向滚动，保持正文宽度和字号 */
private struct MessageTableStyle: MarkdownTableStyle {
    /** 使用原生语义色与分隔线，保留完整列内容 */
    func makeBody(configuration: Configuration) -> some View {
        ScrollView(.horizontal) {
            DefaultMarkdownTableStyle.default.makeBody(configuration: configuration)
                .fixedSize(horizontal: true, vertical: false)
        }.scrollBounceBehavior(.basedOnSize)
    }
}

/** 代码保留原始空白，局部横向滚动及复制沿用应用样式 */
private struct MessageCodeStyle: MarkdownCodeBlockStyle {
    /** 根据解析后的代码与语言构建独立代码区域 */
    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(configuration.language ?? "代码").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("复制", systemImage: "doc.on.doc") { UIPasteboard.general.string = configuration.code }
                    .font(.caption).frame(minHeight: 44)
            }
            ScrollView(.horizontal) {
                Text(verbatim: configuration.code).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
            }
        }.padding(12).background(Color.secondary.opacity(0.07), in: .rect(cornerRadius: 12))
    }
}
