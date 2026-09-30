import Foundation

/** 消息展示所需的过程和引用，不改变 Runtime 原始记录 */
struct MessagePresentation {
    /** 以工具调用 ID 合并后的最新状态，保留执行顺序 */
    let activities: [JSONValue]
    /** 按完整网址去重，同站点不同页面仍分别保留 */
    let sources: [Source]

    struct Source: Identifiable {
        let url: URL
        let title: String
        var id: String { url.absoluteString }
        var domain: String { url.host ?? url.absoluteString }
    }

    /** 从消息 parts 提取可展示信息，同一调用的迟到快照覆盖旧状态 */
    init(parts: [JSONValue]) {
        var order: [String] = []
        var byID: [String: JSONValue] = [:]
        var urls = Set<String>()
        var sources: [Source] = []
        for part in parts {
            if part["type"].string == "data-activity" {
                for item in part["data"]["items"].array where !item.id.isEmpty {
                    if byID[item.id] == nil { order.append(item.id) }
                    byID[item.id] = item
                }
            }
            if part["type"].string == "source-url", let url = URL(string: part["url"].string),
               ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil,
               urls.insert(url.absoluteString).inserted {
                let title = part["title"].string.trimmingCharacters(in: .whitespacesAndNewlines)
                sources.append(Source(url: url, title: title.isEmpty ? url.host! : title))
            }
        }
        activities = order.compactMap { byID[$0] }
        self.sources = sources
    }

    var unfinishedCount: Int { activities.filter { $0["state"].string != "success" }.count }
    var websiteCount: Int { Set(sources.map(\.domain)).count }

    /** 区分真实运行、完成与中断，不把未知或失败步骤显示为成功 */
    func activitySummary(streaming: Bool, failed: Bool, hasText: Bool) -> String {
        if streaming {
            if let running = activities.last(where: { $0["state"].string == "running" }) {
                return "正在\(running["label"].string.isEmpty ? "处理" : running["label"].string)"
            }
            return hasText ? "正在回复" : "正在整理回答"
        }
        if failed { return "回复已中断 · 查看过程" }
        if unfinishedCount > 0 { return "\(activities.count) 项操作 · \(unfinishedCount) 项未完成" }
        return "已完成 \(activities.count) 项操作"
    }
}
