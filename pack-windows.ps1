#Requires -Version 5.1
$ErrorActionPreference = "Stop"
try { chcp 65001 > $null } catch {}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Version = "2.7.19"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppName = "QuickCut-Windows-$Version"
$StageRoot = "D:\QuickCut-win-pack"
if (-not (Test-Path "D:\")) { $StageRoot = Join-Path $env:TEMP "QuickCut-win-pack" }
$Stage = Join-Path $StageRoot $AppName
$Cache = Join-Path $StageRoot "cache"
$Desktop = [Environment]::GetFolderPath("Desktop")
$ZipPath = Join-Path $Desktop "快剪-Windows-$Version-测试包.zip"
$NodeVersion = "22.18.0"
$NodeZipName = "node-v$NodeVersion-win-x64.zip"
$NodeUrl = "https://nodejs.org/dist/v$NodeVersion/$NodeZipName"
$LocalFfmpegBin = "C:\ffmpeg-master-latest-win64-gpl-shared\bin"

function Info([string]$Message) { Write-Host $Message -ForegroundColor Cyan }
function Fail([string]$Message) { Write-Host $Message -ForegroundColor Red; exit 1 }

function Download-File([string]$Url, [string]$Destination) {
  if (Test-Path $Destination) {
    Info "Using cached $(Split-Path $Destination -Leaf)"
    return
  }
  Info "Downloading $Url"
  $partial = "$Destination.partial"
  if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    & curl.exe -L --fail --retry 3 --retry-delay 2 -o $partial $Url
    if ($LASTEXITCODE -ne 0) { Fail "Download failed: $Url" }
  } else {
    Invoke-WebRequest -Uri $Url -OutFile $partial -UseBasicParsing
  }
  Move-Item -Force $partial $Destination
}

New-Item -ItemType Directory -Force -Path $Cache | Out-Null
if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Force -Path $Stage | Out-Null

$EditorSrc = Join-Path $ProjectRoot "Modules\EditorRuntime\editor-desktop"
$EditorDst = Join-Path $Stage "Modules\EditorRuntime\editor-desktop"
$MediaDst = Join-Path $Stage "Modules\EditorRuntime\media"
New-Item -ItemType Directory -Force -Path $EditorDst | Out-Null
New-Item -ItemType Directory -Force -Path $MediaDst | Out-Null

Info "Copying editor..."
Copy-Item (Join-Path $EditorSrc "package.json") $EditorDst
Copy-Item (Join-Path $EditorSrc "README-使用说明.txt") $EditorDst
Copy-Item -Recurse (Join-Path $EditorSrc "src") (Join-Path $EditorDst "src")
Copy-Item -Recurse (Join-Path $EditorSrc "assets") (Join-Path $EditorDst "assets")

Info "Copying Windows FFmpeg..."
if (-not (Test-Path (Join-Path $LocalFfmpegBin "ffmpeg.exe"))) {
  Fail "Local FFmpeg not found at $LocalFfmpegBin"
}
Get-ChildItem $LocalFfmpegBin -File | Where-Object {
  $_.Name -ne "ffplay.exe"
} | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $MediaDst $_.Name)
}

Info "Preparing portable Node.js $NodeVersion..."
$NodeZip = Join-Path $Cache $NodeZipName
Download-File $NodeUrl $NodeZip
$NodeExtract = Join-Path $Cache "node-v$NodeVersion-win-x64"
if (-not (Test-Path (Join-Path $NodeExtract "node.exe"))) {
  if (Test-Path $NodeExtract) { Remove-Item -Recurse -Force $NodeExtract }
  Expand-Archive -Path $NodeZip -DestinationPath $Cache -Force
}
$RuntimeNode = Join-Path $Stage "runtime\node"
New-Item -ItemType Directory -Force -Path $RuntimeNode | Out-Null
Copy-Item (Join-Path $NodeExtract "node.exe") (Join-Path $RuntimeNode "node.exe")
Get-ChildItem $NodeExtract -File -Filter "*.dll" | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $RuntimeNode $_.Name)
}

$Launcher = @"
@echo off
setlocal
cd /d "%~dp0"
title QuickCut $Version
set "QUICKCUT_MEDIA_ROOT=%~dp0Modules\EditorRuntime\media"
set "PATH=%~dp0runtime\node;%QUICKCUT_MEDIA_ROOT%;%PATH%"
if not exist "%~dp0runtime\node\node.exe" (
  echo Missing bundled Node.js.
  pause
  exit /b 1
)
if not exist "%QUICKCUT_MEDIA_ROOT%\ffmpeg.exe" (
  echo Missing bundled FFmpeg.
  pause
  exit /b 1
)
echo Starting QuickCut $Version ...
cd /d "%~dp0Modules\EditorRuntime\editor-desktop"
"%~dp0runtime\node\node.exe" "src\main.mjs"
if errorlevel 1 (
  echo.
  echo QuickCut exited with an error.
  pause
)
endlocal
"@
Set-Content -Path (Join-Path $Stage "启动快剪.bat") -Value $Launcher -Encoding ASCII

$Readme = @"
快剪 QuickCut $Version  Windows 测试包

系统要求
- Windows 10 / 11 64 位
- 已安装 Microsoft Edge（一般系统自带）
- 不需要单独安装 Node.js 或 FFmpeg

怎么用
1. 解压整个文件夹，不要只拷其中一个文件。
2. 双击「启动快剪.bat」。
3. 如果 SmartScreen 拦截，选「更多信息」→「仍要运行」。
4. 关掉编辑器窗口即退出。

测试建议
- 新建工程，导入一段口播视频。
- 在字幕页粘贴正确文案，保存 Groq API Key 后再匹配。
- 试一下剪停顿、高亮字幕、导出视频、导出达芬奇。
- 达芬奇字幕请选 xml / ttml / dfxp，不要选 srt 或 ass。

说明
- 工程数据保存在当前 Windows 用户的 %APPDATA%\QuickCut。
- 本包不含任何 API Key，也不含你的工程和素材。
- 仅供测试，版权归 HX。
"@
Set-Content -Path (Join-Path $Stage "使用说明.txt") -Value $Readme -Encoding UTF8

Info "Smoke-checking bundled binaries..."
$nodeExe = Join-Path $RuntimeNode "node.exe"
$ffmpegExe = Join-Path $MediaDst "ffmpeg.exe"
$ffprobeExe = Join-Path $MediaDst "ffprobe.exe"
& $nodeExe -e "console.log(process.version)"
if ($LASTEXITCODE -ne 0) { Fail "Bundled Node.js failed." }
& $ffmpegExe -version | Select-Object -First 1
if ($LASTEXITCODE -ne 0) { Fail "Bundled FFmpeg failed." }
& $ffprobeExe -version | Select-Object -First 1
if ($LASTEXITCODE -ne 0) { Fail "Bundled FFprobe failed." }
& $nodeExe --check (Join-Path $EditorDst "src\main.mjs")
if ($LASTEXITCODE -ne 0) { Fail "Editor main.mjs failed syntax check." }

if (Test-Path $ZipPath) { Remove-Item -Force $ZipPath }
Info "Creating $ZipPath"
if (Get-Command tar.exe -ErrorAction SilentlyContinue) {
  Push-Location $StageRoot
  & tar.exe -a -cf $ZipPath $AppName
  if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "zip failed." }
  Pop-Location
} else {
  Compress-Archive -Path $Stage -DestinationPath $ZipPath -Force
}

$zip = Get-Item $ZipPath
Info ""
Info "Done."
Info "Folder: $Stage"
Info ("Zip:    {0}  ({1:N1} MB)" -f $zip.FullName, ($zip.Length / 1MB))
