#!/usr/bin/env bash
# Install Claude Code globally (cross-runner, called by onboard:install-claude). Emits ONE JSON line:
#   {"ok":true} | {"ok":false,"error":"…"}
# Uses npm -g (the documented install for all platforms; matches install.ps1 / setup.sh). Browser sign-in is
# a SEPARATE step (the user runs claude once) — this only puts the binary on PATH.
out="$(npm install -g @anthropic-ai/claude-code 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && command -v claude >/dev/null 2>&1; then
  printf '{"ok":true}\n'
else
  err="$(printf '%s' "$out" | tail -3 | tr '\n' ' ' | tr -d '\r\000-\037"\\')"   # strip CR + ALL C0 control chars (npm ANSI escapes) + quote/backslash → safe inside JSON
  printf '{"ok":false,"error":"%s"}\n' "$err"
fi
