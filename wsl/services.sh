#!/usr/bin/env bash
# Claudible — ensure local voice services are up (idempotent).
# Binds 0.0.0.0 so the Windows app can reach the services across the WSL2 virtual NIC. On WSL2's
# default NAT networking this is NOT exposed to your LAN (only the Windows host can reach it). If you
# enable WSL2 *mirrored* networking it becomes reachable from the host's interfaces — these services
# are local and unauthenticated, so don't run mirrored networking on an untrusted network.
set -u
LOG="$HOME/.claudible/logs"; mkdir -p "$LOG"
# Cross-platform port-listen check: ss (Linux/WSL) -> lsof (macOS) -> netstat (fallback).
listening() {
  if command -v ss >/dev/null 2>&1; then ss -tln 2>/dev/null | grep -q ":$1 ";
  elif command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1;
  else netstat -an 2>/dev/null | grep -qE "[:.]$1 .*LISTEN"; fi
}
{ command -v ss >/dev/null 2>&1 || command -v lsof >/dev/null 2>&1 || command -v netstat >/dev/null 2>&1; } || echo "[claudible] note: no ss/lsof/netstat — can't detect already-running voice services; may try to (re)start them."

# Ports are overridable; if you change them, also point the app's CLAUDIBLE_KOKORO / CLAUDIBLE_WHISPER
# URLs at the new ports (see README → Configuration) so the client and server agree.
KOKORO_PORT="${CLAUDIBLE_KOKORO_PORT:-8880}"
WHISPER_PORT="${CLAUDIBLE_WHISPER_PORT:-2022}"

# Where the local voice stack lives. `npm run setup` installs it under ~/.claudible/voice; if you
# already have a full Voicemode install (both services), we reuse that instead. Override with CLAUDIBLE_VOICE=/path.
VOICE="${CLAUDIBLE_VOICE:-$HOME/.claudible/voice}"
if [ ! -d "$VOICE/kokoro" ] && [ -d "$HOME/.voicemode/services/kokoro" ] && [ -d "$HOME/.voicemode/services/whisper" ]; then
  VOICE="$HOME/.voicemode/services"
fi

# wait up to N seconds (default 10) for a port to come up; return non-zero if it never binds.
# Kokoro needs a long window: its first start loads a ~327 MB model + torch, which on CPU can take
# tens of seconds — a short timeout would print a false "FAILED" while the server is still warming up.
wait_listen() { local port="$1" secs="${2:-10}" i; for ((i=0; i<secs*2; i++)); do listening "$port" && return 0; sleep 0.5; done; return 1; }

# Kokoro TTS  (uvicorn + CPU torch — NOT start-cpu.sh, which reinstalls CUDA torch and segfaults).
# The env vars are REQUIRED: Kokoro's config.py defaults model_dir/voices_dir to the container's
# absolute /app/... paths, which don't exist on a normal install — so the server would search /app
# and exit at warmup. MODEL_DIR/VOICES_DIR (relative, resolved against the api/ dir) point it at the
# real weights setup.sh downloads. USE_GPU/USE_ONNX=false force CPU; ESPEAK_DATA_PATH is set only if
# present (Kokoro otherwise uses its bundled espeak loader).
if ! listening "$KOKORO_PORT"; then
  if [ -d "$VOICE/kokoro" ] && ! command -v uv >/dev/null 2>&1; then
    echo "[claudible] kokoro NOT started: 'uv' is missing from PATH — run: npm run setup (it installs uv)."
  elif [ -d "$VOICE/kokoro" ]; then
    ESPEAK_ENV=""
    for p in /usr/lib/x86_64-linux-gnu/espeak-ng-data /usr/share/espeak-ng-data /opt/homebrew/share/espeak-ng-data /usr/local/share/espeak-ng-data; do
      [ -d "$p" ] && { ESPEAK_ENV="ESPEAK_DATA_PATH=$p"; break; }
    done
    ( cd "$VOICE/kokoro" && \
      env MODEL_DIR=src/models VOICES_DIR=src/voices/v1_0 USE_GPU=false USE_ONNX=false \
        PYTHONPATH="$VOICE/kokoro:$VOICE/kokoro/api" $ESPEAK_ENV \
        nohup uv run --no-sync uvicorn api.src.main:app --host 0.0.0.0 --port "$KOKORO_PORT" \
        >"$LOG/kokoro.out" 2>&1 & )
    if wait_listen "$KOKORO_PORT" 90; then echo "[claudible] kokoro up :$KOKORO_PORT"; else echo "[claudible] kokoro not up yet (still loading the model?) — check $LOG/kokoro.out"; fi
  else echo "[claudible] kokoro not installed at $VOICE/kokoro — run: npm run setup"; fi
else echo "[claudible] kokoro already up :$KOKORO_PORT"; fi

# Whisper STT  (OpenAI route + ffmpeg convert)
if ! listening "$WHISPER_PORT"; then
  if [ -d "$VOICE/whisper" ] && [ ! -x "$VOICE/whisper/build/bin/whisper-server" ]; then
    echo "[claudible] whisper NOT started: build/bin/whisper-server is missing or not built — run: npm run setup."
  elif [ -d "$VOICE/whisper" ]; then
    ( cd "$VOICE/whisper" && \
      nohup ./build/bin/whisper-server --host 0.0.0.0 --port "$WHISPER_PORT" -m models/ggml-base.bin \
        --inference-path /v1/audio/transcriptions --convert \
        >"$LOG/whisper.out" 2>&1 & )
    if wait_listen "$WHISPER_PORT" 20; then echo "[claudible] whisper up :$WHISPER_PORT"; else echo "[claudible] whisper FAILED to bind — see $LOG/whisper.out"; fi
  else echo "[claudible] whisper not installed at $VOICE/whisper — run: npm run setup"; fi
else echo "[claudible] whisper already up :$WHISPER_PORT"; fi
