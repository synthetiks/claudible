#!/usr/bin/env bash
# Claudible — one-command local voice setup (run inside WSL, normally via `npm run setup`).
# Installs Whisper (STT) + Kokoro (TTS) under ~/.claudible/voice, OR reuses an existing
# ~/.voicemode install. No Docker. First run downloads a ~150 MB speech model.
#
# NOTE (v0.1): the "reuse existing ~/.voicemode" path is tested. The from-scratch install below
# follows each upstream project's standard steps — verify it on a clean machine before relying on it.
set -euo pipefail

VOICE="${CLAUDIBLE_VOICE:-$HOME/.claudible/voice}"
mkdir -p "$VOICE" "$HOME/.claudible/logs"
say() { printf '\n\033[1m[claudible setup]\033[0m %s\n' "$*"; }

# 0. Reuse an existing Voicemode install if present — nothing to build.
if [ -d "$HOME/.voicemode/services/kokoro" ] && [ -d "$HOME/.voicemode/services/whisper" ]; then
  say "Found an existing Voicemode install at ~/.voicemode — Claudible will use it. Done."
  exit 0
fi

# 1. Prereqs
MISSING=""
for c in git cmake make ffmpeg python3 uv; do command -v "$c" >/dev/null 2>&1 || MISSING="$MISSING $c"; done
if [ -n "$MISSING" ]; then
  say "Missing prerequisites:$MISSING"
  echo "  sudo apt install -y git cmake build-essential ffmpeg python3"
  echo "  curl -LsSf https://astral.sh/uv/install.sh | sh   # for uv"
  exit 1
fi

# 2. Whisper — whisper.cpp server + base model -> $VOICE/whisper
if [ ! -x "$VOICE/whisper/build/bin/whisper-server" ]; then
  say "Installing Whisper (whisper.cpp)…"
  rm -rf "$VOICE/whisper"
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$VOICE/whisper"
  cmake -B "$VOICE/whisper/build" -S "$VOICE/whisper" -DWHISPER_BUILD_SERVER=ON
  cmake --build "$VOICE/whisper/build" --config Release -j
  say "Downloading base speech model (~150 MB)…"
  ( cd "$VOICE/whisper" && bash ./models/download-ggml-model.sh base )
else
  say "Whisper already installed."
fi

# 3. Kokoro — FastAPI TTS (CPU torch via uv) -> $VOICE/kokoro
if [ ! -d "$VOICE/kokoro" ]; then
  say "Installing Kokoro (TTS)…"
  git clone --depth 1 https://github.com/remsky/Kokoro-FastAPI "$VOICE/kokoro"
  # CPU install only — do NOT run the project's CUDA start script (it reinstalls a CUDA torch that segfaults here).
  ( cd "$VOICE/kokoro" && uv sync )
else
  say "Kokoro already installed."
fi

say "Done. Start Claudible with:  npm start"
