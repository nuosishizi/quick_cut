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
  loadReviewSettings,
  reviewReady,
  saveReviewSettings,
} = await import("../src/ai-settings.mjs");

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test("review settings default to Gemini API and are not ready without a key", () => {
  const settings = loadReviewSettings();
  assert.equal(settings.provider, "gemini");
  assert.equal(settings.model, "gemini-2.5-flash");
  assert.equal(reviewReady(), false);
});

test("saving a Gemini key makes review ready", () => {
  const saved = saveReviewSettings({
    provider: "gemini",
    geminiKey: "AIzaSyTestQuickCutGeminiKey12345",
    model: "gemini-2.5-pro",
  });
  assert.equal(saved.provider, "gemini");
  assert.equal(saved.model, "gemini-2.5-pro");
  assert.equal(saved.geminiKey, true);
  assert.match(saved.geminiHint, /^AIza/);
  assert.equal(reviewReady(), true);
});
