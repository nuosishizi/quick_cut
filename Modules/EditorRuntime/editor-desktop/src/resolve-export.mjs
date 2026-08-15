import fs from "node:fs";
import path from "node:path";
import { mergeRanges } from "./pausecut.mjs";
import { captionLayoutMetrics } from "./text-layout.mjs";
import { writeAssSubtitleFile } from "./media.mjs";

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function xmlName(value, max = 48) {
  return xmlEscape(String(value ?? "").slice(0, max));
}

export function fileUrl(filePath) {
  const resolved = path.resolve(String(filePath || "")).replace(/\\/g, "/");
  if (/^[A-Za-z]:/.test(resolved)) return `file://localhost/${encodeURI(resolved)}`;
  const prefixed = resolved.startsWith("/") ? resolved : `/${resolved}`;
  return `file://${encodeURI(prefixed)}`;
}

export function resolveTimebase(fps = 30) {
  const rate = Number(fps) || 30;
  if (Math.abs(rate - 23.976) < 0.02) return { num: 24000, den: 1001, name: "FFVideoFormat1080p2398" };
  if (Math.abs(rate - 29.97) < 0.02) return { num: 30000, den: 1001, name: "FFVideoFormat1080p2997" };
  if (Math.abs(rate - 59.94) < 0.02) return { num: 60000, den: 1001, name: "FFVideoFormat1080p5994" };
  const rounded = Math.max(1, Math.round(rate));
  return { num: rounded, den: 1, name: `FFVideoFormat1080p${rounded}` };
}

export function fcpxTime(seconds, timebase) {
  const frames = Math.max(0, Math.round(Number(seconds || 0) * timebase.num / timebase.den));
  return `${frames * timebase.den}/${timebase.num}s`;
}

export function snapClipsToTimebase(clips = [], timebase) {
  let cursor = 0;
  return (clips || []).map((clip) => {
    let startF = Math.round(Number(clip.start || 0) * timebase.num / timebase.den);
    let endF = Math.round(Number(clip.end || 0) * timebase.num / timebase.den);
    let sourceStartF = Math.round(Number(clip.sourceStart || 0) * timebase.num / timebase.den);
    let sourceEndF = Math.round(Number(clip.sourceEnd || 0) * timebase.num / timebase.den);
    if (startF < cursor) {
      sourceStartF += cursor - startF;
      startF = cursor;
    }
    if (endF <= startF) endF = startF + 1;
    if (sourceEndF <= sourceStartF) sourceEndF = sourceStartF + 1;
    cursor = endF;
    return {
      ...clip,
      start: (startF * timebase.den) / timebase.num,
      end: (endF * timebase.den) / timebase.num,
      sourceStart: (sourceStartF * timebase.den) / timebase.num,
      sourceEnd: (sourceEndF * timebase.den) / timebase.num,
    };
  });
}

export function keptSourceSegments(sourceDuration, removals = []) {
  const duration = Math.max(0, Number(sourceDuration || 0));
  const ranges = mergeRanges(removals || [], duration);
  const segments = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor + 0.002) segments.push({ sourceStart: cursor, sourceEnd: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < duration - 0.002) segments.push({ sourceStart: cursor, sourceEnd: duration });
  return segments;
}

export function normalizeTimelineClips(input = {}) {
  const clips = Array.isArray(input.clips) ? input.clips : [];
  const prepared = clips
    .map((clip, index) => {
      const start = Math.max(0, Number(clip.start || 0));
      const end = Math.max(start + 0.04, Number(clip.end || start));
      const sourceStart = Math.max(0, Number(clip.sourceStart ?? start));
      const sourceEnd = Math.max(sourceStart + 0.04, Number(clip.sourceEnd ?? end));
      return {
        id: String(clip.id || `clip-${index + 1}`),
        name: String(clip.name || `片段 ${index + 1}`),
        start,
        end,
        sourceStart,
        sourceEnd,
      };
    })
    .filter((clip) => clip.end > clip.start + 0.02)
    .sort((left, right) => left.start - right.start);
  if (prepared.length) return prepared;
  let timeline = 0;
  return keptSourceSegments(input.sourceDuration, input.removals).map((segment, index) => {
    const duration = segment.sourceEnd - segment.sourceStart;
    const clip = {
      id: `kept-${index + 1}`,
      name: `片段 ${index + 1}`,
      start: timeline,
      end: timeline + duration,
      sourceStart: segment.sourceStart,
      sourceEnd: segment.sourceEnd,
    };
    timeline += duration;
    return clip;
  });
}

function srtStamp(seconds) {
  const total = Math.max(0, Number(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const millis = Math.round((total - Math.floor(total)) * 1000);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(millis, 3)}`;
}

export function normalizeCaptionStyle(style = {}, transform = {}, canvas = {}) {
  const width = Math.max(320, Number(canvas.width || 1080));
  const height = Math.max(320, Number(canvas.height || 1920));
  const scale = Math.max(0.2, Number(transform.scale || 1));
  const fontSize = Math.max(10, Math.round(Number(style.fontSize || 58) * scale));
  const boxWidth = Math.max(
    160,
    Math.min(width, Number(transform.width || width * 0.8)),
  );
  return {
    fontFamily: String(style.fontFamily || "Helvetica"),
    fontSize,
    fontWeight: Number(style.fontWeight || 800),
    fontItalic: !!style.fontItalic,
    fontUnderline: !!style.fontUnderline,
    textCase: String(style.textCase || "none"),
    color: String(style.color || "#ffffff"),
    highlight: String(style.highlight || "#ffd21f"),
    highlightEnabled: style.highlightEnabled !== false,
    animation: String(style.animation || "fade"),
    stroke: Math.max(0, Number(style.stroke || 0)),
    strokeColor: String(style.strokeColor || "#000000"),
    shadow: Math.max(0, Number(style.shadow || 0)),
    shadowColor: String(style.shadowColor || "#000000"),
    shadowOpacity: Number(style.shadowOpacity ?? 0.8),
    shadowBlur: Number(style.shadowBlur || 0),
    shadowDistance: Number(style.shadowDistance ?? style.shadow ?? 0),
    shadowAngle: Number(style.shadowAngle ?? 45),
    glow: Math.max(0, Number(style.glow || 0)),
    glowColor: String(style.glowColor || style.color || "#ffffff"),
    backgroundEnabled: !!style.backgroundEnabled,
    background: String(style.background || "#000000"),
    backgroundOpacity: Number(style.backgroundOpacity ?? 0.7),
    backgroundMode: String(style.backgroundMode || "block"),
    textAlign: String(style.textAlign || "center"),
    verticalAlign: String(style.verticalAlign || "middle"),
    lineHeight: Number(style.lineHeight || 1.15),
    letterSpacing: Number(style.letterSpacing || 0),
    wordSpacing: Number(style.wordSpacing || 0),
    x: Number(transform.x || 0),
    y: Number(transform.y || 538),
    boxWidth,
    width,
    height,
    scale,
  };
}

export function wrapCaptionText(text, style = {}, canvasWidth = 1080, boxWidth = 860) {
  const layout = captionLayoutMetrics(
    { text, width: boxWidth, scale: 1 },
    style,
    canvasWidth,
    { maxLines: 2 },
  );
  return (layout.lines || []).map((line) => String(line || "").trim()).filter(Boolean);
}

function hexToRgba(hex, alpha = 1) {
  const raw = String(hex || "#ffffff").replace("#", "");
  const full = raw.length === 3 ? raw.split("").map((item) => item + item).join("") : raw.padEnd(6, "0");
  const value = Number.parseInt(full.slice(0, 6), 16);
  const r = ((value >> 16) & 255) / 255;
  const g = ((value >> 8) & 255) / 255;
  const b = (value & 255) / 255;
  return `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} ${Math.max(0, Math.min(1, Number(alpha || 1))).toFixed(3)}`;
}

function fontFace(style) {
  const weight = Number(style.fontWeight || 400);
  const italic = !!style.fontItalic;
  let face = weight >= 750 ? "Bold" : weight >= 600 ? "Semibold" : "Regular";
  if (italic) face = face === "Regular" ? "Italic" : `${face} Italic`;
  return face;
}

function assColor(hex, alpha = 1) {
  const raw = String(hex || "#ffffff").replace("#", "");
  const full = raw.length === 3 ? raw.split("").map((item) => item + item).join("") : raw.padEnd(6, "0");
  const r = full.slice(0, 2);
  const g = full.slice(2, 4);
  const b = full.slice(4, 6);
  const a = Math.round((1 - Math.max(0, Math.min(1, Number(alpha || 1)))) * 255)
    .toString(16)
    .padStart(2, "0");
  return `&H${a}${b}${g}${r}&`.toUpperCase();
}

export function styledCaption(caption = {}, input = {}) {
  const style = normalizeCaptionStyle(
    caption.style || input.captionStyle || {},
    {
      ...(input.captionTransform || {}),
      scale: caption.scale ?? input.captionTransform?.scale,
      width: caption.width ?? input.captionTransform?.width,
      x: caption.x ?? input.captionTransform?.x,
      y: caption.y ?? input.captionTransform?.y,
    },
    { width: input.width, height: input.height },
  );
  const text = String(caption.text || "").trim();
  const lines = wrapCaptionText(text, style, style.width, style.boxWidth);
  return { ...style, text, lines, start: Number(caption.start || 0), end: Number(caption.end || 0) };
}

export function buildResolveSrt(captions = [], input = {}) {
  return (captions || [])
    .map((caption, index) => {
      const styled = styledCaption(caption, input);
      if (!styled.lines.length) return "";
      const start = Math.max(0, styled.start);
      const end = Math.max(start + 0.04, styled.end || start);
      return `${index + 1}\n${srtStamp(start)} --> ${srtStamp(end)}\n${styled.lines.join("\n")}\n`;
    })
    .filter(Boolean)
    .join("\n");
}

export function buildResolveAss(captions = [], input = {}) {
  const first = styledCaption(captions[0] || { text: " " }, input);
  const alignment = first.textAlign === "left" ? 1 : first.textAlign === "right" ? 3 : 2;
  const marginV = Math.max(20, Math.round(first.height / 2 - first.y - first.fontSize * 0.35));
  const marginL = Math.max(10, Math.round((first.width - first.boxWidth) / 2));
  const events = (captions || [])
    .map((caption) => {
      const styled = styledCaption(caption, input);
      if (!styled.lines.length) return "";
      const start = assTime(styled.start);
      const end = assTime(Math.max(styled.start + 0.04, styled.end));
      return `Dialogue: 0,${start},${end},Default,,0,0,0,,${styled.lines.join("\\N")}`;
    })
    .filter(Boolean);
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${first.width}
PlayResY: ${first.height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${first.fontFamily},${first.fontSize},${assColor(first.color)},${assColor(first.color)},${assColor(first.strokeColor)},&H64000000&,${first.fontWeight >= 700 ? -1 : 0},${first.fontItalic ? -1 : 0},0,0,100,100,${first.letterSpacing.toFixed(2)},0,1,${Math.round(first.stroke)},${Math.round(first.shadow)},${alignment},${marginL},${marginL},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`;
}

function assTime(seconds) {
  const total = Math.max(0, Number(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const cs = Math.round((total - Math.floor(total)) * 100);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${hours}:${pad(minutes)}:${pad(secs)}.${pad(cs)}`;
}

function captionWordList(caption, styled) {
  if (Array.isArray(caption.words) && caption.words.length)
    return caption.words
      .map((word) => ({
        display: String(word.display || "").trim(),
        start: Number(word.start ?? styled.start),
        end: Number(word.end ?? styled.end),
      }))
      .filter((word) => word.display);
  const tokens = styled.lines.join(" ").split(/\s+/).filter(Boolean);
  return tokens.map((display, index) => ({
    display,
    start: styled.start + ((styled.end - styled.start) * index) / Math.max(1, tokens.length),
    end: styled.start + ((styled.end - styled.start) * (index + 1)) / Math.max(1, tokens.length),
  }));
}

function wordsWithWrap(caption, styled) {
  const words = captionWordList(caption, styled);
  const lineTokens = styled.lines.map((line) => line.split(/\s+/).filter(Boolean));
  const marked = [];
  let cursor = 0;
  lineTokens.forEach((line, lineIndex) => {
    line.forEach((token, tokenIndex) => {
      const word = words[cursor] || {
        display: token,
        start: styled.start,
        end: styled.end,
      };
      cursor += 1;
      marked.push({
        ...word,
        display: word.display || token,
        breakAfter: tokenIndex === line.length - 1 && lineIndex < lineTokens.length - 1,
      });
    });
  });
  return marked.length ? marked : words;
}

export function captionHighlightEnabled(caption, input) {
  return (input.captionStyle?.highlightEnabled ?? caption.style?.highlightEnabled) !== false;
}

function captionHighlightColor(caption, input) {
  return input.captionStyle?.highlight || caption.style?.highlight || "#ffd21f";
}

function captionAnimationName(caption, input) {
  return String(caption.style?.animation || input.captionStyle?.animation || "fade");
}

export function captionCueWindows(caption, input = {}) {
  const styled = styledCaption(caption, input);
  if (!styled.lines.length) return [];
  const highlight = captionHighlightColor(caption, input);
  const words = wordsWithWrap(caption, styled);
  const animation = captionAnimationName(caption, input);
  const wordMotion =
    animation === "karaoke" ||
    animation === "typewriter" ||
    animation.startsWith("word-") ||
    ["underline", "outline-active", "line-pulse"].includes(animation);
  if ((!captionHighlightEnabled(caption, input) && !wordMotion) || words.length < 2) {
    return [{
      start: styled.start,
      end: styled.end,
      styled,
      highlight,
      activeIndex: -1,
      words,
      animation,
    }];
  }
  return words
    .map((word, index) => {
      const start = Math.max(styled.start, Number(word.start || styled.start));
      const nextStart = Number(words[index + 1]?.start);
      const end = Math.min(
        styled.end,
        Number.isFinite(nextStart) ? nextStart : Number(word.end || styled.end),
      );
      if (end <= start + 0.02) return null;
      return { start, end, styled, highlight, activeIndex: index, words, animation };
    })
    .filter(Boolean);
}

export function applyCaptionTextCase(text, textCase) {
  const value = String(text ?? "");
  const mode = String(textCase || "none");
  if (mode === "upper") return value.toUpperCase();
  if (mode === "lower") return value.toLowerCase();
  if (mode === "title") {
    return value.replace(/(\S+)/g, (word) => {
      const chars = [...word];
      if (!chars.length) return word;
      return chars[0].toLocaleUpperCase() + chars.slice(1).join("").toLocaleLowerCase();
    });
  }
  return value;
}

export function isCaptionWordMotion(animation) {
  const name = String(animation || "");
  return (
    name === "karaoke" ||
    name === "typewriter" ||
    name.startsWith("word-") ||
    name === "underline" ||
    name === "outline-active" ||
    name === "line-pulse"
  );
}

export function captionWordGap(left, right) {
  if (!right) return "";
  if (
    /[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]$/.test(left) ||
    /^[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(right)
  ) {
    return "";
  }
  return " ";
}

function activeLineIndices(words, activeIndex) {
  const hot = new Set();
  if (activeIndex < 0 || !words[activeIndex]) return hot;
  let start = activeIndex;
  while (start > 0 && !words[start - 1]?.breakAfter) start -= 1;
  for (let index = start; index < words.length; index += 1) {
    hot.add(index);
    if (words[index].breakAfter) break;
  }
  return hot;
}

function pushCaptionRun(runs, text, flags) {
  if (!text) return;
  const last = runs[runs.length - 1];
  if (
    last &&
    last.highlight === flags.highlight &&
    last.grow === flags.grow &&
    last.underline === flags.underline
  ) {
    last.text += text;
    return;
  }
  runs.push({
    text,
    highlight: !!flags.highlight,
    grow: !!flags.grow,
    underline: !!flags.underline,
  });
}

export function utf8Length(text) {
  return [...String(text ?? "")].length;
}

export function resolveCaptionEffect(animation, options = {}) {
  const name = String(animation || "fade");
  const highlightOn = options.highlightEnabled !== false;
  const effect = {
    highlightStyle: 0,
    keepPast: name === "karaoke",
    hideFuture: name === "typewriter",
    motion: "none",
    wordLevel: false,
  };
  if (name === "outline-active") effect.highlightStyle = 1;
  else if (name === "underline") effect.highlightStyle = 1;
  else if (name === "word-pill" || name === "word-box" || name === "word-ring") effect.highlightStyle = 3;
  else if (name === "glow" || name === "neon-pulse" || name === "word-gradient") effect.highlightStyle = 2;
  if (
    name === "word-pop" ||
    name === "pop" ||
    name === "zoom" ||
    name === "word-bounce" ||
    name === "word-squash"
  ) {
    effect.motion = "pop";
    effect.wordLevel = true;
  } else if (
    name === "word-lift" ||
    name === "word-rise" ||
    name === "rise" ||
    name === "word-wave"
  ) {
    effect.motion = "slide";
    effect.wordLevel = true;
  } else if (name === "fade" || name === "typewriter") {
    effect.motion = "fade";
    effect.wordLevel = name === "typewriter";
  }
  if (name.startsWith("word-") || name === "karaoke" || name === "typewriter" || name === "line-pulse") {
    effect.wordLevel = true;
  }
  effect.highlightEnabled = highlightOn && (name !== "none");
  return effect;
}

export function buildResolveCaptionItem(caption, input = {}) {
  const styled = styledCaption(caption, input);
  if (!styled.lines.length) return null;
  const textCase = caption.style?.textCase || input.captionStyle?.textCase || "none";
  const animation = captionAnimationName(caption, input);
  const words = wordsWithWrap(caption, styled);
  const parts = [];
  const timing = [];
  let charIndex = 0;
  words.forEach((word, index) => {
    const display = applyCaptionTextCase(word.display, textCase);
    const startIndex = charIndex;
    parts.push(display);
    charIndex += utf8Length(display);
    timing.push({
      display,
      startIndex,
      endIndex: Math.max(startIndex, charIndex - 1),
      start: Math.max(0, Number(word.start ?? styled.start) - styled.start),
      end: Math.max(0, Number(word.end ?? styled.end) - styled.start),
    });
    if (word.breakAfter) {
      parts.push("\n");
      charIndex += 1;
      return;
    }
    const next = words[index + 1];
    if (!next) return;
    const gap = captionWordGap(display, applyCaptionTextCase(next.display, textCase));
    if (gap) {
      parts.push(gap);
      charIndex += utf8Length(gap);
    }
  });
  const text = parts.join("") || applyCaptionTextCase(styled.lines.join("\n"), textCase);
  const start = Math.max(0, Number(styled.start || 0));
  const end = Math.max(start + 0.04, Number(styled.end || start));
  const effect = resolveCaptionEffect(animation, {
    highlightEnabled: captionHighlightEnabled(caption, input),
  });
  return {
    text,
    start,
    end,
    animation,
    words: timing,
    ...effect,
  };
}

export function buildResolveCaptionCues(caption, input = {}) {
  const windows = captionCueWindows(caption, input);
  const textCase = caption.style?.textCase || input.captionStyle?.textCase || "none";
  return windows
    .map((cue) => {
      const animation = cue.animation || "fade";
      const highlightOn = captionHighlightEnabled(caption, input);
      const words = cue.words || [];
      const active = cue.activeIndex;
      if (active < 0 || words.length < 2) {
        const text = applyCaptionTextCase((cue.styled.lines || []).join("\n"), textCase);
        return {
          start: cue.start,
          end: cue.end,
          text,
          runs: [{ text, highlight: false, grow: false, underline: false }],
          animation,
          highlight: cue.highlight,
        };
      }
      const lineHot = animation === "line-pulse" ? activeLineIndices(words, active) : null;
      const runs = [];
      words.forEach((word, index) => {
        if (animation === "typewriter" && index > active) return;
        const display = applyCaptionTextCase(word.display, textCase);
        const isActive = index === active;
        const isPast = index < active;
        let highlight = false;
        if (highlightOn) {
          if (animation === "karaoke") highlight = isActive || isPast;
          else if (animation === "line-pulse") highlight = lineHot.has(index);
          else highlight = isActive;
        }
        pushCaptionRun(runs, display, {
          highlight,
          grow: isActive && String(animation).startsWith("word-"),
          underline: isActive && animation === "underline",
        });
        if (word.breakAfter) {
          pushCaptionRun(runs, "\n", { highlight: false, grow: false, underline: false });
          return;
        }
        const next = words[index + 1];
        if (!next || (animation === "typewriter" && index + 1 > active)) return;
        const gap = captionWordGap(display, applyCaptionTextCase(next.display, textCase));
        if (gap) {
          pushCaptionRun(runs, gap, {
            highlight: animation === "karaoke" && highlightOn && (isActive || isPast),
            grow: false,
            underline: false,
          });
        }
      });
      const text = runs.map((run) => run.text).join("");
      return {
        start: cue.start,
        end: cue.end,
        text,
        runs: runs.length ? runs : [{ text, highlight: false, grow: false, underline: false }],
        animation,
        highlight: cue.highlight,
      };
    })
    .filter((cue) => String(cue.text || "").trim());
}

function cueWordLines(cue) {
  if (cue.activeIndex < 0) {
    return cue.styled.lines.map((line) =>
      String(line)
        .split(/\s+/)
        .filter(Boolean)
        .map((display) => ({ display, index: -1 })),
    );
  }
  const lines = [[]];
  cue.words.forEach((word, index) => {
    if (cue.animation === "typewriter" && index > cue.activeIndex) return;
    lines[lines.length - 1].push({ display: word.display, index });
    if (word.breakAfter) lines.push([]);
  });
  return lines.filter((line) => line.length);
}

function hexCss(hex, alpha = 1) {
  const raw = String(hex || "#ffffff").replace("#", "");
  const full = raw.length === 3 ? raw.split("").map((item) => item + item).join("") : raw.padEnd(6, "0").slice(0, 6);
  const a = Math.round(Math.max(0, Math.min(1, Number(alpha))) * 255)
    .toString(16)
    .padStart(2, "0");
  return Number(alpha) >= 1 ? `#${full}` : `#${full}${a}`;
}

function captionRegion(styled) {
  const centerY = styled.height / 2 + styled.y;
  const topPct = Math.max(2, Math.min(86, ((centerY - styled.fontSize) / styled.height) * 100));
  const widthPct = Math.max(40, Math.min(96, (styled.boxWidth / styled.width) * 100));
  const leftPct = Math.max(2, Math.min(50, (100 - widthPct) / 2 + (styled.x / styled.width) * 100));
  return {
    leftPct,
    topPct,
    widthPct,
    heightPct: Math.max(14, Math.min(36, 100 - topPct - 2)),
    bottomPct: Math.max(6, Math.min(42, 100 - (centerY / styled.height) * 100)),
  };
}

function ttmlTime(seconds) {
  return srtStamp(seconds).replace(",", ".");
}

function textStyleDef(id, styled, color) {
  const align = styled.textAlign === "left" || styled.textAlign === "right" ? styled.textAlign : "center";
  return `              <text-style-def id="${id}">
                <text-style font="${xmlEscape(styled.fontFamily)}" fontSize="${styled.fontSize}" fontFace="${fontFace(styled)}" fontColor="${hexToRgba(color)}" strokeColor="${hexToRgba(styled.strokeColor)}" strokeWidth="${styled.stroke}" shadowColor="${hexToRgba(styled.shadowColor, 0.8)}" alignment="${align}" lineSpacing="${Math.max(0, (styled.lineHeight - 1) * styled.fontSize).toFixed(1)}"${styled.fontItalic ? ' italic="1"' : ""}/>
              </text-style-def>`;
}

function titleBlock(name, clip, timebase, styled, start, end, textXml, styleXml) {
  const offset = Math.max(0, start - Number(clip.start || 0));
  const duration = Math.max(0.04, end - start);
  return `            <title ref="r3" name="${xmlName(name)}" lane="1" offset="${fcpxTime(offset, timebase)}" duration="${fcpxTime(duration, timebase)}" start="3600s">
              <param name="Position" key="9999/999166631/999166633/1/100/101" value="${styled.x.toFixed(1)} ${(-styled.y).toFixed(1)}"/>
              <param name="Alignment" key="9999/999166631/999166633/2/354/1002961760/401" value="1 (Center)"/>
              <text>
${textXml}
              </text>
${styleXml}
            </title>`;
}

function titleXml(caption, clip, timebase, styleId, input) {
  return captionCueWindows(caption, input).map((cue, index) => {
    if (cue.activeIndex < 0) {
      const text = xmlEscape(cue.styled.lines.join("\n")).replace(/\n/g, "&#13;");
      return titleBlock(
        cue.styled.lines[0],
        clip,
        timebase,
        cue.styled,
        cue.start,
        cue.end,
        `                <text-style ref="${styleId}">${text}</text-style>`,
        textStyleDef(styleId, cue.styled, cue.styled.color),
      );
    }
    const spans = cue.words.map((item, wordIndex) => {
      const ref = wordIndex === cue.activeIndex ? `${styleId}h${index}` : `${styleId}b${index}`;
      const gap = item.breakAfter ? "&#13;" : wordIndex < cue.words.length - 1 ? " " : "";
      return `                <text-style ref="${ref}">${xmlEscape(item.display)}${gap}</text-style>`;
    });
    return titleBlock(
      `${cue.styled.lines[0]} · ${cue.words[cue.activeIndex].display}`,
      clip,
      timebase,
      cue.styled,
      cue.start,
      cue.end,
      spans.join("\n"),
      [
        textStyleDef(`${styleId}b${index}`, cue.styled, cue.styled.color),
        textStyleDef(`${styleId}h${index}`, cue.styled, cue.highlight),
      ].join("\n"),
    );
  });
}

function flattenCaptions(captions = [], input = {}) {
  return (captions || []).flatMap((caption) => captionCueWindows(caption, input));
}

function styledCueMarkup(cue, highlightTag) {
  return cueWordLines(cue)
    .map((line, lineIndex, lines) => {
      const text = line
        .map((item, tokenIndex) => {
          const word = xmlEscape(item.display);
          const marked =
            cue.activeIndex >= 0 && item.index === cue.activeIndex
              ? highlightTag(word)
              : word;
          return marked + (tokenIndex < line.length - 1 ? " " : "");
        })
        .join("");
      return text + (lineIndex < lines.length - 1 ? "<br/>" : "");
    })
    .join("");
}

export function buildResolveVtt(captions = [], input = {}) {
  const first = styledCaption(captions[0] || { text: " " }, input);
  const region = captionRegion(first);
  const cues = flattenCaptions(captions, input).map((cue) => {
    const start = ttmlTime(cue.start);
    const end = ttmlTime(Math.max(cue.start + 0.04, cue.end));
    const inner = styledCueMarkup(cue, (word) => `<c.hi>${word}</c>`).replace(/<br\/>/g, "\n");
    return `${start} --> ${end} line:${Math.round(region.topPct)}% align:center size:${Math.round(region.widthPct)}%\n${inner}\n`;
  });
  return `WEBVTT

STYLE
::cue {
  color: ${first.color};
  font-family: ${first.fontFamily};
  font-size: ${first.fontSize}px;
  font-weight: ${first.fontWeight >= 700 ? "bold" : "normal"};
  text-align: ${first.textAlign || "center"};
}
::cue(.hi) {
  color: ${captionHighlightColor(captions[0] || {}, input)};
}

${cues.join("\n")}`;
}

export function buildResolveItt(captions = [], input = {}) {
  const first = styledCaption(captions[0] || { text: " " }, input);
  const region = captionRegion(first);
  const highlight = captionHighlightColor(captions[0] || {}, input);
  const rawStyle = { ...(input.captionStyle || {}), ...(captions[0]?.style || {}) };
  const outline =
    first.stroke > 0
      ? ` tts:textOutline="${hexCss(first.strokeColor)} ${Math.max(1, Math.round(first.stroke))}px"`
      : "";
  const shadow =
    first.shadow > 0
      ? ` tts:textShadow="${Math.max(1, Math.round(first.shadow))}px ${Math.max(1, Math.round(first.shadow))}px ${Math.max(1, Math.round(first.shadow / 2))}px ${hexCss(first.shadowColor, Number(rawStyle.shadowOpacity ?? 0.8))}"`
      : "";
  const background = rawStyle.backgroundEnabled
    ? ` tts:backgroundColor="${hexCss(rawStyle.background || "#000000", rawStyle.backgroundOpacity ?? 0.7)}"`
    : "";
  const italic = first.fontItalic ? ' tts:fontStyle="italic"' : "";
  const cues = flattenCaptions(captions, input).map((cue) => {
    const inner = styledCueMarkup(cue, (word) => `<span style="hi">${word}</span>`);
    return `      <p begin="${ttmlTime(cue.start)}" end="${ttmlTime(Math.max(cue.start + 0.04, cue.end))}" style="s1" region="r1">${inner}</p>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" xml:lang="en" ttp:timeBase="media" ttp:cellResolution="32 15">
  <head>
    <styling>
      <style xml:id="s1" tts:fontFamily="${xmlEscape(first.fontFamily)}" tts:fontSize="${first.fontSize}px" tts:fontWeight="${first.fontWeight >= 700 ? "bold" : "normal"}" tts:color="${hexCss(first.color)}" tts:textAlign="${first.textAlign || "center"}" tts:lineHeight="${Math.round(first.lineHeight * 100)}%" tts:wrapOption="wrap"${italic}${outline}${shadow}${background}/>
      <style xml:id="hi" tts:color="${hexCss(highlight)}" tts:fontWeight="bold"/>
    </styling>
    <layout>
      <region xml:id="r1" tts:origin="${region.leftPct.toFixed(1)}% ${region.topPct.toFixed(1)}%" tts:extent="${region.widthPct.toFixed(1)}% ${region.heightPct.toFixed(1)}%" tts:displayAlign="after" tts:textAlign="${first.textAlign || "center"}" tts:overflow="visible"/>
    </layout>
  </head>
  <body>
    <div>
${cues.join("\n")}
    </div>
  </body>
</tt>
`;
}

function dcstTime(seconds, fps = 30) {
  const rate = Math.max(1, Math.round(Number(fps) || 30));
  const totalFrames = Math.max(0, Math.round(Number(seconds || 0) * rate));
  const frames = totalFrames % rate;
  const totalSecs = Math.floor(totalFrames / rate);
  const secs = totalSecs % 60;
  const mins = Math.floor(totalSecs / 60) % 60;
  const hours = Math.floor(totalSecs / 3600);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(hours)}:${pad(mins)}:${pad(secs)}:${pad(frames)}`;
}

function dcstColor(hex, alpha = 1) {
  const raw = String(hex || "#ffffff").replace("#", "");
  const full = raw.length === 3 ? raw.split("").map((item) => item + item).join("") : raw.padEnd(6, "0").slice(0, 6);
  const a = Math.round(Math.max(0, Math.min(1, Number(alpha))) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${a}${full}`.toUpperCase();
}

function dcstUuid(seed = "quickcut") {
  const text = String(seed || "quickcut");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1)
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  const hex = hash.toString(16).padStart(8, "0");
  return `${hex}-0000-4000-8000-${hex.padEnd(12, "0").slice(0, 12)}`;
}

export function buildResolveDcst(captions = [], input = {}) {
  const first = styledCaption(captions[0] || { text: " " }, input);
  const fps = Number(input.fps || 30);
  const region = captionRegion(first);
  const effect = first.stroke > 0 ? "border" : first.shadow > 0 ? "shadow" : "none";
  const effectColor = first.stroke > 0 ? first.strokeColor : first.shadowColor;
  const fadeAnim = ["fade", "rise", "drop", "alisha-reveal"].includes(
    captionAnimationName(captions[0] || {}, input),
  );
  const spots = flattenCaptions(captions, input).map((cue, index) => {
    const fade = fadeAnim && cue.activeIndex < 0 ? dcstTime(0.2, fps) : dcstTime(0, fps);
    const lines = cueWordLines(cue);
    const texts = lines.map((line, lineIndex) => {
      const vPos = (region.bottomPct + (lines.length - 1 - lineIndex) * 6).toFixed(1);
      const inner = line
        .map((item, tokenIndex) => {
          const color =
            cue.activeIndex >= 0 && item.index === cue.activeIndex
              ? dcstColor(cue.highlight)
              : dcstColor(cue.styled.color);
          const gap = tokenIndex < line.length - 1 ? " " : "";
          return `<Font Color="${color}">${xmlEscape(item.display)}${gap}</Font>`;
        })
        .join("");
      return `        <Text HAlign="${cue.styled.textAlign || "center"}" HPosition="0.0" VAlign="bottom" VPosition="${vPos}">${inner}</Text>`;
    });
    return `      <Subtitle SpotNumber="${index + 1}" TimeIn="${dcstTime(cue.start, fps)}" TimeOut="${dcstTime(Math.max(cue.start + 0.04, cue.end), fps)}" FadeUpTime="${fade}" FadeDownTime="${fade}">
${texts.join("\n")}
      </Subtitle>`;
  });
  const title = xmlEscape(input.projectName || "快剪导出");
  return `<?xml version="1.0" encoding="UTF-8"?>
<DCSubtitle Version="1.0">
  <SubtitleID>${dcstUuid(title)}</SubtitleID>
  <MovieTitle>${title}</MovieTitle>
  <ReelNumber>1</ReelNumber>
  <Language>en</Language>
  <Font Id="Font1" Color="${dcstColor(first.color)}" Effect="${effect}" EffectColor="${dcstColor(effectColor)}" Size="${first.fontSize}" AspectAdjust="1.0" Italic="${first.fontItalic ? "yes" : "no"}" Underlined="no" Weight="${first.fontWeight >= 700 ? "bold" : "normal"}">
${spots.join("\n")}
  </Font>
</DCSubtitle>
`;
}

export function buildResolveFcpxml(input = {}) {
  const videoPath = String(input.inputPath || "");
  if (!videoPath) throw new Error("没有可导出的视频素材。");
  const timebase = resolveTimebase(input.fps);
  const clips = snapClipsToTimebase(normalizeTimelineClips(input), timebase);
  if (!clips.length) throw new Error("时间线上没有可导出的剪辑。");
  const captions = (input.captions || [])
    .map((caption) => ({
      text: String(caption.text || "").trim(),
      start: Number(caption.start || 0),
      end: Number(caption.end || 0),
      words: caption.words,
      style: caption.style,
      width: caption.width,
      scale: caption.scale,
      x: caption.x,
      y: caption.y,
    }))
    .filter((caption) => caption.text && caption.end > caption.start);
  const width = Math.max(1, Number(input.width || 1080));
  const height = Math.max(1, Number(input.height || 1920));
  const sourceDuration = Math.max(
    Number(input.sourceDuration || 0),
    ...clips.map((clip) => clip.sourceEnd),
  );
  const sequenceDuration = Math.max(...clips.map((clip) => clip.end));
  const projectName = xmlEscape(input.projectName || "快剪导出");
  const assetName = xmlEscape(path.basename(videoPath));
  const usedCaptions = new Set();
  const clipXml = clips.map((clip, index) => {
    const nested = [];
    captions.forEach((caption, captionIndex) => {
      if (usedCaptions.has(captionIndex)) return;
      const overlap =
        Math.min(clip.end, caption.end) - Math.max(clip.start, caption.start);
      if (overlap <= 0.02) return;
      usedCaptions.add(captionIndex);
      const titles = titleXml(caption, clip, timebase, `ts${captionIndex + 1}`, input);
      if (titles.length) nested.push(...titles);
    });
    const inner = nested.length ? `\n${nested.join("\n")}\n          ` : "";
    return `          <asset-clip ref="r2" offset="${fcpxTime(clip.start, timebase)}" name="${xmlEscape(clip.name)}" start="${fcpxTime(clip.sourceStart, timebase)}" duration="${fcpxTime(clip.end - clip.start, timebase)}" tcFormat="NDF">${inner}</asset-clip>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
    <format id="r1" name="${timebase.name}" frameDuration="${timebase.den}/${timebase.num}s" width="${width}" height="${height}" colorSpace="1-1-1 (Rec. 709)"/>
    <asset id="r2" name="${assetName}" src="${xmlEscape(fileUrl(videoPath))}" start="0s" duration="${fcpxTime(sourceDuration, timebase)}" hasVideo="1" hasAudio="1" format="r1" videoSources="1" audioSources="1"/>
    <effect id="r3" name="Basic Title" uid=".../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti"/>
  </resources>
  <library>
    <event name="快剪">
      <project name="${projectName}">
        <sequence format="r1" duration="${fcpxTime(sequenceDuration, timebase)}" tcStart="0s" tcFormat="NDF">
          <spine>
${clipXml.join("\n")}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}

export function writeResolveTimeline(input = {}) {
  const outputPath = String(input.outputPath || "");
  if (!outputPath) throw new Error("请选择达芬奇时间线保存位置。");
  const xml = buildResolveFcpxml(input);
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);)/.test(xml))
    throw new Error("导出的达芬奇 XML 含有未闭合实体，请重试导出。");
  const srt = buildResolveSrt(input.captions || [], input);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, xml, "utf8");
  const base = outputPath.replace(/\.fcpxml$/i, "");
  const srtPath = `${base}.srt`;
  const ttmlPath = `${base}.ttml`;
  const dfxpPath = `${base}.dfxp`;
  const vttPath = `${base}.vtt`;
  const webvttPath = `${base}.webvtt`;
  const ittPath = `${base}.itt`;
  const subtitleXmlPath = `${base}.xml`;
  const assPath = `${base}.ass`;
  if (srt.trim()) {
    const ttml = buildResolveItt(input.captions || [], input);
    const vtt = buildResolveVtt(input.captions || [], input);
    fs.writeFileSync(srtPath, srt, "utf8");
    fs.writeFileSync(ttmlPath, ttml, "utf8");
    fs.writeFileSync(dfxpPath, ttml, "utf8");
    fs.writeFileSync(ittPath, ttml, "utf8");
    fs.writeFileSync(vttPath, vtt, "utf8");
    fs.writeFileSync(webvttPath, vtt, "utf8");
    fs.writeFileSync(subtitleXmlPath, ttml, "utf8");
  }
  const styledCaptions = (input.captions || [])
    .filter((item) => String(item.text || "").trim())
    .map((caption) => {
      const style = { ...(input.captionStyle || {}), ...(caption.style || {}) };
      const animation = String(style.animation || "fade");
      const wordAnim =
        animation === "karaoke" ||
        animation === "typewriter" ||
        animation.startsWith("word-") ||
        ["underline", "outline-active", "line-pulse"].includes(animation);
      if (style.highlightEnabled !== false && !wordAnim) style.animation = "karaoke";
      return {
        ...caption,
        x: caption.x ?? input.captionTransform?.x ?? 0,
        y: caption.y ?? input.captionTransform?.y ?? 538,
        scale: caption.scale ?? input.captionTransform?.scale ?? 1,
        width: caption.width ?? input.captionTransform?.width,
        style,
      };
    });
  if (styledCaptions.length)
    writeAssSubtitleFile(
      {
        captions: styledCaptions,
        width: input.width,
        height: input.height,
      },
      assPath,
    );
  return {
    xmlPath: outputPath,
    srtPath: srt.trim() ? srtPath : "",
    ttmlPath: srt.trim() ? ttmlPath : "",
    dfxpPath: srt.trim() ? dfxpPath : "",
    vttPath: srt.trim() ? vttPath : "",
    webvttPath: srt.trim() ? webvttPath : "",
    ittPath: srt.trim() ? ittPath : "",
    subtitleXmlPath: srt.trim() ? subtitleXmlPath : "",
    assPath: styledCaptions.length ? assPath : "",
    clipCount: normalizeTimelineClips(input).length,
    captionCount: styledCaptions.length,
    karaoke: styledCaptions.some((item) =>
      ["karaoke", "typewriter", "underline", "outline-active", "line-pulse"].includes(
        String(item.style?.animation || ""),
      ) || String(item.style?.animation || "").startsWith("word-"),
    ),
  };
}
