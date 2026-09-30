import Foundation
import Observation
import MarkdownView

/** 短暂平滑显示已收到的追加文字，不改变消息原文、持久化或跨端游标 */
@MainActor @Observable final class MessageMarkdownRenderer {
    private(set) var source = StreamingMarkdownSource()
    @ObservationIgnored private var target = ""
    @ObservationIgnored private var initialized = false
    @ObservationIgnored private var finished = false
    @ObservationIgnored private var pending: ArraySlice<Character> = []
    @ObservationIgnored private var step = 1
    @ObservationIgnored private var deadline = ContinuousClock.now
    @ObservationIgnored private var revealTask: Task<Void, Never>?
    @ObservationIgnored private var completedResult: MarkdownParseResult?

    /** 按完整原文复用完成态解析，缓存随消息窗口释放，不依赖行视图是否在屏幕内 */
    func completed(for text: String) -> MarkdownParseResult? {
        guard completedResult?.sourceSnapshot.text == text else { return nil }
        return completedResult
    }

    /** 保存完整解析结果供后续布局复用，不发送观察通知或改变正文状态 */
    func retain(_ result: MarkdownParseResult) -> MarkdownParseResult {
        completedResult = result
        return result
    }

    /** 接收完整快照；历史、替换、结束和大批补读直接展示，短追加最多分四次 */
    func update(_ text: String, streaming: Bool, animated: Bool) {
        let previous = target
        target = text
        if finished && (text != source.text || streaming) {
            source = StreamingMarkdownSource(source.text)
            finished = false
        }
        let append = initialized && text.hasPrefix(previous) && text.hasPrefix(source.text)
        initialized = true
        guard streaming && animated && append else {
            flush()
            if !streaming { source.finishStreaming(); finished = true }
            return
        }
        pending = ArraySlice(text.dropFirst(source.text.count))
        guard pending.count <= 320 else { flush(); return }
        step = max(1, (pending.count + 3) / 4)
        deadline = .now.advanced(by: .milliseconds(160))
        guard !pending.isEmpty, revealTask == nil else { return }
        revealTask = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .milliseconds(40)) } catch { return }
                guard let self else { return }
                if ContinuousClock.now >= self.deadline {
                    self.source.text = self.target
                    self.pending = []
                    self.revealTask = nil
                    return
                }
                let count = min(self.step, self.pending.count)
                self.source.text += String(self.pending.prefix(count))
                self.pending = self.pending.dropFirst(count)
                if self.pending.isEmpty { self.revealTask = nil; return }
            }
        }
    }

    /** 离屏取消平滑任务并补齐，重新出现时可直接读取最新全文 */
    func suspend() { flush() }

    /** 取消未展示的中间帧，确保终态和内容修正不会被旧任务覆盖 */
    private func flush() {
        revealTask?.cancel()
        revealTask = nil
        pending = []
        if source.text != target { source.text = target }
    }
}
