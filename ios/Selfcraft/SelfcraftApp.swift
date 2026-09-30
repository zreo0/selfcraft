import SwiftUI
import AVFoundation
import UserNotifications

/** App 只装配入口与本地持久边界，服务端拥有业务状态 */
@main struct SelfcraftApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var directory: ConnectionDirectory?
    @State private var failure: String?
    @AppStorage("appearance") private var appearance = "system"
    @AppStorage("palette") private var palette = "blue"
    var body: some Scene {
        WindowGroup {
            Group {
                if let directory { RootView(directory: directory) }
                else if let failure { ContentUnavailableView("无法打开本地数据", systemImage: "externaldrive.badge.exclamationmark", description: Text(failure)) }
                else { ProgressView("正在打开 Selfcraft") }
            }
            .tint(palette == "ink" ? .primary : Color.brandBlue)
            .preferredColorScheme(appearance == "system" ? nil : appearance == "dark" ? .dark : .light)
            .task {
                guard directory == nil else { return }
                do { directory = try ConnectionDirectory(local: LocalStore()) }
                catch { failure = error.localizedDescription }
            }
        }
    }
}

/** 根页面不显示实例切换器；通知跳转跨实例时必须确认 */
struct RootView: View {
    @Bindable var directory: ConnectionDirectory
    @State private var notifications = NotificationRouter.shared
    @State private var showSwitch = false
    var body: some View {
        Group {
            if let connection = directory.selected { SessionHost(connection: connection, directory: directory).id(directory.revision) }
            else { NavigationStack { ConnectionForm(directory: directory) } }
        }
        .onChange(of: notifications.pending, initial: true) { _, pending in
            guard let pending else { return }
            if pending.instanceId != directory.selected?.instanceId { showSwitch = true }
        }
        .confirmationDialog("这条通知来自另一个连接，切换后查看？", isPresented: $showSwitch, titleVisibility: .visible) {
            Button("切换并查看") {
                if let pending = notifications.pending, let connection = directory.connections.first(where: { $0.instanceId == pending.instanceId }) { directory.select(connection) }
                else { directory.error = "通知对应的连接尚未保存"; notifications.pending = nil }
            }
            Button("取消", role: .cancel) { notifications.pending = nil }
        }
    }
}

/** 为每次连接建立独立状态所有者，迟到结果不能进入另一个实例 */
struct SessionHost: View {
    let connection: RuntimeConnection
    let directory: ConnectionDirectory
    @State private var session: ConversationSession?
    @State private var failure: String?
    var body: some View {
        Group {
            if let session { SessionView(session: session, directory: directory) }
            else if let failure { ContentUnavailableView("无法恢复当前连接", systemImage: "exclamationmark.triangle", description: Text(failure)) }
            else { ProgressView() }
        }.task {
            do { session = try await ConversationSession(connection: connection, local: directory.local) }
            catch { failure = error.localizedDescription }
        }
    }
}

/** 对话常驻底层，功能与通知共享一个弹出入口，录音生命周期随前后台变化收敛 */
struct SessionView: View {
    @Bindable var session: ConversationSession
    let directory: ConnectionDirectory
    @State private var audio = AudioController()
    @State private var notifications = NotificationRouter.shared
    @State private var sheet: SessionSheet?
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        NavigationStack {
            if session.connected && !session.config["configured"].bool { ModelSettings(session: session) }
            else {
                ChatView(session: session, audio: audio, obscured: sheet != nil,
                         openOverview: { sheet = .overview }, openNotifications: { sheet = .notifications(nil) })
            }
        }
        .task(id: scenePhase) { if scenePhase == .active { await session.run() } }
        .onChange(of: scenePhase) { _, phase in if phase != .active { audio.stop(draft: true); audio.stopPlayback(); saveBeforeSuspension() } }
        .onDisappear { audio.stop(draft: true); audio.stopPlayback(); session.pause(); saveBeforeSuspension() }
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { _ in audio.stop(draft: true); audio.stopPlayback() }
        .onChange(of: notifications.pending, initial: true) { _, pending in
            if let pending, pending.instanceId == session.api.connection.instanceId { sheet = .notifications(pending.notificationId); notifications.pending = nil }
        }
        .onChange(of: sheet?.id) { _, value in
            if value != nil { audio.stop(draft: true); audio.stopPlayback(); session.persist() }
        }
        .sheet(item: $sheet) { destination in
            switch destination {
            case .overview: OverviewSheet(session: session, directory: directory)
            case .notifications(let id): NavigationStack { NotificationsView(api: session.api, initialId: id) }
            }
        }
        .alert("音频暂不可用", isPresented: Binding(get: { audio.error != nil }, set: { if !$0 { audio.error = nil } })) { Button("好") { audio.error = nil } } message: { Text(audio.error ?? "") }
    }

    /** 申请有限后台时间完成草稿写入，不在后台保持网络订阅 */
    private func saveBeforeSuspension() {
        let task = UIApplication.shared.beginBackgroundTask(withName: "Save conversation")
        let saved = session.persist()
        Task {
            await saved.value
            if task != .invalid { UIApplication.shared.endBackgroundTask(task) }
        }
    }
}

/** 互斥的功能面板与通知入口，避免同时呈现多个 sheet */
private enum SessionSheet: Identifiable {
    case overview
    case notifications(String?)
    var id: String {
        switch self {
        case .overview: "overview"
        case .notifications(let id): "notifications-\(id ?? "inbox")"
        }
    }
}

/** 来自 APNs 的路由意图，在确认前不改变活动实例 */
@MainActor @Observable final class NotificationRouter {
    static let shared = NotificationRouter()
    struct Route: Equatable { let instanceId: String; let notificationId: String }
    var pending: Route?

    /** 接收最少定位信息，具体内容重新从已鉴权 Runtime 获取 */
    func receive(instanceId: String, notificationId: String) {
        pending = Route(instanceId: instanceId, notificationId: notificationId)
    }
}

/** 系统通知入口；远程注册在开发者能力配置后启用 */
@MainActor final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    /** 设置通知代理，应用启动不弹权限提示 */
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    /** 提取通知目标，跨实例确认由根页面负责 */
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let instance = info["instanceId"] as? String, let notification = info["notificationId"] as? String else { return }
        await NotificationRouter.shared.receive(instanceId: instance, notificationId: notification)
    }
}
