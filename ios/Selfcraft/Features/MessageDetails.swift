import SwiftUI

/** 过程只占一行，完整执行记录按需打开，避免工具列表挤压回答 */
struct MessageActivitySummary: View {
    let presentation: MessagePresentation
    let streaming: Bool
    let failed: Bool
    let hasText: Bool
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 8) {
                if streaming { ProgressView().controlSize(.mini) }
                else { Image(systemName: failed || presentation.unfinishedCount > 0 ? "exclamationmark.circle" : "checkmark.circle") }
                Text(presentation.activitySummary(streaming: streaming, failed: failed, hasText: hasText))
                    .multilineTextAlignment(.leading)
                Image(systemName: "chevron.right").font(.caption2)
            }.font(.caption).foregroundStyle(.secondary).frame(minHeight: 44, alignment: .leading)
                .contentShape(.rect)
        }.buttonStyle(.plain).accessibilityHint("查看完整执行过程")
    }
}

/** 来源入口放在正文下方，按网站汇总数量但保留每个页面 */
struct MessageSourcesSummary: View {
    let presentation: MessagePresentation
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 8) {
                Image(systemName: "link")
                Text("\(presentation.sources.count) 个来源 · \(presentation.websiteCount) 个网站")
                Image(systemName: "chevron.right").font(.caption2)
            }.font(.caption).foregroundStyle(.secondary).padding(.horizontal, 12)
                .frame(minHeight: 44)
                .background(Color.secondary.opacity(0.06), in: .rect(cornerRadius: 14))
        }.buttonStyle(.plain).accessibilityHint("打开参考来源")
    }
}

/** 全高详情独立滚动，展开过程不会改变对话列表高度或阅读位置 */
struct MessageDetails: View {
    enum Page: String, Identifiable { case activity, sources; var id: String { rawValue } }
    let page: Page
    let presentation: MessagePresentation
    let streaming: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if page == .activity {
                    ForEach(presentation.activities, id: \.id) { item in
                        HStack(alignment: .top, spacing: 12) {
                            activityIcon(item)
                            VStack(alignment: .leading, spacing: 6) {
                                Text(item["label"].string.isEmpty ? "处理步骤" : item["label"].string).font(.subheadline.weight(.medium))
                                if !item["target"].string.isEmpty { Text(item["target"].string).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                                Text(activityState(item)).font(.caption).foregroundStyle(.secondary)
                            }
                        }.padding(.vertical, 6)
                    }
                } else {
                    ForEach(presentation.sources) { source in
                        Link(destination: source.url) {
                            HStack(alignment: .top, spacing: 12) {
                                Image(systemName: "globe").foregroundStyle(.secondary)
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(source.title).font(.subheadline.weight(.medium)).foregroundStyle(.primary)
                                    Text(source.url.absoluteString).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                                }
                                Spacer(minLength: 0)
                                Image(systemName: "arrow.up.right").font(.caption).foregroundStyle(.secondary)
                            }.padding(.vertical, 6)
                        }
                    }
                }
            }
            .navigationTitle(page == .activity ? "执行过程" : "参考来源")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("返回对话", systemImage: "xmark", action: { dismiss() }).labelStyle(.iconOnly)
                }
            }
        }.presentationDetents([.large]).presentationDragIndicator(.visible)
    }

    /** 结束后的 running 只能视为未完成，未知状态不显示成功图标 */
    @ViewBuilder private func activityIcon(_ item: JSONValue) -> some View {
        if streaming && item["state"].string == "running" { ProgressView().controlSize(.small) }
        else {
            Image(systemName: item["state"].string == "success" ? "checkmark.circle" : item["state"].string == "error" ? "exclamationmark.circle" : "questionmark.circle")
                .foregroundStyle(.secondary)
        }
    }

    /** 只描述已知执行状态，不将工具成功等同于整段任务成功 */
    private func activityState(_ item: JSONValue) -> String {
        switch item["state"].string {
        case "success": "已完成"
        case "error": "执行失败"
        case "running": streaming ? "进行中" : "未完成"
        default: "结果未知"
        }
    }
}
