import SwiftUI
import AppKit
import QuartzCore

struct NativeCaptionRenderSpec: Equatable {
    var text: String
    var fontFamily: String
    var fontSize: CGFloat
    var fontWeight: Int
    var italic: Bool
    var letterSpacing: CGFloat
    var wordSpacing: CGFloat
    var textColor: NSColor
    var highlightColor: NSColor
    var highlightEnabled: Bool
    var strokeWidth: CGFloat
    var strokeColor: NSColor
    var shadowStrength: CGFloat
    var shadowColor: NSColor
    var shadowOpacity: Float
    var shadowRadius: CGFloat
    var shadowDistance: CGFloat
    var shadowAngle: CGFloat
    var glowRadius: CGFloat
    var glowColor: NSColor
    var backgroundEnabled: Bool
    var backgroundColor: NSColor
    var backgroundOpacity: CGFloat
    var backgroundScaleX: CGFloat
    var backgroundScaleY: CGFloat
    var backgroundOffsetX: CGFloat
    var backgroundOffsetY: CGFloat
    var padding: CGFloat
    var radius: CGFloat
    var animation: String
    var animationDirection: String
    var lineHeight: CGFloat
    var textAlign: String
    var underline: Bool
    var underlineMode: String
    var underlineThickness: CGFloat
}

/// Bridge used only for live drag/scale feedback. SwiftUI model values are committed
/// once at gesture end, so mouse movement does not invalidate the entire editor tree.
final class NativeCaptionInteractionBus {
    static let shared = NativeCaptionInteractionBus()
    weak var renderer: NativeCaptionLayerView?
    private init() {}

    func preview(translation: CGSize = .zero, scale: CGFloat = 1) {
        renderer?.applyInteractionPreview(translation: translation, scale: scale)
    }

    func reset() { renderer?.applyInteractionPreview(translation: .zero, scale: 1) }
}

struct NativeCaptionPreviewView: NSViewRepresentable {
    let spec: NativeCaptionRenderSpec

    func makeNSView(context: Context) -> NativeCaptionLayerView {
        let view = NativeCaptionLayerView()
        view.wantsLayer = true
        view.update(spec: spec)
        return view
    }

    func updateNSView(_ nsView: NativeCaptionLayerView, context: Context) {
        nsView.update(spec: spec)
    }
}

final class NativeCaptionLayerView: NSView {
    private let interactionRoot = CALayer()
    private let animationRoot = CALayer()
    private let background = CALayer()
    private let underline = CALayer()
    private let sharedRaster = CALayer()

    private let glow = CATextLayer()
    private let outline = CATextLayer()
    private let text = CATextLayer()

    private let line1Glow = CATextLayer()
    private let line1Outline = CATextLayer()
    private let line1 = CATextLayer()
    private let line2Glow = CATextLayer()
    private let line2Outline = CATextLayer()
    private let line2 = CATextLayer()

    private var wordBackgrounds: [CALayer] = []
    private var wordGlows: [CATextLayer] = []
    private var wordOutlines: [CATextLayer] = []
    private var wordLayers: [CATextLayer] = []

    private var timer: Timer?
    private var spec: NativeCaptionRenderSpec?
    private var structureKey = ""
    private var activeWordIndex = -1
    private var startTime = CACurrentMediaTime()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.masksToBounds = false
        interactionRoot.masksToBounds = false
        animationRoot.masksToBounds = false
        layer?.addSublayer(interactionRoot)
        interactionRoot.addSublayer(animationRoot)

        [background, sharedRaster, line1Glow, line1Outline, line1, line2Glow, line2Outline, line2, glow, outline, text, underline].forEach {
            animationRoot.addSublayer($0)
        }
        sharedRaster.contentsGravity = .center
        sharedRaster.magnificationFilter = .linear
        sharedRaster.minificationFilter = .linear
        [glow, outline, text, line1Glow, line1Outline, line1, line2Glow, line2Outline, line2].forEach(prepareTextLayer)

        NativeCaptionInteractionBus.shared.renderer = self
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in self?.tick() }
        if let timer { RunLoop.main.add(timer, forMode: .common) }
    }

    required init?(coder: NSCoder) { fatalError() }

    deinit {
        timer?.invalidate()
        if NativeCaptionInteractionBus.shared.renderer === self { NativeCaptionInteractionBus.shared.renderer = nil }
    }

    override func layout() {
        super.layout()
        CATransaction.begin(); CATransaction.setDisableActions(true)
        interactionRoot.frame = bounds
        animationRoot.frame = bounds
        layoutLayers()
        CATransaction.commit()
    }

    func update(spec newSpec: NativeCaptionRenderSpec) {
        let previous = spec
        let newKey = layerStructureKey(newSpec)
        let animationChanged = previous?.animation != newSpec.animation || previous?.animationDirection != newSpec.animationDirection || previous?.text != newSpec.text
        spec = newSpec
        if animationChanged { startTime = CACurrentMediaTime(); activeWordIndex = -1 }

        CATransaction.begin(); CATransaction.setDisableActions(true)
        if structureKey != newKey {
            structureKey = newKey
            rebuildStructure(newSpec)
        }
        applyStyle(newSpec)
        CATransaction.commit()
        needsLayout = true
    }

    func applyInteractionPreview(translation: CGSize, scale: CGFloat) {
        CATransaction.begin(); CATransaction.setDisableActions(true)
        var transform = CGAffineTransform(translationX: translation.width, y: translation.height)
        transform = transform.scaledBy(x: scale, y: scale)
        interactionRoot.setAffineTransform(transform)
        CATransaction.commit()
    }

    private func prepareTextLayer(_ layer: CATextLayer) {
        layer.contentsScale = NSScreen.main?.backingScaleFactor ?? 2
        layer.alignmentMode = .center
        layer.truncationMode = .none
        layer.isWrapped = true
        layer.masksToBounds = false
    }

    private func layerStructureKey(_ s: NativeCaptionRenderSpec) -> String {
        let mode = isWordAnimation(s.animation) ? "word" : (["donald-line-grow", "line-pulse", "line-rise"].contains(s.animation) ? "line" : "plain")
        return "\(mode)|\(s.animation)|\(s.text)"
    }

    private func textLayout(maxWidth: CGFloat? = nil) -> QuickCutTextLayoutSpec {
        guard let s = spec else {
            return QuickCutTextLayoutSpec(fontFamily: ".System", fontSize: 20, fontWeight: 400, italic: false,
                                          letterSpacing: 0, wordSpacing: 4, lineHeight: 1.15,
                                          maxWidth: maxWidth ?? max(1, bounds.width), alignment: .center)
        }
        return QuickCutTextLayoutSpec(fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight,
                                      italic: s.italic, letterSpacing: s.letterSpacing,
                                      wordSpacing: s.wordSpacing, lineHeight: s.lineHeight,
                                      maxWidth: maxWidth ?? max(1, bounds.width), alignment: .center)
    }

    private func font() -> NSFont { textLayout().font }

    /// Fill only. Stroke is rendered in a dedicated layer behind this fill, so the
    /// visible border grows outward instead of eating into the glyph interior.
    private func fillAttributed(_ string: String, color: NSColor, underline: Bool = false) -> NSAttributedString {
        guard let s = spec else { return NSAttributedString(string: string) }
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = s.textAlign == "left" ? .left : (s.textAlign == "right" ? .right : .center)
        paragraph.lineBreakMode = .byWordWrapping
        paragraph.minimumLineHeight = s.fontSize * max(0.75, s.lineHeight)
        paragraph.maximumLineHeight = paragraph.minimumLineHeight
        var attrs: [NSAttributedString.Key: Any] = [.font: font(), .foregroundColor: color, .kern: s.letterSpacing, .paragraphStyle: paragraph]
        if underline {
            attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue
            attrs[.underlineColor] = color
        }
        return NSAttributedString(string: string, attributes: attrs)
    }

    private func strokeAttributed(_ string: String, color: NSColor, outwardWidth: CGFloat) -> NSAttributedString {
        guard outwardWidth > 0 else { return NSAttributedString(string: "") }
        guard let s = spec else { return NSAttributedString(string: "") }
        let pointSize = max(1, font().pointSize)
        // NSStrokeWidth is a percentage of font size and is centered on the path.
        // Draw stroke-only at 2x requested width, then put the fill layer on top;
        // the inner half is covered, leaving an outward-only visible outline.
        let percentage = max(1, min(80, (outwardWidth * 2 / pointSize) * 100))
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = s.textAlign == "left" ? .left : (s.textAlign == "right" ? .right : .center)
        paragraph.lineBreakMode = .byWordWrapping
        paragraph.minimumLineHeight = s.fontSize * max(0.75, s.lineHeight)
        paragraph.maximumLineHeight = paragraph.minimumLineHeight
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font(), .foregroundColor: color, .strokeColor: color,
            .strokeWidth: percentage, .kern: spec?.letterSpacing ?? 0, .paragraphStyle: paragraph
        ]
        return NSAttributedString(string: string, attributes: attrs)
    }

    private func glowAttributed(_ string: String, color: NSColor, radius: CGFloat) -> NSAttributedString {
        guard radius > 0, let s = spec else { return NSAttributedString(string: "") }
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = s.textAlign == "left" ? .left : (s.textAlign == "right" ? .right : .center)
        paragraph.lineBreakMode = .byWordWrapping
        paragraph.minimumLineHeight = s.fontSize * max(0.75, s.lineHeight)
        paragraph.maximumLineHeight = paragraph.minimumLineHeight
        let pointSize = max(1, font().pointSize)
        // Glow uses a broad stroke-only source plus blur. The fill layer above remains crisp,
        // so the result is a soft halo rather than another hard outline.
        let percentage = max(2, min(95, (max(1.5, radius * 0.42) / pointSize) * 100))
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font(),
            .foregroundColor: color.withAlphaComponent(0.0),
            .strokeColor: color.withAlphaComponent(0.72),
            .strokeWidth: percentage,
            .kern: s.letterSpacing,
            .paragraphStyle: paragraph
        ]
        return NSAttributedString(string: string, attributes: attrs)
    }

    private func rebuildStructure(_ s: NativeCaptionRenderSpec) {
        wordBackgrounds.forEach { $0.removeFromSuperlayer() }
        wordGlows.forEach { $0.removeFromSuperlayer() }
        wordOutlines.forEach { $0.removeFromSuperlayer() }
        wordLayers.forEach { $0.removeFromSuperlayer() }
        wordBackgrounds.removeAll(); wordGlows.removeAll(); wordOutlines.removeAll(); wordLayers.removeAll()

        let isLine = ["donald-line-grow", "line-pulse", "line-rise"].contains(s.animation)
        let isWord = isWordAnimation(s.animation)
        let useShared = !isLine && !isWord
        sharedRaster.isHidden = !useShared
        line1Glow.isHidden = !isLine; line1Outline.isHidden = !isLine; line1.isHidden = !isLine
        line2Glow.isHidden = !isLine; line2Outline.isHidden = !isLine; line2.isHidden = !isLine
        text.isHidden = isLine || useShared; outline.isHidden = isLine || useShared; glow.isHidden = isLine || useShared
        background.isHidden = useShared
        underline.isHidden = useShared || !s.underline || s.underlineMode != "line" || s.animation == "underline"

        guard isWord else { return }
        sharedRaster.isHidden = true
        text.isHidden = true; outline.isHidden = true; glow.isHidden = true
        line1Glow.isHidden = true; line1Outline.isHidden = true; line1.isHidden = true
        line2Glow.isHidden = true; line2Outline.isHidden = true; line2.isHidden = true

        for _ in s.text.split(separator: " ") {
            let bg = CALayer(); bg.masksToBounds = false
            let g = CATextLayer(); prepareTextLayer(g)
            let o = CATextLayer(); prepareTextLayer(o)
            let t = CATextLayer(); prepareTextLayer(t)
            animationRoot.addSublayer(bg); animationRoot.addSublayer(g); animationRoot.addSublayer(o); animationRoot.addSublayer(t)
            wordBackgrounds.append(bg); wordGlows.append(g); wordOutlines.append(o); wordLayers.append(t)
        }
    }

    private func applyStyle(_ s: NativeCaptionRenderSpec) {
        let words = s.text.split(separator: " ").map(String.init)
        if !sharedRaster.isHidden { refreshSharedRaster(s) }
        let split = max(1, Int(ceil(Double(words.count) / 2.0)))
        let first = words.prefix(split).joined(separator: " ")
        let second = words.dropFirst(split).joined(separator: " ")

        let staticWordUnderline = s.underline && s.underlineMode == "word"
        text.string = fillAttributed(s.text, color: s.textColor, underline: staticWordUnderline)
        outline.string = strokeAttributed(s.text, color: s.strokeColor, outwardWidth: s.strokeWidth)
        glow.string = glowAttributed(s.text, color: s.glowColor, radius: s.glowRadius)

        line1.string = fillAttributed(first, color: s.textColor, underline: staticWordUnderline)
        line1Outline.string = strokeAttributed(first, color: s.strokeColor, outwardWidth: s.strokeWidth)
        line1Glow.string = glowAttributed(first, color: s.glowColor, radius: s.glowRadius)
        line2.string = fillAttributed(second, color: s.textColor, underline: staticWordUnderline)
        line2Outline.string = strokeAttributed(second, color: s.strokeColor, outwardWidth: s.strokeWidth)
        line2Glow.string = glowAttributed(second, color: s.glowColor, radius: s.glowRadius)

        let shadowStrength = max(0, min(1, s.shadowStrength / 10.0))
        let shadowAlpha: Float = s.shadowStrength <= 0.001 ? 0 : Float(min(1, Double(s.shadowOpacity) * (0.35 + Double(shadowStrength) * 0.95)))
        let r = s.shadowAngle * .pi / 180
        // Core Animation 的 Y 轴向上；UI 约定 90°=向下，所以这里使用 -sin。
        let effectiveDistance = s.shadowDistance * (0.35 + shadowStrength * 0.90)
        let shadowOffset = CGSize(width: cos(r) * effectiveDistance, height: -sin(r) * effectiveDistance)
        let shadowRadius = max(0, s.shadowRadius) * (0.55 + shadowStrength * 0.85)
        [text, line1, line2].forEach {
            $0.shadowColor = s.shadowColor.cgColor
            $0.shadowRadius = shadowRadius
            $0.shadowOffset = shadowOffset
            $0.shadowOpacity = shadowAlpha
        }

        let glowOpacity: Float = s.glowRadius > 0.1 ? Float(min(0.92, 0.34 + s.glowRadius / 120)) : 0
        [glow, line1Glow, line2Glow].forEach {
            $0.shadowColor = s.glowColor.cgColor
            $0.shadowRadius = max(2.5, s.glowRadius * 0.95)
            $0.shadowOffset = .zero
            $0.shadowOpacity = glowOpacity
            $0.opacity = glowOpacity
            $0.shouldRasterize = true
            $0.rasterizationScale = NSScreen.main?.backingScaleFactor ?? 2
        }

        let alignment: CATextLayerAlignmentMode = s.textAlign == "left" ? .left : (s.textAlign == "right" ? .right : .center)
        [text, outline, glow, line1, line1Outline, line1Glow, line2, line2Outline, line2Glow].forEach { $0.alignmentMode = alignment }
        background.backgroundColor = s.backgroundEnabled ? s.backgroundColor.withAlphaComponent(s.backgroundOpacity).cgColor : NSColor.clear.cgColor
        background.cornerRadius = s.radius
        underline.backgroundColor = s.underline ? s.textColor.cgColor : NSColor.clear.cgColor
        if sharedRaster.isHidden {
            underline.isHidden = !s.underline || s.underlineMode != "line" || s.animation == "underline"
        }

        for i in wordLayers.indices where i < words.count {
            applyWordState(index: i, active: i == activeWordIndex, word: words[i], spec: s)
        }
    }

    private func applyWordState(index: Int, active: Bool, word: String, spec s: NativeCaptionRenderSpec) {
        guard index < wordLayers.count else { return }
        let activeFill: NSColor = (s.animation == "word-pill" && active) ? .black : (active && s.highlightEnabled ? s.highlightColor : s.textColor)
        let underlineActive = (s.animation == "underline" && active) || (s.underline && s.underlineMode == "word")
        wordLayers[index].string = fillAttributed(word, color: activeFill, underline: underlineActive)

        let outlineColor = (s.animation == "outline-active" && active) ? s.highlightColor : s.strokeColor
        let outlineWidth = (s.animation == "outline-active" && active) ? max(s.strokeWidth, 2.5) : s.strokeWidth
        wordOutlines[index].string = strokeAttributed(word, color: outlineColor, outwardWidth: outlineWidth)
        wordGlows[index].string = glowAttributed(word, color: s.glowColor, radius: s.glowRadius)
        wordGlows[index].shadowColor = s.glowColor.cgColor
        wordGlows[index].shadowRadius = max(2.5, s.glowRadius * 0.95)
        wordGlows[index].shadowOpacity = s.glowRadius > 0.1 ? Float(min(0.92, 0.34 + s.glowRadius / 120)) : 0
        wordGlows[index].opacity = wordGlows[index].shadowOpacity

        let strength = max(0, min(1, s.shadowStrength / 10.0))
        wordLayers[index].shadowColor = s.shadowColor.cgColor
        wordLayers[index].shadowOpacity = s.shadowStrength <= 0.001 ? 0 : Float(min(1, Double(s.shadowOpacity) * (0.35 + Double(strength) * 0.95)))
        wordLayers[index].shadowRadius = s.shadowRadius * (0.55 + strength * 0.85)
        let r = s.shadowAngle * .pi / 180
        let d = s.shadowDistance * (0.35 + strength * 0.90)
        wordLayers[index].shadowOffset = CGSize(width: cos(r) * d, height: -sin(r) * d)

        wordBackgrounds[index].backgroundColor = (s.animation == "word-pill" && active) ? s.highlightColor.cgColor : NSColor.clear.cgColor
        wordLayers[index].opacity = (s.animation == "typewriter" && !active && index > activeWordIndex) ? 0 : 1
        wordOutlines[index].opacity = wordLayers[index].opacity
        wordGlows[index].opacity *= wordLayers[index].opacity

        let scale: CGFloat
        switch s.animation {
        case "word-pop", "word-bounce": scale = active ? 1.16 : 1
        case "word-squash": scale = active ? 1.10 : 1
        default: scale = 1
        }
        wordLayers[index].setAffineTransform(CGAffineTransform(scaleX: scale, y: scale))
        wordOutlines[index].setAffineTransform(CGAffineTransform(scaleX: scale, y: scale))
        wordGlows[index].setAffineTransform(CGAffineTransform(scaleX: scale, y: scale))
    }

    private func refreshSharedRaster(_ s: NativeCaptionRenderSpec) {
        let maxWidth = max(80, bounds.width > 1 ? bounds.width : 900)
        guard let result = QuickCutCaptionRasterizer.render(spec: s, maxWidth: maxWidth, activeWordIndex: -1) else {
            sharedRaster.contents = nil
            return
        }
        sharedRaster.contents = result.image
        let backing = NSScreen.main?.backingScaleFactor ?? 2
        let logicalW = CGFloat(result.width) / backing
        let logicalH = CGFloat(result.height) / backing
        sharedRaster.bounds = CGRect(x: 0, y: 0, width: logicalW, height: logicalH)
        sharedRaster.position = CGPoint(x: bounds.midX, y: bounds.midY)
    }

    private func isWordAnimation(_ a: String) -> Bool {
        a == "karaoke" || a.hasPrefix("word-") || a == "underline" || a == "outline-active" || a == "typewriter"
    }

    private func layoutLayers() {
        guard let s = spec else { return }
        if !sharedRaster.isHidden {
            refreshSharedRaster(s)
            sharedRaster.position = CGPoint(x: bounds.midX, y: bounds.midY)
        }
        let layout = textLayout()
        let words = s.text.split(separator: " ").map(String.init)

        if !line1.isHidden || !line2.isHidden {
            let lineH = s.fontSize * max(1.1, s.lineHeight)
            let f1 = CGRect(x: 0, y: bounds.midY + 2, width: bounds.width, height: lineH)
            let f2 = CGRect(x: 0, y: bounds.midY - lineH - 2, width: bounds.width, height: lineH)
            [line1Glow, line1Outline, line1].forEach { $0.frame = f1 }
            [line2Glow, line2Outline, line2].forEach { $0.frame = f2 }
        }

        if !wordLayers.isEmpty {
            let widths = words.map { layout.wordWidth($0) + 2 }
            let total = widths.reduce(0,+) + max(0, CGFloat(widths.count - 1)) * layout.wordSpacing
            let edgePadding: CGFloat = 8
            var x: CGFloat
            if s.textAlign == "left" { x = edgePadding }
            else if s.textAlign == "right" { x = max(edgePadding, bounds.width - total - edgePadding) }
            else { x = (bounds.width - total) / 2 }
            for i in wordLayers.indices where i < widths.count {
                let w = widths[i]
                let frame = CGRect(x: x, y: (bounds.height - s.fontSize * 1.6)/2, width: w, height: s.fontSize * 1.6)
                wordLayers[i].frame = frame; wordOutlines[i].frame = frame; wordGlows[i].frame = frame
                wordBackgrounds[i].frame = frame.insetBy(dx: -4, dy: -2)
                wordBackgrounds[i].cornerRadius = 5
                x += w + layout.wordSpacing
            }
        } else {
            let box = CGRect(x: 0, y: (bounds.height - s.fontSize * 1.8)/2, width: bounds.width, height: s.fontSize * 1.8)
            [glow, outline, text].forEach { $0.frame = box }
        }

        let measuredWidth = layout.singleLineWidth(s.text)
        let bw = max(80, measuredWidth + s.padding * 2) * s.backgroundScaleX
        let bh = max(28, s.fontSize * 1.55 + s.padding * 2) * s.backgroundScaleY
        background.frame = CGRect(x: (bounds.width-bw)/2 + s.backgroundOffsetX, y: (bounds.height-bh)/2 + s.backgroundOffsetY, width: bw, height: bh)
        let underlineWidth = min(bounds.width, max(24, measuredWidth))
        underline.frame = CGRect(x: (bounds.width - underlineWidth)/2,
                                 y: bounds.midY - s.fontSize * 0.70,
                                 width: underlineWidth,
                                 height: max(0.5, s.underlineThickness))
    }

    private func tick() {
        guard let s = spec else { return }
        let elapsed = CACurrentMediaTime() - startTime
        let phase = (elapsed.truncatingRemainder(dividingBy: 2.4)) / 2.4
        let entrance = min(1, phase * 4)

        CATransaction.begin(); CATransaction.setDisableActions(true)
        animationRoot.opacity = 1
        animationRoot.setAffineTransform(.identity)
        switch s.animation {
        case "alisha-reveal":
            animationRoot.opacity = Float(entrance)
            var tx: CGFloat = 0, ty: CGFloat = 0
            switch s.animationDirection {
            case "rightToLeft": tx = CGFloat((1-entrance) * 180)
            case "bottomToTop": ty = CGFloat((1-entrance) * -120)
            case "topToBottom": ty = CGFloat((1-entrance) * 120)
            default: tx = CGFloat((1-entrance) * -180)
            }
            animationRoot.setAffineTransform(CGAffineTransform(translationX: tx, y: ty))
        case "zoom":
            let sc = CGFloat(0.72 + entrance * 0.28)
            animationRoot.setAffineTransform(CGAffineTransform(scaleX: sc, y: sc))
        case "shake":
            animationRoot.setAffineTransform(CGAffineTransform(translationX: CGFloat(sin(phase * .pi * 12) * 12), y: 0))
        case "rise": animationRoot.setAffineTransform(CGAffineTransform(translationX: 0, y: CGFloat((1-entrance) * -90)))
        case "drop": animationRoot.setAffineTransform(CGAffineTransform(translationX: 0, y: CGFloat((1-entrance) * 90)))
        case "fade": animationRoot.opacity = Float(entrance)
        default: break
        }

        if ["donald-line-grow", "line-pulse", "line-rise"].contains(s.animation) {
            let firstActive = phase < 0.5
            if s.animation == "line-rise" {
                let p1 = min(1.0, phase * 2.0)
                let p2 = max(0.0, min(1.0, (phase - 0.5) * 2.0))
                let t1 = CGAffineTransform(translationX: 0, y: CGFloat((1-p1) * -70 + (phase > 0.62 ? (phase-0.62) * 80 : 0)))
                let t2 = CGAffineTransform(translationX: 0, y: CGFloat((1-p2) * -90))
                [line1Glow, line1Outline, line1].forEach { $0.setAffineTransform(t1); $0.opacity = Float(phase > 0.78 ? max(0, 1 - (phase-0.78)*4.5) : 1) }
                [line2Glow, line2Outline, line2].forEach { $0.setAffineTransform(t2); $0.opacity = Float(p2) }
            } else {
                let s1: CGFloat = firstActive ? 1.22 : 0.88
                let s2: CGFloat = firstActive ? 0.88 : 1.22
                [line1Glow, line1Outline, line1].forEach { $0.setAffineTransform(CGAffineTransform(scaleX: s1, y: s1)); $0.opacity = firstActive ? 1 : 0.72 }
                [line2Glow, line2Outline, line2].forEach { $0.setAffineTransform(CGAffineTransform(scaleX: s2, y: s2)); $0.opacity = firstActive ? 0.72 : 1 }
            }
        }

        if !wordLayers.isEmpty {
            let nextActive = min(wordLayers.count - 1, Int(phase * Double(max(1, wordLayers.count))))
            if nextActive != activeWordIndex {
                activeWordIndex = nextActive
                let words = s.text.split(separator: " ").map(String.init)
                for i in wordLayers.indices where i < words.count {
                    applyWordState(index: i, active: i == activeWordIndex, word: words[i], spec: s)
                }
            }
        }
        CATransaction.commit()
    }
}
