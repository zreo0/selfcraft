#include <bluefruit.h>
#include <Adafruit_TinyUSB.h>
#include <Adafruit_SPIFlash.h>
#include <PDM.h>
#include "pocket-storage.h"

/** 实测 HW-483 模块 S 接 D0，按下接地；使用内部上拉避免下拉干扰松开电平 */
static const int BUTTON_ACTIVE = LOW;
static const uint32_t RING_SIZE = 16384;
static const char* SERVICE_UUID = "86B60001-4BCE-4D19-AC2B-2D478FD5A100";
Adafruit_FlashTransport_QSPI transport;
Adafruit_SPIFlash flash(&transport);
/** Seeed 1.1.10 的 SPIFlash 默认表未包含 Puya，参数来自 P25Q16H 数据手册 */
static const SPIFlash_Device_t PUYA_FLASH = {
    .total_size = 2 * SLOT_SIZE, .start_up_time_us = 5000,
    .manufacturer_id = 0x85, .memory_type = 0x60, .capacity = 0x15,
    .max_clock_speed_mhz = 33, .quad_enable_bit_mask = 0x02,
    .has_sector_protection = false, .supports_fast_read = true,
    .supports_qspi = true, .supports_qspi_writes = true,
    .write_status_register_split = false, .single_status_byte = false, .is_fram = false,
};
PocketStorage<Adafruit_SPIFlash> storage(flash);
BLEService service(SERVICE_UUID);
BLECharacteristic manifest("86B60002-4BCE-4D19-AC2B-2D478FD5A100");
BLECharacteristic control("86B60003-4BCE-4D19-AC2B-2D478FD5A100");
BLECharacteristic audio("86B60004-4BCE-4D19-AC2B-2D478FD5A100");
int16_t ring[RING_SIZE];
volatile uint32_t produced = 0, consumed = 0;
volatile bool overflowed = false;
uint8_t block[BLOCK_BYTES];
uint32_t buffered = 0;
int recording = -1, offered = -1;
uint32_t cursor = 0, clockEpoch = 0, clockMillis = 0;
volatile bool transferring = false;
bool fault = false, wasPressed = false;
uint32_t lastButtonChange = 0;
bool rawPressed = false;
volatile uint16_t connectionHandle = BLE_CONN_HANDLE_INVALID;
// BLE 回调只投递控制命令，flash 和录音状态统一在 loop 任务修改
volatile uint8_t commandProduced = 0, commandConsumed = 0;
volatile bool commandOverflow = false;
uint8_t pendingCommands[8][17];
uint32_t testingUntil = 0, testSamples = 0;
int testPeak = 0;
bool serialWasOpen = false;

/** 设置低有效 RGB 指示灯，不使用与硬件极性不符的通用 LED 宏 */
void leds(bool red, bool green, bool blue) {
    digitalWrite(LED_RED, red ? LOW : HIGH);
    digitalWrite(LED_GREEN, green ? LOW : HIGH);
    digitalWrite(LED_BLUE, blue ? LOW : HIGH);
}

/** 不再写 flash 并明确显示错误，保留已提交录音等待人工检查 */
void fail() {
    fault = true;
    PDM.end();
    leds(true, false, true);
    Serial.println("Pocket storage/audio error; committed audio retained. Restart to recover.");
}

/** 清单固定为 32 字节，通知内容取决于协商 MTU，手机支持重新读取 */
void publish() {
    if (offered < 0 || !storage.slots[offered].valid) {
        offered = -1;
        for (int i = 0; i < 2; ++i) if (storage.slots[i].valid) { offered = i; break; }
    }
    uint8_t data[32] = {1};
    for (int i = 0; i < 2; ++i) if (storage.slots[i].valid) ++data[30];
    if (offered >= 0) {
        const PocketSlot& entry = storage.slots[offered];
        data[1] = entry.interrupted ? 1 : 0;
        memcpy(data + 2, entry.id, 16);
        memcpy(data + 18, &entry.epoch, 4);
        memcpy(data + 22, &entry.count, 4);
        const uint32_t crc = ~entry.crc;
        memcpy(data + 26, &crc, 4);
    }
    manifest.write(data, 32);
    if (Bluefruit.connected() && manifest.notifyEnabled()) {
        // 使用完整长读获取清单，不发送被 BLE 库拆成多条的长通知
        uint8_t changed = 1;
        manifest.notify(&changed, 1);
        manifest.write(data, 32);
    }
}

/** PDM 中断仅搬运样本到环形缓冲，不在中断中操作 flash 或 BLE */
void onSamples() {
    int16_t samples[256];
    while (PDM.available()) {
        const int bytes = PDM.read(samples, min(PDM.available(), int(sizeof(samples))));
        for (int i = 0; i < bytes / 2; ++i) {
            if (produced - consumed >= RING_SIZE) { overflowed = true; return; }
            ring[produced % RING_SIZE] = samples[i];
            __DMB();
            ++produced;
        }
    }
}

/** 从中断缓冲压缩并提交 flash 块，返回是否达到时长上限 */
bool drain() {
    while (consumed != produced) {
        const int16_t sample = ring[consumed % RING_SIZE];
        __DMB();
        ++consumed;
        block[buffered++] = pocketMuLaw(sample);
        const bool full = storage.slots[recording].count + buffered == MAX_SAMPLES;
        if (buffered == BLOCK_BYTES || full) {
            if (!storage.append(recording, block, buffered)) { fail(); return true; }
            buffered = 0;
        }
        if (full) return true;
    }
    return false;
}

/** 松开或到达上限后封口，缓冲溢出片段需在手机试听确认 */
void finishRecording() {
    if (recording < 0) return;
    PDM.end();
    if (storage.slots[recording].count < MAX_SAMPLES) drain();
    if (fault) return;
    if (buffered && !storage.append(recording, block, buffered)) { fail(); return; }
    if (!storage.finish(recording, overflowed)) { fail(); return; }
    recording = -1;
    buffered = 0;
    publish();
}

/** 开始时先分配持久身份，满容量时拒绝覆盖并亮红灯 */
void startRecording() {
    int slot = -1;
    for (int i = 0; i < 2; ++i) if (!storage.slots[i].valid && storage.slots[i].ready) { slot = i; break; }
    if (slot < 0) { leds(true, false, false); return; }
    uint8_t id[16];
    if (sd_rand_application_vector_get(id, sizeof(id)) != NRF_SUCCESS) { leds(true, false, false); return; }
    // millis 溢出前使时钟过期，避免长时间断连后给录音伪造新时间
    const uint32_t elapsed = millis() - clockMillis;
    const uint32_t epoch = clockEpoch && elapsed < 86400000 ? clockEpoch + elapsed / 1000 : 0;
    if (!storage.start(slot, id, epoch)) { fail(); return; }
    recording = slot;
    produced = consumed = 0;
    buffered = 0;
    overflowed = false;
    if (!PDM.begin(1, 16000)) { fail(); return; }
    leds(true, false, false);
}

/** 有界命令队列吸收 ATT 响应与主循环处理之间的时差，不静默丢弃 ACK */
void onCommand(uint16_t handle, BLECharacteristic*, uint8_t* data, uint16_t length) {
    if (!Bluefruit.Connection(handle)->secured()) return;
    if (!((length == 5 && (data[0] == 1 || data[0] == 2)) || (length == 17 && data[0] == 3))) return;
    if (uint8_t(commandProduced - commandConsumed) >= 8) { commandOverflow = true; return; }
    memcpy(pendingCommands[commandProduced % 8], data, length);
    __DMB();
    ++commandProduced;
}

/** 在主循环处理时钟、断点和删除确认，避免 BLE 回调并发擦写 flash */
void processCommand() {
    if (commandConsumed == commandProduced) return;
    uint8_t data[17];
    memcpy(data, pendingCommands[commandConsumed % 8], 17);
    __DMB();
    ++commandConsumed;
    if (data[0] == 1) {
        memcpy(&clockEpoch, data + 1, 4);
        clockMillis = millis();
        publish();
    } else if (data[0] == 2 && offered >= 0) {
        memcpy(&cursor, data + 1, 4);
        transferring = cursor < storage.slots[offered].count;
    } else if (data[0] == 3 && offered >= 0) {
        if (memcmp(storage.slots[offered].id, data + 1, 16) == 0) {
            if (!storage.acknowledge(offered, data + 1)) { fail(); return; }
            transferring = false;
            offered = -1;
            publish();
        }
    }
}

/** 按当前 MTU 顺序发送；发送队列满时保留游标，下轮重试 */
void transfer() {
    if (!transferring || offered < 0 || !Bluefruit.connected() || !audio.notifyEnabled()) return;
    BLEConnection* connection = Bluefruit.Connection(connectionHandle);
    if (!connection || !connection->connected()) return;
    const uint16_t mtu = connection->getMtu();
    uint8_t packet[244];
    const uint32_t available = min(uint32_t(mtu - 7), uint32_t(sizeof(packet) - 4));
    const uint32_t count = min(available, storage.slots[offered].count - cursor);
    if (!count) { transferring = false; return; }
    memcpy(packet, &cursor, 4);
    if (!storage.read(offered, cursor, packet + 4, count)) { fail(); return; }
    if (audio.notify(packet, count + 4)) cursor += count;
    if (cursor == storage.slots[offered].count) transferring = false;
}

/** USB 显示系统生成的一次性配对码，录音特征要求带 MITM 保护的加密连接 */
bool onPasskey(uint16_t, const uint8_t passkey[6], bool) {
    Serial.print("Selfcraft pairing code: ");
    Serial.write(passkey, 6);
    Serial.println();
    return true;
}

/** 保存连接句柄并申请较快连接间隔；具体速率由手机协商 */
void onConnected(uint16_t handle) {
    connectionHandle = handle;
    Bluefruit.Connection(handle)->requestConnectionParameter(12, 24);
}

/** 断连不改 flash 状态，下一次由手机检查点重新请求 */
void onDisconnected(uint16_t, uint8_t) {
    transferring = false;
    connectionHandle = BLE_CONN_HANDLE_INVALID;
}

/** USB 提供状态、按键偏置对比及一秒麦克风检查，不输出或保存诊断原音 */
void diagnostics() {
    const bool opened = bool(Serial);
    const int command = Serial.available() ? Serial.read() : -1;
    if ((opened && !serialWasOpen) || command == 's') {
        Serial.print("Selfcraft Pocket ready; flash=");
        Serial.print(flash.size());
        uint8_t jedec[3] = {};
        transport.readCommand(0x9F, jedec, 3);
        Serial.print("; jedec=");
        for (uint8_t byte : jedec) Serial.print(byte, HEX);
        Serial.print("; pending=");
        Serial.print(int(storage.slots[0].valid) + int(storage.slots[1].valid));
        Serial.print("; button=");
        Serial.print(digitalRead(D0));
        Serial.print("; fault=");
        Serial.println(fault);
    }
    serialWasOpen = opened;
    if (command == 'b' && recording < 0 && !testingUntil && !fault) {
        // 临时对比输入偏置，恢复后主循环才处理按键，避免把诊断切换当作按压
        pinMode(D0, INPUT_PULLDOWN);
        delay(2);
        const int down = digitalRead(D0);
        pinMode(D0, INPUT);
        delay(2);
        const int floating = digitalRead(D0);
        pinMode(D0, INPUT_PULLUP);
        delay(2);
        const int up = digitalRead(D0);
        pinMode(D0, BUTTON_ACTIVE == HIGH ? INPUT_PULLDOWN : INPUT_PULLUP);
        delay(2);
        Serial.print("Button bias test; pulldown=");
        Serial.print(down);
        Serial.print("; no_pull=");
        Serial.print(floating);
        Serial.print("; pullup=");
        Serial.println(up);
    } else if (command == 'b') {
        Serial.println("Button bias test unavailable: recording, microphone test or fault active");
    }
    if (command == 't' && recording < 0 && !testingUntil && !fault) {
        produced = consumed = 0;
        testSamples = 0;
        testPeak = 0;
        overflowed = false;
        if (!PDM.begin(1, 16000)) { Serial.println("Microphone begin failed"); return; }
        testingUntil = millis() + 1000;
    }
    if (testingUntil) {
        while (consumed != produced) {
            testPeak = max(testPeak, abs(int(ring[consumed % RING_SIZE])));
            ++consumed;
            ++testSamples;
        }
        if (int32_t(millis() - testingUntil) >= 0) {
            PDM.end();
            testingUntil = 0;
            Serial.print("Microphone test samples=");
            Serial.print(testSamples);
            Serial.print("; peak=");
            Serial.println(testPeak);
        }
    }
}

/** 初始化加密 BLE、板载麦克风及外部 flash；不等待 USB 才允许工作 */
void setup() {
    Serial.begin(115200);
    pinMode(LED_RED, OUTPUT);
    pinMode(LED_GREEN, OUTPUT);
    pinMode(LED_BLUE, OUTPUT);
    pinMode(D0, BUTTON_ACTIVE == HIGH ? INPUT_PULLDOWN : INPUT_PULLUP);
    leds(false, false, true);
    Bluefruit.configPrphBandwidth(BANDWIDTH_MAX);
    Bluefruit.begin(1, 0);
    Bluefruit.autoConnLed(false);
    char name[30];
    snprintf(name, sizeof(name), "Selfcraft Pocket %04X", unsigned(NRF_FICR->DEVICEID[0] & 0xFFFF));
    Bluefruit.setName(name);
    Bluefruit.Security.setIOCaps(true, false, false);
    Bluefruit.Security.setMITM(true);
    Bluefruit.Security.setPairPasskeyCallback(onPasskey);
    Bluefruit.Periph.setConnectCallback(onConnected);
    Bluefruit.Periph.setDisconnectCallback(onDisconnected);
    service.begin();
    manifest.setProperties(CHR_PROPS_READ | CHR_PROPS_NOTIFY);
    manifest.setPermission(SECMODE_ENC_WITH_MITM, SECMODE_NO_ACCESS);
    manifest.setMaxLen(32);
    manifest.begin();
    control.setProperties(CHR_PROPS_WRITE);
    control.setPermission(SECMODE_NO_ACCESS, SECMODE_ENC_WITH_MITM);
    control.setMaxLen(17);
    control.setWriteCallback(onCommand);
    control.begin();
    audio.setProperties(CHR_PROPS_NOTIFY);
    audio.setPermission(SECMODE_ENC_WITH_MITM, SECMODE_NO_ACCESS);
    audio.setMaxLen(244);
    audio.begin();
    transport.begin();
    transport.runCommand(0xAB);
    delay(10);
    if (!flash.begin(&PUYA_FLASH, 1) || flash.size() < 2 * SLOT_SIZE || !storage.recover()) { fail(); return; }
    for (int i = 0; i < 2; ++i) if (!storage.prepare(i)) { fail(); return; }
    PDM.onReceive(onSamples);
    publish();
    Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
    Bluefruit.Advertising.addService(service);
    Bluefruit.ScanResponse.addName();
    Bluefruit.Advertising.restartOnDisconnect(true);
    Bluefruit.Advertising.setInterval(160, 1600);
    Bluefruit.Advertising.setFastTimeout(30);
    Bluefruit.Advertising.start(0);
    leds(false, true, false);
}

/** 按键消抖、持久录音及补传共用主循环，录音优先于 BLE 发送 */
void loop() {
    diagnostics();
    if (fault) { delay(100); return; }
    if (testingUntil) { delay(1); return; }
    if (commandOverflow) { fail(); return; }
    if (clockEpoch && uint32_t(millis() - clockMillis) >= 86400000) clockEpoch = 0;
    const bool pressed = digitalRead(D0) == BUTTON_ACTIVE;
    if (pressed != rawPressed) { rawPressed = pressed; lastButtonChange = millis(); }
    if (millis() - lastButtonChange >= 30 && wasPressed != pressed) {
        wasPressed = pressed;
        if (pressed) startRecording();
        else finishRecording();
    }
    if (recording >= 0 && (drain() || overflowed)) finishRecording();
    if (fault) return;
    processCommand();
    if (fault) return;
    // 录音时不执行耗时的擦除和无线补传，避免 flash 阻塞导致采样丢失
    if (recording < 0) {
        transfer();
        for (int i = 0; i < 2; ++i) if (!storage.prepare(i)) { fail(); return; }
        const bool full = storage.slots[0].valid && storage.slots[1].valid;
        leds(full, !full && !transferring, transferring);
    }
    delay(1);
}
