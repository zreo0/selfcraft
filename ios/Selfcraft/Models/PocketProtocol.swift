import Foundation

/** 随身设备 v1 使用 16kHz G.711 μ-law，接收后还原为 Runtime 的 PCM WAV */
enum PocketProtocol {
    static let service = "86B60001-4BCE-4D19-AC2B-2D478FD5A100"
    static let manifest = "86B60002-4BCE-4D19-AC2B-2D478FD5A100"
    static let control = "86B60003-4BCE-4D19-AC2B-2D478FD5A100"
    static let audio = "86B60004-4BCE-4D19-AC2B-2D478FD5A100"
    static let maximumBytes = 960_000

    /** 校验固定长度清单；空队列返回 nil，未知协议拒绝接收 */
    static func decode(_ data: Data) throws -> PocketManifest? {
        guard data.count == 32, data[0] == 1 else { throw RuntimeError(message: "设备协议不兼容，请更新固件") }
        if data[30] == 0 { return nil }
        let count = Int(uint32(data, at: 22))
        guard count > 0, count <= maximumBytes, data[30] <= 2 else { throw RuntimeError(message: "设备录音大小无效") }
        let bytes = Array(data[2..<18])
        let id = bytes.map { String(format: "%02x", $0) }.joined()
        let epoch = uint32(data, at: 18)
        return PocketManifest(id: id, identifier: Data(bytes), count: count, checksum: uint32(data, at: 26),
                              capturedAt: epoch == 0 ? nil : Date(timeIntervalSince1970: Double(epoch)), interrupted: data[1] & 1 != 0)
    }

    /** 按小端读取已通过边界检查的协议整数，避免非对齐内存访问 */
    static func uint32(_ data: Data, at offset: Int) -> UInt32 {
        (0..<4).reduce(0) { $0 | UInt32(data[offset + $1]) << ($1 * 8) }
    }

    /** 输出小端整数供命令和 WAV 头使用 */
    static func bytes(_ value: UInt32) -> Data {
        Data((0..<4).map { UInt8(truncatingIfNeeded: value >> ($0 * 8)) })
    }

    /** 校验传输内容，只有完整匹配清单的录音才允许确认删除 */
    static func crc32(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xFFFFFFFF
        for byte in data {
            crc ^= UInt32(byte)
            for _ in 0..<8 { crc = (crc >> 1) ^ (crc & 1 == 1 ? 0xEDB88320 : 0) }
        }
        return ~crc
    }

    /** 将单字节 μ-law 解码为有符号 PCM 样本 */
    static func sample(_ byte: UInt8) -> Int16 {
        let value = Int(~byte)
        let magnitude = (((value & 15) << 3) + 132) << ((value >> 4) & 7)
        return Int16(value & 128 == 0 ? magnitude - 132 : 132 - magnitude)
    }

    /** 构造 16kHz 单声道 16bit WAV，编码和 Runtime 校验保持一致 */
    static func wav(_ encoded: Data) -> Data {
        var result = Data("RIFF".utf8) + bytes(UInt32(36 + encoded.count * 2)) + Data("WAVEfmt ".utf8)
        result += bytes(16) + Data([1, 0, 1, 0]) + bytes(16_000) + bytes(32_000) + Data([2, 0, 16, 0])
        result += Data("data".utf8) + bytes(UInt32(encoded.count * 2))
        result.reserveCapacity(44 + encoded.count * 2)
        for byte in encoded {
            let pcm = UInt16(bitPattern: sample(byte))
            result.append(UInt8(truncatingIfNeeded: pcm))
            result.append(UInt8(truncatingIfNeeded: pcm >> 8))
        }
        return result
    }
}

/** 录音身份与内容摘要在重连时保持不变 */
struct PocketManifest: Codable, Equatable, Sendable {
    let id: String
    let identifier: Data
    let count: Int
    let checksum: UInt32
    let capturedAt: Date?
    let interrupted: Bool
}

/** 配对时固定投递目标，调试切换不会迁移设备录音 */
struct PocketBinding: Codable, Sendable {
    let peripheralID: UUID
    let connectionID: UUID
    let instanceID: String
}

/** 手机持久收件箱同时保留已接收标识，防止设备 ACK 丢失导致重复提交 */
struct PocketRecording: Codable, Identifiable, Sendable {
    let manifest: PocketManifest
    let binding: PocketBinding
    let receivedAt: Date
    var sent = false
    var discarded: Bool? = nil
    var error: String?
    /** true 表示提交结果未确认；nil 兼容旧队列，需要先核对一次回执 */
    var submissionPending: Bool? = false
    var id: String { "pocket-" + manifest.id }
    var filename: String { id + ".wav" }
    var capturedAt: Date { manifest.capturedAt ?? receivedAt }

    /** 沿用 App 五分钟补发窗口，中断或时间不明的录音必须由用户确认 */
    func canAutomaticallySend(at date: Date) -> Bool {
        guard let captured = manifest.capturedAt, !manifest.interrupted else { return false }
        return (0...300).contains(date.timeIntervalSince(captured))
    }

    /** 只调度明确确认、有效自动发送或结果未确认的录音，等待用户的旧录音保持静止 */
    func needsDelivery(at date: Date, confirmedID: String? = nil) -> Bool {
        !sent && discarded != true && (id == confirmedID || canAutomaticallySend(at: date) || submissionPending != false)
    }
}
