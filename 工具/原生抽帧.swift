import AVFoundation
import AppKit

guard CommandLine.arguments.count == 4, let seconds = Double(CommandLine.arguments[2]), seconds >= 0 else {
    throw NSError(domain: "原生抽帧", code: 1, userInfo: [NSLocalizedDescriptionKey: "用法：原生抽帧 视频 秒数 新建PNG"])
}
let output = URL(fileURLWithPath: CommandLine.arguments[3])
guard !FileManager.default.fileExists(atPath: output.path) else {
    throw NSError(domain: "原生抽帧", code: 2, userInfo: [NSLocalizedDescriptionKey: "拒绝覆盖已有文件"])
}
let asset = AVURLAsset(url: URL(fileURLWithPath: CommandLine.arguments[1]))
let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
generator.requestedTimeToleranceBefore = .zero
generator.requestedTimeToleranceAfter = .zero
generator.dynamicRangePolicy = .forceSDR
let frame = try generator.copyCGImage(at: CMTime(seconds: seconds, preferredTimescale: 600), actualTime: nil)
let png = NSBitmapImageRep(cgImage: frame).representation(using: .png, properties: [:])!
try png.write(to: output)
