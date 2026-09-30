import Foundation
import Testing
@testable import Selfcraft

/** 五分钟边界和中断草稿不能被自动补发 */
@Test func resendRequiresRecentExplicitIntent() {
    let now = Date()
    let recent = OutgoingMessage(id: "one", text: "测试", capturedAt: now.addingTimeInterval(-300), requiresConfirmation: false)
    #expect(recent.canAutomaticallySend(at: now))
    #expect(!recent.canAutomaticallySend(at: now.addingTimeInterval(1)))
    var draft = recent
    draft.requiresConfirmation = true
    #expect(!draft.canAutomaticallySend(at: now))
}

/** 任意实例标识不能穿越本地目录且不同实例有不同文件 */
@Test func instanceFilesAreIsolated() {
    #expect(!LocalStore.filename("../../private").contains("/"))
    #expect(LocalStore.filename("one") != LocalStore.filename("two"))
}

/** 多端重复快照只更新原消息，保持服务端顺序 */
@Test @MainActor func snapshotsMergeByIdentity() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let connection = RuntimeConnection(id: UUID(), name: "Test", baseURL: URL(string: "http://127.0.0.1:3210")!, instanceId: "test")
    let session = try await ConversationSession(connection: connection, local: LocalStore(directory: directory))
    let first = ChatMessage(id: "a", role: "assistant", parts: [.object(["type": .string("text"), "text": .string("初始")])], metadata: .init(seq: 2, state: "streaming"))
    var completed = first
    completed.parts = [.object(["type": .string("text"), "text": .string("完整回复")])]
    session.merge([first])
    session.merge([completed, completed])
    #expect(session.messages.count == 1)
    #expect(session.messages.first?.value.text == "完整回复")
}

/** 附件访问必须留在当前实例，防止凭证泄漏 */
@Test func requestRejectsForeignResources() throws {
    let connection = RuntimeConnection(id: UUID(), name: "Test", baseURL: URL(string: "https://example.com")!, instanceId: "test")
    let api = RuntimeAPI(connection: connection, token: "test-only")
    #expect(throws: RuntimeError.self) { try api.request("https://another.example/api/messages") }
    #expect(throws: RuntimeError.self) { try api.request("//another.example/api/messages") }
    #expect(try api.request("/api/messages").url?.host == "example.com")
}

/** 两个实例的草稿在退出和重新打开后仍严格隔离 */
@Test @MainActor func draftsRemainBoundToInstance() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let local = try LocalStore(directory: directory)
    let first = RuntimeConnection(id: UUID(), name: "One", baseURL: URL(string: "http://127.0.0.1:3210")!, instanceId: "one")
    let second = RuntimeConnection(id: UUID(), name: "Two", baseURL: URL(string: "http://127.0.0.1:3211")!, instanceId: "two")
    let a = try await ConversationSession(connection: first, local: local)
    a.state.draft = "只属于第一个实例"
    a.state.draftFiles = [.object(["url": .string("/api/attachments/example")])]
    await a.persist().value
    let b = try await ConversationSession(connection: second, local: local)
    #expect(b.state.draft.isEmpty)
    #expect(b.state.draftFiles == nil)
    b.state.draft = "只属于第二个实例"
    await b.persist().value
    #expect(try await ConversationSession(connection: first, local: local).state.draft == "只属于第一个实例")
    #expect(try await ConversationSession(connection: first, local: local).state.draftFiles?.count == 1)
    #expect(try await ConversationSession(connection: second, local: local).state.draft == "只属于第二个实例")
}

/** 中断语音保留已有文字草稿，并按开始采集时间计算补发窗口 */
@Test @MainActor func interruptedVoicePreservesComposer() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let connection = RuntimeConnection(id: UUID(), name: "Test", baseURL: URL(string: "http://127.0.0.1:3210")!, instanceId: "voice")
    let session = try await ConversationSession(connection: connection, local: LocalStore(directory: directory))
    session.state.draft = "尚未发出的文字"
    let capturedAt = Date().addingTimeInterval(-120)
    session.enqueue(text: "", audio: "test.wav", confirmation: true, capturedAt: capturedAt)
    #expect(session.state.draft == "尚未发出的文字")
    #expect(session.state.pending.first?.capturedAt == capturedAt)
    #expect(session.state.pending.first?.canAutomaticallySend(at: Date()) == false)
}

/** 流式更新保持行身份，重复事件与心跳不引发重复状态变化 */
@Test @MainActor func updatesKeepRowsAndIgnoreUnchangedEvents() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let connection = RuntimeConnection(id: UUID(), name: "Test", baseURL: URL(string: "http://127.0.0.1:3210")!, instanceId: "incremental")
    let session = try await ConversationSession(connection: connection, local: LocalStore(directory: directory))
    var message = ChatMessage(id: "a", role: "assistant", parts: [.object(["type": .string("text"), "text": .string("开始")])], metadata: .init(seq: 1, state: "streaming"))
    session.merge([message])
    let row = try #require(session.messages.first)
    let revision = session.tailRevision
    session.merge([])
    session.merge([message])
    #expect(session.tailRevision == revision)
    message.parts = [.object(["type": .string("text"), "text": .string("追加内容")])]
    message.metadata?.state = "completed"
    session.merge([message])
    #expect(session.messages.first === row)
    #expect(row.value.text == "追加内容")
    #expect(session.streamingIDs.isEmpty)
    session.pause()
}

/** 浏览历史使用有界窗口，迟到新消息不挤走当前阅读位置 */
@Test @MainActor func historyWindowStaysBounded() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let connection = RuntimeConnection(id: UUID(), name: "Test", baseURL: URL(string: "http://127.0.0.1:3210")!, instanceId: "window")
    let session = try await ConversationSession(connection: connection, local: LocalStore(directory: directory))
    let start = ContinuousClock.now
    for page in 0..<100 {
        session.merge((1...100).map { index in
            let seq = page * 100 + index
            return ChatMessage(id: "m-\(seq)", role: "user", parts: [.object(["type": .string("text"), "text": .string(String(repeating: "测试", count: 100))])], metadata: .init(seq: seq))
        })
    }
    print("10,000 synthetic messages merged in \(start.duration(to: .now)); retained \(session.messages.count)")
    #expect(session.messages.count == 500)
    #expect(session.messages.first?.value.metadata?.seq == 9501)
    session.readingHistory = true
    session.merge((9451...9500).map { (seq: Int) in ChatMessage(id: "m-\(seq)", role: "user", parts: [], metadata: .init(seq: seq)) }, historical: true)
    #expect(session.messages.first?.value.metadata?.seq == 9451)
    #expect(session.messages.last?.value.metadata?.seq == 9950)
    session.merge([ChatMessage(id: "new", role: "user", parts: [], metadata: .init(seq: 10001))])
    #expect(session.messages.count == 500)
    #expect(session.messages.last?.value.metadata?.seq == 9950)
    #expect(session.hasNewerMessages)
    session.pause()
}

/** 旧缓存可迁移，修改草稿不再重新写入历史内容 */
@Test @MainActor func draftWritesDoNotRewriteHistory() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let local = try LocalStore(directory: directory)
    let connection = RuntimeConnection(id: UUID(), name: "Test", baseURL: URL(string: "http://127.0.0.1:3210")!, instanceId: "migration")
    let name = LocalStore.filename(connection.instanceId)
    var legacy = LocalConversation()
    legacy.draft = "旧草稿"
    legacy.messages = [ChatMessage(id: "legacy", role: "user", parts: [], metadata: .init(seq: 1))]
    try local.write(legacy, name: name)
    let session = try await ConversationSession(connection: connection, local: local)
    #expect(session.messages.first?.id == "legacy")
    session.pause()
    let history: [ChatMessage] = try await ConversationWriter.shared.read("history-" + name, local: local, fallback: [])
    #expect(history.first?.id == "legacy")
    let historyURL = directory.appendingPathComponent("history-" + name)
    let before = try historyURL.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
    for index in 0..<20 {
        session.state.draft = "草稿 \(index)"
        session.persist()
    }
    await session.persist().value
    let restored = try await ConversationSession(connection: connection, local: local)
    #expect(restored.state.draft == "草稿 19")
    #expect(restored.messages.first?.id == "legacy")
    let after = try historyURL.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
    #expect(before == after)
    #expect(try local.read(name, fallback: LocalConversation()).messages.isEmpty)
    restored.readingHistory = true
    restored.pause()
}

/** 长时间离线后的最新页不与旧缓存拼成有缺口的历史 */
@Test @MainActor func reconnectDoesNotSkipHistoryGap() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let connection = RuntimeConnection(id: UUID(), name: "Test", baseURL: URL(string: "http://127.0.0.1:3210")!, instanceId: "gap")
    let session = try await ConversationSession(connection: connection, local: LocalStore(directory: directory))
    session.merge([ChatMessage(id: "old", role: "user", parts: [], metadata: .init(seq: 10))])
    session.applyLatestSnapshot(MessagePage(items: [ChatMessage(id: "recent", role: "user", parts: [], metadata: .init(seq: 1000))], nextCursor: 1000))
    #expect(session.messages.map(\.id) == ["recent"])
    #expect(session.nextCursor == 1000)
    session.pause()
}
