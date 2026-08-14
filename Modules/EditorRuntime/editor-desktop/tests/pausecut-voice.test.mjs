import assert from "node:assert/strict";
import test from "node:test";
import { analyzePauseFrames, samplesToFrames } from "../src/pausecut.mjs";

test("fast edge detection ignores steady room noise and keeps 0.1 seconds around voice", () => {
  const sampleRate = 8000,
    duration = 4,
    samples = new Float32Array(sampleRate * duration);
  for (let index = 0; index < samples.length; index += 1) {
    const time = index / sampleRate;
    if (time < 1 || time >= 3) {
      samples[index] = 0.004 * Math.sin(2 * Math.PI * 60 * time);
      continue;
    }
    const envelope = 0.45 + 0.55 * Math.sin(2 * Math.PI * 3.2 * time) ** 2;
    samples[index] = envelope * (
      0.07 * Math.sin(2 * Math.PI * 185 * time) +
      0.035 * Math.sin(2 * Math.PI * 370 * time)
    );
  }
  const result = analyzePauseFrames(samplesToFrames(samples, sampleRate), {
    keepSeconds: 0.3,
    edgeKeepSeconds: 0.1,
  });
  assert.equal(result.diagnostics.voiceDetected, true);
  assert.ok(result.headTrim > 0.82 && result.headTrim < 0.98);
  assert.ok(result.tailTrim > 0.82 && result.tailTrim < 0.98);
  assert.ok(Math.abs(result.diagnostics.voiceStart - 1) < 0.08);
  assert.ok(Math.abs(result.diagnostics.voiceEnd - 3) < 0.08);
});

test("short clicks do not become the beginning of speech", () => {
  const sampleRate = 8000,
    samples = new Float32Array(sampleRate * 2);
  samples[Math.round(sampleRate * 0.25)] = 0.9;
  for (let index = sampleRate; index < samples.length; index += 1) {
    const time = index / sampleRate;
    samples[index] = 0.08 * Math.sin(2 * Math.PI * 210 * time);
  }
  const result = analyzePauseFrames(samplesToFrames(samples, sampleRate), {
    edgeKeepSeconds: 0.1,
  });
  assert.ok(result.diagnostics.voiceStart > 0.92);
});
