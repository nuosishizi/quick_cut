
import Foundation
import AppKit
import CoreGraphics

enum QuickCutCaptionRasterizer {
    struct Result {
        let image: CGImage
        let width: Int
        let height: Int
    }

    static func render(spec: NativeCaptionRenderSpec, maxWidth: CGFloat, activeWordIndex: Int = -1) -> Result? {
        let scale = NSScreen.main?.backingScaleFactor ?? 2
        let layout = QuickCutTextLayoutSpec(
            fontFamily: spec.fontFamily,
            fontSize: spec.fontSize,
            fontWeight: spec.fontWeight,
            italic: spec.italic,
            letterSpacing: spec.letterSpacing,
            wordSpacing: spec.wordSpacing,
            lineHeight: spec.lineHeight,
            maxWidth: max(1, maxWidth),
            alignment: textAlignment(spec.textAlign)
        )
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = textAlignment(spec.textAlign)
        paragraph.lineBreakMode = .byWordWrapping
        paragraph.minimumLineHeight = spec.fontSize * max(0.75, spec.lineHeight)
        paragraph.maximumLineHeight = paragraph.minimumLineHeight

        let base = NSMutableAttributedString(string: spec.text)
        let full = NSRange(location: 0, length: base.length)
        base.addAttributes([
            .font: layout.font,
            .foregroundColor: spec.textColor,
            .kern: spec.letterSpacing,
            .paragraphStyle: paragraph,
        ], range: full)
        applyWordSpacing(base, amount: spec.wordSpacing)

        let wordRanges = rangesOfWords(in: spec.text)
        if activeWordIndex >= 0, activeWordIndex < wordRanges.count {
            let range = wordRanges[activeWordIndex]
            if spec.highlightEnabled {
                base.addAttribute(.foregroundColor, value: spec.highlightColor, range: range)
            }
            if spec.animation == "word-background" || spec.animation == "karaoke-background" {
                base.addAttribute(.backgroundColor, value: spec.highlightColor.withAlphaComponent(0.88), range: range)
                base.addAttribute(.foregroundColor, value: NSColor.black, range: range)
            }
            if spec.animation == "underline" {
                base.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: range)
                base.addAttribute(.underlineColor, value: spec.highlightColor, range: range)
            }
        }
        if spec.underline && spec.underlineMode == "word" {
            base.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: full)
            base.addAttribute(.underlineColor, value: spec.textColor, range: full)
        }

        let textSystem = makeTextSystem(base, width: max(1, maxWidth))
        let used = textSystem.layout.usedRect(for: textSystem.container)
        let shadowExtra = max(0, spec.shadowDistance + spec.shadowRadius * 1.4)
        let glowExtra = max(0, spec.glowRadius * 2.2)
        let outlineExtra = max(0, spec.strokeWidth * 2.2)
        let backgroundPadX = spec.backgroundEnabled ? max(spec.padding, 0) * max(1, spec.backgroundScaleX) : 0
        let backgroundPadY = spec.backgroundEnabled ? max(spec.padding, 0) * max(1, spec.backgroundScaleY) : 0
        let margin = ceil(max(8, shadowExtra, glowExtra, outlineExtra, backgroundPadX, backgroundPadY) + 6)
        let logicalWidth = ceil(min(maxWidth, max(1, used.width)) + margin * 2)
        let logicalHeight = ceil(max(1, used.height) + margin * 2)
        let pixelWidth = max(2, Int(ceil(logicalWidth * scale)))
        let pixelHeight = max(2, Int(ceil(logicalHeight * scale)))

        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: pixelWidth,
            pixelsHigh: pixelHeight,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else { return nil }

        rep.size = NSSize(width: logicalWidth, height: logicalHeight)
        NSGraphicsContext.saveGraphicsState()
        guard let context = NSGraphicsContext(bitmapImageRep: rep) else {
            NSGraphicsContext.restoreGraphicsState()
            return nil
        }
        NSGraphicsContext.current = context
        context.shouldAntialias = true
        context.imageInterpolation = .high

        let origin = NSPoint(
            x: margin - used.minX + spec.backgroundOffsetX,
            y: margin - used.minY - spec.backgroundOffsetY
        )

        if spec.backgroundEnabled {
            let rect = NSRect(
                x: margin - spec.padding * spec.backgroundScaleX + spec.backgroundOffsetX,
                y: margin - spec.padding * spec.backgroundScaleY - spec.backgroundOffsetY,
                width: used.width + spec.padding * 2 * spec.backgroundScaleX,
                height: used.height + spec.padding * 2 * spec.backgroundScaleY
            )
            let color = spec.backgroundColor.withAlphaComponent(spec.backgroundOpacity)
            color.setFill()
            NSBezierPath(roundedRect: rect, xRadius: spec.radius, yRadius: spec.radius).fill()
        }

        if spec.shadowStrength > 0.01 && spec.shadowOpacity > 0.001 {
            let shadow = NSShadow()
            let angle = spec.shadowAngle * .pi / 180
            shadow.shadowOffset = NSSize(
                width: cos(angle) * spec.shadowDistance,
                height: -sin(angle) * spec.shadowDistance
            )
            shadow.shadowBlurRadius = max(0.1, spec.shadowRadius * (0.75 + min(1.5, spec.shadowStrength / 6)))
            shadow.shadowColor = spec.shadowColor.withAlphaComponent(
                CGFloat(spec.shadowOpacity) * min(1, max(0.18, spec.shadowStrength / 10))
            )
            NSGraphicsContext.saveGraphicsState()
            shadow.set()
            drawAttributed(base, origin: origin, width: maxWidth)
            NSGraphicsContext.restoreGraphicsState()
        }

        if spec.glowRadius > 0.01 {
            let glowSource = mutableCopy(base)
            glowSource.addAttribute(.foregroundColor, value: spec.glowColor.withAlphaComponent(0.35), range: full)
            for multiplier in [1.0, 0.52] {
                let shadow = NSShadow()
                shadow.shadowOffset = .zero
                shadow.shadowBlurRadius = max(1, spec.glowRadius * multiplier)
                shadow.shadowColor = spec.glowColor.withAlphaComponent(multiplier > 0.8 ? 0.82 : 0.52)
                NSGraphicsContext.saveGraphicsState()
                shadow.set()
                drawAttributed(glowSource, origin: origin, width: maxWidth)
                NSGraphicsContext.restoreGraphicsState()
            }
        }

        if spec.strokeWidth > 0.01 {
            let stroke = mutableCopy(base)
            stroke.addAttribute(.foregroundColor, value: spec.strokeColor, range: full)
            stroke.addAttribute(.strokeColor, value: spec.strokeColor, range: full)
            let percent = max(1, min(90, (spec.strokeWidth * 2 / max(1, layout.font.pointSize)) * 100))
            stroke.addAttribute(.strokeWidth, value: percent, range: full)
            drawAttributed(stroke, origin: origin, width: maxWidth)
        }

        drawAttributed(base, origin: origin, width: maxWidth)

        if spec.underline && spec.underlineMode == "line" {
            let thickness = max(1, spec.underlineThickness)
            let y = origin.y - thickness - max(1.5, spec.fontSize * 0.08)
            let lineRect = NSRect(x: origin.x, y: y, width: max(1, used.width), height: thickness)
            spec.textColor.setFill()
            NSBezierPath(roundedRect: lineRect, xRadius: thickness / 2, yRadius: thickness / 2).fill()
        }

        context.flushGraphics()
        NSGraphicsContext.restoreGraphicsState()

        guard let cg = rep.cgImage else { return nil }
        return Result(image: cg, width: pixelWidth, height: pixelHeight)
    }

    static func renderManifest(manifestPath: String, resultPath: String) -> Int32 {
        do {
            let data = try Data(contentsOf: URL(fileURLWithPath: manifestPath))
            guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let jobs = root["jobs"] as? [[String: Any]] else { return 2 }
            var results: [[String: Any]] = []
            for job in jobs {
                let output = string(job, "outputPath", "")
                if output.isEmpty { continue }
                let spec = specFrom(job)
                let maxWidth = CGFloat(number(job, "maxWidth", 900))
                let active = Int(number(job, "activeWordIndex", -1))
                guard let rendered = render(spec: spec, maxWidth: maxWidth, activeWordIndex: active, backingScale: 1) else { continue }
                let rep = NSBitmapImageRep(cgImage: rendered.image)
                guard let png = rep.representation(using: .png, properties: [:]) else { continue }
                try FileManager.default.createDirectory(
                    at: URL(fileURLWithPath: output).deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try png.write(to: URL(fileURLWithPath: output), options: .atomic)
                results.append([
                    "outputPath": output,
                    "width": rendered.width,
                    "height": rendered.height,
                    "logicalWidth": CGFloat(rendered.width) / (NSScreen.main?.backingScaleFactor ?? 2),
                    "logicalHeight": CGFloat(rendered.height) / (NSScreen.main?.backingScaleFactor ?? 2),
                ])
            }
            let resultData = try JSONSerialization.data(withJSONObject: ["results": results], options: [])
            try resultData.write(to: URL(fileURLWithPath: resultPath), options: .atomic)
            return 0
        } catch {
            fputs("Caption rasterizer error: \(error)\n", stderr)
            return 3
        }
    }

    private static func specFrom(_ job: [String: Any]) -> NativeCaptionRenderSpec {
        let style = job["style"] as? [String: Any] ?? [:]
        let scale = CGFloat(number(job, "scale", 1))
        return NativeCaptionRenderSpec(
            text: string(job, "text", ""),
            fontFamily: string(style, "fontFamily", ".System"),
            fontSize: CGFloat(number(style, "fontSize", 54)) * scale,
            fontWeight: Int(number(style, "fontWeight", 700)),
            italic: bool(style, "fontItalic", false),
            letterSpacing: CGFloat(number(style, "letterSpacing", 0)) * scale,
            wordSpacing: max(4, CGFloat(number(style, "wordSpacing", 0)) * scale + 4),
            textColor: color(string(style, "color", "#ffffff")),
            highlightColor: color(string(style, "highlight", "#ffd21f")),
            highlightEnabled: bool(style, "highlightEnabled", true),
            strokeWidth: CGFloat(number(style, "stroke", 0)) * scale,
            strokeColor: color(string(style, "strokeColor", "#000000")),
            shadowStrength: CGFloat(number(style, "shadow", 0)),
            shadowColor: color(string(style, "shadowColor", "#000000")),
            shadowOpacity: Float(number(style, "shadowOpacity", 0.8)),
            shadowRadius: CGFloat(number(style, "shadowBlur", 0) + number(style, "shadow", 0) * 0.75) * scale,
            shadowDistance: CGFloat(number(style, "shadowDistance", 0)) * scale,
            shadowAngle: CGFloat(number(style, "shadowAngle", 45)),
            glowRadius: CGFloat(number(style, "glow", 0)) * scale,
            glowColor: color(string(style, "glowColor", "#ffffff")),
            backgroundEnabled: bool(style, "backgroundEnabled", false),
            backgroundColor: color(string(style, "background", "#111111")),
            backgroundOpacity: CGFloat(number(style, "backgroundOpacity", 0.7)),
            backgroundScaleX: CGFloat(number(style, "backgroundScaleX", 1)),
            backgroundScaleY: CGFloat(number(style, "backgroundScaleY", 1)),
            backgroundOffsetX: CGFloat(number(style, "backgroundOffsetX", 0)) * scale,
            backgroundOffsetY: CGFloat(number(style, "backgroundOffsetY", 0)) * scale,
            padding: CGFloat(number(style, "padding", 14)) * scale,
            radius: CGFloat(number(style, "radius", 12)) * scale,
            animation: string(style, "animation", "fade"),
            animationDirection: string(style, "animationDirection", "left-to-right"),
            lineHeight: CGFloat(number(style, "lineHeight", 1.1)),
            textAlign: string(style, "textAlign", "center"),
            underline: bool(style, "fontUnderline", false),
            underlineMode: string(style, "underlineMode", "line"),
            underlineThickness: CGFloat(number(style, "underlineThickness", 1)) * scale
        )
    }

    private static func makeTextSystem(_ attributed: NSAttributedString, width: CGFloat)
        -> (storage: NSTextStorage, layout: NSLayoutManager, container: NSTextContainer)
    {
        let storage = NSTextStorage(attributedString: attributed)
        let layout = NSLayoutManager()
        let container = NSTextContainer(containerSize: NSSize(width: max(1, width), height: 10000))
        container.lineFragmentPadding = 0
        container.maximumNumberOfLines = 2
        container.lineBreakMode = .byWordWrapping
        layout.addTextContainer(container)
        storage.addLayoutManager(layout)
        layout.ensureLayout(for: container)
        return (storage, layout, container)
    }

    private static func drawAttributed(_ attributed: NSAttributedString, origin: NSPoint, width: CGFloat) {
        let system = makeTextSystem(attributed, width: width)
        system.layout.drawBackground(forGlyphRange: NSRange(location: 0, length: system.layout.numberOfGlyphs), at: origin)
        system.layout.drawGlyphs(forGlyphRange: NSRange(location: 0, length: system.layout.numberOfGlyphs), at: origin)
    }

    private static func applyWordSpacing(_ text: NSMutableAttributedString, amount: CGFloat) {
        guard amount > 0, text.length > 0 else { return }
        let ns = text.string as NSString
        for index in 0..<ns.length where ns.character(at: index) == 32 {
            text.addAttribute(.kern, value: amount, range: NSRange(location: index, length: 1))
        }
    }

    private static func rangesOfWords(in text: String) -> [NSRange] {
        let ns = text as NSString
        guard let regex = try? NSRegularExpression(pattern: "\\S+") else { return [] }
        return regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).map(\.range)
    }

    private static func mutableCopy(_ value: NSAttributedString) -> NSMutableAttributedString {
        NSMutableAttributedString(attributedString: value)
    }

    private static func textAlignment(_ value: String) -> NSTextAlignment {
        value == "left" ? .left : (value == "right" ? .right : .center)
    }

    private static func color(_ hex: String) -> NSColor {
        var value = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("#") { value.removeFirst() }
        if value.count == 3 { value = value.map { "\($0)\($0)" }.joined() }
        guard value.count >= 6, let rgb = UInt64(value.prefix(6), radix: 16) else { return .white }
        return NSColor(
            red: CGFloat((rgb >> 16) & 0xff) / 255,
            green: CGFloat((rgb >> 8) & 0xff) / 255,
            blue: CGFloat(rgb & 0xff) / 255,
            alpha: 1
        )
    }

    private static func number(_ dict: [String: Any], _ key: String, _ fallback: Double) -> Double {
        if let n = dict[key] as? NSNumber { return n.doubleValue }
        if let s = dict[key] as? String, let n = Double(s) { return n }
        return fallback
    }

    private static func string(_ dict: [String: Any], _ key: String, _ fallback: String) -> String {
        (dict[key] as? String) ?? fallback
    }

    private static func bool(_ dict: [String: Any], _ key: String, _ fallback: Bool) -> Bool {
        if let b = dict[key] as? Bool { return b }
        if let n = dict[key] as? NSNumber { return n.boolValue }
        return fallback
    }
}
