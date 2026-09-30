import SwiftUI

/** 云朵入口展示真实近况，详情在同一面板中展开，对话保持原位置 */
struct OverviewSheet: View {
    let session: ConversationSession
    let directory: ConnectionDirectory
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var path: [Destination] = []
    @State private var works: [JSONValue] = []
    @State private var memory: JSONValue?
    @State private var worksError: String?
    @State private var memoryError: String?
    @State private var loading = true

    private enum Destination: Hashable {
        case works, memories, settings
        case work(JSONValue), memory(JSONValue)
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    if dynamicTypeSize.isAccessibilitySize {
                        VStack(alignment: .leading, spacing: 12) { identity; settingsButton }
                    } else {
                        HStack(spacing: 12) { identity; Spacer(); settingsButton }
                    }
                }
                if loading { ProgressView("正在读取近况") }
                if !works.isEmpty {
                    Section("正在推进") {
                        ForEach(works, id: \.id) { item in
                            NavigationLink(value: Destination.work(item)) {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(item["goal"].string).lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                                    if !item["next"].string.isEmpty {
                                        Text(item["next"].string).font(.caption).foregroundStyle(.secondary).lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                                    }
                                }
                            }
                        }
                    }
                }
                if let memory {
                    Section("此刻的认识") {
                        NavigationLink(value: Destination.memory(memory)) {
                            Text(memory["content"].string).lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 3)
                        }
                    }
                }
                Section {
                    NavigationLink(value: Destination.works) { Label("全部事项", systemImage: "checklist") }
                    NavigationLink(value: Destination.memories) { Label("全部记忆", systemImage: "water.waves") }
                }
                if worksError != nil || memoryError != nil {
                    Section {
                        if let worksError { Text(worksError).font(.caption).foregroundStyle(.secondary) }
                        if let memoryError { Text(memoryError).font(.caption).foregroundStyle(.secondary) }
                        Button("重新读取近况") { Task { await load() } }
                    }
                }
            }
            .scrollContentBackground(.hidden).background(Color.surface)
            .navigationTitle("近况").navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: Destination.self) { destination in
                Group {
                    switch destination {
                    case .works: WorksView(session: session)
                    case .memories: MemoriesView(api: session.api)
                    case .settings: SettingsView(session: session, directory: directory)
                    case .work(let item): WorkDetail(session: session, item: item)
                    case .memory(let item): MemoryDetail(api: session.api, item: item)
                    }
                }.toolbar { closeToolbar }
            }
            .task { await load() }
            .refreshable { await load() }
            .toolbar { closeToolbar }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder private var identity: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 12) { brandImage; connectionLabel }
        } else {
            HStack(spacing: 12) { brandImage; connectionLabel }
        }
    }

    private var brandImage: some View {
        Image("Cloud").resizable().scaledToFit().frame(width: 48, height: 48)
            .clipShape(.rect(cornerRadius: 15)).accessibilityHidden(true)
    }

    private var connectionLabel: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Selfcraft").font(.headline)
            HStack(spacing: 6) {
                Circle().fill(Color.secondary).frame(width: 6, height: 6).accessibilityHidden(true)
                Text(session.connected ? "已连接" : "正在恢复连接").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var settingsButton: some View {
        Button { path.append(.settings) } label: {
            Label("设置", systemImage: "slider.horizontal.3").font(.subheadline).frame(minHeight: 44)
        }.buttonStyle(.borderless)
    }

    @ToolbarContentBuilder private var closeToolbar: some ToolbarContent {
        ToolbarItem(placement: .confirmationAction) {
            Button("返回对话", systemImage: "xmark", action: { dismiss() }).labelStyle(.iconOnly)
        }
    }

    /** 同时读取独立近况，单项失败仍保留其他内容与导航入口 */
    private func load() async {
        loading = true
        async let workLoad: Void = loadWorks()
        async let memoryLoad: Void = loadMemory()
        _ = await (workLoad, memoryLoad)
        loading = false
    }

    /** 只展示尚待推进的事项，最多两条，完整内容通过列表访问 */
    private func loadWorks() async {
        do {
            let items: [JSONValue] = try await session.api.get("/api/works")
            try Task.checkCancellation()
            works = Array(items.filter { ["ready", "running", "waiting", "blocked"].contains($0["status"].string) }.prefix(2))
            worksError = nil
        } catch { if !Task.isCancelled { worksError = "事项近况暂不可用" } }
    }

    /** 从服务端当前认识中取一条，不把候选或历史版本当成已确认记忆 */
    private func loadMemory() async {
        do {
            let overview: JSONValue = try await session.api.get("/api/memory")
            try Task.checkCancellation()
            memory = overview["current"].array.first
            memoryError = nil
        } catch { if !Task.isCancelled { memoryError = "记忆近况暂不可用" } }
    }
}
