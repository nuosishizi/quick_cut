#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
RUNTIME="$ROOT/Modules/EditorRuntime"
BUN="$RUNTIME/runtime/bun-arm64"
FFMPEG="$RUNTIME/media/ffmpeg"
FFPROBE="$RUNTIME/media/ffprobe"
EDITOR="$RUNTIME/editor-desktop"
SCRIPT="$EDITOR/src/main.mjs"

fail() {
  echo ""
  echo "$1"
  echo ""
  read -k 1 "?按任意键退出…"
  exit 1
}

ARCH="$(uname -m)"
if [[ "$ARCH" == "x86_64" ]]; then
  TRANSLATED="$(/usr/sbin/sysctl -in sysctl.proc_translated 2>/dev/null || printf 0)"
  if [[ "$TRANSLATED" == "1" ]]; then ARCH="arm64"; fi
fi
[[ "$ARCH" == "arm64" ]] || fail "当前测试包只支持 Apple 芯片 Mac（M1 / M2 / M3 / M4）。"

[[ -f "$SCRIPT" ]] || fail "找不到编辑器：Modules/EditorRuntime/editor-desktop/src/main.mjs"
[[ -f "$BUN" ]] || fail "找不到运行组件：Modules/EditorRuntime/runtime/bun-arm64"
[[ -f "$FFMPEG" && -f "$FFPROBE" ]] || fail "找不到 FFmpeg / FFprobe。"

/usr/bin/xattr -cr "$ROOT" >/dev/null 2>&1 || true
/bin/chmod +x "$BUN" "$FFMPEG" "$FFPROBE" 2>/dev/null || true
[[ -x "$BUN" && -x "$FFMPEG" && -x "$FFPROBE" ]] || fail "无法恢复运行组件执行权限。"

export QUICKCUT_MEDIA_ROOT="$RUNTIME/media"
unset QUICKCUT_APP_EXECUTABLE
unset QUICKCUT_NO_WINDOW
cd "$EDITOR"

echo "============================================="
echo " 快剪 QuickCut 2.7.3  macOS"
echo "============================================="
echo "正在启动编辑器…"
echo "关闭这个终端窗口即可退出。"
echo ""

exec "$BUN" "$SCRIPT"
