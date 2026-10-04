import CoreBluetooth
import Observation
import UIKit

/** App 生命周期内唯一的 BLE 中继；与对话页面和当前调试连接解耦 */
@MainActor @Observable final class PocketRelay: NSObject {
    private(set) var binding: PocketBinding?
    private(set) var devices: [CBPeripheral] = []
    private(set) var records: [PocketRecording] = []
    private(set) var status = "尚未连接随身设备"
    private(set) var progress: Double?
    private(set) var scanning = false
    private(set) var sendingID: String?
    private(set) var busy = false
    var error: String?
    @ObservationIgnored var connection: ((PocketBinding) -> RuntimeConnection?)?
    @ObservationIgnored let inbox: PocketInbox
    @ObservationIgnored private let local: LocalStore
    @ObservationIgnored private var central: CBCentralManager?
    @ObservationIgnored private var peripheral: CBPeripheral?
    @ObservationIgnored private var control: CBCharacteristic?
    @ObservationIgnored private var manifestCharacteristic: CBCharacteristic?
    @ObservationIgnored private var audioCharacteristic: CBCharacteristic?
    @ObservationIgnored private var activeManifest: PocketManifest?
    @ObservationIgnored private var acknowledgedID: String?
    @ObservationIgnored private var commands: [Data] = []
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var receiving: Task<Void, Never>?
    @ObservationIgnored private var uploading: Task<Void, Never>?
    @ObservationIgnored private var scanTimeout: Task<Void, Never>?
    @ObservationIgnored private var verificationTimeout: Task<Void, Never>?
    @ObservationIgnored private var verified = false
    @ObservationIgnored private var clockSyncRequested = false

    /** 恢复配对和持久收件箱；未配对时不提前请求蓝牙权限 */
    init(local: LocalStore) throws {
        self.local = local
        inbox = try PocketInbox(local: local)
        binding = try local.read("pocket-binding.json", fallback: nil)
        super.init()
        if binding != nil { startCentral() }
        Task { await refresh() }
    }

    /** 懒加载带恢复标识的中央管理器，系统恢复时沿用同一个实例 */
    private func startCentral() {
        guard central == nil else { return }
        central = CBCentralManager(delegate: self, queue: .main, options: [CBCentralManagerOptionRestoreIdentifierKey: "dev.selfcraft.pocket.central"])
    }

    /** 用户主动寻找设备，限制扫描时间以避免持续搜索耗电 */
    func scan() {
        scanning = true
        devices = []
        startCentral()
        if central?.state == .poweredOn { beginScan() }
        else if central?.state != .unknown && central?.state != .resetting { scanning = false }
    }

    /** 只扫描 Selfcraft 服务，三十秒后停止并保留发现结果 */
    private func beginScan() {
        central?.scanForPeripherals(withServices: [CBUUID(string: PocketProtocol.service)])
        status = "正在寻找随身设备"
        scanTimeout?.cancel()
        scanTimeout = Task {
            try? await Task.sleep(for: .seconds(30))
            guard !Task.isCancelled else { return }
            central?.stopScan()
            scanning = false
            status = devices.isEmpty ? "未找到设备，请检查供电和固件" : "选择要连接的设备"
        }
    }

    /** 显式绑定设备与实例后连接，绑定失败时不继续交换数据 */
    func pair(_ device: CBPeripheral, to connection: RuntimeConnection) {
        do {
            let value = PocketBinding(peripheralID: device.identifier, connectionID: connection.id, instanceID: connection.instanceId)
            try local.write(value, name: "pocket-binding.json")
            binding = value
            central?.stopScan()
            scanTimeout?.cancel()
            scanning = false
            attach(device)
        } catch { self.error = error.localizedDescription }
    }

    /** 解除传输关联，已接收录音仍保留原目标及待发送状态 */
    func forget() {
        do {
            try local.write(Optional<PocketBinding>.none, name: "pocket-binding.json")
            binding = nil
            generation = UUID()
            if let peripheral { central?.cancelPeripheralConnection(peripheral) }
            clearTransfer()
            peripheral = nil
            status = "尚未连接随身设备"
        } catch { self.error = error.localizedDescription }
    }

    /** 恢复绑定连接；用户强制重连时先断开旧连接，再由断连回调重新验证 */
    func reconnect(force: Bool = false) {
        guard let binding, let central, central.state == .poweredOn else { return }
        if force { error = nil }
        if let device = central.retrievePeripherals(withIdentifiers: [binding.peripheralID]).first {
            if force, device.state == .connected || device.state == .connecting {
                clearTransfer()
                status = "正在重新连接设备"
                central.cancelPeripheralConnection(device)
            } else if device.state != .disconnecting { attach(device) }
        } else { central.scanForPeripherals(withServices: [CBUUID(string: PocketProtocol.service)]) }
    }

    /** 设置代理并连接唯一绑定设备，不自动绑定扫描到的其他设备 */
    private func attach(_ device: CBPeripheral) {
        guard central?.state == .poweredOn else { return }
        if peripheral?.identifier == device.identifier, device.state == .connected,
           verified || verificationTimeout != nil { return }
        peripheral = device
        device.delegate = self
        status = "正在连接设备"
        if device.state == .connected { discover(device) }
        else if device.state != .connecting { central?.connect(device) }
    }

    /** 清除旧 GATT 状态，迟到的异步分包通过代次校验丢弃 */
    private func clearTransfer() {
        generation = UUID()
        verificationTimeout?.cancel()
        verificationTimeout = nil
        verified = false
        clockSyncRequested = false
        control = nil
        manifestCharacteristic = nil
        audioCharacteristic = nil
        activeManifest = nil
        acknowledgedID = nil
        commands = []
        progress = nil
    }

    /** 连接建立后只发现约定服务，不依赖缓存的 characteristic 对象 */
    private func discover(_ device: CBPeripheral) {
        guard central?.state == .poweredOn else { return }
        clearTransfer()
        error = nil
        device.delegate = self
        status = "正在验证设备服务"
        let revision = generation
        verificationTimeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(60))
            guard !Task.isCancelled, let self, revision == self.generation else { return }
            self.failConnection("设备验证超时（\(self.status)），请检查设备供电后重新连接")
        }
        device.discoverServices([CBUUID(string: PocketProtocol.service)])
    }

    /** 验证或传输失败时停止旧连接，保留原件和明确错误，等待用户重试 */
    private func failConnection(_ message: String) {
        error = message
        clearTransfer()
        status = "设备通信暂停，请重新连接"
        if let peripheral { central?.cancelPeripheralConnection(peripheral) }
    }

    /** 恢复已有订阅或按顺序启用通知，避免等待不会重复出现的订阅回调 */
    private func subscribe(_ device: CBPeripheral) {
        guard let audioCharacteristic, let manifestCharacteristic else { return }
        if !audioCharacteristic.isNotifying {
            status = "正在建立安全连接"
            device.setNotifyValue(true, for: audioCharacteristic)
        } else if !manifestCharacteristic.isNotifying {
            status = "正在订阅录音通知"
            device.setNotifyValue(true, for: manifestCharacteristic)
        } else if !clockSyncRequested {
            clockSyncRequested = true
            status = "正在读取设备录音状态"
            command(Data([1]) + PocketProtocol.bytes(UInt32(Date().timeIntervalSince1970)))
        }
    }

    /** 排队带响应写入，保持同步时钟、续传与 ACK 的顺序 */
    private func command(_ value: Data) {
        guard control != nil else { return }
        commands.append(value)
        if commands.count == 1 { writeNext() }
    }

    /** 每次只发一个控制命令，ATT 成功响应后再发下一个 */
    private func writeNext() {
        guard let first = commands.first, let peripheral, let control else { return }
        peripheral.writeValue(first, for: control, type: .withResponse)
    }

    /** 串行处理清单与分包，避免 actor 等待期间重排手机持久化操作 */
    private func receive(_ data: Data, manifest: Bool) {
        let previous = receiving
        let revision = generation
        receiving = Task {
            await previous?.value
            guard revision == generation, let binding else { return }
            do {
                if manifest {
                    let decoded = try PocketProtocol.decode(data)
                    verified = true
                    verificationTimeout?.cancel()
                    verificationTimeout = nil
                    guard let value = decoded else {
                        activeManifest = nil
                        progress = nil
                        status = "设备已连接，按住按键记录想法"
                        return
                    }
                    if value.id == acknowledgedID { return }
                    if activeManifest == value { return }
                    let offset = try await inbox.begin(value, binding: binding)
                    guard revision == generation else { return }
                    activeManifest = value
                    if offset == value.count { await accepted(value) }
                    else {
                        progress = Double(offset) / Double(value.count)
                        status = "正在接收录音"
                        command(Data([2]) + PocketProtocol.bytes(UInt32(offset)))
                    }
                } else if let value = activeManifest {
                    let offset = try await inbox.append(data, id: value.id)
                    guard revision == generation else { return }
                    progress = Double(offset) / Double(value.count)
                    if offset == value.count { await accepted(value) }
                }
            } catch {
                failConnection(error.localizedDescription)
            }
        }
    }

    /** 收件箱提交完成才发送 ACK；Runtime 离线不影响设备释放已安全转存的空间 */
    private func accepted(_ value: PocketManifest) async {
        acknowledgedID = value.id
        command(Data([3]) + value.identifier)
        activeManifest = nil
        progress = nil
        status = "录音已保存到手机"
        await refresh()
        flush()
    }

    /** 同步显示快照，磁盘工作由 actor 串行执行 */
    func refresh() async { records = await inbox.snapshot() }

    /** 显式丢弃未发送录音；发送过程中不能与网络提交竞争 */
    func discard(_ item: PocketRecording) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do { try await inbox.discard(item.id); await refresh() }
        catch { self.error = error.localizedDescription }
    }

    /** 使用稳定录音 ID 投递；旧录音只允许逐条明确确认后发送 */
    func flush(confirm id: String? = nil) {
        guard uploading == nil, !busy else { return }
        let pending = records.filter {
            $0.needsDelivery(at: Date(), confirmedID: id) && connection?($0.binding)?.instanceId == $0.binding.instanceID
        }
        // 在进入忙碌状态前排除等待确认和没有目标连接的录音，避免周期刷新使页面闪烁
        guard !pending.isEmpty else { return }
        busy = true
        uploading = Task {
            var background: UIBackgroundTaskIdentifier = .invalid
            background = UIApplication.shared.beginBackgroundTask(withName: "Relay pocket recording") { [weak self] in self?.uploading?.cancel() }
            defer {
                if background != .invalid { UIApplication.shared.endBackgroundTask(background) }
                uploading = nil
                busy = false
                sendingID = nil
            }
            for item in pending {
                guard !Task.isCancelled else { break }
                guard item.needsDelivery(at: Date(), confirmedID: id) else { continue }
                guard let target = connection?(item.binding), target.instanceId == item.binding.instanceID else { continue }
                do {
                    let api = RuntimeAPI(connection: target, token: try LocalStore.token(target.id))
                    let info: JSONValue = try await api.get("/api/connection")
                    guard info["instanceId"].string == item.binding.instanceID else { throw RuntimeError(message: "服务地址对应另一实例，已停止投递") }
                    let receipt: JSONValue = try await api.get("/api/conversation/receipts/\(item.id)")
                    if receipt["status"].string.isEmpty {
                        if item.submissionPending != false {
                            try await inbox.update(item.id, submissionPending: false)
                            await refresh()
                        }
                        guard item.id == id || item.canAutomaticallySend(at: Date()) else { continue }
                        sendingID = item.id
                        try await api.upload(try await inbox.audio(item), id: item.id, capturedAt: item.capturedAt)
                        let result: JSONValue = try await api.get("/api/audio/\(item.id)/transcribe", method: "POST", body: .object([:]))
                        try Task.checkCancellation()
                        // 转写耗时也计入自动发送窗口，过期后保留原音等待确认
                        guard item.id == id || item.canAutomaticallySend(at: Date()) else { continue }
                        let parts: [JSONValue] = [.object(["type": .string("text"), "text": result["text"]])]
                        // 提交前落盘，响应丢失或 App 退出后即使超过五分钟仍能核对回执
                        try await inbox.update(item.id, submissionPending: true)
                        let _: JSONValue = try await api.get("/api/conversation/messages", method: "POST", body: .object([
                            "id": .string(item.id), "audioId": .string(item.id),
                            "messages": .array([.object(["role": .string("user"), "parts": .array(parts)])]),
                        ]))
                    }
                    try await inbox.update(item.id, sent: true)
                } catch {
                    if !Task.isCancelled { try? await inbox.update(item.id, error: error.localizedDescription) }
                }
                await refresh()
            }
        }
    }
}

/** CoreBluetooth 委托固定在主队列，恢复流程仍检查已保存的设备绑定 */
extension PocketRelay: @preconcurrency CBCentralManagerDelegate, @preconcurrency CBPeripheralDelegate {
    /** 蓝牙可用时恢复连接，关闭或无权限时保留持久录音 */
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .poweredOn {
            if binding != nil { reconnect() }
            else if scanning { beginScan() }
        } else {
            scanning = false
            scanTimeout?.cancel()
            clearTransfer()
            status = central.state == .unsupported ? "此设备不支持蓝牙（模拟器无法连接硬件）" : "请开启蓝牙并允许 Selfcraft 使用"
        }
    }

    /** 系统后台恢复已连接或等待连接的设备，不接管未知外设 */
    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        guard let binding, let restored = (dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral])?.first(where: { $0.identifier == binding.peripheralID }) else { return }
        peripheral = restored
        restored.delegate = self
        // 恢复回调早于 poweredOn，此处只接管对象，蓝牙就绪后再发现服务
        status = "正在恢复蓝牙连接"
    }

    /** 展示发现结果；已有绑定时只恢复那一台设备 */
    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        if let binding {
            if peripheral.identifier == binding.peripheralID { central.stopScan(); attach(peripheral) }
        } else if !devices.contains(where: { $0.identifier == peripheral.identifier }) { devices.append(peripheral) }
    }

    /** 建立连接后执行服务发现 */
    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) { discover(peripheral) }

    /** 连接失败后保留绑定，由用户或下次前台恢复重试 */
    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        status = "设备连接失败，请重试"
        self.error = error?.localizedDescription
    }

    /** 自然断连时恢复待连接请求；协议错误需用户处理后重试 */
    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        clearTransfer()
        if self.error == nil { status = binding == nil ? "尚未连接随身设备" : "设备离线，录音将在重连后补传" }
        if self.error == nil, binding != nil { reconnect() }
    }

    /** 读取协议所需三个特征 */
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        if let error { failConnection(error.localizedDescription); return }
        guard let service = peripheral.services?.first(where: { $0.uuid == CBUUID(string: PocketProtocol.service) }) else {
            failConnection("设备缺少录音服务")
            return
        }
        status = "正在读取设备服务"
        peripheral.discoverCharacteristics([PocketProtocol.manifest, PocketProtocol.control, PocketProtocol.audio].map { CBUUID(string: $0) }, for: service)
    }

    /** 订阅加密音频通知，再同步时钟并请求清单 */
    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        if let error { failConnection(error.localizedDescription); return }
        for characteristic in service.characteristics ?? [] {
            switch characteristic.uuid {
            case CBUUID(string: PocketProtocol.control): control = characteristic
            case CBUUID(string: PocketProtocol.manifest): manifestCharacteristic = characteristic
            case CBUUID(string: PocketProtocol.audio): audioCharacteristic = characteristic
            default: break
            }
        }
        guard control != nil, audioCharacteristic != nil, manifestCharacteristic != nil else { failConnection("设备缺少录音特征"); return }
        subscribe(peripheral)
    }

    /** 等待订阅完成后发起传输，避免首批通知在订阅前丢失 */
    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        if let error { failConnection(error.localizedDescription); return }
        if characteristic == audioCharacteristic || characteristic == manifestCharacteristic { subscribe(peripheral) }
    }

    /** 同步时间或 ACK 完成后主动读取，清单通知仅作为新录音提示 */
    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error { failConnection(error.localizedDescription); return }
        guard !commands.isEmpty else { return }
        let opcode = commands.removeFirst().first
        if opcode == 1 || opcode == 3, let manifestCharacteristic { peripheral.readValue(for: manifestCharacteristic) }
        writeNext()
    }

    /** 清单通知可超过默认 ATT 长度，因此通知只触发完整读取 */
    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error { failConnection(error.localizedDescription); return }
        guard let data = characteristic.value else { return }
        if characteristic == manifestCharacteristic {
            if data.count < 32 { peripheral.readValue(for: characteristic) }
            else { receive(data, manifest: true) }
        } else if characteristic == audioCharacteristic { receive(data, manifest: false) }
    }
}
