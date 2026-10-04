import SwiftUI

/** 随身录音的连接状态与待发送收件箱；不把蓝牙协议细节放进日常对话 */
struct PocketView: View {
    @Bindable var relay: PocketRelay
    let directory: ConnectionDirectory
    @State private var audio = AudioController()
    @State private var confirming: PocketRecording?
    @State private var discarding: PocketRecording?
    @State private var forgetting = false

    var body: some View {
        List {
            Section {
                Label(relay.status, systemImage: "waveform.badge.mic")
                if let progress = relay.progress { ProgressView(value: progress).accessibilityLabel("录音接收进度") }
                if relay.busy { ProgressView("正在处理待发送录音") }
                if let binding = relay.binding {
                    LabeledContent("录音送往", value: directory.connection(for: binding)?.name ?? "原连接已移除")
                    Button("重新连接") { relay.reconnect(force: true) }
                    Button("解除设备关联", role: .destructive) { forgetting = true }
                } else {
                    Button(relay.scanning ? "正在寻找…" : "寻找设备") { relay.scan() }.disabled(relay.scanning)
                    ForEach(relay.devices, id: \.identifier) { device in
                        Button {
                            if let connection = directory.selected { relay.pair(device, to: connection) }
                        } label: {
                            VStack(alignment: .leading) {
                                Text(device.name ?? "Selfcraft Pocket")
                                Text(device.identifier.uuidString.suffix(8)).font(.caption).foregroundStyle(.secondary)
                            }
                        }.disabled(directory.selected == nil)
                    }
                }
            } footer: {
                Text("按住按键录音，松开保存。设备离线时先保存原音，连接后补传。首次连接需输入设备通过 USB 串口显示的配对码。")
            }
            Section("待发送") {
                let pending = relay.records.filter { !$0.sent && $0.discarded != true }
                if pending.isEmpty { Text("暂时没有待发送录音").foregroundStyle(.secondary) }
                ForEach(pending.reversed()) { item in
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Image(systemName: "waveform")
                            Text("\(Double(item.manifest.count) / 16_000, specifier: "%.1f") 秒")
                            Spacer()
                            Text(item.capturedAt, style: .time).foregroundStyle(.secondary)
                        }
                        Text(directory.connection(for: item.binding)?.name ?? "原连接已移除，请恢复同一助理连接后发送")
                            .font(.caption).foregroundStyle(.secondary)
                        if item.manifest.capturedAt == nil { Text("采集时间未知，显示的是接收时间").font(.caption).foregroundStyle(.secondary) }
                        if item.manifest.interrupted { Text("录音曾中断，请试听后确认").font(.caption).foregroundStyle(.secondary) }
                        if let error = item.error { Text(error).font(.caption).foregroundStyle(.red) }
                        HStack {
                            Button(audio.playbackId == item.id && audio.isPlaying ? "暂停" : "试听", systemImage: "play.circle") {
                                Task {
                                    do {
                                        if !audio.togglePlayback(id: item.id) { try audio.play(data: await relay.inbox.audio(item), id: item.id) }
                                    } catch { relay.error = error.localizedDescription }
                                }
                            }
                            Spacer()
                            if relay.sendingID == item.id { ProgressView("正在发送") }
                            else { Button("发送到对话") { confirming = item }.disabled(relay.busy) }
                        }.buttonStyle(.borderless)
                    }.padding(.vertical, 6)
                        .swipeActions { Button("丢弃", role: .destructive) { discarding = item }.disabled(relay.busy) }
                }
            }
            if relay.records.contains(where: \.sent) {
                Section { Text("已送达 \(relay.records.filter(\.sent).count) 条录音，可在对话中查看和播放").foregroundStyle(.secondary) }
            }
            Section {
                Text("超过五分钟、时间不明或中断的录音需要确认后发送。App 被强制退出时，设备仍可保存录音，重新打开 App 后补传。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if let error = relay.error { Section { Text(error).foregroundStyle(.red) } }
        }
        .navigationTitle("随身记录")
        .task { await relay.refresh() }
        .onDisappear { audio.stopPlayback() }
        .confirmationDialog("解除关联后不会删除已收到的录音", isPresented: $forgetting, titleVisibility: .visible) {
            Button("解除关联", role: .destructive) { relay.forget() }
        }
        .confirmationDialog("将这条录音发送到原绑定的助理对话？助理会根据内容继续回复或执行任务。", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), titleVisibility: .visible) {
            if let item = confirming { Button("确认发送") { relay.flush(confirm: item.id); confirming = nil } }
        }
        .confirmationDialog("不再发送并移除手机上的原音？若此前已上传转写，服务端副本会保留。", isPresented: Binding(get: { discarding != nil }, set: { if !$0 { discarding = nil } }), titleVisibility: .visible) {
            if let item = discarding { Button("移除本地录音", role: .destructive) { Task { await relay.discard(item) }; discarding = nil } }
        }
    }
}
