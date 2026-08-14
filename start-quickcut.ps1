#Requires -Version 5.1
$ErrorActionPreference = "Stop"
try { chcp 65001 > $null } catch {}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Editor = Join-Path $Root "Modules\EditorRuntime\editor-desktop"
Set-Location $Editor

function Fail([string]$Message) {
  Write-Host ""
  Write-Host $Message -ForegroundColor Red
  Write-Host ""
  exit 1
}

Write-Host "============================================="
Write-Host " QuickCut Windows"
Write-Host "============================================="
Write-Host ""

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail "Node.js not found. Install LTS from https://nodejs.org/ and run again."
}

Write-Host "Node.js $($node.Source)"
if (-not (Test-Path (Join-Path $Editor "node_modules"))) {
  Write-Host "First run: installing optional dependencies..."
  npm install --omit=optional
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Optional install failed, trying full install..."
    npm install
  }
}

$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
$ffprobe = Get-Command ffprobe -ErrorAction SilentlyContinue
if (-not $ffmpeg -or -not $ffprobe) {
  Fail "FFmpeg / FFprobe not found. Add FFmpeg bin to PATH and run again."
}
Write-Host "FFmpeg $($ffmpeg.Source)"

Write-Host "Starting editor..."
Write-Host "Close the editor window to stop this console."
Write-Host ""

Remove-Item Env:QUICKCUT_NO_WINDOW -ErrorAction SilentlyContinue
node "src\main.mjs"
if ($LASTEXITCODE -ne 0) {
  Fail "Editor exited with code $LASTEXITCODE."
}