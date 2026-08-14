import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

export const isWindows = process.platform === "win32";
export const isDarwin = process.platform === "darwin";

const FILTERS = {
  video: "视频|*.mp4;*.mov;*.m4v;*.mkv;*.webm;*.avi;*.wmv|所有文件|*.*",
  image: "图片|*.jpg;*.jpeg;*.png;*.webp;*.gif;*.bmp;*.tif;*.tiff|所有文件|*.*",
  audio: "音频|*.mp3;*.wav;*.m4a;*.aac;*.flac;*.ogg;*.wma|所有文件|*.*",
  subtitle: "字幕|*.srt;*.vtt;*.ass;*.ssa;*.txt|所有文件|*.*",
  font: "字体|*.ttf;*.otf;*.ttc;*.woff2|所有文件|*.*",
  lut: "LUT 滤镜|*.cube;*.3dl;*.dat;*.m3d;*.csp|所有文件|*.*",
  backup: "快剪备份|*.quickcutbackup;*.zip|所有文件|*.*",
  project: "快剪工程|*.zpe;*.json|所有文件|*.*",
};

const PROMPTS = {
  video: "选择视频",
  image: "选择图片",
  audio: "选择音频",
  subtitle: "选择字幕文件",
  font: "选择字体文件",
  lut: "选择 LUT 滤镜文件",
  backup: "选择快剪工程备份",
  project: "选择工程文件",
};

function darwinTypes(kind) {
  if (kind === "video") return ' of type {"public.movie"}';
  if (kind === "image") return ' of type {"public.image"}';
  if (kind === "audio") return ' of type {"public.audio"}';
  if (kind === "subtitle") return ' of type {"public.plain-text"}';
  if (kind === "backup") return ' of type {"public.data","public.zip-archive"}';
  return "";
}

function powershellEncoded(script) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

function writePickerResult(scriptBody) {
  const output = path.join(os.tmpdir(), `quickcut-pick-${crypto.randomUUID()}.txt`);
  const script = `
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Windows.Forms
${scriptBody}
`;
  const result = powershellEncoded(script.replaceAll("__OUTPUT__", output.replaceAll("'", "''")));
  if (result.status !== 0) return [];
  if (!fs.existsSync(output)) return [];
  try {
    return fs
      .readFileSync(output, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } finally {
    try {
      fs.unlinkSync(output);
    } catch {
      /* temp picker file */
    }
  }
}

export function defaultSupportRoot() {
  if (isWindows)
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "QuickCut",
    );
  return path.join(os.homedir(), "Library", "Application Support", "QuickCut");
}

export function executableName(name) {
  const base = String(name || "").replace(/\.exe$/i, "");
  return isWindows ? `${base}.exe` : base;
}

export function pathHasBinary(directory, name) {
  if (!directory) return "";
  const raw = path.join(directory, name);
  if (fs.existsSync(raw)) return raw;
  const withExt = path.join(directory, executableName(name));
  if (withExt !== raw && fs.existsSync(withExt)) return withExt;
  return "";
}

export function whichBinary(name) {
  const exe = executableName(name);
  const delimiter = isWindows ? ";" : ":";
  for (const directory of String(process.env.PATH || "").split(delimiter)) {
    const found = pathHasBinary(directory, exe);
    if (found) return found;
  }
  return "";
}

export function mediaSearchRoots() {
  if (!isWindows) {
    return ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"];
  }
  return [
    path.join("C:", "ffmpeg-master-latest-win64-gpl-shared", "bin"),
    path.join("C:", "ffmpeg", "bin"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "ffmpeg", "bin"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "ffmpeg", "bin"),
  ];
}

export function fontSearchRoots(extra = []) {
  if (isWindows) {
    return [
      ...extra,
      path.join(process.env.WINDIR || "C:\\Windows", "Fonts"),
      path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
        "Microsoft",
        "Windows",
        "Fonts",
      ),
    ];
  }
  return [
    ...extra,
    path.join(os.homedir(), "Library", "Fonts"),
    "/Library/Fonts",
    "/System/Library/Fonts",
  ];
}

export function fallbackFontFiles() {
  if (isWindows) {
    const fonts = path.join(process.env.WINDIR || "C:\\Windows", "Fonts");
    return [
      path.join(fonts, "msyh.ttc"),
      path.join(fonts, "msyhbd.ttc"),
      path.join(fonts, "simhei.ttf"),
      path.join(fonts, "arial.ttf"),
      path.join(fonts, "segoeui.ttf"),
    ];
  }
  return [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
  ];
}

export function chooseFile(kind) {
  if (isWindows) {
    const filter = FILTERS[kind] || FILTERS.project;
    const title = PROMPTS[kind] || PROMPTS.project;
    const picked = writePickerResult(`
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '${title.replaceAll("'", "''")}'
$dialog.Filter = '${filter}'
$dialog.Multiselect = $false
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [System.IO.File]::WriteAllText('__OUTPUT__', $dialog.FileName, [System.Text.UTF8Encoding]::new($false))
}
`);
    return picked[0] || null;
  }
  const script = `POSIX path of (choose file with prompt "${PROMPTS[kind] || PROMPTS.project}"${darwinTypes(kind)})`;
  const result = spawnSync("/usr/bin/osascript", ["-e", script], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function chooseFiles(kind) {
  if (kind !== "font") return [];
  if (isWindows) {
    return writePickerResult(`
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '选择字体文件（可多选）'
$dialog.Filter = '${FILTERS.font}'
$dialog.Multiselect = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [System.IO.File]::WriteAllText('__OUTPUT__', ($dialog.FileNames -join [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))
}
`);
  }
  const result = spawnSync(
    "/usr/bin/osascript",
    [
      "-e",
      'set pickedFiles to choose file with prompt "选择字体文件（可多选）" with multiple selections allowed',
      "-e",
      'set outputText to ""',
      "-e",
      "repeat with aFile in pickedFiles",
      "-e",
      "set outputText to outputText & POSIX path of aFile & linefeed",
      "-e",
      "end repeat",
      "-e",
      "return outputText",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return [];
  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function chooseOutput(defaultName, extension = "mp4") {
  const safeName = String(defaultName || `快剪导出.${extension}`).replace(
    /["\\]/g,
    "",
  );
  if (isWindows) {
    const picked = writePickerResult(`
$dialog = New-Object System.Windows.Forms.SaveFileDialog
$dialog.Title = '保存导出视频'
$dialog.FileName = '${safeName.replaceAll("'", "''")}'
$dialog.Filter = '视频|*.mp4;*.mov;*.mp3|所有文件|*.*'
$dialog.AddExtension = $true
$dialog.OverwritePrompt = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [System.IO.File]::WriteAllText('__OUTPUT__', $dialog.FileName, [System.Text.UTF8Encoding]::new($false))
}
`);
    return picked[0] || null;
  }
  const script = `POSIX path of (choose file name with prompt "保存导出视频" default name "${safeName}")`;
  const result = spawnSync("/usr/bin/osascript", ["-e", script], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function readClipboard() {
  if (isWindows) {
    const result = powershellEncoded(`
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Windows.Forms
Write-Output ([Windows.Forms.Clipboard]::GetText())
`);
    if (result.status !== 0) throw new Error("无法读取系统剪贴板。");
    return result.stdout || "";
  }
  const result = spawnSync("/usr/bin/pbpaste", [], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error("无法读取系统剪贴板。");
  return result.stdout;
}

export function revealFile(filePath) {
  if (!filePath) return false;
  if (isWindows) {
    const result = spawnSync("explorer.exe", ["/select,", path.resolve(filePath)]);
    return result.status === 0 || result.status === 1;
  }
  return spawnSync("/usr/bin/open", ["-R", filePath]).status === 0;
}

export function findEdge() {
  const candidates = [
    process.env.QUICKCUT_BROWSER,
    path.join(
      process.env.PROGRAMFILES || "C:\\Program Files",
      "Microsoft",
      "Edge",
      "Application",
      "msedge.exe",
    ),
    path.join(
      process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
      "Microsoft",
      "Edge",
      "Application",
      "msedge.exe",
    ),
    path.join(
      process.env.LOCALAPPDATA || "",
      "Microsoft",
      "Edge",
      "Application",
      "msedge.exe",
    ),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

export function openDesktopWindow(url, profileRoot) {
  if (!url) return null;
  if (isWindows) {
    const edge = findEdge();
    if (edge) {
      const profile = profileRoot || path.join(os.tmpdir(), "QuickCutWindow");
      fs.mkdirSync(profile, { recursive: true });
      return spawn(
        edge,
        [
          `--app=${url}`,
          `--user-data-dir=${profile}`,
          "--window-size=1600,980",
          "--disable-features=TranslateUI",
          "--no-first-run",
        ],
        { stdio: "ignore", windowsHide: false },
      );
    }
    spawn("cmd.exe", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    return null;
  }
  spawn("/usr/bin/open", [url], { stdio: "ignore" }).unref();
  return null;
}

function tarBinary() {
  if (isWindows) {
    const system = path.join(process.env.WINDIR || "C:\\Windows", "System32", "tar.exe");
    if (fs.existsSync(system)) return system;
  }
  return whichBinary("tar") || "tar";
}

export function archiveEntries(archive) {
  if (isDarwin && fs.existsSync("/usr/bin/unzip")) {
    const result = spawnSync("/usr/bin/unzip", ["-Z1", archive], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.status !== 0) throw new Error("无法读取工程备份。");
    return String(result.stdout || "")
      .split(/\r?\n/)
      .filter(Boolean);
  }
  const result = spawnSync(tarBinary(), ["-tf", archive], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || "无法读取工程备份。");
  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((entry) => entry.replace(/\\/g, "/").replace(/\/+$/, ""))
    .filter(Boolean);
}

export function createArchive(destination, items, cwd) {
  if (isDarwin && fs.existsSync("/usr/bin/zip")) {
    const result = spawnSync("/usr/bin/zip", ["-qry", destination, ...items], {
      cwd,
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr || "备份失败。");
    return destination;
  }
  const result = spawnSync(tarBinary(), ["-a", "-cf", destination, ...items], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || "备份失败。");
  return destination;
}

export function extractArchive(archive, destination) {
  if (isDarwin && fs.existsSync("/usr/bin/unzip")) {
    const result = spawnSync("/usr/bin/unzip", ["-q", archive, "-d", destination], {
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr || "恢复失败。");
    return destination;
  }
  const result = spawnSync(tarBinary(), ["-xf", archive, "-C", destination], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || "恢复失败。");
  return destination;
}
