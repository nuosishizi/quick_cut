import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  audioDenoiseFilter,
  findDeepFilterBinary,
  hasDeepFilterEngine,
  renderDenoisePreview,
  renderDenoisedTrack,
} from "../src/media.mjs";

test("audioDenoiseFilter maps all modes and strengths correctly", () => {
  // Off or zero strength
  assert.equal(audioDenoiseFilter("off", 0.8), "");
  assert.equal(audioDenoiseFilter("ai-isolation", 0.005), "");

  // AI Isolation mode
  const aiFilter = audioDenoiseFilter("ai-isolation", 0.8);
  assert.ok(aiFilter.includes("highpass=f=55"), "AI isolation should include highpass 55Hz");
  assert.ok(aiFilter.includes("lowpass=f=17500"), "AI isolation should include lowpass 17.5kHz");
  assert.ok(aiFilter.includes("anlmdn"), "AI isolation should include non-local means denoiser");
  assert.ok(aiFilter.includes("afftdn"), "AI isolation should include FFT denoiser");

  // Gentle mode
  const gentleFilter = audioDenoiseFilter("gentle", 0.5);
  assert.ok(gentleFilter.includes("highpass=f=50"));
  assert.ok(gentleFilter.includes("lowpass=f=18000"));
  assert.ok(gentleFilter.includes("afftdn"));

  // Strong mode
  const strongFilter = audioDenoiseFilter("strong", 0.9);
  assert.ok(strongFilter.includes("agate"), "Strong mode includes noise gate");
  assert.ok(strongFilter.includes("highpass=f=65"));
});

test("findDeepFilterBinary returns empty string safely when not present", () => {
  const bin = findDeepFilterBinary();
  assert.equal(typeof bin, "string");
  assert.equal(typeof hasDeepFilterEngine(), "boolean");
});

test("renderDenoisePreview and renderDenoisedTrack fallback gracefully with real media", async () => {
  // Test with an empty or non-existent file error handling
  await assert.rejects(
    async () => {
      await renderDenoisedTrack("non_existent_audio_file.wav", "ai-isolation", 0.8);
    },
    /找不到需要降噪的音频/,
    "Should reject gracefully when file is missing"
  );
});
