#!/usr/bin/env bash
# selfmedia-harvest :: batch download + ASR-ready audio extraction
#
# Usage:
#   scripts/dl-audio.sh <manifest.tsv> [video_dir] [audio_dir]
#
# manifest.tsv: one work per line, TAB separated:
#   <url-or-yt-dlp-target>    <basename-without-extension>
# Blank lines and lines starting with # are ignored.
#
# Env:
#   BROWSER    chrome|safari|edge|firefox|brave|none   (default chrome)
#   SLEEP      seconds between downloads               (default 1)
#   AUDIO_AR   audio sample rate                       (default 16000)
#   AUDIO_CH   audio channels                          (default 1)
#
# Example:
#   printf '%s\t%s\n' 'https://www.douyin.com/video/7663352040181496521' '2026-07-17_1239_renhedegoutong_76633520' > /tmp/m.tsv
#   scripts/dl-audio.sh /tmp/m.tsv videos audio
#
# Idempotent: a work whose audio already exists is skipped, so reruns are safe.

set -o pipefail

MANIFEST="$1"
VID_DIR="$2"
AUD_DIR="$3"

if [ -z "$MANIFEST" ]; then
  echo "usage: dl-audio.sh <manifest.tsv> [video_dir] [audio_dir]" >&2
  exit 1
fi
if [ -z "$VID_DIR" ]; then VID_DIR="videos"; fi
if [ -z "$AUD_DIR" ]; then AUD_DIR="audio"; fi
if [ -z "$BROWSER" ]; then BROWSER="chrome"; fi
if [ -z "$SLEEP" ]; then SLEEP=1; fi
if [ -z "$AUDIO_AR" ]; then AUDIO_AR=16000; fi
if [ -z "$AUDIO_CH" ]; then AUDIO_CH=1; fi

command -v yt-dlp >/dev/null || { echo "yt-dlp missing. Install: pip3 install -U yt-dlp" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg missing. Install: brew install ffmpeg" >&2; exit 1; }
[ -f "$MANIFEST" ] || { echo "manifest not found: $MANIFEST" >&2; exit 1; }

COOKIE_ARG=""
if [ "$BROWSER" != "none" ]; then
  COOKIE_ARG="--cookies-from-browser $BROWSER"
fi

mkdir -p "$VID_DIR" "$AUD_DIR"

ok=0
fail=0
skip=0

while IFS=$'\t' read -r URL BASE || [ -n "$URL" ]; do
  case "$URL" in
    ''|'#'*) continue ;;
  esac
  if [ -z "$BASE" ]; then BASE="work_$(date +%Y%m%d_%H%M%S)"; fi

  STEM="$VID_DIR/RAW_$BASE"
  MP4="$VID_DIR/$BASE.mp4"
  WAV="$AUD_DIR/$BASE.wav"
  LOG="$STEM.log"

  if [ -f "$WAV" ]; then
    echo "SKIP $BASE (audio exists)"
    skip=$((skip + 1))
    continue
  fi

  if ! ls "$STEM".* >/dev/null 2>&1; then
    echo "DL   $BASE"
    # shellcheck disable=SC2086
    if ! yt-dlp --no-warnings $COOKIE_ARG --socket-timeout 30 \
        -f "bv*+ba/b" --merge-output-format mp4 \
        -o "$STEM.%(ext)s" "$URL" >"$LOG" 2>&1; then
      echo "FAIL-DL $BASE"
      tail -n 3 "$LOG" | sed 's/^/    /'
      fail=$((fail + 1))
      continue
    fi
  fi

  SRC=$(ls "$STEM".* 2>/dev/null | grep -v '\.log$' | head -n 1)
  if [ -z "$SRC" ]; then
    echo "FAIL-NOFILE $BASE"
    fail=$((fail + 1))
    continue
  fi

  if ffmpeg -hide_banner -loglevel error -y -i "$SRC" -vn -map a:0 \
      -ac "$AUDIO_CH" -ar "$AUDIO_AR" -c:a pcm_s16le "$WAV"; then
    if [ "$SRC" != "$MP4" ]; then mv "$SRC" "$MP4"; fi
    DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$WAV")
    MEAN=$(ffmpeg -hide_banner -i "$WAV" -af volumedetect -f null - 2>&1 | grep mean_volume | sed 's/.*mean_volume: //')
    echo "OK   $BASE  dur=$DUR  mean=$MEAN"
    ok=$((ok + 1))
  else
    echo "FAIL-FFMPEG $BASE"
    fail=$((fail + 1))
  fi

  rm -f "$LOG"
  sleep "$SLEEP"
done < "$MANIFEST"

echo "--- ok=$ok fail=$fail skip=$skip ---"
if [ "$fail" -gt 0 ]; then exit 1; fi
