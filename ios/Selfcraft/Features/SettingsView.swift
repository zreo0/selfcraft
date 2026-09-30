import SwiftUI
import UserNotifications

/** 正式设置以助理能力为中心，多连接收在开发选项 */
struct SettingsView: View {
    @Bindable var session: ConversationSession
    let directory: ConnectionDirectory
    @AppStorage("appearance") private var appearance = "system"
    @AppStorage("palette") private var palette = "blue"
    @State private var timezone = TimeZone.current.identifier
    @State private var error: String?
    @State private var webKey = ""
    @State private var resetting = false
    @State private var notice = ""

    var body: some View {
        Form {
            Section("模型与能力") {
                NavigationLink("模型渠道") { ModelSettings(session: session) }
                NavigationLink("语音识别") { TranscriptionSettings(api: session.api) }
                TextField("时区", text: $timezone).textInputAutocapitalization(.never)
                Button("保存时区") { Task { await update("/api/config/timezone", method: "PUT", body: ["timezone": .string(timezone)]) } }
                SecureField("网络搜索 API key", text: $webKey)
                Button("启用网络搜索") { Task { await update("/api/config/web", method: "POST", body: ["apiKey": .string(webKey)]); webKey = "" } }.disabled(webKey.isEmpty)
                Button("关闭网络搜索") { Task { await update("/api/config/web", method: "DELETE", body: [:]) } }
            }
            Section("外观") {
                Picker("显示", selection: $appearance) { Text("跟随系统").tag("system"); Text("浅色").tag("light"); Text("深色").tag("dark") }
                Picker("配色", selection: $palette) { Text("澄蓝").tag("blue"); Text("墨白").tag("ink") }
            }
            Section("通知与权限") {
                Button("允许通知") {
                    Task {
                        do {
                            let allowed = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
                            notice = allowed ? "通知权限已开启；远程推送待开发者能力配置后验收" : "通知权限未开启，可在系统设置中修改"
                        } catch { self.error = error.localizedDescription }
                    }
                }
                Button("打开系统权限设置") { if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) } }
                if !notice.isEmpty { Text(notice).font(.caption).foregroundStyle(.secondary) }
            }
            Section("开发选项") {
                NavigationLink("连接管理") { ConnectionsView(directory: directory) }
                LabeledContent("连接状态", value: session.connected ? "已连接" : "等待恢复")
                Text(session.api.connection.baseURL.absoluteString).font(.caption).textSelection(.enabled)
            }
            Section {
                Button("重置模型配置", role: .destructive) { resetting = true }
            } footer: { Text("重置会清除模型与搜索配置，保留对话、记忆及连接凭证。") }
            if let error { Text(error).foregroundStyle(.red) }
        }.navigationTitle("设置").onAppear { timezone = session.config["timezone"].string.isEmpty ? TimeZone.current.identifier : session.config["timezone"].string }
            .confirmationDialog("重置当前助理的模型配置？", isPresented: $resetting, titleVisibility: .visible) {
                Button("重置", role: .destructive) { Task { await update("/api/config/reset", method: "POST", body: [:]) } }
            }
    }

    /** 保存配置后重新读取服务端事实，失败不显示成功 */
    private func update(_ path: String, method: String, body: [String: JSONValue]) async {
        do {
            let _: JSONValue = try await session.api.get(path, method: method, body: .object(body))
            let bootstrap: JSONValue = try await session.api.get("/api/bootstrap")
            session.config = bootstrap["config"]
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}

/** 从首次认识到日常配置共用同一个模型设置页面 */
struct ModelSettings: View {
    @Bindable var session: ConversationSession
    @State private var providerId = ""
    @State private var baseURL = ""
    @State private var kind = "openai-compatible"
    @State private var apiKey = ""
    @State private var modelId = ""
    @State private var context = "128000"
    @State private var output = "8192"
    @State private var vision = false
    @State private var purpose = "agent"
    @State private var status: String?
    @State private var busy = false
    var body: some View {
        Form {
            if !session.config["configured"].bool {
                Section { Text("连接已建立。添加模型并选择使用后，就可以开始第一段对话。").foregroundStyle(.secondary) }
            }
            Section("已配置模型") {
                Picker("用途", selection: $purpose) { Text("对话").tag("agent"); Text("反思").tag("reflection"); Text("整理").tag("compression") }
                if purpose != "agent" { Button("跟随对话模型") { Task { await select(provider: "", model: "") } } }
                ForEach(session.config["providers"].array, id: \.id) { provider in
                    ForEach(provider["models"].array, id: \.id) { model in
                        VStack(alignment: .leading, spacing: 8) {
                            Text("\(provider.id) / \(model.id)").font(.subheadline)
                            HStack {
                                Button("使用") { Task { await select(provider: provider.id, model: model.id) } }
                                Spacer()
                                Button("测试连接") { Task { await test(provider: provider.id, model: model.id) } }
                            }.buttonStyle(.borderless)
                        }
                    }
                }
            }
            Section("添加或更新渠道") {
                TextField("渠道名称", text: $providerId)
                Picker("协议", selection: $kind) { Text("OpenAI Compatible").tag("openai-compatible"); Text("OpenAI").tag("openai"); Text("Anthropic").tag("anthropic") }
                TextField("API 根地址", text: $baseURL).keyboardType(.URL)
                SecureField("API key（更新时可留空）", text: $apiKey)
                TextField("模型 ID", text: $modelId)
                TextField("上下文窗口", text: $context).keyboardType(.numberPad)
                TextField("最大输出 token", text: $output).keyboardType(.numberPad)
                Toggle("支持图片", isOn: $vision)
                Button("保存渠道") { Task { await save() } }.disabled(busy || providerId.isEmpty || modelId.isEmpty)
            }.textInputAutocapitalization(.never).autocorrectionDisabled()
            if busy { ProgressView() }
            if let status { Text(status).font(.footnote).textSelection(.enabled) }
        }.navigationTitle("模型渠道")
    }

    /** 选择用途模型后更新唯一配置快照 */
    private func select(provider: String, model: String) async {
        var body: [String: JSONValue] = ["purpose": .string(purpose), "inherit": .bool(provider.isEmpty)]
        if !provider.isEmpty {
            body["providerId"] = .string(provider)
            body["modelId"] = .string(model)
        }
        do { session.config = try await session.api.get("/api/config/model", method: "PUT", body: .object(body)); status = "已保存" }
        catch { status = error.localizedDescription }
    }

    /** 显式测试模型连通性，不生成会话消息 */
    private func test(provider: String, model: String) async {
        busy = true
        defer { busy = false }
        do { let result: JSONValue = try await session.api.get("/api/config/model/test", method: "POST", body: .object(["providerId": .string(provider), "modelId": .string(model)])); status = "连接成功，\(result["durationMs"].int) ms" }
        catch { status = error.localizedDescription }
    }

    /** 保存渠道能力，密钥仅通过当前鉴权连接发送 */
    private func save() async {
        busy = true
        defer { busy = false }
        do {
            guard let window = Double(context), let maxOutput = Double(output), window > 0, maxOutput > 0 else { throw RuntimeError(message: "请输入有效的模型容量") }
            var body: [String: JSONValue] = ["providerId": .string(providerId), "type": .string(kind), "apiKey": .string(apiKey), "modelId": .string(modelId), "vision": .bool(vision), "contextWindow": .number(window), "maxOutputTokens": .number(maxOutput)]
            if !baseURL.isEmpty { body["baseURL"] = .string(baseURL) }
            session.config = try await session.api.get("/api/config/providers", method: "POST", body: .object(body))
            apiKey = ""
            status = "渠道已保存，请选择模型用途"
        } catch { status = error.localizedDescription }
    }
}

/** 转写模型独立配置，默认使用硅基流动 */
struct TranscriptionSettings: View {
    let api: RuntimeAPI
    @State private var address = "https://api.siliconflow.cn/v1"
    @State private var model = "FunAudioLLM/SenseVoiceSmall"
    @State private var key = ""
    @State private var status: String?
    var body: some View {
        Form {
            TextField("API 根地址", text: $address).keyboardType(.URL)
            TextField("模型", text: $model)
            SecureField("API key（留空保留现有凭证）", text: $key)
            Button("保存") {
                Task {
                    do { let _: JSONValue = try await api.get("/api/config/transcription", method: "PUT", body: .object(["baseURL": .string(address), "modelId": .string(model), "apiKey": .string(key)])); key = ""; status = "已保存" }
                    catch { status = error.localizedDescription }
                }
            }
            Text("录音上传到你的助理，再由这里配置的服务识别。原始录音和转录文字保存在同一实例。").font(.footnote).foregroundStyle(.secondary)
            if let status { Text(status).font(.footnote) }
        }.textInputAutocapitalization(.never).autocorrectionDisabled().navigationTitle("语音识别")
            .task {
                do { let value: JSONValue = try await api.get("/api/config/transcription"); address = value["baseURL"].string; model = value["modelId"].string; status = value["configured"].bool ? "已配置" : "尚未配置" }
                catch { status = error.localizedDescription }
            }
    }
}

/** 开发连接列表，只在设置中出现 */
struct ConnectionsView: View {
    @Bindable var directory: ConnectionDirectory
    var body: some View {
        List {
            ForEach(directory.connections) { connection in
                VStack(alignment: .leading, spacing: 8) {
                    HStack { Text(connection.name); if directory.selectedId == connection.id { Image(systemName: "checkmark.circle.fill").foregroundStyle(.tint) } }
                    Text(connection.baseURL.absoluteString).font(.caption).foregroundStyle(.secondary)
                    HStack {
                        Button("切换") { directory.select(connection) }
                        Spacer()
                        NavigationLink("编辑") { ConnectionForm(directory: directory, editing: connection) }
                    }.buttonStyle(.borderless)
                }.padding(.vertical, 4)
                    .swipeActions { Button("删除", role: .destructive) { do { try directory.remove(connection) } catch { directory.error = error.localizedDescription } } }
            }
            NavigationLink("添加连接") { ConnectionForm(directory: directory) }
            if let error = directory.error { Text(error).foregroundStyle(.red) }
        }.navigationTitle("连接管理")
    }
}

/** 手动地址和凭证连接；编辑地址必须保持服务端身份 */
struct ConnectionForm: View {
    let directory: ConnectionDirectory
    var editing: RuntimeConnection?
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var address = ""
    @State private var token = ""
    @State private var error: String?
    @State private var busy = false
    var body: some View {
        Form {
            Section {
                Image("Cloud").resizable().scaledToFit().frame(width: 64, height: 64).frame(maxWidth: .infinity)
                Text("连接你的 Selfcraft").font(.title2).fontDesign(.serif).frame(maxWidth: .infinity)
                Text("输入服务地址与连接凭证，继续同一段对话。").font(.subheadline).foregroundStyle(.secondary)
            }.listRowBackground(Color.clear)
            Section {
                TextField("名称（可选）", text: $name)
                TextField("http://192.168.1.10:3210", text: $address).keyboardType(.URL).accessibilityIdentifier("runtimeAddress")
                SecureField("连接凭证", text: $token).accessibilityIdentifier("runtimeToken")
            }.textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("连接") {
                busy = true
                Task {
                    defer { busy = false }
                    do { try await directory.connect(name: name, address: address, token: token, editing: editing); token = ""; dismiss() }
                    catch { self.error = error.localizedDescription }
                }
            }.disabled(busy || address.isEmpty).accessibilityIdentifier("connectRuntime")
            if busy { ProgressView("正在验证连接") }
            if let error { Text(error).foregroundStyle(.red) }
        }.navigationTitle(editing == nil ? "开始" : "编辑连接")
            .task {
                if let editing {
                    name = editing.name
                    address = editing.baseURL.absoluteString
                    do { token = try LocalStore.token(editing.id) } catch { self.error = error.localizedDescription }
                }
            }
    }
}
