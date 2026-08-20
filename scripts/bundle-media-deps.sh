#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
MEDIA="$ROOT/Modules/EditorRuntime/media"
LIB="$MEDIA/lib"
BREW_FFMPEG="/opt/homebrew/bin/ffmpeg"
BREW_FFPROBE="/opt/homebrew/bin/ffprobe"

fail() {
  print -u2 "错误：$1"
  exit 1
}

[[ "$(uname -m)" == arm64 ]] || fail "目前只支持 Apple 芯片 Mac。"
[[ -x "$BREW_FFMPEG" && -x "$BREW_FFPROBE" ]] || fail "没有找到 Homebrew 安装的 FFmpeg。"

/bin/mkdir -p "$MEDIA"
/bin/cp "$BREW_FFMPEG" "$MEDIA/ffmpeg"
/bin/cp "$BREW_FFPROBE" "$MEDIA/ffprobe"
/bin/chmod +x "$MEDIA/ffmpeg" "$MEDIA/ffprobe"
/bin/mkdir -p "$LIB"
/usr/bin/find "$LIB" -type f -name '*.dylib' -delete

typeset -a queue
queue=("$MEDIA/ffmpeg" "$MEDIA/ffprobe")

is_system_library() {
  [[ "$1" == /System/* || "$1" == /usr/lib/* ]]
}

while (( ${#queue[@]} )); do
  current="${queue[1]}"
  queue=("${queue[@]:1}")

  while IFS= read -r dependency; do
    [[ -n "$dependency" ]] || continue
    is_system_library "$dependency" && continue
    original_dependency="$dependency"
    if [[ "$dependency" == @rpath/* ]]; then
      dependency="/opt/homebrew/lib/${dependency:t}"
    elif [[ "$dependency" == @loader_path/* ]]; then
      dependency="${current:h}/${dependency#@loader_path/}"
    fi
    [[ -f "$dependency" ]] || fail "找不到动态库：$original_dependency"

    name="${dependency:t}"
    destination="$LIB/$name"
    if [[ ! -e "$destination" ]]; then
      /bin/cp -L "$dependency" "$destination"
      /bin/chmod u+w "$destination"
      queue+=("$destination")
    fi

    if [[ "$current" == "$MEDIA/ffmpeg" || "$current" == "$MEDIA/ffprobe" ]]; then
      replacement="@loader_path/lib/$name"
    else
      replacement="@loader_path/$name"
    fi
    /usr/bin/install_name_tool -change "$original_dependency" "$replacement" "$current"
  done < <(/usr/bin/otool -L "$current" | /usr/bin/awk 'NR > 1 {print $1}')
done

for dylib in "$LIB"/*.dylib; do
  /usr/bin/install_name_tool -id "@loader_path/${dylib:t}" "$dylib"
  /usr/bin/codesign --force --sign - "$dylib"
done
/usr/bin/codesign --force --sign - "$MEDIA/ffmpeg"
/usr/bin/codesign --force --sign - "$MEDIA/ffprobe"

DYLD_LIBRARY_PATH="$LIB" "$MEDIA/ffmpeg" -version >/dev/null
DYLD_LIBRARY_PATH="$LIB" "$MEDIA/ffprobe" -version >/dev/null
print "FFmpeg 已改为可随软件携带的版本，共打包 $(/usr/bin/find "$LIB" -type f -name '*.dylib' | /usr/bin/wc -l | /usr/bin/tr -d ' ') 个动态库。"
