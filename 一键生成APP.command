#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$ROOT/QuickCut.xcodeproj"
BUILD="$ROOT/build"
DERIVED="$BUILD/DerivedData"
LOG="$BUILD/xcodebuild.log"
ERRORS="$BUILD/errors.txt"
DST_APP="$HOME/Desktop/快剪.app"

fail() {
  echo ""
  echo "❌ $1"
  echo ""
  echo "日志目录：$BUILD"
  read -k 1 "?按任意键退出…"
  exit 1
}

mkdir -p "$BUILD"
: > "$LOG"
: > "$ERRORS"

printf '=============================================\n'
printf ' 快剪 QuickCut · 视频剪辑单模块版\n'
printf ' 仅保留视频剪辑模块\n'
printf '=============================================\n\n'

echo '▶ 1/4 检查 Xcode…'
[[ -d /Applications/Xcode.app ]] || fail '没有找到 /Applications/Xcode.app，请先安装完整 Xcode。'
/usr/bin/xcrun --find xcodebuild >/dev/null 2>&1 || fail 'xcodebuild 不可用，请先打开一次 Xcode 完成初始化。'

echo '▶ 2/4 编译 APP…'
rm -rf "$DERIVED"
BUILD_CONFIG="Release"

run_build() {
  local config="$1"
  shift
  set +e
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  /usr/bin/xcodebuild \
    -project "$PROJECT" \
    -scheme QuickCut \
    -configuration "$config" \
    -derivedDataPath "$DERIVED" \
    ARCHS=arm64 ONLY_ACTIVE_ARCH=YES \
    CODE_SIGNING_ALLOWED=NO \
    "$@" \
    clean build 2>&1 | /usr/bin/tee "$LOG"
  local st=${pipestatus[1]}
  set -e
  return $st
}

# 第一遍：标准 Release。
if ! run_build Release; then
  echo ''
  echo '⚠️ 标准 Release 编译失败，自动切换到低复杂度 Release 编译…'
  rm -rf "$DERIVED"
  : > "$LOG"
  # SwiftUI 超大 View 在部分 Xcode/SDK 组合下会出现 type-check 超时；
  # -Onone 不改变功能，只降低编译器求解和优化压力，后台 FFmpeg/Whisper 性能不受影响。
  if ! run_build Release SWIFT_OPTIMIZATION_LEVEL=-Onone SWIFT_COMPILATION_MODE=singlefile; then
    echo ''
    echo '⚠️ 低复杂度 Release 仍失败，自动尝试 Debug 兼容构建…'
    rm -rf "$DERIVED"
    : > "$LOG"
    BUILD_CONFIG="Debug"
    if ! run_build Debug SWIFT_OPTIMIZATION_LEVEL=-Onone SWIFT_COMPILATION_MODE=singlefile; then
      /usr/bin/grep -n -B 3 -A 10 'error:' "$LOG" > "$ERRORS" 2>/dev/null || true
      [[ -s "$ERRORS" ]] && /bin/cat "$ERRORS"
      fail '编译失败。完整日志已保存到 build/xcodebuild.log。'
    fi
  fi
fi

SRC_APP="$DERIVED/Build/Products/$BUILD_CONFIG/QuickCut.app"
[[ -x "$SRC_APP/Contents/MacOS/QuickCut" ]] || fail '编译完成但没有找到 QuickCut 可执行文件。'

echo '▶ 3/4 嵌入视频剪辑运行组件并签名…'
RUNTIME_SRC="$ROOT/Modules/EditorRuntime"
RUNTIME_DST="$SRC_APP/Contents/Resources/EditorRuntime"

# ZIP/浏览器下载可能丢失 Unix 可执行权限。这里先检查文件是否存在，
# 再主动恢复执行权限，避免把“权限丢失”误判成“组件不完整”。
[[ -d "$RUNTIME_SRC/editor-desktop/src" ]] || fail '缺少视频剪辑界面目录：Modules/EditorRuntime/editor-desktop/src'
[[ -f "$RUNTIME_SRC/runtime/bun-arm64" ]] || fail '缺少视频剪辑运行时：Modules/EditorRuntime/runtime/bun-arm64'
[[ -f "$RUNTIME_SRC/media/ffmpeg" ]] || fail '缺少 FFmpeg：Modules/EditorRuntime/media/ffmpeg'
[[ -f "$RUNTIME_SRC/media/ffprobe" ]] || fail '缺少 FFprobe：Modules/EditorRuntime/media/ffprobe'
[[ -f "$RUNTIME_SRC/editor-desktop/src/main.mjs" ]] || fail '缺少视频剪辑后端：editor-desktop/src/main.mjs'
[[ -f "$RUNTIME_SRC/editor-desktop/src/ui.html" ]] || fail '缺少视频剪辑界面：editor-desktop/src/ui.html'

/bin/chmod +x "$RUNTIME_SRC/runtime/bun-arm64" "$RUNTIME_SRC/media/ffmpeg" "$RUNTIME_SRC/media/ffprobe" 2>/dev/null || true

rm -rf "$RUNTIME_DST"
/bin/mkdir -p "$RUNTIME_DST/runtime" "$RUNTIME_DST/media" "$RUNTIME_DST/editor-desktop"
/usr/bin/ditto "$RUNTIME_SRC/editor-desktop/src" "$RUNTIME_DST/editor-desktop/src" || fail '打包编辑器源码失败。'
/usr/bin/ditto "$RUNTIME_SRC/editor-desktop/assets" "$RUNTIME_DST/editor-desktop/assets" || fail '打包编辑器资源失败。'
/bin/cp "$RUNTIME_SRC/editor-desktop/package.json" "$RUNTIME_DST/editor-desktop/package.json" || fail '打包 package.json 失败。'
/bin/cp "$RUNTIME_SRC/runtime/bun-arm64" "$RUNTIME_DST/runtime/bun-arm64" || fail '打包 Bun 失败。'
/bin/cp "$RUNTIME_SRC/media/ffmpeg" "$RUNTIME_DST/media/ffmpeg" || fail '打包 FFmpeg 失败。'
/bin/cp "$RUNTIME_SRC/media/ffprobe" "$RUNTIME_DST/media/ffprobe" || fail '打包 FFprobe 失败。'
/bin/chmod +x "$RUNTIME_DST/runtime/bun-arm64" "$RUNTIME_DST/media/ffmpeg" "$RUNTIME_DST/media/ffprobe" || fail '无法恢复视频剪辑运行组件执行权限。'

[[ -x "$RUNTIME_DST/runtime/bun-arm64" && -x "$RUNTIME_DST/media/ffmpeg" && -x "$RUNTIME_DST/media/ffprobe" ]] || fail '视频剪辑运行组件权限修复失败。'
/usr/bin/xattr -cr "$SRC_APP" >/dev/null 2>&1 || true
/usr/bin/codesign --force --deep --sign - "$SRC_APP" || fail 'APP 签名失败。'
/usr/bin/codesign --verify --deep --strict --verbose=2 "$SRC_APP" || fail 'APP 签名验证失败。'

echo '▶ 4/4 复制到桌面…'
rm -rf "$DST_APP"
/usr/bin/ditto "$SRC_APP" "$DST_APP" || fail '复制 APP 到桌面失败。'
/usr/bin/xattr -cr "$DST_APP" >/dev/null 2>&1 || true

printf '\n=============================================\n'
printf '✅ 已生成：%s\n' "$DST_APP"
printf '✅ 快剪 2.7.5 · 可发送字幕到达芬奇时间线（颜色/字号/描边/阴影/换行/背景）\n'
printf '✅ 视频剪辑界面已嵌入快剪主窗口；Bun / FFmpeg 后台仍为独立进程\n'
printf '✅ 使用 macOS 原生 WKWebView，不包含 Chromium / CEF\n'

printf '=============================================\n\n'
open -R "$DST_APP" || true
read -k 1 "?按任意键退出…"
