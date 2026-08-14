@echo off
setlocal
cd /d "%~dp0"
title QuickCut
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-quickcut.ps1"
if errorlevel 1 pause
endlocal