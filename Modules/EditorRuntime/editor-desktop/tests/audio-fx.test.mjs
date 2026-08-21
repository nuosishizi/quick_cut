import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  AUDIO_FX_MAX_SLOTS,
  audioFxFilters,
  buildAudioFxFilterChain,
  defaultAudioFxParams,
  learnNoiseBandProfile,
  normalizeAudioFxRack,
} from "../src/audio-fx.mjs";
import {
  buildAudioExportGraph,
  exportStatus,
  learnAudioFxNoiseProfile,
  mediaBinary,
  renderAudioFxPreview,
  renderAudioFxTrack,
  startExport,
} from "../src/media.mjs";

const effect = (type, params = {}, id = type) => ({ id, type, enabled: true, params });

test("Fairlight-style rack keeps six ordered slots and every effect has a real filter", () => {
  const types = [
    "voice-isolation", "noise-reduction", "de-hummer", "dialogue-separator",
    "de-esser", "expander-gate", "parametric-eq", "compressor-limiter",
  ];
  const rack = normalizeAudioFxRack(types.map((type) => effect(type)));
  assert.equal(rack.length, AUDIO_FX_MAX_SLOTS);
  assert.deepEqual(rack.map((item) => item.type), types.slice(0, 6));
  for (const item of types.map((type) => effect(type,
    type === "de-hummer" ? { frequency: 50 }
      : type === "parametric-eq" ? { bands: [{ ...defaultAudioFxParams(type).bands[0], gain: 2 }] }
        : {},
  )))
    assert.ok(audioFxFilters(item, { detectedHumFrequency: 50 }).length > 0, item.type);
});

test("Noise Learn produces FFmpeg custom 15-band noise data", () => {
  const rate = 24000;
  const samples = new Float32Array(rate * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const time = index / rate;
    samples[index] = 0.025 * Math.sin(2 * Math.PI * 60 * time) + 0.012 * Math.sin(2 * Math.PI * 1800 * time);
  }
  const profile = learnNoiseBandProfile(samples, rate);
  assert.equal(profile.bands.length, 15);
  assert.ok(profile.bands.every((value) => value >= -80 && value <= -20));
  const filter = buildAudioFxFilterChain([
    effect("noise-reduction", { ...defaultAudioFxParams("noise-reduction"), mode: "learn", learnedBands: profile.bands }),
  ]);
  assert.match(filter, /afftdn=nt=c:bn=/);
  assert.equal((filter.match(/\|/g) || []).length, 14);
  assert.match(filter, /tn=0/);
});

test("Dialogue Separator keeps a compatible fallback when dialoguenhance is unavailable", () => {
  const fallback = buildAudioFxFilterChain([effect("dialogue-separator")], { dialogueEnhance: false });
  assert.match(fallback, /stereotools=/);
  assert.doesNotMatch(fallback, /dialoguenhance=/);
});

test("clip FX are emitted before concat and track FX are emitted in the master stage", () => {
  const clipRack = [effect("de-esser")];
  const trackRack = [effect("compressor-limiter")];
  const result = buildAudioExportGraph({
    outputDuration: 2,
    removals: [],
    audio: { speed: 1, limiter: false },
    denoise: { mode: "off", strength: 0 },
    audioFxRack: trackRack,
    mainAudioClips: [
      { id: "a1", start: 0, end: 1, sourceStart: 0, sourceEnd: 1, fxRack: clipRack },
      { id: "a2", start: 1, end: 2, sourceStart: 1, sourceEnd: 2, fxRack: [] },
    ],
    audioAssets: [],
    includeAudio: true,
  }, { audioCodec: "aac", duration: 2, channels: 2 });
  const clipIndex = result.graph.indexOf("deesser=");
  const concatIndex = result.graph.indexOf("concat=n=");
  const trackIndex = result.graph.indexOf("acompressor=");
  assert.ok(clipIndex >= 0 && clipIndex < concatIndex, result.graph);
  assert.ok(trackIndex > concatIndex, result.graph);
});

test("the complete open-source rack learns noise and renders a synchronized playable track", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quickcut-audio-fx-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source.wav");
  const output = path.join(root, "processed.m4a");
  const generated = spawnSync(mediaBinary("ffmpeg"), [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=210:sample_rate=48000:duration=3",
    "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.035:sample_rate=48000:duration=3:seed=2746",
    "-filter_complex", "[0:a]volume=.25[voice];[voice][1:a]amix=inputs=2:normalize=0,pan=stereo|c0=c0|c1=c0[mix]",
    "-map", "[mix]", "-c:a", "pcm_s16le", source,
  ], { encoding: "utf8", timeout: 30000, windowsHide: true });
  assert.equal(generated.status, 0, generated.stderr);
  const learned = await learnAudioFxNoiseProfile(source, { time: 0, duration: 1 });
  assert.equal(learned.bands.length, 15);
  const rack = [
    effect("noise-reduction", { ...defaultAudioFxParams("noise-reduction"), mode: "learn", learnedBands: learned.bands, noiseFloorDb: learned.noiseFloorDb, reductionDb: 8 }),
    effect("de-hummer", { ...defaultAudioFxParams("de-hummer"), frequency: 50, reductionDb: 10, harmonics: 2 }),
    effect("dialogue-separator", { ...defaultAudioFxParams("dialogue-separator"), backgroundDb: -5, ambienceDb: -4 }),
    effect("de-esser"), effect("parametric-eq"), effect("compressor-limiter"),
  ];
  const tailPreview = await renderAudioFxPreview(source, 2.95, { trackFxRack: rack, previewDirectory: root });
  assert.ok(fs.statSync(tailPreview.path).size > 1024);
  assert.equal(tailPreview.startTime, 0);
  assert.equal(tailPreview.targetOffset, 0);
  assert.equal(tailPreview.duration, 3);
  await renderAudioFxTrack(source, output, { trackFxRack: rack, quickDenoise: { mode: "off", strength: 0 } });
  assert.ok(fs.statSync(output).size > 4096);
  const probe = spawnSync(mediaBinary("ffprobe"), [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", output,
  ], { encoding: "utf8", timeout: 15000, windowsHide: true });
  assert.equal(probe.status, 0, probe.stderr);
  assert.ok(Math.abs(Number(probe.stdout.trim()) - 3) < 0.05, probe.stdout);
});

test("pre-rendered track FX are not applied twice and clip FX survive a real video export", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quickcut-audio-fx-export-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source.mp4");
  const cached = path.join(root, "track-cache.m4a");
  const output = path.join(root, "output.mp4");
  const generated = spawnSync(mediaBinary("ffmpeg"), [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=2",
    "-f", "lavfi", "-i", "sine=frequency=230:sample_rate=48000:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source,
  ], { encoding: "utf8", timeout: 30000, windowsHide: true });
  assert.equal(generated.status, 0, generated.stderr);

  const trackRack = [effect("compressor-limiter")];
  const clipRack = [effect("de-esser")];
  await renderAudioFxTrack(source, cached, { trackFxRack: trackRack });
  const graph = buildAudioExportGraph({
    mainAudioPath: cached,
    mainAudioFxPreRendered: true,
    outputDuration: 2,
    removals: [],
    audio: { speed: 1 },
    denoise: { strength: 0 },
    audioFxRack: trackRack,
    mainAudioClips: [{ start: 0, end: 2, sourceStart: 0, sourceEnd: 2, fxRack: clipRack }],
    audioAssets: [],
    includeAudio: true,
  }, { duration: 2, audioCodec: "aac", channels: 1 }, 1, 0).graph;
  assert.match(graph, /deesser=/);
  assert.doesNotMatch(graph, /acompressor=/);

  const started = startExport({
    inputPath: source,
    mainAudioPath: cached,
    mainAudioFxPreRendered: true,
    outputPath: output,
    format: "mp4",
    width: 320,
    height: 180,
    fps: 24,
    codec: "h264",
    bitrate: "1M",
    encoderDevice: "cpu",
    qualityMode: "fast",
    outputDuration: 2,
    removals: [],
    mainVideoClips: [{ id: "v1", start: 0, end: 2, sourceStart: 0, sourceEnd: 2, trackId: "video" }],
    mainAudioClips: [{ id: "a1", start: 0, end: 2, sourceStart: 0, sourceEnd: 2, trackId: "audio", fxRack: clipRack }],
    audioFxRack: trackRack,
    audio: { speed: 1 },
    denoise: { strength: 0 },
    audioAssets: [], videoLayers: [], images: [], titles: [], captions: [], audioMutes: [],
    includeVideo: true, includeAudio: true,
  });
  const deadline = Date.now() + 20000;
  let status;
  while (Date.now() < deadline) {
    status = exportStatus(started.jobId);
    if (["completed", "failed", "cancelled"].includes(status.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.equal(status?.state, "completed", status?.error || "audio FX export timed out");
  assert.ok(fs.statSync(output).size > 4096);
  const probe = spawnSync(mediaBinary("ffprobe"), [
    "-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=codec_name:format=duration", "-of", "json", output,
  ], { encoding: "utf8", timeout: 15000, windowsHide: true });
  assert.equal(probe.status, 0, probe.stderr);
  const data = JSON.parse(probe.stdout);
  assert.equal(data.streams?.[0]?.codec_name, "aac");
  assert.ok(Math.abs(Number(data.format?.duration) - 2) < 0.08, probe.stdout);
});
