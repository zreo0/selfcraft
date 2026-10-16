import SwiftUI

/** 消息内的原生交互入口，长表单在面板中填写 */
struct InteractionCard: View {
    let value: InteractionView
    let api: RuntimeAPI
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(value.interaction.title).font(.headline)
            Text(value.interaction.description).font(.subheadline).foregroundStyle(.secondary)
            Text(value.status == "ready" ? "等待回答" : value.status == "submitted" ? "回答已接收" : "已关闭").font(.caption)
            if value.supported {
                Button(value.status == "ready" ? "填写回答" : "查看回答") { expanded = true }.buttonStyle(.bordered)
            } else { Text("当前版本不支持此表单，可以直接用文字回答").font(.caption) }
        }
        .padding().frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
        .sheet(isPresented: $expanded) { InteractionSheet(value: value, api: api).id(api.connection.instanceId + value.id) }
    }
}

/** 创建表单自身拥有的编辑器，磁盘不可用时保留文字回答 */
private struct InteractionSheet: View {
    let value: InteractionView
    let api: RuntimeAPI
    @State private var editor: InteractionEditor?
    @State private var failure: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if let editor { InteractionForm(editor: editor) }
                else if let failure { ContentUnavailableView("无法打开表单", systemImage: "exclamationmark.triangle", description: Text(failure)) }
                else { ProgressView("正在读取表单") }
            }
            .navigationTitle("回答问题").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
        .task {
            guard editor == nil else { return }
            do {
                let model = InteractionEditor(view: value, api: api, local: try LocalStore())
                editor = model
                await model.load()
            } catch { failure = error.localizedDescription }
        }
        .onChange(of: value) { _, latest in editor?.receive(latest) }
        .onDisappear { editor?.pause() }
    }
}

/** 仅从结构化字段生成原生控件，所有执行仍回到 Runtime */
private struct InteractionForm: View {
    @Bindable var editor: InteractionEditor
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Form {
            Section {
                Text(editor.view.interaction.title).font(.headline)
                Text(editor.view.interaction.description)
            }
            ForEach(editor.view.interaction.fields) { field in
                Section(field.label + (field.required ? "（必填）" : "")) {
                    if field.type == "text" {
                        TextField("补充说明", text: Binding(get: { editor.values[field.name]?.string ?? "" }, set: { editor.change(field.name, value: .string(String($0.prefix(2000)))) }), axis: .vertical)
                            .lineLimit(3...8).accessibilityLabel(field.label)
                    } else {
                        ForEach(field.options ?? []) { option in
                            let selected = field.type == "multi-select"
                                ? (editor.values[field.name]?.array ?? []).contains(.string(option.value))
                                : editor.values[field.name]?.string == option.value
                            Button {
                                if field.type == "single-select" { editor.change(field.name, value: .string(option.value)) }
                                else {
                                    var values = editor.values[field.name]?.array ?? []
                                    if selected { values.removeAll { $0 == .string(option.value) } } else { values.append(.string(option.value)) }
                                    editor.change(field.name, value: .array(values))
                                }
                            } label: {
                                HStack(alignment: .top) {
                                    VStack(alignment: .leading) {
                                        Text(option.label)
                                        if !option.description.isEmpty { Text(option.description).font(.caption).foregroundStyle(.secondary) }
                                    }
                                    Spacer()
                                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                                }.contentShape(Rectangle())
                            }.buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected : [])
                        }
                    }
                }.disabled(!editor.loaded || editor.busy || editor.pending != nil || editor.view.status != "ready")
            }
            Section {
                if let error = editor.error { Text(error).foregroundStyle(.red).accessibilityLabel("错误：" + error) }
                if editor.view.status == "ready" {
                    Button(editor.busy ? "正在确认" : editor.saving ? "正在保存" : editor.pending == nil ? "提交回答" : "确认原提交结果") { Task { await editor.submit() } }
                        .disabled(!editor.loaded || editor.busy || editor.saving || (editor.conflicted && editor.pending == nil))
                    if editor.error != nil && (editor.pending == nil || !editor.loaded) {
                        Button(editor.loaded ? "核对最新版本并保留填写" : "重新加载") { Task { if editor.loaded { await editor.refresh() } else { await editor.load() } } }
                    }
                } else { Text(editor.view.status == "submitted" ? "回答已接收，处理结果见后续对话" : "此交互已关闭").foregroundStyle(.secondary) }
            }
        }
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await editor.sync() } } }
    }
}

/** 列出历史窗口之外仍等待回答的交互 */
struct InteractionInbox: View {
    let api: RuntimeAPI
    @State private var items: [InteractionView] = []
    @State private var cursor: Int? = 0
    @State private var failure: String?
    @State private var loading = false

    var body: some View {
        List {
            ForEach(items) { value in InteractionCard(value: value, api: api) }
            if let failure { Text(failure).foregroundStyle(.red) }
            if cursor != nil { Button(loading ? "正在读取" : "加载待回答交互") { Task { await load() } }.disabled(loading) }
            if items.isEmpty && cursor == nil { Text("没有待回答交互").foregroundStyle(.secondary) }
        }.navigationTitle("待回答").task { await load() }
        .refreshable { items = []; cursor = 0; await load() }
    }

    /** 分页加载 Runtime 中的待回答记录 */
    private func load() async {
        guard !loading, let after = cursor else { return }
        loading = true
        defer { loading = false }
        do {
            let page: InteractionPage = try await api.get("/api/conversation/ui?status=ready&after=\(after)")
            let known = Set(items.map(\.id))
            items.append(contentsOf: page.items.filter { !known.contains($0.id) })
            cursor = page.nextCursor; failure = nil
        } catch { failure = error.localizedDescription }
    }
}
