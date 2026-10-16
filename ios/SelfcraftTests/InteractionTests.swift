import Foundation
import Testing
@testable import Selfcraft

/** 构造与 Runtime 相同的消息快照，包含 iOS 不需要解释的 OpenUI 源码 */
private func interactionFixture() throws -> InteractionView {
    let data = Data(#"{"id":"ui_test","protocolVersion":1,"libraryVersion":"selfcraft-ui@1","revision":1,"status":"ready","source":"root = Form(...)","interaction":{"kind":"clarification","title":"目标","description":"请选择","fields":[{"name":"goal","type":"single-select","label":"目标","required":true,"options":[{"value":"a","label":"甲","description":""},{"value":"b","label":"乙","description":""}]}],"actions":[{"id":"submit","label":"提交"}]},"values":{"goal":""},"submissionId":null}"#.utf8)
    return try JSONDecoder().decode(InteractionView.self, from: data)
}

/** 三端语义可解码，未知版本只允许文字替代 */
@Test func interactionProtocolAndUnknownVersion() throws {
    let view = try interactionFixture()
    #expect(view.supported)
    let encoded = String(decoding: try JSONEncoder().encode(view), as: UTF8.self)
    let unknown = try JSONDecoder().decode(InteractionView.self, from: Data(encoded.replacingOccurrences(of: "selfcraft-ui@1", with: "selfcraft-ui@2").utf8))
    #expect(!unknown.supported)
    #expect(unknown.interaction.title == view.interaction.title)
}

/** 原始提交与草稿版本在退出后保留，不能在恢复时生成新标识 */
@Test func interactionIntentSurvivesDiskRoundTrip() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let local = try LocalStore(directory: directory)
    let request = InteractionSubmission(submissionId: UUID().uuidString, expectedRevision: 4, actionId: "submit", values: ["goal": .string("a")])
    let draft = InteractionDraft(revision: 4, values: request.values, pending: request)
    try local.write(draft, name: "intent.json")
    let restored = try local.read("intent.json", fallback: InteractionDraft(revision: 0, values: [:]))
    #expect(restored.pending == request)
    #expect(restored.revision == 4)
}

/** 跨端更新保留本地内容与原始版本，重复快照不能自动解除冲突 */
@Test @MainActor func interactionConflictPreservesOriginalRevision() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let local = try LocalStore(directory: directory)
    let connection = RuntimeConnection(id: UUID(), name: "Test", baseURL: URL(string: "http://127.0.0.1:1")!, instanceId: "interaction-test")
    var view = try interactionFixture()
    let editor = InteractionEditor(view: view, api: RuntimeAPI(connection: connection, token: ""), local: local)
    editor.change("goal", value: .string("a"))
    view.revision = 2
    view.values = ["goal": .string("b")]
    editor.receive(view)
    editor.receive(view)
    #expect(editor.conflicted)
    #expect(editor.values["goal"] == .string("a"))
    let saved = try await ConversationWriter.shared.read("interaction-" + LocalStore.filename(connection.instanceId + ":" + view.id), local: local, fallback: InteractionDraft(revision: 0, values: [:]))
    #expect(saved.revision == 1)
    #expect(saved.values["goal"] == .string("a"))
    #expect(saved.pending == nil)
}

/** 摘要经过消息缓存编解码后保持可读，复制不包含原始协议文本 */
@Test func submissionSummarySurvivesMessageRoundTrip() throws {
    let raw = #"{"id":"user:ui-submit:test","role":"user","parts":[{"type":"text","text":"内部原始 JSON"},{"type":"data-ui-submission","data":{"version":1,"uiId":"ui_test","submissionId":"test","title":"容器验收","answers":[{"field":"目标","answer":["质量优先"]},{"field":"多选","answer":["甲","乙"]},{"field":"说明","answer":["第一行\n第二行"]},{"field":"留空","answer":[]}]}}]}"#
    let message = try JSONDecoder().decode(ChatMessage.self, from: Data(raw.utf8))
    let restored = try JSONDecoder().decode(ChatMessage.self, from: JSONEncoder().encode(message))
    #expect(restored == message)
    #expect(restored.submission?.title == "容器验收")
    #expect(restored.text == "容器验收 · 已提交\n目标：质量优先\n多选：甲、乙\n说明：第一行\n第二行\n留空：未填写")
    #expect(restored.parts.first?["text"].string == "内部原始 JSON")
    let unknown = try JSONDecoder().decode(ChatMessage.self, from: Data(raw.replacingOccurrences(of: "\"version\":1", with: "\"version\":2").utf8))
    #expect(unknown.submission == nil)
    #expect(unknown.text == "内部原始 JSON")
}

/** 普通消息和错误形状不能被误认作提交摘要 */
@Test func malformedSubmissionKeepsOriginalText() throws {
    let raw = #"{"id":"ordinary","role":"user","parts":[{"type":"text","text":"普通 JSON 文本"},{"type":"data-ui-submission","data":{"version":1,"answers":"bad"}}]}"#
    let message = try JSONDecoder().decode(ChatMessage.self, from: Data(raw.utf8))
    #expect(message.submission == nil)
    #expect(message.text == "普通 JSON 文本")
}
