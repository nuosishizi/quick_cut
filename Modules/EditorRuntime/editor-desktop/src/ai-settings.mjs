import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { supportRoot } from "./media.mjs";

export const GEMINI_MODELS = [
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash（快）" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro（严审经文）" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite" },
  { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
];

const DEFAULTS = {
  provider: "gemini",
  model: "gemini-2.5-flash",
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

export function loadReviewSettings() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  } catch {
    stored = {};
  }
  const provider = stored.provider === "vertex" ? "vertex" : "gemini";
  const model = GEMINI_MODELS.some((item) => item.id === stored.model)
    ? stored.model
    : DEFAULTS.model;
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
    models: GEMINI_MODELS,
  };
}

export function saveReviewSettings(input = {}) {
  const current = loadReviewSettings();
  const next = {
    provider: input.provider === "vertex" ? "vertex" : input.provider === "gemini" ? "gemini" : current.provider,
    model: GEMINI_MODELS.some((item) => item.id === input.model) ? input.model : current.model,
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

export function reviewReady() {
  const settings = loadReviewSettings();
  if (settings.provider === "vertex")
    return Boolean(
      settings.vertexProject && (vertexApiKey() || vertexServiceAccount()),
    );
  return Boolean(geminiApiKey());
}

export async function completeGeminiReview({
  system,
  user,
  signal = null,
} = {}) {
  const settings = loadReviewSettings();
  const model = settings.model || DEFAULTS.model;
  const body = {
    systemInstruction: { parts: [{ text: String(system || "") }] },
    contents: [{ role: "user", parts: [{ text: String(user || "") }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
    },
  };
  let url = "";
  const headers = { "Content-Type": "application/json" };
  if (settings.provider === "vertex") {
    if (!settings.vertexProject) throw new Error("请先填写 Vertex 项目 ID。");
    const location = settings.vertexLocation || "us-central1";
    url = `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(settings.vertexProject)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
    const sa = vertexServiceAccount();
    const key = vertexApiKey();
    if (sa) headers.Authorization = `Bearer ${await accessTokenFromServiceAccount(sa)}`;
    else if (key) url += `?key=${encodeURIComponent(key)}`;
    else throw new Error("请先保存 Vertex Key 或服务账号 JSON。");
  } else {
    const key = geminiApiKey();
    if (!key) throw new Error("请先保存 Gemini API Key。");
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  const raw = await response.text();
  let data = {};
  try {
    data = JSON.parse(raw);
  } catch {
    data = {};
  }
  if (!response.ok) {
    const message = data?.error?.message || raw.slice(0, 180) || `Gemini 纠正失败（${response.status}）`;
    throw new Error(message);
  }
  const text = (data?.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => String(part?.text || ""))
    .join("\n")
    .trim();
  if (!text) throw new Error("Gemini 没有返回纠正结果。");
  return text;
}
