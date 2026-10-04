import Foundation
import Testing
@testable import Selfcraft

/** 生成稳定录音清单，用于同一份协议的断点和 CRC 验证 */
private func pocketManifest(_ data: Data, interrupted: Bool = false) -> PocketManifest {
    PocketManifest(id: "00112233445566778899aabbccddeeff", identifier: Data(0..<16), count: data.count,
                   checksum: PocketProtocol.crc32(data), capturedAt: Date(timeIntervalSince1970: 1_790_000_000), interrupted: interrupted)
}

/** 使用公开 CRC 向量与 G.711 样本，防止固件与手机编解码各自自洽但不兼容 */
@Test func pocketWireFormatAndAudio() throws {
    #expect(PocketProtocol.crc32(Data("123456789".utf8)) == 0xCBF43926)
    #expect(PocketProtocol.sample(0xFF) == 0)
    #expect(PocketProtocol.sample(0x7F) == 0)
    #expect(PocketProtocol.sample(0x80) == 32124)
    #expect(PocketProtocol.sample(0x00) == -32124)
    let wav = PocketProtocol.wav(Data([0xFF, 0x80, 0x00]))
    #expect(wav.count == 50)
    #expect(PocketProtocol.uint32(wav, at: 24) == 16_000)
    #expect(PocketProtocol.uint32(wav, at: 40) == 6)
    #expect(Array(wav.suffix(6)) == [0, 0, 124, 125, 132, 130])
    var manifest = Data([1, 0]) + Data(0..<16) + PocketProtocol.bytes(1_790_000_000)
    manifest += PocketProtocol.bytes(3) + PocketProtocol.bytes(0x12345678) + Data([1, 0])
    let decoded = try #require(try PocketProtocol.decode(manifest))
    #expect(decoded.count == 3)
    #expect(decoded.checksum == 0x12345678)
    #expect(decoded.id == "000102030405060708090a0b0c0d0e0f")
    manifest[0] = 2
    #expect(throws: RuntimeError.self) { try PocketProtocol.decode(manifest) }
}

/** 重启从落盘的 64KiB 检查点恢复；重复 ACK 不产生第二条录音 */
@Test func pocketResumeAndDurableAcknowledgement() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let local = try LocalStore(directory: directory)
    let data = Data((0..<70_000).map { UInt8(truncatingIfNeeded: $0) })
    let manifest = pocketManifest(data)
    let binding = PocketBinding(peripheralID: UUID(), connectionID: UUID(), instanceID: "first")
    let first = try PocketInbox(local: local)
    #expect(try await first.begin(manifest, binding: binding) == 0)
    #expect(try await first.append(PocketProtocol.bytes(0) + data.prefix(65_536), id: manifest.id) == 65_536)
    #expect(try await first.append(PocketProtocol.bytes(65_536) + data[65_536..<66_000], id: manifest.id) == 66_000)
    let restored = try PocketInbox(local: local)
    #expect(try await restored.begin(manifest, binding: binding) == 65_536)
    #expect(try await restored.append(PocketProtocol.bytes(65_536) + data.dropFirst(65_536), id: manifest.id) == data.count)
    let committed = try PocketInbox(local: local)
    #expect(try await committed.begin(manifest, binding: binding) == data.count)
    let records = await committed.snapshot()
    #expect(records.count == 1)
    #expect(try await committed.audio(records[0]) == PocketProtocol.wav(data))
    try await committed.update(records[0].id, sent: true)
    let acknowledged = try PocketInbox(local: local)
    #expect(try await acknowledged.begin(manifest, binding: binding) == data.count)
    #expect(await acknowledged.snapshot().count == 1)
    #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent(records[0].filename).path))
    let other = PocketBinding(peripheralID: UUID(), connectionID: UUID(), instanceID: "other")
    await #expect(throws: RuntimeError.self) { try await acknowledged.begin(manifest, binding: other) }
}

/** 乱序、损坏或保存失败均不能产生可确认的收件条目 */
@Test func pocketRejectsCorruptionAndStorageFailure() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let local = try LocalStore(directory: directory)
    let inbox = try PocketInbox(local: local)
    let data = Data([1, 2, 3, 4])
    let manifest = pocketManifest(data)
    let binding = PocketBinding(peripheralID: UUID(), connectionID: UUID(), instanceID: "first")
    _ = try await inbox.begin(manifest, binding: binding)
    await #expect(throws: RuntimeError.self) { try await inbox.append(PocketProtocol.bytes(1) + data, id: manifest.id) }
    await #expect(throws: RuntimeError.self) { try await inbox.append(PocketProtocol.bytes(0) + Data([1, 2, 3, 5]), id: manifest.id) }
    #expect(await inbox.snapshot().isEmpty)
    _ = try await inbox.begin(manifest, binding: binding)
    // 阻止队列原子写入，模拟音频已写但队列落盘失败
    try FileManager.default.createDirectory(at: directory.appendingPathComponent("pocket-inbox.json"), withIntermediateDirectories: true)
    await #expect(throws: (any Error).self) { try await inbox.append(PocketProtocol.bytes(0) + data, id: manifest.id) }
    #expect(await inbox.snapshot().isEmpty)
}

/** 过期、未来时间、未知时间及掉电片段均不能自动执行 */
@Test func pocketOfflineIntentNeedsConfirmation() {
    let data = Data([0xFF])
    let manifest = pocketManifest(data)
    let binding = PocketBinding(peripheralID: UUID(), connectionID: UUID(), instanceID: "first")
    let now = manifest.capturedAt!
    let recording = PocketRecording(manifest: manifest, binding: binding, receivedAt: now)
    #expect(recording.canAutomaticallySend(at: now.addingTimeInterval(300)))
    #expect(!recording.canAutomaticallySend(at: now.addingTimeInterval(301)))
    #expect(!recording.canAutomaticallySend(at: now.addingTimeInterval(-1)))
    let interrupted = PocketRecording(manifest: pocketManifest(data, interrupted: true), binding: binding, receivedAt: now)
    #expect(!interrupted.canAutomaticallySend(at: now))
    let unknown = PocketManifest(id: manifest.id, identifier: manifest.identifier, count: 1, checksum: manifest.checksum, capturedAt: nil, interrupted: false)
    #expect(!PocketRecording(manifest: unknown, binding: binding, receivedAt: now).canAutomaticallySend(at: now))
}

/** 丢弃也保存去重标识，设备 ACK 丢失后不会重新创建用户已经放弃的录音 */
@Test func pocketDiscardSurvivesReplay() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let local = try LocalStore(directory: directory)
    let inbox = try PocketInbox(local: local)
    let data = Data([0xFF, 0x80])
    let manifest = pocketManifest(data)
    let binding = PocketBinding(peripheralID: UUID(), connectionID: UUID(), instanceID: "first")
    _ = try await inbox.begin(manifest, binding: binding)
    _ = try await inbox.append(PocketProtocol.bytes(0) + data, id: manifest.id)
    let item = try #require(await inbox.snapshot().first)
    try await inbox.discard(item.id)
    let restored = try PocketInbox(local: local)
    #expect(try await restored.begin(manifest, binding: binding) == 2)
    #expect(await restored.snapshot().first?.discarded == true)
    #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent(item.filename).path))
}

/** 自动调度跳过待确认项，但保留明确确认、回执恢复和旧格式兼容 */
@Test func pocketDeliveryEligibility() throws {
    let manifest = pocketManifest(Data([0xFF]))
    let binding = PocketBinding(peripheralID: UUID(), connectionID: UUID(), instanceID: "first")
    let now = manifest.capturedAt!.addingTimeInterval(301)
    var item = PocketRecording(manifest: manifest, binding: binding, receivedAt: now)
    #expect(!item.needsDelivery(at: now))
    #expect(item.needsDelivery(at: now, confirmedID: item.id))
    #expect(!item.needsDelivery(at: now, confirmedID: "another-recording"))
    #expect(item.needsDelivery(at: manifest.capturedAt!))
    item.submissionPending = true
    #expect(item.needsDelivery(at: now))
    item.sent = true
    #expect(!item.needsDelivery(at: now, confirmedID: item.id))
    item.sent = false
    item.discarded = true
    #expect(!item.needsDelivery(at: now, confirmedID: item.id))
    item.discarded = false
    // 旧版本没有提交标记，升级后应先核对回执，不能把可能已送达的录音当作从未提交
    var legacy = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(item)) as? [String: Any])
    legacy.removeValue(forKey: "submissionPending")
    let restored = try JSONDecoder().decode(PocketRecording.self, from: JSONSerialization.data(withJSONObject: legacy))
    #expect(restored.submissionPending == nil)
    #expect(restored.needsDelivery(at: now))
}

/** 提交前标记跨进程恢复，核对空回执后停止重复重试，音频保留供人工确认 */
@Test func pocketSubmissionRecoveryIsDurable() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let local = try LocalStore(directory: directory)
    let inbox = try PocketInbox(local: local)
    let data = Data([0xFF])
    let manifest = pocketManifest(data)
    let binding = PocketBinding(peripheralID: UUID(), connectionID: UUID(), instanceID: "first")
    _ = try await inbox.begin(manifest, binding: binding)
    _ = try await inbox.append(PocketProtocol.bytes(0) + data, id: manifest.id)
    let item = try #require(await inbox.snapshot().first)
    try await inbox.update(item.id, submissionPending: true)
    let restored = try PocketInbox(local: local)
    let unresolved = try #require(await restored.snapshot().first)
    #expect(unresolved.needsDelivery(at: manifest.capturedAt!.addingTimeInterval(600)))
    try await restored.update(item.id, submissionPending: false)
    let resolved = try PocketInbox(local: local)
    let waiting = try #require(await resolved.snapshot().first)
    #expect(!waiting.needsDelivery(at: manifest.capturedAt!.addingTimeInterval(600)))
    #expect(try await resolved.audio(waiting) == PocketProtocol.wav(data))
}

/** 周期重试旧录音不进入忙碌状态、不占用发送入口，手动确认仍可启动 */
@MainActor @Test func pocketWaitingRecordingsDoNotToggleBusy() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let local = try LocalStore(directory: directory)
    let relay = try PocketRelay(local: local)
    let data = Data([0xFF])
    let binding = PocketBinding(peripheralID: UUID(), connectionID: UUID(), instanceID: "first")
    let manifest = pocketManifest(data)
    let unknown = PocketManifest(id: manifest.id, identifier: manifest.identifier, count: manifest.count,
                                 checksum: manifest.checksum, capturedAt: nil, interrupted: false)
    _ = try await relay.inbox.begin(unknown, binding: binding)
    _ = try await relay.inbox.append(PocketProtocol.bytes(0) + data, id: unknown.id)
    await relay.refresh()
    relay.connection = { binding in
        RuntimeConnection(id: binding.connectionID, name: "test", baseURL: URL(string: "http://127.0.0.1:1")!, instanceId: binding.instanceID)
    }
    for _ in 0..<3 {
        relay.flush()
        #expect(!relay.busy)
        await Task.yield()
        #expect(!relay.busy)
    }
    let item = try #require(relay.records.first)
    relay.flush(confirm: item.id)
    #expect(relay.busy)
    // 测试连接指向无服务的本机端口，请求失败后等待任务释放临时目录
    while relay.busy { await Task.yield() }
}
