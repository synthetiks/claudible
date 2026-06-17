#!/usr/bin/env bash
# Claudible — one-command local voice setup (run inside WSL, normally via `npm run setup`).
# Installs Whisper (STT) + Kokoro (TTS) under ~/.claudible/voice, OR reuses an existing
# ~/.voicemode install. No Docker. First run downloads speech models (~150 MB Whisper + ~327 MB Kokoro).
#
# NOTE (v0.1): the "reuse existing ~/.voicemode" path is exercised regularly. The from-scratch install
# below clones + builds whisper.cpp and Kokoro and downloads their models from GitHub releases, so it
# needs network access and a few GB of disk; it is the less-travelled path, so report anything that
# trips on a clean machine.
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
  echo "  sudo apt install -y git cmake build-essential ffmpeg python3 espeak-ng"
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
  # --extra cpu pulls torch==2.6.0+cpu from the pytorch-cpu index. A bare `uv sync` instead resolves torch
  # (a transitive dep of kokoro) from default PyPI, which on Linux is the ~731MB CUDA wheel + ~2GB of nvidia-*
  # packages — the exact CUDA torch this comment warns against.
  ( cd "$VOICE/kokoro" && uv sync --extra cpu )
else
  say "Kokoro already installed."
fi

# 3b. Kokoro model weights (~327 MB) — the repo gitignores *.pth, so a clone has NO model.
# Without this the server exits at warmup (FileNotFoundError) and :8880 never binds. Idempotent:
# download_model.py skips itself if the file already exists. Kept outside the dir guard above so a
# checkout that somehow lacks the model still gets repaired on a re-run.
if [ ! -f "$VOICE/kokoro/api/src/models/v1_0/kokoro-v1_0.pth" ]; then
  say "Downloading Kokoro model weights (~327 MB)…"
  ( cd "$VOICE/kokoro" && uv run --no-sync python docker/scripts/download_model.py --output api/src/models/v1_0 )
else
  say "Kokoro model already present."
fi

say "Done. Start Claudible with:  npm start"
