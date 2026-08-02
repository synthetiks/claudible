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
  # Curated failure branches (not just `set -e`'s bare exit): provision.sh's `voice` case captures this whole
  # script's log and tails its LAST few lines as the wizard's error message — without these, that tail is git's or
  # cmake's raw output instead of an actionable one. The clone is the FIRST network op `npm run setup` performs.
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$VOICE/whisper" || { say "Couldn't download Whisper (whisper.cpp) — check your network, then re-run \`npm run setup\`."; exit 1; }
  cmake -B "$VOICE/whisper/build" -S "$VOICE/whisper" -DWHISPER_BUILD_SERVER=ON || { say "Whisper configure failed (is cmake installed?) — check the log above, then re-run \`npm run setup\`."; exit 1; }
  cmake --build "$VOICE/whisper/build" --config Release -j || { say "Whisper build failed — check the log above, then re-run \`npm run setup\`."; exit 1; }
else
  say "Whisper already built."
fi
# Size guard (real file is ~140 MB) — an interrupted download leaves a small/truncated file that a bare
# existence check would treat as "present" forever. Wipe it before retrying so a plain re-run self-heals.
whisper_model="$VOICE/whisper/models/ggml-base.bin"
whisper_model_ok() { [ -f "$whisper_model" ] && [ "$(wc -c <"$whisper_model" 2>/dev/null || echo 0)" -gt 104857600 ]; }
if ! whisper_model_ok; then
  rm -f "$whisper_model"
  say "Downloading base speech model (~150 MB)…"
  ( cd "$VOICE/whisper" && bash ./models/download-ggml-model.sh base )
  whisper_model_ok || { say "Whisper model download failed or produced a truncated file — check your network, then re-run \`npm run setup\`."; exit 1; }
else
  say "Whisper model already present."
fi

# 3. Kokoro — FastAPI TTS (CPU torch via uv). Clone gated on .git; `uv sync` runs EVERY time — it's
#    idempotent and completes a half-finished sync, whereas guarding on the dir would strand a partial install.
if [ ! -d "$VOICE/kokoro/.git" ]; then
  say "Installing Kokoro (TTS)…"
  rm -rf "$VOICE/kokoro"
  # on failure, wipe the partial clone — a half-clone still has a .git dir, which would fool the guard above
  # into calling it "already installed" on the next run (mirrors setup-win.ps1's Kokoro clone check).
  git clone --depth 1 https://github.com/remsky/Kokoro-FastAPI "$VOICE/kokoro" || { rm -rf "$VOICE/kokoro"; say "Kokoro clone failed (network?). Re-run \`npm run setup\`."; exit 1; }
fi
# X-linux — MIRROR THE WINDOWS misaki PATCH HERE TOO. Kokoro asks for misaki[en,ja,ko,zh]; the ja extra drags
# in pyopenjtalk, which builds from C++ source. On Windows that is fatal (no MSVC on a normal box) and is why
# setup-win.ps1 rewrites it. On Linux/macOS the toolchain usually IS present, so this is not a hard break —
# it compiles, slowly, and costs build time and disk for voices this app can never ask for. Claudible serves
# English only: grep the UI and the TTS request builder and there is no path to a jf_/jm_/zf_/zm_/kf_ voice
# id, so dropping the CJK extras is behaviour-preserving by construction, not by hope.
# NOT claimed risk-free: removing an extra changes what the resolver sees and could in principle shift a shared
# transitive pin (numpy, say) — a different failure class from "the regex didn't match". Hence one confirming
# run on real hardware: `uv sync --extra cpu` completes, pyopenjtalk is absent from the resolved set, and
# af_bella still synthesizes.
# Patched in the CLONE, never upstream, and idempotent: the pattern only matches an un-patched line, so a
# re-run after a `git pull` re-applies it. sed -i differs between GNU and BSD/macOS (macOS demands an argument
# to -i), so write via a temp file — portable, and it also lets us report whether anything actually changed.
pyproj="$VOICE/kokoro/pyproject.toml"
if [ -f "$pyproj" ]; then
  if grep -qE 'misaki\[[a-z,]*\]' "$pyproj" && ! grep -q 'misaki\[en\]' "$pyproj"; then
    sed -E 's/misaki\[[a-z,]*\]/misaki[en]/g' "$pyproj" > "$pyproj.tmp" && mv "$pyproj.tmp" "$pyproj"
    say "Patched Kokoro deps: English voices only (the CJK extras compile pyopenjtalk from source)."
  fi
fi
# CPU install only — `--extra cpu` pulls torch==2.6.0+cpu from the pytorch-cpu index. A bare `uv sync`
# resolves torch from default PyPI = the ~731MB CUDA wheel + ~2GB of nvidia-* packages (and that CUDA
# torch segfaults here), so the extra is required.
say "Installing/refreshing Kokoro CPU dependencies…"
( cd "$VOICE/kokoro" && uv sync --extra cpu ) || { say "Kokoro dependency install failed — see the output above, then re-run \`npm run setup\`."; exit 1; }

# 3b. Kokoro model weights (~327 MB) — the repo gitignores *.pth, so a clone has NO model.
# Without this the server exits at warmup (FileNotFoundError) and :8880 never binds. Idempotent:
# download_model.py skips itself if the file already exists. Kept outside the dir guard above so a
# checkout that somehow lacks the model still gets repaired on a re-run.
# Size + config.json guard (real file is ~327 MB) — mirrors setup-win.ps1's Test-Kokoro. An interrupted
# download leaves a small/truncated .pth that a bare existence check would treat as "present" forever; wipe
# it before retrying so a plain re-run self-heals.
kokoro_model="$VOICE/kokoro/api/src/models/v1_0/kokoro-v1_0.pth"
kokoro_conf="$VOICE/kokoro/api/src/models/v1_0/config.json"
kokoro_model_ok() { [ -f "$kokoro_model" ] && [ "$(wc -c <"$kokoro_model" 2>/dev/null || echo 0)" -gt 104857600 ] && [ -f "$kokoro_conf" ]; }
if ! kokoro_model_ok; then
  rm -f "$kokoro_model" "$kokoro_conf"
  say "Downloading Kokoro model weights (~327 MB)…"
  ( cd "$VOICE/kokoro" && uv run --no-sync python docker/scripts/download_model.py --output api/src/models/v1_0 )
  kokoro_model_ok || { say "Kokoro model download failed or produced a truncated file — check your network, then re-run \`npm run setup\`."; exit 1; }
else
  say "Kokoro model already present."
fi

say "Done. Start Claudible with:  npm start"
