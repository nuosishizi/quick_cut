import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "quickcut-groq-"));
process.env.QUICKCUT_SUPPORT_ROOT = scratch;
delete process.env.GROQ_API_KEY;

const {
  clearGroqApiKey,
  groqKeyStatus,
  parseGroqTranscription,
  saveGroqApiKey,
  modelStatus,
  canTranscribe,
} = await import("../src/whisper.mjs");

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test("Groq word timestamps become alignment segments in seconds", () => {
  const segments = parseGroqTranscription(
    {
      text: "hello world",
      words: [
        { word: "hello", start: 0.12, end: 0.4 },
        { word: "world", start: 0.41, end: 0.88 },
      ],
    },
    10,
  );
  assert.equal(segments.length, 2);
  assert.equal(segments[0].text, "hello");
  assert.equal(segments[0].start, 10.12);
  assert.equal(segments[1].end, 10.88);
  assert.equal(segments[0].timebase, "seconds");
});

test("Groq key is stored locally and never returned in full", () => {
  assert.equal(canTranscribe(), false);
  assert.equal(groqKeyStatus().configured, false);
  const saved = saveGroqApiKey("  gsk_test_quickcut_secret_key_12345  ");
  assert.equal(saved.configured, true);
  assert.equal(saved.source, "file");
  assert.match(saved.hint, /^gsk_••••/);
  assert.doesNotMatch(saved.hint, /secret/);
  const status = modelStatus();
  assert.equal(status.engine, "groq");
  assert.equal(status.ready, true);
  assert.equal(status.installed, true);
  assert.equal(canTranscribe(), true);
  const file = path.join(scratch, "secrets", "groq-api-key.txt");
  assert.equal(fs.readFileSync(file, "utf8").trim(), "gsk_test_quickcut_secret_key_12345");
  clearGroqApiKey();
  assert.equal(groqKeyStatus().configured, false);
  assert.equal(canTranscribe(), false);
});

test("empty or short Groq keys are rejected", () => {
  assert.throws(() => saveGroqApiKey(""), /请粘贴/);
  assert.throws(() => saveGroqApiKey("gsk_short"), /不完整/);
});
