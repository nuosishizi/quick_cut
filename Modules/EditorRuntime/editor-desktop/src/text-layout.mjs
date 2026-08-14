export const QUICKCUT_TEXT_LAYOUT_VERSION = 1;

export function normalizedFontWeight(value) {
  const n = Math.max(100, Math.min(900, Number(value || 400)));
  if (n < 350) return 300;
  if (n < 550) return 400;
  if (n < 700) return 600;
  if (n < 850) return 700;
  return 900;
}

export function wordGap(style, fontSize) {
  return Math.max(4, Number(fontSize || 54) * 0.28 + Number(style?.wordSpacing || 0));
}

export function estimatedWordWidth(word, style, fontSize, scale = 1) {
  const chars = Array.from(String(word || ""));
  const letterSpacing = Number(style?.letterSpacing || 0) * Math.max(0.2, Number(scale || 1));
  // Geometry contract only. Actual glyph outlines remain libass/CoreText responsibilities.
  const glyphWidth = chars.reduce((sum, ch) => {
    if (/\s/.test(ch)) return sum;
    if (/[MW@#%&]/.test(ch)) return sum + fontSize * 0.72;
    if (/[ilI1'`.,:;!|]/.test(ch)) return sum + fontSize * 0.30;
    if (/[A-Z0-9]/.test(ch)) return sum + fontSize * 0.57;
    return sum + fontSize * 0.53;
  }, 0);
  return Math.max(fontSize * 0.25, glyphWidth + Math.max(0, chars.length - 1) * letterSpacing);
}

export function wrapWords(text, style, maxWidth, maxLines = 2, scale = 1) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const fontSize = Math.max(10, Number(style?.fontSize || 54) * Math.max(0.2, Number(scale || 1)));
  const gap = wordGap(style, fontSize);
  const lines = [];
  let current = [];
  let width = 0;
  words.forEach((word) => {
    const w = estimatedWordWidth(word, style, fontSize, scale);
    const candidate = current.length ? width + gap + w : w;
    if (current.length && candidate > maxWidth && lines.length < Math.max(1, maxLines) - 1) {
      lines.push(current.join(" "));
      current = [word];
      width = w;
    } else {
      current.push(word);
      width = candidate;
    }
  });
  if (current.length) lines.push(current.join(" "));
  return lines;
}

export function captionLayoutMetrics(caption, style, canvasWidth, layout = {}) {
  const scale = Math.max(0.2, Number(caption?.scale || 1));
  const widthScale = Math.max(0.5, Math.min(2.5, Number(style?.captionWidthScale || 1)));
  const maxWidth = Math.max(160, Math.min(canvasWidth, Number(caption?.width || canvasWidth * 0.90 * widthScale)));
  const maxLines = Math.max(1, Math.min(2, Number(layout?.maxLines || 2)));
  const lines = wrapWords(caption?.text || "", style, maxWidth, maxLines, scale);
  return { scale, widthScale, maxWidth, maxLines, lines };
}
