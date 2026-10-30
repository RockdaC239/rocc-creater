// 历史排查工具：已发现首帧色彩不一致，不用于当前 Agent 原片工程流程。
import AVFoundation
import Foundation

@main struct Convert {
    static func main() async throws {
        guard CommandLine.arguments.count == 3 else {
            throw NSError(domain: "HDR转SDR", code: 1, userInfo: [NSLocalizedDescriptionKey: "用法：HDR转SDR 输入.MOV 输出.mov"])
        }
        let input = URL(fileURLWithPath: CommandLine.arguments[1])
        let output = URL(fileURLWithPath: CommandLine.arguments[2])
        guard !FileManager.default.fileExists(atPath: output.path) else {
            throw NSError(domain: "HDR转SDR", code: 2, userInfo: [NSLocalizedDescriptionKey: "拒绝覆盖已有文件"])
        }
        let asset = AVURLAsset(url: input)
        let composition = AVMutableVideoComposition(propertiesOf: asset)
        composition.colorPrimaries = AVVideoColorPrimaries_ITU_R_709_2
        composition.colorTransferFunction = AVVideoTransferFunction_ITU_R_709_2
        composition.colorYCbCrMatrix = AVVideoYCbCrMatrix_ITU_R_709_2
        composition.frameDuration = CMTime(value: 1, timescale: 30)
        guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleProRes422LPCM) else {
            throw NSError(domain: "HDR转SDR", code: 3, userInfo: [NSLocalizedDescriptionKey: "ProRes 导出不可用"])
        }
        session.videoComposition = composition
        try await session.export(to: output, as: .mov)
    }
}
