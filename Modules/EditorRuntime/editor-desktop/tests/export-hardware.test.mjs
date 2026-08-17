import assert from "node:assert/strict";
import test from "node:test";
import {
  detectExportHardware,
  encoderDisplayName,
  formatExportClock,
  parseFfmpegProgress,
  normalizeExportDevice,
  preferredVideoEncoder,
  preferredExportDecodeKind,
  exportIsStalled,
  refreshExportJob,
  videoEncodeArgs,
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
  assert.equal(encoderDisplayName("h264_nvenc"), "NVIDIA NVENC");
  assert.equal(encoderDisplayName("libx264"), "软件编码");
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
  assert.match(job.message, /正在启动编码器|正在准备导出/);
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

test("export device checkbox can force CPU software encoding", () => {
  assert.equal(normalizeExportDevice(""), "gpu");
  assert.equal(normalizeExportDevice("GPU"), "gpu");
  assert.equal(normalizeExportDevice("cpu"), "cpu");
  assert.equal(preferredVideoEncoder(false, { device: "cpu" }), "libx264");
  assert.equal(preferredVideoEncoder(true, { device: "cpu" }), "libx265");
});

test("Windows preferred encoder is a working encoder, not just a compiled name", () => {
  const encoder = preferredVideoEncoder(false);
  assert.ok(
    /h264_nvenc|h264_qsv|h264_amf|h264_videotoolbox|libx264/.test(encoder),
    encoder,
  );
});
