import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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

const DEFAULTS = {
  provider: "gemini",
  model: "gemini-3.7-flash",
  vertexProject: "",
  vertexLocation: "us-central1",
  promptStrict: "",
  promptNatural: "",
};

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
  return isTextReviewModel(id);
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

export function mergeModelCatalog(live = [], selected = "") {
  const byId = new Map();
  for (const item of [...GEMINI_MODELS, ...live]) {
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
  const provider = stored.provider === "vertex" ? "vertex" : "gemini";
  const model = isSelectableModel(stored.model) ? normalizeModelId(stored.model) : DEFAULTS.model;
  return {
    provider,
    model,
    vertexProject: String(stored.vertexProject || "").trim(),
    vertexLocation: String(stored.vertexLocation || DEFAULTS.vertexLocation).trim() || "us-central1",
    promptStrict: String(stored.promptStrict || ""),
    promptNatural: String(stored.promptNatural || ""),
    geminiKey: Boolean(process.env.GEMINI_API_KEY || readSecret("gemini-api-key.txt")),
    geminiHint: maskSecret(process.env.GEMINI_API_KEY || readSecret("gemini-api-key.txt")),
    vertexKey: Boolean(process.env.VERTEX_API_KEY || readSecret("vertex-api-key.txt")),
    vertexHint: maskSecret(process.env.VERTEX_API_KEY || readSecret("vertex-api-key.txt")),
    vertexServiceAccount: Boolean(readSecret("vertex-sa.json")),
    models: mergeModelCatalog([], model),
    modelSource: "fallback",
  };
}

export function saveReviewSettings(input = {}) {
  const current = loadReviewSettings();
  const next = {
    provider: input.provider === "vertex" ? "vertex" : input.provider === "gemini" ? "gemini" : current.provider,
    model: isSelectableModel(input.model) ? normalizeModelId(input.model) : current.model,
    vertexProject:
      input.vertexProject !== undefined ? String(input.vertexProject || "").trim() : current.vertexProject,
    vertexLocation:
      input.vertexLocation !== undefined
        ? String(input.vertexLocation || "").trim() || "us-central1"
        : current.vertexLocation,
    promptStrict: input.promptStrict !== undefined ? String(input.promptStrict || "") : current.promptStrict,
    promptNatural: input.promptNatural !== undefined ? String(input.promptNatural || "") : current.promptNatural,
  };
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
  if (settings.provider === "vertex") {
    if (vertexAuthMode() === "express-key") return true;
    return Boolean(settings.vertexProject && vertexServiceAccount());
  }
  return Boolean(geminiApiKey());
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
      models: mergeModelCatalog(cache.models, settings.model),
      modelSource: "live",
      modelFetchedAt: cache.fetchedAt,
    };
  }
  try {
    let live = [];
    if (settings.provider === "vertex") {
      if (vertexAuthMode() !== "service-account") throw new Error("vertex-express-has-no-model-list");
      if (!reviewReady()) throw new Error("no-vertex-auth");
      live = await fetchVertexModels(settings, await vertexOAuthHeaders());
    } else {
      const key = geminiApiKey();
      if (!key) throw new Error("no-gemini-key");
      live = await fetchGeminiApiModels(key);
    }
    const models = mergeModelCatalog(live, settings.model);
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
      models: mergeModelCatalog(stale, settings.model),
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

export async function completeGeminiReview({
  system,
  user,
  signal = null,
} = {}) {
  const settings = loadReviewSettings();
  const model = settings.model || DEFAULTS.model;
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
