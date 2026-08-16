export const QUICKCUT_TEXT_LAYOUT_VERSION = 2;

// Preview CSS: words are joined with a space and each .word has margin-right: 0.24em.
export const CAPTION_WORD_SPACE_EM = 0.28;
export const CAPTION_WORD_MARGIN_EM = 0.24;

export function normalizedFontWeight(value) {
  const n = Math.max(100, Math.min(900, Number(value || 400)));
  if (n < 350) return 300;
  if (n < 550) return 400;
  if (n < 700) return 600;
  if (n < 850) return 700;
  return 900;
}

export function wordGap(style, fontSize) {
  const size = Math.max(10, Number(fontSize || 54));
  return Math.max(
    4,
    size * (CAPTION_WORD_SPACE_EM + CAPTION_WORD_MARGIN_EM) + Number(style?.wordSpacing || 0),
  );
}

export function estimatedWordWidth(word, style, fontSize, scale = 1) {
  const chars = Array.from(String(word || ""));
  const size = Math.max(10, Number(fontSize || 54));
  const letterSpacing = Number(style?.letterSpacing || 0) * Math.max(0.2, Number(scale || 1));
  const weight = Number(style?.fontWeight || 400);
  const weightScale = weight >= 800 ? 1.2 : weight >= 600 ? 1.1 : 1;
  const stroke = Math.max(0, Number(style?.stroke || 0)) * Math.max(0.2, Number(scale || 1));
  const glyphWidth = chars.reduce((sum, ch) => {
    if (/\s/.test(ch)) return sum;
    if (/[MW@#%&]/.test(ch)) return sum + size * 0.8;
    if (/[—–―]/.test(ch)) return sum + size * 0.72;
    if (/[ilI1'`.,:;!|]/.test(ch)) return sum + size * 0.36;
    if (/[A-Z0-9]/.test(ch)) return sum + size * 0.66;
    return sum + size * 0.62;
  }, 0);
  return Math.max(
    size * 0.3,
    glyphWidth * weightScale + Math.max(0, chars.length - 1) * letterSpacing + stroke * 2,
  );
}

export function estimatedLineWidth(displays = [], style = {}, fontSize, scale = 1) {
  const items = (displays || []).map((item) => String(item || "").trim()).filter(Boolean);
  if (!items.length) return 0;
  const size = Math.max(10, Number(fontSize || style.fontSize || 54));
  const gap = wordGap(style, size);
  const trailing = size * CAPTION_WORD_MARGIN_EM;
  let width = 0;
  items.forEach((word, index) => {
    const wordWidth = estimatedWordWidth(word, style, size, scale);
    width = index ? width + gap + wordWidth : wordWidth;
  });
  return width + trailing;
}

export function normalizeCaptionLines(value) {
  const raw = String(value ?? "2").trim().toLowerCase();
  if (raw === "1" || raw === "one" || raw === "single") return 1;
  if (raw === "3" || raw === "three") return 3;
  if (raw === "0" || raw === "multi" || raw === "many" || raw === "auto") return 0;
  const numeric = Number(raw);
  if (numeric === 1) return 1;
  if (numeric === 3) return 3;
  if (numeric === 0 || numeric >= 4) return 0;
  return 2;
}

export function captionWrapLineLimit(value) {
  const mode = normalizeCaptionLines(value);
  if (mode === 1) return 1;
  if (mode === 3) return 3;
  if (mode === 0) return 8;
  return 2;
}

export function captionMatchLineLimit(value) {
  return captionWrapLineLimit(value);
}

export function captionSafeBoxWidth(input = {}) {
  const canvas = Math.max(320, Number(input.canvasWidth || input.width || 1080));
  const style = input.style || {};
  const pad = style.backgroundEnabled
    ? Math.max(0, Number(style.backgroundWidth ?? style.padding ?? 0) * 2)
    : 0;
  const requested = Number(input.boxWidth || input.captionWidth);
  const usable = Number.isFinite(requested) && requested > 0 ? requested : canvas * 0.8;
  const boxed = Math.max(120, Math.min(canvas * 0.92, usable) - pad);
  return Math.max(80, boxed * 0.94);
}

export function packWordsIntoLines(words = [], style = {}, maxWidth = 860, scale = 1) {
  const items = (words || [])
    .map((word, index) => ({
      index,
      display: typeof word === "string" ? word : String(word?.display || "").trim(),
      word: typeof word === "string" ? { display: word } : word,
    }))
    .filter((item) => item.display);
  if (!items.length) return [];
  const fontSize = Math.max(10, Number(style.fontSize || 54) * Math.max(0.2, Number(scale || 1)));
  const lines = [];
  let start = 0;
  items.forEach((item, offset) => {
    const candidate = estimatedLineWidth(
      items.slice(start, offset + 1).map((entry) => entry.display),
      style,
      fontSize,
      scale,
    );
    if (offset > start && candidate > maxWidth) {
      lines.push({
        startIndex: start,
        endIndex: offset,
        words: items.slice(start, offset).map((entry) => entry.word),
      });
      start = offset;
    }
  });
  lines.push({
    startIndex: start,
    endIndex: items.length,
    words: items.slice(start).map((entry) => entry.word),
  });
  return lines;
}

export function wrapWords(text, style, maxWidth, maxLines = 2, scale = 1) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  void maxLines;
  const fontSize = Math.max(10, Number(style?.fontSize || 54) * Math.max(0.2, Number(scale || 1)));
  const lines = [];
  let current = [];
  words.forEach((word) => {
    const candidate = estimatedLineWidth([...current, word], style, fontSize, scale);
    if (current.length && candidate > maxWidth) {
      lines.push(current.join(" "));
      current = [word];
    } else {
      current.push(word);
    }
  });
  if (current.length) lines.push(current.join(" "));
  return lines;
}

export function captionLayoutMetrics(caption, style, canvasWidth, layout = {}) {
  const scale = Math.max(0.2, Number(caption?.scale || 1));
  const widthScale = Math.max(0.5, Math.min(2.5, Number(style?.captionWidthScale || 1)));
  const maxWidth = Math.max(160, Math.min(canvasWidth, Number(caption?.width || canvasWidth * 0.90 * widthScale)));
  const maxLines = captionWrapLineLimit(layout?.maxLines ?? style?.captionLines ?? 2);
  const lines = wrapWords(caption?.text || "", style, maxWidth, maxLines, scale);
  return { scale, widthScale, maxWidth, maxLines, lines };
}
