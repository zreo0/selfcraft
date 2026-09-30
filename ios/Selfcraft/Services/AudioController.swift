import AVFoundation
import Observation

/** 前台按住录音与手动播放；后台和中断停止录制 */
@MainActor @Observable final class AudioController: NSObject, AVSpeechSynthesizerDelegate {
    var recording = false
    var elapsed: Double = 0
    var playbackId: String?
    var speakingMessageID: String?
    var isPlaying = false
    var playbackProgress: Double = 0
    var error: String?
    private var recorder: AVAudioRecorder?
    private var player: AVAudioPlayer?
    private let speech = AVSpeechSynthesizer()
    private var timer: Task<Void, Never>?
    private var recordingName: String?
    private var finished: ((String, Bool, Date) -> Void)?
    private var capturedAt = Date()
    private var starting = false
    private var generation = 0

    /** 将系统朗读完成事件同步到消息菜单的播放状态 */
    override init() {
        super.init()
        speech.delegate = self
    }

    /** 请求麦克风后开始标准 PCM 录音，回调区分草稿与正常松手发送 */
    func start(directory: URL, finished: @escaping (String, Bool, Date) -> Void) async {
        guard !recording && !starting else { return }
        starting = true
        generation += 1
        let attempt = generation
        defer { starting = false }
        guard await AVAudioApplication.requestRecordPermission() else {
            error = "请在系统设置中允许麦克风访问"
            return
        }
        guard attempt == generation else { return }
        do {
            stopPlayback()
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
            try session.setActive(true)
            let name = "recording-\(UUID().uuidString).wav"
            let recorder = try AVAudioRecorder(url: directory.appendingPathComponent(name), settings: [
                AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000,
                AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
            ])
            guard recorder.record() else { throw RuntimeError(message: "无法开始录音") }
            capturedAt = Date()
            self.recorder = recorder
            recordingName = name
            self.finished = finished
            elapsed = 0
            recording = true
            timer = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
                    guard let self, self.recording else { return }
                    self.elapsed = self.recorder?.currentTime ?? 0
                    if self.elapsed >= 119.9 { self.stop(draft: true); return }
                }
            }
        } catch { self.error = error.localizedDescription }
    }

    /** 停止录音；取消丢弃原件，中断和时长上限仅保存草稿 */
    func stop(draft: Bool, cancel: Bool = false) {
        generation += 1
        guard recording else { return }
        let duration = recorder?.currentTime ?? 0
        recorder?.stop()
        timer?.cancel()
        recording = false
        if cancel || duration < 0.25 {
            recorder?.deleteRecording()
        } else if let name = recordingName { finished?(name, draft, capturedAt) }
        recorder = nil
        recordingName = nil
        finished = nil
        do { try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        catch { self.error = error.localizedDescription }
    }

    /** 手动播放原件或暂停，不在消息出现时自动触发 */
    func play(data: Data, id: String) throws {
        if togglePlayback(id: id) { return }
        stopPlayback()
        try AVAudioSession.sharedInstance().setCategory(.playback)
        try AVAudioSession.sharedInstance().setActive(true)
        player = try AVAudioPlayer(data: data)
        playbackId = id
        player?.play()
        isPlaying = true
        timer = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
                guard let self, let player = self.player else { return }
                self.playbackProgress = player.duration > 0 ? player.currentTime / player.duration : 0
                if !player.isPlaying && player.currentTime == 0 { self.stopPlayback(); return }
            }
        }
    }

    /** 返回是否复用了当前音频，调用方据此避免再次下载 */
    func togglePlayback(id: String) -> Bool {
        guard playbackId == id, let player else { return false }
        if player.isPlaying { player.pause() } else { player.play() }
        isPlaying = player.isPlaying
        return true
    }

    /** 朗读指定消息，再次操作同一消息停止，切换消息时替换当前朗读 */
    func speak(_ text: String, id: String) {
        guard !recording else { return }
        if speakingMessageID == id { stopPlayback(); return }
        stopPlayback()
        speakingMessageID = id
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "zh-CN")
        speech.speak(utterance)
    }

    /** 离开实例或开始录音时释放播放资源 */
    func stopPlayback() {
        player?.stop()
        player = nil
        playbackId = nil
        isPlaying = false
        playbackProgress = 0
        speech.stopSpeaking(at: .immediate)
        speakingMessageID = nil
        if !recording { timer?.cancel() }
    }

    /** 自然播放结束后恢复朗读菜单，不让旧回调清除新朗读状态 */
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            guard let self, !self.speech.isSpeaking else { return }
            self.speakingMessageID = nil
        }
    }

}
