# Selfcraft Pocket：XIAO Sense → iPhone → Runtime

首版固件针对 **Seeed Studio XIAO nRF52840 Sense**，配合 iOS「设置 → 随身记录」。按住外部按键采集板载麦克风，松开保存，手机通过 BLE 接收后上传到配对时绑定的 Runtime。Web 和 iPhone 使用同一条语音消息及转录文字。

## 接线

先断开 USB。将焊好排针的 XIAO 跨面包板中间沟槽插入，确保两侧引脚不被同一组铜片短接。三针按键模块按**实际丝印**接线，不凭朝向判断：

| 按键模块 | XIAO |
| --- | --- |
| `-` / `GND` | `GND` |
| `+` / `VCC`（此款模块中间脚） | `3V3` |
| `S` / `OUT` | `D0` / `A0` |

固件默认 `BUTTON_ACTIVE = LOW`，同时启用内部上拉，对应实测 HW-483 模块：松开为 1、按下为 0、再次松开为 1。早期按商品说明使用的高有效和内部下拉配置会干扰该模块松开后的读数，已修正。不要把模块接到 `5V`。两线常开裸按键也可连接 `D0` 和 `GND`，沿用低有效配置；更换模块应重新确认实际触发电平。

原型先由 USB 供电。本次未接电池、未做续航测量或待机功耗优化；断开 USB 且没有电池时无法录音。

## 编译与刷机

依赖官方 Arduino CLI、**Seeed nRF52 Boards 1.1.10**，并非 mbed 版本。PDM、Bluefruit、SPIFlash 均来自固定版本的板卡包，不需要另装同名库。

```sh
arduino-cli core update-index --additional-urls https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json
arduino-cli core install Seeeduino:nrf52@1.1.10 --additional-urls https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json
arduino-cli compile --fqbn Seeeduino:nrf52:xiaonRF52840Sense --build-path /tmp/selfcraft-pocket-build hardware/selfcraft-pocket
arduino-cli board list
arduino-cli upload --fqbn Seeeduino:nrf52:xiaonRF52840Sense --port /dev/cu.usbmodemXXXX --input-dir /tmp/selfcraft-pocket-build
```

macOS 板卡包若报 `adafruit-nrfutil: permission denied`，对该包 `tools/adafruit-nrfutil/macos/adafruit-nrfutil` 执行 `chmod u+x`。旧版工具依赖 Python/Rosetta，请以构建日志中的真实错误处理。

若自动复位未进入下载模式：USB-C 朝上时，快速双击接口左侧 `RST` 附近的微型 Reset 按钮，再重新 `board list` 使用新的端口上传。必须看到 DFU 成功信息；旧版上传工具可能在报错后仍返回退出码 0。

**固件使用全部 2MB 外部 Flash 保存录音，初次启动会擦除空闲槽。刷机前应备份其他程序在外部 Flash 中的数据。** 后续重刷此协议固件会恢复未确认录音，不清空它们。

## 配对与使用

1. 打开 USB 串口监视器，115200 baud
2. iPhone 打开 Selfcraft，连接目标 Runtime，进入「设置 → 随身记录 → 寻找设备」
3. 选择 `Selfcraft Pocket XXXX`，在 iOS 配对框中输入串口显示的六位配对码
4. 以后使用系统保存的蓝牙绑定密钥重连，无需 USB；协议特征要求加密和 MITM 保护
5. 按住外部按键说话，松开保存。超时自动结束，必须松开后才能开始下一条

| 灯光 | 含义 |
| --- | --- |
| 绿色 | 可以开始录音；不代表 Runtime 已收到 |
| 红色，按键按住时 | 正在录音 |
| 红色，松开后仍亮 | 两个存储槽都在等待补传，不能继续录音 |
| 蓝色 | 初始化或补传 |
| 红蓝同时亮 | 存储或采集异常，停止写入并保留已提交内容 |

USB 命令 `s` 打印 Flash 容量、待传数量、按键电平和错误状态；`t` 做一秒麦克风电平检查，仅打印样本数与峰值，不保存或上传诊断音频。诊断时不响应外部录音按键。

USB 命令 `b` 在未录音、未做麦克风自检且无故障时，临时对比 D0 的 `pulldown / no_pull / pullup` 三种输入设置，并立即恢复固件原配置。分别在松开、按住、松开时执行，用于区分模块输出与内部偏置的影响；`no_pull` 在信号悬空时不具备确定含义。诊断本身不启动录音、不清空存储，也不会持久改变触发电平。不能仅凭类似模块的商品说明判定实际电路。

## 容量与恢复边界

- 16kHz 单声道，固件以 G.711 μ-law 存储和传输，手机还原为 16bit PCM WAV；这是有损语音压缩
- 两个槽，每条最多 60 秒。容量满时拒绝覆盖旧录音；本版不会把多个短录音装进同一个槽
- 每块最多 4080 音频字节，内容和 CRC 写完后才提交。掉电恢复已提交块，尚在 RAM 中的尾部无法保证保留；恢复片段标记为中断
- 手机每 64KiB 保存续传检查点，断连可以重复读取尾部。完整长度与 CRC 匹配后，先原子保存 WAV，再保存收件箱，最后发送设备 ACK
- 手机收到不等于 Runtime 收到。Runtime 回执确认并在本地落盘后，才删除手机 WAV；保留录音 ID，防止设备 ACK 丢失后的重复提交
- 待发送录音可以左滑移除本地原音并停止后续发送，仍保留去重标识。如果此前已上传转写，服务端副本不会因此自动删除
- App 沿用五分钟自动补发窗口。未知时间、掉电片段和旧录音必须试听/确认后发送，避免陈旧语音指令自动执行
- 设备从手机同步时间，重启或同步超过 24 小时后时间视为未知，不用补传时间伪装采集时间
- 配对固定 `connectionID + instanceID`。切换 App 的开发连接不会迁移录音；删除原连接后录音仍保留，需恢复同一连接或人工处理
- 使用 CoreBluetooth 后台模式和状态恢复；这不保证 iOS 随时运行网络转写。系统暂停或用户强制退出时依靠设备存储，重新打开后继续
- 本版未接 AccessorySetupKit，不声明支持 iOS 26 对该框架提供的强制退出重启特例

## BLE v1

UUID 前缀均为 `86B6xxxx-4BCE-4D19-AC2B-2D478FD5A100`：服务 `0001`，清单 `0002`（read/notify），控制 `0003`（write with response），音频 `0004`（notify）。整数均为 little-endian。

清单 32 字节：`version:u8=1, flags:u8, recordingID:16bytes, epoch:u32, encodedLength:u32, crc32:u32, pendingCount:u8, reserved:u8`。flags bit0 为中断；epoch 0 表示时间未知。pendingCount 0 表示空队列。清单通知使用单字节提示，客户端重新执行长读。

控制命令：

- `01 + epoch:u32`：校时并发布当前清单
- `02 + offset:u32`：从逻辑音频偏移续传当前清单的录音
- `03 + recordingID:16bytes`：仅在手机持久接收后确认该录音，固件只删除 ID 匹配的槽

音频通知：`offset:u32 + μ-law bytes`，总长度不超过协商 ATT MTU 减 3。队列满时固件不推进游标。录音优先，采样时暂停无线补传及擦除。

## 验证

```sh
clang++ -std=c++11 -Wall -Wextra -Werror hardware/tests/pocket-storage-test.cpp -o /tmp/selfcraft-pocket-storage-test
/tmp/selfcraft-pocket-storage-test
```

iOS `PocketTests` 覆盖固定协议向量、WAV 解码、检查点恢复、ACK 丢失去重、跨实例冲突、乱序/损坏拒绝、落盘失败和旧意图确认。

对明确授权的测试 Runtime，可运行以下真实接口验收。测试录音会上传、调用转写供应商并进入对话，需使用专用测试录音：

```sh
SELFCRAFT_TEST_AUDIO=/path/to/test.wav SELFCRAFT_RUNTIME_URL=http://127.0.0.1:3210 bun hardware/runtime-smoke.ts
```

凭证从该测试实例 `ConfigStore` 读取，或使用 `SELFCRAFT_ACCESS_TOKEN` 环境变量，不写入脚本。

物理验收顺序：串口状态 → 麦克风电平 → 按键高低电平 → 首次配对 → 短录音/试听 → Web 同步 → BLE 断开/补传 → App 重启 → 设备重启恢复 → 两槽满保护 → 锁屏/后台。编译和模拟器测试不能替代这些检查。

官方参考：[XIAO Sense 硬件与复位](https://wiki.seeedstudio.com/XIAO_BLE/)、[PDM 麦克风](https://wiki.seeedstudio.com/XIAO-BLE-Sense-PDM-Usage/)、[Apple 蓝牙恢复边界](https://developer.apple.com/documentation/technotes/tn3115-bluetooth-state-restoration-app-relaunch-rules)。

## 2026-10-03 已完成验收

- Seeed nRF52 1.1.10 实际编译成功，已通过 USB DFU 刷入用户的 Sense 主板；最初自动下载未进入 DFU，经双击 RST 后完成
- 真机发现 SPIFlash 默认器件表不包含 Puya，显式传入 [P25Q16H 参数](https://files.seeedstudio.com/wiki/github_weiruanexample/Flash_P25Q16H-UXH-IR_Datasheet.pdf) 后复测：`flash=2097152; jedec=856015; pending=0; button=0; fault=0`
- 板载麦克风一秒电平自检：`samples=16384; peak=8145`，只验证采集可运行，未保存诊断音频，不代表语音清晰度验收
- 主机存储测试通过：编码向量、分块写入掉电、重启恢复、ACK、跨块读取、两槽 60 秒满容量及防覆盖
- 本地容器 `typecheck / bun test / doctor / smoke:evolution / smoke:provider` 全部通过，213 项测试通过。宿主机沙盒禁止监听临时端口的失败在容器中复核通过
- 真实多端 `smoke:mobile` 通过；合成中文语音 6.953 秒完成重复上传、真实转写、重复会话提交，Web/iOS 历史中只有一条语音消息，助理回复「记录成功」
- iPhone Debug 签名构建成功，23 项 iOS 测试通过；模拟器完成「设置 → 随身记录」导航和不支持蓝牙状态检查
- 接线后最终固件再次 DFU 成功，串口 `fault=0`；读到 `pending=1; button=1`，尚需确认松手后的电平，不能据此判定按键验收通过
- iPhone 首次安装中途断连，`devicectl` 报 `IXRemoteErrorDomain code 6`，随后设备变为 unavailable；App 安装与实机启动尚未确认
- 外部按键、iPhone 实机 BLE 配对/传输/补传、锁屏及后台恢复仍待接线后的实机验收。续航、电池、APNs 不在以上通过结论内

## 2026-10-04 按键输入排查

- 用户完成 `D0 → 3V3` 直连测试，串口读到 `button=1`
- 诊断固件成功刷入；用户按松开、按住、松开的顺序执行 `b`，三组 `pulldown / no_pull / pullup` 结果分别为 `1/1/1`、`0/0/0`、`0/1/1`
- 实测支持低有效和内部上拉配置，修正 `BUTTON_ACTIVE = LOW`；原内部下拉不能可靠恢复松开读数
- 修正固件编译及 USB DFU 成功；刷入后串口两次返回 `pending=2; button=1; fault=0`，原录音保留。存储保护测试、容器规定检查及 213 项 Runtime 测试通过
- 用户在修正固件上按松开、按住、松开执行 `s`，确认 `button=1 → 0 → 1`，三次均为 `fault=0`，按键电平验收通过
- 两条已有录音保留，`pending=2` 仍会阻止新增录音；需通过 App 持久接收并 ACK 后释放槽位，录音、BLE 链路仍需复测
- 新版 App 已通过 `devicectl` 安装到用户 iPhone；本地签名验证通过，用户在系统中信任开发者后确认成功打开
- 经用户明确授权，仅本次联调临时转发 Mac 局域网 `192.168.88.61:3211` 到 `127.0.0.1:3210`；未认证请求返回 401，未修改 Docker 的监听配置。联调结束需停止临时转发进程
- 用户确认 BLE 配对成功、两条旧录音已接收到手机；按住说话产生的新录音成功送到 Runtime。截图中两条 60 秒旧录音仍待手动确认，不等于已提交到对话
- 修复待确认录音每 15 秒触发忙碌提示的问题：调度前筛选可发送项，持久记录提交未确认状态以保留回执恢复能力，旧格式仅先核对回执。26 项 iOS 测试、213 项 Runtime 测试及规定检查通过，新版已安装并启动在用户 iPhone

- 用户确认忙碌提示不再闪烁；后续 App 重启发现蓝牙恢复停滞，真机日志定位为 `willRestoreState` 早于 `poweredOn` 时过早发现服务。修正恢复顺序、已有订阅恢复、验证超时及手动重连后，真机同一路径正常到达设备已连接；26 项 iOS 测试及容器规定检查通过
