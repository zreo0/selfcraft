import Foundation

/** Runtime 确认的交互定义，原生端不解释 OpenUI 源码 */
struct InteractionView: Codable, Sendable, Identifiable, Equatable {
    let id: String
    let protocolVersion: Int
    let libraryVersion: String
    var revision: Int
    var status: String
    let interaction: InteractionDefinition
    var values: [String: JSONValue]
    var submissionId: String?

    var supported: Bool {
        protocolVersion == 1 && libraryVersion == "selfcraft-ui@1"
            && interaction.fields.allSatisfy { ["single-select", "multi-select", "text"].contains($0.type) }
            && interaction.actions.count == 1 && interaction.actions.first?.id == "submit"
    }
}

/** 跨端表单语义，布局由各端自行决定 */
struct InteractionDefinition: Codable, Sendable, Equatable {
    let kind: String
    let title: String
    let description: String
    let fields: [InteractionField]
    let actions: [InteractionAction]
}

/** 有稳定名称的输入字段 */
struct InteractionField: Codable, Sendable, Identifiable, Equatable {
    let name: String
    let type: String
    let label: String
    let required: Bool
    let options: [InteractionOption]?
    var id: String { name }
}

/** 显示标签与持久值分离的选项 */
struct InteractionOption: Codable, Sendable, Identifiable, Equatable {
    let value: String
    let label: String
    let description: String
    var id: String { value }
}

/** 由 Runtime 明确允许的动作 */
struct InteractionAction: Codable, Sendable, Equatable {
    let id: String
    let label: String
}

/** 网络重试必须复用的完整提交 */
struct InteractionSubmission: Codable, Sendable, Equatable {
    let submissionId: String
    let expectedRevision: Int
    let actionId: String
    let values: [String: JSONValue]
}

/** 已持久接收的回执，不表示主脑已完成 */
struct InteractionReceipt: Codable, Sendable {
    let submissionId: String
    let executionId: String
}

/** 分页列表不受聊天历史缓存大小影响 */
struct InteractionPage: Codable, Sendable {
    let items: [InteractionView]
    let nextCursor: Int?
}

/** 按实例隔离的本轮填写和待确认动作 */
struct InteractionDraft: Codable, Sendable {
    var revision: Int
    var values: [String: JSONValue]
    var pending: InteractionSubmission?
}

/** 已提交回答的持久快照，原文仍由 Runtime 保留 */
struct SubmissionSummary: Codable, Sendable, Equatable {
    let version: Int
    let uiId: String
    let submissionId: String
    let title: String
    let answers: [Answer]

    /** 提交时固定的字段标签与选项文字 */
    struct Answer: Codable, Sendable, Equatable {
        let field: String
        let answer: [String]
        var filled: [String] { answer.filter { !$0.isEmpty } }
    }

    var text: String {
        (["\(title) · 已提交"] + answers.map {
            "\($0.field)：\($0.filled.isEmpty ? "未填写" : $0.filled.joined(separator: "、"))"
        }).joined(separator: "\n")
    }
}
