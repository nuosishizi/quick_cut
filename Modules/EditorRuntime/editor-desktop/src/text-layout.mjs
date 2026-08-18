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
    0,
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
    size * 0.15,
    glyphWidth * weightScale + Math.max(0, chars.length - 1) * letterSpacing + stroke * 2,
  );
}

export function paintedWordWidth(word, style, fontSize, scale = 1) {
  const chars = Array.from(String(word || ""));
  const size = Math.max(10, Number(fontSize || 54));
  const letterSpacing = Number(style?.letterSpacing || 0) * Math.max(0.2, Number(scale || 1));
  const weight = Number(style?.fontWeight || 400);
  const weightScale = weight >= 800 ? 1.07 : weight >= 600 ? 1.03 : 1;
  const glyphWidth = chars.reduce((sum, ch) => {
    if (/\s/.test(ch)) return sum;
    if (/[MW@#%&]/.test(ch)) return sum + size * 0.72;
    if (/[—–―]/.test(ch)) return sum + size * 0.62;
    if (/[ilI1'`.,:;!|]/.test(ch)) return sum + size * 0.3;
    if (/[A-Z0-9]/.test(ch)) return sum + size * 0.56;
    return sum + size * 0.48;
  }, 0);
  return Math.max(size * 0.15, glyphWidth * weightScale + Math.max(0, chars.length - 1) * letterSpacing);
}

export function paintedLineWidth(displays = [], style = {}, fontSize, scale = 1) {
  const items = (displays || []).map((item) => String(item || "").trim()).filter(Boolean);
  if (!items.length) return 0;
  const size = Math.max(10, Number(fontSize || style.fontSize || 54));
  const gap = wordGap(style, size);
  const trailing = size * CAPTION_WORD_MARGIN_EM;
  let width = 0;
  items.forEach((word, index) => {
    const wordWidth = paintedWordWidth(word, style, size, scale);
    width = index ? width + gap + wordWidth : wordWidth;
  });
  return width + trailing;
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

export const KINSOKU_LINE_START_PROHIBITED = /^["”’」』》〉）】〕〗)\]}。，、；：！？…—～.,!?:;-]/u;
export const KINSOKU_LINE_END_PROHIBITED = /["“‘「『《〈（【〔〖(\[{]$/u;

export const SCRIPTURE_BOOK_PATTERN =
  /^(?:Genesis|Exodus|Leviticus|Numbers|Deuteronomy|Joshua|Judges|Ruth|1\s*Samuel|2\s*Samuel|1\s*Kings|2\s*Kings|1\s*Chronicles|2\s*Chronicles|Ezra|Nehemiah|Esther|Job|Psalms?|Proverbs|Ecclesiastes|Song\s*of\s*Solomon|Isaiah|Jeremiah|Lamentations|Ezekiel|Daniel|Hosea|Joel|Amos|Obadiah|Jonah|Micah|Nahum|Habakkuk|Zephaniah|Haggai|Zechariah|Malachi|Matthew|Mark|Luke|John|Acts|Romans|1\s*Corinthians|2\s*Corinthians|Galatians|Ephesians|Philippians|Colossians|1\s*Thessalonians|2\s*Thessalonians|1\s*Timothy|2\s*Timothy|Titus|Philemon|Hebrews|James|1\s*Peter|2\s*Peter|1\s*John|2\s*John|3\s*John|Jude|Revelation|创世记|出埃及记|利未记|民数记|申命记|约书亚记|士师记|路得记|撒母耳记上|撒母耳记下|列王纪上|列王纪下|历代志上|历代志下|以斯拉记|尼希米记|以斯帖记|约伯记|诗篇|箴言|传道书|雅歌|以赛亚书|耶利米书|耶利米哀歌|以西结书|但以理书|何西阿书|约珥书|阿摩司书|俄巴底亚书|约拿书|弥迦书|那鸿书|哈巴谷书|西番雅书|哈该书|撒迦利亚书|玛拉基书|马太福音|马可福音|路加福音|约翰福音|使徒行传|罗马书|哥林多前书|哥林多后书|加拉太书|以弗所书|腓立比书|歌罗西书|帖撒罗尼迦前书|帖撒罗尼迦后书|提摩太前书|提摩太后书|提多书|腓利门书|希伯来书|雅各书|彼得前书|彼得后书|约翰一书|约翰二书|约翰三书|犹大书|启示录)$/i;

export const CHAPTER_VERSE_PATTERN = /^\d+:\d+(?:-\d+)?$/;

export function normalizeLanguagePunctuation(text) {
  let str = String(text || "");
  // Keep digit:digit (scripture e.g. 24:36, clock time e.g. 10:30) compact
  str = str.replace(/(\d)\s*:\s*(\d)/g, "$1:$2");

  // 1. English context: convert full-width Chinese punctuation adjacent to Latin letters/numbers to half-width
  str = str.replace(/([a-zA-Z0-9])([，,])(?:\s*)([a-zA-Z0-9])/gu, "$1, $3");
  str = str.replace(/([a-zA-Z])([：:])(?:\s*)([a-zA-Z0-9])/gu, "$1: $3");
  str = str.replace(/(\d)([：:])(?:\s*)([a-zA-Z])/gu, "$1: $3");
  str = str.replace(/([a-zA-Z0-9])([；;])(?:\s*)([a-zA-Z0-9])/gu, "$1; $3");
  str = str.replace(/([a-zA-Z0-9])，/gu, "$1, ");
  str = str.replace(/([a-zA-Z0-9])。/gu, "$1. ");
  str = str.replace(/([a-zA-Z0-9])！/gu, "$1! ");
  str = str.replace(/([a-zA-Z0-9])？/gu, "$1? ");
  str = str.replace(/([a-zA-Z])：/gu, "$1: ");
  str = str.replace(/([a-zA-Z0-9])；/gu, "$1; ");

  // 2. Chinese context: convert half-width punctuation between/after CJK characters to full-width Chinese punctuation
  str = str.replace(/([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]),([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF])/gu, "$1，$2");
  str = str.replace(/([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]):([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF])/gu, "$1：$2");
  str = str.replace(/([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]);([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF])/gu, "$1；$2");
  str = str.replace(/([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]),(?!\s*[a-zA-Z0-9])/gu, "$1，");
  str = str.replace(/([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF])!(?!\s*[a-zA-Z0-9])/gu, "$1！");
  str = str.replace(/([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF])\?(?!\s*[a-zA-Z0-9])/gu, "$1？");
  str = str.replace(/([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF];(?!\s*[a-zA-Z0-9]))/gu, "$1；");

  // Clean redundant spaces before English punctuation
  str = str.replace(/\s+([.,!?;:])/g, "$1");
  // Clean redundant spaces around Chinese punctuation
  str = str.replace(/\s*([，。、！？；：”’」』》〉）】〕〗])\s*/gu, "$1");
  str = str.replace(/\s*([“‘「『《〈（【〔〖])\s*/gu, "$1");

  return str;
}

export function formatPanguSpacing(text) {
  let str = String(text || "");
  str = str.replace(/([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF])([a-zA-Z0-9])/gu, "$1 $2");
  str = str.replace(/([a-zA-Z0-9])([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF])/gu, "$1 $2");
  str = str.replace(/ {2,}/g, " ");
  return str;
}

export function stripTrailingCaptionPunctuation(text) {
  return String(text || "")
    .replace(/[，,。.]$/u, "")
    .trim();
}

export function shouldCohesionStepBack(items, breakPoint, start) {
  if (breakPoint <= start + 1) return false;
  const curr = items[breakPoint];
  const prev = items[breakPoint - 1];
  const currDisp = typeof curr === "string" ? curr : (curr?.display || "");
  const prevDisp = typeof prev === "string" ? prev : (prev?.display || "");

  if (KINSOKU_LINE_END_PROHIBITED.test(prevDisp)) return true;
  if (curr?.word?.keepWithPrevious || curr?.keepWithPrevious) return true;
  if (/^\d+:$/.test(prevDisp) && /^\d+$/.test(currDisp)) return true;
  if (/^\d+$/.test(prevDisp) && /^:\d+/.test(currDisp)) return true;
  if (
    (/^\d+:/.test(currDisp) || /^:\d+/.test(currDisp) || /^\d+$/.test(currDisp) || CHAPTER_VERSE_PATTERN.test(currDisp.replace(/^[^\d]+|[^\d]+$/g, ""))) &&
    SCRIPTURE_BOOK_PATTERN.test(prevDisp.replace(/[^\p{L}\p{N}]/gu, ""))
  ) {
    return true;
  }
  if (KINSOKU_LINE_START_PROHIBITED.test(currDisp)) return true;

  return false;
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
      let breakPoint = offset;
      while (breakPoint > start + 1 && shouldCohesionStepBack(items, breakPoint, start)) {
        breakPoint -= 1;
      }
      lines.push({
        startIndex: start,
        endIndex: breakPoint,
        words: items.slice(start, breakPoint).map((entry) => entry.word),
      });
      start = breakPoint;
    }
  });
  lines.push({
    startIndex: start,
    endIndex: items.length,
    words: items.slice(start).map((entry) => entry.word),
  });
  return lines;
}

export function wrapCaptionWordList(words = [], style = {}, boxWidth = 860, lineMode = 2, scale = 1) {
  const displays = (words || [])
    .map((word) => (typeof word === "string" ? word : String(word?.display || "")).trim())
    .filter(Boolean);
  if (!displays.length) return [];
  const limit = captionWrapLineLimit(lineMode);
  const maxWidth = Math.max(80, Number(boxWidth || 860));
  const fontSize = Math.max(10, Number(style?.fontSize || 54) * Math.max(0.2, Number(scale || 1)));
  const lines = [];
  let start = 0;
  for (let index = 0; index < displays.length; index += 1) {
    const candidate = estimatedLineWidth(displays.slice(start, index + 1), style, fontSize, scale);
    const lastAllowed = limit > 0 && lines.length >= Math.max(0, limit - 1);
    if (index > start && candidate > maxWidth && !lastAllowed) {
      let breakPoint = index;
      while (breakPoint > start + 1 && shouldCohesionStepBack(displays, breakPoint, start)) {
        breakPoint -= 1;
      }
      lines.push(displays.slice(start, breakPoint));
      start = breakPoint;
    }
  }
  lines.push(displays.slice(start));
  return lines;
}

export function wrapWords(text, style, maxWidth, maxLines = 2, scale = 1) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  return wrapCaptionWordList(words, style, maxWidth, maxLines, scale).map((line) => line.join(" "));
}

export function captionLayoutMetrics(caption, style, canvasWidth, layout = {}) {
  const scale = Math.max(0.2, Number(caption?.scale || 1));
  const widthScale = Math.max(0.5, Math.min(2.5, Number(style?.captionWidthScale || 1)));
  const maxWidth = Math.max(160, Math.min(canvasWidth, Number(caption?.width || canvasWidth * 0.90 * widthScale)));
  const maxLines = captionWrapLineLimit(layout?.maxLines ?? style?.captionLines ?? 2);
  const lines = wrapWords(caption?.text || "", style, maxWidth, maxLines, scale);
  return { scale, widthScale, maxWidth, maxLines, lines };
}

export function applyCaptionTextCase(text, textCase) {
  const value = String(text || "");
  if (textCase === "upper") return value.toUpperCase();
  if (textCase === "lower") return value.toLowerCase();
  if (textCase === "title") {
    return value.replace(/\S+/g, (word) => {
      const [first, ...rest] = Array.from(word);
      return `${String(first || "").toUpperCase()}${rest.join("").toLowerCase()}`;
    });
  }
  return value;
}

export function captionPaintOverflow(style = {}, scale = 1) {
  const sized = Math.max(0.2, Number(scale || 1));
  const stroke = Math.max(0, Number(style.stroke || 0)) * sized;
  const shadowDistance = Math.max(0, Number(style.shadowDistance ?? 0)) * sized;
  const shadowBlur = Math.max(0, Number(style.shadowBlur || 0)) * sized;
  const glow = Math.max(0, Number(style.glow || 0)) * sized;
  const shadow = Math.max(0, Number(style.shadow || 0));
  return Math.ceil(stroke + shadowDistance + shadowBlur * 0.75 + glow * 1.6 + (shadow > 0.01 ? 6 : 4));
}

export function captionHighlightSegments(caption = {}, highlightEnabled = true) {
  const start = Number(caption.start || 0);
  const end = Math.max(start + 0.04, Number(caption.end || start));
  if (highlightEnabled === false) return [{ start, end }];
  const times = [start, end];
  for (const word of Array.isArray(caption.words) ? caption.words : []) {
    const at = Number(word?.start);
    if (Number.isFinite(at) && at >= start && at < end) times.push(at);
  }
  const unique = [...new Set(times.map((value) => Math.round(Number(value) * 1000) / 1000))].sort(
    (left, right) => left - right,
  );
  const segments = [];
  for (let index = 0; index < unique.length - 1; index += 1) {
    if (unique[index + 1] - unique[index] > 0.01) {
      segments.push({ start: unique[index], end: unique[index + 1] });
    }
  }
  return segments.length ? segments : [{ start, end }];
}

export function layoutCaptionPaint(input = {}) {
  const style = input.style || {};
  const scale = Math.max(0.2, Number(input.scale || 1));
  const fontSize = Math.max(8, Number(style.fontSize || 54) * scale);
  const items = (Array.isArray(input.words) ? input.words : [])
    .map((word, index) => {
      const source = typeof word === "string" ? { display: word } : word || {};
      const display = applyCaptionTextCase(
        String(source.display || source.word || "").trim(),
        style.textCase,
      );
      return display
        ? {
            index,
            display,
            start: Number(source.start || 0),
            end: Number(source.end || 0),
          }
        : null;
    })
    .filter(Boolean);
  if (!items.length) {
    return {
      lines: [],
      fontSize,
      lineHeight: fontSize,
      gap: 0,
      padX: 0,
      padY: 0,
      radius: 0,
      contentWidth: 0,
      contentHeight: 0,
      boxWidth: 0,
      boxHeight: 0,
      backgroundMode: String(style.backgroundMode || "block"),
      fitText: style.backgroundFitText !== false,
      backgroundEnabled: !!style.backgroundEnabled,
    };
  }
  const measure =
    typeof input.measure === "function"
      ? (text) => Math.max(1, Number(input.measure(text, style, fontSize, scale)) || 1)
      : (text) => paintedWordWidth(text, style, fontSize, scale);
  const gap = Number.isFinite(Number(input.gap))
    ? Math.max(0, Number(input.gap))
    : wordGap(style, fontSize);
  const limit = captionWrapLineLimit(input.lineMode ?? style.captionLines ?? 2);
  const maxWidth = Math.max(80, Number(input.boxWidth || 860));
  const widths = items.map((item) => measure(item.display));
  const isZeroGapWord = (item) => /^[:;,.)!?]/.test(typeof item === "string" ? item : item?.display || "");
  const lineWidthOf = (from, to) => {
    let width = 0;
    for (let index = from; index < to; index += 1) {
      width += widths[index] + (index > from && !isZeroGapWord(items[index]) ? gap : 0);
    }
    return width;
  };
  const ranges = [];
  let start = 0;
  for (let index = 0; index < items.length; index += 1) {
    const lastAllowed = limit > 0 && ranges.length >= Math.max(0, limit - 1);
    if (index > start && lineWidthOf(start, index + 1) > maxWidth && !lastAllowed) {
      let breakPoint = index;
      while (breakPoint > start + 1 && shouldCohesionStepBack(items, breakPoint, start)) {
        breakPoint -= 1;
      }
      ranges.push([start, breakPoint]);
      start = breakPoint;
    }
  }
  ranges.push([start, items.length]);
  const lineHeight = fontSize * Math.max(0.8, Number(style.lineHeight || 1.15));
  const backgroundEnabled = !!style.backgroundEnabled;
  const padX = backgroundEnabled
    ? Math.max(0, Number(style.backgroundWidth ?? style.padding ?? 14) * scale)
    : 0;
  const padY = backgroundEnabled
    ? Math.max(0, Number(style.backgroundHeight ?? style.padding ?? 14) * scale)
    : 0;
  const radius = backgroundEnabled ? Math.max(0, Number(style.radius || 0) * scale) : 0;
  const align = String(style.textAlign || "center");
  const lines = ranges.map(([from, to], lineIndex) => ({
    index: lineIndex,
    width: lineWidthOf(from, to),
    y: padY + lineIndex * lineHeight,
    words: items.slice(from, to).map((item, offset) => ({
      ...item,
      width: widths[from + offset],
    })),
  }));
  const contentWidth = Math.max(0, ...lines.map((line) => line.width));
  const contentHeight = Math.max(lineHeight, lines.length * lineHeight);
  for (const line of lines) {
    let x = padX;
    if (align === "center") x = padX + (contentWidth - line.width) / 2;
    else if (align === "right") x = padX + (contentWidth - line.width);
    for (let i = 0; i < line.words.length; i += 1) {
      const word = line.words[i];
      if (i > 0 && !isZeroGapWord(word)) {
        x += gap;
      }
      word.x = x;
      word.y = line.y;
      word.height = fontSize;
      x += word.width;
    }
    line.x = line.words[0]?.x ?? padX;
    line.height = lineHeight;
  }
  return {
    lines,
    fontSize,
    lineHeight,
    gap,
    padX,
    padY,
    radius,
    contentWidth,
    contentHeight,
    boxWidth: contentWidth + padX * 2,
    boxHeight: contentHeight + padY * 2,
    backgroundMode: String(style.backgroundMode || "block"),
    fitText: style.backgroundFitText !== false,
    backgroundEnabled,
  };
}
