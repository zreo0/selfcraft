#include <algorithm>
#include <cassert>
#include <cstdio>
#include <vector>
#include "../selfcraft-pocket/pocket-storage.h"

/** NOR flash 测试替身：只能清零，支持在任意一次写入中途掉电 */
struct MemoryFlash {
    std::vector<uint8_t> bytes = std::vector<uint8_t>(2 * SLOT_SIZE, 0xFF);
    int writes = 0, cutAt = -1, erases = 0;

    /** 按地址返回字节，所有越界均使测试失败 */
    uint32_t readBuffer(uint32_t address, uint8_t* output, uint32_t size) {
        assert(address + size <= bytes.size());
        memcpy(output, bytes.data() + address, size);
        return size;
    }

    /** 模拟 NOR 编程及半次写入，返回实际落盘字节数 */
    uint32_t writeBuffer(uint32_t address, const uint8_t* input, uint32_t size) {
        assert(address + size <= bytes.size());
        const uint32_t count = ++writes == cutAt ? size / 2 : size;
        for (uint32_t i = 0; i < count; ++i) {
            assert((bytes[address + i] & input[i]) == input[i]);
            bytes[address + i] &= input[i];
        }
        return count;
    }

    /** 模拟 64KiB 擦除并记录是否错误回收待确认数据 */
    bool eraseBlock(uint32_t block) {
        ++erases;
        std::fill(bytes.begin() + block * 65536, bytes.begin() + (block + 1) * 65536, 0xFF);
        return true;
    }

    /** 内存测试无需等待 flash 忙状态 */
    void waitUntilReady() {}
};

/** 验证公开编码向量、掉电恢复、内容读取、幂等 ACK 与禁止覆盖 */
int main() {
    assert(~pocketCRC((const uint8_t*)"123456789", 9) == 0xCBF43926);
    assert(pocketMuLaw(0) == 0xFF);
    assert(pocketMuLaw(32124) == 0x80);
    assert(pocketMuLaw(-32124) == 0x00);
    MemoryFlash flash;
    PocketStorage<MemoryFlash> storage(flash);
    assert(storage.recover() && storage.prepare(0));
    uint8_t id[16] = {1, 2, 3};
    std::vector<uint8_t> audio(BLOCK_BYTES * 2 + 37);
    for (uint32_t i = 0; i < audio.size(); ++i) audio[i] = uint8_t(i);
    assert(storage.start(0, id, 1790000000));
    assert(storage.append(0, audio.data(), BLOCK_BYTES));
    const MemoryFlash committed = flash;
    // 在第二块内容、长度/CRC 或提交标记的任意写入中断，只能恢复第一块
    for (int cut = 1; cut <= 3; ++cut) {
        MemoryFlash interrupted = committed;
        PocketStorage<MemoryFlash> writer(interrupted);
        writer.slots[0] = storage.slots[0];
        interrupted.cutAt = interrupted.writes + cut;
        assert(!writer.append(0, audio.data() + BLOCK_BYTES, BLOCK_BYTES));
        PocketStorage<MemoryFlash> restored(interrupted);
        assert(restored.recover());
        assert(restored.slots[0].count == BLOCK_BYTES);
        assert(restored.slots[0].interrupted);
        const int erases = interrupted.erases;
        assert(restored.prepare(0) && interrupted.erases == erases);
        assert(!restored.start(0, id, 0));
    }
    assert(storage.append(0, audio.data() + BLOCK_BYTES, BLOCK_BYTES));
    assert(storage.append(0, audio.data() + BLOCK_BYTES * 2, 37));
    assert(storage.finish(0, false));
    PocketStorage<MemoryFlash> restored(flash);
    assert(restored.recover());
    assert(restored.slots[0].valid && !restored.slots[0].interrupted);
    assert(restored.slots[0].count == audio.size());
    std::vector<uint8_t> result(audio.size());
    assert(restored.read(0, 0, result.data(), result.size()) && result == audio);
    assert(~restored.slots[0].crc == ~pocketCRC(audio.data(), audio.size()));
    uint8_t wrong[16] = {};
    assert(!restored.acknowledge(0, wrong));
    assert(restored.acknowledge(0, id));
    PocketStorage<MemoryFlash> acknowledged(flash);
    assert(acknowledged.recover() && !acknowledged.slots[0].valid);
    assert(acknowledged.prepare(0) && acknowledged.start(0, wrong, 0));
    // 两个满槽都应恢复且不可覆盖，逻辑尾块不能越过每槽边界
    MemoryFlash fullFlash;
    PocketStorage<MemoryFlash> full(fullFlash);
    std::vector<uint8_t> chunk(BLOCK_BYTES, 0x7F);
    for (int slot = 0; slot < 2; ++slot) {
        id[0] = uint8_t(slot);
        assert(full.prepare(slot) && full.start(slot, id, 0));
        for (uint32_t offset = 0; offset < MAX_SAMPLES;) {
            const uint32_t count = std::min(BLOCK_BYTES, MAX_SAMPLES - offset);
            assert(full.append(slot, chunk.data(), count));
            offset += count;
        }
        assert(!full.append(slot, chunk.data(), 1));
        assert(full.finish(slot, false));
    }
    PocketStorage<MemoryFlash> fullRestored(fullFlash);
    assert(fullRestored.recover());
    for (int slot = 0; slot < 2; ++slot) {
        assert(fullRestored.slots[slot].valid && fullRestored.slots[slot].count == MAX_SAMPLES);
        assert(!fullRestored.start(slot, id, 0));
        uint8_t last = 0;
        assert(fullRestored.read(slot, MAX_SAMPLES - 1, &last, 1) && last == 0x7F);
    }
    std::puts("Pocket storage: codec, power cuts, protected backlog, readback and durable ACK passed");
}
