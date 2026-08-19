# release.ps1 - QuickCut Release Automation Helper
param(
  [Parameter(Mandatory=$true)]
  [string]$Version
)

$ErrorActionPreference = "Stop"

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  Write-Host "Version must follow semantic versioning, e.g. 2.7.42" -ForegroundColor Red
  exit 1
}

Write-Host "==> Checking git status..." -ForegroundColor Cyan
$status = git status --porcelain
if ($status) {
  Write-Host "Uncommitted changes detected. Please commit or stash first." -ForegroundColor Yellow
}

Write-Host "==> Running full test suite..." -ForegroundColor Cyan
Push-Location "Modules/EditorRuntime/editor-desktop"
node --test tests/alignment-status.test.mjs tests/script-judge.test.mjs tests/resolve-export.test.mjs tests/resolve-link.test.mjs tests/export-captions.test.mjs tests/timeline-edit.test.mjs tests/text-layout.test.mjs tests/ui-regressions.test.mjs tests/punctuation-quotes.test.mjs tests/denoise-isolation.test.mjs
if ($LASTEXITCODE -ne 0) {
  Pop-Location
  Write-Host "Tests failed! Aborting release." -ForegroundColor Red
  exit 1
}
Pop-Location

Write-Host "==> Packaging Windows & macOS locally..." -ForegroundColor Cyan
powershell -ExecutionPolicy Bypass -File .\pack-windows.ps1
powershell -ExecutionPolicy Bypass -File .\pack-macos.ps1

Write-Host "==> Creating Git Tag v$Version..." -ForegroundColor Cyan
git tag -a "v$Version" -m "Release QuickCut v$Version" -f

Write-Host "==> Pushing to origin..." -ForegroundColor Cyan
git push origin master
git push origin "v$Version" -f

Write-Host ""
Write-Host "Done! Tag v$Version pushed. GitHub Actions CI will build & release automatically." -ForegroundColor Green
