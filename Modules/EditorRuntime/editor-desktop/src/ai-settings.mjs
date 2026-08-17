import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { supportRoot } from "./media.mjs";

const GEMINI_API_ROOT = "https://generativelanguage.googleapis.com";
const INTERACTIONS_PATH = "/v1beta/interactions";
const MODELS_LIST_PATH = "/v1beta/models";
const MODEL_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const NOT_TEXT_MODEL = /image|tts|live|embed|robot|computer-use|veo|lyria|omni|native-audio|imagen|aqa|gemma/i;

export const GEMINI_MODELS = [
  { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash（推荐）" },
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite（便宜）" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview（严审经文）" },
  { id: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite" },
];

export const ANTIGRAVITY_MODELS = [
  { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash High（推荐，套餐更稳）" },
  { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash High（部分地区不可用）" },
  { id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash Medium" },
  { id: "gemini-3.5-flash-high", label: "Gemini 3.5 Flash High" },
  { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro High（严审经文）" },
];

export const ANTIGRAVITY_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          decision: { type: "string" },
          reason: { type: "string" },
        },
        required: ["id", "decision"],
      },
    },
  },
  required: ["decisions"],
};

const DEFAULTS = {
  provider: "gemini",
  model: "gemini-3.7-flash",
  vertexProject: "",
  vertexLocation: "us-central1",
  promptStrict: "",
  promptNatural: "",
  antigravityPath: "",
};

let antigravityTestHooks = {
  resolveCli: null,
  exec: null,
  install: null,
  login: null,
};

let lastReviewTransport = {
  provider: "",
  requestedModel: "",
  usedModel: "",
  fallback: false,
  ms: 0,
};

export function getLastReviewTransport() {
  return { ...lastReviewTransport };
}

export function noteReviewTransport(patch = {}) {
  lastReviewTransport = { ...lastReviewTransport, ...patch };
  return getLastReviewTransport();
}

export function setAntigravityTestHooks(hooks = null) {
  antigravityTestHooks = {
    resolveCli: hooks?.resolveCli || null,
    exec: hooks?.exec || null,
    install: hooks?.install || null,
    login: hooks?.login || null,
  };
}

function secretsDir() {
  const directory = path.join(supportRoot(), "secrets");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function settingsPath() {
  return path.join(secretsDir(), "review-settings.json");
}

function modelCachePath() {
  return path.join(secretsDir(), "gemini-models.json");
}

function maskSecret(value) {
  const key = String(value || "");
  if (key.length < 8) return "";
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

function readSecret(name) {
  try {
    return fs.readFileSync(path.join(secretsDir(), name), "utf8").trim();
  } catch {
    return "";
  }
}

function writeSecret(name, value) {
  const file = path.join(secretsDir(), name);
  if (!value) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* absent */
    }
    return;
  }
  fs.writeFileSync(file, value, { mode: 0o600, encoding: "utf8" });
}

export function normalizeModelId(value) {
  return String(value || "")
    .trim()
    .replace(/^models\//i, "")
    .replace(/^publishers\/google\/models\//i, "");
}

export function isTextReviewModel(value, meta = {}) {
  const id = normalizeModelId(value);
  if (!/^gemini-/i.test(id)) return false;
  if (NOT_TEXT_MODEL.test(id)) return false;
  const methods = [
    ...(meta.supportedGenerationMethods || []),
    ...(meta.supported_generation_methods || []),
    ...(meta.supportedActions || []),
    ...(meta.supported_actions || []),
  ].map((item) => String(item || "").toLowerCase());
  if (
    methods.length &&
    methods.every((method) => /embed|predict|counttoken|batchembed/.test(method))
  ) {
    return false;
  }
  return true;
}

export function isSelectableModel(value) {
  const id = normalizeModelId(value);
  if (!id) return false;
  if (GEMINI_MODELS.some((item) => item.id === id)) return true;
  if (ANTIGRAVITY_MODELS.some((item) => item.id === id)) return true;
  return isTextReviewModel(id);
}

export function normalizeReviewProvider(value, fallback = "gemini") {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "vertex" || raw === "antigravity" || raw === "gemini") return raw;
  const next = String(fallback || "").trim().toLowerCase();
  if (next === "vertex" || next === "antigravity" || next === "gemini") return next;
  return "gemini";
}

export function resolveCliFile(value = "") {
  const raw = String(value || "").trim().replace(/^["']|["']$/g, "");
  if (!raw) return "";
  try {
    if (fs.existsSync(raw) && fs.statSync(raw).isFile()) return raw;
    if (fs.existsSync(raw) && fs.statSync(raw).isDirectory()) {
      for (const name of ["agy.exe", "agy", "agy.cmd"]) {
        const nested = path.join(raw, name);
        if (fs.existsSync(nested) && fs.statSync(nested).isFile()) return nested;
      }
    }
  } catch {
    return "";
  }
  return "";
}

function lookOnPath(name) {
  const wanted = String(name || "").trim();
  if (!wanted) return "";
  const pathEnv = String(process.env.PATH || "");
  const exts =
    process.platform === "win32" && !path.extname(wanted)
      ? [".exe", ".cmd", ".bat", ""]
      : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, `${wanted}${ext}`);
      const resolved = resolveCliFile(full);
      if (resolved) return resolved;
    }
  }
  return "";
}

export function antigravityInstallHint() {
  const win = process.platform === "win32";
  const localAppData =
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return {
    command: win
      ? "irm https://antigravity.google/cli/install.ps1 | iex"
      : "curl -fsSL https://antigravity.google/cli/install.sh | bash",
    shell: win ? "PowerShell" : "终端",
    docs: "https://antigravity.google/docs/cli/install",
    binDir: win ? path.join(localAppData, "agy", "bin") : path.join(os.homedir(), ".local", "bin"),
  };
}

export function antigravitySearchPaths(explicit = "") {
  const localAppData =
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return [
    explicit,
    process.env.ANTIGRAVITY_CLI,
    process.env.AGY_PATH,
    path.join(localAppData, "agy", "bin", "agy.exe"),
    path.join(localAppData, "agy", "bin", "agy"),
    path.join(localAppData, "antigravity", "bin", "agy.exe"),
    path.join(localAppData, "Programs", "Antigravity", "agy.exe"),
    path.join(os.homedir(), "AppData", "Local", "agy", "bin", "agy.exe"),
    path.join(os.homedir(), "AppData", "Local", "antigravity", "bin", "agy.exe"),
    path.join(os.homedir(), ".local", "bin", "agy.exe"),
    path.join(os.homedir(), ".local", "bin", "agy"),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
  ].filter(Boolean);
}

export function findAntigravityCli(explicit = "") {
  if (typeof antigravityTestHooks.resolveCli === "function") {
    return String(antigravityTestHooks.resolveCli() || "");
  }
  const chosen = resolveCliFile(explicit);
  if (chosen) return chosen;
  const fromPath = lookOnPath("agy");
  if (fromPath) return fromPath;
  for (const candidate of antigravitySearchPaths()) {
    const resolved = resolveCliFile(candidate);
    if (resolved) return resolved;
  }
  return "";
}

export function agyReviewWorkspace() {
  const directory = path.join(supportRoot(), "agy-review");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

export function removeAgyWorkDir(directory) {
  const target = String(directory || "").trim();
  if (!target) return true;
  try {
    if (!fs.existsSync(target)) return true;
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 80 });
    return true;
  } catch {
    return false;
  }
}

export function sweepStaleAgyWorkDirs() {
  let names = [];
  try {
    names = fs.readdirSync(os.tmpdir());
  } catch {
    return;
  }
  for (const name of names) {
    if (!String(name).startsWith("quickcut-agy-")) continue;
    removeAgyWorkDir(path.join(os.tmpdir(), name));
  }
}

export function parseAgyModels(output = "") {
  const text = String(output || "").trim();
  const rows = [];
  const seen = new Set();
  const push = (id, label = "") => {
    const name = normalizeModelId(id);
    if (!isTextReviewModel(name) || seen.has(name)) return;
    seen.add(name);
    rows.push({ id: name, label: labelForModel(name, label) });
  };
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const data = JSON.parse(text);
      const list = Array.isArray(data)
        ? data
        : [...(data.models || []), ...(data.items || [])];
      for (const item of list) {
        if (typeof item === "string") push(item);
        else push(item?.id || item?.name || item?.slug, item?.label || item?.displayName || item?.display_name);
      }
      if (rows.length) return rows;
    } catch {
      /* fall through to line parse */
    }
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^(gemini-[a-z0-9][a-z0-9._-]*)(?:\s+(.+))?$/i);
    if (!match) continue;
    push(match[1], match[2] || "");
  }
  return rows;
}

export function mapToAntigravityModel(value, available = []) {
  const name = normalizeModelId(value);
  const ids = (Array.isArray(available) ? available : [])
    .map((item) => normalizeModelId(item?.id || item))
    .filter(Boolean);
  if (name && ids.includes(name)) return name;
  const suffixes = ["-high", "-medium", "-low"];
  if (name) {
    for (const suffix of suffixes) {
      if (ids.includes(name + suffix)) return name + suffix;
    }
    const stripped = name.replace(/-(high|medium|low)$/i, "");
    if (ids.includes(stripped)) return stripped;
    for (const suffix of suffixes) {
      if (ids.includes(stripped + suffix)) return stripped + suffix;
    }
    if (!ids.length) {
      if (/-(high|medium|low)$/i.test(name)) return name;
      if (/^gemini-/i.test(name)) return `${name}-high`;
    }
  }
  return ids[0] || ANTIGRAVITY_MODELS[0].id;
}

export function antigravityModelArgs(value, available = []) {
  const slug = mapToAntigravityModel(value, available);
  const flags = [];
  if (slug) flags.push("--model", slug);
  if (slug && !/-(high|medium|low)$/i.test(slug)) flags.push("--effort", "low");
  return flags;
}

export function fromAntigravityModel(value) {
  const name = normalizeModelId(value);
  return name.replace(/-(high|medium|low)$/i, "") || name;
}

export function isUnavailableAgyModel(message = "") {
  return /was not found|does not have access|invalid model|conflicts with --effort|not recognized as a known model|specified region|套餐或地区不可用|模型不可用/i.test(
    String(message || ""),
  );
}

export function antigravityRetryPlans(value, available = []) {
  const plans = [];
  const seen = new Set();
  const push = (flags) => {
    const key = flags.join("\0");
    if (seen.has(key)) return;
    seen.add(key);
    plans.push(flags);
  };
  push(antigravityModelArgs(value, available));
  push(["--model", "gemini-3.6-flash-high"]);
  push(["--model", "gemini-3.5-flash-high"]);
  push([]);
  return plans;
}

export function catalogForProvider(provider) {
  return normalizeReviewProvider(provider) === "antigravity" ? ANTIGRAVITY_MODELS : GEMINI_MODELS;
}

function hintForModel(id) {
  if (id === "gemini-3.7-flash") return "推荐";
  if (id === "gemini-3.1-pro-preview") return "严审经文";
  if (/flash-lite/i.test(id)) return "便宜";
  return "";
}

export function labelForModel(id, displayName = "") {
  const name = normalizeModelId(id);
  const base = String(displayName || "")
    .replace(/\s+/g, " ")
    .trim() || name.replace(/^gemini-/i, "Gemini ").replace(/-/g, " ");
  const pretty = base.replace(/\bgemini\b/gi, "Gemini");
  const hint = hintForModel(name);
  return hint && !pretty.includes(hint) ? `${pretty}（${hint}）` : pretty;
}

function compareModels(left, right) {
  const a = normalizeModelId(left.id || left);
  const b = normalizeModelId(right.id || right);
  const parse = (id) => {
    const match = id.match(/^gemini-(\d+)(?:\.(\d+))?(?:-([a-z0-9-]+))?/i);
    const rest = match ? match[3] || "" : id;
    return {
      major: match ? Number(match[1]) : 0,
      minor: match ? Number(match[2] || 0) : 0,
      family: /pro/.test(rest) ? 0 : /flash-lite/.test(rest) ? 2 : /flash/.test(rest) ? 1 : 3,
      preview: /preview|exp/.test(id) ? 1 : 0,
      id,
    };
  };
  const aa = parse(a);
  const bb = parse(b);
  return bb.major - aa.major || bb.minor - aa.minor || aa.family - bb.family || aa.preview - bb.preview || aa.id.localeCompare(bb.id);
}

export function mergeModelCatalog(live = [], selected = "", catalog = GEMINI_MODELS) {
  const byId = new Map();
  for (const item of [...(catalog || GEMINI_MODELS), ...live]) {
    const id = normalizeModelId(item?.id);
    if (!isSelectableModel(id)) continue;
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        label: item.label || labelForModel(id),
      });
    }
  }
  const selectedId = normalizeModelId(selected);
  if (selectedId && isSelectableModel(selectedId) && !byId.has(selectedId)) {
    byId.set(selectedId, { id: selectedId, label: labelForModel(selectedId) });
  }
  return [...byId.values()].sort(compareModels);
}

export function parseListedModels(payload = {}) {
  const rows = [
    ...(payload.models || []),
    ...(payload.publisherModels || []),
    ...(payload.publisher_models || []),
  ];
  return rows
    .map((model) => {
      const id = normalizeModelId(model.name || model.baseModelId || model.base_model_id || "");
      if (!isTextReviewModel(id, model)) return null;
      return {
        id,
        label: labelForModel(id, model.displayName || model.display_name),
      };
    })
    .filter(Boolean);
}

function readModelCache() {
  try {
    return JSON.parse(fs.readFileSync(modelCachePath(), "utf8"));
  } catch {
    return null;
  }
}

function writeModelCache(cache) {
  fs.writeFileSync(modelCachePath(), JSON.stringify(cache, null, 2), { mode: 0o600, encoding: "utf8" });
}

export function loadReviewSettings() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  } catch {
    stored = {};
  }
  const provider = normalizeReviewProvider(stored.provider);
  const storedModel = isSelectableModel(stored.model) ? normalizeModelId(stored.model) : "";
  const model =
    provider === "antigravity"
      ? mapToAntigravityModel(storedModel || DEFAULTS.model)
      : fromAntigravityModel(storedModel || DEFAULTS.model) || DEFAULTS.model;
  const antigravityPath = String(stored.antigravityPath || "").trim();
  const antigravityCli = findAntigravityCli(antigravityPath);
  return {
    provider,
    model,
    vertexProject: String(stored.vertexProject || "").trim(),
    vertexLocation: String(stored.vertexLocation || DEFAULTS.vertexLocation).trim() || "us-central1",
    promptStrict: String(stored.promptStrict || ""),
    promptNatural: String(stored.promptNatural || ""),
    antigravityPath,
    antigravityCli,
    antigravityReady: Boolean(antigravityCli),
    antigravityLoggedIn: null,
    antigravityState: antigravityCli ? "installed" : "missing",
    antigravityInstallCommand: antigravityInstallHint().command,
    antigravityDocs: antigravityInstallHint().docs,
    antigravityHint: antigravityCli
      ? `已找到 ${antigravityCli}。点「检测」确认登录，或点「登录」用浏览器完成 Gemini 套餐授权。`
      : `还没安装 agy。点「安装 agy」会运行官方脚本：${antigravityInstallHint().command}`,
    geminiKey: Boolean(process.env.GEMINI_API_KEY || readSecret("gemini-api-key.txt")),
    geminiHint: maskSecret(process.env.GEMINI_API_KEY || readSecret("gemini-api-key.txt")),
    vertexKey: Boolean(process.env.VERTEX_API_KEY || readSecret("vertex-api-key.txt")),
    vertexHint: maskSecret(process.env.VERTEX_API_KEY || readSecret("vertex-api-key.txt")),
    vertexServiceAccount: Boolean(readSecret("vertex-sa.json")),
    models: mergeModelCatalog([], model, catalogForProvider(provider)),
    modelSource: "fallback",
  };
}

export function saveReviewSettings(input = {}) {
  const current = loadReviewSettings();
  const next = {
    provider:
      input.provider !== undefined
        ? normalizeReviewProvider(input.provider, current.provider)
        : current.provider,
    model: isSelectableModel(input.model) ? normalizeModelId(input.model) : current.model,
    vertexProject:
      input.vertexProject !== undefined ? String(input.vertexProject || "").trim() : current.vertexProject,
    vertexLocation:
      input.vertexLocation !== undefined
        ? String(input.vertexLocation || "").trim() || "us-central1"
        : current.vertexLocation,
    promptStrict: input.promptStrict !== undefined ? String(input.promptStrict || "") : current.promptStrict,
    promptNatural: input.promptNatural !== undefined ? String(input.promptNatural || "") : current.promptNatural,
    antigravityPath:
      input.antigravityPath !== undefined
        ? String(input.antigravityPath || "").trim()
        : current.antigravityPath || "",
  };
  if (next.provider === "antigravity") next.model = mapToAntigravityModel(next.model);
  else next.model = fromAntigravityModel(next.model) || next.model;
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), { mode: 0o600, encoding: "utf8" });
  if (input.geminiKey !== undefined) {
    const key = String(input.geminiKey || "").replace(/\s+/g, "").trim();
    if (key && key.length < 20) throw new Error("Gemini API Key 看起来不完整。");
    writeSecret("gemini-api-key.txt", key);
  }
  if (input.vertexKey !== undefined) {
    const key = String(input.vertexKey || "").replace(/\s+/g, "").trim();
    if (key && key.length < 16) throw new Error("Vertex Key 看起来不完整。");
    writeSecret("vertex-api-key.txt", key);
  }
  if (input.vertexServiceAccountJson !== undefined) {
    const raw = String(input.vertexServiceAccountJson || "").trim();
    if (raw) {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("服务账号必须是 JSON。");
      }
      if (!parsed.client_email || !parsed.private_key) throw new Error("服务账号 JSON 缺少 client_email 或 private_key。");
      writeSecret("vertex-sa.json", JSON.stringify(parsed, null, 2));
      if (!next.vertexProject && parsed.project_id) next.vertexProject = parsed.project_id;
      fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), { mode: 0o600, encoding: "utf8" });
    } else {
      writeSecret("vertex-sa.json", "");
    }
  }
  return loadReviewSettings();
}

export function clearGeminiKey() {
  writeSecret("gemini-api-key.txt", "");
  return loadReviewSettings();
}

export function clearVertexSecrets() {
  writeSecret("vertex-api-key.txt", "");
  writeSecret("vertex-sa.json", "");
  return loadReviewSettings();
}

function geminiApiKey() {
  return String(process.env.GEMINI_API_KEY || readSecret("gemini-api-key.txt") || "").trim();
}

function vertexApiKey() {
  return String(process.env.VERTEX_API_KEY || readSecret("vertex-api-key.txt") || "").trim();
}

function vertexServiceAccount() {
  const raw = readSecret("vertex-sa.json");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function accessTokenFromServiceAccount(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claim = Buffer.from(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  ).toString("base64url");
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${signer.sign(sa.private_key, "base64url")}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!data.access_token)
    throw new Error(data.error_description || data.error || "Vertex 服务账号换票失败。");
  return data.access_token;
}

export function vertexAuthMode() {
  if (vertexServiceAccount()) return "service-account";
  if (vertexApiKey()) return "express-key";
  return "none";
}

export function reviewReady() {
  const settings = loadReviewSettings();
  if (settings.provider === "antigravity") return Boolean(findAntigravityCli(settings.antigravityPath));
  if (settings.provider === "vertex") {
    if (vertexAuthMode() === "express-key") return true;
    return Boolean(settings.vertexProject && vertexServiceAccount());
  }
  return Boolean(geminiApiKey());
}

export function geminiMediaReady() {
  const settings = loadReviewSettings();
  if (settings.provider === "antigravity") return false;
  return reviewReady();
}

export function buildGeminiInteractionBody({ model, system, user } = {}) {
  const id = normalizeModelId(model) || DEFAULTS.model;
  const generation_config = { temperature: 0 };
  if (/^gemini-3/i.test(id)) generation_config.thinking_level = "low";
  return {
    model: id,
    input: String(user || ""),
    system_instruction: String(system || ""),
    store: false,
    generation_config,
    response_format: [{ type: "text", mime_type: "application/json" }],
  };
}

export function buildGeminiGenerateContentBody({ system, user } = {}) {
  return {
    systemInstruction: { parts: [{ text: String(system || "") }] },
    contents: [{ role: "user", parts: [{ text: String(user || "") }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
    },
  };
}

function collectText(value, into = []) {
  if (!value) return into;
  if (typeof value === "string") {
    if (value.trim()) into.push(value);
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, into);
    return into;
  }
  if (typeof value !== "object") return into;
  if (typeof value.text === "string") into.push(value.text);
  if (typeof value.output_text === "string") into.push(value.output_text);
  collectText(value.parts, into);
  collectText(value.content, into);
  collectText(value.contents, into);
  collectText(value.candidates, into);
  collectText(value.steps, into);
  collectText(value.outputs, into);
  return into;
}

export function extractGeminiOutputText(data = {}) {
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  const steps = Array.isArray(data.steps) ? data.steps : [];
  const fromSteps = steps
    .filter((step) => String(step?.type || "") === "model_output")
    .flatMap((step) => collectText(step.content));
  if (fromSteps.length) return fromSteps.join("\n").trim();
  const fromCandidates = (data.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => String(part?.text || ""))
    .filter(Boolean);
  if (fromCandidates.length) return fromCandidates.join("\n").trim();
  return collectText(data).join("\n").trim();
}

export function extractApiErrorMessage(data, raw = "", status = 0) {
  const message =
    data?.error?.message ||
    (Array.isArray(data) ? data[0]?.error?.message : "") ||
    "";
  if (message) return String(message);
  return raw.slice(0, 240) || `Gemini 纠正失败（${status}）`;
}

function apiErrorMessage(data, raw, status) {
  const message = extractApiErrorMessage(data, raw, status);
  if (/api keys are not supported|expected oauth|assert a principal/i.test(message)) {
    return "这个接口不接受 API Key，需要 OAuth 服务账号。只用 Key 时请选 Gemini API，或在 Vertex 里走 Express（不要填项目接口）。";
  }
  return message;
}

export function shouldFallbackToGenerateContent(status, data, raw) {
  if (status === 404 || status === 405) return true;
  const message = String(extractApiErrorMessage(data, raw, status) || "").toLowerCase();
  return /not found|unknown (rpc|method)|method not found|unrecognized name|does not exist|api keys are not supported|expected oauth|assert a principal/.test(
    message,
  );
}

export function buildVertexExpressGenerateContentUrl(model, key) {
  const url = new URL(
    `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(normalizeModelId(model))}:generateContent`,
  );
  url.searchParams.set("key", key);
  return url.toString();
}

async function readJsonResponse(response) {
  const raw = await response.text();
  let data = {};
  try {
    data = JSON.parse(raw);
  } catch {
    data = {};
  }
  return { raw, data };
}

async function fetchAllPages(firstUrl, headers, pickRows) {
  const collected = [];
  let url = firstUrl;
  for (let page = 0; page < 8 && url; page += 1) {
    const response = await fetch(url, { headers });
    const { data, raw } = await readJsonResponse(response);
    if (!response.ok) throw new Error(apiErrorMessage(data, raw, response.status));
    collected.push(...pickRows(data));
    const token = data.nextPageToken || data.next_page_token;
    if (!token) break;
    const next = new URL(firstUrl);
    next.searchParams.set("pageToken", token);
    url = next.toString();
  }
  return collected;
}

async function fetchGeminiApiModels(key) {
  const url = new URL(`${GEMINI_API_ROOT}${MODELS_LIST_PATH}`);
  url.searchParams.set("pageSize", "200");
  return fetchAllPages(url.toString(), { "x-goog-api-key": key }, parseListedModels);
}

async function fetchVertexModels(settings, headers) {
  const location = settings.vertexLocation || "us-central1";
  const project = settings.vertexProject;
  const url = new URL(
    project
      ? `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models`
      : `https://${location}-aiplatform.googleapis.com/v1beta1/publishers/google/models`,
  );
  url.searchParams.set("pageSize", "200");
  return fetchAllPages(url.toString(), headers, parseListedModels);
}

async function vertexOAuthHeaders() {
  const sa = vertexServiceAccount();
  if (!sa) throw new Error("Vertex 项目接口需要服务账号 JSON，不能只用 API Key。");
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${await accessTokenFromServiceAccount(sa)}`,
  };
}

export async function listReviewModels({ refresh = false } = {}) {
  const settings = loadReviewSettings();
  const cache = readModelCache();
  const cacheFresh =
    !refresh &&
    cache &&
    cache.provider === settings.provider &&
    Date.now() - Number(cache.fetchedAt || 0) < MODEL_CACHE_TTL_MS &&
    Array.isArray(cache.models) &&
    cache.models.length;
  if (cacheFresh) {
    return {
      ...settings,
      models: mergeModelCatalog(cache.models, settings.model, catalogForProvider(settings.provider)),
      modelSource: "live",
      modelFetchedAt: cache.fetchedAt,
    };
  }
  if (settings.provider === "antigravity" && !refresh) {
    const stale = cache?.models?.length ? cache.models : [];
    return {
      ...settings,
      models: mergeModelCatalog(stale, settings.model, ANTIGRAVITY_MODELS),
      modelSource: stale.length ? "cache" : "fallback",
      modelFetchedAt: cache?.fetchedAt || 0,
    };
  }
  try {
    let live = [];
    if (settings.provider === "antigravity") {
      if (!findAntigravityCli(settings.antigravityPath)) throw new Error("no-agy");
      const listed = await runAntigravityCli(["models"], {
        timeoutMs: 45_000,
        timeoutMessage:
          "拉取模型超时。请点「登录」在可见终端完成 Gemini 套餐授权，然后再点「拉取最新」。",
      });
      if (listed.status !== 0) throw new Error(listed.stderr || "agy models failed");
      live = parseAgyModels(listed.stdout);
    } else if (settings.provider === "vertex") {
      if (vertexAuthMode() !== "service-account") throw new Error("vertex-express-has-no-model-list");
      if (!reviewReady()) throw new Error("no-vertex-auth");
      live = await fetchVertexModels(settings, await vertexOAuthHeaders());
    } else {
      const key = geminiApiKey();
      if (!key) throw new Error("no-gemini-key");
      live = await fetchGeminiApiModels(key);
    }
    const models = mergeModelCatalog(live, settings.model, catalogForProvider(settings.provider));
    const fetchedAt = Date.now();
    writeModelCache({ provider: settings.provider, fetchedAt, models: live });
    return {
      ...settings,
      models,
      modelSource: live.length ? "live" : "fallback",
      modelFetchedAt: fetchedAt,
    };
  } catch {
    const stale = cache?.models?.length ? cache.models : [];
    return {
      ...settings,
      models: mergeModelCatalog(stale, settings.model, catalogForProvider(settings.provider)),
      modelSource: stale.length ? "cache" : "fallback",
      modelFetchedAt: cache?.fetchedAt || 0,
    };
  }
}

async function completeViaInteractions({ settings, model, system, user, signal }) {
  const body = buildGeminiInteractionBody({ model, system, user });
  const headers = { "Content-Type": "application/json" };
  let url = "";
  if (settings.provider === "vertex") {
    if (vertexAuthMode() !== "service-account") {
      return {
        ok: false,
        status: 401,
        data: { error: { message: "API keys are not supported by this API." } },
        raw: "",
      };
    }
    if (!settings.vertexProject) throw new Error("请先填写 Vertex 项目 ID，或导入带 project_id 的服务账号。");
    const location = settings.vertexLocation || "us-central1";
    url = `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${encodeURIComponent(settings.vertexProject)}/locations/${encodeURIComponent(location)}/interactions`;
    Object.assign(headers, await vertexOAuthHeaders());
  } else {
    const key = geminiApiKey();
    if (!key) throw new Error("请先保存 Gemini API Key。");
    url = `${GEMINI_API_ROOT}${INTERACTIONS_PATH}`;
    headers["x-goog-api-key"] = key;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  const { data, raw } = await readJsonResponse(response);
  return { ok: response.ok, status: response.status, data, raw };
}

async function completeViaGenerateContent({ settings, model, system, user, signal }) {
  const body = buildGeminiGenerateContentBody({ system, user });
  const headers = { "Content-Type": "application/json" };
  let url = "";
  if (settings.provider === "vertex") {
    const mode = vertexAuthMode();
    if (mode === "express-key") {
      url = buildVertexExpressGenerateContentUrl(model, vertexApiKey());
    } else if (mode === "service-account") {
      if (!settings.vertexProject) throw new Error("请先填写 Vertex 项目 ID，或导入带 project_id 的服务账号。");
      const location = settings.vertexLocation || "us-central1";
      url = `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(settings.vertexProject)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
      Object.assign(headers, await vertexOAuthHeaders());
    } else {
      throw new Error("请先保存 Vertex Key，或导入服务账号 JSON。");
    }
  } else {
    const key = geminiApiKey();
    if (!key) throw new Error("请先保存 Gemini API Key。");
    url = `${GEMINI_API_ROOT}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    headers["x-goog-api-key"] = key;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  const { data, raw } = await readJsonResponse(response);
  return { ok: response.ok, status: response.status, data, raw, url };
}

function textFromResult(result) {
  if (!result.ok) return "";
  return extractGeminiOutputText(result.data);
}

async function postGeminiJson(url, headers, body, signal) {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  const parsed = await readJsonResponse(response);
  return { ok: response.ok, status: response.status, ...parsed };
}

function mediaPartsFromInput(input = []) {
  return (Array.isArray(input) ? input : []).map((item) => {
    if (item?.type === "audio" && item.data)
      return { inlineData: { mimeType: item.mime_type || "audio/flac", data: item.data } };
    return { text: String(item?.text || item || "") };
  });
}

export async function completeGeminiMedia({
  system = "",
  input = [],
  signal = null,
  responseSchema = null,
} = {}) {
  const settings = loadReviewSettings();
  if (settings.provider === "antigravity") {
    throw new Error("Antigravity CLI 只用于文稿纠正，听写请改用 Groq、Deepgram 或本地 Whisper。");
  }
  if (!geminiMediaReady()) throw new Error("请先在纠正设置里保存 Gemini 或 Vertex 凭证。");
  const model = fromAntigravityModel(settings.model || DEFAULTS.model) || DEFAULTS.model;
  const responseFormat = responseSchema
    ? [{ type: "text", mime_type: "application/json", schema: responseSchema }]
    : [{ type: "text", mime_type: "application/json" }];
  const interactionBody = {
    model,
    input,
    system_instruction: String(system || ""),
    store: false,
    generation_config: { temperature: 0 },
    response_format: responseFormat,
  };
  const generateBody = {
    systemInstruction: { parts: [{ text: String(system || "") }] },
    contents: [{ role: "user", parts: mediaPartsFromInput(input) }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      ...(responseSchema ? { responseSchema } : {}),
    },
  };

  const postGenerate = async () => {
    const headers = { "Content-Type": "application/json" };
    let url = "";
    if (settings.provider === "vertex") {
      if (vertexAuthMode() === "express-key")
        url = buildVertexExpressGenerateContentUrl(model, vertexApiKey());
      else if (vertexAuthMode() === "service-account") {
        if (!settings.vertexProject) throw new Error("请先填写 Vertex 项目 ID。");
        const location = settings.vertexLocation || "us-central1";
        url = `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(settings.vertexProject)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
        Object.assign(headers, await vertexOAuthHeaders());
      } else throw new Error("请先保存 Vertex Key，或导入服务账号 JSON。");
    } else {
      const key = geminiApiKey();
      if (!key) throw new Error("请先保存 Gemini API Key。");
      url = `${GEMINI_API_ROOT}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      headers["x-goog-api-key"] = key;
    }
    return postGeminiJson(url, headers, generateBody, signal);
  };

  if (settings.provider === "vertex" && vertexAuthMode() === "express-key") {
    const express = await postGenerate();
    const text = textFromResult(express);
    if (text) return text;
    throw new Error(apiErrorMessage(express.data, express.raw, express.status));
  }

  const headers = { "Content-Type": "application/json" };
  let url = `${GEMINI_API_ROOT}${INTERACTIONS_PATH}`;
  if (settings.provider === "vertex") {
    if (vertexAuthMode() !== "service-account") {
      const express = await postGenerate();
      const text = textFromResult(express);
      if (text) return text;
      throw new Error(apiErrorMessage(express.data, express.raw, express.status));
    }
    if (!settings.vertexProject) throw new Error("请先填写 Vertex 项目 ID。");
    const location = settings.vertexLocation || "us-central1";
    url = `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${encodeURIComponent(settings.vertexProject)}/locations/${encodeURIComponent(location)}/interactions`;
    Object.assign(headers, await vertexOAuthHeaders());
  } else {
    const key = geminiApiKey();
    if (!key) throw new Error("请先保存 Gemini API Key。");
    headers["x-goog-api-key"] = key;
  }
  const interaction = await postGeminiJson(url, headers, interactionBody, signal);
  const interactionText = textFromResult(interaction);
  if (interactionText) return interactionText;
  if (!shouldFallbackToGenerateContent(interaction.status, interaction.data, interaction.raw)) {
    throw new Error(apiErrorMessage(interaction.data, interaction.raw, interaction.status));
  }
  const legacy = await postGenerate();
  const text = textFromResult(legacy);
  if (!text) throw new Error(apiErrorMessage(legacy.data, legacy.raw, legacy.status));
  return text;
}

export function formatAntigravityError(message, status = "") {
  const text = String(message || "").trim();
  if (/authentication required|not authenticated|login required|please (sign|log) in|auth required/i.test(text)) {
    return "Antigravity CLI 还没有登录。请先在终端运行 agy，用 Gemini 套餐完成登录后再纠正。";
  }
  if (/timed? ?out|超时/i.test(text)) {
    return "agy 没有在限定时间内返回。请点「登录」在可见终端完成 Gemini 套餐授权，然后再试。";
  }
  if (/not recognized|unknown model|invalid model|conflicts with --effort/i.test(text)) {
    return text.slice(0, 280) || "Antigravity 模型不可用，请点「拉取最新」后重选。";
  }
  if (/was not found|does not have access|specified region/i.test(text)) {
    return "这个模型在你当前套餐或地区不可用。请在纠正设置里点「拉取最新」另选一个，或改用 agy 默认模型。";
  }
  return text.slice(0, 280) || `Antigravity CLI 纠正失败${status ? `（${status}）` : ""}。`;
}

export function extractAntigravityResponse(stdout = "", stderr = "") {
  const raw = String(stdout || "").trim();
  let envelope = null;
  if (raw.startsWith("{")) {
    try {
      envelope = JSON.parse(raw);
    } catch {
      envelope = null;
    }
  }
  if (!envelope) {
    const match = raw.match(/\{[\s\S]*\}\s*$/);
    if (match) {
      try {
        envelope = JSON.parse(match[0]);
      } catch {
        envelope = null;
      }
    }
  }
  if (envelope && typeof envelope === "object") {
    const status = String(envelope.status || "").toUpperCase();
    if (status && status !== "SUCCESS") {
      throw new Error(formatAntigravityError(envelope.error || stderr, status));
    }
    if (envelope.structured_output && typeof envelope.structured_output === "object") {
      const dumped = JSON.stringify(envelope.structured_output);
      if (/"decisions"\s*:/.test(dumped) || Object.keys(envelope.structured_output).length) {
        return dumped;
      }
    }
    if (typeof envelope.response === "string" && envelope.response.trim()) {
      return envelope.response.trim();
    }
    if (status === "SUCCESS") {
      throw new Error("agy 没有返回判定 JSON。任务文件可能没被读到，请再纠正一次。");
    }
  }
  if (raw && /"decisions"\s*:/.test(raw)) return raw;
  throw new Error(formatAntigravityError(stderr, "ERROR"));
}

export function buildAntigravityTask({ system, user } = {}) {
  return [
    String(system || "").trim(),
    "",
    String(user || "").trim(),
    "",
    'Return JSON only: {"decisions":[{"id":"...","decision":"keep|cut|missing|unsure","reason":"..."}]}',
    "Do not explain. Do not ask questions. Do not search the workspace. Do not run tools.",
  ].join("\n");
}

export function buildAntigravityJudgePrompt(taskPath = "") {
  const file = path.resolve(String(taskPath || "review-task.md"));
  return [
    "You are the same manuscript-cut judge used by Vertex.",
    `Read ONLY this file and follow it exactly: ${file}`,
    "Output only the decisions JSON.",
    "Do not act as a coding agent. Do not search the home directory. Do not list other folders. Do not run commands.",
  ].join(" ");
}

function killAgyProcess(child) {
  const pid = Number(child?.pid);
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

function spawnAntigravity(cli, args, { cwd, timeoutMs, signal, timeoutMessage } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, {
      cwd: cwd || process.cwd(),
      windowsHide: true,
      shell: /\.(cmd|bat)$/i.test(cli),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result);
    };
    const onAbort = () => {
      killAgyProcess(child);
      finish(new Error("Antigravity CLI 纠正已取消。"));
    };
    const timer = setTimeout(() => {
      killAgyProcess(child);
      finish(
        new Error(
          timeoutMessage ||
            "agy 没有在限定时间内返回。请点「登录」在可见终端完成 Gemini 套餐授权，然后再试。",
        ),
      );
    }, Math.max(1000, Number(timeoutMs) || 30_000));
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish(new Error(error?.message || "无法启动 Antigravity CLI。"));
    });
    child.on("close", (code) => {
      finish(null, { status: Number(code) || 0, stdout, stderr });
    });
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort);
    }
  });
}

export async function runAntigravityCli(args, options = {}) {
  if (typeof antigravityTestHooks.exec === "function") {
    return antigravityTestHooks.exec(args, options);
  }
  const settings = loadReviewSettings();
  const cli = findAntigravityCli(settings.antigravityPath);
  if (!cli) throw new Error("未找到 Antigravity CLI（agy）。请先在纠正设置里点「安装 agy」，或指定路径。");
  return spawnAntigravity(cli, args, options);
}

function antigravityAuthFailed(text = "", status = 0) {
  return (
    /authentication required|not authenticated|not signed in|please (sign|log) in|auth required/i.test(
      String(text || ""),
    ) || (Number(status) !== 0 && /auth/i.test(String(text || "")))
  );
}

export async function checkAntigravityStatus() {
  sweepStaleAgyWorkDirs();
  const settings = loadReviewSettings();
  const cli = findAntigravityCli(settings.antigravityPath);
  if (!cli) {
    return {
      ...settings,
      antigravityCli: "",
      antigravityReady: false,
      antigravityLoggedIn: false,
      antigravityState: "missing",
      antigravityHint: `还没安装 agy。点「安装 agy」会运行官方脚本：${settings.antigravityInstallCommand}`,
    };
  }
  try {
    const listed = await runAntigravityCli(["models"], {
      timeoutMs: 45_000,
      timeoutMessage:
        "检测超时：agy 没有响应。请点「登录」在可见终端完成 Gemini 套餐授权，然后再点「检测」。",
    });
    const combined = `${listed.stdout || ""}\n${listed.stderr || ""}`;
    if (antigravityAuthFailed(combined, listed.status)) {
      return {
        ...settings,
        antigravityCli: cli,
        antigravityReady: true,
        antigravityLoggedIn: false,
        antigravityState: "need-login",
        antigravityHint: "agy 已安装，但还没登录。点「登录」打开终端，用浏览器完成 Gemini 套餐授权，回来再点「检测」。",
      };
    }
    if (listed.status !== 0) {
      return {
        ...settings,
        antigravityCli: cli,
        antigravityReady: true,
        antigravityLoggedIn: false,
        antigravityState: "error",
        antigravityHint: formatAntigravityError(listed.stderr || listed.stdout, listed.status),
      };
    }
    const live = parseAgyModels(listed.stdout);
    return {
      ...settings,
      antigravityCli: cli,
      antigravityReady: true,
      antigravityLoggedIn: true,
      antigravityState: "ready",
      antigravityHint: `已就绪，可用 Gemini 套餐。${cli}`,
      models: mergeModelCatalog(live, settings.model, ANTIGRAVITY_MODELS),
      modelSource: live.length ? "live" : settings.modelSource,
    };
  } catch (error) {
    const message = error?.message || String(error);
    return {
      ...settings,
      antigravityCli: cli,
      antigravityReady: true,
      antigravityLoggedIn: false,
      antigravityState: antigravityAuthFailed(message) ? "need-login" : "error",
      antigravityHint: antigravityAuthFailed(message)
        ? "agy 已安装，但还没登录。点「登录」用浏览器完成 Gemini 套餐授权。"
        : message,
    };
  }
}

export async function installAntigravityCli() {
  if (typeof antigravityTestHooks.install === "function") {
    return antigravityTestHooks.install();
  }
  const existing = findAntigravityCli(loadReviewSettings().antigravityPath);
  if (existing) return checkAntigravityStatus();
  const command =
    process.platform === "win32"
      ? ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://antigravity.google/cli/install.ps1 | iex"]]
      : ["/bin/bash", ["-lc", "curl -fsSL https://antigravity.google/cli/install.sh | bash"]];
  const result = await spawnAntigravity(command[0], command[1], { timeoutMs: 5 * 60 * 1000 });
  const found = findAntigravityCli();
  if (found) return checkAntigravityStatus();
  const detail = String(result.stderr || result.stdout || "").trim();
  throw new Error(
    detail
      ? `安装失败：${detail.slice(0, 240)}`
      : `安装失败。请打开 ${antigravityInstallHint().shell} 运行：${antigravityInstallHint().command}`,
  );
}

export function openAntigravityLogin() {
  if (typeof antigravityTestHooks.login === "function") {
    return antigravityTestHooks.login();
  }
  const cli = findAntigravityCli(loadReviewSettings().antigravityPath);
  if (!cli) throw new Error("还没安装 Antigravity CLI。请先点「安装 agy」。");
  if (process.platform === "win32") {
    const cleanCli = cli.replace(/"/g, "");
    const batPath = path.join(os.tmpdir(), `quickcut-agy-login-${Date.now()}.bat`);
    const batContent = `@echo off
chcp 65001 >nul
title Antigravity 登录
cls
echo =======================================================
echo   请在下方终端中登录 Antigravity (Gemini 套餐)
echo =======================================================
echo.
"${cleanCli}"
echo.
echo =======================================================
echo   登录完成或结束后，请关闭此窗口并回到快剪点击「检测」
echo =======================================================
echo.
pause
`;
    fs.writeFileSync(batPath, batContent, { encoding: "utf8" });
    spawn("cmd.exe", ["/c", "start", "Antigravity 登录", batPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    }).unref();
  } else if (process.platform === "darwin") {
    spawn(
      "/usr/bin/osascript",
      ["-e", `tell application "Terminal" to do script ${JSON.stringify(cli)}`],
      { detached: true, stdio: "ignore" },
    ).unref();
  } else {
    spawn(cli, [], { detached: true, stdio: "ignore" }).unref();
  }
  return { opened: true, path: cli };
}

export function openAntigravityDocs() {
  const url = antigravityInstallHint().docs;
  if (process.platform === "win32") {
    spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } else {
    spawn("/usr/bin/open", [url], { detached: true, stdio: "ignore" }).unref();
  }
  return { opened: true, url };
}

async function completeViaAntigravity({ system, user, model, signal } = {}) {
  const settings = loadReviewSettings();
  const cli = findAntigravityCli(settings.antigravityPath);
  if (!cli) throw new Error("未找到 Antigravity CLI（agy）。请先在纠正设置里点「安装 agy」，或指定路径。");
  sweepStaleAgyWorkDirs();
  const work = agyReviewWorkspace();
  const taskPath = path.join(work, "review-task.md");
  const schemaPath = path.join(work, "review-schema.json");
  fs.writeFileSync(taskPath, buildAntigravityTask({ system, user }), "utf8");
  fs.writeFileSync(schemaPath, JSON.stringify(ANTIGRAVITY_REVIEW_SCHEMA), "utf8");
  const baseArgs = [
    "-p",
    buildAntigravityJudgePrompt(taskPath),
    "--add-dir",
    work,
    "--output-format",
    "json",
    "--print-timeout",
    "8m",
    "--disable-slash-commands",
    "--json-schema",
    schemaPath,
  ];
  const runOnce = async (modelFlags) => {
    const result = await runAntigravityCli([...baseArgs, ...modelFlags], {
      cwd: work,
      timeoutMs: 9 * 60 * 1000,
      signal,
      timeoutMessage:
        "纠正超时。agy 可能卡在授权。请点「登录」在可见终端跑一次 agy，完成 Gemini 套餐授权后再纠正。",
    });
    if (result.status !== 0 && !String(result.stdout || "").trim()) {
      throw new Error(formatAntigravityError(result.stderr, result.status));
    }
    return extractAntigravityResponse(result.stdout, result.stderr);
  };
  const plans = antigravityRetryPlans(model || settings.model);
  try {
    let lastError;
    for (let index = 0; index < plans.length; index += 1) {
      try {
        const text = await runOnce(plans[index]);
        const flags = plans[index];
        const usedIndex = flags.indexOf("--model");
        noteReviewTransport({
          provider: "antigravity",
          requestedModel: mapToAntigravityModel(model || settings.model),
          usedModel: usedIndex >= 0 ? flags[usedIndex + 1] : "(agy-default)",
          fallback: index > 0,
        });
        return text;
      } catch (error) {
        lastError = error;
        const canRetry =
          index < plans.length - 1 && isUnavailableAgyModel(error?.message);
        if (!canRetry) throw error;
      }
    }
    throw lastError;
  } finally {
    try {
      fs.unlinkSync(taskPath);
    } catch {
      /* agy may still hold the file; leftover is overwritten next run */
    }
    try {
      fs.unlinkSync(schemaPath);
    } catch {
      /* same */
    }
  }
}

export async function completeGeminiReview({
  system,
  user,
  signal = null,
} = {}) {
  const settings = loadReviewSettings();
  const model =
    settings.provider === "antigravity"
      ? mapToAntigravityModel(settings.model || DEFAULTS.model)
      : fromAntigravityModel(settings.model || DEFAULTS.model) || DEFAULTS.model;
  const started = Date.now();
  noteReviewTransport({
    provider: settings.provider,
    requestedModel: model,
    usedModel: model,
    fallback: false,
    ms: 0,
  });
  try {
    const text =
      settings.provider === "antigravity"
        ? await completeViaAntigravity({ system, user, model, signal })
        : await completeGeminiReviewHttp({ settings, model, system, user, signal });
    noteReviewTransport({ ms: Date.now() - started });
    return text;
  } catch (error) {
    noteReviewTransport({ ms: Date.now() - started });
    throw error;
  }
}

async function completeGeminiReviewHttp({ settings, model, system, user, signal }) {
  if (settings.provider === "vertex" && vertexAuthMode() === "express-key") {
    const express = await completeViaGenerateContent({ settings, model, system, user, signal });
    const text = textFromResult(express);
    if (text) return text;
    throw new Error(apiErrorMessage(express.data, express.raw, express.status));
  }
  const interaction = await completeViaInteractions({ settings, model, system, user, signal });
  const interactionText = textFromResult(interaction);
  if (interactionText) return interactionText;
  if (!shouldFallbackToGenerateContent(interaction.status, interaction.data, interaction.raw)) {
    throw new Error(apiErrorMessage(interaction.data, interaction.raw, interaction.status));
  }
  const legacy = await completeViaGenerateContent({ settings, model, system, user, signal });
  const text = textFromResult(legacy);
  if (!text) throw new Error(apiErrorMessage(legacy.data, legacy.raw, legacy.status));
  return text;
}
