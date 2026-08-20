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
  ANTIGRAVITY_MODELS,
  GEMINI_MODELS,
  antigravityInstallHint,
  antigravitySearchPaths,
  buildAntigravityTask,
  buildGeminiGenerateContentBody,
  buildGeminiInteractionBody,
  buildVertexExpressGenerateContentUrl,
  checkAntigravityStatus,
  completeGeminiMedia,
  completeGeminiReview,
  extractAntigravityResponse,
  extractApiErrorMessage,
  extractGeminiOutputText,
  formatAntigravityError,
  geminiMediaReady,
  isTextReviewModel,
  listReviewModels,
  loadReviewSettings,
  antigravityModelArgs,
  fromAntigravityModel,
  isUnavailableAgyModel,
  mapToAntigravityModel,
  mergeModelCatalog,
  parseAgyModels,
  parseListedModels,
  removeAgyWorkDir,
  reviewReady,
  saveReviewSettings,
  setAntigravityTestHooks,
  shouldFallbackToGenerateContent,
  vertexAuthMode,
} = await import("../src/ai-settings.mjs");

test.afterEach(() => setAntigravityTestHooks(null));
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

test("Vertex API keys are treated as Express and do not need a project", () => {
  const saved = saveReviewSettings({
    provider: "vertex",
    vertexProject: "",
    vertexKey: "AIzaSyTestQuickCutVertexKey12345",
  });
  assert.equal(saved.provider, "vertex");
  assert.equal(vertexAuthMode(), "express-key");
  assert.equal(reviewReady(), true);
  assert.equal(
    buildVertexExpressGenerateContentUrl("gemini-3.7-flash"),
    "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.7-flash:generateContent",
  );
});

test("Vertex API keys call Express generateContent and never hit project Interactions", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"keep":[8]}' }] } }],
        }),
    };
  };
  try {
    const text = await completeGeminiReview({ system: "Be strict.", user: "u" });
    assert.equal(text, '{"keep":[8]}');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /aiplatform\.googleapis\.com\/v1\/publishers\/google\/models\/gemini-3\.1-pro-preview:generateContent/);
    assert.doesNotMatch(calls[0].url, /interactions/);
    assert.doesNotMatch(calls[0].url, /projects\//);
    assert.doesNotMatch(calls[0].url, /[?&]key=/);
    assert.equal(calls[0].options.headers["x-goog-api-key"], "AIzaSyTestQuickCutVertexKey12345");
  } finally {
    globalThis.fetch = original;
  }
});

test("Vertex Express does not query OAuth-only model list endpoints", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    throw new Error("should not fetch Vertex publisher models with an API key");
  };
  try {
    const listed = await listReviewModels({ refresh: true });
    assert.equal(calls.length, 0);
    assert.ok(listed.models.some((item) => item.id === "gemini-3.7-flash"));
  } finally {
    globalThis.fetch = original;
  }
});

test("API-key-rejected Vertex errors are parsed and can fall back", () => {
  const payload = [
    {
      error: {
        code: 401,
        message: "API keys are not supported by this API. Expected OAuth2 access token or other authentication credentials that assert a principal.",
      },
    },
  ];
  assert.match(extractApiErrorMessage(payload, JSON.stringify(payload), 401), /API keys are not supported/);
  assert.equal(shouldFallbackToGenerateContent(401, payload, JSON.stringify(payload)), true);
});

test("review falls back to generateContent if Interactions is unavailable", async () => {
  saveReviewSettings({ provider: "gemini" });
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

test("Antigravity CLI slugs are mapped from Gemini API model ids", () => {
  assert.deepEqual(antigravityModelArgs("gemini-3.7-flash-high"), ["--model", "gemini-3.7-flash-high"]);
  assert.ok(!antigravityModelArgs("gemini-3.7-flash-high").includes("--effort"));
  assert.equal(mapToAntigravityModel("gemini-3.7-flash"), "gemini-3.7-flash-high");
  assert.equal(
    mapToAntigravityModel("gemini-3.7-flash", [{ id: "gemini-3.7-flash-medium" }]),
    "gemini-3.7-flash-medium",
  );
  assert.ok(ANTIGRAVITY_MODELS.some((item) => item.id === "gemini-3.7-flash-high"));
  const parsed = parseAgyModels(`
gemini-3.7-flash-high     Gemini 3.7 Flash (High)
gemini-3.1-pro-high       Gemini 3.1 Pro (High)
claude-sonnet-4-6         Claude Sonnet 4.6
`);
  assert.deepEqual(
    parsed.map((item) => item.id),
    ["gemini-3.7-flash-high", "gemini-3.1-pro-high"],
  );
});

test("Antigravity JSON envelope becomes review text and login errors are readable", () => {
  assert.equal(
    extractAntigravityResponse(
      JSON.stringify({
        status: "SUCCESS",
        response: '{"decisions":[{"id":"1","decision":"cut"}]}',
      }),
    ),
    '{"decisions":[{"id":"1","decision":"cut"}]}',
  );
  assert.equal(
    extractAntigravityResponse(
      JSON.stringify({
        status: "SUCCESS",
        response: "",
        structured_output: { decisions: [{ id: "2", decision: "keep" }] },
      }),
    ),
    '{"decisions":[{"id":"2","decision":"keep"}]}',
  );
  assert.match(formatAntigravityError("authentication required"), /还没有登录/);
  assert.throws(
    () =>
      extractAntigravityResponse(
        JSON.stringify({ status: "SUCCESS", response: "", json_schema: { type: "object" } }),
      ),
    /没有返回判定 JSON/,
  );
  assert.match(formatAntigravityError("Antigravity CLI 超时。"), /登录/);
  assert.throws(
    () =>
      extractAntigravityResponse(
        JSON.stringify({ status: "ERROR", response: "", error: "authentication required" }),
      ),
    /还没有登录/,
  );
});

test("Antigravity provider is ready without an API key once agy is found", () => {
  setAntigravityTestHooks({ resolveCli: () => path.join(scratch, "agy.exe") });
  const saved = saveReviewSettings({ provider: "antigravity", model: "gemini-3.7-flash" });
  assert.equal(saved.provider, "antigravity");
  assert.equal(saved.model, "gemini-3.7-flash-high");
  assert.equal(reviewReady(), true);
  assert.equal(geminiMediaReady(), false);
});

test("Antigravity review calls agy -p and never hits Gemini HTTP APIs", async () => {
  const calls = [];
  setAntigravityTestHooks({
    resolveCli: () => path.join(scratch, "agy.exe"),
    exec: async (args) => {
      calls.push(args);
      return {
        status: 0,
        stdout: JSON.stringify({
          status: "SUCCESS",
          response: '{"decisions":[{"id":"9","decision":"cut","reason":"reread"}]}',
        }),
        stderr: "",
      };
    },
  });
  saveReviewSettings({ provider: "antigravity", model: "gemini-3.7-flash-high" });
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Antigravity review must not call Gemini HTTP APIs");
  };
  try {
    const text = await completeGeminiReview({
      system: "Be strict.",
      user: '{"ids":[1]}',
    });
    assert.equal(text, '{"decisions":[{"id":"9","decision":"cut","reason":"reread"}]}');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "-p");
    assert.ok(calls[0].includes("--output-format"));
    assert.ok(calls[0].includes("json"));
    assert.ok(calls[0].includes("--print-timeout"));
    assert.ok(calls[0].includes("8m"));
    assert.ok(calls[0].includes("--disable-slash-commands"));
    assert.ok(calls[0].includes("--add-dir"));
    assert.match(calls[0][1], /review-task\.md/);
    assert.ok(!calls[0].includes("--effort"));
    assert.ok(calls[0].includes("--model"));
    assert.ok(calls[0].includes("gemini-3.7-flash-high"));
    assert.ok(!calls[0].includes("--dangerously-skip-permissions"));
    assert.match(buildAntigravityTask({ system: "Be strict.", user: "x" }), /Be strict\.\n\nx/);
  } finally {
    globalThis.fetch = original;
  }
});

test("Antigravity lists Gemini slugs from agy models", async () => {
  setAntigravityTestHooks({
    resolveCli: () => path.join(scratch, "agy.exe"),
    exec: async (args) => {
      assert.deepEqual(args, ["models"]);
      return {
        status: 0,
        stdout: "gemini-3.8-flash-high     Gemini 3.8 Flash (High)\nclaude-sonnet-4-6         Claude\n",
        stderr: "",
      };
    },
  });
  saveReviewSettings({ provider: "antigravity" });
  const listed = await listReviewModels({ refresh: true });
  assert.equal(listed.modelSource, "live");
  assert.ok(listed.models.some((item) => item.id === "gemini-3.8-flash-high"));
  assert.ok(!listed.models.some((item) => item.id === "claude-sonnet-4-6"));
});

test("Vertex and Gemini API drop Antigravity effort suffixes from model ids", () => {
  saveReviewSettings({ provider: "antigravity", model: "gemini-3.7-flash-high" });
  const switched = saveReviewSettings({ provider: "vertex" });
  assert.equal(switched.provider, "vertex");
  assert.equal(switched.model, "gemini-3.7-flash");
  assert.equal(fromAntigravityModel("gemini-3.6-flash-high"), "gemini-3.6-flash");
  assert.equal(isUnavailableAgyModel("Publisher model was not found or your project does not have access to it"), true);
});

test("Antigravity retries without --model when the pinned slug is unavailable", async () => {
  const calls = [];
  setAntigravityTestHooks({
    resolveCli: () => path.join(scratch, "agy.exe"),
    exec: async (args) => {
      calls.push(args);
      if (args.includes("gemini-3.7-flash-high")) {
        return {
          status: 1,
          stdout: JSON.stringify({
            status: "ERROR",
            response: "",
            error:
              "Publisher model `projects/1/locations/asia-southeast1/publishers/google/models/gemini-3.7-flash-high` was not found or your project does not have access to it.",
          }),
          stderr: "",
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          status: "SUCCESS",
          response: '{"decisions":[{"id":"4","decision":"keep"}]}',
        }),
        stderr: "",
      };
    },
  });
  saveReviewSettings({ provider: "antigravity", model: "gemini-3.7-flash-high" });
  const text = await completeGeminiReview({ system: "Be strict.", user: "u" });
  assert.equal(text, '{"decisions":[{"id":"4","decision":"keep"}]}');
  assert.ok(calls.length >= 2);
  assert.ok(calls[0].includes("gemini-3.7-flash-high"));
  assert.ok(calls[1].includes("gemini-3.6-flash-high"));
});

test("Antigravity cannot be used as Gemini speech-to-text", async () => {
  setAntigravityTestHooks({ resolveCli: () => path.join(scratch, "agy.exe") });
  saveReviewSettings({ provider: "antigravity" });
  await assert.rejects(
    () => completeGeminiMedia({ system: "stt", input: [{ type: "text", text: "x" }] }),
    /只用于文稿纠正/,
  );
});

test("official Windows agy location is searched and leftover work dirs can be ignored", () => {
  const paths = antigravitySearchPaths().join("|").replaceAll("\\", "/");
  assert.match(paths, /\/agy\/bin\/agy/);
  assert.match(antigravityInstallHint().command, /install\.ps1|install\.sh/);
  const gone = path.join(scratch, "quickcut-agy-missing");
  assert.equal(removeAgyWorkDir(gone), true);
  const locked = path.join(scratch, "quickcut-agy-locked");
  fs.mkdirSync(locked, { recursive: true });
  assert.equal(removeAgyWorkDir(locked), true);
});

test("Antigravity status distinguishes missing, login required and ready", async () => {
  setAntigravityTestHooks({ resolveCli: () => "" });
  saveReviewSettings({ provider: "antigravity" });
  const missing = await checkAntigravityStatus();
  assert.equal(missing.antigravityState, "missing");
  assert.match(missing.antigravityHint, /安装/);

  setAntigravityTestHooks({
    resolveCli: () => path.join(scratch, "agy.exe"),
    exec: async () => ({ status: 1, stdout: "", stderr: "authentication required" }),
  });
  const needLogin = await checkAntigravityStatus();
  assert.equal(needLogin.antigravityState, "need-login");
  assert.equal(needLogin.antigravityLoggedIn, false);

  setAntigravityTestHooks({
    resolveCli: () => path.join(scratch, "agy.exe"),
    exec: async () => ({
      status: 0,
      stdout: "gemini-3.7-flash-high     Gemini 3.7 Flash (High)\n",
      stderr: "",
    }),
  });
  const ready = await checkAntigravityStatus();
  assert.equal(ready.antigravityState, "ready");
  assert.equal(ready.antigravityLoggedIn, true);
});

test("opening review settings does not spawn agy", async () => {
  let called = 0;
  setAntigravityTestHooks({
    resolveCli: () => path.join(scratch, "agy.exe"),
    exec: async () => {
      called += 1;
      return { status: 0, stdout: "gemini-3.7-flash-high     Gemini 3.7 Flash (High)\n", stderr: "" };
    },
  });
  saveReviewSettings({ provider: "antigravity" });
  const listed = await listReviewModels({ refresh: false });
  assert.equal(called, 0);
  assert.ok(listed.models.some((item) => item.id === "gemini-3.7-flash-high"));
  const refreshed = await listReviewModels({ refresh: true });
  assert.equal(called, 1);
  assert.equal(refreshed.modelSource, "live");
});

test("successful Antigravity review is not lost if leftover files cannot be deleted", async () => {
  setAntigravityTestHooks({
    resolveCli: () => path.join(scratch, "agy.exe"),
    exec: async () => ({
      status: 0,
      stdout: JSON.stringify({
        status: "SUCCESS",
        response: '{"decisions":[{"id":"1","decision":"keep"}]}',
      }),
      stderr: "",
    }),
  });
  saveReviewSettings({ provider: "antigravity" });
  const work = path.join(scratch, "agy-review");
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, "review-task.md"), "keep", "utf8");
  const text = await completeGeminiReview({ system: "Be strict.", user: "u" });
  assert.equal(text, '{"decisions":[{"id":"1","decision":"keep"}]}');
});
