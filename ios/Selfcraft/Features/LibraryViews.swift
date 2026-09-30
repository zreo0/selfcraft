import SwiftUI

/** 事项列表使用 Runtime 的 Work，不复制后台执行状态 */
struct WorksView: View {
    let session: ConversationSession
    @State private var items: [JSONValue] = []
    @State private var error: String?
    @State private var loading = true

    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            if loading { ProgressView("正在读取事项") }
            if !loading && items.isEmpty { ContentUnavailableView("暂时没有事项", systemImage: "checklist", description: Text("在对话中交给我一件需要持续推进的事。")) }
            ForEach(items, id: \.id) { item in
                NavigationLink {
                    WorkDetail(session: session, item: item)
                } label: {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(item["goal"].string).font(.headline)
                        Text(statusLabel(item["status"].string)).font(.caption).foregroundStyle(.tint)
                        Text(item["next"].string).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                    }.padding(.vertical, 6)
                }
            }
        }.navigationTitle("事项").task { await load() }.refreshable { await load() }
    }

    /** 读取持久事项并区分空状态和读取失败 */
    private func load() async {
        defer { loading = false }
        do { items = try await session.api.get("/api/works"); error = nil }
        catch { self.error = error.localizedDescription }
    }

    /** 把运行状态映射为面向用户的进展描述 */
    private func statusLabel(_ status: String) -> String {
        ["ready": "待继续", "running": "进行中", "waiting": "等待中", "completed": "已完成", "cancelled": "已取消", "blocked": "需要处理"][status] ?? status
    }
}

/** 事项列表与近况面板共用详情和补充要求入口 */
struct WorkDetail: View {
    let session: ConversationSession
    let item: JSONValue
    var body: some View {
        Form {
            Section("目标") { Text(item["goal"].string) }
            Section("完成条件") { Text(item["acceptance"].string) }
            Section("进展与依据") { Text(item["evidence"].string); Text(item["next"].string) }
            Section("补充要求") { WorkInstruction(session: session, item: item) }
        }.navigationTitle("事项详情")
    }
}

/** 通过原有前台用户指令更新事项，遵循主脑的授权与版本检查 */
struct WorkInstruction: View {
    let session: ConversationSession
    let item: JSONValue
    @State private var instruction = ""
    @State private var sent = false
    @State private var cancel = false
    var body: some View {
        TextField("补充目标或要求", text: $instruction, axis: .vertical)
        Button("提交补充") {
            session.enqueue(text: "针对事项 \(item["id"].string)（\(item["goal"].string)）：\(instruction)")
            instruction = ""
            sent = true
        }.disabled(instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        Button("请求取消事项", role: .destructive) { cancel = true }
            .confirmationDialog("取消后不再继续推进，已发生的操作不会撤销。", isPresented: $cancel, titleVisibility: .visible) {
                Button("提交取消请求", role: .destructive) {
                    session.enqueue(text: "请取消事项 \(item["id"].string)（\(item["goal"].string)），不要继续执行。")
                    sent = true
                }
            }
        if sent { Text("请求已加入对话，请查看助理处理结果。").font(.caption).foregroundStyle(.secondary) }
    }
}

/** 与 Web 共用认识、候选和历史，不在本地生成记忆 */
struct MemoriesView: View {
    let api: RuntimeAPI
    @State private var overview: JSONValue = .null
    @State private var query = ""
    @State private var error: String?
    @State private var loading = true
    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            if loading { ProgressView("正在读取记忆") }
            ForEach([("current", "此刻"), ("pending", "待确认"), ("versions", "流变")], id: \.0) { key, title in
                Section(title) {
                    ForEach(overview[key].array, id: \.id) { item in
                        NavigationLink { MemoryDetail(api: api, item: item) } label: {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(item["content"].string)
                                if !item["validFrom"].string.isEmpty { Text(item["validFrom"].string).font(.caption).foregroundStyle(.secondary) }
                            }.padding(.vertical, 4)
                        }
                    }
                }
            }
            if overview["nextOffset"] != .null { Button("加载更多") { Task { await load(more: true) } } }
            if !loading && ["current", "pending", "versions"].allSatisfy({ overview[$0].array.isEmpty }) {
                ContentUnavailableView("认识正在形成", systemImage: "water.waves", description: Text("持续对话后，值得保留的认识会出现在这里。"))
            }
        }.navigationTitle("记忆").searchable(text: $query, prompt: "查找记忆")
            .task(id: query) { await load() }.refreshable { await load() }
    }

    /** 按检索词读取概览，分页追加时保留已加载项 */
    private func load(more: Bool = false) async {
        defer { loading = false }
        do {
            let encoded = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&+?#"))) ?? ""
            var next: JSONValue = try await api.get("/api/memory?q=\(encoded)&offset=\(more ? overview["nextOffset"].int : 0)")
            try Task.checkCancellation()
            if more, case .object(var object) = next {
                for key in ["current", "pending", "versions"] { object[key] = .array(overview[key].array + next[key].array) }
                next = .object(object)
            }
            overview = next
            error = nil
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

/** 记忆的来源、确认、修订与忘记操作 */
struct MemoryDetail: View {
    let api: RuntimeAPI
    let item: JSONValue
    @State private var detail: JSONValue = .null
    @State private var correction = ""
    @State private var isChange = false
    @State private var validFrom = Date()
    @State private var resident = false
    @State private var error: String?
    @State private var forget = false
    private var memory: JSONValue { detail["memory"] == .null ? item : detail["memory"] }
    var body: some View {
        Form {
            if let error { Text(error).foregroundStyle(.red) }
            Section("当前认识") { Text(detail["memory"]["content"].string.isEmpty ? item["content"].string : detail["memory"]["content"].string) }
            if memory["status"].string == "active" { Section("修订") {
                TextField("写下准确的认识", text: $correction, axis: .vertical)
                Toggle("情况发生了变化", isOn: $isChange)
                if isChange { DatePicker("生效日期", selection: $validFrom, displayedComponents: .date) }
                Button("保存修订") { Task { await correct() } }.disabled(correction.count < 4)
            } }
            Section {
                if memory["status"].string == "candidate" {
                    if memory["revisionKind"].string == "world_change" { DatePicker("变化生效日期", selection: $validFrom, displayedComponents: .date) }
                    Button("确认这条认识") { Task { await action("confirm", body: memory["revisionKind"].string == "world_change" ? ["validFrom": .string(validFrom.ISO8601Format())] : [:]) } }.disabled(item["confirmable"] == .bool(false))
                }
                if ["active", "candidate"].contains(memory["status"].string) {
                    Toggle("常驻记忆", isOn: $resident)
                    Button("保存常驻设置") { Task { await action("resident", body: ["resident": .bool(resident)]) } }
                }
                if memory["status"].string != "forgotten" { Button("忘记这条认识", role: .destructive) { forget = true } }
            }
            Section("来源") { ForEach(detail["sources"].array, id: \.id) { source in Text(source["text"].string.isEmpty ? source["type"].string : source["text"].string).font(.subheadline) } }
            Section("修订历史") { ForEach(detail["history"].array, id: \.id) { version in Text(version["content"].string) } }
        }.navigationTitle("认识详情").task { await load() }
            .confirmationDialog("忘记这条认识？历史原文仍会保留。", isPresented: $forget, titleVisibility: .visible) {
                Button("忘记", role: .destructive) { Task { await action("forget") } }
            }
    }

    /** 读取服务端详情，不使用列表副本替代最新版本 */
    private func load() async {
        do { detail = try await api.get("/api/memory/\(memory.id)"); resident = detail["memory"]["resident"].bool }
        catch { self.error = error.localizedDescription }
    }

    /** 提交一次显式记忆操作并刷新结果 */
    private func action(_ name: String, body: [String: JSONValue] = [:]) async {
        do {
            let result: JSONValue = try await api.get("/api/memory/\(memory.id)/\(name)", method: "POST", body: .object(body))
            detail = .object(["memory": result["memory"]])
            error = nil
            await load()
        }
        catch { self.error = error.localizedDescription }
    }

    /** 纠错不篡改原有生效时间，现实变化才提交用户选择的日期 */
    private func correct() async {
        var body: [String: JSONValue] = ["content": .string(correction), "revisionKind": .string(isChange ? "world_change" : "correction")]
        if isChange { body["validFrom"] = .string(validFrom.ISO8601Format()) }
        await action("correct", body: body)
    }
}

/** 通知始终从 Runtime 读取，APNs 只负责提醒 */
struct NotificationsView: View {
    @Environment(\.dismiss) private var dismiss
    let api: RuntimeAPI
    var initialId: String? = nil
    @State private var selected: JSONValue?
    @State private var items: [JSONValue] = []
    @State private var error: String?
    @State private var loading = true
    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            if loading { ProgressView("正在读取通知") }
            if !loading && error == nil && items.isEmpty { ContentUnavailableView("暂无未读通知", systemImage: "bell") }
            ForEach(items, id: \.id) { item in
                VStack(alignment: .leading, spacing: 10) {
                    Button(item["title"].string) { selected = item }.font(.headline)
                    Text(item["message"].string).font(.subheadline)
                    Button("标记已读") {
                        Task { do { let _: JSONValue = try await api.get("/api/notifications/\(item.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? item.id)/read", method: "POST", body: .object([:])); await load() } catch { self.error = error.localizedDescription } }
                    }
                }.padding(.vertical, 6)
            }
        }.navigationTitle("通知").task {
            await load()
            if let initialId {
                do {
                    let item: JSONValue = try await api.get("/api/notifications/\(initialId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? initialId)")
                    if item == .null { error = "这条通知已不可用" } else { selected = item }
                } catch { self.error = error.localizedDescription }
            }
        }.refreshable { await load() }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("返回对话", systemImage: "xmark", action: { dismiss() }).labelStyle(.iconOnly)
                }
            }
            .navigationDestination(item: $selected) { item in
                ScrollView { VStack(alignment: .leading, spacing: 16) {
                    Text(item["title"].string).font(.title2)
                    MessageText(text: item["message"].string)
                }.padding(20) }.navigationTitle("通知详情")
            }
    }

    /** 刷新未读通知，失败时保留上次显示内容 */
    private func load() async {
        defer { loading = false }
        do {
            let page: JSONValue = try await api.get("/api/notifications")
            try Task.checkCancellation()
            items = page["items"].array
            error = nil
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}
