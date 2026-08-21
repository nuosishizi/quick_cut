import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  analyzeHumSamples,
  analyzeNoiseProfile,
  audioDenoiseFilter,
  buildProfessionalDenoiseChain,
  denoiseConfigFingerprint,
  denoisePresetSettings,
  mediaBinary,
  normalizeDenoiseConfig,
  renderDenoisedTrack,
} from "../src/media.mjs";

test("professional denoise presets normalize and build the ordered stage chain", () => {
  const preset = denoisePresetSettings("mixed-heavy");
  assert.ok(preset.environment > 0.75);
  assert.ok(preset.residual > 0.5);

  const config = normalizeDenoiseConfig({
    mode: "studio-chain",
    preset: "mixed-heavy",
    humFrequency: "auto",
    detectedHumFrequency: 50,
  });
  const chain = buildProfessionalDenoiseChain(config);
  const humIndex = chain.indexOf("equalizer=f=50:");
  const environmentIndex = chain.indexOf("afftdn=nr=");
  const neuralIndex = chain.indexOf("arnndn=");
  const residualIndex = chain.lastIndexOf("afftdn=nr=");
  const restoreIndex = chain.indexOf("equalizer=f=3200:");
  assert.ok(chain.startsWith("aresample=48000,highpass="));
  assert.ok(humIndex > 0, "De-Hum must emit a 50 Hz notch when analysis detected 50 Hz");
  assert.ok(environmentIndex > humIndex, "environment reduction follows De-Hum");
  if (neuralIndex >= 0) assert.ok(neuralIndex > environmentIndex, "RNNoise follows the first spectral pass");
  assert.ok(residualIndex > environmentIndex, "residual pass is distinct and later");
  assert.ok(restoreIndex > residualIndex, "voice EQ is last");
  assert.ok(chain.endsWith("alimiter=limit=0.96"));
  assert.equal(chain.includes("anlmdn"), false, "professional chain avoids the unstable Windows anlmdn path");
  assert.equal(audioDenoiseFilter(config), chain);

  const fingerprint = denoiseConfigFingerprint(config);
  assert.notEqual(
    fingerprint,
    denoiseConfigFingerprint({ ...config, residual: config.residual + 0.1 }),
    "every stage parameter must invalidate a cached denoised track",
  );
});

test("hum analysis distinguishes 50 Hz and 60 Hz instead of always forcing a notch", () => {
  const sampleRate = 12000;
  const makeSamples = (frequency) => {
    const samples = new Float32Array(sampleRate * 3);
    for (let index = 0; index < samples.length; index += 1) {
      const time = index / sampleRate;
      samples[index] =
        0.22 * Math.sin(2 * Math.PI * frequency * time) +
        0.08 * Math.sin(2 * Math.PI * frequency * 2 * time) +
        0.02 * Math.sin(2 * Math.PI * 317 * time);
    }
    return samples;
  };
  assert.equal(analyzeHumSamples(makeSamples(50), sampleRate).humFrequency, 50);
  assert.equal(analyzeHumSamples(makeSamples(60), sampleRate).humFrequency, 60);
  assert.equal(analyzeHumSamples(makeSamples(317), sampleRate).humFrequency, 0);
});

test("professional chain detects hum and renders a playable video audio track", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quickcut-professional-denoise-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "noisy-video.mp4");
  const destination = path.join(root, "project", "media", "clean.m4a");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const ffmpeg = mediaBinary("ffmpeg");
  const generated = spawnSync(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=0x17202a:s=320x180:r=24:d=4",
    "-f", "lavfi", "-i", "sine=frequency=180:sample_rate=48000:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=900:sample_rate=48000:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=50:sample_rate=48000:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=100:sample_rate=48000:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=7200:sample_rate=48000:duration=4",
    "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.04:sample_rate=48000:duration=4:seed=24680",
    "-filter_complex",
    "[1:a]volume=0.30[a1];[2:a]volume=0.12[a2];[3:a]volume=0.24[a3];[4:a]volume=0.10[a4];[5:a]volume=0.04[a5];[a1][a2][a3][a4][a5][6:a]amix=inputs=6:normalize=0,alimiter=limit=0.96[mix]",
    "-map", "0:v", "-map", "[mix]", "-c:v", "mpeg4", "-q:v", "6",
    "-c:a", "aac", "-b:a", "192k", "-shortest", source,
  ], { encoding: "utf8", timeout: 30000, windowsHide: true });
  assert.equal(generated.status, 0, generated.stderr);

  const before = await analyzeNoiseProfile(source, { duration: 4 });
  assert.equal(before.humFrequency, 50, JSON.stringify(before));
  await renderDenoisedTrack(source, "studio-chain", 0.82, destination, {
    mode: "studio-chain",
    strength: 0.82,
    preset: "mixed-heavy",
    humFrequency: "auto",
  });
  assert.ok(fs.statSync(destination).size > 4096);
  assert.equal(
    fs.readdirSync(path.dirname(destination)).some((name) => name.includes(".partial")),
    false,
  );

  const after = await analyzeNoiseProfile(destination, { duration: 4 });
  assert.ok(
    after.score50Db < before.score50Db - 3,
    `50 Hz prominence should fall materially (${before.score50Db} -> ${after.score50Db})`,
  );
  const probed = spawnSync(mediaBinary("ffprobe"), [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", destination,
  ], { encoding: "utf8", timeout: 15000, windowsHide: true });
  assert.equal(probed.status, 0, probed.stderr);
  assert.ok(Math.abs(Number(probed.stdout.trim()) - 4) < 0.08, "denoise must preserve audio duration/sync");
});
