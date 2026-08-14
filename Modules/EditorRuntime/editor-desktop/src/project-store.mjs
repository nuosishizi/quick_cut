import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { supportRoot } from "./media.mjs";
import { archiveEntries, createArchive, extractArchive } from "./platform.mjs";

const projectsRoot = () => {
  const value = path.join(supportRoot(), "projects");
  fs.mkdirSync(value, { recursive: true, mode: 0o700 });
  return value;
};

function validateId(id) {
  const value = String(id || "");
  if (!/^[a-f0-9-]{24,64}$/i.test(value)) throw new Error("工程编号无效。");
  return value;
}

const projectDirectory = (id) => path.join(projectsRoot(), validateId(id));
const projectFile = (id) => path.join(projectDirectory(id), "project.json");

export function createProject(input = {}) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const ratio = input.ratio === "16:9" ? "16:9" : "9:16";
  const project = {
    format: "QuickCutProject",
    version: 1,
    id,
    name:
      String(input.name || "未命名工程")
        .trim()
        .slice(0, 80) || "未命名工程",
    createdAt: now,
    updatedAt: now,
    data: {
      projectId: id,
      projectName:
        String(input.name || "未命名工程")
          .trim()
          .slice(0, 80) || "未命名工程",
      ratio,
      width: ratio === "16:9" ? 1920 : 1080,
      height: ratio === "16:9" ? 1080 : 1920,
    },
  };
  fs.mkdirSync(path.join(projectDirectory(id), "media"), {
    recursive: true,
    mode: 0o700,
  });
  return saveProjectSnapshot({
    projectId: id,
    projectName: project.name,
    data: project.data,
    createdAt: now,
  });
}

export function saveProjectSnapshot(input = {}) {
  const id = validateId(input.projectId || input.data?.projectId);
  const directory = projectDirectory(id);
  fs.mkdirSync(path.join(directory, "media"), { recursive: true, mode: 0o700 });
  let previous = {};
  try {
    previous = JSON.parse(fs.readFileSync(projectFile(id), "utf8"));
  } catch {}
  const now = new Date().toISOString();
  const data = { ...(input.data || {}), projectId: id };
  const firstVideo = [data.video, ...(data.videoLayers || [])].find(Boolean);
  const project = {
    ...previous,
    format: "QuickCutProject",
    version: 1,
    id,
    name:
      String(
        input.projectName ||
          input.data?.projectName ||
          previous.name ||
          "未命名工程",
      )
        .trim()
        .slice(0, 80) || "未命名工程",
    createdAt: previous.createdAt || input.createdAt || now,
    updatedAt: now,
    ratio: data.ratio === "16:9" ? "16:9" : "9:16",
    thumbnailPath:
      data.projectCoverPath && fs.existsSync(data.projectCoverPath)
        ? data.projectCoverPath
        : firstVideo?.previewPath || "",
    videoName: firstVideo?.name || "",
    data,
  };
  const temporary = path.join(directory, `.project-${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(project, null, 2), {
    mode: 0o600,
  });
  fs.renameSync(temporary, projectFile(id));
  return project;
}

export function loadProject(id) {
  const file = projectFile(id);
  if (!fs.existsSync(file)) throw new Error("工程不存在或已经被删除。");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function listProjects() {
  return fs
    .readdirSync(projectsRoot(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      try {
        const value = JSON.parse(
          fs.readFileSync(
            path.join(projectsRoot(), entry.name, "project.json"),
            "utf8",
          ),
        );
        const primarySource =
          value.data?.video?.originalPath || value.data?.video?.path || "";
        const sourceAvailable = !primarySource || fs.existsSync(primarySource);
        const thumbnailPath =
          sourceAvailable && value.thumbnailPath && fs.existsSync(value.thumbnailPath)
            ? value.thumbnailPath
            : "";
        return [
          {
            id: value.id,
            name: value.name,
            createdAt: value.createdAt,
            updatedAt: value.updatedAt,
            ratio: value.data?.ratio || "9:16",
            duration: Number(value.data?.duration || 0),
            videoName: value.videoName || value.data?.video?.name || "",
            thumbnailPath,
          },
        ];
      } catch {
        return [];
      }
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function deleteProject(id) {
  const source = projectDirectory(id);
  if (!fs.existsSync(source)) return false;
  const trash = path.join(supportRoot(), "deleted-projects");
  fs.mkdirSync(trash, { recursive: true, mode: 0o700 });
  fs.renameSync(source, path.join(trash, `${id}-${Date.now()}`));
  return true;
}

export function resetProject(id) {
  const current = loadProject(id);
  const directory = projectDirectory(id);
  const media = path.join(directory, "media");
  if (fs.existsSync(media)) {
    const history = path.join(directory, "reset-history");
    fs.mkdirSync(history, { recursive: true, mode: 0o700 });
    fs.renameSync(media, path.join(history, String(Date.now())));
  }
  fs.mkdirSync(media, { recursive: true, mode: 0o700 });
  return saveProjectSnapshot({
    projectId: id,
    projectName: current.name,
    data: {
      projectId: id,
      projectName: current.name,
      ratio: current.data?.ratio === "16:9" ? "16:9" : "9:16",
      width: current.data?.ratio === "16:9" ? 1920 : 1080,
      height: current.data?.ratio === "16:9" ? 1080 : 1920,
    },
  });
}

function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function clearProjectCache(id) {
  const current = loadProject(id);
  const directory = projectDirectory(id);
  const media = path.join(directory, "media");
  const cacheFiles = new Set([
    current.thumbnailPath,
    current.data?.projectCoverPath,
  ]);
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.previewPath === "string") cacheFiles.add(value.previewPath);
    for (const child of Object.values(value)) visit(child);
  };
  visit(current.data);
  let removed = 0;
  for (const file of cacheFiles) {
    if (!file || !fs.existsSync(file)) continue;
    const allowed = inside(directory, file) || inside(path.join(supportRoot(), "previews"), file);
    if (!allowed) continue;
    fs.rmSync(file, { force: true });
    removed += 1;
  }
  if (fs.existsSync(media)) {
    for (const entry of fs.readdirSync(media)) {
      fs.rmSync(path.join(media, entry), { recursive: true, force: true });
      removed += 1;
    }
  }
  const stripCache = (value) => {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value))
      return value.map(stripCache).filter(Boolean);
    const copy = {};
    for (const [key, child] of Object.entries(value)) {
      if (["previewPath", "previewUrl", "projectCoverPath"].includes(key)) continue;
      copy[key] = stripCache(child);
    }
    if (typeof copy.path === "string" && inside(media, copy.path) && !fs.existsSync(copy.path))
      return null;
    return copy;
  };
  const data = stripCache(current.data) || {};
  saveProjectSnapshot({ projectId: id, projectName: current.name, data });
  return { removed, project: loadProject(id) };
}

export function stageProjectAsset(projectId, sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath))
    throw new Error("素材文件已经不存在。");
  const directory = path.join(projectDirectory(projectId), "media");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const extension = path.extname(sourcePath).slice(0, 12);
  const base =
    path
      .basename(sourcePath, extension)
      .replace(/[^\p{L}\p{N}._ -]+/gu, "-")
      .slice(0, 72) || "asset";
  const destination = path.join(
    directory,
    `${base}-${crypto.randomUUID().slice(0, 8)}${extension}`,
  );
  fs.copyFileSync(sourcePath, destination);
  return destination;
}

export async function stageProjectAssetAsync(projectId, sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath))
    throw new Error("素材文件已经不存在。");
  const directory = path.join(projectDirectory(projectId), "media");
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const resolvedSource = path.resolve(sourcePath);
  if (path.dirname(resolvedSource) === path.resolve(directory))
    return resolvedSource;
  const extension = path.extname(sourcePath).slice(0, 12);
  const base =
    path
      .basename(sourcePath, extension)
      .replace(/[^\p{L}\p{N}._ -]+/gu, "-")
      .slice(0, 72) || "asset";
  const destination = path.join(
    directory,
    `${base}-${crypto.randomUUID().slice(0, 8)}${extension}`,
  );
  try {
    await fs.promises.link(resolvedSource, destination);
  } catch (error) {
    if (!["EXDEV", "EPERM", "EACCES", "EMLINK", "EEXIST", "ENOENT"].includes(error?.code))
      throw error;
    if (!fs.existsSync(resolvedSource))
      throw new Error("处理后的素材文件尚未生成或已被清理，请重试。");
    try {
      await fs.promises.copyFile(
        resolvedSource,
        destination,
        fs.constants.COPYFILE_FICLONE,
      );
    } catch {
      await fs.promises.copyFile(resolvedSource, destination);
    }
  }
  return destination;
}

export const stageMedia = stageProjectAsset;
export const projectStoragePath = projectDirectory;
export const appSupportRoot = supportRoot;

function archiveEntriesSafe(archive) {
  for (const entry of archiveEntries(archive)) {
    const normalized = String(entry || "").replace(/\\/g, "/");
    if (path.isAbsolute(normalized) || normalized.split("/").includes(".."))
      throw new Error("备份包路径不安全，已停止恢复。");
  }
}

export function exportBackup(destination) {
  if (!destination) return null;
  const items = ["projects", "fonts", "caption-presets.json"].filter((name) =>
    fs.existsSync(path.join(supportRoot(), name)),
  );
  if (!items.length) throw new Error("目前没有可备份的工程。");
  return createArchive(destination, items, supportRoot());
}

export function importBackup(archive) {
  if (!archive || !fs.existsSync(archive)) return null;
  archiveEntriesSafe(archive);
  const destination = path.join(
    supportRoot(),
    `restore-${crypto.randomUUID()}`,
  );
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  extractArchive(archive, destination);
  const incomingFonts = path.join(destination, "fonts");
  if (fs.existsSync(incomingFonts))
    fs.cpSync(incomingFonts, path.join(supportRoot(), "fonts"), {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
  let count = 0;
  const incoming = path.join(destination, "projects");
  if (fs.existsSync(incoming)) {
    for (const entry of fs
      .readdirSync(incoming, { withFileTypes: true })
      .filter((item) => item.isDirectory())) {
      const source = path.join(incoming, entry.name);
      const file = path.join(source, "project.json");
      if (!fs.existsSync(file)) continue;
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      let id = value.id;
      if (
        !/^[a-f0-9-]{24,64}$/i.test(String(id || "")) ||
        fs.existsSync(projectDirectory(id))
      ) {
        id = crypto.randomUUID();
        value.id = id;
        value.name = `${value.name || "恢复工程"}（恢复）`;
        value.data = {
          ...(value.data || {}),
          projectId: id,
          projectName: value.name,
        };
        fs.writeFileSync(file, JSON.stringify(value, null, 2));
      }
      const restoredDirectory = projectDirectory(id);
      fs.cpSync(source, restoredDirectory, { recursive: true });
      const restoredFile = path.join(restoredDirectory, "project.json");
      const restored = JSON.parse(fs.readFileSync(restoredFile, "utf8"));
      const restoredMedia = path.join(restoredDirectory, "media");
      const restoredFonts = path.join(supportRoot(), "fonts");
      const rebase = (input, key = "") => {
        if (Array.isArray(input)) return input.map((item) => rebase(item));
        if (!input || typeof input !== "object") {
          if (typeof input !== "string") return input;
          if (["url", "previewUrl"].includes(key)) return "";
          if (key === "previewPath") return "";
          if (!["path", "fontFile", "sourcePath"].includes(key)) return input;
          const mediaCandidate = path.join(restoredMedia, path.basename(input));
          if (fs.existsSync(mediaCandidate)) return mediaCandidate;
          const fontCandidate = path.join(restoredFonts, path.basename(input));
          if (fs.existsSync(fontCandidate)) return fontCandidate;
          return fs.existsSync(input) ? input : "";
        }
        return Object.fromEntries(
          Object.entries(input).map(([childKey, childValue]) => [
            childKey,
            rebase(childValue, childKey),
          ]),
        );
      };
      restored.id = id;
      restored.thumbnailPath = "";
      restored.data = rebase({
        ...(restored.data || {}),
        projectId: id,
        projectName: restored.name,
      });
      fs.writeFileSync(restoredFile, JSON.stringify(restored, null, 2), {
        mode: 0o600,
      });
      count += 1;
    }
  }
  for (const name of ["fonts", "caption-presets.json"]) {
    const source = path.join(destination, name);
    if (fs.existsSync(source))
      fs.cpSync(source, path.join(supportRoot(), name), {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
  }
  fs.rmSync(destination, { recursive: true, force: true });
  return { restored: count };
}
