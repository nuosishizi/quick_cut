import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const testScratch = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".scratch",
);
fs.mkdirSync(testScratch, { recursive: true });
const temporaryRoot = fs.mkdtempSync(path.join(testScratch, "quickcut-248-"));
process.env.QUICKCUT_SUPPORT_ROOT = path.join(temporaryRoot, "support");
if (process.platform !== "win32" && fs.existsSync(ffmpeg))
  process.env.QUICKCUT_MEDIA_ROOT = "/usr/bin";
else delete process.env.QUICKCUT_MEDIA_ROOT;
const media = await import("../src/media.mjs");
const store = await import("../src/project-store.mjs");
const ffmpeg = media.mediaBinary("ffmpeg");
const ffprobe = media.mediaBinary("ffprobe");

test.after(() => fs.rmSync(testScratch, { recursive: true, force: true }));

function run(binary, args) {
  const result = spawnSync(binary, args, { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("project cover is a real 9:16 render and project store prefers it", async () => {
  const source = path.join(temporaryRoot, "source.mp4");
  run(ffmpeg, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x180:r=24:d=1",
    "-pix_fmt",
    "yuv420p",
    source,
  ]);
  const project = store.createProject({ name: "封面测试", ratio: "9:16" });
  const cover = path.join(store.projectStoragePath(project.id), "project-cover.png");
  await media.createProjectCover({
    inputPath: source,
    destination: cover,
    time: 0.2,
    projectWidth: 1080,
    projectHeight: 1920,
    videoTransform: { x: 60, y: -80, scale: 1.15 },
  });
  const dimensions = JSON.parse(
    run(ffprobe, [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      cover,
    ]),
  ).streams[0];
  assert.deepEqual(
    { width: dimensions.width, height: dimensions.height },
    { width: 216, height: 384 },
  );
  store.saveProjectSnapshot({
    projectId: project.id,
    projectName: project.name,
    data: {
      ...project.data,
      video: { path: source, name: "source.mp4", previewPath: source },
      projectCoverPath: cover,
    },
  });
  assert.equal(store.listProjects()[0].thumbnailPath, cover);
  fs.rmSync(source, { force: true });
  assert.equal(store.listProjects()[0].thumbnailPath, "");
});

test("deleteProject removes the project from the home list", async () => {
  const project = store.createProject({ name: "待删除工程", ratio: "9:16" });
  assert.ok(store.listProjects().some((item) => item.id === project.id));
  assert.equal(await store.deleteProject(project.id), true);
  assert.equal(store.listProjects().some((item) => item.id === project.id), false);
});

test("listProjects hides folders marked deleted when the folder cannot be moved", () => {
  const project = store.createProject({ name: "占用中的工程", ratio: "9:16" });
  fs.writeFileSync(path.join(store.projectStoragePath(project.id), ".deleted"), "1");
  assert.equal(store.listProjects().some((item) => item.id === project.id), false);
});

test("bundled-compatible metadata probe reads streams before every export", () => {
  const source = path.join(temporaryRoot, "probe-source.mp4");
  run(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=24:d=0.4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", source,
  ]);
  const info = media.probeMedia(source);
  assert.equal(info.width, 320);
  assert.equal(info.height, 180);
  assert.ok(info.duration > 0.3);
});

test("pause cutting and still export share the compatible media path", async () => {
  const source = path.join(temporaryRoot, "pause-and-still-source.mp4");
  const still = path.join(temporaryRoot, "pause-and-still.png");
  run(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=green:s=320x180:r=24:d=1",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
    "-c:v", "libx264", "-c:a", "aac", "-shortest", "-pix_fmt", "yuv420p", source,
  ]);
  const analysis = await media.analyzePauses(source, { threshold: 0.3 });
  assert.ok(analysis.duration > 0.8);
  assert.ok(Array.isArray(analysis.waveform) && analysis.waveform.length > 0);
  await media.extractStillFrame(source, 0.2, still);
  assert.ok(fs.existsSync(still) && fs.statSync(still).size > 100);
});

test("untouched matching source uses zero-reencode smart copy", async () => {
  const source = path.join(temporaryRoot, "smart-copy-source.mp4");
  const output = path.join(temporaryRoot, "smart-copy-output.mp4");
  run(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", source,
  ]);
  const started = media.startExport({
    inputPath: source,
    outputPath: output,
    format: "mp4",
    width: 320,
    height: 180,
    fps: 24,
    codec: "source",
    outputDuration: 1,
    mainVideoClips: [{
      id: "v1", start: 0, end: 1, sourceStart: 0, sourceEnd: 1,
      settings: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, blendMode: "normal" },
    }],
    mainAudioClips: [],
    videoTransform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, blendMode: "normal" },
    color: {}, beauty: {}, denoise: { strength: 0 },
    removals: [], audioMutes: [], videoLayers: [], images: [],
    titles: [], captions: [], audioAssets: [],
    includeVideo: true, includeAudio: true, audioProcessingEnabled: false,
  });
  assert.equal(started.mode, "smart-copy");
  const deadline = Date.now() + 10000;
  let status;
  while (Date.now() < deadline) {
    status = media.exportStatus(started.jobId);
    if (["completed", "failed", "cancelled"].includes(status.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(status?.state, "completed", status?.error || "smart copy timed out");
  const packetHash = (file) => run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-i", file,
    "-map", "0:v:0", "-c", "copy", "-f", "md5", "-",
  ]).trim();
  assert.equal(packetHash(output), packetHash(source));
});

test("beauty export starts visibly and completes through the fast filter path", async () => {
  const source = path.join(temporaryRoot, "beauty-source.mp4");
  const output = path.join(temporaryRoot, "beauty-output.mp4");
  run(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=0.8",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", source,
  ]);
  const started = media.startExport({
    inputPath: source, outputPath: output, format: "mp4",
    width: 320, height: 180, fps: 24, codec: "h264", bitrate: "1M",
    outputDuration: 0.8,
    mainVideoClips: [{
      id: "v1", start: 0, end: 0.8, sourceStart: 0, sourceEnd: 0.8,
      settings: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, blendMode: "normal" },
    }],
    mainAudioClips: [],
    videoTransform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, blendMode: "normal" },
    color: {},
    beauty: { smoothing: 85, blemish: 90, texture: 35, whitening: 35 },
    denoise: { strength: 0 }, removals: [], audioMutes: [], videoLayers: [],
    images: [], titles: [], captions: [], audioAssets: [],
    includeVideo: true, includeAudio: false, audioProcessingEnabled: false,
  });
  assert.ok(media.exportStatus(started.jobId).progress >= 0.01);
  const deadline = Date.now() + 15000;
  let status;
  while (Date.now() < deadline) {
    status = media.exportStatus(started.jobId);
    if (["completed", "failed", "cancelled"].includes(status.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(status?.state, "completed", status?.error || "beauty export timed out");
  assert.ok(fs.existsSync(output) && fs.statSync(output).size > 1000);
});

test("timeline offset creates a leading black gap in a real export", async () => {
  const source = path.join(temporaryRoot, "red-with-audio.mp4");
  const output = path.join(temporaryRoot, "offset-export.mp4");
  run(ffmpeg, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=320x320:r=24:d=2",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    source,
  ]);
  const started = media.startExport({
    inputPath: source,
    outputPath: output,
    format: "mp4",
    width: 320,
    height: 320,
    fps: 24,
    codec: "h264",
    bitrate: "1M",
    removals: [],
    audioMutes: [],
    audioAssets: [],
    videoLayers: [],
    images: [],
    titles: [],
    captions: [],
    outputDuration: 3,
    mainTimelineOffset: 1,
    videoTransform: { x: 0, y: 0, scale: 1 },
    color: {},
    beauty: {},
    denoise: { strength: 0 },
    audio: { speed: 1, volume: 1, pan: 0 },
    trackOrder: ["video", "audio"],
    trackDefinitions: {},
    trackVisibility: { video: true, audio: true },
    mainAudioClipSettings: {},
    mainVideoClips: [{ start: 1, end: 3, trackId: "video" }],
    mainAudioClips: [{ id: "v-0.0000-2.0000", start: 1, end: 3, trackId: "audio" }],
    includeVideo: true,
    includeAudio: true,
  });
  const deadline = Date.now() + 20000;
  let status;
  while (Date.now() < deadline) {
    status = media.exportStatus(started.jobId);
    if (["completed", "failed", "cancelled"].includes(status.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(status?.state, "completed", status?.error || "export timed out");
  const frame = (time) =>
    spawnSync(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(time),
      "-i",
      output,
      "-frames:v",
      "1",
      "-vf",
      "scale=1:1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ]).stdout;
  const before = frame(0.3);
  const after = frame(1.3);
  assert.ok(before.length >= 3 && after.length >= 3);
  assert.ok(before[0] < 20 && before[1] < 20 && before[2] < 20, "leading gap is not black");
  assert.ok(after[0] > 120 && after[1] < 80 && after[2] < 80, "video did not start after offset");
});

test("letter spacing, line spacing and exact output duration survive a real export", async (context) => {
  const fontFile = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
  if (!fs.existsSync(fontFile)) {
    context.skip("test font unavailable");
    return;
  }
  const source = path.join(temporaryRoot, "typography-source.mp4");
  const output = path.join(temporaryRoot, "typography-export.mp4");
  const image = path.join(temporaryRoot, "animated-image.png");
  run(ffmpeg, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=navy:s=320x320:r=24:d=1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    source,
  ]);
  run(ffmpeg, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=yellow:s=80x80",
    "-frames:v",
    "1",
    image,
  ]);
  const textStyle = {
    fontFamily: "DejaVu Sans",
    fontFile,
    fontSize: 28,
    fontWeight: 700,
    color: "#ffffff",
    stroke: 1,
    strokeColor: "#000000",
    shadow: 0,
    letterSpacing: 3,
    wordSpacing: 6,
    lineHeight: 1.4,
  };
  const started = media.startExport({
    inputPath: source,
    outputPath: output,
    format: "mp4",
    width: 320,
    height: 320,
    fps: 24,
    codec: "h264",
    bitrate: "1M",
    removals: [],
    audioMutes: [],
    audioAssets: [],
    videoLayers: [],
    images: [
      {
        path: image,
        start: 0,
        end: 0.82,
        x: 80,
        y: 80,
        scale: 0.18,
        opacity: 0.9,
        enterAnimation: "slide-left",
        exitAnimation: "zoom-out",
        enterDuration: 0.2,
        exitDuration: 0.2,
        trackId: "image",
      },
    ],
    titles: [
      {
        text: "Line one\\nLine two",
        start: 0,
        end: 0.82,
        x: 0,
        y: -70,
        scale: 1,
        enterAnimation: "left",
        exitAnimation: "fade",
        enterDuration: 0.2,
        exitDuration: 0.2,
        style: textStyle,
      },
    ],
    captions: [
      {
        text: "Hello world",
        start: 0,
        end: 0.82,
        x: 0,
        y: 75,
        scale: 1,
        style: textStyle,
      },
    ],
    outputDuration: 0.82,
    mainTimelineOffset: 0,
    videoTransform: { x: 0, y: 0, scale: 1 },
    color: {},
    beauty: {},
    denoise: { strength: 0 },
    audio: { speed: 1, volume: 1, pan: 0 },
    trackOrder: ["caption", "text", "image", "video", "audio"],
    trackDefinitions: {},
    trackVisibility: { caption: true, text: true, image: true, video: true, audio: true },
    mainAudioClipSettings: {},
    mainVideoClips: [{ start: 0, end: 0.82, trackId: "video" }],
    mainAudioClips: [],
    includeVideo: true,
    includeAudio: false,
  });
  const deadline = Date.now() + 20000;
  let status;
  while (Date.now() < deadline) {
    status = media.exportStatus(started.jobId);
    if (["completed", "failed", "cancelled"].includes(status.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(status?.state, "completed", status?.error || "export timed out");
  const duration = Number(
    run(ffprobe, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1:nk=1",
      output,
    ]),
  );
  assert.ok(duration >= 0.8 && duration < 0.9, `unexpected export duration ${duration}`);
});
