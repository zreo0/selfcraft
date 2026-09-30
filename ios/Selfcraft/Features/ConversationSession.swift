import Foundation
import Observation

/** 单一实例的显示缓存与待发送队列，不拥有 Agent 执行生命周期 */
@MainActor @Observable final class ConversationSession {
    let api: RuntimeAPI
    let local: LocalStore
    var state: LocalConversation
    private(set) var messages: [MessageItem] = []
    private(set) var streamingIDs: Set<String> = []
    var config: JSONValue = .null
    var error: String?
    var connected = false
    var sending: Set<String> = []
    var nextCursor: Int?
    var loadingHistory = false
    var readingHistory = false
    var hasNewerMessages = false
    private(set) var tailRevision = 0
    @ObservationIgnored private var byID: [String: MessageItem] = [:]
    @ObservationIgnored private var eventCursor = 0
    @ObservationIgnored private var unseenRevision = 0
    @ObservationIgnored private var deliveries: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var draftSave: Task<Void, Never>?
    @ObservationIgnored private var historySave: Task<Void, Never>?
    @ObservationIgnored private var historyDirty = false
    private let filename: String
    private var historyFilename: String { "history-" + filename }

    /** 串行恢复草稿和有界历史；旧版合并文件在下次保存时迁移 */
    init(connection: RuntimeConnection, local: LocalStore) async throws {
        self.local = local
        filename = LocalStore.filename(connection.instanceId)
        let restored = try await ConversationWriter.shared.read(filename, local: local, fallback: LocalConversation())
        state = restored
        api = RuntimeAPI(connection: connection, token: try LocalStore.token(connection.id))
        state.messages = []
        let cache = try await ConversationWriter.shared.read("history-" + filename, local: local, fallback: restored.messages)
        merge(Array(cache.suffix(200)))
        nextCursor = messages.first?.value.metadata?.seq
    }

    /** 即刻排队保存用户意图，历史缓存使用独立文件 */
    private func saveIntent() -> Task<Void, Error> {
        draftSave?.cancel()
        draftSave = nil
        return ConversationWriter.shared.write(state, local: local, name: filename)
    }

    /** 合并连续键入；生命周期结束时 persist 会立即补写 */
    func scheduleDraftSave() {
        draftSave?.cancel()
        draftSave = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
            guard let self else { return }
            _ = await self.persist().value
        }
    }

    /** 保存待发送和草稿；返回任务供前后台切换等待，不在主线程编码 */
    @discardableResult func persist() -> Task<Void, Never> {
        let saved = saveIntent()
        return Task {
            do { try await saved.value }
            catch { self.error = "无法保存草稿：\(error.localizedDescription)" }
        }
    }

    /** 按固定间隔合并可重建缓存，最终回复和退出时立即提交 */
    private func saveHistory(immediate: Bool = false) {
        guard historyDirty else { return }
        if readingHistory {
            historySave?.cancel()
            historySave = nil
            historyDirty = false
            return
        }
        if !immediate {
            guard historySave == nil else { return }
            historySave = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                self?.saveHistory(immediate: true)
            }
            return
        }
        historySave?.cancel()
        historySave = nil
        historyDirty = false
        let snapshot = messages.suffix(200).map(\.value)
        let saved = ConversationWriter.shared.write(snapshot, local: local, name: historyFilename)
        Task {
            do { try await saved.value }
            catch { self.historyDirty = true; self.error = "无法保存历史缓存：\(error.localizedDescription)" }
        }
    }

    /** 前台恢复快照并订阅事件，断线后重连不取消服务端任务 */
    func run() async {
        defer { pause() }
        while !Task.isCancelled {
            do {
                let bootstrap: JSONValue = try await api.get("/api/bootstrap")
                try Task.checkCancellation()
                guard bootstrap["instanceId"].string == api.connection.instanceId else { throw RuntimeError(message: "实例身份发生变化，请重新配置连接") }
                config = bootstrap["config"]
                let page = try JSONDecoder().decode(MessagePage.self, from: JSONEncoder().encode(bootstrap["messages"]))
                applyLatestSnapshot(page)
                connected = true
                error = nil
                try await withThrowingTaskGroup(of: Void.self) { group in
                    group.addTask { [self] in try await observe() }
                    group.addTask { [self] in
                        while !Task.isCancelled {
                            await flush()
                            try await Task.sleep(for: .seconds(5))
                        }
                    }
                    _ = try await group.next()
                    group.cancelAll()
                }
            } catch {
                connected = false
                if !Task.isCancelled { self.error = error.localizedDescription }
            }
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
        }
    }

    /** 最新页与缓存没有交集时重建窗口，避免分页越过离线期间的历史缺口 */
    func applyLatestSnapshot(_ page: MessagePage) {
        if !readingHistory, !messages.isEmpty, !page.items.contains(where: { byID[$0.id] != nil }) {
            messages = []
            byID = [:]
            streamingIDs = []
        }
        merge(page.items)
        if !readingHistory {
            nextCursor = page.nextCursor == nil ? nil : messages.first?.value.metadata?.seq
        }
    }

    /** 只更新变化行；插入时排序，窗口最多保留 500 条，空事件不写盘 */
    func merge(_ incoming: [ChatMessage], historical: Bool = false) {
        var inserted: [MessageItem] = []
        var changed = false
        var completed = false
        for value in incoming {
            if let item = byID[value.id] {
                guard item.value != value else { continue }
                completed = completed || (item.value.isStreaming && !value.isStreaming)
                item.value = value
                item.revision += 1
            } else {
                if readingHistory && !historical { hasNewerMessages = true; unseenRevision += 1; continue }
                let item = MessageItem(value)
                byID[value.id] = item
                inserted.append(item)
            }
            if value.isStreaming { streamingIDs.insert(value.id) } else { streamingIDs.remove(value.id) }
            changed = true
        }
        guard changed else { return }
        if !inserted.isEmpty {
            messages.append(contentsOf: inserted)
            messages.sort { ($0.value.metadata?.seq ?? 0) < ($1.value.metadata?.seq ?? 0) }
            if messages.count > 500 {
                let removed = historical ? Array(messages.suffix(messages.count - 500)) : Array(messages.prefix(messages.count - 500))
                for item in removed { byID.removeValue(forKey: item.id); streamingIDs.remove(item.id) }
                messages = historical ? Array(messages.prefix(500)) : Array(messages.suffix(500))
                if historical { hasNewerMessages = true }
                else { nextCursor = messages.first?.value.metadata?.seq }
            }
        }
        tailRevision += 1
        // 历史浏览窗口不是最新消息缓存，避免上翻后覆盖离线首页
        if !readingHistory {
            historyDirty = true
            saveHistory(immediate: completed)
        }
    }

    /** 继续读取历史页，禁止并发翻页和缓存状态覆盖流式回复 */
    func loadEarlier() async {
        guard let cursor = nextCursor, !loadingHistory else { return }
        loadingHistory = true
        defer { loadingHistory = false }
        do {
            let page: MessagePage = try await api.get("/api/messages?before=\(cursor)&limit=50")
            try Task.checkCancellation()
            readingHistory = true
            merge(page.items, historical: true)
            nextCursor = page.nextCursor
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }

    /** 从历史窗口回到最新页，远端完整记录不受本地窗口裁剪影响 */
    func loadLatest() async {
        guard !loadingHistory else { return }
        loadingHistory = true
        defer { loadingHistory = false }
        do {
            let revisions = byID.mapValues(\.revision)
            let unseenBefore = unseenRevision
            let page: MessagePage = try await api.get("/api/messages?limit=50")
            try Task.checkCancellation()
            // 请求期间流式事件可能更新已有行，优先保留更新后的值
            let refreshed = page.items.map { value in
                if let current = byID[value.id], current.revision != revisions[value.id] { return current.value }
                return value
            }
            messages = []; byID = [:]; streamingIDs = []
            readingHistory = false; hasNewerMessages = unseenRevision != unseenBefore
            merge(refreshed)
            nextCursor = page.nextCursor
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }

    /** 先排队持久保存发送意图，写入成功后才允许网络提交 */
    func enqueue(text: String, audio: String? = nil, confirmation: Bool = false, files: [JSONValue] = [], clearComposer: Bool = false, capturedAt: Date = Date()) {
        let item = OutgoingMessage(id: UUID().uuidString, text: text, capturedAt: capturedAt, audioFilename: audio, files: files, requiresConfirmation: confirmation)
        state.pending.append(item)
        if clearComposer { state.draft = ""; state.draftFiles = nil }
        let saved = saveIntent()
        deliveries[item.id] = Task {
            do {
                try await saved.value
                try Task.checkCancellation()
                if !confirmation { await deliver(item, force: true) }
                else { deliveries.removeValue(forKey: item.id) }
            } catch {
                if !Task.isCancelled { self.error = "无法保存待发送内容：\(error.localizedDescription)" }
                deliveries.removeValue(forKey: item.id)
            }
        }
    }

    /** 离开前台时取消网络请求，补写已改变的缓存 */
    func pause() {
        for task in deliveries.values { task.cancel() }
        deliveries.removeAll()
        connected = false
        saveHistory(immediate: true)
    }

    /** 删除条目先保存新队列，成功后才能清理录音文件 */
    func discard(_ item: OutgoingMessage) async {
        guard !sending.contains(item.id) else { return }
        deliveries[item.id]?.cancel()
        state.pending.removeAll { $0.id == item.id }
        do {
            try await saveIntent().value
            if let filename = item.audioFilename {
                let url = local.directory.appendingPathComponent(filename)
                try await Task.detached { try FileManager.default.removeItem(at: url) }.value
            }
        } catch { self.error = error.localizedDescription }
    }

    /** 核实回执后补发，手动重试也必须先确认本地持久化成功 */
    func deliver(_ item: OutgoingMessage, force: Bool = false) async {
        guard !sending.contains(item.id), state.pending.contains(where: { $0.id == item.id }) else { return }
        sending.insert(item.id)
        defer { sending.remove(item.id); deliveries.removeValue(forKey: item.id) }
        do {
            try await saveIntent().value
            try Task.checkCancellation()
            let receipt: JSONValue = try await api.get("/api/conversation/receipts/\(item.id)")
            if !receipt["status"].string.isEmpty { await acknowledge(item); return }
            guard force || item.canAutomaticallySend(at: Date()) else { return }
            var body: [String: JSONValue] = ["id": .string(item.id)]
            var text = item.text
            if let filename = item.audioFilename {
                let url = local.directory.appendingPathComponent(filename)
                let data = try await Task.detached { try Data(contentsOf: url) }.value
                try await api.upload(data, id: item.id, capturedAt: item.capturedAt)
                let result: JSONValue = try await api.get("/api/audio/\(item.id)/transcribe", method: "POST", body: .object([:]))
                text = result["text"].string
                body["audioId"] = .string(item.id)
            }
            try Task.checkCancellation()
            let parts = [JSONValue.object(["type": .string("text"), "text": .string(text)])] + item.files
            body["messages"] = .array([.object(["role": .string("user"), "parts": .array(parts)])])
            let _: JSONValue = try await api.get("/api/conversation/messages", method: "POST", body: .object(body))
            await acknowledge(item)
        } catch {
            if !Task.isCancelled, let index = state.pending.firstIndex(where: { $0.id == item.id }) {
                state.pending[index].error = error.localizedDescription
                persist()
            }
        }
    }

    /** 回执确认后持久移除条目，写入失败仍保留录音供恢复 */
    private func acknowledge(_ item: OutgoingMessage) async {
        state.pending.removeAll { $0.id == item.id }
        do {
            try await saveIntent().value
            if let filename = item.audioFilename {
                let url = local.directory.appendingPathComponent(filename)
                try await Task.detached { try FileManager.default.removeItem(at: url) }.value
            }
        } catch { self.error = error.localizedDescription }
    }

    /** 只检查已发起发送的条目，避免与首次持久保存并发执行 */
    private func flush() async {
        for item in state.pending {
            if Task.isCancelled { return }
            if !item.requiresConfirmation && deliveries[item.id] == nil { await deliver(item) }
        }
    }

    /** 在非 UI 隔离域解码事件，主线程只提交变化的消息 */
    private func observe() async throws {
        try await api.events(after: eventCursor) { [weak self] data in
            let event = try JSONDecoder().decode(ConversationEvent.self, from: data)
            await self?.receive(event)
        }
    }

    /** 空心跳只更新游标，不触发合并、布局或磁盘写入 */
    private func receive(_ event: ConversationEvent) {
        if !event.items.isEmpty { merge(event.items) }
        eventCursor = event.cursor
    }
}

/** 原生解码事件，避免 JSONValue 中转的重复编码 */
private struct ConversationEvent: Decodable, Sendable {
    let items: [ChatMessage]
    let cursor: Int
}
