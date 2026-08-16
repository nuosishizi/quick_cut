import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  chooseFile,
  chooseFiles,
  chooseOutput,
  defaultExportPath,
  isWindows,
  openDesktopWindow,
  readClipboard,
  revealFile,
} from "./platform.mjs";
import {
  analyzePauses,
  analyzeWaveform,
  cachedMediaPreview,
  cancelExport,
  createMediaPreviewAsync,
  createProjectCover,
  extractStillFrame,
  exportStatus,
  fontCatalog,
  installFont,
  installLocalFont,
  localFonts,
  customCaptionPresets,
  probeMediaAsync,
  renderDenoisePreview,
  renderDenoisedTrack,
  renderLutPreviewFrame,
  startExport,
  saveCaptionPreset,
  supportRoot,
  detectExportHardware,
} from "./media.mjs";
import {
  cancelModelDownload,
  cancelScriptAnalysis,
  clearGroqApiKey,
  groqKeyStatus,
  modelDownloadStatus,
  modelStatus,
  saveDeepgramApiKey,
  saveGroqApiKey,
  saveSpeechSettings,
  clearDeepgramApiKey,
  scriptAnalysisStatus,
  reviewScriptIssues,
  speechStatus,
  startModelDownload,
  startScriptAnalysis,
} from "./whisper.mjs";
import {
  clearGeminiKey,
  clearVertexSecrets,
  listReviewModels,
  loadReviewSettings,
  saveReviewSettings,
} from "./ai-settings.mjs";
import { blockingScriptureIssues, DEFAULT_REVIEW_PROMPTS } from "./script-judge.mjs";
import { writeResolveTimeline } from "./resolve-export.mjs";
import {
  installResolveLink,
  resolveLinkStatus,
  resolveSendProgress,
  revealResolveLog,
  sendToResolve,
} from "./resolve-link.mjs";
import { mergeRanges, mapSourceTime } from "./pausecut.mjs";
import { buildCaptions, regroupProjectCaptions, spokenCaptionWords } from "./alignment.mjs";
import { captionMatchLineLimit } from "./text-layout.mjs";
import {
  createProject,
  deleteProject,
  exportBackup,
  importBackup,
  listProjects,
  loadProject,
  resetProject,
  clearProjectCache,
  saveProjectSnapshot,
  stageProjectAssetAsync,
  projectStoragePath,
} from "./project-store.mjs";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rawHtml = fs.readFileSync(path.join(currentDir, "ui.html"), "utf8");
const assets = new Map();
let serverPort = 0;
let assetServer = null;
let embeddedHtml = "";
let nativeMethods = null;
let pendingDrops = [];
let dropIntent = { target: "media", time: 0, updatedAt: 0 };
const uploadSecret = crypto.randomUUID();
const mediaAnalysisJobs = new Map();
const mediaAnalysisKeys = new Map();
const mediaAnalysisQueue = [];
let activeMediaAnalyses = 0;

function drainMediaAnalysisQueue() {
  while (activeMediaAnalyses < 1 && mediaAnalysisQueue.length) {
    const entry = mediaAnalysisQueue.shift();
    activeMediaAnalyses += 1;
    Promise.resolve()
      .then(entry.task)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        activeMediaAnalyses -= 1;
        drainMediaAnalysisQueue();
      });
  }
}

function enqueueMediaAnalysis(task) {
  return new Promise((resolve, reject) => {
    mediaAnalysisQueue.push({ task, resolve, reject });
    drainMediaAnalysisQueue();
  });
}

function uploadDirectory() {
  const directory = path.join(supportRoot(), "uploads");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function safe(action) {
  return async (...args) => {
    try {
      return { ok: true, value: await action(...args) };
    } catch (error) {
      console.error(error);
      return {
        ok: false,
        error: {
          message: error?.message || String(error),
          code: error?.code || "ERROR",
        },
      };
    }
  };
}



function saveProjectFile(data, existingPath = "") {
  const destination = existingPath || chooseOutput("快剪工程.zpe", "zpe");
  if (!destination) return null;
  fs.writeFileSync(
    destination,
    JSON.stringify(
      {
        format: "SubtitleProofreaderEditor",
        version: 1,
        savedAt: new Date().toISOString(),
        ...data,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return destination;
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return (
    {
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
      ".m4v": "video/x-m4v",
      ".webm": "video/webm",
      ".m4a": "audio/mp4",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".aac": "audio/aac",
      ".flac": "audio/flac",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".srt": "application/x-subrip",
      ".vtt": "text/vtt",
      ".ass": "text/plain",
      ".ttf": "font/ttf",
      ".otf": "font/otf",
      ".woff2": "font/woff2",
    }[extension] || "application/octet-stream"
  );
}

function registerAsset(filePath) {
  if (!filePath || !fs.existsSync(filePath))
    throw new Error("素材文件已经不存在。");
  const existing = [...assets.entries()].find(
    ([, value]) => value === filePath,
  )?.[0];
  const token = existing || crypto.randomUUID();
  assets.set(token, filePath);
  return {
    token,
    url: `http://127.0.0.1:${serverPort}/asset/${token}`,
    path: filePath,
    name: path.basename(filePath),
  };
}

function mediaAnalysisKey(filePath, kind) {
  const stat = fs.statSync(filePath);
  return `${path.resolve(filePath)}:${stat.size}:${stat.mtimeMs}:${kind}`;
}

function startMediaAnalysis(filePath, kind, initial = {}) {
  if (!filePath || !fs.existsSync(filePath) || !["video", "audio"].includes(kind))
    return "";
  const key = mediaAnalysisKey(filePath, kind);
  const existing = mediaAnalysisKeys.get(key);
  if (existing && mediaAnalysisJobs.has(existing)) return existing;
  const jobId = crypto.randomUUID();
  const job = {
    jobId,
    state: "running",
    progress: 0.03,
    error: "",
    result: null,
  };
  mediaAnalysisJobs.set(jobId, job);
  mediaAnalysisKeys.set(key, jobId);
  enqueueMediaAnalysis(async () => {
      // Metadata probing stays in the single background analysis queue, so
      // importing is immediate while rotation/display dimensions are always
      // refreshed even for projects created by an older QuickCut version.
      const metadata = await probeMediaAsync(filePath);
      job.progress = 0.15;
      const previewPath =
        initial.previewPath && fs.existsSync(initial.previewPath)
          ? initial.previewPath
          : cachedMediaPreview(filePath, kind);
      const generatedPreview = previewPath
        ? previewPath
        : await createMediaPreviewAsync(filePath, kind).catch(() => null);
      job.progress = 0.42;
      job.result = {
        ...metadata,
        waveform: Array.isArray(initial.waveform) ? initial.waveform : [],
        previewPath: generatedPreview || "",
        previewUrl: generatedPreview ? registerAsset(generatedPreview).url : "",
      };
      const existingWaveform = Array.isArray(initial.waveform)
        ? initial.waveform
        : [];
      const waveform = existingWaveform.length
        ? existingWaveform
        : await analyzeWaveform(
            filePath,
            Math.max(
              2400,
              Math.min(
                24000,
                Math.ceil(Number(metadata.duration || 0) * 80),
              ),
            ),
          ).catch(() => []);
      job.progress = 1;
      job.state = "completed";
      job.result = {
        ...metadata,
        waveform,
        previewPath: generatedPreview || "",
        previewUrl: generatedPreview ? registerAsset(generatedPreview).url : "",
      };
    })
    .catch((error) => {
      job.state = "failed";
      job.error = error?.message || String(error);
    });
  while (mediaAnalysisJobs.size > 128) {
    const oldest = mediaAnalysisJobs.keys().next().value;
    if (!oldest || mediaAnalysisJobs.get(oldest)?.state === "running") break;
    mediaAnalysisJobs.delete(oldest);
  }
  return jobId;
}

function mediaAnalysisStatus(jobId) {
  const job = mediaAnalysisJobs.get(String(jobId || ""));
  if (!job) throw new Error("素材后台分析任务不存在或已经过期。");
  return { ...job };
}

function startAssetServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      if (
        request.method === "PUT" &&
        requestUrl.pathname === `/upload/${uploadSecret}`
      ) {
        const suppliedName = String(
          requestUrl.searchParams.get("name") || "asset",
        );
        const extension = path.extname(suppliedName).slice(0, 12);
        const base =
          path
            .basename(suppliedName, extension)
            .replace(/[^\p{L}\p{N}._ -]+/gu, "-")
            .slice(0, 80) || "asset";
        const destination = path.join(
          uploadDirectory(),
          `${base}-${crypto.randomUUID().slice(0, 10)}${extension}`,
        );
        const output = fs.createWriteStream(destination, { mode: 0o600 });
        let size = 0;
        let stopped = false;
        request.on("data", (chunk) => {
          size += chunk.length;
          if (size > 20 * 1024 * 1024 * 1024) {
            stopped = true;
            request.destroy();
            output.destroy();
            try {
              fs.unlinkSync(destination);
            } catch {}
          }
        });
        request.on("error", () => {
          try {
            output.destroy();
            fs.unlinkSync(destination);
          } catch {}
        });
        output.on("error", () => {
          if (!response.headersSent) {
            response.writeHead(500);
            response.end("upload failed");
          }
        });
        output.on("finish", () => {
          if (stopped) return;
          response.setHeader("Content-Type", "application/json");
          response.writeHead(200);
          response.end(
            JSON.stringify({ path: destination, name: suppliedName, size }),
          );
        });
        request.pipe(output);
        return;
      }
      if (request.method === "GET" && (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html")) {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.writeHead(200);
        response.end(embeddedHtml || "<html><body>编辑器正在启动…</body></html>");
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/health") {
        response.setHeader("Content-Type", "application/json");
        response.writeHead(200);
        response.end(JSON.stringify({ ok: true, port: serverPort, version: "2.7.22" }));
        return;
      }
      if (request.method === "POST" && requestUrl.pathname.startsWith("/rpc/")) {
        const name = decodeURIComponent(requestUrl.pathname.slice(5));
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
          if (body.length > 16 * 1024 * 1024) request.destroy();
        });
        request.on("end", async () => {
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          try {
            const args = body ? JSON.parse(body) : [];
            const fn = nativeMethods?.[name];
            if (typeof fn !== "function") throw new Error(`本机功能 ${name} 未加载`);
            const value = await fn(...(Array.isArray(args) ? args : []));
            response.writeHead(200);
            response.end(JSON.stringify(value));
          } catch (error) {
            response.writeHead(500);
            response.end(JSON.stringify({ ok: false, error: { message: error?.message || String(error), code: error?.code || "RPC_ERROR" } }));
          }
        });
        return;
      }
      const match = request.url?.match(/^\/asset\/([a-f0-9-]+)/i);
      const filePath = match ? assets.get(match[1]) : null;
      if (!filePath || !fs.existsSync(filePath)) {
        response.writeHead(404);
        response.end();
        return;
      }
      const stat = fs.statSync(filePath);
      const range = request.headers.range;
      response.setHeader("Content-Type", mimeType(filePath));
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader("Cache-Control", "no-store");
      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = Number(parts[0] || 0);
        const end = Math.min(stat.size - 1, Number(parts[1] || stat.size - 1));
        response.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Content-Length": end - start + 1,
        });
        fs.createReadStream(filePath, { start, end }).pipe(response);
      } else {
        response.writeHead(200, { "Content-Length": stat.size });
        fs.createReadStream(filePath).pipe(response);
      }
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      serverPort = server.address().port;
      resolve(server);
    });
  });
}

assetServer = await startAssetServer();

const iconPath = path.resolve(currentDir, "../assets/QuickCutIcon-1024.png");
const iconUrl = fs.existsSync(iconPath) ? registerAsset(iconPath).url : "";
const filterPreviewPath = path.resolve(
  currentDir,
  "../assets/filter-preview-portrait.jpg",
);
const filterPreviewUrl = fs.existsSync(filterPreviewPath)
  ? registerAsset(filterPreviewPath).url
  : "";
const bridgeScript = `<script>
(() => {
  const rpc = async (name, args) => {
    const response = await fetch('/rpc/' + encodeURIComponent(String(name)), {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(args || [])
    });
    const data = await response.json().catch(() => ({ok:false,error:{message:'本机功能返回无效数据'}}));
    if (!response.ok && data?.ok !== false) return {ok:false,error:{message:'本机功能调用失败'}};
    return data;
  };
  window.native = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return undefined;
      return (...args) => rpc(prop, args);
    }
  });
  if (${isWindows ? "true" : "false"}) {
    document.documentElement.dataset.platform = 'windows';
    const retitle = () => {
      document.querySelectorAll('[title]').forEach((el) => {
        el.title = String(el.title || '')
          .replaceAll('⇧⌘', 'Ctrl+Shift+')
          .replaceAll('⌘', 'Ctrl+');
      });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', retitle);
    else retitle();
  }
})();
</script>`;
embeddedHtml = rawHtml
  .replaceAll("__QUICKCUT_ICON__", iconUrl)
  .replaceAll("__QUICKCUT_FILTER_PREVIEW__", filterPreviewUrl)
  .replace("</head>", bridgeScript + "</head>");

async function importedAsset(projectId, selected, kind) {
  if (!selected) return null;
  const uploaded = selected.startsWith(`${uploadDirectory()}${path.sep}`);
  try {
    const applicationGenerated = selected.startsWith(`${supportRoot()}${path.sep}`);
    const managed = uploaded || applicationGenerated;
    const staged = projectId && managed
      ? await stageProjectAssetAsync(projectId, selected)
      : selected;
    if (kind === "video" || kind === "audio") {
      const previewPath = cachedMediaPreview(staged, kind);
      const asset = {
        kind,
        ...registerAsset(staged),
        originalPath: managed ? "" : selected,
        linked: !managed,
        managed,
        previewPath: previewPath || "",
        previewUrl: previewPath ? registerAsset(previewPath).url : "",
        waveform: [],
        analysisPending: true,
      };
      asset.analysisJobId = startMediaAnalysis(staged, kind, asset);
      return asset;
    }
    if (kind === "subtitle")
      return {
        kind,
        ...registerAsset(staged),
        originalPath: managed ? "" : selected,
        linked: !managed,
        managed,
        content: fs.readFileSync(staged, "utf8"),
      };
    const asset = {
      kind,
      ...registerAsset(staged),
      originalPath: managed ? "" : selected,
      linked: !managed,
      managed,
    };
    return kind === "image" ? { ...asset, previewUrl: asset.url } : asset;
  } finally {
    if (uploaded)
      try {
        fs.unlinkSync(selected);
      } catch {}
  }
}

function rehydrateMedia(
  item,
  kind,
  analyzeMissing = true,
  requireWaveform = false,
) {
  const sourcePath = item?.originalPath || item?.path;
  if (!sourcePath || !fs.existsSync(sourcePath))
    return item
      ? { ...item, missing: true, url: "", previewUrl: "", previewPath: "" }
      : item;
  if (sourcePath !== item.path) item = { ...item, path: sourcePath };
  const registered = registerAsset(item.path);
  if (kind === "video" || kind === "audio") {
    const previewPath =
      item.previewPath && fs.existsSync(item.previewPath)
        ? item.previewPath
        : cachedMediaPreview(item.path, kind);
    const hydrated = {
      ...item,
      ...registered,
      previewPath: previewPath || "",
      previewUrl: previewPath ? registerAsset(previewPath).url : "",
    };
    if (
      analyzeMissing &&
      (!Number(hydrated.duration || 0) ||
        !previewPath ||
        (requireWaveform &&
          (!Array.isArray(hydrated.waveform) || !hydrated.waveform.length)))
    )
      hydrated.analysisJobId = startMediaAnalysis(item.path, kind, hydrated);
    return hydrated;
  }
  if (kind === "subtitle")
    return {
      ...item,
      ...registered,
      content: fs.readFileSync(item.path, "utf8"),
    };
  return {
    ...item,
    ...registered,
    previewUrl: kind === "image" ? registered.url : item.previewUrl,
  };
}

function loadProjectForUi(id) {
  const value = loadProject(id);
  const data = {
    ...(value.data || {}),
    projectId: value.id,
    projectName: value.name,
  };
  if (data.video?.path)
    data.video = rehydrateMedia(
      {
        ...data.video,
        waveform:
          Array.isArray(data.video.waveform) && data.video.waveform.length
            ? data.video.waveform
            : data.waveform || [],
      },
      "video",
      true,
      true,
    );
  if (data.denoisedAudio?.path)
    data.denoisedAudio = rehydrateMedia(data.denoisedAudio, "audio", false);
  data.videoLayers = (data.videoLayers || []).map((item) =>
    rehydrateMedia(item, "video", false),
  );
  data.images = (data.images || []).map((item) =>
    rehydrateMedia(item, "image"),
  );
  data.audioAssets = (data.audioAssets || []).map((item) =>
    rehydrateMedia(item, "audio", false),
  );
  data.libraryAssets = (data.libraryAssets || []).map((item) =>
    rehydrateMedia(item, item?.kind, false),
  );
  return { ...value, data };
}


const smartFinishAnalyses = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForScriptAnalysis(jobId) {
  while (true) {
    const status = scriptAnalysisStatus(jobId);
    if (status.state === "completed") return status.result;
    if (["failed", "cancelled"].includes(status.state))
      throw new Error(status.error || "文案匹配失败。");
    await sleep(260);
  }
}

// Manuscript-first captioning: the pasted manuscript is authoritative; ASR supplies timing/evidence.
function finalCaptionWords(operations = [], removals = []) {
  return (operations || []).flatMap((operation) => {
    if (!operation?.spoken || operation.action === "cut" || operation.type === "repeat-cut") return [];
    const spoken = {
      ...operation.spoken,
      start: mapSourceTime(Number(operation.spoken.start || 0), removals),
      end: mapSourceTime(Number(operation.spoken.end || 0), removals),
    };
    spoken.end = Math.max(spoken.start + 0.04, spoken.end);
    const isAddition = operation.type === "filler" || operation.issueType === "addition";
    const isParaphrase = operation.issueType === "semantic";
    // The manuscript is the subtitle authority whenever an expected token is aligned.
    // This deliberately covers uncertain ASR substitutions such as Study→stuff:
    // uncertainty must not replace a manuscript word with a weaker ASR guess.
    if (operation.expected && operation.action !== "cut" && !isParaphrase && !isAddition) {
      return [{
        ...spoken,
        display: operation.expected.display,
        norm: operation.expected.norm,
        keepWithPrevious: !!operation.expected.keepWithPrevious || !!spoken.keepWithPrevious,
        scriptureReference: !!operation.expected.scriptureReference || !!spoken.scriptureReference,
      }];
    }
    // Genuine paraphrases / harmless additions are outside the exact manuscript wording,
    // so preserved audio receives the actually spoken subtitle. Every kept audible token
    // still has a caption.
    if (operation.action !== "cut" && (isAddition || isParaphrase || !operation.expected)) return [spoken];
    if (operation.expected && operation.action !== "cut") return [{ ...spoken, display: operation.expected.display, norm: operation.expected.norm }];
    return [];
  });
}

function removeImmediateFalseStarts(aligned) {
  const operations = aligned?.operations || [];
  const issues = aligned?.issues || (aligned.issues = []);
  const live = operations
    .map((op, index) => ({ op, index }))
    .filter(({ op }) => op?.spoken && op.action !== "cut" && op.type !== "repeat-cut");
  const fillers = new Set(["uh", "um", "erm", "er", "ah", "hmm"]);
  const normAt = (entry) => String(entry?.op?.spoken?.norm || "");
  const expectedCount = (group) => group.filter(({ op }) => !!op.expected).length;
  const sameSequence = (a, b) => a.length === b.length && a.every((entry, i) => normAt(entry) && normAt(entry) === normAt(b[i]));
  const shortGap = (a, b) => {
    const end = Number(a.at(-1)?.op?.spoken?.end || 0);
    const start = Number(b[0]?.op?.spoken?.start || end);
    return start - end <= 0.9;
  };
  const markEarlier = (earlier, later) => {
    if (!earlier.length || !later.length) return false;
    // Two separately manuscript-backed copies may be intentional repetition.
    if (expectedCount(earlier) === earlier.length && expectedCount(later) === later.length) return false;
    const expectedSource = earlier.map(({ op }) => op.expected).filter(Boolean);
    if (expectedSource.length === earlier.length && expectedCount(later) === 0) {
      for (let i = 0; i < later.length; i += 1) {
        later[i].op.expected = { ...expectedSource[i] };
        later[i].op.type = "match";
        later[i].op.relation = "match";
        later[i].op.action = "";
        later[i].op.issueType = "";
        later[i].op.issueId = "";
      }
    }
    const start = Number(earlier[0].op.spoken.start || 0);
    const end = Number(earlier.at(-1).op.spoken.end || start + 0.04);
    const id = crypto.randomUUID();
    for (const { op } of earlier) {
      op.type = "repeat-cut";
      op.action = "cut";
      op.issueType = "repeat";
      op.issueId = id;
    }
    issues.push({
      id, type: "repeat", label: "重复阅读",
      spokenText: earlier.map(({ op }) => op.spoken?.display || op.spoken?.text || op.spoken?.norm || "").join(" ").trim(),
      expectedText: later.map(({ op }) => op.expected?.display || op.spoken?.display || op.spoken?.norm || "").join(" ").trim(),
      start, end: Math.max(start + 0.04, end), suggested: true, severity: "high", strict: false,
      confirmedCut: true, confirmedError: false, repeatKeepLater: true,
      earlierOperationIndexes: earlier.map(({ index }) => index), laterOperationIndexes: later.map(({ index }) => index),
      falseStartDetected: true,
    });
    return true;
  };

  // Immediate restart: "we need / we need", "truth that / truth that".
  // Longest phrase wins so multi-word restarts are removed as one clean cut.
  for (let pos = 0; pos < live.length; pos += 1) {
    if (live[pos].op.action === "cut") continue;
    let handled = false;
    for (let n = Math.min(18, Math.floor((live.length - pos) / 2)); n >= 1; n -= 1) {
      const earlier = live.slice(pos, pos + n);
      const later = live.slice(pos + n, pos + 2 * n);
      if (earlier.some(({ op }) => op.action === "cut") || later.some(({ op }) => op.action === "cut")) continue;
      if (!sameSequence(earlier, later) || !shortGap(earlier, later)) continue;
      const totalSpan = Number(later.at(-1).op.spoken.end || 0) - Number(earlier[0].op.spoken.start || 0);
      if (totalSpan > 12.0) continue;
      if (markEarlier(earlier, later)) { handled = true; break; }
    }
    if (handled) continue;

    // Prefix restart: the speaker begins a sentence, stops, then restarts with the
    // corrected/extended sentence. Example:
    // "rest is biblical and health boundaries" ->
    // "rest is biblical and healthy boundaries are important".
    // Also "we're treating it" -> "we're treating as ordinary...".
    // This is not an exact duplicate, so compare the longest earlier prefix against
    // the start of the later take and cut only the abandoned first take.
    const tokenNear = (a, b) => {
      if (!a || !b) return false;
      if (a === b) return true;
      const short = a.length <= b.length ? a : b, long = a.length <= b.length ? b : a;
      return short.length >= 4 && long.startsWith(short) && long.length - short.length <= 3;
    };
    for (let n = Math.min(14, live.length - pos - 2); n >= 2 && !handled; n -= 1) {
      const earlier = live.slice(pos, pos + n);
      if (earlier.some(({op}) => op.action === "cut")) continue;
      const earlierEnd = Number(earlier.at(-1)?.op?.spoken?.end || 0);
      for (let restart = pos + n; restart <= Math.min(live.length - n, pos + n + 3); restart += 1) {
        const later = live.slice(restart, restart + n);
        if (later.length !== n || later.some(({op}) => op.action === "cut")) continue;
        const laterStart = Number(later[0]?.op?.spoken?.start || earlierEnd);
        if (laterStart - earlierEnd > 1.6) break;
        const nearPrefix = earlier.every((entry, i) => tokenNear(normAt(entry), normAt(later[i])));
        if (!nearPrefix) continue;
        if (markEarlier(earlier, later)) { handled = true; break; }
      }
    }
    if (!handled) {
      for (let n = Math.min(8, live.length - pos - 2); n >= 2 && !handled; n -= 1) {
        const earlier = live.slice(pos, pos + n);
        const later = live.slice(pos + n, pos + n + 2);
        if (earlier.length < 2 || later.length < 2) continue;
        if (earlier.some(({ op }) => op.action === "cut") || later.some(({ op }) => op.action === "cut"))
          continue;
        const earlierEnd = Number(earlier.at(-1)?.op?.spoken?.end || 0);
        const laterStart = Number(later[0]?.op?.spoken?.start || earlierEnd);
        if (laterStart - earlierEnd > 2.4) continue;
        if (
          tokenNear(normAt(earlier[0]), normAt(later[0])) &&
          tokenNear(normAt(earlier[1]), normAt(later[1]))
        )
          handled = markEarlier(earlier, later);
      }
    }
    if (handled) continue;
    // Hesitation restart: "word uh word". Only a real filler may be between them.
    if (pos + 2 < live.length) {
      const a = live[pos], middle = live[pos + 1], b = live[pos + 2];
      if (a.op.action !== "cut" && b.op.action !== "cut" && normAt(a) === normAt(b) && fillers.has(normAt(middle))) {
        const gap = Number(b.op.spoken.start || 0) - Number(a.op.spoken.end || 0);
        if (gap <= 1.2 && markEarlier([a], [b])) {
          middle.op.type = "filler";
          middle.op.action = "insert";
        }
      }
    }
  }
  return aligned;
}


function preferLaterCorrectedRepeats(aligned) {
  const operations = aligned?.operations || [];
  for (const issue of aligned?.issues || []) {
    if (issue?.type !== "repeat" || !issue.repeatKeepLater) continue;
    const earlier = Array.isArray(issue.earlierOperationIndexes) ? issue.earlierOperationIndexes : [];
    const later = Array.isArray(issue.laterOperationIndexes) ? issue.laterOperationIndexes : [];
    if (!earlier.length || earlier.length !== later.length) continue;
    for (let index = 0; index < later.length; index += 1) {
      const oldOp = operations[earlier[index]], newOp = operations[later[index]];
      if (!oldOp?.expected || !newOp?.spoken) continue;
      newOp.expected = { ...oldOp.expected };
      newOp.type = "match"; newOp.relation = "match"; newOp.action = ""; newOp.issueType = ""; newOp.issueId = "";
      oldOp.type = "repeat-cut"; oldOp.action = "cut"; oldOp.issueType = "repeat"; oldOp.issueId = issue.id;
    }
  }
  return aligned;
}

function strictBlockingIssues(aligned) {
  return (aligned?.issues || []).filter((issue) =>
    issue?.strict && issue?.confirmedError === true && ["missing", "mismatch"].includes(String(issue.type || ""))
  );
}

async function smartFinishAnalyze(input = {}) {
  const inputPath = String(input.inputPath || "");
  const script = String(input.script || "").trim();
  if (!inputPath || !fs.existsSync(inputPath)) throw new Error("找不到需要处理的视频。");
  if (!script) throw new Error("请先粘贴正确文案。");
  if (!modelStatus().ready)
    throw new Error("一键成片需要 Groq API Key。请先在字幕页保存 Key，没有独立显卡时不用下载本地模型。");

  const info = await probeMediaAsync(inputPath);
  const duration = Number(info.duration || 0);
  if (!(duration > 0)) throw new Error("无法读取视频时长。");

  // User-defined rule: opening/ending voice margin 0.1s; internal pauses keep 0.5s total.
  // analyzePauseFrames removes the centre of a long pause and leaves half the keep
  // duration on each side, so speech boundaries are never cut flush.
  const pauseAnalysis = await analyzePauses(inputPath, {
    keepSeconds: 0.5,
    edgeKeepSeconds: 0.1,
    sensitivity: 0.42,
  });
  const pauseRemovals = mergeRanges(pauseAnalysis.removals || [], duration);

  // Align on source time first.  This lets us remove spoken mistakes before a
  // final timebase is computed, avoiding inverse-timeline ambiguity.
  const started = startScriptAnalysis({
    inputPath,
    duration,
    script,
    removals: [],
    captionLines: input.captionLines,
  });
  let aligned = await waitForScriptAnalysis(started.jobId);
  aligned = preferLaterCorrectedRepeats(aligned);
  aligned = removeImmediateFalseStarts(aligned);

  // 双保险停顿：ASR 时间戳只用于补抓声学检测漏掉的“明显长空档”。
  // 为避免误剪低声词，只处理 >0.62s 的空档，仍然从中间裁，最终保留 0.5s。
  const spokenForGaps = (aligned.operations || []).map((op) => op?.spoken).filter(Boolean)
    .sort((a,b) => Number(a.start||0) - Number(b.start||0));
  const transcriptGapRemovals = [];
  for (let i = 1; i < spokenForGaps.length; i += 1) {
    const left = Number(spokenForGaps[i-1].end || 0), right = Number(spokenForGaps[i].start || left);
    const gap = right - left;
    if (gap > 0.62) transcriptGapRemovals.push({
      start: left + 0.25, end: right - 0.25, duration: Math.max(0, gap - 0.5), source: "pause-transcript-fallback"
    });
  }
  const blockingIssues = strictBlockingIssues(aligned);

  // Preserve harmless fillers, acceptable additions and semantic paraphrases.
  // Only true reading errors, repeats and unrelated extra speech are removed.
  const cuttableTypes = new Set(["extra", "repeat"]);
  const issueRemovals = (aligned.issues || [])
    .filter((issue) => cuttableTypes.has(String(issue.type || "")) && issue.confirmedCut === true)
    .map((issue) => ({
      start: Math.max(0, Number(issue.start || 0)),
      end: Math.min(duration, Math.max(Number(issue.start || 0) + 0.04, Number(issue.end || 0))),
      duration: Math.max(0.04, Number(issue.end || 0) - Number(issue.start || 0)),
      source: `script-${issue.type}`,
      issueId: issue.id,
    }));
  const removals = mergeRanges([...pauseRemovals, ...transcriptGapRemovals, ...issueRemovals], duration);
  const outputDuration = Math.max(0.04, mapSourceTime(duration, removals));
  const words = finalCaptionWords(aligned.operations || [], removals);
  const sourceFps = Math.max(24, Math.min(60, Number(info.frameRate || 30)));
  const captionEndLimit = Math.max(0.04, outputDuration - 1 / sourceFps);
  const captions = buildCaptions(words, {
    maxWords: 10,
    maxChars: 34,
    maxLines: captionMatchLineLimit(input.captionLines),
  })
    .filter((caption) => caption.start < captionEndLimit)
    .map((caption) => ({
      ...caption,
      end: Math.min(captionEndLimit, Math.max(caption.start + Math.min(0.18, Math.max(0.04, captionEndLimit - caption.start)), caption.end)),
    }))
    .filter((caption) => caption.end > caption.start + 0.02);

  const counts = (aligned.issues || []).reduce((acc, issue) => {
    const type = String(issue.type || "unknown");
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});
  const token = crypto.randomUUID();
  const record = {
    token,
    createdAt: Date.now(),
    inputPath,
    script,
    info,
    duration,
    removals,
    captions,
    issues: aligned.issues || [],
    outputDuration,
    transcript: aligned.transcript || "",
    counts,
  };
  smartFinishAnalyses.set(token, record);
  while (smartFinishAnalyses.size > 6) {
    const oldest = smartFinishAnalyses.keys().next().value;
    smartFinishAnalyses.delete(oldest);
  }

  const removedSeconds = removals.reduce((sum, range) => sum + Math.max(0, range.end - range.start), 0);
  const cutIssues = (aligned.issues || []).filter((issue) => cuttableTypes.has(String(issue.type || "")) && issue.confirmedCut === true).length;
  const missing = Number(counts.missing || 0);
  const keptAdditions = (aligned.issues || []).filter((issue) => ["addition", "semantic"].includes(String(issue.type || ""))).length;
  const manuscriptRecovered = (aligned.operations || []).filter((operation) => operation?.manuscriptRecovered).length;
  const summaryText = [
    `停顿/错误共剪掉 ${removedSeconds.toFixed(1)} 秒，${removals.length} 段`,
    `自动删除 ${cutIssues} 处读错、无效重读或完全不匹配人声`,
    manuscriptRecovered ? `按正确文案修复 ${manuscriptRecovered} 处 ASR 漏识别/近音识别并生成正确字幕` : "正确文案与人声对齐稳定",
    keptAdditions ? `保留 ${keptAdditions} 处不改变原意的口语/同义表达并生成字幕` : "没有额外语义内容需要保留",
    `生成 ${captions.length} 条最终字幕`,
    blockingIssues.length ? `严格经文校验发现 ${blockingIssues.length} 处有明确错误证据，已禁止继续导出` : (missing ? `普通内容仍有 ${missing} 处没有可靠对应人声，已提示但不会伪造声音` : "严格校验通过"),
  ].join(" · ");
  const blockingText = blockingIssues.map((issue, index) =>
    `${index + 1}. ${issue.label || issue.type}：应为「${issue.expectedText || "—"}」，识别为「${issue.spokenText || "—"}」`
  ).join("\n");

  return {
    token,
    duration,
    outputDuration,
    removalCount: removals.length,
    removedSeconds,
    cutIssueCount: cutIssues,
    missingCount: missing,
    captionCount: captions.length,
    previewText: captions[0]?.text || "",
    blocked: blockingIssues.length > 0,
    blockingCount: blockingIssues.length,
    blockingText,
    summaryText,
  };
}


function inverseOutputTime(outputTime, removals = []) {
  let source = Math.max(0, Number(outputTime || 0));
  const sorted = [...(removals || [])].sort((a,b) => Number(a.start||0) - Number(b.start||0));
  let removedBefore = 0;
  for (const range of sorted) {
    const start = Number(range.start || 0), end = Number(range.end || start);
    const outputStart = start - removedBefore;
    if (source < outputStart) break;
    const duration = Math.max(0, end - start);
    source += duration;
    removedBefore += duration;
  }
  return source;
}


function normalizeReviewPhrase(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function plannedCaptionHasExpected(record, expectedText) {
  const expected = normalizeReviewPhrase(expectedText);
  if (!expected || expected.length < 2) return false;
  const planned = normalizeReviewPhrase((record?.captions || []).map((caption) => caption.text || "").join(" "));
  if (!planned) return false;
  if (planned.includes(expected)) return true;
  const expectedWords = expected.split(" ").filter(Boolean);
  const plannedWords = planned.split(" ").filter(Boolean);
  if (!expectedWords.length || !plannedWords.length) return false;
  // Manuscript is authoritative. A second ASR pass is only an auditor, never proof by itself.
  // Compare ordered token windows rather than isolated word presence, which prevents a correct
  // sentence from being marked red because the verifier heard one word differently.
  let cursor = 0, hits = 0;
  for (const word of expectedWords) {
    let found = -1;
    for (let i = cursor; i < Math.min(plannedWords.length, cursor + 18); i += 1) {
      if (plannedWords[i] === word) { found = i; break; }
    }
    if (found >= 0) { hits += 1; cursor = found + 1; }
  }
  const ratio = hits / expectedWords.length;
  return ratio >= (expectedWords.length <= 3 ? 1 : 0.82);
}

function issueHasIndependentRedEvidence(issue) {
  const type = String(issue?.type || "");
  if (type === "repeat") return issue?.confirmedCut === true || issue?.falseStartDetected === true;
  if (type === "extra") return issue?.confirmedCut === true && issue?.confirmedError === true;
  if (type === "mismatch") return issue?.confirmedCut === true && issue?.confirmedError === true;
  // "missing" can be caused by verifier ASR omission and cannot be a destructive red signal alone.
  return false;
}

function reviewSeverity(issue) {
  const type = String(issue?.type || "");
  if (type === "addition" || type === "semantic" || type === "near") return "green";
  if (issueHasIndependentRedEvidence(issue)) return "red";
  if (["missing", "mismatch", "extra"].includes(type)) return "green";
  return "";
}

function reviewReason(issue, severity) {
  const type = String(issue?.type || "");
  if (severity === "green") {
    if (type === "addition") return "正确文案之外的口语/补充表达，语义未改变，可保留。";
    if (type === "semantic") return "说法与正确文案不同，但语义一致，可保留。";
    if (type === "extra") return "额外表达未达到错误剪除置信度，作为绿色差异供人工确认。";
    return "与正确文案存在表述差异，但没有足够证据判定为错误。";
  }
  if (type === "repeat") return "最终成品仍检测到重复/重读，应剪除前一次错误时间段。";
  if (type === "missing") return "正确文案中的内容在最终成品里没有可靠对应人声/字幕。";
  if (type === "mismatch") return "最终成品仍存在与正确文案意思不匹配的读错/错词。";
  if (type === "extra") return "最终成品仍残留与上下文无关的额外内容。";
  return "最终成品存在需要人工处理的不匹配内容。";
}

async function smartFinishReviewExport(input = {}) {
  const token = String(input.token || "");
  const record = smartFinishAnalyses.get(token);
  if (!record) throw new Error("原始一键成片分析结果已经过期，请重新生成。");
  const outputPath = String(input.outputPath || "");
  if (!outputPath || !fs.existsSync(outputPath)) throw new Error("找不到已经导出的成品视频。");

  const info = await probeMediaAsync(outputPath);
  const duration = Number(info.duration || 0);
  if (!(duration > 0)) throw new Error("无法读取成品视频时长。");

  // 第二道防护必须重新听“最终成品”，而不是只复用第一次分析结果。
  const started = startScriptAnalysis({ inputPath: outputPath, duration, script: record.script, removals: [] });
  let aligned = await waitForScriptAnalysis(started.jobId);
  aligned = preferLaterCorrectedRepeats(aligned);
  aligned = removeImmediateFalseStarts(aligned);

  const items = (aligned.issues || []).map((issue) => {
    const expectedText = String(issue.expectedText || "").replace(/^\s*[—-]\s*$/, "").trim();
    // A second ASR pass can miss a correctly spoken word/sentence. If the first-pass final
    // caption plan actually contains the manuscript text, ASR "missing" alone is not enough
    // evidence to call it a red final-video error.
    const plannedHasExpected = plannedCaptionHasExpected(record, expectedText);
    if (String(issue.type || "") === "missing" && plannedHasExpected) return null;
    let severity = reviewSeverity(issue);
    // Never let one verifier ASR contradiction override a manuscript-backed first-pass caption plan.
    if (plannedHasExpected && severity === "red" && !issueHasIndependentRedEvidence(issue)) severity = "green";
    if (!severity) return null;
    const spokenText = String(issue.spokenText || "").replace(/^\s*[—-]\s*$/, "").trim();
    return {
      id: String(issue.id || crypto.randomUUID()),
      severity,
      type: String(issue.type || ""),
      start: Math.max(0, Number(issue.start || 0)),
      end: Math.min(duration, Math.max(Number(issue.start || 0) + 0.04, Number(issue.end || 0))),
      expectedText,
      spokenText,
      displayText: spokenText || expectedText || "待处理",
      reason: reviewReason(issue, severity),
      confirmedCut: issue.confirmedCut === true,
      confirmedError: issue.confirmedError === true,
    };
  }).filter(Boolean);

  // 只显示不匹配项；完全匹配项不进入列表。
  items.sort((a,b) => a.start - b.start || (a.severity === "red" ? -1 : 1));
  return {
    items,
    redCount: items.filter((item) => item.severity === "red").length,
    greenCount: items.filter((item) => item.severity === "green").length,
    duration,
  };
}

function smartFinishStartReviewedExport(input = {}) {
  const token = String(input.token || "");
  const record = smartFinishAnalyses.get(token);
  if (!record) throw new Error("原始一键成片分析结果已经过期，请重新生成。");
  const outputPath = String(input.outputPath || "");
  if (!outputPath) throw new Error("请选择复检修正版导出位置。");

  const oldDuration = Math.max(0.04, Number(record.outputDuration || 0.04));
  const reviewCuts = mergeRanges((Array.isArray(input.cuts) ? input.cuts : []).map((range) => ({
    start: Math.max(0, Number(range.start || 0)),
    end: Math.min(oldDuration, Math.max(Number(range.start || 0) + 0.04, Number(range.end || 0))),
    source: "post-review",
  })), oldDuration);

  // 二次剪辑时间来自“第一次成品时间轴”，转换回原素材时间轴后再与第一次 removals 合并。
  const sourceCuts = reviewCuts.map((range) => ({
    start: inverseOutputTime(range.start, record.removals),
    end: inverseOutputTime(range.end, record.removals),
    source: "post-review",
  }));
  const removals = mergeRanges([...(record.removals || []), ...sourceCuts], Number(record.duration || 0));

  const edits = Array.isArray(input.edits) ? input.edits : [];
  const editForCaption = (caption) => {
    const center = (Number(caption.start || 0) + Number(caption.end || 0)) / 2;
    let best = null;
    for (const edit of edits) {
      const start = Number(edit.start || 0), end = Number(edit.end || start);
      if (center >= start - 0.12 && center <= end + 0.12) best = edit;
    }
    return best;
  };
  const insideCut = (caption) => {
    const center = (Number(caption.start || 0) + Number(caption.end || 0)) / 2;
    return reviewCuts.some((range) => center >= range.start && center <= range.end);
  };

  const adjustedCaptions = (record.captions || [])
    .filter((caption) => !insideCut(caption))
    .map((caption) => {
      const edit = editForCaption(caption);
      const start = mapSourceTime(Number(caption.start || 0), reviewCuts);
      const end = mapSourceTime(Number(caption.end || 0), reviewCuts);
      return {
        ...caption,
        text: edit && String(edit.text || "").trim() ? String(edit.text).trim() : caption.text,
        start,
        end: Math.max(start + 0.04, end),
      };
    });

  const spec = input.renderSpec && typeof input.renderSpec === "object" ? input.renderSpec : {};
  const specStyle = spec.style && typeof spec.style === "object" ? spec.style : {};
  const specCaption = spec.caption && typeof spec.caption === "object" ? spec.caption : {};
  const specVideo = spec.video && typeof spec.video === "object" ? spec.video : {};
  const specLayout = spec.layout && typeof spec.layout === "object" ? spec.layout : {};
  const specOutput = spec.output && typeof spec.output === "object" ? spec.output : {};
  const style = { ...(input.style && typeof input.style === "object" ? input.style : {}), ...specStyle };
  const captionX = Number(specCaption.x ?? input.captionX ?? 0);
  const captionY = Number(specCaption.y ?? input.captionY ?? 0);
  const captionScale = Math.max(0.2, Math.min(5, Number(specCaption.scale ?? input.captionScale ?? 1)));
  const width = Math.max(320, Number(specOutput.width ?? input.width ?? record.info.displayWidth ?? record.info.width ?? 1080));
  const height = Math.max(320, Number(specOutput.height ?? input.height ?? record.info.displayHeight ?? record.info.height ?? 1920));
  const widthScale = Math.max(0.5, Math.min(2.5, Number(specCaption.widthScale ?? style.captionWidthScale ?? 1)));
  const captions = adjustedCaptions.map((caption) => ({
    ...caption,
    x: captionX,
    y: captionY,
    width: Math.max(160, Math.min(width, width * 0.90 * widthScale)),
    scale: captionScale,
    style,
  }));
  const fps = Math.max(24, Math.min(60, Number(record.info.frameRate || 30)));
  const outputDuration = Math.max(0.04, mapSourceTime(oldDuration, reviewCuts));

  return startExport({
    inputPath: record.inputPath,
    outputPath,
    format: "mp4",
    codec: "h264",
    width, height, fps,
    bitrate: "12M",
    colorSpace: "bt709",
    removals,
    outputDuration,
    captions,
    layoutPolicy: specLayout,
    includeVideo: true,
    includeAudio: true,
    audio: { speed: 1, volume: 1, normalize: false, limiter: true },
    audioProcessingEnabled: false,
    videoTransform: {
      x: 0, y: 0, scale: 1, rotation: 0, opacity: 1,
      ...(input.videoTransform && typeof input.videoTransform === "object" ? input.videoTransform : {}),
      ...specVideo,
    },
    resourceBudget: {
      workerThreads: width * height >= 3840 * 2160 ? 3 : 4,
      filterThreads: width * height >= 3840 * 2160 ? 1 : 2,
      memoryClass: width * height >= 3840 * 2160 ? "4k" : "1080p",
    },
  });
}

function smartFinishStartExport(input = {}) {
  const token = String(input.token || "");
  const record = smartFinishAnalyses.get(token);
  if (!record) throw new Error("一键成片分析结果已经过期，请重新生成。");
  const outputPath = String(input.outputPath || "");
  if (!outputPath) throw new Error("请选择导出位置。");
  const spec = input.renderSpec && typeof input.renderSpec === "object" ? input.renderSpec : {};
  const specStyle = spec.style && typeof spec.style === "object" ? spec.style : {};
  const specCaption = spec.caption && typeof spec.caption === "object" ? spec.caption : {};
  const specVideo = spec.video && typeof spec.video === "object" ? spec.video : {};
  const specLayout = spec.layout && typeof spec.layout === "object" ? spec.layout : {};
  const specOutput = spec.output && typeof spec.output === "object" ? spec.output : {};
  const style = { ...(input.style && typeof input.style === "object" ? input.style : {}), ...specStyle };
  const captionX = Number(specCaption.x ?? input.captionX ?? 0);
  const captionY = Number(specCaption.y ?? input.captionY ?? 0);
  const captionScale = Math.max(0.2, Math.min(5, Number(specCaption.scale ?? input.captionScale ?? 1)));
  const width = Math.max(320, Number(specOutput.width ?? input.width ?? record.info.displayWidth ?? record.info.width ?? 1080));
  const height = Math.max(320, Number(specOutput.height ?? input.height ?? record.info.displayHeight ?? record.info.height ?? 1920));
  const widthScale = Math.max(0.5, Math.min(2.5, Number(specCaption.widthScale ?? style.captionWidthScale ?? 1)));
  const captions = record.captions.map((caption) => ({
    ...caption,
    x: captionX,
    y: captionY,
    width: Math.max(160, Math.min(width, width * 0.90 * widthScale)),
    scale: captionScale,
    style,
  }));
  const fps = Math.max(24, Math.min(60, Number(record.info.frameRate || 30)));
  return startExport({
    inputPath: record.inputPath,
    outputPath,
    format: "mp4",
    codec: "h264",
    width,
    height,
    fps,
    bitrate: "12M",
    colorSpace: "bt709",
    removals: record.removals,
    outputDuration: Math.max(0, Number(record.outputDuration || 0)),
    captions,
    layoutPolicy: specLayout,
    includeVideo: true,
    includeAudio: true,
    audio: { speed: 1, volume: 1, normalize: false, limiter: true },
    audioProcessingEnabled: false,
    videoTransform: {
      x: 0, y: 0, scale: 1, rotation: 0, opacity: 1,
      ...(input.videoTransform && typeof input.videoTransform === "object" ? input.videoTransform : {}),
      ...specVideo,
    },
    // 按输出像素预算线程：4K 时主动降低滤镜并发，把资源留给 UI / AVPlayer。
    resourceBudget: (() => {
      const pixels = width * height;
      if (pixels >= 3840 * 2160) return { workerThreads: 3, filterThreads: 1, memoryClass: "4k" };
      if (pixels >= 1920 * 1080) return { workerThreads: 4, filterThreads: 2, memoryClass: "1080p" };
      return { workerThreads: 4, filterThreads: 2, memoryClass: "light" };
    })(),
    color: {},
    beauty: {},
    optimizeLinearCuts: true,
    denoise: { strength: 0 },
    videoLayers: [],
    images: [],
    titles: [],
    audioAssets: [],
    trackOrder: ["caption", "video"],
    trackDefinitions: {
      video: { kind: "video" },
      caption: { kind: "caption" },
    },
    trackVisibility: { video: true, caption: true },
  });
}

nativeMethods = {
  ping: safe(() => ({
    ready: true,
    version: "2.7.22",
    appName: "快剪 QuickCut",
  })),
  smartFinishAnalyze: safe((input = {}) => smartFinishAnalyze(input)),
  smartFinishReviewExport: safe((input = {}) => smartFinishReviewExport(input)),
  smartFinishStartReviewedExport: safe((input = {}) => smartFinishStartReviewedExport(input)),
  smartFinishStartExport: safe((input = {}) => smartFinishStartExport(input)),
  uploadEndpoint: safe(
    () => `http://127.0.0.1:${serverPort}/upload/${uploadSecret}`,
  ),
  listProjects: safe(() =>
    listProjects().map((record) => ({
      ...record,
      thumbnailUrl:
        record.thumbnailPath && fs.existsSync(record.thumbnailPath)
          ? registerAsset(record.thumbnailPath).url
          : "",
    })),
  ),
  createProject: safe((input) => createProject(input || {})),
  deleteProject: safe((id) => deleteProject(id)),
  resetProject: safe((id) => resetProject(id)),
  clearProjectCache: safe((id) => clearProjectCache(id)),
  loadProject: safe((id) => loadProjectForUi(id)),
  saveProjectSnapshot: safe((input) => saveProjectSnapshot(input || {})),
  refreshProjectCover: safe(async (input = {}) => {
    const destination = path.join(
      projectStoragePath(input.projectId),
      "project-cover.png",
    );
    const output = await createProjectCover({
      inputPath: input.inputPath,
      destination,
      time: input.time,
      projectWidth: input.projectWidth,
      projectHeight: input.projectHeight,
      videoTransform: input.videoTransform,
    });
    return { path: output, ...registerAsset(output) };
  }),
  setDropIntent: safe((input = {}) => {
    const target = ["media", "preview", "timeline"].includes(input.target)
      ? input.target
      : "media";
    dropIntent = {
      target,
      time: Math.max(0, Number(input.time || 0)),
      trackId: String(input.trackId || ""),
      updatedAt: Date.now(),
    };
    return true;
  }),
  mediaAnalysisStatus: safe((jobId) => mediaAnalysisStatus(jobId)),
  pickVideo: safe((input = {}) =>
    importedAsset(input?.projectId, chooseFile("video"), "video"),
  ),
  pickImage: safe((input = {}) =>
    importedAsset(input?.projectId, chooseFile("image"), "image"),
  ),
  pickAudio: safe((input = {}) =>
    importedAsset(input?.projectId, chooseFile("audio"), "audio"),
  ),
  pickSubtitle: safe((input = {}) =>
    importedAsset(input?.projectId, chooseFile("subtitle"), "subtitle"),
  ),
  relinkAsset: safe((input = {}) => {
    const selected = chooseFile(input.kind || "video");
    return selected ? importedAsset(input.projectId, selected, input.kind || "video") : null;
  }),
  assetAvailability: safe((input = []) =>
    [...new Set((input || []).map(String).filter(Boolean))].map((filePath) => ({
      path: filePath,
      exists: fs.existsSync(filePath),
    })),
  ),
  addVideoPath: safe((input) => {
    const value = typeof input === "string" ? { path: input } : input || {};
    return importedAsset(value.projectId, value.path, "video");
  }),
  addImagePath: safe((input) => {
    const value = typeof input === "string" ? { path: input } : input || {};
    return importedAsset(value.projectId, value.path, "image");
  }),
  addAudioPath: safe((input) => {
    const value = typeof input === "string" ? { path: input } : input || {};
    return importedAsset(value.projectId, value.path, "audio");
  }),
  addSubtitlePath: safe((input) => {
    const value = typeof input === "string" ? { path: input } : input || {};
    return importedAsset(value.projectId, value.path, "subtitle");
  }),
  extractStill: safe(async (input = {}) => {
    const destination = chooseOutput("快剪静帧.png", "png");
    if (!destination) return null;
    const stillPath = await extractStillFrame(
      input.path,
      input.time,
      destination,
    );
    const asset = await importedAsset(input.projectId, stillPath, "image");
    return { ...asset, exportedPath: destination };
  }),
  takeDroppedFiles: safe(() => {
    const files = pendingDrops;
    pendingDrops = [];
    const latest =
      Date.now() - dropIntent.updatedAt < 5000
        ? dropIntent
        : { target: "media", time: 0, trackId: "" };
    return files.map((item) => ({
      ...item,
      target: latest.target,
      time: latest.time,
      trackId: latest.trackId || "",
    }));
  }),
  readClipboard: safe(() => readClipboard()),
  analyzePauses: safe((input) =>
    analyzePauses(input.path, input.options || {}),
  ),
  denoisePreview: safe(async (input) =>
    registerAsset(
      await renderDenoisePreview(
        input.path,
        input.time,
        input.mode,
        input.strength,
      ),
    ),
  ),
  applyDenoiseTrack: safe(async (input = {}) => {
    const directory = path.join(projectStoragePath(input.projectId), "media");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const output = path.join(
      directory,
      `denoised-track-${crypto.randomUUID().slice(0, 12)}.m4a`,
    );
    await renderDenoisedTrack(input.path, input.mode, input.strength, output);
    const stat = fs.statSync(output);
    if (!stat.isFile() || stat.size < 256)
      throw new Error("降噪音轨写入工程失败，请重试。");
    const registered = registerAsset(output);
    return {
      id: crypto.randomUUID(),
      kind: "audio",
      path: output,
      name: path.basename(output),
      size: stat.size,
      ...registered,
    };
  }),
  chooseExport: safe((defaultName) => {
    const name = defaultName || "快剪导出.mp4";
    try {
      return { path: chooseOutput(name), autoSaved: false };
    } catch (error) {
      return {
        path: defaultExportPath(name),
        autoSaved: true,
        notice: error?.message || "无法打开系统保存框",
      };
    }
  }),
  chooseResolveExport: safe((defaultName) =>
    chooseOutput(defaultName || "快剪-达芬奇.fcpxml", "fcpxml"),
  ),
  exportResolveTimeline: safe((input) => writeResolveTimeline(input || {})),
  installResolveLink: safe(() => installResolveLink()),
  resolveLinkStatus: safe(() => resolveLinkStatus()),
  resolveSendProgress: safe(() => resolveSendProgress()),
  revealResolveLog: safe(() => {
    const logPath = revealResolveLog();
    revealFile(logPath);
    return logPath;
  }),
  sendToResolve: safe((input) => sendToResolve(input || {})),
  startExport: safe((config) => startExport(config)),
  exportHardware: safe(() => detectExportHardware()),
  exportStatus: safe((jobId) => exportStatus(jobId)),
  cancelExport: safe((jobId) => cancelExport(jobId)),
  modelStatus: safe(() => modelStatus()),
  groqKeyStatus: safe(() => groqKeyStatus()),
  speechSettings: safe(() => speechStatus()),
  saveSpeechSettings: safe((input) => saveSpeechSettings(input || {})),
  saveGroqApiKey: safe((key) => saveGroqApiKey(key)),
  clearGroqApiKey: safe(() => clearGroqApiKey()),
  saveDeepgramApiKey: safe((key) => saveDeepgramApiKey(key)),
  clearDeepgramApiKey: safe(() => clearDeepgramApiKey()),
  startModelDownload: safe(() => startModelDownload()),
  modelDownloadStatus: safe((jobId) => modelDownloadStatus(jobId)),
  cancelModelDownload: safe((jobId) => cancelModelDownload(jobId)),
  startScriptAnalysis: safe((input) => startScriptAnalysis(input)),
  regroupCaptions: safe((input) =>
    regroupProjectCaptions(input?.captions || [], {
      captionLines: input?.captionLines ?? 2,
      boxWidth: input?.boxWidth,
      canvasWidth: input?.canvasWidth || input?.width,
      scale: input?.scale,
      style: input?.style || input?.captionStyle,
      lineChars: input?.lineChars,
      maxChars: input?.maxChars,
    }),
  ),
  scriptAnalysisStatus: safe((jobId) => scriptAnalysisStatus(jobId)),
  cancelScriptAnalysis: safe((jobId) => cancelScriptAnalysis(jobId)),
  reviewScriptIssues: safe((input) => reviewScriptIssues(input || {})),
  reviewSettings: safe(() => listReviewModels()),
  refreshGeminiModels: safe(() => listReviewModels({ refresh: true })),
  saveReviewSettings: safe((input) => saveReviewSettings(input || {})),
  importVertexServiceAccount: safe(() => {
    const selected = chooseFile("project");
    if (!selected) return loadReviewSettings();
    return saveReviewSettings({
      vertexServiceAccountJson: fs.readFileSync(selected, "utf8"),
    });
  }),
  clearGeminiKey: safe(() => clearGeminiKey()),
  clearVertexSecrets: safe(() => clearVertexSecrets()),
  defaultReviewPrompts: safe(() => DEFAULT_REVIEW_PROMPTS),
  blockingScriptureIssues: safe((issues) => blockingScriptureIssues(issues || [])),
  localFonts: safe(() => {
    const localRoot = path.join(supportRoot(), "fonts") + path.sep;
    return localFonts().map((font) => ({
      ...font,
      source: String(font.path || "").startsWith(localRoot) ? "local" : "system",
      ...registerAsset(font.path),
    }));
  }),
  installLocalFont: safe(() => {
    const selected = chooseFile("font");
    if (!selected) return null;
    const font = installLocalFont(selected);
    return { ...font, source: "local", ...registerAsset(font.path) };
  }),
  installLocalFonts: safe(() => {
    const selected = chooseFiles("font");
    if (!selected.length) return [];
    return selected.map((filePath) => {
      const font = installLocalFont(filePath);
      return { ...font, source: "local", ...registerAsset(font.path) };
    });
  }),
  importLut: safe(async (input = {}) => {
    const selected = chooseFile("lut");
    if (!selected) return null;
    const extension = path.extname(selected).toLowerCase();
    if (![".cube", ".3dl", ".dat", ".m3d", ".csp"].includes(extension))
      throw new Error("请选择 .cube、.3dl、.dat、.m3d 或 .csp 格式的 LUT。");
    const staged = await stageProjectAssetAsync(input.projectId, selected);
    return { path: staged, name: path.basename(selected), extension };
  }),
  lutPreview: safe(async (input = {}) =>
    registerAsset(
      await renderLutPreviewFrame(input.path, input.time, input.lutPath),
    ),
  ),
  customCaptionPresets: safe(() => customCaptionPresets()),
  saveCaptionPreset: safe((input) => saveCaptionPreset(input || {})),
  fontCatalog: safe((query) => fontCatalog(query)),
  installFont: safe(async (id) => {
    const font = await installFont(id);
    return { ...font, ...registerAsset(font.path) };
  }),
  registerAsset: safe((filePath) => registerAsset(filePath)),
  saveProject: safe((data) => saveProjectFile(data, data?.projectPath || "")),
  openProject: safe(() => {
    const selected = chooseFile("project");
    return selected
      ? {
          projectPath: selected,
          data: JSON.parse(fs.readFileSync(selected, "utf8")),
        }
      : null;
  }),
  revealFile: safe((filePath) => revealFile(filePath)),
  exportProjectBackup: safe(() => {
    const destination = chooseOutput(
      "快剪工程备份.quickcutbackup",
      "quickcutbackup",
    );
    return destination ? exportBackup(destination) : null;
  }),
  importProjectBackup: safe(() => {
    const source = chooseFile("backup");
    return source ? importBackup(source) : null;
  }),
};

setImmediate(() => {
  try {
    detectExportHardware();
  } catch {
    /* first GPU probe is best-effort */
  }
});

console.log(`QUICKCUT_EMBED_PORT=${serverPort}`);
const editorUrl = `http://127.0.0.1:${serverPort}/`;
console.log(`QUICKCUT_EDITOR_URL=${editorUrl}`);

const embeddedInNativeShell = Boolean(process.env.QUICKCUT_APP_EXECUTABLE);
if (!embeddedInNativeShell && process.env.QUICKCUT_NO_WINDOW !== "1") {
  const windowProcess = openDesktopWindow(
    editorUrl,
    path.join(supportRoot(), "window-profile"),
  );
  if (windowProcess) {
    const startedAt = Date.now();
    windowProcess.on("exit", () => {
      if (Date.now() - startedAt < 3000) {
        console.log("编辑器窗口已打开。关闭这个控制台即可退出后台。");
        return;
      }
      requestExit();
    });
  } else {
    console.log(
      isWindows
        ? "未找到 Edge，已在默认浏览器中打开编辑器。关闭这个控制台即可退出。"
        : "已在浏览器中打开编辑器。关闭这个终端窗口即可退出后台。",
    );
  }
}

let quitting = false;
function requestExit() {
  if (quitting) return;
  quitting = true;
  try { assetServer?.closeAllConnections?.(); } catch {}
  try { assetServer?.close?.(); } catch {}
  setTimeout(() => process.exit(0), 120);
}
process.on("SIGINT", requestExit);
process.on("SIGTERM", requestExit);
process.on("SIGHUP", requestExit);
