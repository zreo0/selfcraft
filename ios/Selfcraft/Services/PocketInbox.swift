import Foundation

/** 串行持久化接收进度与发送回执，写入失败时绝不向设备发送删除确认 */
actor PocketInbox {
    let local: LocalStore
    private var records: [PocketRecording]
    private var current: PocketManifest?
    private var binding: PocketBinding?
    private var buffer = Data()
    private var checkpoint = 0

    /** 读取手机收件箱，损坏状态向上报告而不是静默覆盖 */
    init(local: LocalStore) throws {
        self.local = local
        records = try local.read("pocket-inbox.json", fallback: [])
    }

    /** 返回独立快照供 UI 和发送流程使用 */
    func snapshot() -> [PocketRecording] { records }

    /** 恢复同一录音的检查点；已经持久接收的录音直接返回完整长度 */
    func begin(_ manifest: PocketManifest, binding: PocketBinding) throws -> Int {
        if let saved = records.first(where: { $0.manifest.id == manifest.id }) {
            guard saved.manifest == manifest, saved.binding.instanceID == binding.instanceID else { throw RuntimeError(message: "录音身份冲突，已停止接收") }
            return manifest.count
        }
        guard records.filter({ !$0.sent && $0.discarded != true }).count < 60 else { throw RuntimeError(message: "手机有 60 条待发送录音，请先处理") }
        current = manifest
        self.binding = binding
        let name = "pocket-" + manifest.id
        let previous: PocketManifest? = try local.read(name + ".partial.json", fallback: nil)
        let url = local.directory.appendingPathComponent(name + ".partial")
        guard previous == nil || previous == manifest else { throw RuntimeError(message: "录音清单发生变化，已停止接收") }
        buffer = previous != nil && FileManager.default.fileExists(atPath: url.path) ? try Data(contentsOf: url) : Data()
        guard buffer.count <= manifest.count else { throw RuntimeError(message: "录音检查点无效") }
        try local.write(manifest, name: name + ".partial.json")
        checkpoint = buffer.count
        // 上次可能在检查点写完后、收件箱提交前退出
        if buffer.count == manifest.count { try commit() }
        return buffer.count
    }

    /** 顺序追加带偏移的分包，每 64KiB 保存检查点，完整校验后提交 WAV */
    func append(_ packet: Data, id: String) throws -> Int {
        guard let current, current.id == id, packet.count > 4 else { throw RuntimeError(message: "录音分包无效") }
        let offset = Int(PocketProtocol.uint32(packet, at: 0))
        let payload = packet.dropFirst(4)
        if offset < buffer.count {
            guard offset + payload.count <= buffer.count, buffer[offset..<(offset + payload.count)].elementsEqual(payload) else { throw RuntimeError(message: "重复分包内容不一致") }
            return buffer.count
        }
        guard offset == buffer.count, buffer.count + payload.count <= current.count else { throw RuntimeError(message: "录音传输中断，请重新连接补传") }
        buffer.append(contentsOf: payload)
        if buffer.count == current.count { try commit() }
        else if buffer.count - checkpoint >= 65_536 {
            try buffer.write(to: local.directory.appendingPathComponent("pocket-" + id + ".partial"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            checkpoint = buffer.count
        }
        return buffer.count
    }

    /** 原音和队列依次落盘；只有二者成功才允许固件回收存储 */
    private func commit() throws {
        guard let current, let binding else { throw RuntimeError(message: "没有正在接收的录音") }
        guard PocketProtocol.crc32(buffer) == current.checksum else {
            buffer.removeAll()
            try buffer.write(to: local.directory.appendingPathComponent("pocket-" + current.id + ".partial"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            throw RuntimeError(message: "录音校验失败，已保留设备原件，请重新连接")
        }
        let item = PocketRecording(manifest: current, binding: binding, receivedAt: Date())
        try PocketProtocol.wav(buffer).write(to: local.directory.appendingPathComponent(item.filename), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        let next = records + [item]
        try local.write(next, name: "pocket-inbox.json")
        records = next
        try? FileManager.default.removeItem(at: local.directory.appendingPathComponent(item.id + ".partial"))
        try? FileManager.default.removeItem(at: local.directory.appendingPathComponent(item.id + ".partial.json"))
    }

    /** 保存投递结果，成功回执落盘后才能清理手机原音，已接收标识继续保留 */
    func update(_ id: String, sent: Bool = false, error: String? = nil, submissionPending: Bool? = nil) throws {
        guard let index = records.firstIndex(where: { $0.id == id }) else { return }
        var next = records
        next[index].sent = sent
        next[index].error = error
        if let submissionPending { next[index].submissionPending = submissionPending }
        if sent { next[index].submissionPending = false }
        try local.write(next, name: "pocket-inbox.json")
        records = next
        if sent { try? FileManager.default.removeItem(at: local.directory.appendingPathComponent(records[index].filename)) }
    }

    /** 在串行存储域读取待发送音频，避免阻塞 UI */
    func audio(_ item: PocketRecording) throws -> Data {
        try Data(contentsOf: local.directory.appendingPathComponent(item.filename))
    }

    /** 用户明确丢弃后保留去重标识，防止设备重传使内容重新出现 */
    func discard(_ id: String) throws {
        guard let index = records.firstIndex(where: { $0.id == id && !$0.sent }) else { return }
        var next = records
        next[index].discarded = true
        try local.write(next, name: "pocket-inbox.json")
        records = next
        try? FileManager.default.removeItem(at: local.directory.appendingPathComponent(records[index].filename))
    }
}
