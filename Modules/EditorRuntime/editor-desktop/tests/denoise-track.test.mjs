import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { mediaBinary, renderDenoisedTrack, renderLutPreviewFrame } from "../src/media.mjs";

const scratchRoot = path.join(process.cwd(), "tests", ".denoise-scratch");
fs.mkdirSync(scratchRoot, { recursive: true });
// The package ships macOS arm64 media binaries. On Linux/Windows CI and
// desktop hosts, prefer a real local FFmpeg instead of the bundled Mach-O files.
if (process.platform !== "win32" && fs.existsSync("/usr/bin/ffmpeg"))
  process.env.QUICKCUT_MEDIA_ROOT = "/usr/bin";
else delete process.env.QUICKCUT_MEDIA_ROOT;

test("whole-track denoise writes atomically to the project media destination", async (t) => {
  const root = fs.mkdtempSync(path.join(scratchRoot, "quickcut-denoise-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, "voice.m4a");
  const destination = path.join(root, "project", "media", "denoised.m4a");
  const generated = spawnSync(mediaBinary("ffmpeg"), [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=0.45",
    "-c:a", "aac", input,
  ]);
  assert.equal(generated.status, 0, generated.stderr?.toString());
  const output = await renderDenoisedTrack(input, "fast", 0.35, destination);
  assert.equal(output, destination);
  assert.ok(fs.statSync(destination).size > 256);
  assert.equal(
    fs.readdirSync(path.dirname(destination)).some((name) => name.includes(".partial")),
    false,
  );
});

test("an imported cube LUT produces a real preview frame", async (t) => {
  const root = fs.mkdtempSync(path.join(scratchRoot, "quickcut-lut-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, "source.mp4"), lut = path.join(root, "identity.cube");
  fs.writeFileSync(lut, [
    "TITLE \"Identity\"", "LUT_3D_SIZE 2", "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 1",
    "0 0 0", "1 0 0", "0 1 0", "1 1 0", "0 0 1", "1 0 1", "0 1 1", "1 1 1",
  ].join("\n"));
  const generated = spawnSync(mediaBinary("ffmpeg"), [
    "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    "color=c=0x4a7299:s=320x180:d=0.3", "-c:v", "libx264", "-pix_fmt", "yuv420p", input,
  ]);
  assert.equal(generated.status, 0, generated.stderr?.toString());
  const frame = await renderLutPreviewFrame(input, 0, lut);
  assert.ok(fs.statSync(frame).size > 256);
  fs.unlinkSync(frame);
});
