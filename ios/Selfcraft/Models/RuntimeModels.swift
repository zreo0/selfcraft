import Foundation
import Observation

/** 保留服务端可扩展字段的 JSON 值，用于配置和领域详情 */
enum JSONValue: Codable, Sendable, Equatable, Hashable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null

    /** 从 JSON 解码一个有类型的值 */
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([String: JSONValue].self) { self = .object(value) }
        else { self = .array(try container.decode([JSONValue].self)) }
    }

    /** 将当前值编码为标准 JSON */
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    subscript(_ key: String) -> JSONValue {
        if case .object(let value) = self { return value[key] ?? .null }
        return .null
    }
    var id: String { self["id"].string }
    var string: String { if case .string(let value) = self { return value }; return "" }
    var bool: Bool { if case .bool(let value) = self { return value }; return false }
    var int: Int { if case .number(let value) = self { return Int(value) }; return 0 }
    var array: [JSONValue] { if case .array(let value) = self { return value }; return [] }
}

/** 用户保存的连接；密钥以 id 为 Keychain 索引 */
struct RuntimeConnection: Codable, Identifiable, Equatable, Sendable {
    var id: UUID
    var name: String
    var baseURL: URL
    var instanceId: String
}

/** 服务端持久消息及独立播放附件 */
struct ChatMessage: Codable, Identifiable, Sendable, Equatable {
    var id: String
    var role: String
    var parts: [JSONValue]
    var metadata: Metadata?

    struct Metadata: Codable, Sendable, Equatable {
        var seq: Int?
        var occurredAt: String?
        var state: String?
        var executionId: String?
        var audio: Audio?
    }
    struct Audio: Codable, Sendable, Equatable {
        var id: String
        var url: String
        var duration: Double
        var deleted: Bool
    }
    var text: String { parts.filter { $0["type"].string == "text" }.map { $0["text"].string }.joined() }
    var isStreaming: Bool { metadata?.state == "streaming" }
}

/** 服务端历史页，与流式快照共享消息类型 */
struct MessagePage: Codable, Sendable {
    var items: [ChatMessage]
    var nextCursor: Int?
}

/** 断线可恢复的发送条目；草稿不自动重发 */
struct OutgoingMessage: Codable, Identifiable, Sendable {
    var id: String
    var text: String
    var capturedAt: Date
    var audioFilename: String?
    var files: [JSONValue] = []
    var requiresConfirmation: Bool
    var error: String?

    /** 判断当前条目是否仍在用户授权的自动补发窗口内 */
    func canAutomaticallySend(at date: Date) -> Bool {
        !requiresConfirmation && date.timeIntervalSince(capturedAt) >= 0 && date.timeIntervalSince(capturedAt) <= 300
    }
}

/** 每个实例独立保存的草稿、持久回执前条目与显示缓存 */
struct LocalConversation: Codable, Sendable {
    var draft = ""
    var draftFiles: [JSONValue]? = nil
    var pending: [OutgoingMessage] = []
    var messages: [ChatMessage] = []
}

/** 稳定的单条消息状态，流式变化只通知对应行 */
@MainActor @Observable final class MessageItem: Identifiable {
    let id: String
    var value: ChatMessage
    @ObservationIgnored var revision = 0
    @ObservationIgnored let markdown = MessageMarkdownRenderer()

    /** 绑定持久消息标识，后续快照更新不重建行身份 */
    init(_ value: ChatMessage) {
        id = value.id
        self.value = value
    }
}
