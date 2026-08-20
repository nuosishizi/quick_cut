import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quickcut-vertex-test-"));
process.env.QUICKCUT_SUPPORT_ROOT = testRoot;

const ai = await import("../src/ai-settings.mjs");

test("saving an Express key selects Express mode and clears an old service account", () => {
  ai.saveReviewSettings({
    provider: "vertex",
    vertexServiceAccountJson: JSON.stringify({
      client_email: "test@example.invalid",
      private_key: "not-a-real-private-key",
      project_id: "old-project",
    }),
  });
  assert.equal(ai.vertexAuthMode(), "service-account");

  ai.saveReviewSettings({
    provider: "vertex",
    vertexKey: "AQ.Ab12345678901234567890123456789012345678901234567",
  });

  const settings = ai.loadReviewSettings();
  assert.equal(ai.vertexAuthMode(), "express-key");
  assert.equal(settings.vertexKey, true);
  assert.equal(settings.vertexServiceAccount, false);
});

test("Vertex Express review never calls the OAuth project or Interactions endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options = {}) => {
    request = { url: String(url), options };
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"decisions":[]}' }] } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  try {
    const text = await ai.completeGeminiReview({ system: "system", user: "user" });
    assert.equal(text, '{"decisions":[]}');
    assert.match(request.url, /^https:\/\/aiplatform\.googleapis\.com\/v1\/publishers\/google\/models\//);
    assert.match(request.url, /:generateContent$/);
    assert.doesNotMatch(request.url, /projects\/|interactions|[?&]key=/);
    assert.match(request.options.headers["x-goog-api-key"], /^AQ\.Ab/);
    assert.equal(request.options.headers.Authorization, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("importing a service account clears an old Express key", () => {
  ai.saveReviewSettings({
    provider: "vertex",
    vertexServiceAccountJson: JSON.stringify({
      client_email: "test@example.invalid",
      private_key: "not-a-real-private-key",
      project_id: "project-from-json",
    }),
  });

  const settings = ai.loadReviewSettings();
  assert.equal(ai.vertexAuthMode(), "service-account");
  assert.equal(settings.vertexKey, false);
  assert.equal(settings.vertexServiceAccount, true);
});

test.after(() => fs.rmSync(testRoot, { recursive: true, force: true }));
