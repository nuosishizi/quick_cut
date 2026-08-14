import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  defaultSupportRoot,
  executableName,
  fallbackFontFiles,
  isWindows,
  mediaSearchRoots,
  pathHasBinary,
} from "../src/platform.mjs";
import { mediaBinary } from "../src/media.mjs";

const src = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/main.mjs"),
  "utf8",
);

test("Windows host no longer shells out to macOS-only binaries", () => {
  assert.match(src, /from "\.\/platform\.mjs"/);
  assert.doesNotMatch(src, /\/usr\/bin\/osascript/);
  assert.doesNotMatch(src, /\/usr\/bin\/pbpaste/);
  assert.doesNotMatch(src, /\/usr\/bin\/open/);
});

test("platform helpers resolve Windows-style binaries and app data", () => {
  assert.equal(executableName("ffmpeg"), process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  assert.match(defaultSupportRoot(), /QuickCut/);
  if (isWindows) {
    assert.match(defaultSupportRoot(), /AppData/i);
    assert.ok(mediaSearchRoots().some((root) => /ffmpeg/i.test(root)));
    assert.ok(fallbackFontFiles().some((file) => /Fonts/i.test(file)));
  }
  const probe = pathHasBinary(path.dirname(process.execPath), path.basename(process.execPath));
  if (probe) assert.equal(fs.existsSync(probe), true);
});

test("mediaBinary finds a usable FFmpeg on this machine", () => {
  const ffmpeg = mediaBinary("ffmpeg");
  const ffprobe = mediaBinary("ffprobe");
  assert.equal(fs.existsSync(ffmpeg), true);
  assert.equal(fs.existsSync(ffprobe), true);
});
