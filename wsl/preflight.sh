#!/usr/bin/env bash
# Cross-runner dependency probe for the self-bootstrapping provisioner (runners/deps.js). Run via the active
# runner's runScript — git-bash on Windows-native, wsl.exe on WSL, bash on Posix — so $HOME resolves to the
# execution space's home and the credential check reads the right store. SUPERSEDES check-onboard.sh: same
# Claude/gh sign-in signals, plus node/git/uv/cloudflared + versions, in the shape detectDeps() returns.
# Emits ONE JSON line. node is always present (it runs Claude Code's hooks) and is used to parse the
# credentials JSON PRECISELY (claudeAiOauth.accessToken — not a loose grep that a stray token could trip).
#
# NOTE: the WIN runner does NOT use this script — it detects in pure Node (runners/win.js detectDeps), because
# this script needs bash and Git-for-Windows may be the very thing missing (the chicken-and-egg). This probe
# serves WSL/Posix, where bash + the toolchain live in the guest.

HERE="$(cd "$(dirname "$0")" && pwd)"
# node runs Claude Code's hooks AND parses the credentials JSON below. Under `bash -lc` (how every runner
# invokes this) nvm's node is NOT on PATH — so without this, a machine with node installed reported
# `node: missing` AND `claude: not signed in`, and the wizard offered to install a node that was already there.
. "$HERE/node-path.sh" 2>/dev/null || true              # nvm's node isn't on PATH for non-interactive shells → resolve it

has() { command -v "$1" >/dev/null 2>&1 && printf true || printf false; }
# First dotted-number token of `<tool> --version` (handles "git version 2.45.0", "v22.14.0", "uv 0.5.0", …).
ver() { command -v "$1" >/dev/null 2>&1 || return 0; "$1" --version 2>/dev/null | head -1 | grep -oE '[0-9]+(\.[0-9]+)+' | head -1; }

node_v="$(ver node)"; git_v="$(ver git)"; claude_v="$(ver claude)"; uv_v="$(ver uv)"; cf_v="$(ver cloudflared)"; gh_v="$(ver gh)"

# Node >= 22.12.0 ? (sort -V; coreutils ships with git-bash too)
node_ok=false
if [ -n "$node_v" ] && [ "$(printf '22.12.0\n%s\n' "$node_v" | sort -V | head -1)" = "22.12.0" ]; then node_ok=true; fi

# Claude signed in: ~/.claude/.credentials.json has a non-empty claudeAiOauth.accessToken (node-parsed).
claude_signed=false
cred="$HOME/.claude/.credentials.json"
if [ -f "$cred" ]; then
  claude_signed="$(cat "$cred" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const c=JSON.parse(s);process.stdout.write(c&&c.claudeAiOauth&&c.claudeAiOauth.accessToken?"true":"false")}catch{process.stdout.write("false")}})' 2>/dev/null)"
  [ "$claude_signed" = "true" ] || claude_signed=false
fi

# GitHub signed in: `gh auth status` exit 0; account via the API. Strip control chars / quotes / backslashes.
gh_signed=false; gh_account=""
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  gh_signed=true
  gh_account="$(gh api user --jq .login 2>/dev/null | head -1 | tr -d '\000-\037"\\')"
fi

# Voice models (Whisper + Kokoro) — same file layout setup.sh builds/downloads, checked HERE (inside the
# guest, where $HOME is the real one) instead of main.js's Windows-side check, which only ever looks at the
# native-Windows build layout (.exe, Release/) and so is always false for a WSL/posix voice install.
VOICE="${CLAUDIBLE_VOICE:-$HOME/.claudible/voice}"
voice_ready=false
# A model file must clear 100MB (real sizes: whisper ~140MB, kokoro ~327MB) — a plain existence check would
# report "ready" for a truncated/interrupted download too, with no wizard recovery path (setup.sh's own size
# guard is what self-heals it, but only on the NEXT `npm run setup` — this probe must not paper over that gap).
big() { [ -f "$1" ] && [ "$(wc -c <"$1" 2>/dev/null || echo 0)" -gt 104857600 ]; }
if [ -x "$VOICE/whisper/build/bin/whisper-server" ] && big "$VOICE/whisper/models/ggml-base.bin" && big "$VOICE/kokoro/api/src/models/v1_0/kokoro-v1_0.pth" ; then
  voice_ready=true
fi
# setup.sh treats an existing ~/.voicemode install as already done and never builds its own — match that.
if [ -d "$HOME/.voicemode/services/kokoro" ] && [ -d "$HOME/.voicemode/services/whisper" ]; then voice_ready=true; fi

printf '{"node":{"installed":%s,"version":"%s","ok":%s},"git":{"installed":%s,"version":"%s"},"claude":{"installed":%s,"version":"%s","signedIn":%s},"uv":{"installed":%s,"version":"%s"},"voice":{"ready":%s},"cloudflared":{"installed":%s,"version":"%s"},"gh":{"installed":%s,"version":"%s","signedIn":%s,"account":"%s"}}\n' \
  "$(has node)" "$node_v" "$node_ok" \
  "$(has git)" "$git_v" \
  "$(has claude)" "$claude_v" "$claude_signed" \
  "$(has uv)" "$uv_v" \
  "$voice_ready" \
  "$(has cloudflared)" "$cf_v" \
  "$(has gh)" "$gh_v" "$gh_signed" "$gh_account"
