param(
  [string]$OutDir = ""
)
#Requires -Version 5.1
$ErrorActionPreference = "Stop"
try { chcp 65001 > $null } catch {}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Version = "2.7.41"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppName = "QuickCut-macOS-$Version"
$StageRoot = "D:\QuickCut-mac-pack"
if (-not (Test-Path "D:\")) { $StageRoot = Join-Path $env:TEMP "QuickCut-mac-pack" }
$Stage = Join-Path $StageRoot $AppName
$Desktop = [Environment]::GetFolderPath("Desktop")
$TargetDir = if ($OutDir -and (Test-Path $OutDir -IsValid)) {
  if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
  (Resolve-Path $OutDir).Path
} else {
  $Desktop
}
$ZipPath = Join-Path $TargetDir "快剪-macOS-$Version-测试包.zip"

function Info([string]$Message) { Write-Host $Message -ForegroundColor Cyan }
function Fail([string]$Message) { Write-Host $Message -ForegroundColor Red; exit 1 }

if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Force -Path $Stage | Out-Null

$RuntimeSrc = Join-Path $ProjectRoot "Modules/EditorRuntime"
$Bun = Join-Path $RuntimeSrc "runtime/bun-arm64"
$Ffmpeg = Join-Path $RuntimeSrc "media/ffmpeg"
$Ffprobe = Join-Path $RuntimeSrc "media/ffprobe"

$Cache = Join-Path $StageRoot "cache"
New-Item -ItemType Directory -Force -Path $Cache | Out-Null

function Download-File([string]$Url, [string]$Destination) {
  if (Test-Path $Destination) {
    Info "Using cached $(Split-Path $Destination -Leaf)"
    return
  }
  Info "Downloading $Url"
  $partial = "$Destination.partial"
  if (Get-Command curl -ErrorAction SilentlyContinue) {
    & curl -L --fail --retry 3 --retry-delay 2 -o $partial $Url
    if ($LASTEXITCODE -ne 0) { Fail "Download failed: $Url" }
  } elseif (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    & curl.exe -L --fail --retry 3 --retry-delay 2 -o $partial $Url
    if ($LASTEXITCODE -ne 0) { Fail "Download failed: $Url" }
  } else {
    Invoke-WebRequest -Uri $Url -OutFile $partial -UseBasicParsing
  }
  Move-Item -Force $partial $Destination
}

# 1. Resolve Bun arm64
if (-not (Test-Path $Bun)) {
  $cmdBun = (Get-Command bun -ErrorAction SilentlyContinue)?.Source
  if ($cmdBun) {
    New-Item -ItemType Directory -Force -Path (Split-Path $Bun) | Out-Null
    Copy-Item $cmdBun $Bun
  } else {
    Info "Fetching bun-darwin-aarch64..."
    $bunZip = Join-Path $Cache "bun-darwin-aarch64.zip"
    Download-File "https://github.com/oven-sh/bun/releases/latest/download/bun-darwin-aarch64.zip" $bunZip
    Expand-Archive -Path $bunZip -DestinationPath $Cache -Force
    $bunExtracted = Join-Path $Cache "bun-darwin-aarch64/bun"
    if (Test-Path $bunExtracted) {
      New-Item -ItemType Directory -Force -Path (Split-Path $Bun) | Out-Null
      Copy-Item $bunExtracted $Bun
    }
  }
}

# 2. Resolve macOS FFmpeg & FFprobe
if (-not (Test-Path $Ffmpeg)) {
  $cmdFfmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue)?.Source
  if ($cmdFfmpeg) {
    New-Item -ItemType Directory -Force -Path (Split-Path $Ffmpeg) | Out-Null
    Copy-Item $cmdFfmpeg $Ffmpeg
  }
}
if (-not (Test-Path $Ffprobe)) {
  $cmdFfprobe = (Get-Command ffprobe -ErrorAction SilentlyContinue)?.Source
  if ($cmdFfprobe) {
    New-Item -ItemType Directory -Force -Path (Split-Path $Ffprobe) | Out-Null
    Copy-Item $cmdFfprobe $Ffprobe
  }
}

foreach ($required in @($Bun, $Ffmpeg, $Ffprobe)) {
  if (-not (Test-Path $required)) { Fail "Missing Mac runtime: $required" }
}

Info "Copying Apple Silicon runtime and editor..."
$EditorDst = Join-Path $Stage "Modules\EditorRuntime\editor-desktop"
$MediaDst = Join-Path $Stage "Modules\EditorRuntime\media"
$BunDst = Join-Path $Stage "Modules\EditorRuntime\runtime"
New-Item -ItemType Directory -Force -Path $EditorDst, $MediaDst, $BunDst | Out-Null
Copy-Item (Join-Path $RuntimeSrc "editor-desktop\package.json") $EditorDst
Copy-Item -Recurse (Join-Path $RuntimeSrc "editor-desktop\src") (Join-Path $EditorDst "src")
Copy-Item -Recurse (Join-Path $RuntimeSrc "editor-desktop\assets") (Join-Path $EditorDst "assets")
Copy-Item $Bun (Join-Path $BunDst "bun-arm64")
Copy-Item $Ffmpeg (Join-Path $MediaDst "ffmpeg")
Copy-Item $Ffprobe (Join-Path $MediaDst "ffprobe")
$Deepfilter = Join-Path $RuntimeSrc "media\deepfilter"
if (Test-Path $Deepfilter) { Copy-Item $Deepfilter (Join-Path $MediaDst "deepfilter") }

Copy-Item (Join-Path $ProjectRoot "启动快剪.command") (Join-Path $Stage "启动快剪.command")
Copy-Item (Join-Path $ProjectRoot "一键生成APP.command") (Join-Path $Stage "一键生成APP.command")
Copy-Item -Recurse (Join-Path $ProjectRoot "QuickCut") (Join-Path $Stage "QuickCut")
Copy-Item -Recurse (Join-Path $ProjectRoot "QuickCut.xcodeproj") (Join-Path $Stage "QuickCut.xcodeproj")

$Readme = @"
快剪 QuickCut $Version  macOS 测试包

系统要求
- Apple 芯片 Mac（M1 / M2 / M3 / M4）
- macOS 13 或更高
- 不需要安装 Node.js / FFmpeg
- 做原生窗口 APP 才需要安装 Xcode

普通测试（推荐）
1. 解压整个文件夹。
2. 右键「启动快剪.command」→ 打开。
3. 若系统拦截：系统设置 → 隐私与安全性 → 仍要打开。
4. 若提示没有执行权限，打开「终端」执行：
   cd 到解压后的文件夹
   chmod +x 启动快剪.command
   xattr -cr .
   然后再右键打开。
5. 编辑器会在浏览器里打开。关掉终端窗口即退出。

做成桌面 APP
- 这台 Mac 已安装完整 Xcode 时，双击「一键生成APP.command」。
- 完成后桌面会有「快剪.app」，界面嵌在原生窗口里。

测试建议
- 新建工程，导入口播视频。
- 字幕页粘贴正确文案，保存 Groq API Key 后再匹配。
- 试剪停顿、高亮字幕、导出视频、导出达芬奇。
- 达芬奇字幕请选 xml / ttml / dfxp，不要选 srt 或 ass。

说明
- 工程数据在 ~/Library/Application Support/QuickCut。
- 本包不含 API Key、工程和素材。
- 仅供测试，版权归 HX。
"@
Set-Content -Path (Join-Path $Stage "使用说明.txt") -Value $Readme -Encoding UTF8

if (Test-Path $ZipPath) { Remove-Item -Force $ZipPath }
Info "Creating $ZipPath"
Compress-Archive -Path $Stage -DestinationPath $ZipPath -Force

$zip = Get-Item $ZipPath
Info ""
Info "Done."
Info "Folder: $Stage"
Info ("Zip:    {0}  ({1:N1} MB)" -f $zip.FullName, ($zip.Length / 1MB))
