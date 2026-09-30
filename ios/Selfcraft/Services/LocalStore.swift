import Foundation
import Security

/** 本地文件和 Keychain 边界；文件按服务端实例身份隔离 */
struct LocalStore: Sendable {
    let directory: URL

    /** 创建受系统数据保护的应用支持目录 */
    init(directory: URL? = nil) throws {
        self.directory = try directory ?? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("Selfcraft", isDirectory: true)
        try FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
    }

    /** 读取指定 Codable 状态；只有文件不存在时返回默认值 */
    func read<T: Decodable>(_ name: String, fallback: T) throws -> T {
        let url = directory.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: url.path) else { return fallback }
        return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
    }

    /** 原子保存非敏感状态，写入失败向调用者报告 */
    func write<T: Encodable>(_ value: T, name: String) throws {
        try JSONEncoder().encode(value).write(to: directory.appendingPathComponent(name), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /** 读取连接密钥，不存在返回空值 */
    static func token(_ id: UUID) throws -> String {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "Selfcraft.Runtime", kSecAttrAccount as String: id.uuidString, kSecReturnData as String: true]
        var value: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &value)
        if status == errSecItemNotFound { return "" }
        guard status == errSecSuccess, let data = value as? Data, let token = String(data: data, encoding: .utf8) else { throw RuntimeError(message: "无法读取连接凭证") }
        return token
    }

    /** 保存或移除连接密钥，绝不写入 UserDefaults */
    static func saveToken(_ token: String?, id: UUID) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "Selfcraft.Runtime", kSecAttrAccount as String: id.uuidString]
        if let token {
            let attributes: [String: Any] = [kSecValueData as String: Data(token.utf8), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
            let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
            if status == errSecItemNotFound {
                guard SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil) == errSecSuccess else { throw RuntimeError(message: "无法保存连接凭证") }
            } else if status != errSecSuccess { throw RuntimeError(message: "无法更新连接凭证") }
        } else {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw RuntimeError(message: "无法删除连接凭证") }
        }
    }

    /** 将实例身份编码为安全文件名，禁止服务端标识穿越目录 */
    static func filename(_ instanceId: String) -> String {
        Data(instanceId.utf8).base64EncodedString().replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "+", with: "-") + ".json"
    }
}
