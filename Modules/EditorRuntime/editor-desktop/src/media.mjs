import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  analyzePauseFrames,
  mergeRanges,
  samplesToFrames,
  waveformPeaks,
} from "./pausecut.mjs";
import { captionLayoutMetrics, estimatedWordWidth, normalizedFontWeight, wordGap } from "./text-layout.mjs";
import {
  defaultSupportRoot,
  fallbackFontFiles,
  fontSearchRoots,
  isDarwin,
  isWindows,
  mediaSearchRoots,
  pathHasBinary,
  whichBinary,
} from "./platform.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const jobs = new Map();
let encoderCatalog = null;

export function supportRoot() {
  const overridden = process.env.QUICKCUT_SUPPORT_ROOT;
  const root = overridden || defaultSupportRoot();
  const legacy = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "SubtitleProofreaderEditor",
  );
  if (!overridden && !fs.existsSync(root) && fs.existsSync(legacy)) {
    try {
      fs.cpSync(legacy, root, { recursive: true });
    } catch {
      /* legacy data remains untouched */
    }
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function usableBinary(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return "";
  if (isWindows) return filePath;
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return filePath;
  } catch {
    try {
      fs.chmodSync(filePath, 0o755);
      fs.accessSync(filePath, fs.constants.X_OK);
      return filePath;
    } catch {
      return "";
    }
  }
}

export function mediaBinary(name) {
  const overriddenRoot = process.env.QUICKCUT_MEDIA_ROOT;
  const overridden = pathHasBinary(overriddenRoot, name);
  if (overridden) return overridden;
  const bundledDir = path.resolve(moduleDir, "../../../media");
  const bundled = usableBinary(pathHasBinary(bundledDir, name));
  if (bundled) return bundled;
  const fromPath = whichBinary(name);
  if (fromPath) return fromPath;
  for (const directory of mediaSearchRoots()) {
    const found = pathHasBinary(directory, name);
    if (found) return found;
  }
  throw new Error(
    isWindows
      ? `缺少视频处理组件：${name}。请安装 FFmpeg 并加入 PATH，或把它放到媒体目录。`
      : `缺少视频处理组件：${name}`,
  );
}

function availableEncoders() {
  if (encoderCatalog) return encoderCatalog;
  encoderCatalog = new Set();
  try {
    const result = spawnSync(mediaBinary("ffmpeg"), ["-hide_banner", "-encoders"], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });
    const text = `${result.stdout || ""}\n${result.stderr || ""}`;
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*[A-Z.]+\s+([a-z0-9_]+)\s+/i);
      if (match) encoderCatalog.add(match[1]);
    }
  } catch {
    encoderCatalog = new Set();
  }
  return encoderCatalog;
}

function preferredVideoEncoder(useHevc) {
  if (isDarwin) return useHevc ? "hevc_videotoolbox" : "h264_videotoolbox";
  const encoders = availableEncoders();
  const order = useHevc
    ? ["hevc_nvenc", "hevc_amf", "hevc_qsv", "libx265", "hevc_mf"]
    : ["h264_nvenc", "h264_amf", "h264_qsv", "libx264", "h264_mf"];
  return order.find((name) => encoders.has(name)) || order.at(-2) || "libx264";
}

function run(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { lowPriority = false, ...spawnOptions } = options;
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...spawnOptions,
    });
    if (lowPriority && child.pid)
      try {
        os.setPriority(child.pid, 12);
      } catch {}
    const stdout = [];
    let stderr = "";
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-12000);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(stdout))
        : reject(new Error(stderr.trim() || `媒体处理失败（${code}）`)),
    );
  });
}

const probeArguments = (inputPath) => [
  "-v",
  "error",
  // The bundled ffprobe is intentionally compatible with older macOS
  // releases.  `-show_streams/-show_format` exposes rotation side data on
  // both old and new ffprobe builds; the narrower `stream_side_data` section
  // selector is rejected by some versions before export can even start.
  "-show_streams",
  "-show_format",
  "-of",
  "json",
  inputPath,
];

function parsedMediaInfo(inputPath, data) {
  const video =
    data.streams?.find((stream) => stream.codec_type === "video") || {};
  const audio =
    data.streams?.find((stream) => stream.codec_type === "audio") || {};
  const frameRateParts = String(video.r_frame_rate || "0/1")
    .split("/")
    .map(Number);
  const frameRate =
    frameRateParts.length === 2 && frameRateParts[1]
      ? frameRateParts[0] / frameRateParts[1]
      : Number(frameRateParts[0] || 0);
  const rawRotation = Number(
      video.side_data_list?.find((item) => Number.isFinite(Number(item.rotation)))?.rotation ??
      video.tags?.rotate ?? 0,
    ),
    rotation = Number.isFinite(rawRotation) ? rawRotation : 0,
    quarterTurn = Math.abs(Math.round(rotation / 90)) % 2 === 1,
    encodedWidth = Number(video.width || 0),
    encodedHeight = Number(video.height || 0);
  return {
    path: inputPath,
    name: path.basename(inputPath),
    duration: Number(data.format?.duration || 0),
    size: Number(data.format?.size || fs.statSync(inputPath).size),
    width: encodedWidth,
    height: encodedHeight,
    displayWidth: quarterTurn ? encodedHeight : encodedWidth,
    displayHeight: quarterTurn ? encodedWidth : encodedHeight,
    rotation,
    videoCodec: video.codec_name || "",
    audioCodec: audio.codec_name || "",
    sampleRate: Number(audio.sample_rate || 0),
    channels: Number(audio.channels || 0),
    frameRate: Number.isFinite(frameRate) ? frameRate : 0,
  };
}

export function probeMedia(inputPath) {
  if (!fs.existsSync(inputPath)) throw new Error("素材文件已经不存在。");
  const result = spawnSync(mediaBinary("ffprobe"), probeArguments(inputPath), {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(result.stderr || "无法读取素材信息。");
  return parsedMediaInfo(inputPath, JSON.parse(result.stdout));
}

export async function probeMediaAsync(inputPath) {
  if (!fs.existsSync(inputPath)) throw new Error("素材文件已经不存在。");
  const result = await run(mediaBinary("ffprobe"), probeArguments(inputPath));
  return parsedMediaInfo(inputPath, JSON.parse(result.toString("utf8")));
}

function mediaPreviewPath(inputPath, kind = "video") {
  if (
    !inputPath ||
    !fs.existsSync(inputPath) ||
    !["video", "audio"].includes(kind)
  )
    return "";
  const stat = fs.statSync(inputPath);
  const key = crypto
    .createHash("sha256")
    .update(`${inputPath}:${stat.size}:${stat.mtimeMs}:${kind}`)
    .digest("hex")
    .slice(0, 20);
  const directory = path.join(supportRoot(), "previews", "media");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return path.join(directory, `${key}.png`);
}

export function cachedMediaPreview(inputPath, kind = "video") {
  const outputPath = mediaPreviewPath(inputPath, kind);
  return outputPath &&
    fs.existsSync(outputPath) &&
    fs.statSync(outputPath).size > 100
    ? outputPath
    : null;
}

export function createMediaPreview(inputPath, kind = "video") {
  const outputPath = mediaPreviewPath(inputPath, kind);
  if (!outputPath) return null;
  const cached = cachedMediaPreview(inputPath, kind);
  if (cached) return cached;
  const audioArgs = [
          "-y",
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          inputPath,
          "-filter_complex",
          "aformat=channel_layouts=mono,showwavespic=s=240x135:colors=0x4fc9a0:scale=sqrt,format=rgba",
          "-frames:v",
          "1",
          outputPath,
        ];
  const videoArgs = (seek) => [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    String(seek),
    "-i",
    inputPath,
    "-map",
    "0:v:0",
    "-an",
    "-frames:v",
    "1",
    "-vf",
    "scale=240:135:force_original_aspect_ratio=decrease,pad=240:135:(ow-iw)/2:(oh-ih)/2:color=0x111315",
    outputPath,
  ];
  const attempts = kind === "video" ? [videoArgs(0.2), videoArgs(0)] : [audioArgs];
  let created = false;
  for (const args of attempts) {
    try {
      fs.unlinkSync(outputPath);
    } catch {}
    const result = spawnSync(mediaBinary("ffmpeg"), args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    if (
      result.status === 0 &&
      fs.existsSync(outputPath) &&
      fs.statSync(outputPath).size > 100
    ) {
      created = true;
      break;
    }
  }
  if (!created) return null;
  return outputPath;
}

export async function createMediaPreviewAsync(inputPath, kind = "video") {
  const outputPath = mediaPreviewPath(inputPath, kind);
  if (!outputPath) return null;
  const cached = cachedMediaPreview(inputPath, kind);
  if (cached) return cached;
  const audioArgs = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inputPath,
    "-filter_complex",
    "aformat=channel_layouts=mono,showwavespic=s=240x135:colors=0x4fc9a0:scale=sqrt,format=rgba",
    "-frames:v",
    "1",
    outputPath,
  ];
  const videoArgs = (seek) => [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    String(seek),
    "-i",
    inputPath,
    "-map",
    "0:v:0",
    "-an",
    "-frames:v",
    "1",
    "-vf",
    "scale=240:135:force_original_aspect_ratio=decrease,pad=240:135:(ow-iw)/2:(oh-ih)/2:color=0x111315",
    outputPath,
  ];
  const attempts =
    kind === "video" ? [videoArgs(0.2), videoArgs(0)] : [audioArgs];
  for (const args of attempts) {
    await fs.promises.unlink(outputPath).catch(() => {});
    try {
      await run(mediaBinary("ffmpeg"), args);
      const stat = await fs.promises.stat(outputPath).catch(() => null);
      if (stat?.size > 100) return outputPath;
    } catch {
      /* Try the next seek position before giving up. */
    }
  }
  return null;
}

export async function extractStillFrame(inputPath, time = 0, destination = "") {
  if (!inputPath || !fs.existsSync(inputPath))
    throw new Error("视频文件已经不存在。");
  const directory = destination
    ? path.dirname(destination)
    : path.join(supportRoot(), "stills");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const outputPath =
    destination || path.join(directory, `still-${crypto.randomUUID()}.png`);
  await run(mediaBinary("ffmpeg"), [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    String(Math.max(0, Number(time || 0))),
    "-i",
    inputPath,
    "-frames:v",
    "1",
    outputPath,
  ]);
  return outputPath;
}

export async function createProjectCover(input = {}) {
  const inputPath = input.inputPath;
  const destination = input.destination;
  if (!inputPath || !fs.existsSync(inputPath))
    throw new Error("找不到用于工程封面的主视频。");
  if (!destination) throw new Error("工程封面保存位置无效。");
  const canvasWidth = 216;
  const canvasHeight = 384;
  const projectWidth = Math.max(1, Number(input.projectWidth || 1080));
  const projectHeight = Math.max(1, Number(input.projectHeight || 1920));
  const transform = input.videoTransform || {};
  const scale = Math.max(0.05, Math.min(8, Number(transform.scale || 1)));
  const rotation = Number(transform.rotation || 0);
  const offsetX = Number(transform.x || 0) * canvasWidth / projectWidth;
  const offsetY = Number(transform.y || 0) * canvasHeight / projectHeight;
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${crypto.randomUUID()}.tmp.png`;
  const filter =
    `[0:v]scale=${canvasWidth}:${canvasHeight}:force_original_aspect_ratio=decrease,` +
    `scale=iw*${scale.toFixed(5)}:ih*${scale.toFixed(5)},` +
    `rotate=${rotation.toFixed(4)}*PI/180:c=none:ow=rotw(iw):oh=roth(ih)[covervideo];` +
    `[1:v][covervideo]overlay=x='(W-w)/2+${offsetX.toFixed(3)}':` +
    `y='(H-h)/2+${offsetY.toFixed(3)}':shortest=1,format=rgb24[cover]`;
  try {
    await run(mediaBinary("ffmpeg"), [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(Math.max(0, Number(input.time || 0))),
      "-i",
      inputPath,
      "-f",
      "lavfi",
      "-i",
      `color=c=0x0e0f10:s=${canvasWidth}x${canvasHeight}:d=1`,
      "-filter_complex",
      filter,
      "-map",
      "[cover]",
      "-frames:v",
      "1",
      temporary,
    ]);
    await fs.promises.rename(temporary, destination);
    return destination;
  } finally {
    await fs.promises.unlink(temporary).catch(() => {});
  }
}

export async function extractAudioSamples(
  inputPath,
  sampleRate = 8000,
  lowPriority = false,
) {
  const bytes = await run(mediaBinary("ffmpeg"), [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(sampleRate),
    "-f",
    "f32le",
    "pipe:1",
  ], { lowPriority });
  return new Float32Array(
    bytes.buffer,
    bytes.byteOffset,
    Math.floor(bytes.byteLength / 4),
  );
}

export async function analyzeWaveform(inputPath, points = 1800) {
  const samples = await extractAudioSamples(inputPath, 6000, true);
  return waveformPeaks(
    samples,
    Math.max(320, Math.min(24000, Number(points) || 1800)),
  );
}

export async function analyzePauses(inputPath, options = {}) {
  const info = probeMedia(inputPath);
  const samples = await extractAudioSamples(inputPath, 8000);
  const frames = samplesToFrames(samples, 8000, 20);
  const analysis = analyzePauseFrames(frames, options);
  return {
    ...analysis,
    duration: info.duration,
    outputDuration: Math.max(
      0,
      info.duration -
        analysis.removals.reduce((sum, range) => sum + range.duration, 0),
    ),
    waveform: waveformPeaks(
      samples,
      Math.max(1200, Math.min(24000, Math.round(info.duration * 60))),
    ),
  };
}

function audioDenoiseFilter(mode, strength = 0.7) {
  const amount = Math.max(0, Math.min(1, Number(strength)));
  if (!mode || mode === "off" || amount <= 0.01) return "";
  const reduction = Math.round(8 + amount * 18);
  const model = [
    path.resolve(moduleDir, "../assets/models/std.rnnn"),
    path.resolve(moduleDir, "../../assets/models/std.rnnn"),
    path.resolve(moduleDir, "../../../models/std.rnnn"),
  ].find((candidate) => fs.existsSync(candidate));
  const neural = model
    ? `aresample=48000,arnndn=m='${model.replace(/\\/g, "/").replace(/'/g, "\\'")}':mix=${(0.35 + amount * 0.65).toFixed(3)}`
    : "";
  if (mode === "quality")
    return [
      "highpass=f=60",
      "lowpass=f=16500",
      neural,
      `afftdn=nr=${Math.max(8, Math.round(reduction * 0.72))}:nf=-38:tn=1`,
      `anlmdn=s=${(0.0005 + amount * 0.0014).toFixed(4)}:p=0.002:r=0.006`,
      "alimiter=limit=0.96",
    ]
      .filter(Boolean)
      .join(",");
  if (mode === "strong")
    return [
      "highpass=f=65",
      "lowpass=f=15800",
      neural,
      `afftdn=nr=${Math.max(7, Math.round(reduction * 0.62))}:nf=-38:tn=1`,
      "agate=threshold=0.006:ratio=1.6:attack=8:release=180",
      "alimiter=limit=0.96",
    ]
      .filter(Boolean)
      .join(",");
  return `highpass=f=60,lowpass=f=16000,afftdn=nr=${Math.max(6, Math.round(reduction * 0.7))}:nf=-38:tn=1`;
}

function audioMasterFilter(config, info) {
  const audio = config.audio || {};
  const filters = [];
  if (
    !config.audioProcessingEnabled &&
    Number(config.denoise?.strength || 0) <= 0.01
  ) return "";
  const offset = Math.max(
    -Number(config.outputDuration || info.duration),
    Math.min(
      Number(config.outputDuration || info.duration),
      Number(audio.offset || 0),
    ),
  );
  if (offset > 0.001) filters.push(`adelay=${Math.round(offset * 1000)}:all=1`);
  else if (offset < -0.001)
    filters.push(`atrim=start=${(-offset).toFixed(4)},asetpts=PTS-STARTPTS`);
  const mode = String(audio.channelMode || "original");
  if (Number(info.channels || 0) === 1 || mode === "left")
    filters.push("pan=stereo|c0=c0|c1=c0");
  else if (mode === "right") filters.push("pan=stereo|c0=c1|c1=c1");
  else if (mode === "mix")
    filters.push("pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1");
  const lowCut = Math.max(20, Math.min(300, Number(audio.lowCut || 60)));
  const highCut = Math.max(
    4000,
    Math.min(20000, Number(audio.highCut || 16500)),
  );
  filters.push(`highpass=f=${Math.round(lowCut)}`);
  filters.push(`lowpass=f=${Math.round(highCut)}`);
  const denoise = audioDenoiseFilter(
    config.denoise?.mode,
    config.denoise?.strength,
  );
  if (denoise) filters.push(denoise);
  const volume = Math.max(0, Math.min(4, Number(audio.volume ?? 1)));
  if (Math.abs(volume - 1) > 0.001) filters.push(`volume=${volume.toFixed(3)}`);
  const bass = Math.max(-12, Math.min(12, Number(audio.bass || 0)));
  const treble = Math.max(-12, Math.min(12, Number(audio.treble || 0)));
  if (Math.abs(bass) > 0.01)
    filters.push(`bass=g=${bass.toFixed(2)}:f=110:w=0.6`);
  if (Math.abs(treble) > 0.01)
    filters.push(`treble=g=${treble.toFixed(2)}:f=6500:w=0.5`);
  const presence = Math.max(0, Math.min(100, Number(audio.presence || 0)));
  if (presence > 0.1)
    filters.push(
      `equalizer=f=3200:t=q:w=1.1:g=${(presence * 0.12).toFixed(2)}`,
    );
  const deesser = Math.max(0, Math.min(100, Number(audio.deesser || 0)));
  if (deesser > 0.1)
    filters.push(
      `deesser=i=${(deesser / 100).toFixed(3)}:m=${(0.45 + deesser / 190).toFixed(3)}:f=0.55`,
    );
  const voiceEnhance = Math.max(
    0,
    Math.min(100, Number(audio.voiceEnhance || 0)),
  );
  if (voiceEnhance > 0.1) {
    filters.push(
      `equalizer=f=180:t=q:w=0.8:g=${(voiceEnhance * 0.045).toFixed(2)}`,
    );
    filters.push(
      `crystalizer=i=${(voiceEnhance * 0.055).toFixed(2)}:c=0`,
    );
  }
  const compressor = Math.max(0, Math.min(1, Number(audio.compressor || 0)));
  if (compressor > 0.01)
    filters.push(
      `acompressor=threshold=${(0.32 - compressor * 0.2).toFixed(3)}:ratio=${(1.5 + compressor * 5.5).toFixed(2)}:attack=12:release=160:makeup=${(1 + compressor * 1.2).toFixed(2)}`,
    );
  const pan = Math.max(-1, Math.min(1, Number(audio.pan || 0)));
  if (Math.abs(pan) > 0.01)
    filters.push(`stereotools=balance_out=${pan.toFixed(3)}`);
  const speed = Math.max(0.5, Math.min(2, Number(audio.speed || 1)));
  if (Math.abs(speed - 1) > 0.001) filters.push(`atempo=${speed.toFixed(4)}`);
  if (audio.normalize)
    filters.push("dynaudnorm=f=250:g=15:p=0.93:m=8:r=0.12:c=1");
  if (audio.limiter !== false)
    filters.push("alimiter=limit=0.96:attack=5:release=80");
  return filters.join(",");
}

function resolveFontFile(style = {}) {
  const candidates = [style.fontFile, ...fallbackFontFiles()];
  const direct = candidates.find(
    (candidate) => candidate && fs.existsSync(candidate),
  );
  if (direct) return direct;
  if (!isWindows) {
    const matched = spawnSync("fc-match", ["-f", "%{file}", "sans-serif"], {
      encoding: "utf8",
    });
    const file = String(matched.stdout || "").trim();
    if (matched.status === 0 && file && fs.existsSync(file)) return file;
  }
  return "";
}

function escapeDrawtext(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "’")
    .replace(/%/g, "\\%")
    .replace(/\n/g, " ");
}

function escapeFilterPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function animationMotion(id = "") {
  const value = String(id || "").toLowerCase();
  if (value.includes("orbit") || value.includes("ring")) return "rotate";
  if (value.includes("comet") || value.includes("flare")) return "right";
  if (value.includes("dust")) return "up";
  if (value.includes("halo") || value.includes("rays") || value.includes("burst")) return "zoom";
  if (value.includes("left")) return "left";
  if (value.includes("right")) return "right";
  if (value.includes("up") || value === "rise" || value.includes("word-rise"))
    return "up";
  if (value.includes("down") || value === "drop") return "down";
  if (value.includes("rotate") || value.includes("roll") || value === "tilt")
    return "rotate";
  if (value.includes("zoom") || value.includes("scale") || value.includes("pop"))
    return "zoom";
  if (value.includes("wipe") || value.includes("reveal") || value === "typewriter")
    return "wipe";
  return value ? "fade" : "";
}

function animationIntensity(item, mode) {
  const id = item?.[`${mode}Animation`];
  if (!id) return "0";
  const start = Math.max(0, Number(item.start || 0));
  const end = Math.max(start + 0.04, Number(item.end || start + 0.04));
  const duration = Math.min(
    end - start,
    Math.max(0.15, Number(item[`${mode}Duration`] || 0.45)),
  );
  return mode === "enter"
    ? `if(between(t,${start.toFixed(4)},${(start + duration).toFixed(4)}),1-(t-${start.toFixed(4)})/${duration.toFixed(4)},0)`
    : `if(between(t,${(end - duration).toFixed(4)},${end.toFixed(4)}),(t-${(end - duration).toFixed(4)})/${duration.toFixed(4)},0)`;
}

function animatedPosition(item, axis, base, distance = 180) {
  const entries = ["enter", "exit"].map((mode) => ({
    motion: animationMotion(item?.[`${mode}Animation`]),
    factor: animationIntensity(item, mode),
  }));
  const additions = [];
  for (const entry of entries) {
    let amount = 0;
    if (axis === "x" && entry.motion === "left") amount = -distance;
    if (axis === "x" && entry.motion === "right") amount = distance;
    if (axis === "y" && entry.motion === "up") amount = distance * 0.62;
    if (axis === "y" && entry.motion === "down") amount = -distance * 0.62;
    if (entry.motion === "rotate") amount = axis === "x" ? -distance * 0.18 : distance * 0.1;
    if (amount) additions.push(`(${amount.toFixed(2)})*(${entry.factor})`);
  }
  return additions.length ? `${base}+${additions.join("+")}` : base;
}

function animatedAlpha(item, baseOpacity = 1) {
  const enter = animationIntensity(item, "enter"),
    exit = animationIntensity(item, "exit");
  if (enter === "0" && exit === "0")
    return Math.max(0, Math.min(1, Number(baseOpacity ?? 1))).toFixed(3);
  return `${Math.max(0, Math.min(1, Number(baseOpacity ?? 1))).toFixed(3)}*(1-max(${enter},${exit}))`;
}

function spacedText(value, wordSpacing = 0) {
  const count = Math.max(1, Math.min(8, 1 + Math.round(Number(wordSpacing || 0) / 6)));
  return String(value || "").replace(/ /g, " ".repeat(count));
}

function casedText(value, mode = "none") {
  const text = String(value || "");
  if (mode === "upper") return text.toUpperCase();
  if (mode === "lower") return text.toLowerCase();
  if (mode === "title")
    return text.replace(/\b([\p{L}])/gu, (letter) => letter.toUpperCase());
  return text;
}

function assColor(value, alpha = 0) {
  const hex = String(value || "#ffffff")
    .replace("#", "")
    .padEnd(6, "f")
    .slice(0, 6);
  const [red, green, blue] = [
    hex.slice(0, 2),
    hex.slice(2, 4),
    hex.slice(4, 6),
  ];
  return `&H${Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, "0")}${blue}${green}${red}`.toUpperCase();
}

function assOverrideColor(value) {
  const full = assColor(value, 0);
  return `&H${full.slice(-6)}&`;
}

function assAlpha(opacity = 1) {
  const alpha = Math.round((1 - Math.max(0, Math.min(1, Number(opacity)))) * 255);
  return `&H${alpha.toString(16).padStart(2, "0").toUpperCase()}&`;
}

function assTime(seconds) {
  const value = Math.max(0, Number(seconds || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remaining = value % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${remaining.toFixed(2).padStart(5, "0")}`;
}

function escapeAssText(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/[{}]/g, "")
    .replace(/\r?\n/g, " ");
}

function assAnimationTags(animation, x, y, durationMs, style = {}) {
  const end = Math.max(120, Math.min(durationMs, 520));
  const tags = {
    fade: "\\fad(180,90)",
    rise: `\\move(${x},${y + 90},${x},${y},0,${end})\\fad(100,70)`,
    "slide-left": `\\move(${x - 240},${y},${x},${y},0,${end})\\fad(80,70)`,
    "slide-right": `\\move(${x + 240},${y},${x},${y},0,${end})\\fad(80,70)`,
    zoom: `\\pos(${x},${y})\\fscx55\\fscy55\\t(0,${end},\\fscx100\\fscy100)`,
    flip: `\\pos(${x},${y})\\frx75\\t(0,${end},\\frx0)`,
    shake: `\\move(${x - 9},${y},${x + 9},${y},0,100)\\t(100,220,\\frz-2)\\t(220,360,\\frz2)\\t(360,480,\\frz0)`,
    glow: `\\pos(${x},${y})\\blur7\\t(0,${end},\\blur0)\\t(${end},${Math.min(durationMs, end + 350)},\\blur4)`,
    stretch: `\\pos(${x},${y})\\fscx25\\fsp-4\\t(0,${end},\\fscx100\\fsp0)`,
    drop: `\\move(${x},${y - 180},${x},${y},0,${end})`,
    swing: `\\pos(${x},${y})\\frz12\\t(0,${Math.round(end * 0.65)},\\frz-3)\\t(${Math.round(end * 0.65)},${end},\\frz0)`,
    "neon-pulse": `\\pos(${x},${y})\\blur5\\t(0,220,\\blur0)\\t(220,440,\\blur5)\\t(440,620,\\blur0)`,
    blink: `\\pos(${x},${y})\\alpha&HAA&\\t(0,90,\\alpha&H00&)\\t(90,180,\\alpha&HAA&)\\t(180,270,\\alpha&H00&)`,
    typewriter: `\\pos(${x},${y})\\fad(80,40)`,
    // Alisha：方向可选，四个方向共享同一套渐显滑入。
    "alisha-reveal": (() => {
      const d = String(style.animationDirection || "leftToRight");
      const fromX = d === "leftToRight" ? x - 180 : d === "rightToLeft" ? x + 180 : x;
      const fromY = d === "bottomToTop" ? y + 140 : d === "topToBottom" ? y - 140 : y;
      return `\\move(${fromX},${fromY},${x},${y},0,${Math.min(end, 360)})\\alpha&HFF&\\t(0,${Math.min(end, 320)},\\alpha&H00&)\\fad(0,80)`;
    })(),
    // 参考用户提供的 Donald 样例：粗体双行短语快速切换，几乎无位移，保留极短入场避免硬闪。
    "donald-cut": `\\pos(${x},${y})\\fad(35,25)`,
  };
  return tags[animation] || `\\pos(${x},${y})`;
}

function stableWordAssEvents(caption, style, x, y, animation) {
  const words = Array.isArray(caption.words) && caption.words.length
    ? caption.words
    : String(caption.text || "").split(/\s+/).filter(Boolean).map((display, index, list) => ({
        display,
        start: Number(caption.start) + (Number(caption.end) - Number(caption.start)) * index / Math.max(1, list.length),
        end: Number(caption.start) + (Number(caption.end) - Number(caption.start)) * (index + 1) / Math.max(1, list.length),
      }));
  if (!words.length) return [];
  const base = assOverrideColor(style.color || "#ffffff");
  const weightTag = `\\b${normalizedFontWeight(style.fontWeight || 700)}`;
  const hi = assOverrideColor(style.highlight || "#ffd21f");
  const stroke = assOverrideColor(style.strokeColor || "#000000");
  const effectiveScale = Math.max(0.2, Number(caption.scale || 1));
  const outline = Math.max(0, Number(style.stroke || 0) * effectiveScale);
  const activeOutline = Math.max(outline, animation === "word-box" || animation === "word-ring" ? 3 * effectiveScale : outline);
  const fontSize = Math.max(10, Number(style.fontSize || 54) * effectiveScale);
  const letterSpacing = Number(style.letterSpacing || 0) * effectiveScale;
  const gap = wordGap(style, fontSize);
  const wordWidths = words.map((word) => estimatedWordWidth(word.display || "", style, fontSize, 1));
  const totalWidth = wordWidths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, words.length - 1);
  const left = x - totalWidth / 2;
  const separatorCount = Math.max(1, Math.min(8, 1 + Math.round(Number(style.wordSpacing || 0) / 6)));
  const separator = " ".repeat(separatorCount);
  const wordTimes = words.map((word, index) => {
    const start = Math.max(Number(caption.start), Number(word.start ?? (Number(caption.start) + (Number(caption.end)-Number(caption.start))*index/words.length)));
    const next = words[index + 1];
    const nextStart = next ? Number(next.start ?? NaN) : NaN;
    const end = Math.min(Number(caption.end), Math.max(start + 0.025,
      Number.isFinite(nextStart) ? nextStart : Number(word.end ?? (Number(caption.start) + (Number(caption.end)-Number(caption.start))*(index+1)/words.length))));
    return { start, end };
  });
  return words.flatMap((_, activeIndex) => {
    const { start, end } = wordTimes[activeIndex];
    const content = words.map((word, index) => {
      const escaped = escapeAssText(word.display);
      if (index !== activeIndex) return `{\\1c${base}\\3c${stroke}\\bord${outline.toFixed(1)}\\u0}${escaped}`;
      if (animation === "word-pill")
        return `{\\1c&H000000&\\3c${stroke}\\bord${outline.toFixed(1)}\\u0}${escaped}`;
      if (animation === "underline")
        return `{\\1c${hi}\\3c${stroke}\\bord${outline.toFixed(1)}\\u1}${escaped}`;
      if (animation === "outline-active" || animation === "word-box" || animation === "word-ring")
        return `{\\1c${base}\\3c${hi}\\bord${activeOutline.toFixed(1)}\\u0}${escaped}`;
      return `{\\1c${hi}\\3c${stroke}\\bord${outline.toFixed(1)}\\u0}${escaped}`;
    }).join(separator);
    const events = [];
    if (animation === "word-pill") {
      const before = wordWidths.slice(0, activeIndex).reduce((sum, width) => sum + width, 0) + gap * activeIndex;
      const activeX = left + before + wordWidths[activeIndex] / 2;
      events.push(vectorRectEvent(start, end, {
        x: activeX,
        y,
        width: wordWidths[activeIndex] + Math.max(10, fontSize * 0.22),
        height: fontSize * 1.18,
      }, style.highlight || "#ffd21f", 1, 1));
    }
    const familyTag = style.fontFamily ? `\\fn${String(style.fontFamily).replace(/[{}]/g, "")}` : "";
    const italicTag = style.fontItalic ? "\\i1" : "\\i0";
    events.push(`Dialogue: 2,${assTime(start)},${assTime(end)},Default,,0,0,0,,{\\pos(${x},${y})${familyTag}\\fs${fontSize.toFixed(2)}\\fsp${letterSpacing.toFixed(2)}${weightTag}${italicTag}}${content}`);
    return events;
  }).filter(Boolean);
}

function karaokeAssText(caption, animation) {
  // 兼容旧工程：新的一键成片逐字样式走 stableWordAssEvents，确保所有词位置固定。
  return escapeAssText(caption.text || "");
}

function linePulseAssEvents(caption, style, x, y, fontSize) {
  const words = Array.isArray(caption.words) && caption.words.length
    ? caption.words
    : String(caption.text || "").split(/\s+/).filter(Boolean).map((display, index, list) => ({
        display,
        start: Number(caption.start) + (Number(caption.end) - Number(caption.start)) * index / list.length,
        end: Number(caption.start) + (Number(caption.end) - Number(caption.start)) * (index + 1) / list.length,
      }));
  if (words.length < 2) return [];
  let split = Math.ceil(words.length / 2);
  const totalChars = words.reduce((sum, word) => sum + String(word.display || "").length + 1, 0);
  let chars = 0;
  for (let index = 0; index < words.length - 1; index += 1) {
    chars += String(words[index].display || "").length + 1;
    if (chars >= totalChars / 2) { split = index + 1; break; }
  }
  const lines = [words.slice(0, split), words.slice(split)];
  if (!lines[1].length) return [];
  const boundary = Math.max(Number(caption.start) + 0.04, Number(lines[1][0].start || caption.start));
  const periods = [
    [Number(caption.start), Math.min(Number(caption.end), boundary), 0],
    [Math.min(Number(caption.end), boundary), Number(caption.end), 1],
  ].filter(([start, end]) => end > start + 0.002);
  const offset = Math.round(fontSize * 0.62);
  return periods.flatMap(([start, end, active]) => lines.map((line, index) => {
    const scale = index === active ? 130 : 100;
    const lineY = y + (index === 0 ? -offset : offset);
    const text = escapeAssText(
      spacedText(casedText(line.map((word) => word.display || "").join(" ").replace(/\s+([.,!?;:])/g, "$1"), style.textCase), style.wordSpacing),
    );
    return `Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,{\\pos(${x},${lineY})\\fscx${scale}\\fscy${scale}}${text}`;
  }));
}


function lineRiseAssEvents(caption, style, x, y, fontSize) {
  const words = Array.isArray(caption.words) && caption.words.length
    ? caption.words
    : String(caption.text || "").split(/\s+/).filter(Boolean).map((display, index, list) => ({
        display,
        start: Number(caption.start) + (Number(caption.end) - Number(caption.start)) * index / Math.max(1, list.length),
        end: Number(caption.start) + (Number(caption.end) - Number(caption.start)) * (index + 1) / Math.max(1, list.length),
      }));
  if (words.length < 2) return [];
  const split = Math.max(1, Math.ceil(words.length / 2));
  const lines = [words.slice(0, split), words.slice(split)];
  const mid = Math.max(Number(caption.start) + 0.08, Number(lines[1][0]?.start || (Number(caption.start) + Number(caption.end)) / 2));
  const end = Number(caption.end);
  const rise = Math.max(55, Math.round(fontSize * 1.25));
  const weight = normalizedFontWeight(style.fontWeight || 700);
  const text1 = escapeAssText(spacedText(casedText(lines[0].map(w => w.display).join(" "), style.textCase), style.wordSpacing));
  const text2 = escapeAssText(spacedText(casedText(lines[1].map(w => w.display).join(" "), style.textCase), style.wordSpacing));
  const enter1 = Math.max(120, Math.min(420, Math.round((mid - Number(caption.start)) * 700)));
  const enter2 = Math.max(120, Math.min(420, Math.round((end - mid) * 700)));
  return [
    `Dialogue: 2,${assTime(caption.start)},${assTime(Math.min(end, mid + 0.18))},Default,,0,0,0,,{\\move(${x},${y + rise},${x},${y - Math.round(fontSize * 0.45)},0,${enter1})\\b${weight}\\fad(50,80)}${text1}`,
    `Dialogue: 2,${assTime(mid)},${assTime(end)},Default,,0,0,0,,{\\move(${x},${y + rise},${x},${y + Math.round(fontSize * 0.45)},0,${enter2})\\b${weight}\\fad(50,50)}${text2}`,
  ];
}

function estimatedCaptionBox(caption, style, fontSize, scale, x, y) {
  const words = String(casedText(caption.text || "", style.textCase)).split(/\s+/).filter(Boolean);
  const padding = Math.max(0, Number(style.padding || 0)) * scale;
  const gap = wordGap(style, fontSize);
  const textWidth = words.reduce((sum, word) => sum + estimatedWordWidth(word, style, fontSize, scale), 0) + gap * Math.max(0, words.length - 1);
  const width = Math.max(80, textWidth + padding * 2) * Math.max(0.2, Number(style.backgroundScaleX || 1));
  const height = Math.max(28, fontSize * Math.max(1.2, Number(style.lineHeight || 1.15)) * 1.35 + padding * 2) * Math.max(0.2, Number(style.backgroundScaleY || 1));
  return {
    width,
    height,
    x: x + Number(style.backgroundOffsetX || 0),
    y: y + Number(style.backgroundOffsetY || 0),
  };
}

function vectorRectEvent(start, end, box, color, opacity = 1, layer = 0, radius = 0) {
  const left = Math.round(box.x - box.width / 2), top = Math.round(box.y - box.height / 2);
  const width = Math.max(1, Math.round(box.width)), height = Math.max(1, Math.round(box.height));
  const ass = assOverrideColor(color || "#000000");
  const alpha = assAlpha(opacity);
  return `Dialogue: ${layer},${assTime(start)},${assTime(end)},Default,,0,0,0,,{\\an7\\pos(${left},${top})\\p1\\1c${ass}\\alpha${alpha}\\bord0\\shad0}m 0 0 l ${width} 0 l ${width} ${height} l 0 ${height}{\\p0}`;
}

function fullUnderlineEvent(caption, style, x, y, fontSize, scale) {
  if (!style.fontUnderline || String(style.underlineMode || "line") !== "line") return "";
  const text = casedText(caption.text || "", style.textCase);
  const words = String(text).split(/\s+/).filter(Boolean);
  const width = Math.max(40, words.reduce((sum, word) => sum + estimatedWordWidth(word, style, fontSize, scale), 0) + wordGap(style, fontSize) * Math.max(0, words.length - 1));
  const thickness = Math.max(1, Number(style.underlineThickness || 1) * scale);
  const box = { x, y: y + fontSize * 0.62, width, height: thickness };
  return vectorRectEvent(caption.start, caption.end, box, style.color || "#ffffff", 1, 1);
}


function sharedRasterAnimationSupported(style = {}) {
  const animation = String(style.animation || "fade");
  return ["", "none", "fade", "alisha-reveal", "rise", "drop"].includes(animation);
}

function rasterEnterAnimation(style = {}) {
  const animation = String(style.animation || "");
  if (animation === "fade") return "fade";
  if (animation === "rise") return "slide-up";
  if (animation === "drop") return "slide-down";
  if (animation === "alisha-reveal") {
    const direction = String(style.animationDirection || "leftToRight");
    if (direction === "rightToLeft") return "slide-right";
    if (direction === "bottomToTop") return "slide-up";
    if (direction === "topToBottom") return "slide-down";
    return "slide-left";
  }
  return "";
}

function prepareSharedCaptionRaster(config) {
  if (!process.env.QUICKCUT_APP_EXECUTABLE) return false;
  if (!(config.captions || []).length) return false;
  const style = config.captions[0]?.style || {};
  if (!sharedRasterAnimationSupported(style)) return false;

  const executable = process.env.QUICKCUT_APP_EXECUTABLE;
  if (!fs.existsSync(executable)) return false;
  const directory = path.join(supportRoot(), "temp", `caption-raster-${crypto.randomUUID()}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const jobs = (config.captions || []).map((caption, index) => ({
    text: casedText(caption.text || "", style.textCase),
    outputPath: path.join(directory, `caption-${String(index).padStart(4, "0")}.png`),
    maxWidth: Math.max(80, Number(caption.width || config.width * 0.80)),
    scale: Math.max(0.05, Math.min(8, Number(caption.scale || 1))),
    style,
    activeWordIndex: -1,
  }));
  const manifestPath = path.join(directory, "manifest.json");
  const resultPath = path.join(directory, "result.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ jobs }), { mode: 0o600 });

  const run = spawnSync(executable, ["--render-caption-manifest", manifestPath, resultPath], {
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env },
  });
  if (run.status !== 0 || !fs.existsSync(resultPath)) {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
    return false;
  }
  let results = [];
  try {
    results = JSON.parse(fs.readFileSync(resultPath, "utf8")).results || [];
  } catch {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
    return false;
  }
  if (results.length !== jobs.length) {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
    return false;
  }

  const rasterImages = results.map((result, index) => {
    const caption = config.captions[index];
    const enterAnimation = rasterEnterAnimation(style);
    return {
      path: result.outputPath,
      start: Number(caption.start || 0),
      end: Number(caption.end || 0),
      x: Number(caption.x || 0),
      y: Number(caption.y || 0),
      rotation: 0,
      opacity: 1,
      pixelExact: true,
      enterAnimation,
      enterDuration: Math.min(0.45, Math.max(0.15, (Number(caption.end || 0) - Number(caption.start || 0)) * 0.24)),
      _quickCutCaptionRaster: true,
    };
  });
  config.images = [...(config.images || []), ...rasterImages];
  config.captionRasterized = true;
  config.captionRasterDirectory = directory;
  return true;
}

function createAssSubtitleFile(config) {
  const captions = config.captions || [];
  if (!captions.length) return "";
  const style = { ...(captions[0].style || {}) };
  const resolvedFontPath = resolveFontFile(style);
  const resolvedFontMeta = resolvedFontPath ? readFontMetadata(resolvedFontPath) : null;
  if (resolvedFontMeta?.family) style.fontFamily = resolvedFontMeta.family;
  if (resolvedFontPath) style.fontFile = resolvedFontPath;
  const width = Math.max(320, Math.round(config.width || 1080));
  const height = Math.max(320, Math.round(config.height || 1920));
  const scale = Math.max(0.05, Math.min(8, Number(captions[0].scale || 1)));
  const fontSize = Math.max(
    10,
    Math.round(Number(style.fontSize || 54) * scale),
  );
  const backgroundEnabled = !!style.backgroundEnabled;
  const outline = Math.max(0, Math.round(Number(style.stroke || 0) * scale));
  const shadow = 0;
  const letterSpacing = Number(style.letterSpacing || 0) * scale;
  const x = Math.round(width / 2 + Number(captions[0].x || 0));
  const y = Math.round(height / 2 + Number(captions[0].y || 0));
  const textBoxWidth = Math.max(
    160,
    Math.min(width, Number(captions[0].width || width * 0.8)),
  );
  const horizontalMargin = Math.max(0, Math.round((width - textBoxWidth) / 2));
  const animation = style.animation || "fade";
  const events = captions.flatMap((caption) => {
    const result = [];
    const durationMs = Math.round((Number(caption.end) - Number(caption.start)) * 1000);
    const baseTags = assAnimationTags(animation, x, y, durationMs, style);
    const box = estimatedCaptionBox(caption, style, fontSize, scale, x, y);
    if (style.backgroundEnabled) {
      result.push(vectorRectEvent(caption.start, caption.end, box, style.background || "#000000", Number(style.backgroundOpacity ?? 0.7), 0));
    }
    const shadowStrength = Math.max(0, Number(style.shadow || 0));
    const shadowOpacity = Math.max(0, Math.min(1, Number(style.shadowOpacity ?? 0.8)));
    const shadowBlur = Math.max(0, Number(style.shadowBlur || 0) * scale);
    const shadowDistance = Math.max(0, Number(style.shadowDistance || 0) * scale);
    if (shadowStrength > 0.01 && shadowOpacity > 0.001) {
      const angle = Number(style.shadowAngle ?? 45) * Math.PI / 180;
      const sx = Math.round(Math.cos(angle) * shadowDistance);
      const sy = Math.round(Math.sin(angle) * shadowDistance);
      const shadowText = escapeAssText(spacedText(casedText(caption.text, style.textCase), style.wordSpacing));
      const shadowColor = assOverrideColor(style.shadowColor || "#000000");
      const alpha = assAlpha(shadowOpacity * Math.min(1, shadowStrength / 18));
      result.push(`Dialogue: 1,${assTime(caption.start)},${assTime(caption.end)},Default,,0,0,0,,{\\pos(${x + sx},${y + sy})\\1c${shadowColor}\\alpha${alpha}\\bord0\\shad0\\blur${Math.max(0.1, shadowBlur).toFixed(1)}}${shadowText}`);
    }
    const glow = Math.max(0, Number(style.glow || 0));
    if (glow > 0.01) {
      const glowPx = glow * scale;
      const glowText = escapeAssText(spacedText(casedText(caption.text, style.textCase), style.wordSpacing));
      const glowColor = assOverrideColor(style.glowColor || style.color || "#ffffff");
      const familyTag = style.fontFamily ? `\\fn${String(style.fontFamily).replace(/[{}]/g, "")}` : "";
      result.push(`Dialogue: 0,${assTime(caption.start)},${assTime(caption.end)},Default,,0,0,0,,{\\pos(${x},${y})${familyTag}\\fs${fontSize}\\1a&HFF&\\3c${glowColor}\\3a&H70&\\bord${Math.max(1.2, glowPx * 0.22).toFixed(1)}\\blur${Math.max(2, glowPx * 0.95).toFixed(1)}\\shad0}${glowText}`);
      result.push(`Dialogue: 1,${assTime(caption.start)},${assTime(caption.end)},Default,,0,0,0,,{\\pos(${x},${y})${familyTag}\\fs${fontSize}\\1a&HFF&\\3c${glowColor}\\3a&H35&\\bord${Math.max(0.8, glowPx * 0.12).toFixed(1)}\\blur${Math.max(1.5, glowPx * 0.48).toFixed(1)}\\shad0}${glowText}`);
    }
    if (animation === "line-pulse" || animation === "donald-line-grow") {
      const lines = linePulseAssEvents(caption, style, x, y, fontSize).map((line) => line.replace(/^Dialogue: 0,/, "Dialogue: 2,"));
      if (lines.length) result.push(...lines);
    } else if (animation === "line-rise") {
      result.push(...lineRiseAssEvents(caption, style, x, y, fontSize));
    } else {
      const wordAnimation = animation === "karaoke" || animation === "typewriter" || animation.startsWith("word-") || ["underline", "outline-active"].includes(animation);
      if (wordAnimation) {
        result.push(...stableWordAssEvents(caption, style, x, y, animation));
      } else {
        const text = escapeAssText(spacedText(casedText(caption.text, style.textCase), style.wordSpacing));
        result.push(`Dialogue: 2,${assTime(caption.start)},${assTime(caption.end)},Default,,0,0,0,,{${baseTags}\\b${normalizedFontWeight(style.fontWeight || 700)}}${text}`);
      }
    }
    const underline = fullUnderlineEvent(caption, style, x, y, fontSize, scale);
    if (underline) result.push(underline);
    return result;
  });
  const directory = path.join(supportRoot(), "temp");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filePath = path.join(directory, `captions-${crypto.randomUUID()}.ass`);
  const horizontal = { left: 1, center: 2, right: 3 }[
      style.textAlign || "center"
    ],
    verticalBase = { bottom: 0, middle: 3, top: 6 }[
      style.verticalAlign || "middle"
    ],
    alignment = verticalBase + horizontal,
    backColor = backgroundEnabled
      ? assColor(
          style.background || "#000000",
          1 - Number(style.backgroundOpacity ?? 0.7),
        )
      : assColor(
          style.shadowColor || "#000000",
          1 - Number(style.shadowOpacity ?? 0.8),
        ),
    backgroundPadding = Math.max(
      Number(style.backgroundWidth ?? style.padding ?? 14),
      Number(style.backgroundHeight ?? style.padding ?? 14),
    );
  const content = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${style.fontFamily || "Helvetica"},${fontSize},${assColor(style.color || "#ffffff")},${assColor(style.color || "#ffffff")},${assColor(style.strokeColor || "#000000")},${backColor},${normalizedFontWeight(style.fontWeight || 700)},${style.fontItalic ? -1 : 0},${style.fontUnderline && String(style.underlineMode || "line") === "word" ? -1 : 0},0,100,100,${letterSpacing.toFixed(2)},0,1,${outline},${shadow},${alignment},${horizontalMargin},${horizontalMargin},0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join("\n")}\n`;
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  return filePath;
}

function keptSegments(duration, removals) {
  const ranges = mergeRanges(removals || [], duration);
  const segments = [];
  let cursor = 0;
  ranges.forEach((range) => {
    if (range.start > cursor + 0.002)
      segments.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  });
  if (cursor < duration - 0.002)
    segments.push({ start: cursor, end: duration });
  return segments;
}

function appendMainClipAudioFilters(graph, config, inputLabel) {
  if (!inputLabel || !(config.mainAudioClips || []).length) return inputLabel;
  const filters = [];
  for (const clip of config.mainAudioClips || []) {
    const start = Math.max(0, Number(clip.start || 0));
    const end = Math.max(start + 0.002, Number(clip.end || start));
    const enable = `between(t,${start.toFixed(4)},${end.toFixed(4)})`;
    const volume = clip.muted
      ? 0
      : Math.max(0, Math.min(4, Number(clip.volume ?? 1)));
    if (clip.muted || Math.abs(volume - 1) > 0.001)
      filters.push(
        `volume=volume=${volume.toFixed(3)}:enable='${enable}'`,
      );
    const pan = Math.max(-1, Math.min(1, Number(clip.pan || 0)));
    if (Math.abs(pan) > 0.001)
      filters.push(
        `stereotools=balance_out=${pan.toFixed(3)}:enable='${enable}'`,
      );
    const fadeIn = Math.max(0, Math.min(end - start, Number(clip.fadeIn || 0)));
    const fadeOut = Math.max(
      0,
      Math.min(end - start, Number(clip.fadeOut || 0)),
    );
    if (fadeIn > 0.001)
      filters.push(
        `afade=t=in:st=${start.toFixed(4)}:d=${fadeIn.toFixed(4)}`,
      );
    if (fadeOut > 0.001)
      filters.push(
        `afade=t=out:st=${Math.max(start, end - fadeOut).toFixed(4)}:d=${fadeOut.toFixed(4)}`,
      );
  }
  if (!filters.length) return inputLabel;
  graph.push(`${inputLabel}${filters.join(",")}[clipprocesseda]`);
  return "[clipprocesseda]";
}

function appendExternalAudio(
  graph,
  config,
  firstInputIndex,
  initialLabel = null,
) {
  const labels = initialLabel ? [initialLabel] : [];
  const outputDuration = Math.max(0.04, Number(config.outputDuration || 0));
  const speed = Math.max(0.5, Math.min(2, Number(config.audio?.speed || 1)));
  (config.audioAssets || []).forEach((audio, index) => {
    if (config.trackVisibility?.[audio.trackId] === false) return;
    const start = Math.max(0, Number(audio.start || 0));
    const end = Math.max(start + 0.04, Number(audio.end || start + 0.04));
    const sourceStart = Math.max(0, Number(audio.sourceStart || 0));
    const duration = Math.max(0.04, end - start);
    const sourceDuration = duration * speed;
    const volume = audio.muted
      ? 0
      : Math.max(0, Math.min(4, Number(audio.volume ?? 1)));
    const pan = Math.max(-1, Math.min(1, Number(audio.pan || 0)));
    const fadeIn = Math.max(0, Math.min(duration, Number(audio.fadeIn || 0)));
    const fadeOut = Math.max(0, Math.min(duration, Number(audio.fadeOut || 0)));
    const itemFilters = [
      `atrim=start=${sourceStart.toFixed(5)}:duration=${sourceDuration.toFixed(5)}`,
      "asetpts=PTS-STARTPTS",
    ];
    if (Math.abs(speed - 1) > 0.001)
      itemFilters.push(`atempo=${speed.toFixed(4)}`);
    itemFilters.push(`volume=${volume.toFixed(3)}`);
    if (Math.abs(pan) > 0.001)
      itemFilters.push(`stereotools=balance_out=${pan.toFixed(3)}`);
    if (fadeIn > 0.001)
      itemFilters.push(`afade=t=in:st=0:d=${fadeIn.toFixed(4)}`);
    if (fadeOut > 0.001)
      itemFilters.push(
        `afade=t=out:st=${Math.max(0, duration - fadeOut).toFixed(4)}:d=${fadeOut.toFixed(4)}`,
      );
    itemFilters.push(
      `adelay=${Math.round(start * 1000)}:all=1`,
      "apad",
      `atrim=duration=${outputDuration.toFixed(5)}`,
    );
    const label = `[externala${index}]`;
    graph.push(
      `[${firstInputIndex + index}:a]${itemFilters.join(",")}${label}`,
    );
    labels.push(label);
  });
  if (!labels.length) return null;
  if (labels.length === 1) return labels[0];
  graph.push(
    `${labels.join("")}amix=inputs=${labels.length}:duration=longest:dropout_transition=0,atrim=duration=${outputDuration.toFixed(5)}[mixeda]`,
  );
  return "[mixeda]";
}

function buildAudioExportGraph(config, info, audioInputOffset = 1) {
  const graph = [];
  let label = null;
  if (info.audioCodec) {
    const segments = keptSegments(info.duration, config.removals || []);
    if (!segments.length && !(config.audioAssets || []).length)
      throw new Error("所有音频内容都被删除了，无法导出。");
    const speed = Math.max(0.5, Math.min(2, Number(config.audio?.speed || 1)));
    let cursor = Math.max(0, Number(config.mainTimelineOffset || 0));
    const fallback = segments.map((segment) => {
      const duration = (segment.end - segment.start) / speed;
      const clip = {
        sourceStart: segment.start,
        sourceEnd: segment.end,
        start: cursor,
        end: cursor + duration,
      };
      cursor += duration;
      return clip;
    });
    const clips =
      Array.isArray(config.mainAudioClips) && config.mainAudioClips.length
        ? config.mainAudioClips
        : fallback;
    const outputDuration = Math.max(
      0.04,
      Number(config.outputDuration || cursor || info.duration),
    );
    const inputs = [];
    clips.forEach((clip, index) => {
      const start = Math.max(0, Number(clip.start || 0));
      const end = Math.max(start + 0.002, Number(clip.end || start));
      const sourceStart = Math.max(0, Number(clip.sourceStart || 0));
      const sourceEnd = Math.max(
        sourceStart + 0.002,
        Number(clip.sourceEnd || sourceStart + (end - start) * speed),
      ),
        clipDuration = Math.max(0.002, (sourceEnd - sourceStart) / speed),
        edgeFade = Math.min(0.009, clipDuration / 4);
      graph.push(
        `[0:a]atrim=start=${sourceStart.toFixed(5)}:end=${sourceEnd.toFixed(5)},asetpts=PTS-STARTPTS,atempo=${speed.toFixed(4)},afade=t=in:st=0:d=${edgeFade.toFixed(5)},afade=t=out:st=${Math.max(0, clipDuration - edgeFade).toFixed(5)}:d=${edgeFade.toFixed(5)},adelay=${Math.round(start * 1000)}:all=1,apad,atrim=duration=${outputDuration.toFixed(5)}[a${index}]`,
      );
      inputs.push(`[a${index}]`);
    });
    if (inputs.length > 1) {
      graph.push(
        `${inputs.join("")}amix=inputs=${inputs.length}:duration=longest:dropout_transition=0,atrim=duration=${outputDuration.toFixed(5)}[joineda]`,
      );
      label = "[joineda]";
    } else if (inputs.length === 1) {
      graph.push("[a0]anull[joineda]");
      label = "[joineda]";
    }
    const master = label
      ? audioMasterFilter(
          { ...config, audio: { ...(config.audio || {}), speed: 1, offset: 0 } },
          info,
        )
      : "";
    if (master) {
      graph.push(`${label}${master}[denoiseda]`);
      label = "[denoiseda]";
    }
    label = appendMainClipAudioFilters(graph, config, label);
    if (label && (config.audioMutes || []).length) {
      const filters = config.audioMutes.map(
        (range) =>
          `volume=enable='between(t,${Number(range.start).toFixed(3)},${Number(range.end).toFixed(3)})':volume=0`,
      );
      graph.push(`${label}${filters.join(",")}[outa]`);
      label = "[outa]";
    }
  }
  label = appendExternalAudio(graph, config, audioInputOffset, label);
  if (!label) throw new Error("这个工程没有可导出的音频轨道。");
  return { graph: graph.join(";"), audioLabel: label };
}

function buildExportGraph(config, info) {
  const width = Math.max(320, Math.round(config.width || 1080));
  const height = Math.max(320, Math.round(config.height || 1920));
  const fps = Math.max(24, Math.min(60, Number(config.fps || 30)));
  const segments = keptSegments(info.duration, config.removals || []);
  if (!segments.length) throw new Error("所有视频内容都被删除了，无法导出。");
  const graph = [];
  const speed = Math.max(0.5, Math.min(2, Number(config.audio?.speed || 1)));
  const legacyOffset = Math.max(0, Number(config.mainTimelineOffset || 0));
  let legacyCursor = legacyOffset;
  const fallbackMainClips = segments.map((segment) => {
    const duration = (segment.end - segment.start) / speed;
    const clip = {
      sourceStart: segment.start,
      sourceEnd: segment.end,
      start: legacyCursor,
      end: legacyCursor + duration,
      trackId: "video",
    };
    legacyCursor += duration;
    return clip;
  });
  const hasExplicitMainClips = Array.isArray(config.mainVideoClips) && config.mainVideoClips.length;
  const mainVideoClips = hasExplicitMainClips ? config.mainVideoClips : fallbackMainClips;
  const outputDuration = Math.max(
    0.04,
    Number(config.outputDuration || legacyCursor || info.duration),
  );
  const sourceWidth = Math.max(16, Number(info.width || width));
  const sourceHeight = Math.max(16, Number(info.height || height));
  const linearCutMode = !!config.optimizeLinearCuts && !hasExplicitMainClips && mainVideoClips.length > 1;
  if (linearCutMode) {
    const labels = [];
    mainVideoClips.forEach((clip, index) => {
      const sourceStart = Math.max(0, Number(clip.sourceStart || 0));
      const sourceEnd = Math.max(sourceStart + 0.002, Number(clip.sourceEnd || sourceStart + 0.002));
      graph.push(`[0:v]trim=start=${sourceStart.toFixed(5)}:end=${sourceEnd.toFixed(5)},setpts=PTS-STARTPTS[vcut${index}]`);
      labels.push(`[vcut${index}]`);
    });
    graph.push(`${labels.join("")}concat=n=${labels.length}:v=1:a=0[joinedv0]`);
    graph.push(`[joinedv0]tpad=stop_mode=clone:stop_duration=0.50,trim=duration=${outputDuration.toFixed(5)},setpts=PTS-STARTPTS[joinedv]`);
  } else {
    graph.push(
      `color=c=black:s=${sourceWidth}x${sourceHeight}:r=${fps}:d=${outputDuration.toFixed(5)}[maincanvas0]`,
    );
    mainVideoClips.forEach((clip, index) => {
    const start = Math.max(0, Number(clip.start || 0));
    const end = Math.max(start + 0.002, Number(clip.end || start));
    const sourceStart = Math.max(0, Number(clip.sourceStart || 0));
    const sourceEnd = Math.max(
      sourceStart + 0.002,
      Number(clip.sourceEnd || sourceStart + (end - start) * speed),
    );
    const settings = clip.settings || {},
      clipScale = Math.max(0.05, Number(settings.scale || 1)),
      rotation = Math.max(-360, Math.min(360, Number(settings.rotation || 0))),
      opacity = Math.max(0, Math.min(1, Number(settings.opacity ?? 1))),
      transformFilters = [
        `scale=iw*${clipScale.toFixed(5)}:ih*${clipScale.toFixed(5)}:flags=lanczos+accurate_rnd`,
      ];
    if (Math.abs(rotation) > 0.001)
      transformFilters.push(
        `rotate=${rotation.toFixed(4)}*PI/180:ow=rotw(iw):oh=roth(ih):c=none`,
      );
    if (opacity < 0.999)
      transformFilters.push(
        `format=rgba,colorchannelmixer=aa=${opacity.toFixed(4)}`,
      );
    graph.push(
      `[0:v]trim=start=${sourceStart.toFixed(5)}:end=${sourceEnd.toFixed(5)},setpts=(PTS-STARTPTS)/${speed.toFixed(4)}+${start.toFixed(5)}/TB,${transformFilters.join(",")}[mainraw${index}]`,
    );
    const clipX = `(W-w)/2+${Math.round(Number(settings.x || 0))}`,
      clipY = `(H-h)/2+${Math.round(Number(settings.y || 0))}`;
    graph.push(
      `[maincanvas${index}][mainraw${index}]overlay=x='${clipX}':y='${clipY}':enable='between(t,${start.toFixed(5)},${end.toFixed(5)})':eof_action=pass:shortest=0[maincanvas${index + 1}]`,
    );
    });
    graph.push(`[maincanvas${mainVideoClips.length}]null[joinedv]`);
  }
  if (info.audioCodec) {
    const audioClips =
      Array.isArray(config.mainAudioClips) && config.mainAudioClips.length
        ? config.mainAudioClips
        : mainVideoClips;
    const audioLabels = [];
    audioClips.forEach((clip, index) => {
      const start = Math.max(0, Number(clip.start || 0));
      const end = Math.max(start + 0.002, Number(clip.end || start));
      const sourceStart = Math.max(0, Number(clip.sourceStart || 0));
      const sourceEnd = Math.max(
        sourceStart + 0.002,
        Number(clip.sourceEnd || sourceStart + (end - start) * speed),
      );
      if (linearCutMode) {
        graph.push(`[0:a]atrim=start=${sourceStart.toFixed(5)}:end=${sourceEnd.toFixed(5)},asetpts=PTS-STARTPTS,atempo=${speed.toFixed(4)},afade=t=in:st=0:d=0.008,afade=t=out:st=${Math.max(0, (sourceEnd-sourceStart)/speed-0.008).toFixed(5)}:d=0.008[maina${index}]`);
      } else {
        graph.push(
          `[0:a]atrim=start=${sourceStart.toFixed(5)}:end=${sourceEnd.toFixed(5)},asetpts=PTS-STARTPTS,atempo=${speed.toFixed(4)},adelay=${Math.round(start * 1000)}:all=1,apad,atrim=duration=${outputDuration.toFixed(5)}[maina${index}]`,
        );
      }
      audioLabels.push(`[maina${index}]`);
    });
    if (linearCutMode && audioLabels.length > 1)
      graph.push(`${audioLabels.join("")}concat=n=${audioLabels.length}:v=0:a=1[joineda]`);
    else if (audioLabels.length > 1)
      graph.push(
        `${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0,atrim=duration=${outputDuration.toFixed(5)}[joineda]`,
      );
    else if (audioLabels.length === 1)
      graph.push(`${audioLabels[0]}anull[joineda]`);
  }
  const mainOffset = 0;
  let sourceVideoLabel = "[joinedv]";
  const color = config.color || {};
  const filters = [];
  const exposure = Math.max(-2, Math.min(2, Number(color.exposure || 0) / 50));
  if (Math.abs(exposure) > 0.001)
    filters.push(`exposure=exposure=${exposure.toFixed(3)}:black=0`);
  const contrast = Math.max(0.1, 1 + Number(color.contrast || 0) / 72);
  const pivot = Math.max(-1, Math.min(1, Number(color.pivot || 0) / 100));
  const saturation = Math.max(0, 1 + Number(color.saturation || 0) / 75);
  filters.push(
    `eq=brightness=${(-pivot * (contrast - 1) * 0.18).toFixed(3)}:contrast=${contrast.toFixed(3)}:saturation=${saturation.toFixed(3)}`,
  );
  const lift = Math.max(-1, Math.min(1, Number(color.lift || 0) / 100));
  const gamma = Math.max(-1, Math.min(1, Number(color.gamma || 0) / 100));
  const gain = Math.max(-1, Math.min(1, Number(color.gain || 0) / 100));
  if (Math.abs(lift) > 0.001 || Math.abs(gain) > 0.001) {
    const inputBlack = Math.max(-0.18, Math.min(0.18, -lift * 0.12));
    const outputBlack = Math.max(0, Math.min(0.18, lift * 0.12));
    const inputWhite = Math.max(0.78, Math.min(1, 1 - Math.max(0, gain) * 0.18));
    const outputWhite = Math.max(0.78, Math.min(1, 1 + Math.min(0, gain) * 0.18));
    filters.push(
      `colorlevels=rimin=${inputBlack.toFixed(3)}:gimin=${inputBlack.toFixed(3)}:bimin=${inputBlack.toFixed(3)}:rimax=${inputWhite.toFixed(3)}:gimax=${inputWhite.toFixed(3)}:bimax=${inputWhite.toFixed(3)}:romin=${outputBlack.toFixed(3)}:gomin=${outputBlack.toFixed(3)}:bomin=${outputBlack.toFixed(3)}:romax=${outputWhite.toFixed(3)}:gomax=${outputWhite.toFixed(3)}:bomax=${outputWhite.toFixed(3)}`,
    );
  }
  if (Math.abs(gamma) > 0.001) {
    const mid = Math.max(0.08, Math.min(0.92, 0.5 + gamma * 0.24));
    filters.push(`curves=all='0/0 0.5/${mid.toFixed(3)} 1/1'`);
  }
  const vibrance = Math.max(
    -2,
    Math.min(2, Number(color.vibrance || 0) / 50),
  );
  if (Math.abs(vibrance) > 0.001)
    filters.push(`vibrance=intensity=${vibrance.toFixed(3)}`);
  const hueShift = Math.max(-180, Math.min(180, Number(color.hue || 0) * 1.8));
  if (Math.abs(hueShift) > 0.001)
    filters.push(`hue=h=${hueShift.toFixed(2)}`);
  const temperature = Math.max(
    -0.5,
    Math.min(0.5, Number(color.temperature || 0) / 200),
  );
  const tint = Math.max(-0.4, Math.min(0.4, Number(color.tint || 0) / 250));
  if (Math.abs(temperature) > 0.001 || Math.abs(tint) > 0.001)
    filters.push(
      `colorbalance=rs=${temperature.toFixed(3)}:gs=${tint.toFixed(3)}:bs=${(-temperature).toFixed(3)}:rm=${(temperature * 0.55).toFixed(3)}:gm=${(tint * 0.65).toFixed(3)}:bm=${(-temperature * 0.55).toFixed(3)}`,
    );
  const midtoneDetail = Math.max(-100, Math.min(100, Number(color.midtoneDetail || 0)));
  if (Math.abs(midtoneDetail) > 0.1)
    filters.push(`unsharp=9:9:${(midtoneDetail / 32).toFixed(3)}:7:7:0`);
  const vignette = Math.max(0, Math.min(1, Number(color.vignette || 0) / 100));
  if (vignette > 0.01)
    filters.push(
      `vignette=angle=PI/${(4.8 - vignette * 3.35).toFixed(3)}:eval=frame`,
    );
  const beauty = config.beauty || {};
  const smoothing = Math.max(
    0,
    Math.min(1, Number(beauty.smoothing || 0) / 100),
  );
  const blemish = Math.max(
    0,
    Math.min(1, Number(beauty.blemish || 0) / 100),
  );
  const texture = Math.max(
    0,
    Math.min(1, Number(beauty.texture || 0) / 100),
  );
  const whitening = Math.max(
    0,
    Math.min(1, Number(beauty.whitening || 0) / 100),
  );
  const brighten = Math.max(
    -1,
    Math.min(1, Number(beauty.brighten || 0) / 100),
  );
  const warmth = Math.max(-1, Math.min(1, Number(beauty.warmth || 0) / 50));
  const rosy = Math.max(
    -1,
    Math.min(1, Number(beauty.rosy || 0) / 100),
  );
  if (Math.abs(warmth) > 0.01 || Math.abs(rosy) > 0.01)
    filters.push(
      `colorbalance=rs=${(warmth * 0.075 + rosy * 0.045).toFixed(3)}:gs=${(-rosy * 0.018).toFixed(3)}:bs=${(-warmth * 0.075 - rosy * 0.025).toFixed(3)}:rm=${(warmth * 0.045 + rosy * 0.035).toFixed(3)}:gm=0:bm=${(-warmth * 0.045).toFixed(3)}`,
    );
  // Do not simulate skin whitening with a global luma/gamma lift. That brightens sky/walls.
  // Preview uses an actual skin mask. Export keeps color changes conservative until a dedicated
  // face segmentation path is available; smoothing/detail remain visible without flattening the frame.
  if (Math.abs(brighten) > 0.01 || whitening > 0.01)
    filters.push(
      `colorbalance=rm=${(brighten * 0.022 + whitening * 0.018).toFixed(3)}:gm=${(brighten * 0.014 + whitening * 0.012).toFixed(3)}:bm=${(-whitening * 0.004).toFixed(3)}`,
    );
  if (texture > 0.01)
    filters.push(
      `unsharp=5:5:${(0.2 + texture * 1.8).toFixed(3)}:5:5:0`,
    );
  const transform = config.videoTransform || {};
  const scale = Math.max(0.05, Number(transform.scale || 1));
  const rotation = Math.max(-360, Math.min(360, Number(transform.rotation || 0)));
  filters.push(
    `scale=w=${Math.round(width * scale)}:h=${Math.round(height * scale)}:force_original_aspect_ratio=decrease:flags=lanczos+accurate_rnd`,
  );
  if (Math.abs(rotation) > 0.001)
    filters.push(`rotate=${rotation.toFixed(4)}*PI/180:ow=rotw(iw):oh=roth(ih):c=none`);
  let gradedInput = sourceVideoLabel;
  if (smoothing > 0.01 || blemish > 0.01) {
    // hqdn3d is SIMD-optimised and keeps the hardware encoder fed.  The old
    // smartblur + bilateral chain evaluated two neighbourhood filters for
    // every 1080p frame and could sit at 0% for minutes before frame one.
    graph.push(
      `${sourceVideoLabel}hqdn3d=${(0.18 + smoothing * 0.92 + blemish * 0.52).toFixed(2)}:${(0.14 + smoothing * 0.58).toFixed(2)}:${(0.28 + smoothing * 0.76).toFixed(2)}:${(0.18 + smoothing * 0.48).toFixed(2)},unsharp=5:5:${(0.16 + texture * 1.05 + smoothing * 0.06).toFixed(3)}:5:5:0[beautymerged]`,
    );
    gradedInput = "[beautymerged]";
  }
  const lutPath = String(config.lut?.path || "");
  const lutStrength = Math.max(
    0,
    Math.min(1, Number(config.lut?.intensity ?? 1)),
  );
  if (lutPath && fs.existsSync(lutPath) && lutStrength > 0.001) {
    graph.push(`${gradedInput}${filters.join(",")}[gradedbase]`);
    if (lutStrength >= 0.999)
      graph.push(
        `[gradedbase]lut3d=file='${escapeFilterPath(lutPath)}':interp=tetrahedral[main]`,
      );
    else {
      graph.push(`[gradedbase]split=2[lutoriginal][lutinput]`);
      graph.push(
        `[lutinput]lut3d=file='${escapeFilterPath(lutPath)}':interp=tetrahedral[lutresult]`,
      );
      graph.push(
        `[lutoriginal][lutresult]blend=all_expr='A*${(1 - lutStrength).toFixed(4)}+B*${lutStrength.toFixed(4)}'[main]`,
      );
    }
  } else graph.push(`${gradedInput}${filters.join(",")}[main]`);
  graph.push(`color=c=black:s=${width}x${height}:r=${fps}[base]`);
  const x = `(W-w)/2+${Math.round(Number(transform.x || 0))}`;
  const y = `(H-h)/2+${Math.round(Number(transform.y || 0))}`;
  let layer = 0;
  let inputIndex = 1;
  const mainTrackIds = [...new Set(mainVideoClips.map((clip) => clip.trackId || "video"))];
  const mainTrackLabels = new Map();
  if (mainTrackIds.length > 1) {
    const labels = mainTrackIds.map((_, index) => `[maintrack${index}]`);
    graph.push(`[main]split=${mainTrackIds.length}${labels.join("")}`);
    mainTrackIds.forEach((trackId, index) =>
      mainTrackLabels.set(trackId, labels[index]),
    );
  } else mainTrackLabels.set(mainTrackIds[0] || "video", "[main]");
  const consumedMainTracks = new Set();
  const preparedVideos = (config.videoLayers || []).map((video, index) => {
    const videoScale = Math.max(0.03, Number(video.scale || 1));
    const clipDuration = Math.max(
      0.04,
      Number(video.end || 0) - Number(video.start || 0),
    );
    const sourceDuration = clipDuration * speed;
    const videoFilters = [
      `scale=w=${Math.max(8, Math.round(width * videoScale))}:h=${Math.max(8, Math.round(height * videoScale))}:force_original_aspect_ratio=decrease:flags=lanczos+accurate_rnd`,
    ];
    if (Math.abs(Number(video.rotation || 0)) > 0.001)
      videoFilters.push(
        `rotate=${Number(video.rotation).toFixed(4)}*PI/180:ow=rotw(iw):oh=roth(ih):c=none`,
      );
    videoFilters.push(
      "format=rgba",
      `colorchannelmixer=aa=${Math.max(0, Math.min(1, Number(video.opacity ?? 1))).toFixed(3)}`,
    );
    graph.push(
      `[${inputIndex}:v]trim=start=${Math.max(0, Number(video.sourceStart || 0)).toFixed(5)}:duration=${sourceDuration.toFixed(5)},setpts=(PTS-STARTPTS)/${speed.toFixed(4)}+${Math.max(0, Number(video.start || 0)).toFixed(5)}/TB,${videoFilters.join(",")}[overlayv${index}]`,
    );
    inputIndex += 1;
    return { video, label: `[overlayv${index}]` };
  });
  const preparedImages = (config.images || []).map((image, index) => {
    const imageScale = Math.max(0.03, Number(image.scale || 0.35));
    const imageWidth = Math.max(8, Math.round(width * imageScale));
    const imageFilters = image.pixelExact
      ? []
      : [`scale=${imageWidth}:-1:flags=lanczos+accurate_rnd`];
    if (Math.abs(Number(image.rotation || 0)) > 0.001)
      imageFilters.push(
        `rotate=${Number(image.rotation).toFixed(4)}*PI/180:ow=rotw(iw):oh=roth(ih):c=none`,
      );
    imageFilters.push(
      "format=rgba",
      `colorchannelmixer=aa=${Math.max(0, Math.min(1, Number(image.opacity ?? 1))).toFixed(3)}`,
    );
    if (image.enterAnimation) {
      const duration = Math.max(0.15, Number(image.enterDuration || 0.45));
      imageFilters.push(
        `fade=t=in:st=${Math.max(0, Number(image.start || 0)).toFixed(4)}:d=${duration.toFixed(4)}:alpha=1`,
      );
    }
    if (image.exitAnimation) {
      const duration = Math.max(0.15, Number(image.exitDuration || 0.45));
      imageFilters.push(
        `fade=t=out:st=${Math.max(Number(image.start || 0), Number(image.end || 0) - duration).toFixed(4)}:d=${duration.toFixed(4)}:alpha=1`,
      );
    }
    graph.push(
      `[${inputIndex}:v]${imageFilters.join(",")}[img${index}]`,
    );
    inputIndex += 1;
    return { image, label: `[img${index}]` };
  });
  graph.push("[base]null[layer0]");
  const addTextItems = (items) => {
    for (const text of items || []) {
      layer += 1;
      const style = text.style || {};
      const resolvedFont = resolveFontFile(style);
      if (!resolvedFont)
        throw new Error("找不到可用于导出的字体文件，请先在字体面板载入字体。");
      const fontFile = `:fontfile='${escapeDrawtext(resolvedFont)}'`;
      const textScale = Math.max(0.05, Math.min(8, Number(text.scale || 1)));
      const backgroundPadding = Math.max(
        Number(style.backgroundWidth ?? style.padding ?? 14),
        Number(style.backgroundHeight ?? style.padding ?? 14),
      );
      const background = style.backgroundEnabled
        ? `:box=1:boxcolor=${style.background || "black"}@${Math.max(0, Math.min(1, Number(style.backgroundOpacity ?? 0.7))).toFixed(2)}:boxborderw=${Math.round(backgroundPadding * textScale)}`
        : "";
      const shadowDistance = Number(style.shadowDistance ?? style.shadow ?? 0),
        shadowAngle = (Number(style.shadowAngle ?? 45) * Math.PI) / 180,
        shadowX = Math.round(Math.cos(shadowAngle) * shadowDistance * textScale),
        shadowY = Math.round(Math.sin(shadowAngle) * shadowDistance * textScale);
      const shadow =
        Number(style.shadowOpacity ?? 0.8) > 0 &&
        Number(style.shadowBlur ?? style.shadow ?? 0) > 0
          ? `:shadowx=${shadowX}:shadowy=${shadowY}:shadowcolor=${style.shadowColor || "black"}@${Math.max(0, Math.min(1, Number(style.shadowOpacity ?? 0.8))).toFixed(2)}`
          : "";
      const border =
        Number(style.stroke || 0) > 0
          ? `:borderw=${Math.round(Number(style.stroke || 2) * textScale)}:bordercolor=${style.strokeColor || "black"}`
          : "";
      const lineSpacing = Math.round(
        (Number(style.lineHeight || 1.15) - 1) *
          Number(style.fontSize || 54) *
          textScale,
      );
      const baseX = `(w-text_w)/2+${Math.round(Number(text.x || 0))}`,
        baseY = `(h-text_h)/2+${Math.round(Number(text.y || 0))}`,
        animatedX = animatedPosition(text, "x", baseX, 130),
        animatedY = animatedPosition(text, "y", baseY, 130),
        alpha = animatedAlpha(text, 1),
        content = spacedText(casedText(text.text, style.textCase), style.wordSpacing);
      const enable = `between(t,${Number(text.start || 0).toFixed(3)},${Number(text.end || info.duration).toFixed(3)})`,
        backgroundX = animatedPosition(
          text,
          "x",
          `(w-text_w)/2+${Math.round(Number(text.x || 0) + Number(style.backgroundX || 0))}`,
          130,
        ),
        backgroundY = animatedPosition(
          text,
          "y",
          `(h-text_h)/2+${Math.round(Number(text.y || 0) + Number(style.backgroundY || 0))}`,
          130,
        ),
        backgroundDraw = style.backgroundEnabled
          ? `drawtext=text='${escapeDrawtext(content)}'${fontFile}:fontsize=${Math.round(Number(style.fontSize || 54) * textScale)}:line_spacing=${lineSpacing}:fontcolor=white@0:x='${backgroundX}':y='${backgroundY}'${background}:enable='${enable}',`
          : "";
      const draw = `${backgroundDraw}drawtext=text='${escapeDrawtext(content)}'${fontFile}:fontsize=${Math.round(Number(style.fontSize || 54) * textScale)}:line_spacing=${lineSpacing}:fontcolor=${style.color || "white"}:alpha='${alpha}':x='${animatedX}':y='${animatedY}'${shadow}${border}:enable='${enable}'`;
      graph.push(`[layer${layer - 1}]${draw}[layer${layer}]`);
    }
  };
  const order =
    Array.isArray(config.trackOrder) && config.trackOrder.length
      ? [...config.trackOrder].reverse()
      : ["video", "image", "text", "caption"];
  let captionRendered = false;
  for (const key of order) {
    const kind = config.trackDefinitions?.[key]?.kind || key;
    if (config.trackVisibility?.[key] === false) continue;
    if (kind === "video") {
      const mainLabel = mainTrackLabels.get(key);
      if (mainLabel && config.includeVideo !== false) {
        const ranges = mainVideoClips.filter(
          (clip) => (clip.trackId || "video") === key,
        );
        const enable = ranges
          .map(
            (clip) =>
              `between(t,${Math.max(0, Number(clip.start || 0)).toFixed(3)},${Math.max(Number(clip.start || 0), Number(clip.end || 0)).toFixed(3)})`,
          )
          .join("+");
        layer += 1;
        graph.push(
          `[layer${layer - 1}]${mainLabel}overlay=x='${x}':y='${y}':enable='${enable || "1"}':eof_action=pass:shortest=0[layer${layer}]`,
        );
        consumedMainTracks.add(key);
      }
      for (const { video, label } of preparedVideos.filter(
        (item) =>
          item.video.trackId === key ||
          (!item.video.trackId && key === "video-overlay"),
      )) {
        layer += 1;
        graph.push(
          `[layer${layer - 1}]${label}overlay=x='(W-w)/2+${Math.round(Number(video.x || 0))}':y='(H-h)/2+${Math.round(Number(video.y || 0))}':enable='between(t,${Number(video.start || 0).toFixed(3)},${Number(video.end || info.duration).toFixed(3)})':eof_action=pass:shortest=0[layer${layer}]`,
        );
      }
    } else if (kind === "image") {
      for (const { image, label } of preparedImages.filter(
        (item) =>
          item.image.trackId === key || (!item.image.trackId && key === "image"),
      )) {
        layer += 1;
        const imageX = animatedPosition(
          image,
          "x",
          `(W-w)/2+${Math.round(Number(image.x || 0))}`,
          220,
        );
        const imageY = animatedPosition(
          image,
          "y",
          `(H-h)/2+${Math.round(Number(image.y || 0))}`,
          220,
        );
        graph.push(
          `[layer${layer - 1}]${label}overlay=x='${imageX}':y='${imageY}':enable='between(t,${Number(image.start || 0).toFixed(3)},${Number(image.end || info.duration).toFixed(3)})':shortest=1[layer${layer}]`,
        );
      }
    } else if (kind === "text")
      addTextItems(
        (config.titles || []).filter(
          (item) => item.trackId === key || (!item.trackId && key === "text"),
        ),
      );
    else if (kind === "caption" && config.captionRasterized && !captionRendered) {
      // Caption pixels were rasterized by the same AppKit/CoreText renderer used by preview.
      captionRendered = true;
    } else if (kind === "caption" && config.captionAssPath && !captionRendered) {
      layer += 1;
      const fontFile = resolveFontFile(config.captions?.[0]?.style || {});
      const fontsDir = fontFile
        ? path.dirname(fontFile)
        : path.join(supportRoot(), "fonts");
      graph.push(
        `[layer${layer - 1}]ass=filename='${escapeFilterPath(config.captionAssPath)}':fontsdir='${escapeFilterPath(fontsDir)}'[layer${layer}]`,
      );
      captionRendered = true;
    } else if (kind === "caption" && !captionRendered) {
      addTextItems(config.captions || []);
      captionRendered = true;
    }
  }
  for (const [trackId, label] of mainTrackLabels)
    if (!consumedMainTracks.has(trackId)) graph.push(`${label}nullsink`);
  let audioLabel =
    info.audioCodec && config.includeAudio !== false ? "[joineda]" : null;
  if (info.audioCodec && config.includeAudio === false)
    graph.push("[joineda]anullsink");
  if (audioLabel && mainOffset > 0.001) {
    graph.push(
      `${audioLabel}adelay=${Math.round(mainOffset * 1000)}:all=1[mainoffseta]`,
    );
    audioLabel = "[mainoffseta]";
  }
  const master = audioLabel
    ? audioMasterFilter(
        { ...config, audio: { ...(config.audio || {}), speed: 1, offset: 0 } },
        info,
      )
    : "";
  if (audioLabel && master) {
    graph.push(`${audioLabel}${master}[denoiseda]`);
    audioLabel = "[denoiseda]";
  }
  audioLabel = appendMainClipAudioFilters(graph, config, audioLabel);
  if (audioLabel && (config.audioMutes || []).length) {
    const muteFilters = config.audioMutes.map(
      (range) =>
        `volume=enable='between(t,${Number(range.start).toFixed(3)},${Number(range.end).toFixed(3)})':volume=0`,
    );
    graph.push(`${audioLabel}${muteFilters.join(",")}[outa]`);
    audioLabel = "[outa]";
  }
  audioLabel =
    config.includeAudio === false
      ? null
      : appendExternalAudio(graph, config, inputIndex, audioLabel);
  const videoLabel = `[layer${layer}]`;
  return { graph: graph.join(";"), videoLabel, audioLabel, width, height, fps };
}

export async function renderDenoisePreview(inputPath, time, mode, strength) {
  const directory = path.join(supportRoot(), "previews");
  fs.mkdirSync(directory, { recursive: true });
  const outputPath = path.join(directory, `denoise-${crypto.randomUUID()}.m4a`);
  const filter = audioDenoiseFilter(mode, strength) || "anull";
  await run(mediaBinary("ffmpeg"), [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    String(Math.max(0, Number(time || 0) - 2)),
    "-t",
    "8",
    "-i",
    inputPath,
    "-vn",
    "-af",
    filter,
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    outputPath,
  ]);
  return outputPath;
}

export async function renderLutPreviewFrame(inputPath, time, lutPath) {
  if (!inputPath || !fs.existsSync(inputPath)) throw new Error("请先导入视频。");
  if (!lutPath || !fs.existsSync(lutPath)) throw new Error("LUT 文件不存在。");
  const directory = path.join(supportRoot(), "previews", "lut");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const outputPath = path.join(directory, `lut-${crypto.randomUUID()}.jpg`);
  await run(mediaBinary("ffmpeg"), [
    "-y", "-hide_banner", "-loglevel", "error",
    "-ss", String(Math.max(0, Number(time || 0))),
    "-i", inputPath,
    "-vf", `lut3d=file='${escapeFilterPath(lutPath)}':interp=tetrahedral,scale=540:-2:flags=bilinear`,
    "-frames:v", "1", "-q:v", "3", outputPath,
  ], { lowPriority: true });
  return outputPath;
}

export async function renderDenoisedTrack(inputPath, mode, strength, destination = "") {
  if (!inputPath || !fs.existsSync(inputPath)) throw new Error("找不到需要降噪的音频。");
  const directory = destination
    ? path.dirname(path.resolve(destination))
    : path.join(supportRoot(), "previews");
  fs.mkdirSync(directory, { recursive: true });
  const outputPath = destination
    ? path.resolve(destination)
    : path.join(directory, `denoised-track-${crypto.randomUUID()}.m4a`);
  const temporary = path.join(
    directory,
    `.${path.basename(outputPath)}.${crypto.randomUUID()}.partial.m4a`,
  );
  const filter = audioDenoiseFilter(mode, strength) || "anull";
  try {
    await run(mediaBinary("ffmpeg"), [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-vn",
      "-af",
      filter,
      "-c:a",
      "aac",
      "-b:a",
      "224k",
      temporary,
    ]);
    const stat = await fs.promises.stat(temporary).catch(() => null);
    if (!stat?.isFile() || stat.size < 256)
      throw new Error("降噪音轨没有正确生成，请重试。");
    await fs.promises.rename(temporary, outputPath);
  } finally {
    await fs.promises.unlink(temporary).catch(() => {});
  }
  return outputPath;
}

function visualTransformIsDefault(value = {}) {
  return Math.abs(Number(value.x || 0)) < 0.001 &&
    Math.abs(Number(value.y || 0)) < 0.001 &&
    Math.abs(Number(value.scale || 1) - 1) < 0.001 &&
    Math.abs(Number(value.rotation || 0)) < 0.001 &&
    Math.abs(Number(value.opacity ?? 1) - 1) < 0.001 &&
    (value.blendMode || "normal") === "normal";
}

function canSmartCopy(config, info, format) {
  const clips = config.mainVideoClips || [],
    clip = clips[0],
    sourceCodec = String(info.videoCodec || "").toLowerCase(),
    sourceIsWebSafe = /h264|avc|hevc|h265/.test(sourceCodec),
    codecMatches = (config.codec === "source" && (format === "mov" || sourceIsWebSafe)) || (config.codec === "hevc"
      ? /hevc|h265/.test(sourceCodec)
      : /h264|avc/.test(sourceCodec)),
    noColor = Object.values(config.color || {}).every(
      (value) => Math.abs(Number(value || 0)) < 0.001,
    ),
    noBeauty = Object.values(config.beauty || {}).every(
      (value) => Math.abs(Number(value || 0)) < 0.001,
    );
  return ["mp4", "mov"].includes(format) && codecMatches &&
    Number(config.width) === Number(info.displayWidth || info.width) &&
    Number(config.height) === Number(info.displayHeight || info.height) &&
    Math.abs(Number(config.fps || info.frameRate) - Number(info.frameRate || config.fps)) < 0.1 &&
    clips.length === 1 && Number(clip.start || 0) < 0.002 &&
    Math.abs(Number(clip.sourceStart || 0)) < 0.002 &&
    Math.abs(Number(clip.sourceEnd || info.duration) - Number(info.duration)) < 0.04 &&
    Math.abs(Number(config.outputDuration || info.duration) - Number(info.duration)) < 0.04 &&
    visualTransformIsDefault(config.videoTransform) &&
    visualTransformIsDefault(clip.settings) && noColor && noBeauty &&
    !(config.removals || []).length && !(config.audioMutes || []).length &&
    !(config.videoLayers || []).length && !(config.images || []).length &&
    !(config.titles || []).length && !(config.captions || []).length &&
    !(config.audioAssets || []).length && config.includeVideo !== false &&
    config.includeAudio !== false && !config.audioProcessingEnabled &&
    Number(config.denoise?.strength || 0) <= 0.01;
}

export function startExport(config) {
  const info = probeMedia(config.inputPath);
  const id = crypto.randomUUID();
  const job = {
    id,
    state: "preparing",
    progress: 0.01,
    error: "",
    outputPath: config.outputPath,
    child: null,
  };
  jobs.set(id, job);
  const format = String(
    config.format || path.extname(config.outputPath).slice(1) || "mp4",
  ).toLowerCase();
  if (canSmartCopy(config, info, format)) {
    const args = [
      "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
      "-i", config.inputPath,
      "-map", "0:v:0", "-map", "0:a?", "-c", "copy",
      "-map_metadata", "0", "-movflags", "+faststart",
      "-t", String(Math.max(0.04, Number(config.outputDuration || info.duration))),
      "-progress", "pipe:2", "-nostats", config.outputPath,
    ];
    const child = spawn(mediaBinary("ffmpeg"), args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (child.pid) {
      try { os.setPriority(child.pid, 5); } catch {}
    }
    job.child = child;
    job.state = "exporting";
    job.progress = Math.max(job.progress, 0.02);
    job.encoder = "copy";
    job.mode = "smart-copy";
    monitorExport(child, job, config, info);
    return { jobId: id, mode: "smart-copy" };
  }
  if (format !== "mp3" && (config.captions || []).length) {
    const rasterized = process.platform === "darwin" && prepareSharedCaptionRaster(config);
    if (!rasterized) config.captionAssPath = createAssSubtitleFile(config);
  }
  const inputs = isDarwin
    ? ["-hwaccel", "videotoolbox", "-i", config.inputPath]
    : ["-i", config.inputPath];
  if (format === "mp3") {
    for (const audio of config.audioAssets || []) inputs.push("-i", audio.path);
    const built = buildAudioExportGraph(config, info, 1);
    const args = [
      "-y",
      "-hide_banner",
      ...inputs,
      "-filter_complex",
      built.graph,
      "-map",
      built.audioLabel,
      "-c:a",
      "libmp3lame",
      "-b:a",
      "192k",
      "-t",
      String(Math.max(0.04, Number(config.outputDuration || info.duration))),
      "-progress",
      "pipe:2",
      "-nostats",
      config.outputPath,
    ];
    const child = spawn(mediaBinary("ffmpeg"), args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (child.pid) {
      try { os.setPriority(child.pid, 5); } catch {}
    }
    job.child = child;
    job.state = "exporting";
    job.progress = Math.max(job.progress, 0.02);
    monitorExport(child, job, config, info);
    return { jobId: id };
  }
  for (const video of config.videoLayers || []) inputs.push("-i", video.path);
  for (const image of config.images || [])
    inputs.push("-loop", "1", "-i", image.path);
  for (const audio of config.audioAssets || []) inputs.push("-i", audio.path);
  const built = buildExportGraph(config, info);
  const colorProfiles = {
      bt709: { space: "bt709", primaries: "bt709", transfer: "bt709", pixel: "yuv420p" },
      p3: { space: "bt709", primaries: "smpte432", transfer: "iec61966-2-1", pixel: "yuv420p" },
      bt2020: { space: "bt2020nc", primaries: "bt2020", transfer: "bt709", pixel: "yuv420p" },
      hlg: { space: "bt2020nc", primaries: "bt2020", transfer: "arib-std-b67", pixel: "p010le", hdr: true },
      pq: { space: "bt2020nc", primaries: "bt2020", transfer: "smpte2084", pixel: "p010le", hdr: true },
    },
    colorProfile = colorProfiles[config.colorSpace] || colorProfiles.bt709,
    useHevc = config.codec === "hevc" ||
      (config.codec === "source" && /hevc|h265/.test(String(info.videoCodec || "").toLowerCase())) ||
      colorProfile.hdr;
  const preferredEncoder = preferredVideoEncoder(useHevc);
  const fallbackEncoder = useHevc ? "libx265" : "libx264";
  const launch = (encoder, allowFallback) => {
    // 商业级资源预算：滤镜图不允许无限抢满 CPU/内存。
    // VideoToolbox 负责硬件编码，CPU 线程主要留给解码/滤镜/字幕合成。
    const logical = Math.max(2, Number(os.cpus?.().length || 4));
    const budget = config.resourceBudget && typeof config.resourceBudget === "object" ? config.resourceBudget : {};
    const workerThreads = Math.max(2, Math.min(6, Number(budget.workerThreads || Math.ceil(logical / 2))));
    const filterThreads = Math.max(1, Math.min(6, Number(budget.filterThreads || (isDarwin ? 4 : 2))));
    const args = [
      "-y",
      "-hide_banner",
      "-threads", String(workerThreads),
      "-filter_threads", String(filterThreads),
      "-filter_complex_threads", String(filterThreads),
      ...inputs,
      "-filter_complex",
      built.graph,
      "-map",
      built.videoLabel,
    ];
    if (built.audioLabel) args.push("-map", built.audioLabel);
    args.push(
      "-r",
      String(built.fps),
      "-c:v",
      encoder,
      "-b:v",
      String(config.bitrate || (config.quality === "high" ? "20M" : "12M")),
    );
    const numericBitrate = Number.parseFloat(String(config.bitrate || "20M")) || 20;
    args.push(
      "-maxrate", `${Math.ceil(numericBitrate * 1.32)}M`,
      "-bufsize", `${Math.ceil(numericBitrate * 2)}M`,
      "-g", String(Math.max(24, Math.round(built.fps * 2))),
    );
    if (encoder === "h264_videotoolbox")
      args.push("-profile:v", "high", "-realtime", "true");
    if (encoder === "hevc_videotoolbox")
      args.push("-profile:v", colorProfile.hdr ? "main10" : "main", "-tag:v", "hvc1", "-realtime", "true");
    if (encoder === "h264_nvenc" || encoder === "hevc_nvenc")
      args.push("-preset", "p4", "-rc", "vbr", "-spatial_aq", "1");
    if (encoder === "h264_amf" || encoder === "hevc_amf")
      args.push("-quality", "balanced", "-rc", "vbr_peak");
    if (encoder === "h264_qsv" || encoder === "hevc_qsv")
      args.push("-preset", "medium");
    if (encoder.startsWith("libx")) args.push("-preset", "fast");
    args.push(
      "-pix_fmt",
      colorProfile.pixel,
      "-colorspace",
      colorProfile.space,
      "-color_primaries",
      colorProfile.primaries,
      "-color_trc",
      colorProfile.transfer,
    );
    if (built.audioLabel) args.push("-c:a", "aac", "-b:a", "192k");
    args.push(
      "-t",
      String(Math.max(0.04, Number(config.outputDuration || info.duration))),
      "-movflags",
      "+faststart",
      "-progress",
      "pipe:2",
      "-nostats",
      config.outputPath,
    );
    const child = spawn(mediaBinary("ffmpeg"), args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (child.pid) {
      try { os.setPriority(child.pid, 5); } catch {}
    }
    job.child = child;
    job.state = "exporting";
    job.progress = Math.max(job.progress, 0.02);
    job.encoder = encoder;
    job.mode =
      /videotoolbox|nvenc|amf|qsv|_mf$/.test(encoder)
        ? "hardware-quality"
        : "software-fallback";
    monitorExport(
      child,
      job,
      config,
      info,
      allowFallback
        ? () => {
            job.progress = 0.015;
            job.error = "";
            launch(fallbackEncoder, false);
          }
        : null,
    );
  };
  launch(preferredEncoder, preferredEncoder !== fallbackEncoder);
  return { jobId: id };
}

function monitorExport(child, job, config, info, retry = null) {
  let stderr = "", progressBuffer = "";
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr = (stderr + text).slice(-12000);
    progressBuffer = (progressBuffer + text).slice(-4000);
    const timeMatches = [...progressBuffer.matchAll(/out_time_(?:ms|us)=(\d+)/g)];
    const frameMatches = [...progressBuffer.matchAll(/(?:^|\n)frame=(\d+)/g)];
    let seconds = 0;
    if (timeMatches.length)
      seconds = Number(timeMatches[timeMatches.length - 1][1]) / 1e6;
    else if (frameMatches.length)
      seconds = Number(frameMatches[frameMatches.length - 1][1]) /
        Math.max(1, Number(config.fps || info.frameRate || 30));
    if (seconds > 0)
      job.progress = Math.max(
        job.progress,
        Math.min(
          0.99,
          seconds / Math.max(0.1, Number(config.outputDuration || info.duration)),
        ),
      );
    const lastNewline = progressBuffer.lastIndexOf("\n");
    if (lastNewline > 0) progressBuffer = progressBuffer.slice(lastNewline + 1);
  });
  child.on("error", (error) => {
    job.state = "failed";
    job.error = error.message;
  });
  child.on("close", (code) => {
    job.child = null;
    if (job.state === "cancelled") {
      if (config.captionAssPath)
        try {
          fs.unlinkSync(config.captionAssPath);
        } catch {
          /* temporary subtitle file */
        }
      return;
    }
    if (code === 0 && fs.existsSync(config.outputPath)) {
      job.state = "completed";
      job.progress = 1;
    } else if (retry) {
      job.state = "preparing";
      retry(stderr);
      return;
    } else {
      job.state = "failed";
      job.error = stderr.trim() || "视频导出失败。";
    }
    if (config.captionAssPath)
      try {
        fs.unlinkSync(config.captionAssPath);
      } catch {
        /* temporary subtitle file */
      }
  });
}

export function exportStatus(jobId) {
  const job = jobs.get(String(jobId || ""));
  if (!job) throw new Error("导出任务已经不存在。");
  return {
    jobId: job.id,
    state: job.state,
    progress: job.progress,
    error: job.error,
    outputPath: job.outputPath,
  };
}

export function cancelExport(jobId) {
  const job = jobs.get(String(jobId || ""));
  if (!job || ["completed", "failed", "cancelled"].includes(job.state))
    return false;
  job.state = "cancelled";
  try {
    job.child?.kill("SIGTERM");
  } catch {
    /* already stopped */
  }
  return true;
}


const fontMetadataCache = new Map();
function decodeFontNameString(buffer, platformId) {
  if (!buffer?.length) return "";
  if (platformId === 0 || platformId === 3) {
    let out = "";
    for (let i = 0; i + 1 < buffer.length; i += 2) {
      const code = buffer.readUInt16BE(i);
      if (code) out += String.fromCharCode(code);
    }
    return out.replace(/\u0000/g, "").trim();
  }
  return buffer.toString("latin1").replace(/\u0000/g, "").trim();
}

function readFontMetadata(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const cacheKey = `${filePath}:${stat.size}:${stat.mtimeMs}`;
    const cached = fontMetadataCache.get(cacheKey);
    if (cached) return cached;
    const buffer = fs.readFileSync(filePath);
    if (buffer.length < 20) return null;
    let sfntOffset = 0;
    if (buffer.toString("ascii", 0, 4) === "ttcf") {
      const count = buffer.readUInt32BE(8);
      if (!count || buffer.length < 16) return null;
      sfntOffset = buffer.readUInt32BE(12);
    }
    if (sfntOffset + 12 > buffer.length) return null;
    const numTables = buffer.readUInt16BE(sfntOffset + 4);
    let nameOffset = -1, nameLength = 0;
    for (let i = 0; i < numTables; i += 1) {
      const record = sfntOffset + 12 + i * 16;
      if (record + 16 > buffer.length) break;
      if (buffer.toString("ascii", record, record + 4) !== "name") continue;
      nameOffset = sfntOffset + buffer.readUInt32BE(record + 8);
      nameLength = buffer.readUInt32BE(record + 12);
      break;
    }
    if (nameOffset < 0 || nameOffset + 6 > buffer.length) return null;
    const count = buffer.readUInt16BE(nameOffset + 2);
    const strings = nameOffset + buffer.readUInt16BE(nameOffset + 4);
    const candidates = new Map();
    for (let i = 0; i < count; i += 1) {
      const rec = nameOffset + 6 + i * 12;
      if (rec + 12 > buffer.length) break;
      const platform = buffer.readUInt16BE(rec);
      const language = buffer.readUInt16BE(rec + 4);
      const nameId = buffer.readUInt16BE(rec + 6);
      const length = buffer.readUInt16BE(rec + 8);
      const offset = buffer.readUInt16BE(rec + 10);
      if (![1, 2, 4, 6, 16, 17].includes(nameId)) continue;
      const start = strings + offset, end = start + length;
      if (start < 0 || end > buffer.length || end <= start) continue;
      const value = decodeFontNameString(buffer.subarray(start, end), platform);
      if (!value) continue;
      const score = (language === 0x0409 ? 100 : 0) + (platform === 3 ? 20 : platform === 0 ? 15 : 0);
      const current = candidates.get(nameId);
      if (!current || score > current.score) candidates.set(nameId, { value, score });
    }
    const family = candidates.get(16)?.value || candidates.get(1)?.value || path.basename(filePath, path.extname(filePath)).replace(/[-_]/g, " ");
    const subfamily = candidates.get(17)?.value || candidates.get(2)?.value || "";
    const fullName = candidates.get(4)?.value || [family, subfamily].filter(Boolean).join(" ");
    const postscriptName = candidates.get(6)?.value || "";
    const meta = { family, subfamily, fullName, postscriptName };
    fontMetadataCache.clear();
    fontMetadataCache.set(cacheKey, meta);
    return meta;
  } catch {
    return null;
  }
}

function listFontFiles(root, results, limit = 500) {
  if (!fs.existsSync(root) || results.length >= limit) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (results.length >= limit) break;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) listFontFiles(absolute, results, limit);
    else if (/\.(ttf|otf|ttc)$/i.test(entry.name)) {
      const meta = readFontMetadata(absolute);
      results.push({
        id: absolute,
        family: meta?.family || path.basename(entry.name, path.extname(entry.name)).replace(/[-_]/g, " "),
        fullName: meta?.fullName || "",
        postscriptName: meta?.postscriptName || "",
        subfamily: meta?.subfamily || "",
        path: absolute,
        installed: true,
      });
    }
  }
}

export function localFonts() {
  const fonts = [];
  fontSearchRoots([path.join(supportRoot(), "fonts")]).forEach((root) =>
    listFontFiles(root, fonts),
  );
  return fonts;
}

export function installLocalFont(sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath))
    throw new Error("字体文件已经不存在。");
  const extension = path.extname(sourcePath).toLowerCase();
  if (!/[.](ttf|otf|ttc|woff2)$/.test(extension))
    throw new Error("请选择 TTF、OTF、TTC 或 WOFF2 字体文件。");
  const directory = path.join(supportRoot(), "fonts");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const hash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(sourcePath))
    .digest("hex")
    .slice(0, 10);
  const base =
    path
      .basename(sourcePath, extension)
      .replace(/[^\p{L}\p{N}._ -]+/gu, "-")
      .slice(0, 72) || "font";
  const destination = path.join(directory, `${base}-${hash}${extension}`);
  if (!fs.existsSync(destination)) fs.copyFileSync(sourcePath, destination);
  const meta = readFontMetadata(destination);
  return {
    id: destination,
    family: meta?.family || base.replace(/[-_]/g, " "),
    fullName: meta?.fullName || "",
    postscriptName: meta?.postscriptName || "",
    subfamily: meta?.subfamily || "",
    path: destination,
    installed: true,
    source: "local",
  };
}

function captionPresetsPath() {
  return path.join(supportRoot(), "caption-presets.json");
}

export function customCaptionPresets() {
  try {
    const value = JSON.parse(fs.readFileSync(captionPresetsPath(), "utf8"));
    return Array.isArray(value) ? value.slice(0, 100) : [];
  } catch {
    return [];
  }
}

export function saveCaptionPreset(input = {}) {
  const name =
    String(input.name || "我的字幕样式")
      .trim()
      .slice(0, 40) || "我的字幕样式";
  const style =
    input.style && typeof input.style === "object" ? { ...input.style } : {};
  const values = customCaptionPresets();
  const preset = {
    id: crypto.randomUUID(),
    name,
    style,
    createdAt: new Date().toISOString(),
  };
  values.unshift(preset);
  const temporary = `${captionPresetsPath()}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(values.slice(0, 100), null, 2), {
    mode: 0o600,
  });
  fs.renameSync(temporary, captionPresetsPath());
  return preset;
}

export async function fontCatalog(query = "") {
  const response = await fetch("https://api.fontsource.org/v1/fonts");
  if (!response.ok) throw new Error("暂时无法连接开源字体目录。");
  const data = await response.json();
  const text = String(query || "")
    .trim()
    .toLowerCase();
  return data
    .filter(
      (font) =>
        !text ||
        String(font.family || "")
          .toLowerCase()
          .includes(text) ||
        String(font.id || "").includes(text),
    )
    .slice(0, 120);
}

export async function installFont(fontId) {
  const response = await fetch(
    `https://api.fontsource.org/v1/fonts/${encodeURIComponent(fontId)}`,
  );
  if (!response.ok) throw new Error("无法读取字体文件信息。");
  const metadata = await response.json();
  const weight = metadata.weights?.includes(700)
    ? "700"
    : String(
        metadata.weights?.includes(400) ? 400 : metadata.weights?.[0] || 400,
      );
  const style =
    metadata.variants?.[weight]?.normal ||
    Object.values(metadata.variants?.[weight] || {})[0];
  const subset =
    style?.latin ||
    style?.[metadata.defSubset] ||
    Object.values(style || {})[0];
  const url = subset?.url?.ttf || subset?.url?.woff2;
  if (!url) throw new Error("这款字体没有可用的字体文件。");
  const fontResponse = await fetch(url);
  if (!fontResponse.ok) throw new Error("字体下载失败。");
  const directory = path.join(supportRoot(), "fonts");
  fs.mkdirSync(directory, { recursive: true });
  const extension = url.includes(".ttf") ? ".ttf" : ".woff2";
  const destination = path.join(
    directory,
    `${metadata.id}-${weight}${extension}`,
  );
  fs.writeFileSync(destination, Buffer.from(await fontResponse.arrayBuffer()), {
    mode: 0o600,
  });
  return {
    id: metadata.id,
    family: metadata.family,
    path: destination,
    installed: true,
    weight: Number(weight),
    license: metadata.license || metadata.type || "open-source",
  };
}
