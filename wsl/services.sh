#!/usr/bin/env bash
# Claudible — ensure local voice services are up (idempotent). Binds 0.0.0.0 so the Windows app
# reaches them reliably (WSL2 NAT keeps this host-only, not exposed on the LAN).
set -u
LOG="$HOME/.claudible/logs"; mkdir -p "$LOG"
listening() { ss -tln 2>/dev/null | grep -q ":$1 "; }

# Where the local voice stack lives. `npm run setup` installs it under ~/.claudible/voice; if you
# already have a Voicemode install, we reuse that instead. Override with CLAUDIBLE_VOICE=/path.
VOICE="${CLAUDIBLE_VOICE:-$HOME/.claudible/voice}"
if [ ! -d "$VOICE/kokoro" ] && [ -d "$HOME/.voicemode/services/kokoro" ]; then
  VOICE="$HOME/.voicemode/services"
fi

# wait up to ~5s for a port to come up; return non-zero if it never binds
wait_listen() { for _ in $(seq 1 10); do listening "$1" && return 0; sleep 0.5; done; return 1; }

# Kokoro TTS :8880  (uvicorn + CPU torch — NOT start-cpu.sh, which reinstalls CUDA torch and segfaults)
if ! listening 8880; then
  if [ -d "$VOICE/kokoro" ]; then
    ( cd "$VOICE/kokoro" && \
      nohup uv run --no-sync uvicorn api.src.main:app --host 0.0.0.0 --port 8880 \
        >"$LOG/kokoro.out" 2>&1 & )
    if wait_listen 8880; then echo "[claudible] kokoro up :8880"; else echo "[claudible] kokoro FAILED to bind — see $LOG/kokoro.out"; fi
  else echo "[claudible] kokoro not installed at $VOICE/kokoro — run: npm run setup"; fi
else echo "[claudible] kokoro already up"; fi

# Whisper STT :2022  (OpenAI route + ffmpeg convert)
if ! listening 2022; then
  if [ -d "$VOICE/whisper" ]; then
    ( cd "$VOICE/whisper" && \
      nohup ./build/bin/whisper-server --host 0.0.0.0 --port 2022 -m models/ggml-base.bin \
        --inference-path /v1/audio/transcriptions --convert \
        >"$LOG/whisper.out" 2>&1 & )
    if wait_listen 2022; then echo "[claudible] whisper up :2022"; else echo "[claudible] whisper FAILED to bind — see $LOG/whisper.out"; fi
  else echo "[claudible] whisper not installed at $VOICE/whisper — run: npm run setup"; fi
else echo "[claudible] whisper already up"; fi
