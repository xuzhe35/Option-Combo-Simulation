// Offline macOS OCR. Output is untrusted text + normalized original-image boxes.
import Foundation
import Vision
import ImageIO
import CoreImage

do {
    guard [2, 3].contains(CommandLine.arguments.count) else { exit(2) }
    let url = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
    guard let image = CGImageSourceCreateWithURL(url as CFURL, nil),
          let properties = CGImageSourceCopyPropertiesAtIndex(image, 0, nil) as? [CFString: Any],
          let width = properties[kCGImagePropertyPixelWidth] as? Int,
          let height = properties[kCGImagePropertyPixelHeight] as? Int,
          width > 0, height > 0, width <= 8192, height <= 8192, width * height <= 20_000_000 else { exit(3) }
    let orientation = CGImagePropertyOrientation(rawValue: (properties[kCGImagePropertyOrientation] as? UInt32) ?? 1) ?? .up
    guard let decoded = CGImageSourceCreateImageAtIndex(image, 0, nil) else { exit(3) }
    let upright: CGImage
    if orientation == .up { upright = decoded }
    else {
        let ci = CIImage(cgImage: decoded).oriented(orientation)
        guard let rotated = CIContext(options: [.useSoftwareRenderer: true]).createCGImage(ci, from: ci.extent) else { exit(3) }
        upright = rotated
    }
    func recognize(_ pixels: CGImage) throws -> [VNRecognizedTextObservation] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        request.recognitionLanguages = ["en-US"]
        try VNImageRequestHandler(cgImage: pixels, options: [:]).perform([request])
        return request.results ?? []
    }
    let requestedCrops: [[String: Any]]?
    if CommandLine.arguments.count == 3 {
        requestedCrops = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))) as? [[String: Any]]
    } else { requestedCrops = nil }
    let observations = requestedCrops == nil ? try recognize(upright) : []
    var words = [[String: Any]]()
    var lines = [[String: Any]]()
    var rereads = [[String: Any]]()
    func box(_ b: CGRect) -> [Double] {
        [b.minX, 1 - b.maxY, b.width, b.height].map { abs($0) < 0.0000001 ? 0 : abs($0 - 1) < 0.0000001 ? 1 : $0 }
    }
    let regex = try NSRegularExpression(pattern: "\\S+")
    let shortCode = try NSRegularExpression(pattern: "^\\(?[A-Z][A-Z0-9.]{0,11}\\)?$")
    // OCR word rectangles can include leading background even when both scales agree.
    // Measure contrasting glyph pixels inside each local word; never infer indentation
    // from a ticker, strategy name or assumed number of legs.
    func inkBounds(_ rect: CGRect, context: CGContext, padding: Int) -> CGRect? {
        guard let data = context.data else { return nil }
        let bytes = data.assumingMemoryBound(to: UInt8.self), stride = context.bytesPerRow
        let x0 = max(0, Int(floor(rect.minX)) - padding), x1 = min(context.width, Int(ceil(rect.maxX)) + padding)
        let y0 = max(0, Int(floor(rect.minY)) - padding), y1 = min(context.height, Int(ceil(rect.maxY)) + padding)
        guard x1 > x0, y1 > y0 else { return nil }
        var histogram = [Int: Int]()
        for y in y0..<y1 { for x in x0..<x1 {
            let i = y * stride + x * 4
            let key = (Int(bytes[i]) / 16) * 256 + (Int(bytes[i + 1]) / 16) * 16 + Int(bytes[i + 2]) / 16
            histogram[key, default: 0] += 1
        }}
        guard let background = histogram.max(by: { $0.value < $1.value })?.key else { return nil }
        let bg = [(background / 256) * 16 + 8, ((background / 16) % 16) * 16 + 8, (background % 16) * 16 + 8]
        var minX = x1, maxX = x0, minY = y1, maxY = y0, count = 0
        let minColumnPixels = max(2, Int(Double(y1 - y0) * 0.12))
        var columns = [(x: Int, ys: [Int])]()
        for x in x0..<x1 {
            var ys = [Int]()
            for y in y0..<y1 {
                let i = y * stride + x * 4
                let contrast = abs(Int(bytes[i]) - bg[0]) + abs(Int(bytes[i + 1]) - bg[1]) + abs(Int(bytes[i + 2]) - bg[2])
                if contrast >= 180 { ys.append(y) }
            }
            if ys.count >= minColumnPixels { columns.append((x, ys)) }
        }
        // The padded box can clip the last glyph of the neighbouring cell (e.g. the final
        // digit of a P&L value). A narrow ink run on the box edge, separated from the word's
        // own ink by more than letter spacing, belongs to that neighbour (same rule as headerInk).
        var runs = [[(x: Int, ys: [Int])]]()
        for column in columns {
            if let last = runs.last?.last, column.x == last.x + 1 { runs[runs.count - 1].append(column) } else { runs.append([column]) }
        }
        // y1 - y0 is the padded OCR box, often twice the glyph height; letter spacing stays far below 0.3 of it.
        let gap = max(3, Int(Double(y1 - y0) * 0.3)), narrow = max(2, (x1 - x0) / 5)
        if runs.count > 1, runs[0][0].x <= x0 + 1, runs[0].count <= narrow, runs[1][0].x - runs[0].last!.x > gap { runs.removeFirst() }
        if runs.count > 1, runs[runs.count - 1].last!.x >= x1 - 2, runs[runs.count - 1].count <= narrow,
           runs[runs.count - 1][0].x - runs[runs.count - 2].last!.x > gap { runs.removeLast() }
        for column in runs.joined() {
            minX = min(minX, column.x); maxX = max(maxX, column.x)
            minY = min(minY, column.ys[0]); maxY = max(maxY, column.ys[column.ys.count - 1]); count += column.ys.count
        }
        guard maxX >= minX, maxY >= minY, count >= 4,
              Double(maxY - minY + 1) >= rect.height * 0.25,
              Double(maxX - minX + 1) >= rect.width * 0.3 else { return nil }
        return CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)
    }
    // Header word rectangles can clip a sliver of the neighbouring label's last glyph.
    // An ink run that touches the rectangle edge and is separated from the word's own
    // ink by more than letter spacing belongs to the neighbour; a rectangle holding only
    // such a sliver is reported as a fragment instead of a glyph of its own.
    func headerInk(_ rect: CGRect, context: CGContext) -> (bounds: CGRect?, fragmentOnly: Bool) {
        guard let data = context.data else { return (nil, false) }
        let bytes = data.assumingMemoryBound(to: UInt8.self), stride = context.bytesPerRow
        let x0 = max(0, Int(floor(rect.minX))), x1 = min(context.width, Int(ceil(rect.maxX)))
        let y0 = max(0, Int(floor(rect.minY))), y1 = min(context.height, Int(ceil(rect.maxY)))
        guard x1 > x0, y1 > y0 else { return (nil, false) }
        var histogram = [Int: Int]()
        for y in y0..<y1 { for x in x0..<x1 {
            let i = y * stride + x * 4
            histogram[(Int(bytes[i]) / 16) * 256 + (Int(bytes[i + 1]) / 16) * 16 + Int(bytes[i + 2]) / 16, default: 0] += 1
        }}
        guard let background = histogram.max(by: { $0.value < $1.value })?.key else { return (nil, false) }
        let bg = [(background / 256) * 16 + 8, ((background / 16) % 16) * 16 + 8, (background % 16) * 16 + 8]
        let minColumnPixels = max(2, Int(Double(y1 - y0) * 0.12))
        var columns = [Int: (Int, Int, Int)]()
        for x in x0..<x1 {
            var ys = [Int]()
            for y in y0..<y1 {
                let i = y * stride + x * 4
                if abs(Int(bytes[i]) - bg[0]) + abs(Int(bytes[i + 1]) - bg[1]) + abs(Int(bytes[i + 2]) - bg[2]) >= 180 { ys.append(y) }
            }
            if ys.count >= minColumnPixels { columns[x] = (ys[0], ys[ys.count - 1], ys.count) }
        }
        var runs = [(Int, Int)](), start: Int? = nil
        for x in x0...x1 {
            if x < x1, columns[x] != nil { if start == nil { start = x } }
            else if let first = start { runs.append((first, x)); start = nil }
        }
        guard !runs.isEmpty else { return (nil, false) }
        let gap = max(3, Int(Double(y1 - y0) * 0.6))
        let edgeSliver = { (run: (Int, Int)) -> Bool in run.1 - run.0 <= max(2, (x1 - x0) / 5) }
        if runs.count == 1, (runs[0].0 <= x0 + 1 || runs[0].1 >= x1 - 1), edgeSliver(runs[0]) { return (nil, true) }
        if runs.count > 1, runs[0].0 <= x0 + 1, edgeSliver(runs[0]), runs[1].0 - runs[0].1 >= gap { runs.removeFirst() }
        if runs.count > 1, runs[runs.count - 1].1 >= x1 - 1, edgeSliver(runs[runs.count - 1]),
           runs[runs.count - 1].0 - runs[runs.count - 2].1 >= gap { runs.removeLast() }
        let kept = (runs[0].0..<runs[runs.count - 1].1).compactMap { columns[$0] }
        let minX = runs[0].0, maxX = runs[runs.count - 1].1 - 1
        guard let minY = kept.map({ $0.0 }).min(), let maxY = kept.map({ $0.1 }).max(),
              kept.reduce(0, { $0 + $1.2 }) >= 4,
              Double(maxY - minY + 1) >= rect.height * 0.25,
              Double(maxX - minX + 1) >= rect.width * 0.3 else { return (nil, false) }
        return (CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1), false)
    }
    // A solitary digit can be missed by Vision's line detector in a wide cell.
    // Locate actual neutral, bright glyph pixels inside the already bounded
    // numeric cell, then retry a tighter source crop. No character is inferred.
    func numericGlyphBounds(_ rect: CGRect, padding: Int = 2) -> CGRect? {
        guard let image = upright.cropping(to: rect), let context = CGContext(data: nil, width: image.width, height: image.height,
            bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard let data = context.data else { return nil }
        let bytes = data.assumingMemoryBound(to: UInt8.self)
        var x0 = image.width, y0 = image.height, x1 = 0, y1 = 0, count = 0
        for y in 0..<image.height { for x in 0..<image.width {
            let i = y * context.bytesPerRow + x * 4, rgb = (0..<3).map { Int(bytes[i + $0]) }
            if rgb.min()! >= 110, rgb.max()! - rgb.min()! <= 90 {
                x0 = min(x0, x); x1 = max(x1, x); y0 = min(y0, y); y1 = max(y1, y); count += 1
            }
        }}
        guard count >= 8, x1 - x0 >= 1, y1 - y0 >= 3 else { return nil }
        let measured = CGRect(x: rect.minX + Double(max(0, x0 - padding)), y: rect.minY + Double(max(0, y0 - padding)),
            width: Double(min(image.width - 1, x1 + padding) - max(0, x0 - padding) + 1), height: Double(min(image.height - 1, y1 + padding) - max(0, y0 - padding) + 1))
        return measured.width * measured.height < rect.width * rect.height * 0.75 ? measured : nil
    }
    // Repeat the SAME source patch to give the line detector enough text extent.
    // No font, template, expected digit or synthetic text is introduced. Every copy
    // must be present in the complete repeated numeric text; both scales must agree.
    func repeatedGlyphRead(_ focused: CGRect, scale: Int, neutralMask: Bool = false) throws -> [[String: Any]]? {
        guard let crop = upright.cropping(to: focused) else { return nil }
        var accepted = [[String: Any]]()
        // Two text extents address line-detector size limits, not character identity.
        for (count, spacing) in [(3, 1), (7, 4)] {
            let margin = crop.height * scale, gap = spacing * scale, tile = crop.width * scale + gap
            let w = margin * 2 + tile * count, h = margin * 2 + crop.height * scale
            guard w <= 8192, h <= 8192, w * h <= 20_000_000,
                  let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { continue }
            ctx.setFillColor(CGColor(gray: 0, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
            ctx.interpolationQuality = .high
            for i in 0..<count { ctx.draw(crop, in: CGRect(x: margin + i * tile, y: margin, width: crop.width * scale, height: crop.height * scale)) }
            // A second representation uses the SAME neutral-ink test as the
            // source locator. No morphology, character templates or substitutions.
            if neutralMask, let data = ctx.data {
                let bytes = data.assumingMemoryBound(to: UInt8.self)
                for y in 0..<h { for x in 0..<w {
                    let i = y * ctx.bytesPerRow + x * 4, rgb = (0..<3).map { Int(bytes[i + $0]) }
                    let value: UInt8 = rgb.min()! >= 110 && rgb.max()! - rgb.min()! <= 90 ? 255 : 0
                    for channel in 0..<3 { bytes[i + channel] = value }
                }}
            }
            guard let image = ctx.makeImage() else { continue }
            let observations = try recognize(image)
            // Vision can split the copies into adjacent words, but supplies only
            // word boxes. Require complete, non-overlapping coverage of the line.
            let ordered = observations.sorted { $0.boundingBox.minX < $1.boundingBox.minX }
            guard !ordered.isEmpty, ordered.allSatisfy({ let y = (1 - $0.boundingBox.midY) * Double(h); return y >= Double(margin) && y <= Double(margin + crop.height * scale) }),
                  zip(ordered, ordered.dropFirst()).allSatisfy({ $0.boundingBox.maxX <= $1.boundingBox.minX + 0.0000001 }) else { continue }
            let candidates = ordered.compactMap { $0.topCandidates(1).first }
            guard candidates.count == ordered.count else { continue }
            let text = candidates.map { $0.string.filter { !$0.isWhitespace } }.joined(), chars = Array(text)
            guard !chars.isEmpty, chars.count % count == 0 else { continue }
            let length = chars.count / count, token = String(chars.prefix(length))
            let copies = (0..<count).map { String(chars[($0 * length)..<(($0 + 1) * length)]) }
            let r = ordered.map { $0.boundingBox }.reduce(CGRect.null) { $0.union($1) }, left = r.minX * Double(w), right = r.maxX * Double(w)
            guard copies.allSatisfy({ $0 == token }),
                  token.range(of: "^[+-]?[0-9]+(?:[,.][0-9]+)*%?$", options: .regularExpression) != nil,
                  left >= Double(margin - scale * 2), right <= Double(margin + tile * count + scale * 2),
                  left < Double(margin + crop.width * scale / 2), right > Double(margin + tile * (count - 1) + crop.width * scale / 2) else { continue }
            let b = [focused.minX / Double(upright.width), focused.minY / Double(upright.height), focused.width / Double(upright.width), focused.height / Double(upright.height)]
            accepted.append(["text": token, "confidence": candidates.map { $0.confidence }.min() ?? 0, "bbox": b, "inkBbox": b,
                "numericGlyphCrop": b, "glyphRepeatEvidence": ["method": "identical_source_patch", "copies": copies,
                    "recognizedText": text, "sourceBbox": b, "preprocessing": neutralMask ? "neutral_ink_mask" : "original", "canvasBox": box(r), "canvasSize": [w, h],
                    "tileWidth": tile, "margin": margin, "scale": scale]])
        }
        if accepted.isEmpty, !neutralMask { return try repeatedGlyphRead(focused, scale: scale, neutralMask: true) }
        guard !accepted.isEmpty, Set(accepted.compactMap { $0["text"] as? String }).count == 1 else { return nil }
        return [accepted[0]]
    }
    func readScaled(_ cropRect: CGRect, scale: Int, padding: Int, headerMode: Bool, measureAll: Bool = false, numericMode: Bool = false) throws -> [[String: Any]]? {
        guard let crop = upright.cropping(to: cropRect) else { return nil }
        let w = crop.width * scale + padding * 2, h = crop.height * scale + padding * 2
        guard w <= 8192, h <= 8192, w * h <= 20_000_000,
              let context = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        context.interpolationQuality = .high
        context.setFillColor(CGColor(gray: 0, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: w, height: h))
        context.draw(crop, in: CGRect(x: padding, y: padding, width: crop.width * scale, height: crop.height * scale))
        guard let enlarged = context.makeImage() else { return nil }
        var localWords = [[String: Any]]()
        for localObservation in try recognize(enlarged) {
            guard let local = localObservation.topCandidates(1).first else { continue }
            let localText = local.string
            for match in regex.matches(in: localText, range: NSRange(localText.startIndex..., in: localText)) {
                guard let range = Range(match.range, in: localText) else { continue }
                let r = try local.boundingBox(for: range)?.boundingBox ?? localObservation.boundingBox
                let globalBox = [(cropRect.minX + (r.minX * Double(w) - Double(padding)) / Double(scale)) / Double(upright.width),
                    (cropRect.minY + ((1 - r.maxY) * Double(h) - Double(padding)) / Double(scale)) / Double(upright.height),
                    r.width * Double(w) / Double(scale) / Double(upright.width), r.height * Double(h) / Double(scale) / Double(upright.height)]
                let token = String(localText[range])
                var localWord: [String: Any] = ["text": token, "confidence": local.confidence, "bbox": globalBox]
                let wordRect = CGRect(x: r.minX * Double(w), y: (1 - r.maxY) * Double(h), width: r.width * Double(w), height: r.height * Double(h))
                var ink: CGRect? = nil
                if headerMode {
                    let measured = headerInk(wordRect, context: context)
                    ink = measured.bounds
                    if measured.fragmentOnly { localWord["inkEvidence"] = "edge_fragment_only" }
                } else if measureAll || shortCode.firstMatch(in: token, range: NSRange(token.startIndex..., in: token)) != nil {
                    ink = inkBounds(wordRect, context: context, padding: measureAll ? 0 : 2 * scale)
                }
                if let ink {
                    localWord["inkBbox"] = [(cropRect.minX + (ink.minX - Double(padding)) / Double(scale)) / Double(upright.width),
                        (cropRect.minY + (ink.minY - Double(padding)) / Double(scale)) / Double(upright.height),
                        ink.width / Double(scale) / Double(upright.width), ink.height / Double(scale) / Double(upright.height)]
                }
                localWords.append(localWord)
            }
        }
        let numericToken = try NSRegularExpression(pattern: "^[+-]?[0-9]+(?:[,.][0-9]+)*%?$")
        let hasOnlyProvenOrnaments = localWords.contains { word in let t = word["text"] as? String ?? ""; return numericToken.firstMatch(in: t, range: NSRange(t.startIndex..., in: t)) == nil } && localWords.allSatisfy { word in
            let t = word["text"] as? String ?? ""
            if numericToken.firstMatch(in: t, range: NSRange(t.startIndex..., in: t)) != nil { return true }
            guard !t.contains(where: { $0.isLetter || $0.isNumber }), let b = word["bbox"] as? [Double] else { return false }
            let original = CGRect(x: b[0], y: 1 - b[1] - b[3], width: b[2], height: b[3])
            return coloredSquare(original)?["neutralInkPixels"] as? Int == 0
        }
        if numericMode, (localWords.isEmpty || hasOnlyProvenOrnaments), let focused = numericGlyphBounds(cropRect) {
            if let words = try readScaled(focused, scale: scale, padding: padding, headerMode: false, measureAll: true), !words.isEmpty {
                return words.map { word in var w = word; w["numericGlyphCrop"] = [focused.minX / Double(upright.width), focused.minY / Double(upright.height), focused.width / Double(upright.width), focused.height / Double(upright.height)]
                    if hasOnlyProvenOrnaments { w["ornamentIsolationEvidence"] = ["method": "source_square_exclusion", "originalWords": localWords] }
                    return w }
            }
            if localWords.isEmpty, let tight = numericGlyphBounds(cropRect, padding: 0), let repeated = try repeatedGlyphRead(tight, scale: scale) { return repeated }
        }
        return localWords
    }
    func rereadCrop(_ cropRect: CGRect, scales: [Int] = [2, 3], padded: Bool = false, headerMode: Bool = false, measureAll: Bool = false, numericMode: Bool = false) throws -> [[String: Any]] {
        var passes = [[String: Any]]()
        for scale in scales {
            let padding = padded || scales == [3, 4] ? 8 * scale : 0
            let maxWidth = (8192 - padding * 2) / scale
            if !headerMode || Int(cropRect.width) <= maxWidth {
                if let words = try readScaled(cropRect, scale: scale, padding: padding, headerMode: headerMode, measureAll: measureAll, numericMode: numericMode) {
                    var pass: [String: Any] = ["scale": scale, "words": words]
                    if numericMode, let ink = numericGlyphBounds(cropRect) { pass["numericInkBbox"] = [ink.minX / Double(upright.width), ink.minY / Double(upright.height), ink.width / Double(upright.width), ink.height / Double(upright.height)] }
                    passes.append(pass)
                }
                continue
            }
            // A wide header is read in overlapping horizontal tiles at the same scale. Each
            // word is kept only by the tile whose core holds its centre; the overlap is a
            // third of a tile, far wider than any header word, so a word clipped at one
            // tile edge is read whole by its neighbour.
            let overlap = maxWidth / 3, step = maxWidth - overlap
            var starts = [Int](), x = Int(cropRect.minX)
            while true { starts.append(x); if x + maxWidth >= Int(cropRect.maxX) { break }; x += step }
            var words = [[String: Any]](), tiles = [[Double]](), complete = true
            for (index, start) in starts.enumerated() {
                let tile = CGRect(x: Double(start), y: cropRect.minY, width: Double(min(maxWidth, Int(cropRect.maxX) - start)), height: cropRect.height)
                guard let tileWords = try readScaled(tile, scale: scale, padding: padding, headerMode: true) else { complete = false; break }
                let coreLeft = index == 0 ? -Double.infinity : Double(start + overlap / 2) / Double(upright.width)
                let coreRight = index == starts.count - 1 ? Double.infinity : Double(starts[index + 1] + overlap / 2) / Double(upright.width)
                words += tileWords.filter { word in
                    guard let b = word["bbox"] as? [Double] else { return false }
                    return b[0] + b[2] / 2 >= coreLeft && b[0] + b[2] / 2 < coreRight
                }
                tiles.append([tile.minX / Double(upright.width), tile.width / Double(upright.width)])
            }
            if complete {
                words.sort { (($0["bbox"] as? [Double])?[0] ?? 0) < (($1["bbox"] as? [Double])?[0] ?? 0) }
                passes.append(["scale": scale, "words": words, "tiles": tiles])
            }
        }
        return passes
    }
    func coloredSquare(_ b: CGRect) -> [String: Any]? {
        let rect = CGRect(x: b.minX * Double(upright.width), y: (1 - b.maxY) * Double(upright.height),
            width: b.width * Double(upright.width), height: b.height * Double(upright.height)).integral
        guard let pixels = upright.cropping(to: rect), let context = CGContext(data: nil, width: pixels.width, height: pixels.height,
            bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        context.draw(pixels, in: CGRect(x: 0, y: 0, width: pixels.width, height: pixels.height))
        guard let data = context.data else { return nil }
        let bytes = data.assumingMemoryBound(to: UInt8.self)
        var xs = [Int](), ys = [Int](), neutralInkPixels = 0
        for y in 0..<pixels.height { for x in 0..<pixels.width {
            let i = y * context.bytesPerRow + x * 4, rgb = (0..<3).map { Int(bytes[i + $0]) }
            if rgb.max()! >= 120, rgb.max()! - rgb.min()! >= 100 { xs.append(x); ys.append(y) }
            if rgb.min()! >= 110, rgb.max()! - rgb.min()! <= 90 { neutralInkPixels += 1 }
        }}
        guard let x0 = xs.min(), let x1 = xs.max(), let y0 = ys.min(), let y1 = ys.max() else { return nil }
        let w = x1 - x0 + 1, h = y1 - y0 + 1, fill = Double(xs.count) / Double(w * h)
        guard w >= 3, h >= 3, Double(w) / Double(h) >= 0.75, Double(w) / Double(h) <= 1.35, fill >= 0.75 else { return nil }
        return ["method": "compact_colored_square", "fill": fill, "neutralInkPixels": neutralInkPixels,
            "inkBbox": [(rect.minX + Double(x0)) / Double(upright.width), (rect.minY + Double(y0)) / Double(upright.height),
                Double(w) / Double(upright.width), Double(h) / Double(upright.height)]]
    }
    for (lineId, observation) in observations.enumerated() {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let text = candidate.string
        lines.append(["text": text, "confidence": candidate.confidence, "bbox": box(observation.boundingBox)])
        for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            guard let range = Range(match.range, in: text) else { continue }
            let rect = try candidate.boundingBox(for: range)?.boundingBox ?? observation.boundingBox
            let token = String(text[range])
            var word: [String: Any] = ["text": token, "confidence": candidate.confidence, "bbox": box(rect), "lineId": lineId]
            if !token.contains(where: { $0.isLetter || $0.isNumber }), let evidence = coloredSquare(rect) { word["decorationEvidence"] = evidence }
            words.append(word)
        }
        let tokens = text.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        let hasCode = tokens.contains { shortCode.firstMatch(in: $0, range: NSRange($0.startIndex..., in: $0)) != nil }
        // Generic text-line rereading: no ticker dictionary, sample coordinates or replacement rules.
        guard tokens.count >= 3, hasCode, observation.boundingBox.width <= 0.6,
              rereads.count < 96 else { continue }
        let b = observation.boundingBox
        let pad = max(4.0, b.height * Double(upright.height) * 0.4)
        let cropRect = CGRect(x: b.minX * Double(upright.width) - pad,
            y: (1 - b.maxY) * Double(upright.height) - pad,
            width: b.width * Double(upright.width) + 2 * pad,
            height: b.height * Double(upright.height) + 2 * pad).integral
            .intersection(CGRect(x: 0, y: 0, width: upright.width, height: upright.height))
        let passes = try rereadCrop(cropRect)
        rereads.append(["lineId": lineId, "cropBbox": [cropRect.minX / Double(upright.width),
            cropRect.minY / Double(upright.height), cropRect.width / Double(upright.width), cropRect.height / Double(upright.height)], "passes": passes])
    }
    // Header rereads keep all labels, including unknown columns. Fused-word
    // cut candidates come from repeated body-number right edges and nearby ink gaps,
    // and only when both fragment texts agree at two scales and reconstruct it.
    // No column coordinates, letter counts, symbols or portfolio values live here.
    func letters(_ text: String) -> String { text.uppercased().filter { $0.isLetter || $0.isNumber } }
    func pixelRuns(_ rect: CGRect) -> [(Int, Int)] {
        guard let pixels = upright.cropping(to: rect),
              let context = CGContext(data: nil, width: pixels.width, height: pixels.height, bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return [] }
        context.draw(pixels, in: CGRect(x: 0, y: 0, width: pixels.width, height: pixels.height))
        guard let data = context.data else { return [] }
        let bytes = data.assumingMemoryBound(to: UInt8.self), stride = context.bytesPerRow
        var hist = [Int: Int]()
        for y in 0..<pixels.height { for x in 0..<pixels.width {
            let i = y * stride + x * 4
            hist[Int(bytes[i] / 16) * 256 + Int(bytes[i + 1] / 16) * 16 + Int(bytes[i + 2] / 16), default: 0] += 1
        }}
        guard let bg = hist.max(by: { $0.value < $1.value })?.key else { return [] }
        let background = [(bg / 256) * 16 + 8, ((bg / 16) % 16) * 16 + 8, (bg % 16) * 16 + 8]
        var runs = [(Int, Int)](), start: Int? = nil
        for x in 0...pixels.width {
            var count = 0
            if x < pixels.width { for y in 0..<pixels.height {
                let i = y * stride + x * 4
                if (0..<3).reduce(0, { $0 + abs(Int(bytes[i + $1]) - background[$1]) }) >= 120 { count += 1 }
            }}
            let ink = count >= max(2, pixels.height / 10)
            if ink, start == nil { start = x }
            if !ink, let first = start { runs.append((first, x)); start = nil }
        }
        return runs
    }
    func splitHeader(_ word: [String: Any], anchors: [Double]) throws -> [[[String: Any]]]? {
        guard let token = word["text"] as? String, letters(token).count >= 6,
              let b = word["bbox"] as? [Double] else { return nil }
        let observed = word["observationBbox"] as? [Double] ?? b
        let region = CGRect(x: observed[0] * Double(upright.width), y: observed[1] * Double(upright.height),
            width: observed[2] * Double(upright.width), height: observed[3] * Double(upright.height)).integral
            .intersection(CGRect(x: 0, y: 0, width: upright.width, height: upright.height))
        let runs = pixelRuns(region)
        guard runs.count > 1 else { return nil }
        let gaps = (1..<runs.count).map { Double(runs[$0 - 1].1 + runs[$0].0) / 2 + region.minX }
        let cuts = Set(anchors.filter { $0 > region.minX + region.height * 0.5 && $0 < region.maxX - region.height * 0.5 }
            .flatMap { anchor in [floor(anchor), ceil(anchor)] + Array(gaps.filter { abs($0 - anchor) < region.height * 0.65 }.sorted { abs($0 - anchor) < abs($1 - anchor) }.prefix(2)) })
        var solutions = [[[String: Any]]]()
        for cut in cuts.sorted() {
            let y = max(0, region.minY - region.height * 0.2), bottom = min(Double(upright.height), region.maxY + region.height * 0.2)
            let rects = [CGRect(x: region.minX, y: y, width: cut - region.minX, height: bottom - y),
                CGRect(x: cut, y: y, width: region.maxX - cut, height: bottom - y)]
            var parts = [[String: Any]]()
            for rect in rects {
                let passes = try rereadCrop(rect.integral, padded: true, headerMode: true)
                guard passes.count == 2 else { break }
                let texts = passes.map { pass in (pass["words"] as? [[String: Any]] ?? []).map { $0["text"] as? String ?? "" }.joined() }
                guard texts[0] == texts[1], letters(texts[0]).count >= 2,
                      let firstWords = passes[0]["words"] as? [[String: Any]], !firstWords.isEmpty else { break }
                let bounds = firstWords.compactMap { ($0["inkBbox"] ?? $0["bbox"]) as? [Double] }
                let left = bounds.map { $0[0] }.min()!, right = bounds.map { $0[0] + $0[2] }.max()!
                guard left >= b[0] - 0.001, right <= b[0] + b[2] + 0.001 else { break }
                parts.append(["text": texts[0], "bbox": [max(left, b[0]), b[1], min(right, b[0] + b[2]) - max(left, b[0]), b[3]],
                    "coordinateEvidence": "body_alignment_crop_consensus", "passes": passes,
                    "cutX": cut / Double(upright.width)])
            }
            if parts.count == 2, parts.map({ letters($0["text"] as? String ?? "") }).joined() == letters(token) { solutions.append(parts) }
        }
        // The browser admits only one supported semantic split, with exact text
        // reconstruction; it still requires all column labels uniquely in order.
        return solutions.isEmpty ? nil : solutions
    }
    // A filled sort triangle is often read as 'A'. Prove its filled, widening
    // scan lines; an actual letter A has a hole and must remain an unknown label.
    func sortControl(_ word: [String: Any]) -> [[String: Any]]? {
        guard let text = word["text"] as? String, text == "A" || text.hasSuffix("+A"),
              let b = word["bbox"] as? [Double] else { return nil }
        let region = CGRect(x: b[0] * Double(upright.width), y: b[1] * Double(upright.height),
            width: b[2] * Double(upright.width), height: b[3] * Double(upright.height)).integral
        guard let run = pixelRuns(region).last,
              let pixels = upright.cropping(to: region),
              let context = CGContext(data: nil, width: pixels.width, height: pixels.height, bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        context.draw(pixels, in: CGRect(x: 0, y: 0, width: pixels.width, height: pixels.height))
        guard let data = context.data else { return nil }
        let bytes = data.assumingMemoryBound(to: UInt8.self)
        var widths = [Int](), holes = 0
        for y in 0..<pixels.height {
            let xs = (run.0..<run.1).filter { x in let i = y * context.bytesPerRow + x * 4; return Int(bytes[i]) + Int(bytes[i + 1]) + Int(bytes[i + 2]) > 450 }
            if let first = xs.first, let last = xs.last { widths.append(last - first + 1); if xs.count < last - first { holes += 1 } }
        }
        guard widths.count >= 5, holes <= 1, let first = widths.first, let last = widths.last,
              abs(first - last) >= (run.1 - run.0) / 2 else { return nil }
        let sign = first < last ? 1 : -1
        guard zip(widths, widths.dropFirst()).filter({ ($0.1 - $0.0) * sign >= -1 }).count >= widths.count - 2 else { return nil }
        let split = (region.minX + Double(run.0)) / Double(upright.width)
        var parts = [[String: Any]]()
        if text != "A" { parts.append(["text": String(text.dropLast()), "bbox": [b[0], b[1], split - b[0], b[3]]]) }
        parts.append(["text": "▲", "bbox": [max(split, b[0]), b[1], b[0] + b[2] - max(split, b[0]), b[3]], "coordinateEvidence": "filled_sort_triangle"])
        return parts
    }
    // A window or grid frame line beside a header symbol is often read as '|'. Prove it
    // from pixels: a thin column, uniform over at least three text heights and set off
    // from both neighbouring columns, is a rule and not a glyph (a glyph is one text high).
    func frameRule(_ word: [String: Any]) -> [String: Any]? {
        guard let text = word["text"] as? String, text.contains("|"),
              !text.contains(where: { $0.isLetter || $0.isNumber }),
              let b = word["bbox"] as? [Double] else { return nil }
        let height = b[3] * Double(upright.height), centerY = (b[1] + b[3] / 2) * Double(upright.height)
        let y0 = max(0, Int(centerY - height * 2)), y1 = min(upright.height, Int(centerY + height * 2))
        let x0 = max(0, Int(b[0] * Double(upright.width)) - 6), x1 = min(upright.width, Int((b[0] + b[2]) * Double(upright.width)) + 6)
        guard height >= 4, Double(y1 - y0) >= height * 3, x1 - x0 > 8,
              let pixels = upright.cropping(to: CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)),
              let context = CGContext(data: nil, width: pixels.width, height: pixels.height, bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        context.draw(pixels, in: CGRect(x: 0, y: 0, width: pixels.width, height: pixels.height))
        guard let data = context.data else { return nil }
        let bytes = data.assumingMemoryBound(to: UInt8.self)
        let columns = (0..<pixels.width).map { x -> (mean: Double, spread: Int) in
            let values = (0..<pixels.height).map { y -> Int in
                let i = y * context.bytesPerRow + x * 4; return (Int(bytes[i]) + Int(bytes[i + 1]) + Int(bytes[i + 2])) / 3 }
            return (Double(values.reduce(0, +)) / Double(values.count), values.max()! - values.min()!)
        }
        let rule = (0..<pixels.width).filter { x in
            let left = x >= 4 ? abs(columns[x].mean - columns[x - 4].mean) >= 30 : x0 == 0
            let right = x + 4 < pixels.width ? abs(columns[x].mean - columns[x + 4].mean) >= 30 : x1 == upright.width
            // At the true image edge only one neighbour exists. The line still
            // needs the same long uniform run and narrow width; never infer it
            // at an interior crop edge or from an OCR rectangle alone.
            return columns[x].spread <= 24 && left && right
        }
        guard let first = rule.first, let last = rule.last, last - first + 1 <= max(3, Int(height / 4)),
              rule.count == last - first + 1 else { return nil }
        let x = Double(x0 + first) / Double(upright.width), center = b[0] + b[2] / 2
        return ["side": x < center ? "left" : "right", "bbox": [x, Double(y0) / Double(upright.height),
            Double(last - first + 1) / Double(upright.width), Double(y1 - y0) / Double(upright.height)]]
    }
    var headerRereads = [[String: Any]]()
    if let instrument = words.first(where: { letters($0["text"] as? String ?? "").contains("INSTRUMENT") }),
       let ib = instrument["bbox"] as? [Double] {
        let cy = ib[1] + ib[3] / 2
        let row = words.filter { guard let b = $0["bbox"] as? [Double] else { return false }; return abs(b[1] + b[3] / 2 - cy) < min(b[3], ib[3]) * 0.5 }
        let boxes = row.compactMap { $0["bbox"] as? [Double] }
        let top = boxes.map { $0[1] }.min()!, bottom = boxes.map { $0[1] + $0[3] }.max()!, pad = (bottom - top) * 0.25
        let region = CGRect(x: 0, y: max(0, top - pad) * Double(upright.height), width: Double(upright.width),
            height: (min(1, bottom + pad) - max(0, top - pad)) * Double(upright.height)).integral
        let numeric = words.compactMap { word -> Double? in
            guard let t = word["text"] as? String, t.range(of: "^[+-]?[0-9][0-9,.]*%?$", options: .regularExpression) != nil,
                  let b = word["bbox"] as? [Double], b[1] > bottom else { return nil }
            return (b[0] + b[2]) * Double(upright.width)
        }
        let tolerance = (bottom - top) * Double(upright.height) * 0.15
        var clusters = [[Double]]()
        for x in numeric.sorted() {
            if let last = clusters.last, x - last[0] <= tolerance { clusters[clusters.count - 1].append(x) }
            else { clusters.append([x]) }
        }
        let anchors = clusters.filter { $0.count >= 3 }.map { $0.reduce(0, +) / Double($0.count) }
        // Preserve the established header reads. Retry with neutral padding only
        // if a returned rectangle actually protrudes outside the source image;
        // unconditional padding changes Vision's segmentation of valid headers.
        var headerPasses = try rereadCrop(region, headerMode: true)
        let protrudes = headerPasses.contains { pass in
            (pass["words"] as? [[String: Any]] ?? []).contains { word in
                guard let b = (word["inkBbox"] ?? word["bbox"]) as? [Double], b.count == 4 else { return true }
                return b[0] < 0 || b[1] < 0 || b[0] + b[2] > 1.001 || b[1] + b[3] > 1.001
            }
        }
        if protrudes { headerPasses = try rereadCrop(region, padded: true, headerMode: true) }
        for pass in headerPasses {
            var next = pass, local = pass["words"] as? [[String: Any]] ?? []
            for i in local.indices {
                if let rule = frameRule(local[i]) {
                    local[i]["frameRule"] = rule
                    if local[i]["text"] as? String == "|", let observed = local[i]["bbox"] as? [Double],
                       let measured = rule["bbox"] as? [Double], observed[1] >= 0, observed[1] + observed[3] <= 1 {
                        // A frame's actual measured pixels replace its loose OCR
                        // box, which can protrude outside the source image.
                        // Other controls, labels and numbers are never clamped.
                        local[i]["observationBbox"] = observed
                        local[i]["bbox"] = [measured[0], observed[1], measured[2], observed[3]]
                        local[i]["coordinateEvidence"] = "pixel_proven_frame_rule"
                    }
                }
                if let ink = local[i]["inkBbox"] as? [Double] { local[i]["observationBbox"] = local[i]["bbox"]; local[i]["bbox"] = ink }
                if let parts = sortControl(local[i]) { local[i]["headerParts"] = parts }
                else if let parts = try splitHeader(local[i], anchors: anchors) { local[i]["headerPartCandidates"] = parts }
            }
            next["words"] = local; headerRereads.append(next)
        }
    }
    // A vertical frame/gutter edge may be appended to a numeric token. Require
    // a narrow, uniform band over three text heights, then reread the pixels;
    // never remove punctuation from OCR text by string replacement.
    var numericRereads = [[String: Any]]()
    for word in words.prefix(12000) {
        guard let text = word["text"] as? String,
              text.range(of: "^[+-]?[0-9][0-9,.]*%?\\|$", options: .regularExpression) != nil,
              let b = word["bbox"] as? [Double], numericRereads.count < 32 else { continue }
        let rect = CGRect(x: b[0] * Double(upright.width), y: max(0, b[1] - b[3]) * Double(upright.height),
            width: b[2] * Double(upright.width), height: min(1 - max(0, b[1] - b[3]), b[3] * 3) * Double(upright.height)).integral
            .intersection(CGRect(x: 0, y: 0, width: upright.width, height: upright.height))
        guard let pixels = upright.cropping(to: rect), let context = CGContext(data: nil, width: pixels.width, height: pixels.height,
            bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { continue }
        context.draw(pixels, in: CGRect(x: 0, y: 0, width: pixels.width, height: pixels.height))
        guard let data = context.data else { continue }
        let bytes = data.assumingMemoryBound(to: UInt8.self)
        let columns = (0..<pixels.width).filter { x in
            let values = (0..<pixels.height).map { y -> Int in let i = y * context.bytesPerRow + x * 4; return (Int(bytes[i]) + Int(bytes[i + 1]) + Int(bytes[i + 2])) / 3 }
            return (values.max()! - values.min()!) <= 3
        }
        var rule = pixels.width
        while rule > 0, columns.contains(rule - 1) { rule -= 1 }
        guard rule < pixels.width - 1, rule > pixels.width / 2, pixels.width - rule <= max(3, Int(b[3] * Double(upright.height) * 0.35)) else { continue }
        let crop = CGRect(x: rect.minX, y: b[1] * Double(upright.height) - 2, width: Double(rule), height: b[3] * Double(upright.height) + 4).integral
            .intersection(CGRect(x: 0, y: 0, width: upright.width, height: upright.height))
        numericRereads.append(["originalBbox": b, "originalText": text, "method": "vertical_border_crop_consensus",
            "cropBbox": [crop.minX / Double(upright.width), crop.minY / Double(upright.height), crop.width / Double(upright.width), crop.height / Double(upright.height)],
            "passes": try rereadCrop(crop, padded: true), "ruleBbox": [(rect.minX + Double(rule)) / Double(upright.width), rect.minY / Double(upright.height), Double(pixels.width - rule) / Double(upright.width), rect.height / Double(upright.height)]])
    }
    // Column calibration belongs to the browser normalizer only. This helper
    // receives bounded image-space cell crops after a validated header pass.
    var quantityRereads = [[String: Any]]()
    var reviewRereads = [[String: Any]]()
    for item in (requestedCrops ?? []).prefix(1088) {
        guard let field = item["field"] as? String, ["quantity", "descriptionRow", "avgPrice", "dailyPnl", "mark", "costBasis", "unrealizedPnl", "deltaDollars", "marketValue", "theta", "lastPrice", "displayIv"].contains(field), let b = item["cropBbox"] as? [Double], b.count == 4,
              b.allSatisfy({ $0.isFinite && $0 >= 0 && $0 <= 1 }), b[2] > 0, b[3] > 0,
              b[0] + b[2] <= 1.000001, b[1] + b[3] <= 1.000001 else { exit(3) }
        let rect = CGRect(x: b[0] * Double(upright.width), y: b[1] * Double(upright.height),
            width: b[2] * Double(upright.width), height: b[3] * Double(upright.height)).integral
            .intersection(CGRect(x: 0, y: 0, width: upright.width, height: upright.height))
        let evidence: [String: Any] = ["field": field, "cropBbox": [rect.minX / Double(upright.width), rect.minY / Double(upright.height),
            rect.width / Double(upright.width), rect.height / Double(upright.height)],
            "passes": try rereadCrop(rect, scales: field == "descriptionRow" ? [2, 3, 4] : [3, 4], padded: true, measureAll: field != "quantity", numericMode: field != "descriptionRow")]
        if field == "quantity" { quantityRereads.append(evidence) } else { reviewRereads.append(evidence) }
    }
    let result: [String: Any] = ["width": upright.width, "height": upright.height,
        "words": words, "lines": lines, "rereads": rereads, "numericRereads": numericRereads, "headerRereads": headerRereads,
        "quantityRereads": quantityRereads, "reviewRereads": reviewRereads, "reviewProtocol": 1, "engine": "apple-vision",
        "model": "macOS Vision accurate + row-and-cell-review-v8"]
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]))
} catch {
    // Never put image contents or local paths in diagnostics.
    fputs("Local image recognition failed.\n", stderr)
    exit(1)
}
