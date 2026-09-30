import Foundation

/** 可直接展示的连接错误 */
struct RuntimeError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/** 一个连接的不可变请求边界，禁止凭证跟随重定向到其他主机 */
final class RuntimeAPI: NSObject, URLSessionTaskDelegate, Sendable {
    let connection: RuntimeConnection
    private let token: String

    /** 绑定连接与 Keychain 中读取的凭证 */
    init(connection: RuntimeConnection, token: String) {
        self.connection = connection
        self.token = token
    }

    /** 构造同实例请求，拒绝附件 URL 逃逸 */
    func request(_ path: String, method: String = "GET", body: Data? = nil, contentType: String = "application/json") throws -> URLRequest {
        guard path.hasPrefix("/api/"), !path.hasPrefix("//"),
              let url = URL(string: path, relativeTo: connection.baseURL)?.absoluteURL,
              url.host == connection.baseURL.host, url.port == connection.baseURL.port,
              url.scheme == connection.baseURL.scheme else { throw RuntimeError(message: "无效的实例资源地址") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = 100
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if body != nil { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        return request
    }

    /** 执行请求并解码响应，返回类型由调用方指定 */
    func get<T: Decodable & Sendable>(_ path: String, method: String = "GET", body: JSONValue? = nil) async throws -> T {
        let data = try body.map { try JSONEncoder().encode($0) }
        let bytes = try await send(request(path, method: method, body: data))
        return try JSONDecoder().decode(T.self, from: bytes)
    }

    /** 请求原始数据，失败时返回脱敏的服务端提示 */
    func send(_ request: URLRequest) async throws -> Data {
        let session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        return data
    }

    /** 对 multipart 音频上传使用同一鉴权边界 */
    func upload(_ data: Data, id: String, capturedAt: Date) async throws {
        let boundary = UUID().uuidString
        var body = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"capturedAt\"\r\n\r\n\(capturedAt.ISO8601Format())\r\n--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"recording.wav\"\r\nContent-Type: audio/wav\r\n\r\n".utf8)
        body.append(data)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        _ = try await send(request("/api/audio/\(id)", method: "PUT", body: body, contentType: "multipart/form-data; boundary=\(boundary)"))
    }

    /** 上传由照片选择器转换为 JPEG 的图片 */
    func uploadImage(_ data: Data) async throws -> JSONValue {
        let boundary = UUID().uuidString
        var body = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"image.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n".utf8)
        body.append(data)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        return try JSONDecoder().decode(JSONValue.self, from: await send(request("/api/attachments", method: "POST", body: body, contentType: "multipart/form-data; boundary=\(boundary)")))
    }

    /** 持续读取共享快照，取消页面任务会关闭连接 */
    func events(after cursor: Int, receive: @Sendable (Data) async throws -> Void) async throws {
        let session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request("/api/conversation/events?after=\(cursor)"))
        try validate(response, data: Data())
        for try await line in bytes.lines {
            try Task.checkCancellation()
            if line.hasPrefix("data: ") { try await receive(Data(line.dropFirst(6).utf8)) }
        }
    }

    /** 拒绝所有 HTTP 重定向，避免把访问凭证发往其他地址 */
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    /** 验证状态码，不将凭证或原始网络对象展示给用户 */
    private func validate(_ response: URLResponse, data: Data) throws {
        guard let response = response as? HTTPURLResponse else { throw RuntimeError(message: "无效的服务响应") }
        if response.statusCode == 401 { throw RuntimeError(message: "连接凭证失效，请在连接管理中更新") }
        guard (200..<300).contains(response.statusCode) else {
            let value = try? JSONDecoder().decode(JSONValue.self, from: data)
            throw RuntimeError(message: value?["error"].string.isEmpty == false ? value!["error"].string : "请求失败（\(response.statusCode)）")
        }
    }
}
