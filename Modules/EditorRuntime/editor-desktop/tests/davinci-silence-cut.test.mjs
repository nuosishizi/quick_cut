import test from "node:test";
import assert from "node:assert/strict";
import { analyzePauseFrames, samplesToFrames } from "../src/pausecut.mjs";

test("DaVinci silence cut: thresholdDb accurately removes low energy silence", () => {
  const sampleRate = 8000;
  // 1s tone (0.5 amp = -6dB), 1s silence (0.001 amp = -60dB), 1s tone (0.5 amp = -6dB)
  const samples = new Float32Array(sampleRate * 3);
  for (let i = 0; i < sampleRate; i++) samples[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5;
  // silence in middle
  for (let i = sampleRate * 2; i < sampleRate * 3; i++) samples[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5;

  const frames = samplesToFrames(samples, sampleRate, 20);
  const result = analyzePauseFrames(frames, {
    thresholdDb: -25.0,
    preRollSeconds: 0,
    postRollSeconds: 0,
    minDurationSeconds: 0.08,
  });

  assert.equal(result.pauses.length, 1);
  assert(Math.abs(result.pauses[0].start - 1.0) < 0.05);
  assert(Math.abs(result.pauses[0].end - 2.0) < 0.05);
});

test("DaVinci silence cut: head and tail frame buffers preserve pre-roll and post-roll", () => {
  const sampleRate = 8000;
  const samples = new Float32Array(sampleRate * 3);
  for (let i = 0; i < sampleRate; i++) samples[i] = 0.4;
  for (let i = sampleRate * 2; i < sampleRate * 3; i++) samples[i] = 0.4;

  const frames = samplesToFrames(samples, sampleRate, 20);
  const result = analyzePauseFrames(frames, {
    thresholdDb: -25.0,
    preRollSeconds: 0.10, // 头部之前保留 0.1s
    postRollSeconds: 0.10, // 尾部之后保留 0.1s
    minDurationSeconds: 0.08,
  });

  assert.equal(result.removals.length, 1);
  // Cut should start at ~1.10s and end at ~1.90s
  assert(Math.abs(result.removals[0].start - 1.10) < 0.06);
  assert(Math.abs(result.removals[0].end - 1.90) < 0.06);
});
