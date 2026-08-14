import Foundation
import AppKit

/// Shared text-layout contract used by the preview renderer and serialized into RenderSpec.
/// It keeps geometry/spacing decisions separate from SwiftUI so editing does not rebuild layout policy.
struct QuickCutTextLayoutSpec: Equatable {
    var fontFamily: String
    var fontSize: CGFloat
    var fontWeight: Int
    var italic: Bool
    var letterSpacing: CGFloat
    var wordSpacing: CGFloat
    var lineHeight: CGFloat
    var maxWidth: CGFloat
    var alignment: NSTextAlignment

    var font: NSFont {
        let weight = Self.nsWeight(fontWeight)
        let base: NSFont
        if fontFamily.isEmpty || fontFamily == ".System" {
            base = NSFont.systemFont(ofSize: fontSize, weight: weight)
        } else {
            base = Self.closestFamilyFont(familyOrPostScriptName: fontFamily, size: fontSize, requestedWeight: fontWeight)
                ?? NSFont(name: fontFamily, size: fontSize)
                ?? NSFont.systemFont(ofSize: fontSize, weight: weight)
        }
        guard italic else { return base }
        return NSFontManager.shared.convert(base, toHaveTrait: .italicFontMask)
    }

    /// Select a real face from the family instead of only changing a descriptor trait.
    /// Families such as Helvetica Neue contain Thin/Regular/Medium/Bold/Black faces;
    /// choosing the closest physical face makes all five UI weight levels visibly distinct.
    static func closestFamilyFont(familyOrPostScriptName: String, size: CGFloat, requestedWeight: Int) -> NSFont? {
        let manager = NSFontManager.shared
        let seed = NSFont(name: familyOrPostScriptName, size: size)
        let family = seed?.familyName ?? familyOrPostScriptName
        guard let members = manager.availableMembers(ofFontFamily: family), !members.isEmpty else { return seed }
        let target = requestedWeight
        var bestName: String?
        var bestDistance = Int.max
        for member in members {
            guard member.count >= 3,
                  let postScript = member[0] as? String,
                  let cocoaWeight = member[2] as? Int else { continue }
            // NSFontManager family weights are roughly 0...15. Map them to CSS-like 100...900.
            let mapped = 100 + Int((Double(max(0, min(15, cocoaWeight))) / 15.0 * 800.0).rounded())
            let distance = abs(mapped - target)
            if distance < bestDistance { bestDistance = distance; bestName = postScript }
        }
        if let bestName, let font = NSFont(name: bestName, size: size) { return font }
        return seed
    }

    var attributes: [NSAttributedString.Key: Any] {
        [.font: font, .kern: letterSpacing]
    }

    func wordWidth(_ word: String) -> CGFloat {
        ceil((word as NSString).size(withAttributes: attributes).width)
    }

    func singleLineWidth(_ text: String) -> CGFloat {
        let words = text.split(separator: " ").map(String.init)
        guard !words.isEmpty else { return 0 }
        return words.reduce(CGFloat.zero) { $0 + wordWidth($1) } + wordSpacing * CGFloat(max(0, words.count - 1))
    }

    /// Deterministic greedy wrapping. Preview and export share the same max-width/spacing contract.
    func lines(for text: String, maximumLines: Int = 2) -> [String] {
        let words = text.split(separator: " ").map(String.init)
        guard !words.isEmpty else { return [""] }
        guard maximumLines > 1, maxWidth > 1 else { return [words.joined(separator: " ")] }
        var lines: [String] = []
        var current: [String] = []
        var width: CGFloat = 0
        for word in words {
            let w = wordWidth(word)
            let candidate = current.isEmpty ? w : width + wordSpacing + w
            if !current.isEmpty, candidate > maxWidth, lines.count < maximumLines - 1 {
                lines.append(current.joined(separator: " "))
                current = [word]
                width = w
            } else {
                current.append(word)
                width = candidate
            }
        }
        if !current.isEmpty { lines.append(current.joined(separator: " ")) }
        return lines
    }

    static func nsWeight(_ value: Int) -> NSFont.Weight {
        switch value {
        case ..<350: return .light
        case 350..<550: return .regular
        case 550..<700: return .medium
        case 700..<850: return .bold
        default: return .black
        }
    }

    static func weightValue(_ value: Int) -> Double {
        switch value {
        case ..<350: return -0.35
        case 350..<550: return 0
        case 550..<700: return 0.23
        case 700..<850: return 0.4
        default: return 0.62
        }
    }
}
