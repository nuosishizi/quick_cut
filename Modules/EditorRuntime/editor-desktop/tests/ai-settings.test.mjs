import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "quickcut-ai-"));
process.env.QUICKCUT_SUPPORT_ROOT = scratch;
delete process.env.GEMINI_API_KEY;
delete process.env.VERTEX_API_KEY;

const {
  GEMINI_MODELS,
  buildGeminiGenerateContentBody,
  buildGeminiInteractionBody,
  completeGeminiReview,
  extractGeminiOutputText,
  isTextReviewModel,
  listReviewModels,
  loadReviewSettings,
  mergeModelCatalog,
  parseListedModels,
  reviewReady,
  saveReviewSettings,
} = await import("../src/ai-settings.mjs");

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test("review settings default to Gemini 3.7 Flash and are not ready without a key", () => {
  const settings = loadReviewSettings();
  assert.equal(settings.provider, "gemini");
  assert.equal(settings.model, "gemini-3.7-flash");
  assert.equal(reviewReady(), false);
  assert.ok(GEMINI_MODELS.some((item) => item.id === "gemini-3.7-flash"));
  assert.ok(GEMINI_MODELS.some((item) => item.id === "gemini-3.1-pro-preview"));
  assert.ok(!GEMINI_MODELS.some((item) => item.id === "gemini-2.0-flash"));
});

test("saving a Gemini key makes review ready and keeps newer models", () => {
  const saved = saveReviewSettings({
    provider: "gemini",
    geminiKey: "AIzaSyTestQuickCutGeminiKey12345",
    model: "gemini-3.1-pro-preview",
  });
  assert.equal(saved.provider, "gemini");
  assert.equal(saved.model, "gemini-3.1-pro-preview");
  assert.equal(saved.geminiKey, true);
  assert.match(saved.geminiHint, /^AIza/);
  assert.equal(reviewReady(), true);
});

test("only text Gemini models are offered for manuscript review", () => {
  assert.equal(isTextReviewModel("gemini-3.7-flash"), true);
  assert.equal(isTextReviewModel("models/gemini-3.6-flash"), true);
  assert.equal(isTextReviewModel("gemini-3.1-flash-image"), false);
  assert.equal(isTextReviewModel("gemini-3.1-flash-tts-preview"), false);
  assert.equal(isTextReviewModel("gemini-3.1-flash-live-preview"), false);
  assert.equal(isTextReviewModel("gemini-embedding-001"), false);
  const parsed = parseListedModels({
    models: [
      { name: "models/gemini-3.7-flash", displayName: "Gemini 3.7 Flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.1-flash-image", displayName: "Nano Banana 2" },
      { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
    ],
  });
  assert.deepEqual(parsed.map((item) => item.id), ["gemini-3.7-flash"]);
});

test("live model lists are merged with the official fallback catalog", () => {
  const models = mergeModelCatalog(
    [{ id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" }],
    "gemini-3.8-flash",
  );
  assert.equal(models[0].id, "gemini-3.8-flash");
  assert.ok(models.some((item) => item.id === "gemini-3.7-flash"));
});

test("Interactions request uses the current official body, not generateContent", () => {
  const body = buildGeminiInteractionBody({
    model: "gemini-3.7-flash",
    system: "Be strict.",
    user: '{"ids":[1]}',
  });
  assert.equal(body.model, "gemini-3.7-flash");
  assert.equal(body.store, false);
  assert.equal(body.system_instruction, "Be strict.");
  assert.equal(body.input, '{"ids":[1]}');
  assert.equal(body.generation_config.temperature, 0);
  assert.equal(body.generation_config.thinking_level, "low");
  assert.deepEqual(body.response_format, [{ type: "text", mime_type: "application/json" }]);
  const legacy = buildGeminiGenerateContentBody({ system: "Be strict.", user: "x" });
  assert.equal(legacy.generationConfig.responseMimeType, "application/json");
});

test("Gemini output parsing accepts Interactions steps and legacy candidates", () => {
  assert.equal(
    extractGeminiOutputText({
      steps: [
        { type: "user_input", content: [{ type: "text", text: "prompt" }] },
        { type: "model_output", content: [{ type: "text", text: '{"keep":[1]}' }] },
      ],
    }),
    '{"keep":[1]}',
  );
  assert.equal(
    extractGeminiOutputText({
      candidates: [{ content: { parts: [{ text: '{"keep":[2]}' }] } }],
    }),
    '{"keep":[2]}',
  );
});

test("settings pull live Gemini text models from the official list endpoint", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /generativelanguage\.googleapis\.com\/v1beta\/models/);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          models: [
            { name: "models/gemini-3.7-flash", displayName: "Gemini 3.7 Flash" },
            { name: "models/gemini-3.9-flash", displayName: "Gemini 3.9 Flash" },
            { name: "models/gemini-3.1-flash-image", displayName: "Nano Banana 2" },
          ],
        }),
    };
  };
  try {
    const listed = await listReviewModels({ refresh: true });
    assert.equal(listed.modelSource, "live");
    assert.ok(listed.models.some((item) => item.id === "gemini-3.9-flash"));
    assert.ok(!listed.models.some((item) => item.id === "gemini-3.1-flash-image"));
  } finally {
    globalThis.fetch = original;
  }
});

test("review calls the Interactions API first", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ output_text: '{"keep":[9]}' }),
    };
  };
  try {
    const text = await completeGeminiReview({ system: "Be strict.", user: '{"ids":[1]}' });
    assert.equal(text, '{"keep":[9]}');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /generativelanguage\.googleapis\.com\/v1beta\/interactions/);
    assert.equal(calls[0].options.headers["x-goog-api-key"], "AIzaSyTestQuickCutGeminiKey12345");
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.store, false);
    assert.equal(body.model, "gemini-3.1-pro-preview");
  } finally {
    globalThis.fetch = original;
  }
});

test("review falls back to generateContent if Interactions is unavailable", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("/interactions")) {
      return {
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ error: { message: "Method not found" } }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"keep":[3]}' }] } }],
        }),
    };
  };
  try {
    const text = await completeGeminiReview({ system: "Be strict.", user: "u" });
    assert.equal(text, '{"keep":[3]}');
    assert.equal(calls.length, 2);
    assert.match(calls[1].url, /:generateContent/);
  } finally {
    globalThis.fetch = original;
  }
});
