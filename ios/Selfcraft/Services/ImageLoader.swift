import Foundation
import UIKit
import ImageIO

/** 解码和缩图离开主线程，解码缓存按像素成本限制内存 */
actor ImageLoader {
    static let shared = ImageLoader()
    private let cache = NSCache<NSString, UIImage>()

    /** 限制缩略图缓存到 24 MB，系统内存压力下也允许自动清理 */
    init() {
        cache.totalCostLimit = 24 * 1024 * 1024
        cache.countLimit = 48
    }

    /** 按实例和资源路径缓存缩略图，返回可显示的图片 */
    func image(api: RuntimeAPI, path: String) async throws -> UIImage {
        let key = "\(api.connection.instanceId):\(path)" as NSString
        if let cached = cache.object(forKey: key) { return cached }
        let data = try await api.send(api.request(path))
        let image = try Self.thumbnail(data, pixels: 1200)
        cache.setObject(image, forKey: key, cost: Int(image.size.width * image.size.height * 4))
        return image
    }

    /** 上传前缩小照片，避免解码和编码整张原始照片阻塞输入 */
    static func uploadJPEG(_ data: Data) async throws -> Data {
        try await Task.detached(priority: .userInitiated) {
            let image = try thumbnail(data, pixels: 2048)
            guard let jpeg = image.jpegData(compressionQuality: 0.8) else { throw RuntimeError(message: "无法转换图片") }
            return jpeg
        }.value
    }

    /** 直接从压缩数据生成定尺寸缩略图，不先解码全尺寸像素 */
    private static func thumbnail(_ data: Data, pixels: Int) throws -> UIImage {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: pixels,
                kCGImageSourceShouldCacheImmediately: true,
              ] as CFDictionary) else { throw RuntimeError(message: "无法读取图片") }
        return UIImage(cgImage: image)
    }
}
