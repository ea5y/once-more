#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
revision=4979e04f5dcaccb36057e059bbaed8a2f5288315
source_dir="$root/.local/verification/whisper.cpp"
build_dir="$root/.local/verification/whisper-static"
if [ ! -d "$source_dir/.git" ]; then
  git clone https://github.com/ggml-org/whisper.cpp.git "$source_dir"
  git -C "$source_dir" checkout "$revision"
fi
[ "$(git -C "$source_dir" rev-parse HEAD)" = "$revision" ] || { echo 'Whisper source revision does not match.' >&2; exit 1; }
patch_file="$root/scripts/patches/whisper-utf8-wrap.patch"
if git -C "$source_dir" apply --check "$patch_file" 2>/dev/null; then
  git -C "$source_dir" apply "$patch_file"
else
  git -C "$source_dir" apply --reverse --check "$patch_file" || { echo 'Unexpected Whisper source changes.' >&2; exit 1; }
fi
cmake_bin=${CMAKE_BIN:-cmake}
sdk=$(xcrun --show-sdk-path)
"$cmake_bin" -S "$source_dir" -B "$build_dir" -DBUILD_SHARED_LIBS=OFF -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DCMAKE_CXX_FLAGS="-I$sdk/usr/include/c++/v1"
"$cmake_bin" --build "$build_dir" --config Release --target whisper-cli -j 4
mkdir -p "$root/src-tauri/binaries"
cp "$build_dir/bin/whisper-cli" "$root/src-tauri/binaries/whisper-cli"
cp "$source_dir/LICENSE" "$root/src-tauri/binaries/Whisper-LICENSE.txt"
printf 'whisper.cpp v1.8.2\nRevision: %s\nhttps://github.com/ggml-org/whisper.cpp\nLocal patch: UTF-8-safe segment wrapping (scripts/patches/whisper-utf8-wrap.patch).\nStatic libraries, Metal enabled; build on target macOS architecture.\n' "$revision" > "$root/src-tauri/binaries/Whisper-SOURCE.txt"

sh "$root/scripts/prepare-vad-model.sh"
