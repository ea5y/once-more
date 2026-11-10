#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
destination="$root/src-tauri/binaries"
model="$destination/ggml-silero-v5.1.2.bin"
expected=29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf
mkdir -p "$destination"
if [ ! -f "$model" ]; then
  curl --fail --location --proto '=https' --tlsv1.2 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin' -o "$model.download"
  actual=$(shasum -a 256 "$model.download" | cut -d ' ' -f 1)
  [ "$actual" = "$expected" ] || { echo 'VAD model checksum mismatch.' >&2; exit 1; }
  mv "$model.download" "$model"
fi
actual=$(shasum -a 256 "$model" | cut -d ' ' -f 1)
[ "$actual" = "$expected" ] || { echo 'VAD model checksum mismatch.' >&2; exit 1; }
if [ ! -f "$destination/Silero-LICENSE.txt" ]; then
  curl --fail --location --proto '=https' --tlsv1.2 'https://raw.githubusercontent.com/snakers4/silero-vad/master/LICENSE' -o "$destination/Silero-LICENSE.txt"
fi
printf 'Silero VAD v5.1.2 (MIT)\nhttps://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin\nSHA256: %s\nUpstream: https://github.com/snakers4/silero-vad\n' "$expected" > "$destination/Silero-SOURCE.txt"
