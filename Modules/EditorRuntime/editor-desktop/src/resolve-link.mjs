import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { supportRoot } from "./media.mjs";
import { normalizeCaptionStyle, wrapCaptionText } from "./resolve-export.mjs";

export const RESOLVE_SCRIPT_NAME = "快剪.lua";
export const RESOLVE_CAPTION_BIN = "caption-bin.drb";
const LISTENER_STALE_MS = 4000;

export function bundledResolveScriptPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "resolve-script", RESOLVE_SCRIPT_NAME);
}

export function bundledCaptionBinPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "resolve-script", RESOLVE_CAPTION_BIN);
}

export function resolveScriptDirectories() {
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return [
      path.join(
        appdata,
        "Blackmagic Design",
        "DaVinci Resolve",
        "Support",
        "Fusion",
        "Scripts",
        "Utility",
      ),
    ];
  }
  const home = os.homedir();
  return [
    path.join(
      home,
      "Library",
      "Application Support",
      "Blackmagic Design",
      "DaVinci Resolve",
      "Fusion",
      "Scripts",
      "Utility",
    ),
    path.join(
      home,
      "Library",
      "Application Support",
      "Blackmagic Design",
      "DaVinci Resolve",
      "Support",
      "Fusion",
      "Scripts",
      "Utility",
    ),
  ];
}

export function resolveLinkRoot() {
  return path.join(supportRoot(), "resolve-link");
}

export function ensureResolveLinkDirs() {
  const root = resolveLinkRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

export function hexToUnitRgb(hex) {
  const raw = String(hex || "#ffffff").replace("#", "");
  const full = raw.length === 3 ? raw.split("").map((part) => part + part).join("") : raw.padEnd(6, "0").slice(0, 6);
  const value = Number.parseInt(full, 16);
  if (!Number.isFinite(value)) return [1, 1, 1];
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

export function hexToCss(hex) {
  const raw = String(hex || "#ffffff").replace("#", "");
  const full = raw.length === 3 ? raw.split("").map((part) => part + part).join("") : raw.padEnd(6, "0").slice(0, 6);
  return `#${full.toUpperCase()}`;
}

export function fusionFontStyle(style = {}) {
  const bold = Number(style.fontWeight || 400) >= 700;
  const italic = !!style.fontItalic;
  if (bold && italic) return "Bold Italic";
  if (bold) return "Bold";
  if (italic) return "Italic";
  return "Regular";
}

export function sampleHasCjk(text) {
  return /[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(String(text || ""));
}

export function pickResolveFont(family, sampleText, platform = process.platform) {
  if (sampleHasCjk(sampleText)) {
    return platform === "win32" ? "Microsoft YaHei" : "PingFang SC";
  }
  const name = String(family || "Arial").trim() || "Arial";
  if (platform === "win32" && /helvetica/i.test(name)) return "Arial";
  return name;
}

export function fusionTextSize(fontSize, canvas = {}) {
  const width = Math.max(320, Number(canvas.width) || Number(canvas) || 1080);
  const height = Math.max(320, Number(canvas.height) || 1920);
  const basis = Math.min(width, height);
  const size = Math.max(10, Number(fontSize) || 58);
  return Math.max(0.040, Math.min(0.20, (size / basis) * 1.40));
}

export function fusionCenter(transform = {}, canvas = {}) {
  const width = Math.max(320, Number(canvas.width) || 1080);
  const height = Math.max(320, Number(canvas.height) || 1920);
  const x = Number(transform.x || 0);
  const y = Number(transform.y ?? 538);
  return {
    centerX: Math.max(0, Math.min(1, 0.5 + x / width)),
    centerY: Math.max(0, Math.min(1, 1 - (0.5 + y / height))),
  };
}

export function fusionStroke(stroke, fontSize) {
  const px = Math.max(0, Number(stroke) || 0);
  if (px <= 0) return 0;
  const size = Math.max(10, Number(fontSize) || 58);
  return Math.max(0.035, Math.min(0.35, (px / size) * 0.95));
}

export function fusionShadow(style = {}) {
  const amount = Math.max(0, Number(style.shadow) || 0);
  if (amount <= 0) return { enabled: false, softness: 0, offset: 0, opacity: 0, angle: 45 };
  const blur = Math.max(amount, Number(style.shadowBlur) || 0);
  const distance = Math.max(amount, Number(style.shadowDistance) || amount);
  const size = Math.max(10, Number(style.fontSize) || 58);
  return {
    enabled: true,
    softness: Math.max(0.01, Math.min(0.2, (blur / size) * 0.12)),
    offset: Math.max(0.01, Math.min(0.16, (distance / size) * 0.1)),
    opacity: Math.max(0.05, Math.min(1, Number(style.shadowOpacity ?? 0.8))),
    angle: ((Number(style.shadowAngle ?? 45) % 360) + 360) % 360,
  };
}

export function fusionGlow(style = {}) {
  const amount = Math.max(0, Number(style.glow) || 0);
  if (amount <= 0) return { enabled: false, softness: 0 };
  const size = Math.max(10, Number(style.fontSize) || 58);
  return {
    enabled: true,
    softness: Math.max(0.02, Math.min(0.35, (amount / size) * 0.18)),
  };
}

export function fusionBackground(style = {}) {
  const enabled = !!(style.backgroundEnabled || (style.background && style.background !== "none" && style.background !== "transparent" && style.backgroundEnabled !== false));
  if (!enabled) return { enabled: false, color: [0, 0, 0], opacity: 0, extendX: 0, extendY: 0, round: 0 };
  const color = hexToUnitRgb(style.background || "#000000");
  const opacity = Math.max(0.05, Math.min(1, Number(style.backgroundOpacity ?? 0.8)));
  const paddingX = Math.max(4, Number(style.backgroundWidth ?? style.padding ?? 14));
  const paddingY = Math.max(4, Number(style.backgroundHeight ?? style.padding ?? 14));
  const radius = Math.max(0, Number(style.radius ?? 12));
  const fontSize = Math.max(10, Number(style.fontSize) || 58);
  return {
    enabled: true,
    color,
    opacity,
    extendX: Math.max(0.12, Math.min(0.40, (paddingX / fontSize) * 0.45)),
    extendY: Math.max(0.06, Math.min(0.30, (paddingY / fontSize) * 0.30)),
    round: Math.max(0, Math.min(0.30, (radius / 65))),
  };
}

export function tokenizeWordsFallback(text, start = 0, end = 1) {
  const str = String(text || "").trim();
  if (!str) return [];
  const startSec = Math.max(0, Number(start) || 0);
  const endSec = Math.max(startSec + 0.1, Number(end) || (startSec + 1));
  const duration = endSec - startSec;
  const regex = /[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]|[\w'’]+|[^\s\w\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]+/gu;
  const tokens = [];
  let match;
  while ((match = regex.exec(str)) !== null) {
    if (match[0].trim()) tokens.push(match[0]);
  }
  if (!tokens.length) tokens.push(str);
  const totalChars = tokens.reduce((acc, t) => acc + t.length, 0);
  let cursor = startSec;
  return tokens.map((token) => {
    const tokenDuration = duration * (token.length / Math.max(1, totalChars));
    const tokenStart = cursor;
    const tokenEnd = cursor + tokenDuration;
    cursor = tokenEnd;
    return {
      word: token,
      start: tokenStart,
      end: tokenEnd,
    };
  });
}

export function buildPresetSettings(firstStyle = {}, canvas = {}, center = {}, stroke = 0, shadow = {}, background = {}) {
  const colorRgb = hexToUnitRgb(firstStyle.color);
  const strokeColorRgb = hexToUnitRgb(firstStyle.strokeColor || "#000000");
  const shadowColorRgb = hexToUnitRgb(firstStyle.shadowColor || "#000000");
  const highlightColor = firstStyle.highlightColor || firstStyle.highlight || "#FFD200";
  const highlightColorRgb = hexToUnitRgb(highlightColor);
  const highlightEnabled = firstStyle.highlightEnabled !== false ? 1 : 0;
  const anim = String(firstStyle.animation || "").toLowerCase();

  let highlightStyle = 0; // 0 = Fill
  if (anim === "outline-active" || anim === "underline") {
    highlightStyle = 1;
  } else if (anim === "glow" || anim === "neon-pulse" || anim === "word-gradient") {
    highlightStyle = 2;
  } else if (anim === "word-pill" || anim === "word-box" || anim === "word-ring" || anim === "bubble") {
    highlightStyle = 3;
  }

  const isPopIn = anim === "pop-in" || anim === "popin" || anim.startsWith("word-pop") || anim.startsWith("word-bounce") || anim === "zoom" || !!firstStyle.popIn ? 1 : 0;
  const isSlideUp = anim === "slide-up" || anim === "slideup" || anim.startsWith("word-lift") || anim.startsWith("word-rise") ? 1 : 0;
  const isFade = anim === "fade" || anim === "typewriter" ? 1 : 0;
  const isSequentialWordAnim = isPopIn || isSlideUp || isFade;
  const animationLevel = isSequentialWordAnim ? 1 : 0;

  return {
    Font: pickResolveFont(firstStyle.fontFamily, ""),
    Style: fusionFontStyle(firstStyle),
    TextSize: fusionTextSize(firstStyle.fontSize, canvas),
    TextPosition: [center.centerX, center.centerY],
    FillEnabled: 1,
    FillColorRed: colorRgb[0],
    FillColorGreen: colorRgb[1],
    FillColorBlue: colorRgb[2],
    OutlineEnabled: stroke > 0 ? 1 : 0,
    OutlineThickness: stroke,
    OutlineColorRed: strokeColorRgb[0],
    OutlineColorGreen: strokeColorRgb[1],
    OutlineColorBlue: strokeColorRgb[2],
    ShadowEnabled: shadow.enabled ? 1 : 0,
    ShadowColorRed: shadowColorRgb[0],
    ShadowColorGreen: shadowColorRgb[1],
    ShadowColorBlue: shadowColorRgb[2],
    BubbleEnabled: background.enabled ? 1 : 0,
    BubbleColorRed: background.color ? background.color[0] : 0,
    BubbleColorGreen: background.color ? background.color[1] : 0,
    BubbleColorBlue: background.color ? background.color[2] : 0,
    HighlightEnabled: highlightEnabled,
    HighlightStyle: highlightStyle,
    HighlightColorRed: highlightColorRgb[0],
    HighlightColorGreen: highlightColorRgb[1],
    HighlightColorBlue: highlightColorRgb[2],
    HighlightRound: background.round || 0.25,
    HighlightExtendHorizontal: background.extendX || 0.04,
    HighlightExtendVertical: background.extendY || 0.04,
    AnimationLength: 0,
    AnimationLevel: animationLevel,
    AnimationMode: 1,
    PopInEnabled: isPopIn,
    FadeEnabled: isFade,
    SlideUpEnabled: isSlideUp,
  };
}

export function buildResolveSendJob(input = {}) {
  const canvas = {
    width: Math.max(320, Number(input.width) || 1080),
    height: Math.max(320, Number(input.height) || 1920),
  };
  const fps = Number(input.fps) || 30;
  const transform = input.captionTransform || {};
  const captions = Array.isArray(input.captions) ? input.captions : [];
  const firstStyle = normalizeCaptionStyle(
    input.captionStyle || {},
    transform,
    canvas,
  );
  const sample = captions.map((caption) => caption?.text || "").join("");
  const center = fusionCenter(transform, canvas);
  const shadow = fusionShadow(firstStyle);
  const stroke = fusionStroke(firstStyle.stroke, firstStyle.fontSize);
  const fontName = pickResolveFont(firstStyle.fontFamily, sample);
  const fontStyle = fusionFontStyle(firstStyle);
  const textSize = fusionTextSize(firstStyle.fontSize, canvas);
  const colorRgb = hexToUnitRgb(firstStyle.color);
  const strokeColorRgb = hexToUnitRgb(firstStyle.strokeColor);
  const shadowColorRgb = hexToUnitRgb(firstStyle.shadowColor);
  const highlightColor = firstStyle.highlightColor || firstStyle.highlight || "#FFD200";
  const highlightColorRgb = hexToUnitRgb(highlightColor);
  const highlightEnabled = firstStyle.highlightEnabled !== false;

  const background = fusionBackground(firstStyle);
  const presetSettings = buildPresetSettings(
    { ...firstStyle, fontFamily: fontName, highlightColor, highlightEnabled },
    canvas,
    center,
    stroke,
    shadow,
    background,
  );

  const items = captions
    .map((caption) => {
      const styled = normalizeCaptionStyle(
        { ...(input.captionStyle || {}), ...(caption.style || {}) },
        {
          ...transform,
          scale: caption.scale ?? transform.scale,
          width: caption.width ?? transform.width,
          x: caption.x ?? transform.x,
          y: caption.y ?? transform.y,
        },
        canvas,
      );
      const lines = wrapCaptionText(caption.text, styled, styled.width, styled.boxWidth);
      if (!lines.length) return null;
      const start = Math.max(0, Number(caption.start || 0));
      const end = Math.max(start + 0.04, Number(caption.end || start));
      const text = lines.join("\n");

      let rawWords = [];
      if (Array.isArray(caption.words) && caption.words.length > 0) {
        rawWords = caption.words
          .map((w) => ({
            word: String(w.display || w.word || "").trim(),
            start: Math.max(start, Number(w.start || start)),
            end: Math.min(end, Math.max(Number(w.start || start) + 0.04, Number(w.end || end))),
          }))
          .filter((w) => w.word.length > 0);
      }
      if (!rawWords.length) {
        rawWords = tokenizeWordsFallback(text, start, end);
      }

      const textChars = [...text];
      let cursor = 0;
      const words = rawWords.map((w) => {
        const token = w.word;
        const tokenChars = [...token];
        let matchStart = -1;
        for (let i = cursor; i <= textChars.length - tokenChars.length; i++) {
          let matches = true;
          for (let j = 0; j < tokenChars.length; j++) {
            if (textChars[i + j] !== tokenChars[j]) {
              matches = false;
              break;
            }
          }
          if (matches) {
            matchStart = i;
            break;
          }
        }
        if (matchStart < 0) {
          const cleanToken = token.replace(/^[^\w\u4e00-\u9fa5]+|[^\w\u4e00-\u9fa5]+$/g, "");
          if (cleanToken.length > 0) {
            const cleanChars = [...cleanToken];
            for (let i = cursor; i <= textChars.length - cleanChars.length; i++) {
              let matches = true;
              for (let j = 0; j < cleanChars.length; j++) {
                if (textChars[i + j].toLowerCase() !== cleanChars[j].toLowerCase()) {
                  matches = false;
                  break;
                }
              }
              if (matches) {
                matchStart = i;
                break;
              }
            }
          }
        }

        let startIdx = 0;
        let endIdx = 0;
        if (matchStart >= 0) {
          startIdx = matchStart;
          endIdx = matchStart + tokenChars.length - 1;
          cursor = matchStart + tokenChars.length;
        } else {
          startIdx = cursor;
          endIdx = startIdx + tokenChars.length - 1;
          cursor = endIdx + 1;
        }
        return {
          word: token,
          startIndex: startIdx,
          endIndex: endIdx,
          start: w.start,
          end: w.end,
        };
      });

      return {
        text,
        start,
        end,
        words,
      };
    })
    .filter(Boolean);

  if (!items.length) throw new Error("没有可以发送的字幕。");

  const captionBinPath = bundledCaptionBinPath();

  return {
    id: String(input.id || `qc-${Date.now()}`),
    app: "快剪",
    fps,
    replace: input.replace !== false,
    templateName: "AutoSubs Caption",
    captionBinPath: fs.existsSync(captionBinPath) ? captionBinPath : "",
    presetSettings,
    style: {
      fontFamily: fontName,
      fontStyle,
      size: textSize,
      color: colorRgb,
      strokeEnabled: stroke > 0,
      strokeColor: strokeColorRgb,
      stroke,
      shadowEnabled: shadow.enabled,
      shadowColor: shadowColorRgb,
      backgroundEnabled: background.enabled,
      backgroundColor: background.color,
      backgroundOpacity: background.opacity,
      backgroundExtendX: background.extendX,
      backgroundExtendY: background.extendY,
      backgroundRound: background.round,
      centerX: center.centerX,
      centerY: center.centerY,
      align: firstStyle.textAlign === "left" ? 0 : firstStyle.textAlign === "right" ? 2 : 1,
      highlightColor: highlightColorRgb,
      highlightEnabled,
      highlightStyle: presetSettings.HighlightStyle,
    },
    items,
  };
}

export function installResolveLink(options = {}) {
  const source = bundledResolveScriptPath();
  if (!fs.existsSync(source)) throw new Error("找不到达芬奇接收脚本。");
  const body = fs.readFileSync(source);
  const binSource = bundledCaptionBinPath();
  const binBody = fs.existsSync(binSource) ? fs.readFileSync(binSource) : null;
  const installed = [];
  let changed = false;
  const directories = options.directories || resolveScriptDirectories();
  for (const directory of directories) {
    fs.mkdirSync(directory, { recursive: true });
    const destination = path.join(directory, RESOLVE_SCRIPT_NAME);
    const previous = fs.existsSync(destination) ? fs.readFileSync(destination) : null;
    fs.writeFileSync(destination, body);
    if (!previous || Buffer.compare(previous, body) !== 0) changed = true;
    if (binBody) {
      const binDestination = path.join(directory, RESOLVE_CAPTION_BIN);
      const prevBin = fs.existsSync(binDestination) ? fs.readFileSync(binDestination) : null;
      if (!prevBin || Buffer.compare(prevBin, binBody) !== 0) {
        fs.writeFileSync(binDestination, binBody);
        changed = true;
      }
    }
    installed.push(destination);
  }
  const root = ensureResolveLinkDirs();
  if (binBody) {
    const linkBin = path.join(root, RESOLVE_CAPTION_BIN);
    const prevLinkBin = fs.existsSync(linkBin) ? fs.readFileSync(linkBin) : null;
    if (!prevLinkBin || Buffer.compare(prevLinkBin, binBody) !== 0) {
      fs.writeFileSync(linkBin, binBody);
      changed = true;
    }
  }
  if (changed) {
    try {
      fs.writeFileSync(path.join(root, "stop"), "1\n");
    } catch {
      /* old watcher will exit on the next poll if this file appears */
    }
  }
  return {
    installed: installed[0] || "",
    copies: installed,
  };
}

export function writeResolveProgress(fields = {}) {
  const root = ensureResolveLinkDirs();
  const payload = {
    listening: false,
    phase: fields.phase || "waiting",
    message: fields.message || "",
    done: Number(fields.done || 0),
    total: Number(fields.total || 0),
    percent: Number(fields.percent || 0),
    jobId: String(fields.jobId || ""),
    error: String(fields.error || ""),
    updated: Math.floor(Date.now() / 1000),
  };
  if (payload.total > 0) {
    payload.percent = Math.max(
      0,
      Math.min(100, Math.round((payload.done / payload.total) * 100)),
    );
  } else if (payload.phase === "done") {
    payload.percent = 100;
  }
  fs.writeFileSync(path.join(root, "progress.json"), `${JSON.stringify(payload)}\n`);
  return payload;
}

export function resolveSendProgress(options = {}) {
  const status = resolveLinkStatus(options);
  const progressPath = path.join(resolveLinkRoot(), "progress.json");
  let progress = {};
  if (fs.existsSync(progressPath)) {
    try {
      progress = JSON.parse(fs.readFileSync(progressPath, "utf8"));
    } catch {
      progress = {};
    }
  }
  const total = Number(progress.total || 0);
  const done = Number(progress.done || 0);
  let percent = Number(progress.percent || 0);
  if (total > 0) percent = Math.max(percent, Math.round((done / total) * 100));
  if (progress.phase === "done") percent = Math.max(percent, 100);
  let phase = progress.phase || (status.listening ? "idle" : "offline");
  let message = progress.message || "";
  if (!message) {
    if (!status.listening) message = "达芬奇还没开始接收。请点「工作区 → 脚本 → 快剪」";
    else if (phase === "idle") message = "达芬奇已连接，等待发送";
    else message = "正在发送到达芬奇…";
  }
  const logPath = path.join(resolveLinkRoot(), "script.log");
  let logTail = "";
  if (fs.existsSync(logPath)) {
    const raw = fs.readFileSync(logPath, "utf8");
    logTail = raw.split(/\r?\n/).filter(Boolean).slice(-12).join("\n");
  }
  return {
    ...status,
    phase,
    message,
    done,
    total,
    percent: Math.max(0, Math.min(100, percent)),
    jobId: String(progress.jobId || ""),
    error: String(progress.error || ""),
    logPath,
    logTail,
  };
}

export function revealResolveLog() {
  const logPath = path.join(resolveLinkRoot(), "script.log");
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, "", "utf8");
  }
  return logPath;
}

export function resolveLinkStatus(options = {}) {
  const source = bundledResolveScriptPath();
  const copies = (options.directories || resolveScriptDirectories()).map((directory) =>
    path.join(directory, RESOLVE_SCRIPT_NAME),
  );
  const installedPath = copies.find((file) => fs.existsSync(file)) || "";
  const root = resolveLinkRoot();
  const listenerPath = path.join(root, "listener.json");
  let listening = false;
  let updated = 0;
  if (fs.existsSync(listenerPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(listenerPath, "utf8"));
      updated = Number(data.updated || 0) * 1000;
      listening = Date.now() - updated <= LISTENER_STALE_MS;
    } catch {
      listening = false;
    }
  }
  return {
    scriptReady: fs.existsSync(source),
    installed: Boolean(installedPath),
    installedPath,
    listening,
    linkRoot: root,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendToResolve(input = {}, options = {}) {
  const installed = options.skipInstall
    ? { installed: "" }
    : installResolveLink({ directories: options.directories });
  const root = ensureResolveLinkDirs();
  const job = buildResolveSendJob(input);
  const jobPath = path.join(root, "job.json");
  const resultPath = path.join(root, "result.json");
  const workingPath = path.join(root, "job.working.json");
  try {
    if (fs.existsSync(resultPath)) fs.unlinkSync(resultPath);
  } catch {
    /* old result can stay if locked */
  }
  try {
    if (fs.existsSync(workingPath)) fs.unlinkSync(workingPath);
  } catch {
    /* old working job can stay if locked */
  }
  writeResolveProgress({
    phase: "waiting",
    message: "任务已写好，等待达芬奇接收",
    done: 0,
    total: job.items.length,
    jobId: job.id,
  });
  fs.writeFileSync(jobPath, `${JSON.stringify(job)}\n`, "utf8");

  const timeoutMs = Math.max(
    5000,
    Number(options.timeoutMs) || Math.min(600000, Math.max(180000, job.items.length * 450)),
  );
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(resultPath)) {
      const raw = fs.readFileSync(resultPath, "utf8");
      let result;
      try {
        result = JSON.parse(raw);
      } catch {
        result = null;
      }
      if (result && String(result.id || "") === job.id) {
        if (result.ok === false) {
          throw new Error(result.error || "达芬奇写入失败");
        }
        return {
          ...result,
          id: job.id,
          count: Number(result.count || job.items.length),
          installedPath: installed.installed,
          listening: resolveLinkStatus().listening,
        };
      }
    }
    await sleep(Number(options.pollMs) || 250);
  }

  const status = resolveLinkStatus();
  if (!status.listening) {
    throw new Error(
      "达芬奇还没开始接收。请打开达芬奇工程和时间线，点「工作区 → 脚本 → 快剪」，然后再点一次发送。",
    );
  }
  throw new Error("达芬奇接收超时。请确认当前时间线已打开，然后重试。");
}
