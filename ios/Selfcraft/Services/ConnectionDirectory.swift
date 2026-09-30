import Foundation
import Observation

/** 保存开发连接列表；主界面只有一个活动实例 */
@MainActor @Observable final class ConnectionDirectory {
    var connections: [RuntimeConnection] = []
    var revision = UUID()
    var selectedId: UUID?
    var error: String?
    let local: LocalStore
    var selected: RuntimeConnection? { connections.first { $0.id == selectedId } }

    /** 载入连接列表，错误由启动页面展示 */
    init(local: LocalStore) throws {
        self.local = local
        connections = try local.read("connections.json", fallback: [])
        selectedId = UserDefaults.standard.string(forKey: "selectedConnection").flatMap(UUID.init(uuidString:))
    }

    /** 验证服务端身份后保存连接，编辑地址不能悄悄替换实例 */
    func connect(name: String, address: String, token: String, editing: RuntimeConnection? = nil) async throws {
        guard let url = URL(string: address.trimmingCharacters(in: .whitespacesAndNewlines)),
              ["http", "https"].contains(url.scheme), url.host != nil, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, ["", "/"].contains(url.path) else { throw RuntimeError(message: "请输入服务根地址，例如 http://192.168.1.10:3210") }
        #if !DEBUG
        guard url.scheme == "https" else { throw RuntimeError(message: "正式版本需要 HTTPS 连接") }
        #endif
        var connection = RuntimeConnection(id: editing?.id ?? UUID(), name: name.isEmpty ? "Selfcraft" : name, baseURL: url, instanceId: "")
        let api = RuntimeAPI(connection: connection, token: token)
        let info: JSONValue = try await api.get("/api/connection")
        guard info["protocolVersion"].int == 1, !info["instanceId"].string.isEmpty else { throw RuntimeError(message: "服务版本不兼容，请更新 Runtime") }
        connection.instanceId = info["instanceId"].string
        if let editing, editing.instanceId != connection.instanceId { throw RuntimeError(message: "地址对应另一实例，请新增连接以隔离数据") }
        try LocalStore.saveToken(token, id: connection.id)
        var next = connections.filter { $0.id != connection.id }
        next.append(connection)
        try local.write(next, name: "connections.json")
        connections = next
        select(connection)
    }

    /** 切换活动连接，不迁移原实例草稿 */
    func select(_ connection: RuntimeConnection) {
        revision = UUID()
        selectedId = connection.id
        UserDefaults.standard.set(connection.id.uuidString, forKey: "selectedConnection")
    }

    /** 删除连接入口，保留实例草稿文件供以后重新连接 */
    func remove(_ connection: RuntimeConnection) throws {
        let next = connections.filter { $0.id != connection.id }
        try local.write(next, name: "connections.json")
        try LocalStore.saveToken(nil, id: connection.id)
        connections = next
        if selectedId == connection.id {
            selectedId = next.first?.id
            UserDefaults.standard.set(selectedId?.uuidString, forKey: "selectedConnection")
        }
    }
}
