import Foundation

/** 按文件串行执行会话读写，编码和落盘均离开主线程 */
@MainActor final class ConversationWriter {
    static let shared = ConversationWriter()
    private var tails: [URL: Task<Void, Error>] = [:]

    /** 在调用时捕获快照并排队，后提交的状态不会被较早写入覆盖 */
    func write<T: Encodable & Sendable>(_ value: T, local: LocalStore, name: String) -> Task<Void, Error> {
        let url = local.directory.appendingPathComponent(name)
        let previous = tails[url]
        let task = Task.detached(priority: .utility) {
            _ = try? await previous?.value
            try local.write(value, name: name)
        }
        tails[url] = task
        return task
    }

    /** 恢复前等待该文件的既有写入，避免快速切换实例时读取旧草稿 */
    func read<T: Codable & Sendable>(_ name: String, local: LocalStore, fallback: T) async throws -> T {
        let url = local.directory.appendingPathComponent(name)
        let previous = tails[url]
        let task = Task.detached(priority: .userInitiated) {
            _ = try? await previous?.value
            return try local.read(name, fallback: fallback)
        }
        tails[url] = Task { _ = try await task.value }
        return try await task.value
    }
}
