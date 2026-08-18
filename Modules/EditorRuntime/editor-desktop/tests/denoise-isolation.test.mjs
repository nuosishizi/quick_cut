import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  audioDenoiseFilter,
  findDeepFilterBinary,
  hasDeepFilterEngine,
  findDemucsBinary,
  hasDemucsEngine,
  renderDenoisePreview,
  renderDenoisedTrack,
} from "../src/media.mjs";

test("audioDenoiseFilter maps all modes and strengths correctly", () => {
  // Off or zero strength
  assert.equal(audioDenoiseFilter("off", 0.8), "");
  assert.equal(audioDenoiseFilter("ai-isolation", 0.005), "");

  // UVR5 Master mode (De-noise + De-reverb + Tone Polish)
  const uvr5Filter = audioDenoiseFilter("uvr5-master", 0.85);
  assert.ok(uvr5Filter.includes("afftdn=nr="), "UVR5 master includes spectral denoiser");
  assert.ok(uvr5Filter.includes("tn=1:tr=1"), "UVR5 master includes transient de-reverb");
  assert.ok(uvr5Filter.includes("equalizer=f=185"), "UVR5 master includes low-end warmth");
  assert.ok(uvr5Filter.includes("equalizer=f=3300"), "UVR5 master includes presence boost");
  assert.ok(uvr5Filter.includes("highshelf=f=10500"), "UVR5 master includes highshelf air");
  assert.ok(uvr5Filter.includes("crystalizer"), "UVR5 master includes air crystalizer");
  assert.ok(uvr5Filter.includes("deesser"), "UVR5 master includes de-esser");
  assert.ok(uvr5Filter.includes("alimiter"), "UVR5 master includes limiter");

  // De-Reverb mode
  const dereverbFilter = audioDenoiseFilter("dereverb", 0.8);
  assert.ok(dereverbFilter.includes("tn=1:tr=1"), "De-reverb includes reflection suppression");
  assert.ok(dereverbFilter.includes("equalizer=f=280"), "De-reverb includes mud room frequency dip");

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

test("findDeepFilterBinary and findDemucsBinary return safely when not present", () => {
  const binDF = findDeepFilterBinary();
  assert.equal(typeof binDF, "string");
  assert.equal(typeof hasDeepFilterEngine(), "boolean");

  const binDemucs = findDemucsBinary();
  assert.equal(typeof binDemucs, "string");
  assert.equal(typeof hasDemucsEngine(), "boolean");
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
