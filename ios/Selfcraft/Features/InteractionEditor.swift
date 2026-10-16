import Foundation
import Observation

/** 一个实例、一张表单的编辑状态；不持有模型或业务执行权限 */
@MainActor @Observable final class InteractionEditor {
    var view: InteractionView
    var values: [String: JSONValue]
    var pending: InteractionSubmission?
    var error: String?
    var busy = false
    var loaded = false
    var conflicted = false
    private var baseRevision: Int
    private var dirty = false
    private(set) var saving = false
    private var debounce: Task<Void, Never>?
    private let api: RuntimeAPI
    private let local: LocalStore
    private let filename: String

    /** 绑定不可变实例身份；初值只作为加载前的展示快照 */
    init(view: InteractionView, api: RuntimeAPI, local: LocalStore) {
        self.view = view
        baseRevision = view.revision
        values = view.values
        self.api = api
        self.local = local
        filename = "interaction-" + LocalStore.filename(api.connection.instanceId + ":" + view.id)
    }

    /** 恢复本地草稿并核实实例与服务端状态，未知回执不自动产生新提交 */
    func load() async {
        do {
            let bootstrap: JSONValue = try await api.get("/api/bootstrap")
            guard bootstrap["instanceId"].string == api.connection.instanceId else { throw RuntimeError(message: "实例身份变化，请重新连接") }
            guard bootstrap["interaction"]["protocolVersion"].int == 1 else { throw RuntimeError(message: "此 Runtime 暂不支持交互表单") }
            let saved: InteractionDraft? = try await ConversationWriter.shared.read(filename, local: local, fallback: nil)
            let latest: InteractionView = try await api.get("/api/conversation/ui/\(view.id)")
            baseRevision = saved?.revision ?? latest.revision
            values = saved?.values ?? latest.values
            pending = saved?.pending
            dirty = saved != nil && values != latest.values
            view = latest
            if latest.status != "ready" {
                values = latest.values; pending = nil; dirty = false
            } else if let pending {
                do {
                    let _: InteractionReceipt = try await api.get("/api/conversation/ui/submissions/\(pending.submissionId)")
                    view = try await api.get("/api/conversation/ui/\(view.id)")
                    self.pending = nil; values = view.values; dirty = false
                } catch { self.error = "上次提交尚未确认，请使用原提交重试" }
            } else if dirty && baseRevision != latest.revision {
                conflicted = true; error = "表单已变化，本地填写已保留，请核对最新版本"
            }
            if !dirty { baseRevision = view.revision; values = view.values }
            loaded = true
            try await persist()
        } catch { self.error = error.localizedDescription }
    }

    /** 更新本地输入并排队落盘，防抖只作用于服务端草稿保存 */
    func change(_ name: String, value: JSONValue) {
        values[name] = value
        dirty = true
        let saved = ConversationWriter.shared.write(InteractionDraft(revision: baseRevision, values: values, pending: pending), local: local, name: filename)
        Task { do { try await saved.value } catch { self.error = "本地保存失败：\(error.localizedDescription)" } }
        scheduleSave()
    }

    /** 合并连续输入，不取消已经发送的草稿请求 */
    private func scheduleSave() {
        debounce?.cancel()
        debounce = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(500)) } catch { return }
            guard let self else { return }
            await self.saveDraft()
        }
    }

    /** 串行保存带版本的草稿，冲突保留本地值 */
    private func saveDraft() async {
        guard loaded, dirty, !saving, !busy, !conflicted, pending == nil, view.status == "ready" else { return }
        saving = true
        let snapshot = values
        do {
            let latest: InteractionView = try await api.get("/api/conversation/ui/\(view.id)/state", method: "PATCH",
                body: .object(["expectedRevision": .number(Double(baseRevision)), "values": .object(snapshot)]))
            try Task.checkCancellation()
            baseRevision = latest.revision
            guard view.revision <= latest.revision else {
                conflicted = true
                throw RuntimeError(message: "其他客户端修改了表单，请核对最新版本", status: 409)
            }
            view = latest
            dirty = values != snapshot
            try await persist()
        } catch {
            self.error = error.localizedDescription
            if (error as? RuntimeError)?.status == 409 { conflicted = true }
        }
        saving = false
        if dirty && error == nil { scheduleSave() }
    }

    /** 接收 SSE 新快照，不覆盖正在编辑的本地字段 */
    func receive(_ latest: InteractionView) {
        guard latest.revision > view.revision else { return }
        view = latest
        if latest.status != "ready" || !dirty {
            values = latest.values; pending = nil; dirty = false; baseRevision = latest.revision
            Task { try? await persist() }
        } else if !saving {
            conflicted = true; error = "其他客户端修改了表单，请核对最新版本"
        }
    }

    /** 关闭编辑面板时取消草稿请求，避免迟到响应覆盖重新打开后的填写 */
    func pause() { debounce?.cancel() }

    /** 前台恢复只同步状态，不替用户解除编辑冲突 */
    func sync() async {
        guard loaded else { await load(); return }
        do {
            let latest: InteractionView = try await api.get("/api/conversation/ui/\(view.id)")
            receive(latest)
        } catch { self.error = error.localizedDescription }
    }

    /** 用户核对后采用最新版本，保留尚未提交的填写 */
    func refresh() async {
        do {
            view = try await api.get("/api/conversation/ui/\(view.id)")
            if view.status != "ready" { values = view.values; pending = nil; dirty = false }
            baseRevision = view.revision
            conflicted = false; error = nil
            try await persist()
        } catch { self.error = error.localizedDescription }
    }

    /** 持久保存完整请求后再提交；失败保留原标识供查询或重试 */
    func submit() async {
        guard loaded, !busy, !saving, (!conflicted || pending != nil), view.supported else { return }
        busy = true
        debounce?.cancel()
        defer { busy = false }
        do {
            let request = pending ?? InteractionSubmission(submissionId: UUID().uuidString.lowercased(), expectedRevision: baseRevision, actionId: "submit", values: values)
            pending = request
            try await persist()
            let body = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(request))
            let _: InteractionReceipt = try await api.get("/api/conversation/ui/\(view.id)/actions", method: "POST", body: body)
            view = try await api.get("/api/conversation/ui/\(view.id)")
            pending = nil; values = view.values; dirty = false; error = nil
            try await persist()
        } catch {
            self.error = error.localizedDescription
            if let status = (error as? RuntimeError)?.status, [409, 422].contains(status) {
                pending = nil
                conflicted = status == 409
                do { try await persist() } catch { self.error = error.localizedDescription }
            }
        }
    }

    /** 通过既有串行写入边界保存本轮输入，不保存凭证 */
    private func persist() async throws {
        try await ConversationWriter.shared.write(InteractionDraft(revision: baseRevision, values: values, pending: pending), local: local, name: filename).value
    }
}
