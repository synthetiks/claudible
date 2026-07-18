#!/usr/bin/env bash
# Install Claude Code globally (cross-runner, called by onboard:install-claude). Emits ONE JSON line:
#   {"ok":true} | {"ok":false,"error":"…"}
# Uses npm -g (the documented install for all platforms; matches install.ps1 / setup.sh). Browser sign-in is
# a SEPARATE step (the user runs claude once) — this only puts the binary on PATH.
out="$(npm install -g @anthropic-ai/claude-code 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && command -v claude >/dev/null 2>&1; then
  printf '{"ok":true}\n'
else
  # R17: this was the ONE dependency whose failure dumped raw tool noise ("npm ERR! code EACCES … syscall
  # mkdir …") instead of a next step — every other dep already speaks human. Classify the two failures a
  # user can actually act on; anything else keeps npm's (stripped) last words, labeled as npm's.
  if ! command -v npm >/dev/null 2>&1; then
    err="npm isn't available — install Node.js first (the row above), then retry"
  else
    case "$out" in
      *EACCES*|*EPERM*|*"permission denied"*)
        err="npm can't write its global folder — in a terminal run:  sudo npm install -g @anthropic-ai/claude-code   then press Install again" ;;
      *ENOTFOUND*|*ETIMEDOUT*|*EAI_AGAIN*|*ECONNRESET*|*"network"*)
        err="network problem reaching npm — check your connection and retry" ;;
      *)
        err="npm said: $(printf '%s' "$out" | tail -3 | tr '\n' ' ' | tr -d '\r\000-\037"\\')" ;;   # strip CR + C0 (npm ANSI) + quote/backslash → safe inside JSON
    esac
  fi
  printf '{"ok":false,"error":"%s"}\n' "$err"
fi
