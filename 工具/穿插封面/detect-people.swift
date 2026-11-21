import Foundation
import Vision
import ImageIO

do {
    guard CommandLine.arguments.count == 2,
          let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw NSError(domain: "Cover", code: 1, userInfo: [NSLocalizedDescriptionKey: "无法读取检测图片"])
    }
    let people = VNDetectHumanRectanglesRequest()
    people.upperBodyOnly = false
    let faces = VNDetectFaceRectanglesRequest()
    try VNImageRequestHandler(cgImage: image).perform([people, faces])
    let width = Double(image.width), height = Double(image.height)
    var boxes = (people.results ?? []).filter { $0.confidence >= 0.5 }.map { $0.boundingBox }
    // 人脸框不含发型，向上扩展以覆盖发顶，再交给蒙版核实轮廓。
    boxes += (faces.results ?? []).filter { $0.confidence >= 0.5 }.map {
        let b = $0.boundingBox
        return CGRect(x: b.minX - b.width * 0.15, y: b.minY, width: b.width * 1.3, height: b.height * 1.65)
    }
    let output = boxes.map { box in
        ["left": max(0, box.minX * width),
         "top": max(0, (1 - box.maxY) * height),
         "right": min(width, box.maxX * width),
         "bottom": min(height, (1 - box.minY) * height)]
    }
    let data = try JSONSerialization.data(withJSONObject: output)
    FileHandle.standardOutput.write(data)
} catch {
    FileHandle.standardError.write(Data("人物检测失败：\(error)\n".utf8))
    exit(1)
}
