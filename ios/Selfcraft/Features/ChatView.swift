import SwiftUI
import PhotosUI

/** 持续对话与原生输入栏，输入和计时变化不订阅到消息列表 */
struct ChatView: View {
    let session: ConversationSession
    let audio: AudioController
    let obscured: Bool
    let openOverview: () -> Void
    let openNotifications: () -> Void

    var body: some View {
        ConversationTimeline(session: session, audio: audio)
            .background(Color.surface)
            .navigationTitle("Selfcraft")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(action: openOverview) {
                        Image(systemName: "sidebar.left").frame(width: 44, height: 44)
                    }.accessibilityLabel("近况与功能").accessibilityHint("查看事项、记忆和设置")
                        .accessibilityIdentifier("openOverview")
                }
                ToolbarItem(placement: .principal) {
                    Image("Cloud").resizable().scaledToFit().frame(width: 32, height: 32)
                        .clipShape(.rect(cornerRadius: 10))
                        .accessibilityLabel("Selfcraft").accessibilityAddTraits(.isHeader)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    NotificationButton(api: session.api, obscured: obscured, open: openNotifications)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { MessageComposer(session: session, audio: audio, obscured: obscured) }
    }
}

/** 未读提示独立刷新，离开前台或打开面板后停止查询 */
private struct NotificationButton: View {
    let api: RuntimeAPI
    let obscured: Bool
    let open: () -> Void
    @Environment(\.scenePhase) private var scenePhase
    @State private var unread: Int?

    var body: some View {
        Button(action: open) {
            Image(systemName: "bell").frame(width: 44, height: 44)
                .overlay(alignment: .topTrailing) {
                    if let unread, unread > 0 {
                        Circle().fill(Color.accentColor).frame(width: 7, height: 7).padding(8)
                    }
                }
        }.accessibilityLabel("通知")
            .accessibilityValue(unread.map { "\($0) 条未读" } ?? "")
            .task(id: scenePhase == .active && !obscured) {
                guard scenePhase == .active && !obscured else { return }
                while !Task.isCancelled {
                    do {
                        let page: JSONValue = try await api.get("/api/notifications")
                        try Task.checkCancellation()
                        unread = page["items"].array.count
                    } catch { if Task.isCancelled { return } }
                    do { try await Task.sleep(for: .seconds(30)) } catch { return }
                }
            }
    }
}

/** 系统列表按需复用消息行，长消息定位交给原生滚动容器 */
private struct ConversationTimeline: View {
    let session: ConversationSession
    let audio: AudioController
    @State private var followsTail = true
    @State private var nearBottom = true
    @State private var followTask: Task<Void, Never>?
    @State private var scrollIdle = true

    var body: some View {
        ScrollViewReader { proxy in
            List {
                if session.nextCursor != nil {
                    Button("加载更早的消息") {
                        let anchor = session.messages.first?.id
                        followsTail = false
                        Task {
                            await session.loadEarlier()
                            await Task.yield()
                            if let anchor { proxy.scrollTo(anchor, anchor: .top) }
                        }
                    }.disabled(session.loadingHistory).frame(maxWidth: .infinity)
                        .listRowSeparator(.hidden).listRowBackground(Color.clear)
                }
                if session.messages.isEmpty {
                    VStack(spacing: 16) {
                        Image("Cloud").resizable().scaledToFit().frame(width: 80, height: 80)
                        Text("从这一刻开始").font(.title2).fontDesign(.serif)
                        Text("说说今天，或交给我一件事。").foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity).padding(.vertical, 64)
                        .listRowSeparator(.hidden).listRowBackground(Color.clear)
                }
                ForEach(session.messages) { item in
                    MessageEntry(item: item, api: session.api, audio: audio).id(item.id)
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { _, _ in
                            if item.id == session.messages.last?.id { scheduleFollow(proxy) }
                        }
                        .listRowInsets(EdgeInsets(top: 12, leading: 20, bottom: 12, trailing: 20))
                        .listRowSeparator(.hidden).listRowBackground(Color.clear)
                }
                PendingMessages(session: session, audio: audio)
                    .listRowSeparator(.hidden).listRowBackground(Color.clear)
                Color.clear.frame(height: 1).id("bottom")
                    .listRowSeparator(.hidden).listRowBackground(Color.clear)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentSize.height - geometry.visibleRect.maxY < 100
            } action: { _, value in nearBottom = value }
            .onScrollPhaseChange { _, phase in
                scrollIdle = phase == .idle
                if phase == .tracking || phase == .interacting || phase == .decelerating {
                    followsTail = false
                    followTask?.cancel()
                    followTask = nil
                    session.readingHistory = true
                }
                if phase == .idle && nearBottom && !session.hasNewerMessages {
                    followsTail = true
                    session.readingHistory = false
                }
            }
            .task { proxy.scrollTo("bottom", anchor: .bottom) }
            .onChange(of: session.messages.last?.id) { _, _ in scheduleFollow(proxy) }
            .onChange(of: session.state.pending.count) { _, _ in scheduleFollow(proxy) }
            .onDisappear { followTask?.cancel(); followTask = nil }
            .overlay(alignment: .bottomTrailing) {
                if session.hasNewerMessages {
                    Button("回到最新消息", systemImage: "arrow.down") {
                        Task {
                            await session.loadLatest()
                            followsTail = true
                            await Task.yield()
                            proxy.scrollTo("bottom", anchor: .bottom)
                        }
                    }.buttonStyle(.borderedProminent).padding(12)
                }
            }
        }
    }

    /** 仅尾部内容增长时合并定位请求，触摸与惯性滚动期间保持用户的阅读位置 */
    private func scheduleFollow(_ proxy: ScrollViewProxy) {
        guard followsTail, scrollIdle, followTask == nil else { return }
        followTask = Task { @MainActor in
            do { try await Task.sleep(for: .milliseconds(60)) } catch { return }
            if followsTail && scrollIdle { proxy.scrollTo("bottom", anchor: .bottom) }
            followTask = nil
        }
    }
}

/** 只有对应消息值改变时重新提交该行 */
private struct MessageEntry: View {
    let item: MessageItem
    let api: RuntimeAPI
    let audio: AudioController
    var body: some View { MessageRow(message: item.value, api: api, audio: audio, markdown: item.markdown) }
}

/** 草稿与录音计时限定在输入区域 */
private struct MessageComposer: View {
    @Bindable var session: ConversationSession
    @Bindable var audio: AudioController
    let obscured: Bool
    @State private var voiceMode = false
    @FocusState private var inputFocused: Bool
    @State private var photo: PhotosPickerItem?
    @State private var uploading = false
    @State private var gestureStarted = false
    @State private var cancelling = false

    var body: some View {
        VStack(spacing: 10) {
            if let error = session.error { Text(error).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
            if let files = session.state.draftFiles, !files.isEmpty {
                HStack { Text("已添加 \(files.count) 张图片").font(.caption); Spacer(); Button("移除") { session.state.draftFiles = nil; session.persist() } }
            }
            if !session.streamingIDs.isEmpty {
                Button("停止当前回复", systemImage: "stop.circle") {
                    Task { do { let _: JSONValue = try await session.api.get("/api/conversation/stop", method: "POST", body: .object([:])) } catch { session.error = error.localizedDescription } }
                }.font(.caption)
            }
            HStack(alignment: .bottom, spacing: 4) {
                Button(voiceMode ? "切换到文字输入" : "切换到语音输入", systemImage: voiceMode ? "keyboard" : "mic") {
                    // 同时取消尚在等待麦克风权限的启动请求，避免切换后迟到录音
                    audio.stop(draft: true)
                    voiceMode.toggle()
                    inputFocused = !voiceMode
                }.labelStyle(.iconOnly).frame(width: 44, height: 44)
                    .disabled(audio.recording).accessibilityIdentifier("toggleInputMode")
                if voiceMode {
                    voiceInput
                } else {
                    TextField("说点什么…", text: $session.state.draft, axis: .vertical)
                        .lineLimit(1...6).padding(.horizontal, 12).padding(.vertical, 12)
                        .background(Color.secondary.opacity(0.07), in: .rect(cornerRadius: 20))
                        .focused($inputFocused).accessibilityIdentifier("messageInput")
                        .onChange(of: session.state.draft) { _, _ in session.scheduleDraftSave() }
                    if !session.state.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !(session.state.draftFiles ?? []).isEmpty {
                        Button("发送", systemImage: "arrow.up.circle.fill") {
                            session.enqueue(text: session.state.draft, files: session.state.draftFiles ?? [], clearComposer: true)
                        }.labelStyle(.iconOnly).font(.title).frame(minWidth: 44, minHeight: 44)
                            .disabled(uploading).accessibilityIdentifier("sendMessage")
                    }
                }
                PhotosPicker(selection: $photo, matching: .images) {
                    Image(systemName: "plus").frame(width: 44, height: 44)
                }.disabled(uploading || (session.state.draftFiles?.count ?? 0) >= 4 || audio.recording)
                    .accessibilityLabel("添加图片")
                    .onChange(of: photo) { _, value in
                        if value != nil { voiceMode = false }
                    }
            }
        }.padding(.horizontal, 16).padding(.vertical, 10).background(.bar)
            .onChange(of: obscured) { _, value in
                if value { inputFocused = false; gestureStarted = false; cancelling = false }
            }
            .onDisappear { audio.stop(draft: true) }
            .task(id: photo) {
                guard let item = photo else { return }
                uploading = true
                defer { uploading = false; photo = nil }
                do {
                    guard let data = try await item.loadTransferable(type: Data.self) else { throw RuntimeError(message: "无法读取图片") }
                    let jpeg = try await ImageLoader.uploadJPEG(data)
                    let file = try await session.api.uploadImage(jpeg)
                    try Task.checkCancellation()
                    session.state.draftFiles = (session.state.draftFiles ?? []) + [file]
                    session.persist()
                } catch { if !Task.isCancelled { session.error = error.localizedDescription } }
            }
    }

    private var voiceInput: some View {
        Text(cancelling ? "松开取消" : audio.recording ? "\(Int(audio.elapsed)) 秒 · 上滑取消" : "按住说话")
            .font(.subheadline.weight(.medium)).monospacedDigit()
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(cancelling ? Color.red.opacity(0.12) : Color.accentColor.opacity(0.08), in: .capsule)
            .contentShape(.capsule)
            .gesture(DragGesture(minimumDistance: 0).onChanged { value in
                cancelling = value.translation.height < -60
                if !gestureStarted {
                    gestureStarted = true
                    Task {
                        guard gestureStarted && voiceMode && !obscured else { return }
                        await startRecording()
                    }
                }
            }.onEnded { _ in
                audio.stop(draft: false, cancel: cancelling)
                gestureStarted = false
                cancelling = false
            })
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(audio.recording ? "结束录音并发送" : "开始录音")
            .accessibilityValue(audio.recording ? "\(Int(audio.elapsed)) 秒" : "")
            .accessibilityHint("双击开始，再次双击结束并发送；也可使用取消录音操作")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction {
                if audio.recording { audio.stop(draft: false) }
                else { Task { await startRecording() } }
            }
            .accessibilityAction(named: "取消录音") { audio.stop(draft: false, cancel: true) }
            .accessibilityIdentifier("voiceInput")
    }

    /** 启动当前实例录音，回调保存到同一实例队列 */
    private func startRecording() async {
        guard voiceMode && !obscured else { return }
        await audio.start(directory: session.local.directory) { name, draft, capturedAt in
            session.enqueue(text: "", audio: name, confirmation: draft, capturedAt: capturedAt)
        }
    }
}

/** 待发送队列独立于历史列表和流式文本 */
private struct PendingMessages: View {
    let session: ConversationSession
    let audio: AudioController
    var body: some View { ForEach(session.state.pending) { item in pendingRow(item) } }

    /** 显示尚未取得持久回执的语音或文字，允许显式确认过期输入 */
    private func pendingRow(_ item: OutgoingMessage) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(item.audioFilename == nil ? item.text : "语音消息", systemImage: item.audioFilename == nil ? "text.bubble" : "waveform")
            if let filename = item.audioFilename {
                Button("试听") {
                    if audio.togglePlayback(id: item.id) { return }
                    let url = session.local.directory.appendingPathComponent(filename)
                    Task {
                        do { try audio.play(data: await Task.detached { try Data(contentsOf: url) }.value, id: item.id) }
                        catch { session.error = error.localizedDescription }
                    }
                }
            }
            if session.sending.contains(item.id) { ProgressView(item.audioFilename == nil ? "正在发送" : "正在上传或转写") }
            else {
                Text(item.error ?? (item.requiresConfirmation ? "录音已保留，确认后发送" : "等待连接，超过五分钟需确认发送"))
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("发送") { Task { await session.deliver(item, force: true) } }
                    Button("删除", role: .destructive) { Task { await session.discard(item) } }
                }
            }
        }.padding(16).background(Color.secondary.opacity(0.07), in: .rect(cornerRadius: 18)).frame(maxWidth: .infinity, alignment: .trailing)
    }
}

/** 单条消息独立渲染，原音播放不会触发其他消息网络请求 */
struct MessageRow: View {
    let message: ChatMessage
    let api: RuntimeAPI
    let audio: AudioController
    let markdown: MessageMarkdownRenderer
    @State private var failure: String?
    @State private var deleting = false
    @State private var detail: MessageDetails.Page?

    var body: some View {
        let presentation = MessagePresentation(parts: message.parts)
        HStack {
            if message.role == "user" { Spacer(minLength: 32) }
            VStack(alignment: .leading, spacing: 10) {
                if let original = message.metadata?.audio {
                    if original.deleted { Label("原始录音已删除", systemImage: "waveform.slash").font(.caption) }
                    else {
                        VoicePlayback(original: original, api: api, audio: audio)
                    }
                }
                ForEach(Array(message.parts.enumerated()), id: \.offset) { _, part in
                    if part["type"].string == "file", part["mediaType"].string.hasPrefix("image/") {
                        AuthenticatedImage(api: api, path: part["url"].string)
                    }
                }
                if message.role == "assistant", !presentation.activities.isEmpty {
                    MessageActivitySummary(presentation: presentation, streaming: message.isStreaming,
                                           failed: message.metadata?.state == "failed", hasText: !message.text.isEmpty) { detail = .activity }
                }
                if !message.text.isEmpty { MessageText(text: message.text, streaming: message.isStreaming, sharedRenderer: markdown).equatable() }
                if message.isStreaming && presentation.activities.isEmpty {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.mini)
                        Text(message.text.isEmpty ? "正在思考" : "正在回复").font(.caption).foregroundStyle(.secondary)
                    }.frame(minHeight: 32)
                }
                if message.metadata?.state == "failed" {
                    Label("回复中断，可补充要求后继续", systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(.secondary)
                }
                if message.role == "assistant", !presentation.sources.isEmpty {
                    MessageSourcesSummary(presentation: presentation) { detail = .sources }
                }
                if let failure { Text(failure).font(.caption).foregroundStyle(.red) }
            }
            .padding(message.role == "user" ? 16 : 0)
            .background(message.role == "user" ? Color.accentColor.opacity(0.07) : .clear, in: .rect(cornerRadius: 20))
            .contextMenu {
                if !message.text.isEmpty {
                    Button("复制文字", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.text }
                    if message.role == "assistant" {
                        Button(audio.speakingMessageID == message.id ? "停止朗读" : "朗读", systemImage: audio.speakingMessageID == message.id ? "stop.circle" : "speaker.wave.2") {
                            audio.speak(message.text, id: message.id)
                        }.disabled(audio.recording)
                    }
                }
                if message.metadata?.audio?.deleted == false { Button("删除原始录音", role: .destructive) { deleting = true } }
            }
            .accessibilityActions {
                if !message.text.isEmpty {
                    Button("复制文字") { UIPasteboard.general.string = message.text }
                    if message.role == "assistant" {
                        Button(audio.speakingMessageID == message.id ? "停止朗读" : "朗读") { audio.speak(message.text, id: message.id) }
                            .disabled(audio.recording)
                    }
                }
            }
            if message.role != "user" { Spacer(minLength: 8) }
        }
        .sheet(item: $detail) { page in
            MessageDetails(page: page, presentation: presentation, streaming: message.isStreaming)
        }
        .confirmationDialog("删除原始录音？转录文字会保留。", isPresented: $deleting, titleVisibility: .visible) {
            Button("删除录音", role: .destructive) {
                guard let id = message.metadata?.audio?.id else { return }
                Task { do { let _: JSONValue = try await api.get("/api/audio/\(id)", method: "DELETE", body: .object([:])) } catch { failure = error.localizedDescription } }
            }
        }
    }
}

/** 通过同实例鉴权获取图片，不将令牌放入 URL */
struct AuthenticatedImage: View {
    let api: RuntimeAPI
    let path: String
    @State private var image: UIImage?
    @State private var failed = false
    var body: some View {
        Group {
            if let image { Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 260).clipShape(.rect(cornerRadius: 12)) }
            else if failed { Label("图片暂不可用", systemImage: "photo") }
            else { ProgressView() }
        }.task(id: path) {
            do { image = try await ImageLoader.shared.image(api: api, path: path) }
            catch { if !Task.isCancelled { failed = true } }
        }
    }
}


/** 播放进度只刷新语音控件，暂停和继续复用已加载的播放器 */
private struct VoicePlayback: View {
    let original: ChatMessage.Audio
    let api: RuntimeAPI
    @Bindable var audio: AudioController
    @State private var loading = false
    @State private var playbackTask: Task<Void, Never>?
    @State private var failure: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                if audio.togglePlayback(id: original.id) { return }
                loading = true
                playbackTask = Task {
                    defer { loading = false }
                    do {
                        let data = try await api.send(api.request(original.url))
                        try Task.checkCancellation()
                        try audio.play(data: data, id: original.id)
                        failure = nil
                    } catch { if !Task.isCancelled { failure = error.localizedDescription } }
                }
            } label: {
                HStack(spacing: 14) {
                    if loading { ProgressView() }
                    else { Image(systemName: audio.playbackId == original.id && audio.isPlaying ? "pause.circle.fill" : "play.circle.fill").font(.title2) }
                    Image(systemName: "waveform").font(.title2).frame(maxWidth: .infinity)
                    Text("\(Int(original.duration))秒").monospacedDigit()
                }.padding(.vertical, 6)
            }.disabled(loading).buttonStyle(.borderless).foregroundStyle(.tint).accessibilityLabel("播放或暂停原始录音")
            if audio.playbackId == original.id { ProgressView(value: audio.playbackProgress) }
            if let failure { Text(failure).font(.caption).foregroundStyle(.red) }
        }.onDisappear { playbackTask?.cancel() }
    }
}
