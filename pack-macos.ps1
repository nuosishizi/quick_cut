param(
  [string]$OutDir = ""
)
#Requires -Version 5.1
$ErrorActionPreference = "Stop"
try { chcp 65001 > $null } catch {}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Version = "2.7.42"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppName = "QuickCut-macOS-$Version"
$tempBase = [System.IO.Path]::GetTempPath()
$StageRoot = if (Test-Path "D:\") { "D:\QuickCut-mac-pack" } else { Join-Path $tempBase "QuickCut-mac-pack" }
$Stage = Join-Path $StageRoot $AppName
$desktop = [Environment]::GetFolderPath("Desktop")
$fallbackDir = if ($desktop -and (Test-Path $desktop)) { $desktop } else { $ProjectRoot }
$TargetDir = if ($OutDir) {
  if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
  (Resolve-Path $OutDir).Path
} else {
  $fallbackDir
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
  $cmdBunObj = Get-Command bun -ErrorAction SilentlyContinue
  $cmdBun = if ($cmdBunObj) { $cmdBunObj.Source } else { $null }
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
  $cmdFfmpegObj = Get-Command ffmpeg -ErrorAction SilentlyContinue
  $cmdFfmpeg = if ($cmdFfmpegObj) { $cmdFfmpegObj.Source } else { $null }
  if ($cmdFfmpeg) {
    New-Item -ItemType Directory -Force -Path (Split-Path $Ffmpeg) | Out-Null
    Copy-Item $cmdFfmpeg $Ffmpeg
  }
}
if (-not (Test-Path $Ffprobe)) {
  $cmdFfprobeObj = Get-Command ffprobe -ErrorAction SilentlyContinue
  $cmdFfprobe = if ($cmdFfprobeObj) { $cmdFfprobeObj.Source } else { $null }
  if ($cmdFfprobe) {
    New-Item -ItemType Directory -Force -Path (Split-Path $Ffprobe) | Out-Null
    Copy-Item $cmdFfprobe $Ffprobe
  }
}

foreach ($required in @($Bun, $Ffmpeg, $Ffprobe)) {
  if (-not (Test-Path $required)) { Fail "Missing Mac runtime: $required" }
}

Info "Copying Apple Silicon runtime and editor..."
$EditorDst = Join-Path $Stage "Modules/EditorRuntime/editor-desktop"
$MediaDst = Join-Path $Stage "Modules/EditorRuntime/media"
$BunDst = Join-Path $Stage "Modules/EditorRuntime/runtime"
New-Item -ItemType Directory -Force -Path $EditorDst, $MediaDst, $BunDst | Out-Null
Copy-Item (Join-Path $RuntimeSrc "editor-desktop/package.json") $EditorDst
Copy-Item -Recurse (Join-Path $RuntimeSrc "editor-desktop/src") (Join-Path $EditorDst "src")
Copy-Item -Recurse (Join-Path $RuntimeSrc "editor-desktop/assets") (Join-Path $EditorDst "assets")
Copy-Item $Bun (Join-Path $BunDst "bun-arm64")
Copy-Item $Ffmpeg (Join-Path $MediaDst "ffmpeg")
Copy-Item $Ffprobe (Join-Path $MediaDst "ffprobe")
$Deepfilter = Join-Path $RuntimeSrc "media/deepfilter"
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
# Build native macOS App and DMG if Xcode is available
$xcodeCmd = Get-Command xcodebuild -ErrorAction SilentlyContinue
$xcodebuild = if ($xcodeCmd) { $xcodeCmd.Source } else { $null }
$hdiCmd = Get-Command hdiutil -ErrorAction SilentlyContinue
$hdiutil = if ($hdiCmd) { $hdiCmd.Source } else { $null }

if ($xcodebuild -and $hdiutil) {
  try {
    Info "Building native macOS QuickCut.app with xcodebuild..."
    $derivedData = Join-Path $StageRoot "DerivedData"
    if (Test-Path $derivedData) { Remove-Item -Recurse -Force $derivedData }
    $projPath = Join-Path $ProjectRoot "QuickCut.xcodeproj"

    & xcodebuild -project $projPath -scheme QuickCut -configuration Release -derivedDataPath $derivedData ARCHS="arm64" ONLY_ACTIVE_ARCH=NO CODE_SIGNING_ALLOWED=NO SWIFT_OPTIMIZATION_LEVEL=-Onone clean build
    
    $builtApp = Join-Path $derivedData "Build/Products/Release/QuickCut.app"
    if (-not (Test-Path $builtApp)) {
      $foundApp = Get-ChildItem -Path $derivedData -Recurse -Filter "QuickCut.app" | Select-Object -First 1
      $builtApp = if ($foundApp) { $foundApp.FullName } else { $null }
    }

    if ($builtApp -and (Test-Path $builtApp)) {
      Info "Embedding runtime into QuickCut.app..."
      $appDst = Join-Path $Stage "快剪.app"
      if (Test-Path $appDst) { Remove-Item -Recurse -Force $appDst }
      Copy-Item -Recurse $builtApp $appDst

      $runtimeDst = Join-Path $appDst "Contents/Resources/EditorRuntime"
      New-Item -ItemType Directory -Force -Path $runtimeDst | Out-Null
      $sourceModules = Join-Path $Stage "Modules/EditorRuntime"
      if (Test-Path $sourceModules) {
        Get-ChildItem $sourceModules | ForEach-Object {
          Copy-Item -Recurse $_.FullName (Join-Path $runtimeDst $_.Name) -Force
        }
      }

      # Clear attributes and set execution permissions on macOS
      if (Get-Command chmod -ErrorAction SilentlyContinue) {
        & chmod -R +x (Join-Path $appDst "Contents/MacOS")
        if (Test-Path (Join-Path $runtimeDst "runtime/bun-arm64")) { & chmod +x (Join-Path $runtimeDst "runtime/bun-arm64") }
        if (Test-Path (Join-Path $runtimeDst "media/ffmpeg")) { & chmod +x (Join-Path $runtimeDst "media/ffmpeg") }
        if (Test-Path (Join-Path $runtimeDst "media/ffprobe")) { & chmod +x (Join-Path $runtimeDst "media/ffprobe") }
      }
      if (Get-Command xattr -ErrorAction SilentlyContinue) {
        & xattr -cr $appDst
      }

      # Standard inside-out code sign for nested binaries
      if (Get-Command codesign -ErrorAction SilentlyContinue) {
        Info "Code-signing embedded binaries and QuickCut.app..."
        $bunBin = Join-Path $runtimeDst "runtime/bun-arm64"
        $ffmpegBin = Join-Path $runtimeDst "media/ffmpeg"
        $ffprobeBin = Join-Path $runtimeDst "media/ffprobe"
        $mainBin = Join-Path $appDst "Contents/MacOS/QuickCut"
        
        if (Test-Path $bunBin) { & codesign --force --sign - $bunBin }
        if (Test-Path $ffmpegBin) { & codesign --force --sign - $ffmpegBin }
        if (Test-Path $ffprobeBin) { & codesign --force --sign - $ffprobeBin }
        if (Test-Path $mainBin) { & codesign --force --sign - $mainBin }
        & codesign --force --deep --sign - $appDst
      }

      # Create DMG Installer
      Info "Creating macOS DMG installer..."
      $dmgStage = Join-Path $StageRoot "dmg-stage"
      if (Test-Path $dmgStage) { Remove-Item -Recurse -Force $dmgStage }
      New-Item -ItemType Directory -Force -Path $dmgStage | Out-Null
      Copy-Item -Recurse $appDst (Join-Path $dmgStage "快剪.app")
      if (Get-Command ln -ErrorAction SilentlyContinue) {
        & ln -s /Applications (Join-Path $dmgStage "Applications")
      }

      # Add helper command script for Gatekeeper unquarantine
      $unquarantineScript = @"
#!/bin/bash
echo "============================================="
echo " 快剪 QuickCut · 首次打开权限修复工具"
echo "============================================="
echo ""
echo "正在解除 macOS Gatekeeper 隔离限制..."
APP_PATHS=(
  "/Applications/快剪.app"
  "/Applications/QuickCut.app"
  "`$HOME/Desktop/快剪.app"
  "`$(dirname "`$0")/快剪.app"
)
FIXED=0
for p in "`${APP_PATHS[@]}"; do
  if [ -d "`$p" ]; then
    xattr -cr "`$p" 2>/dev/null || true
    echo "✅ 已成功解除安全隔离: `$p"
    open "`$p" 2>/dev/null || true
    FIXED=1
    break
  fi
done
if [ `$FIXED -eq 0 ]; then
  echo "提示：请先将「快剪.app」拖入旁边的「Applications（应用程序）」文件夹，再双击本工具即可。"
fi
echo ""
echo "按任意键退出…"
read -n 1
"@
      $unquarantinePath = Join-Path $dmgStage "首次打开如果提示已损坏点我.command"
      Set-Content -Path $unquarantinePath -Value $unquarantineScript -Encoding UTF8
      if (Get-Command chmod -ErrorAction SilentlyContinue) {
        & chmod +x $unquarantinePath
      }

      $dmgEnglish = Join-Path $TargetDir "QuickCut-macOS-$Version-Installer.dmg"
      $dmgChinese = Join-Path $TargetDir "快剪-macOS-$Version-安装包.dmg"
      if (Test-Path $dmgEnglish) { Remove-Item -Force $dmgEnglish }
      if (Test-Path $dmgChinese) { Remove-Item -Force $dmgChinese }
      & hdiutil create -volname "QuickCut" -srcfolder $dmgStage -ov -format UDZO $dmgEnglish
      if (Test-Path $dmgEnglish) {
        Copy-Item $dmgEnglish $dmgChinese -Force
        $dmgItem = Get-Item $dmgChinese
        Info ("DMG Installer: {0}  ({1:N1} MB)" -f $dmgItem.FullName, ($dmgItem.Length / 1MB))
      }
    }
  } catch {
    Write-Host "Warning: DMG creation step note: $_" -ForegroundColor Yellow
  }
}

if (Test-Path $ZipPath) { Remove-Item -Force $ZipPath }
Info "Creating $ZipPath"
Compress-Archive -Path $Stage -DestinationPath $ZipPath -Force

$zip = Get-Item $ZipPath
Info ""
Info "Done."
Info "Folder: $Stage"
Info ("Zip:    {0}  ({1:N1} MB)" -f $zip.FullName, ($zip.Length / 1MB))
