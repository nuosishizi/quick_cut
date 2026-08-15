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
  parseGeminiTranscription,
  parseGroqTranscription,
  parseTimestampSeconds,
  tightenTranscriptWordTimes,
  saveGroqApiKey,
  saveSpeechSettings,
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

test("Groq keeps coherent speech segments and drops no-speech hallucinations", () => {
  const segments = parseGroqTranscription({
    segments: [
      {
        text: "The Bible doesn't just say God dislikes these sins.",
        start: 5,
        end: 8.2,
        no_speech_prob: 0.01,
        avg_logprob: -0.12,
      },
      {
        text: "fire. Bop ben that backfivar we see today.",
        start: 4.2,
        end: 5.1,
        no_speech_prob: 0.82,
        avg_logprob: -1.1,
      },
    ],
  });
  assert.equal(segments.length, 1);
  assert.match(segments[0].text, /The Bible doesn't just say/);
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

test("Gemini timestamps parse seconds and clock strings", () => {
  assert.equal(parseTimestampSeconds(12.5), 12.5);
  assert.equal(parseTimestampSeconds("01:02"), 62);
  assert.equal(parseTimestampSeconds("1:02:03"), 3723);
  const segments = parseGeminiTranscription({
    text: "hello world",
    segments: [
      {
        start: 1.2,
        end: 2.4,
        text: "hello world",
        words: [
          { text: "hello", start: 1.2, end: 1.6 },
          { text: "world", start: 1.7, end: 2.4 },
        ],
      },
    ],
  }, 10);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].start, 11.2);
  assert.equal(segments[1].text, "world");
});

test("Groq trailing silence is not kept on the previous sentence", () => {
  const tightened = tightenTranscriptWordTimes([
    { text: "soul.", start: 184.0, end: 187.2 },
    { text: "And", start: 187.25, end: 187.5 },
    { text: "here's", start: 187.5, end: 187.9 },
  ]);
  assert.ok(tightened[0].end <= 185.4);
  assert.ok(tightened[1].start < 185.7);
  assert.ok(tightened[1].start >= tightened[0].end);
});

test("speech engine can switch to Gemini without a Groq key", () => {
  assert.equal(canTranscribe(), false);
  const saved = saveSpeechSettings({ engine: "gemini" });
  assert.equal(saved.engine, "gemini");
  const status = modelStatus();
  assert.equal(status.preferredEngine, "gemini");
  assert.equal(status.engine === "gemini" || status.ready === false, true);
});
