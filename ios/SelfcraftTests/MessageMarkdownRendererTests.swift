import Foundation
import Testing
import SwiftUI
@testable import Selfcraft

/** 首次测量即获得全文高度，重建消息视图仍复用同一解析文档 */
@MainActor @Test func markdownHistoryHasStableFirstLayout() throws {
    let renderer = MessageMarkdownRenderer()
    let text = String(repeating: "## 标题\n\n这是一段用于验证首次布局的中文正文，包含 **粗体** 与 `代码`。\n\n", count: 12)
    let first = UIHostingController(rootView: MessageText(text: text, sharedRenderer: renderer))
    let size = first.sizeThatFits(in: CGSize(width: 320, height: CGFloat.greatestFiniteMagnitude))
    let parsed = try #require(renderer.completed(for: text))
    #expect(size.height > 600)

    let rebuilt = UIHostingController(rootView: MessageText(text: text, sharedRenderer: renderer))
    let rebuiltSize = rebuilt.sizeThatFits(in: CGSize(width: 320, height: CGFloat.greatestFiniteMagnitude))
    #expect(abs(size.height - rebuiltSize.height) < 1)
    #expect(renderer.completed(for: text) == parsed)
    #expect(renderer.completed(for: text + "修正") == nil)

    let wider = rebuilt.sizeThatFits(in: CGSize(width: 600, height: CGFloat.greatestFiniteMagnitude))
    #expect(wider.height < rebuiltSize.height)
    #expect(renderer.completed(for: text) == parsed)
}

/** 完成态必须重新完整解析，补齐流式过程中尚未出现的引用定义 */
@MainActor @Test func markdownCompletionCachesLatestFullDocument() throws {
    let renderer = MessageMarkdownRenderer()
    renderer.update("[文档][ref]", streaming: true, animated: false)
    let complete = "[文档][ref]\n\n[ref]: https://example.com\n\n最终内容"
    let host = UIHostingController(rootView: MessageText(text: complete, sharedRenderer: renderer))
    _ = host.sizeThatFits(in: CGSize(width: 320, height: CGFloat.greatestFiniteMagnitude))
    let parsed = try #require(renderer.completed(for: complete))
    #expect(parsed.parsingStrategy == .full)
    #expect(parsed.sourceSnapshot.text == complete)
    #expect(renderer.completed(for: "[文档][ref]") == nil)
    renderer.suspend()
}

/** 短追加平滑到达全文，中文与复合 emoji 不被拆坏 */
@MainActor @Test func markdownStreamingPreservesCharacters() async throws {
    let renderer = MessageMarkdownRenderer()
    renderer.update("开头", streaming: true, animated: true)
    let complete = "开头\n\n## 标题\n\n你好 👨‍👩‍👧‍👦，这是 **粗体** 和 `代码`。"
    renderer.update(complete, streaming: true, animated: true)
    #expect(renderer.source.text == "开头")
    for _ in 0..<40 {
        if renderer.source.text == complete { break }
        try await Task.sleep(for: .milliseconds(25))
    }
    #expect(renderer.source.text == complete)
    renderer.suspend()
}

/** 完成、中断和内容替换立即补齐，不被迟到平滑任务覆盖 */
@MainActor @Test func markdownTerminalSnapshotWins() async throws {
    let renderer = MessageMarkdownRenderer()
    renderer.update("部分", streaming: true, animated: true)
    renderer.update("部分内容正在生成", streaming: true, animated: true)
    renderer.update("最终全文", streaming: false, animated: true)
    #expect(renderer.source.text == "最终全文")
    try await Task.sleep(for: .milliseconds(200))
    #expect(renderer.source.text == "最终全文")
    let previous = renderer.source
    renderer.update("恢复后的回复", streaming: true, animated: true)
    #expect(renderer.source !== previous)
    #expect(renderer.source.text == "恢复后的回复")
    renderer.suspend()
}

/** 历史、减少动态效果、大批断线补读与离屏均不排队打字 */
@MainActor @Test func markdownCatchUpDoesNotDelayHistory() {
    let renderer = MessageMarkdownRenderer()
    renderer.update("历史完整内容", streaming: false, animated: true)
    #expect(renderer.source.text == "历史完整内容")
    renderer.update("新回复", streaming: true, animated: false)
    #expect(renderer.source.text == "新回复")
    let long = "新回复" + String(repeating: "中文", count: 500)
    renderer.update(long, streaming: true, animated: true)
    #expect(renderer.source.text == long)
    renderer.update(long + "结尾", streaming: true, animated: true)
    renderer.suspend()
    #expect(renderer.source.text == long + "结尾")
}

/** 两条消息各自推进，连续接收快照不丢掉末尾或互相污染 */
@MainActor @Test func markdownStreamsRemainIndependent() async throws {
    let first = MessageMarkdownRenderer()
    let second = MessageMarkdownRenderer()
    first.update("A", streaming: true, animated: true)
    second.update("B", streaming: true, animated: true)
    for index in 1...12 {
        first.update("A" + String(repeating: "甲", count: index), streaming: true, animated: true)
        second.update("B" + String(repeating: "乙", count: index), streaming: true, animated: true)
        try await Task.sleep(for: .milliseconds(10))
    }
    for _ in 0..<40 {
        if first.source.text.count == 13 && second.source.text.count == 13 { break }
        try await Task.sleep(for: .milliseconds(25))
    }
    #expect(first.source.text == "A" + String(repeating: "甲", count: 12))
    #expect(second.source.text == "B" + String(repeating: "乙", count: 12))
    first.suspend()
    second.suspend()
}
