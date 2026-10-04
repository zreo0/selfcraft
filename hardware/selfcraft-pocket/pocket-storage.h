#pragma once
#include <stdint.h>
#include <string.h>

/** 共享存储常量；两个 1MiB 槽各保存最多一分钟 μ-law 录音 */
static const uint32_t SLOT_SIZE = 1024 * 1024;
static const uint32_t BLOCK_BYTES = 4080;
static const uint32_t MAX_SAMPLES = 960000;
static const uint32_t HEADER_MAGIC = 0x31504353;
static const uint32_t BLOCK_MAGIC = 0x314B4C42;
static const uint32_t SEAL_MAGIC = 0x31444E45;

/** 增量 CRC32，输入和输出均为尚未取反的中间状态 */
inline uint32_t pocketCRC(const uint8_t* data, uint32_t size, uint32_t crc = 0xFFFFFFFF) {
    for (uint32_t i = 0; i < size; ++i) {
        crc ^= data[i];
        for (uint8_t bit = 0; bit < 8; ++bit) crc = (crc >> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
    }
    return crc;
}

/** PCM16 压缩为标准 G.711 μ-law，手机还原 PCM 后复用语音识别接口 */
inline uint8_t pocketMuLaw(int16_t sample) {
    int value = sample;
    const uint8_t sign = value < 0 ? 0x80 : 0;
    if (value < 0) value = -value;
    if (value > 32635) value = 32635;
    value += 132;
    uint8_t exponent = 7;
    for (int mask = 0x4000; exponent > 0 && !(value & mask); mask >>= 1) --exponent;
    return uint8_t(~(sign | (exponent << 4) | ((value >> (exponent + 3)) & 15)));
}

/** 槽内元数据；未封口的录音重启后作为中断片段恢复 */
struct PocketSlot {
    uint8_t id[16] = {};
    uint32_t epoch = 0;
    uint32_t count = 0;
    uint32_t crc = 0xFFFFFFFF;
    bool interrupted = false;
    bool valid = false;
    bool ready = false;
};

/** 原始 flash 追加日志；每块先写内容再写提交标记，不覆盖未 ACK 录音 */
template<class Flash> class PocketStorage {
    Flash& flash;
    uint8_t scratch[BLOCK_BYTES];

    /** 完整写入并等待芯片结束编程，失败由调用方停止录音 */
    bool write(uint32_t address, const void* data, uint32_t size) {
        const bool ok = flash.writeBuffer(address, (const uint8_t*)data, size) == size;
        flash.waitUntilReady();
        return ok;
    }

public:
    PocketSlot slots[2];

    /** 绑定 flash 驱动，主机测试使用相同代码和内存 flash */
    explicit PocketStorage(Flash& device) : flash(device) {}

    /** 恢复所有提交块，掉电时尚未提交的块和 RAM 中样本无法恢复 */
    bool recover() {
        for (int slot = 0; slot < 2; ++slot) {
            uint32_t header[7], seal[5];
            const uint32_t base = slot * SLOT_SIZE;
            if (flash.readBuffer(base, (uint8_t*)header, sizeof(header)) != sizeof(header)
                || flash.readBuffer(base + 64, (uint8_t*)seal, sizeof(seal)) != sizeof(seal)) return false;
            slots[slot] = PocketSlot();
            if (header[0] != HEADER_MAGIC || seal[4] == 0) continue;
            if (~pocketCRC((uint8_t*)(header + 1), 20) != header[6]) return false;
            PocketSlot& entry = slots[slot];
            memcpy(entry.id, header + 1, 16);
            entry.epoch = header[5];
            for (uint32_t block = 0; block < 255; ++block) {
                uint32_t metadata[3];
                const uint32_t address = base + 4096 + block * 4096;
                if (flash.readBuffer(address, (uint8_t*)metadata, 12) != 12) return false;
                const uint32_t size = metadata[0];
                if (metadata[2] != BLOCK_MAGIC || size == 0 || size > BLOCK_BYTES || entry.count + size > MAX_SAMPLES) break;
                if (flash.readBuffer(address + 16, scratch, size) != size) return false;
                if (~pocketCRC(scratch, size) != metadata[1]) break;
                entry.crc = pocketCRC(scratch, size, entry.crc);
                entry.count += size;
                if (size < BLOCK_BYTES) break;
            }
            entry.valid = entry.count != 0;
            entry.interrupted = seal[3] != SEAL_MAGIC || seal[0] != entry.count || seal[1] != ~entry.crc || seal[2] != 0;
        }
        return true;
    }

    /** 空闲时预擦除已释放槽，未被手机持久接收的槽永不擦除 */
    bool prepare(int slot) {
        PocketSlot& entry = slots[slot];
        if (entry.valid || entry.ready) return true;
        for (uint32_t block = slot * 16; block < uint32_t(slot + 1) * 16; ++block) {
            if (!flash.eraseBlock(block)) return false;
            flash.waitUntilReady();
        }
        entry = PocketSlot();
        entry.ready = true;
        return true;
    }

    /** 固定本次身份和采集时间，头部最后提交后才开始采样 */
    bool start(int slot, const uint8_t id[16], uint32_t epoch) {
        if (slots[slot].valid || !slots[slot].ready) return false;
        uint32_t header[7] = {HEADER_MAGIC};
        memcpy(header + 1, id, 16);
        header[5] = epoch;
        header[6] = ~pocketCRC((uint8_t*)(header + 1), 20);
        const uint32_t base = slot * SLOT_SIZE;
        if (!write(base + 4, header + 1, 24) || !write(base, header, 4)) return false;
        slots[slot] = PocketSlot();
        memcpy(slots[slot].id, id, 16);
        slots[slot].epoch = epoch;
        return true;
    }

    /** 追加一个块，调用方仅允许最后一块不足 4080 字节 */
    bool append(int slot, const uint8_t* data, uint32_t size) {
        PocketSlot& entry = slots[slot];
        if (!size || size > BLOCK_BYTES || entry.count % BLOCK_BYTES || entry.count + size > MAX_SAMPLES) return false;
        const uint32_t address = slot * SLOT_SIZE + 4096 + (entry.count / BLOCK_BYTES) * 4096;
        uint32_t metadata[3] = {size, ~pocketCRC(data, size), BLOCK_MAGIC};
        if (!write(address + 16, data, size) || !write(address, metadata, 8) || !write(address + 8, metadata + 2, 4)) return false;
        entry.count += size;
        entry.crc = pocketCRC(data, size, entry.crc);
        return true;
    }

    /** 封口并记录完整性；空录音不会进入待传队列 */
    bool finish(int slot, bool interrupted) {
        PocketSlot& entry = slots[slot];
        uint32_t seal[4] = {entry.count, ~entry.crc, uint32_t(interrupted), SEAL_MAGIC};
        const uint32_t address = slot * SLOT_SIZE + 64;
        if (!write(address, seal, 12) || !write(address + 12, seal + 3, 4)) return false;
        entry.interrupted = interrupted;
        entry.valid = entry.count != 0;
        return true;
    }

    /** 按逻辑音频偏移跨块读取，传输不暴露存储头或未提交内容 */
    bool read(int slot, uint32_t offset, uint8_t* data, uint32_t size) {
        if (!slots[slot].valid || offset > slots[slot].count || size > slots[slot].count - offset) return false;
        while (size) {
            const uint32_t within = offset % BLOCK_BYTES;
            const uint32_t count = size < BLOCK_BYTES - within ? size : BLOCK_BYTES - within;
            const uint32_t address = slot * SLOT_SIZE + 4096 + (offset / BLOCK_BYTES) * 4096 + 16 + within;
            if (flash.readBuffer(address, data, count) != count) return false;
            offset += count;
            data += count;
            size -= count;
        }
        return true;
    }

    /** ACK 先落盘，重启仍知道该录音已由手机接管，再允许擦除 */
    bool acknowledge(int slot, const uint8_t id[16]) {
        if (!slots[slot].valid || memcmp(slots[slot].id, id, 16)) return false;
        const uint32_t acknowledged = 0;
        if (!write(slot * SLOT_SIZE + 80, &acknowledged, 4)) return false;
        slots[slot].valid = false;
        return true;
    }
};
