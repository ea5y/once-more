#!/bin/sh
set -eu

# Reproducible, audio-only LGPL build. Run on the target OS/architecture.
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=9.0.2
work="$root/.local/ffmpeg-build"
destination="$root/src-tauri/binaries"
mkdir -p "$work" "$destination"
cd "$work"
if [ ! -f "ffmpeg-$version.tar.xz" ]; then
  curl --fail --location --proto '=https' --tlsv1.2 "https://ffmpeg.org/releases/ffmpeg-$version.tar.xz" -o "ffmpeg-$version.tar.xz.download"
  mv "ffmpeg-$version.tar.xz.download" "ffmpeg-$version.tar.xz"
fi
if [ ! -d "ffmpeg-$version" ]; then tar -xf "ffmpeg-$version.tar.xz"; fi
cd "ffmpeg-$version"
./configure --disable-everything --disable-autodetect --disable-doc --disable-network \
  --disable-shared --enable-static --disable-x86asm \
  --enable-ffmpeg --enable-ffprobe --disable-ffplay \
  --enable-protocol=file,pipe \
  --enable-demuxer=wav,mp3,mov,flac,ogg,aiff,aac \
  --enable-parser=aac,mpegaudio,flac,opus,vorbis \
  --enable-decoder=pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_f64le,pcm_u8,pcm_s16be,pcm_s24be,pcm_s32be,pcm_f32be,pcm_f64be,mp3,mp3float,flac,aac,alac,vorbis,opus \
  --enable-encoder=pcm_f32le,pcm_s24le,pcm_s16le \
  --enable-muxer=pcm_f32le,wav,ipod,mp4,mov \
  --enable-filter=aresample,aformat,anull,atrim,asetpts
make -j4 ffmpeg ffprobe
cp ffmpeg ffprobe "$destination/"
cp COPYING.LGPLv2.1 "$destination/FFmpeg-LICENSE.txt"
cp ffbuild/config.log "$work/config.log"
printf 'FFmpeg %s\nSource: https://ffmpeg.org/releases/ffmpeg-%s.tar.xz\nBuilt by scripts/build-audio-tools.sh (audio-only LGPL configuration).\n' "$version" "$version" > "$destination/FFmpeg-SOURCE.txt"
echo "Audio tools prepared at $destination"
