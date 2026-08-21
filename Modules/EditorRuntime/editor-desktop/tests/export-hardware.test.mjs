import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cleanFfmpegErrorMessage,
  detectExportHardware,
  encoderDisplayName,
  encoderStallMessage,
  exportStallLimit,
  formatExportClock,
  parseFfmpegProgress,
  normalizeExportDevice,
  preferredVideoEncoder,
  preferredExportDecodeKind,
  exportIsStalled,
  isHardwareEncoder,
  listBusyGpuApps,
  shouldSkipHardwareForBusyGpu,
  refreshExportJob,
  videoEncodeArgs,
  estimateSpawnCommandLength,
  captionRastersUseMovieFilter,
  collectExportExtraInputs,
  shouldWriteFilterComplexScript,
  compactFfmpegFilterArgs,
  isSpawnTooLongError,
  composeCaptionRasterConcat,
  mainClipsUseConcat,
  clipHasCustomVisual,
  EXPORT_ENCODE_STALL_MS,
  EXPORT_SOFTWARE_STALL_MS,
  EXPORT_BUSY_GPU_STALL_MS,
} from "../src/media.mjs";

test("hardware probe never selects NVENC unless the GPU actually encodes", () => {
  const hardware = detectExportHardware();
  assert.ok(["nvidia", "intel", "amd", "apple", "software"].includes(hardware.vendor));
  assert.ok(hardware.h264);
  assert.ok(hardware.hevc);
  if (hardware.vendor !== "nvidia") {
    assert.doesNotMatch(hardware.h264, /nvenc/);
    assert.doesNotMatch(preferredVideoEncoder(false), /nvenc/);
  } else {
    assert.equal(hardware.h264, "h264_nvenc");
    assert.equal(hardware.decode, "cuda");
  }
});

test("NVIDIA encode args use NVENC presets and stay off compiled-in-only selection", () => {
  const args = videoEncodeArgs("h264_nvenc", {
    bitrate: "12M",
    fps: 30,
    qualityMode: "balanced",
  });
  assert.ok(args.includes("h264_nvenc"));
  assert.ok(args.includes("-preset"));
  assert.ok(args.includes("p5"));
  assert.ok(args.includes("-gpu"));
  assert.ok(args.includes("-rc-lookahead"));
  assert.match(encoderDisplayName("h264_nvenc"), /NVIDIA NVENC/);
  assert.match(encoderDisplayName("libx264"), /CPU 软件编码/);
});

test("FFmpeg progress prefers microseconds and clock time over the ms alias", () => {
  const fromUs = parseFfmpegProgress(
    "frame=30\nout_time_us=5000000\nout_time_ms=5000000\nout_time=00:00:05.000000\nspeed=1.2x\nprogress=continue\n",
    { duration: 20, fps: 30 },
  );
  assert.equal(fromUs.seconds, 5);
  assert.equal(fromUs.ended, false);
  assert.equal(fromUs.speed, 1.2);
  const fromClock = parseFfmpegProgress("out_time=00:01:10.500000\n", { duration: 120, fps: 30 });
  assert.equal(fromClock.seconds, 70.5);
  const milli = parseFfmpegProgress("out_time_ms=2500\n", { duration: 10, fps: 30 });
  assert.equal(milli.seconds, 2.5);
  const microMsAlias = parseFfmpegProgress("out_time_ms=2500000\n", { duration: 10, fps: 30 });
  assert.equal(microMsAlias.seconds, 2.5);
  assert.equal(parseFfmpegProgress("progress=end\nout_time_us=10000000\n", { duration: 10 }).ended, true);
  const pending = parseFfmpegProgress(
    "frame=0\nout_time_us=N/A\nout_time_ms=N/A\nout_time=N/A\nspeed=N/A\nprogress=continue\n",
    { duration: 20, fps: 30 },
  );
  assert.equal(pending.seconds, 0);
  assert.equal(pending.ended, false);
});

test("export status keeps the clock moving before ffmpeg reports frames", () => {
  assert.equal(formatExportClock(25), "0:25");
  const job = refreshExportJob({
    state: "exporting",
    progress: 0.02,
    startedAt: Date.now() - 25_000,
    stage: "encoding",
    frameProgress: false,
    encoder: "h264_qsv",
  });
  assert.match(job.message, /已用 0:25/);
  assert.ok(job.progress > 0.02, "soft progress should creep during silence");
  assert.match(job.message, /正在启动.*编码器|正在准备导出/);
});

test("filtered GPU export skips CUDA decode and treats a silent encoder as stalled", () => {
  assert.equal(preferredExportDecodeKind("h264_nvenc", "cuda"), "");
  assert.equal(preferredExportDecodeKind("h264_amf", "d3d11va"), "");
  assert.equal(preferredExportDecodeKind("h264_qsv", "qsv"), "");
  assert.equal(preferredExportDecodeKind("h264_videotoolbox", "videotoolbox"), "videotoolbox");
  assert.equal(preferredExportDecodeKind("libx264", "cuda"), "");
  assert.equal(
    exportIsStalled({
      state: "exporting",
      encoder: "h264_qsv",
      frameProgress: false,
      startedAt: Date.now() - 16_000,
      lastProgressAt: Date.now() - 16_000,
    }),
    true,
  );
  assert.equal(
    exportIsStalled({
      state: "exporting",
      frameProgress: true,
      startedAt: Date.now() - 30_000,
    }),
    false,
  );
});

test("Intel QSV yields to CPU when DaVinci is using the iGPU", () => {
  assert.equal(isHardwareEncoder("h264_qsv"), true);
  assert.equal(isHardwareEncoder("libx264"), false);
  assert.equal(shouldSkipHardwareForBusyGpu("h264_qsv", ["达芬奇"]), false);
  assert.equal(shouldSkipHardwareForBusyGpu("hevc_qsv", ["达芬奇"]), false);
  assert.equal(shouldSkipHardwareForBusyGpu("h264_nvenc", ["达芬奇"]), false);
  assert.equal(shouldSkipHardwareForBusyGpu("h264_qsv", []), false);
  assert.equal(exportStallLimit({ encoder: "h264_qsv" }), EXPORT_ENCODE_STALL_MS);
  assert.equal(exportStallLimit({ encoder: "h264_qsv", gpuBusy: true }), EXPORT_BUSY_GPU_STALL_MS);
  assert.equal(exportStallLimit({ encoder: "libx264" }), EXPORT_SOFTWARE_STALL_MS);
  assert.equal(
    exportIsStalled({
      state: "exporting",
      encoder: "libx264",
      frameProgress: false,
      startedAt: Date.now() - 16_000,
      lastProgressAt: Date.now() - 16_000,
    }),
    false,
  );
  assert.equal(
    exportIsStalled({
      state: "exporting",
      encoder: "libx264",
      frameProgress: false,
      startedAt: Date.now() - 95_000,
      lastProgressAt: Date.now() - 95_000,
    }),
    true,
  );
  assert.match(encoderStallMessage({ encoder: "h264_qsv" }), /编码器长时间没有输出画面/);
  assert.doesNotMatch(encoderStallMessage({ encoder: "libx264" }), /显卡/);
  assert.ok(Array.isArray(listBusyGpuApps()));
});

test("busy GPU encode args drop NVENC lookahead and QSV queue depth", () => {
  const nvenc = videoEncodeArgs("h264_nvenc", { bitrate: "12M", fps: 30, gpuBusy: true });
  const lookaheadAt = nvenc.indexOf("-rc-lookahead");
  assert.ok(lookaheadAt >= 0);
  assert.equal(nvenc[lookaheadAt + 1], "0");
  const qsv = videoEncodeArgs("h264_qsv", { bitrate: "12M", fps: 30, gpuBusy: true });
  assert.ok(qsv.includes("-async_depth"));
  assert.equal(qsv[qsv.indexOf("-async_depth") + 1], "1");
});

test("export device checkbox can force CPU software encoding", () => {
  assert.equal(normalizeExportDevice(""), "gpu");
  assert.equal(normalizeExportDevice("GPU"), "gpu");
  assert.equal(normalizeExportDevice("cpu"), "cpu");
  assert.equal(preferredVideoEncoder(false, { device: "cpu" }), "libx264");
  assert.equal(preferredVideoEncoder(true, { device: "cpu" }), "libx265");
});

test("many caption rasters stay off the Windows command line", () => {
  const rasters = Array.from({ length: 80 }, (_, index) => ({
    path: `C:\\Users\\newnew\\AppData\\Roaming\\QuickCut\\temp\\caption-raster-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\\c${index}.png`,
    start: index * 0.2,
    end: index * 0.2 + 0.18,
    _quickCutCaptionRaster: true,
  }));
  assert.equal(captionRastersUseMovieFilter({ images: rasters }), true);
  const collected = collectExportExtraInputs({
    images: [...rasters, { path: "C:\\pics\\logo.png" }],
    videoLayers: [{ path: "C:\\clips\\broll.mp4" }],
  });
  assert.equal(collected.captionRastersViaMovie, true);
  assert.deepEqual(collected.extraInputs, [
    "-i",
    "C:\\clips\\broll.mp4",
    "-framerate",
    "1",
    "-loop",
    "1",
    "-i",
    "C:\\pics\\logo.png",
  ]);
  const graph = rasters
    .map(
      (image, index) =>
        `movie='${image.path}':loop=1[img${index}];[layer${index}][img${index}]overlay=x=0:y=0:enable='between(t,${image.start},${image.end})'[layer${index + 1}]`,
    )
    .join(";");
  const longArgs = [
    "-y",
    "-i",
    "C:\\Users\\newnew\\Videos\\source.mp4",
    ...rasters.flatMap((image) => ["-loop", "1", "-i", image.path]),
    "-filter_complex",
    graph,
    "out.mp4",
  ];
  assert.ok(estimateSpawnCommandLength("C:\\ffmpeg\\bin\\ffmpeg.exe", longArgs) > 24000);
  assert.equal(
    shouldWriteFilterComplexScript(["-filter_complex", graph, "out.mp4"], {
      binary: "ffmpeg",
      rasterCount: rasters.length,
    }),
    true,
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qc-ffscript-"));
  const packed = compactFfmpegFilterArgs(["-y", "-i", "source.mp4", "-filter_complex", graph, "out.mp4"], {
    directory,
    binary: "ffmpeg",
    rasterCount: rasters.length,
  });
  assert.ok(packed.scriptPath);
  assert.ok(packed.args.includes("-filter_complex_script"));
  assert.ok(!packed.args.includes("-filter_complex"));
  assert.ok(estimateSpawnCommandLength("ffmpeg", packed.args) < 4000);
  assert.equal(isSpawnTooLongError({ code: "ENAMETOOLONG", message: "spawn ENAMETOOLONG" }), true);
  assert.equal(isSpawnTooLongError(new Error("spawn ffmpeg.exe ENAMETOOLONG")), true);
  assert.equal(isSpawnTooLongError(new Error("encoder failed")), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("software encode waiting for a frame does not blame the GPU", () => {
  const job = refreshExportJob({
    state: "exporting",
    progress: 0.16,
    startedAt: Date.now() - 11_000,
    stage: "encoding",
    frameProgress: false,
    encoder: "libx264",
    encoderLabel: "软件编码",
  });
  assert.match(job.message, /软件编码/);
  assert.match(job.message, /正在启动 CPU 编码器/);
  assert.doesNotMatch(job.message, /显卡/);
});

test("busy iGPU skip tells the user it switched to CPU", () => {
  const job = refreshExportJob({
    state: "exporting",
    progress: 0.04,
    startedAt: Date.now() - 2_000,
    stage: "encoding",
    frameProgress: false,
    encoder: "libx264",
    encoderLabel: "软件编码",
    gpuBusy: true,
    busyGpuApps: ["达芬奇"],
  });
  assert.match(job.message, /软件编码/);
  assert.match(job.message, /正在启动编码器/);
});

test("caption rasters collapse to one concat overlay", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qc-caption-concat-"));
  const first = path.join(directory, "a.png");
  const second = path.join(directory, "b.png");
  fs.writeFileSync(first, "png");
  fs.writeFileSync(second, "png");
  const config = {
    width: 1080,
    height: 1920,
    outputDuration: 4,
    captionRasterDirectory: directory,
    images: [
      { path: first, start: 0.5, end: 1.5, fullFrame: true, _quickCutCaptionRaster: true },
      { path: second, start: 2, end: 3.2, fullFrame: true, _quickCutCaptionRaster: true },
    ],
  };
  const listPath = composeCaptionRasterConcat(config, { duration: 4 });
  assert.ok(listPath);
  const text = fs.readFileSync(listPath, "utf8");
  assert.match(text, /ffconcat version 1.0/);
  assert.match(text, /empty\.png/);
  assert.match(text, /a\.png/);
  assert.equal(config.images.length, 1);
  assert.equal(config.images[0]._quickCutCaptionConcat, true);
  const extra = collectExportExtraInputs(config);
  assert.equal(extra.captionRastersViaMovie, false);
  assert.deepEqual(extra.extraInputs.slice(0, 5), ["-f", "concat", "-safe", "0", "-i"]);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("cut-up timeline joins with concat instead of stacked overlay", () => {
  const sequential = [
    { start: 0, end: 168.6, sourceStart: 0, sourceEnd: 168.6, trackId: "video" },
    { start: 168.6, end: 391, sourceStart: 170.23, sourceEnd: 393.26, trackId: "video" },
    { start: 391, end: 418, sourceStart: 395.05, sourceEnd: 422, trackId: "video" },
  ];
  assert.equal(mainClipsUseConcat(sequential), true);
  assert.equal(
    mainClipsUseConcat([
      ...sequential,
      { start: 10, end: 20, sourceStart: 10, sourceEnd: 20, trackId: "video" },
    ]),
    false,
  );
  assert.equal(clipHasCustomVisual({ scale: 1.2 }), true);
  assert.equal(mainClipsUseConcat([{ start: 0, end: 2, settings: { scale: 1.4 } }]), false);
  assert.equal(mainClipsUseConcat([{ start: 1, end: 3, trackId: "video" }]), true);
});

test("cleanFfmpegErrorMessage strips raw progress output and extracts real error", () => {
  const dirty = `
frame=2173 fps=245.08 stream_0_0_q=19.0
bitrate=15598.1kbits/s total_size=146538544 out_time_us=75157333
out_time_ms=75157333 out_time=00:01:15.157333 dup_frames=0 drop_frames=0
speed=8.44x progress=continue frame=2230 fps=245.82
[h264_nvenc @ 000001f] OpenEncodeSessionEx failed: out of memory (10)
[vost#0:0/h264_nvenc @ 000002] Error submitting video frame to the encoder
Conversion failed!
`;
  const cleaned = cleanFfmpegErrorMessage(dirty);
  assert.doesNotMatch(cleaned, /progress=continue/);
  assert.doesNotMatch(cleaned, /out_time_us=/);
  assert.match(cleaned, /OpenEncodeSessionEx failed/);
  assert.match(cleaned, /Error submitting video frame/);
});

