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

# 1. Prereqs — auto-install whatever's missing (one-time). apt needs sudo; uv has its own installer.
APT_MISSING=""
for c in git cmake make g++ ffmpeg python3 espeak-ng curl; do command -v "$c" >/dev/null 2>&1 || APT_MISSING="$APT_MISSING $c"; done   # probe the FULL install set (g++/curl/espeak-ng too) so a box missing only those still triggers the install
if [ -n "$APT_MISSING" ]; then
  if command -v apt-get >/dev/null 2>&1; then
    say "Installing WSL build prerequisites ($APT_MISSING ) — you may be asked for your WSL sudo password…"
    if ! { sudo apt-get update -y && sudo apt-get install -y git cmake build-essential ffmpeg python3 espeak-ng curl; }; then
      say "Couldn't auto-install. Run this in WSL, then re-run \`npm run setup\`:"
      echo "  sudo apt install -y git cmake build-essential ffmpeg python3 espeak-ng curl"
      exit 1
    fi
  elif command -v brew >/dev/null 2>&1; then
    # macOS: Homebrew for the build libs; Xcode Command Line Tools provide git/make/clang(g++)/curl/python3.
    command -v g++ >/dev/null 2>&1 || command -v clang++ >/dev/null 2>&1 || { say "Install Xcode Command Line Tools first:  xcode-select --install  — then re-run \`npm run setup\`."; exit 1; }
    say "Installing build prerequisites via Homebrew ($APT_MISSING )…"
    if ! brew install cmake ffmpeg espeak-ng; then
      say "Couldn't auto-install via Homebrew. Run, then re-run \`npm run setup\`:"
      echo "  brew install cmake ffmpeg espeak-ng"
      exit 1
    fi
  else
    say "Missing:$APT_MISSING — and this isn't an apt or Homebrew system. Install them with your package manager, then re-run \`npm run setup\`."
    exit 1
  fi
fi
# uv (Python package manager) — installs to ~/.local/bin via its own script
if ! command -v uv >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/uv" ]; then
  say "Installing uv…"
  curl -LsSf https://astral.sh/uv/install.sh | sh || { say "uv install failed — see https://docs.astral.sh/uv/ then re-run \`npm run setup\`."; exit 1; }
fi
export PATH="$HOME/.local/bin:$PATH"   # make sure the rest of THIS run can find a freshly-installed uv
if ! command -v uv >/dev/null 2>&1; then
  say "uv isn't on PATH yet — open a new WSL shell (or run: source ~/.bashrc) and re-run \`npm run setup\`."
  exit 1
fi

# 2. Whisper — whisper.cpp server (gate on the binary) + base model (its OWN guard, so a dropped
#    download self-heals on a plain re-run instead of being skipped behind the binary check).
if [ ! -x "$VOICE/whisper/build/bin/whisper-server" ]; then
  say "Installing Whisper (whisper.cpp)…"
  rm -rf "$VOICE/whisper"
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$VOICE/whisper"
  cmake -B "$VOICE/whisper/build" -S "$VOICE/whisper" -DWHISPER_BUILD_SERVER=ON
  cmake --build "$VOICE/whisper/build" --config Release -j
else
  say "Whisper already built."
fi
if [ ! -f "$VOICE/whisper/models/ggml-base.bin" ]; then
  say "Downloading base speech model (~150 MB)…"
  ( cd "$VOICE/whisper" && bash ./models/download-ggml-model.sh base )
else
  say "Whisper model already present."
fi

# 3. Kokoro — FastAPI TTS (CPU torch via uv). Clone gated on .git; `uv sync` runs EVERY time — it's
#    idempotent and completes a half-finished sync, whereas guarding on the dir would strand a partial install.
if [ ! -d "$VOICE/kokoro/.git" ]; then
  say "Installing Kokoro (TTS)…"
  rm -rf "$VOICE/kokoro"
  git clone --depth 1 https://github.com/remsky/Kokoro-FastAPI "$VOICE/kokoro"
fi
# CPU install only — `--extra cpu` pulls torch==2.6.0+cpu from the pytorch-cpu index. A bare `uv sync`
# resolves torch from default PyPI = the ~731MB CUDA wheel + ~2GB of nvidia-* packages (and that CUDA
# torch segfaults here), so the extra is required.
say "Installing/refreshing Kokoro CPU dependencies…"
( cd "$VOICE/kokoro" && uv sync --extra cpu )

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
