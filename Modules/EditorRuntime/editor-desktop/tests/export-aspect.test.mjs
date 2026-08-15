import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import * as media from "../src/media.mjs";
import { sourceGeometry, sourceOrientationFilters } from "../src/media.mjs";

const ffmpeg = media.mediaBinary("ffmpeg");
const ffprobe = media.mediaBinary("ffprobe");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quickcut-aspect-"));

function run(binary, args) {
  const result = spawnSync(binary, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "ffmpeg failed");
  return result;
}

function probeSize(file) {
  const result = spawnSync(ffprobe, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0", file,
  ], { encoding: "utf8" });
  const [width, height] = String(result.stdout || "").trim().split(",").map(Number);
  return { width, height };
}

function rgbAt(file, x, y) {
  const result = spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-i", file, "-vf", `crop=2:2:${x}:${y}`,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ]);
  if (result.status !== 0 || !result.stdout?.length)
    throw new Error(result.stderr?.toString() || "sample failed");
  return [result.stdout[0], result.stdout[1], result.stdout[2]];
}

function dominant(rgb) {
  const [r, g, b] = rgb;
  if (r > 120 && r > g + 25 && r > b + 25) return "red";
  if (g > 110 && g > r + 25 && g > b + 25) return "green";
  if (b > 120 && b > r + 25 && b > g + 25) return "blue";
  if (r < 45 && g < 45 && b < 45) return "black";
  return `other(${r},${g},${b})`;
}

async function waitExport(started, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let status;
  while (Date.now() < deadline) {
    status = media.exportStatus(started.jobId);
    if (["completed", "failed", "cancelled"].includes(status.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return status;
}

test("orientation helpers use display size, not the encoded landscape size", () => {
  const geo = sourceGeometry({
    width: 1920,
    height: 1080,
    displayWidth: 1080,
    displayHeight: 1920,
    rotation: 90,
  });
  assert.equal(geo.displayWidth, 1080);
  assert.equal(geo.displayHeight, 1920);
  const filters = sourceOrientationFilters({
    width: 1920,
    height: 1080,
    displayWidth: 1080,
    displayHeight: 1920,
    rotation: 90,
  }).filters.join(",");
  assert.doesNotMatch(filters, /transpose=/);
  assert.match(filters, /1080:1920/);
});

test("portrait 1080x1920 export keeps the full 9:16 picture", async () => {
  const source = path.join(temporaryRoot, "portrait.mp4");
  const output = path.join(temporaryRoot, "portrait-out.mp4");
  run(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=red:s=1080x640:d=0.6:r=24",
    "-f", "lavfi", "-i", "color=c=green:s=1080x640:d=0.6:r=24",
    "-f", "lavfi", "-i", "color=c=blue:s=1080x640:d=0.6:r=24",
    "-filter_complex", "[0:v][1:v][2:v]vstack=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", source,
  ]);
  const started = media.startExport({
    inputPath: source,
    outputPath: output,
    format: "mp4",
    width: 1080,
    height: 1920,
    fps: 24,
    codec: "h264",
    bitrate: "2M",
    outputDuration: 0.6,
    mainVideoClips: [{ start: 0, end: 0.6, sourceStart: 0, sourceEnd: 0.6, settings: { scale: 1 } }],
    mainAudioClips: [],
    videoTransform: { x: 0, y: 0, scale: 1 },
    color: {}, beauty: {}, denoise: { strength: 0 },
    removals: [], audioMutes: [], videoLayers: [], images: [], titles: [], captions: [], audioAssets: [],
    includeVideo: true, includeAudio: false, audioProcessingEnabled: false,
  });
  const status = await waitExport(started);
  assert.equal(status?.state, "completed", status?.error || "portrait export failed");
  assert.deepEqual(probeSize(output), { width: 1080, height: 1920 });
  assert.equal(dominant(rgbAt(output, 540, 80)), "red");
  assert.equal(dominant(rgbAt(output, 540, 960)), "green");
  assert.equal(dominant(rgbAt(output, 540, 1840)), "blue");
});

test("rotated 1920x1080 source exported to 1080x1920 is not square-cropped", async () => {
  const landscape = path.join(temporaryRoot, "landscape.mp4");
  const source = path.join(temporaryRoot, "rotated.mp4");
  const output = path.join(temporaryRoot, "rotated-out.mp4");
  run(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=red:s=640x1080:d=0.6:r=24",
    "-f", "lavfi", "-i", "color=c=green:s=640x1080:d=0.6:r=24",
    "-f", "lavfi", "-i", "color=c=blue:s=640x1080:d=0.6:r=24",
    "-filter_complex", "[0:v][1:v][2:v]hstack=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", landscape,
  ]);
  run(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-display_rotation", "90", "-i", landscape, "-c", "copy", source,
  ]);
  const info = media.probeMedia(source);
  const started = media.startExport({
    inputPath: source,
    outputPath: output,
    format: "mp4",
    width: 1080,
    height: 1920,
    fps: 24,
    codec: "h264",
    bitrate: "2M",
    outputDuration: 0.6,
    mainVideoClips: [{ start: 0, end: 0.6, sourceStart: 0, sourceEnd: 0.6, settings: { scale: 1 } }],
    mainAudioClips: [],
    videoTransform: { x: 0, y: 0, scale: 1 },
    color: {}, beauty: {}, denoise: { strength: 0 },
    removals: [], audioMutes: [], videoLayers: [], images: [], titles: [], captions: [], audioAssets: [],
    includeVideo: true, includeAudio: false, audioProcessingEnabled: false,
  });
  const status = await waitExport(started);
  assert.equal(status?.state, "completed", status?.error || "rotated export failed");
  assert.deepEqual(probeSize(output), { width: 1080, height: 1920 });
  const top = dominant(rgbAt(output, 540, 80));
  const mid = dominant(rgbAt(output, 540, 960));
  const bottom = dominant(rgbAt(output, 540, 1840));
  assert.notEqual(top, "black", "top of the 9:16 frame should not be cropped away");
  assert.notEqual(bottom, "black", "bottom of the 9:16 frame should not be cropped away");
  const colors = new Set([top, mid, bottom]);
  assert.ok(colors.has("red") && colors.has("blue"), `expected full frame colors, got ${top}/${mid}/${bottom}; probe rotation=${info.rotation}`);
});
