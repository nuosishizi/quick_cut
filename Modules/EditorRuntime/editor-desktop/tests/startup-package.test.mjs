import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "..");
const contentsRoot = path.resolve(testDir, "../../../..");
const resourcesRoot = path.join(contentsRoot, "Resources");
const launcherPath = path.join(contentsRoot, "MacOS", "QuickCut");

test("bundle launcher resolves Contents/Resources and all runtime components exist", { skip: !fs.existsSync(launcherPath) }, () => {
  const launcher = fs.readFileSync(launcherPath, "utf8");
  assert.match(launcher, /SCRIPT_DIR\/\.\.\/Resources\/runtime/);
  assert.match(launcher, /APP_VERSION="2\.7\.1"/);
  assert.match(launcher, /component_verified/);
  assert.match(launcher, /automatic runtime repair and retry/);
  assert.match(launcher, /runtime retry exited with status/);
  assert.equal(
    path.resolve(path.dirname(launcherPath), "../Resources"),
    resourcesRoot,
  );

  for (const relativePath of [
    "runtime/bun-arm64",
    "media/ffmpeg",
    "media/ffprobe",
  ]) {
    const component = path.join(resourcesRoot, relativePath);
    assert.equal(fs.existsSync(component), true, `${relativePath} must exist`);
    assert.notEqual(
      fs.statSync(component).mode & 0o111,
      0,
      `${relativePath} must be executable`,
    );
  }
});

test("packaged media binaries are complete, executable and exact", { skip: !fs.existsSync(launcherPath) }, () => {
  const expected = {
    "runtime/bun-arm64": [63096576, "e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233"],
    "media/ffmpeg": [36766920, "a2ad6f0fc42a3c8f5183ef1d53e906d6bb35478d14a6b67175c30ce6c17e9214"],
    "media/ffprobe": [18187448, "c846d5db9d3b5bc33f987725e21f3ea14953931221c191575918e907ad6c18ff"],
  };
  for (const [relativePath, [size, hash]] of Object.entries(expected)) {
    const component = path.join(resourcesRoot, relativePath);
    assert.equal(fs.statSync(component).size, size);
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(component)).digest("hex"), hash);
    assert.notEqual(fs.statSync(component).mode & 0o111, 0);
  }
});

test("installer and launcher validate the runtime bytes actually shipped", { skip: !fs.existsSync(launcherPath) }, () => {
  const runtime = path.join(resourcesRoot, "runtime", "bun-arm64");
  const size = fs.statSync(runtime).size;
  const hash = crypto.createHash("sha256").update(fs.readFileSync(runtime)).digest("hex");
  const launcher = fs.readFileSync(launcherPath, "utf8");
  const installer = fs.readFileSync(path.resolve(contentsRoot, "../../安装快剪.command"), "utf8");
  for (const source of [launcher, installer]) {
    assert.match(source, new RegExp(String(size)));
    assert.match(source, new RegExp(hash));
  }
});

test("macOS UI waits for readiness and uses supported menu roles", { skip: true }, () => {
  const source = fs.readFileSync(path.join(projectRoot, "src/main.mjs"), "utf8");
  const applicationIndex = source.indexOf("const app = new Application()");
  const readyIndex = source.indexOf("await app.whenReady", applicationIndex);
  const menuIndex = source.indexOf("app.setMenu", applicationIndex);
  const windowIndex = source.indexOf("app.createBrowserWindow", applicationIndex);

  assert.ok(applicationIndex >= 0);
  assert.ok(readyIndex > applicationIndex);
  assert.ok(menuIndex > readyIndex);
  assert.ok(windowIndex > readyIndex);
  assert.match(source, /role: "selectall"/);
  assert.doesNotMatch(source, /role: "selectAll"/);
  assert.doesNotMatch(source, /app\.run\(\);/);
});
