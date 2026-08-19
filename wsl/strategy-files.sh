#!/usr/bin/env bash
# Claudible — install/remove the plan-big-execute-small team files.
# $1 = 'on' | 'off'. All logic (templates, the only-touch-owned-paths guard) lives in strategy-files-tool.js;
# this wrapper only resolves node and runs it GUEST-SIDE so ~/.claude is the same home claude itself uses
# (WSL: the distro home · win: git-bash HOME = the Windows profile · posix: $HOME). Prints the tool's JSON.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/node-path.sh" 2>/dev/null || true              # nvm's node isn't on PATH for non-interactive shells → resolve it

MODE="${1:-}"
CFG="${2:-}"   # optional JSON seat overrides (custom strategy); the tool allowlists every value
case "$MODE" in on|off) ;; *) printf '{"ok":false,"error":"mode must be on|off"}'; exit 0 ;; esac

unset MSYS_NO_PATHCONV  # win-native: keep git-bash from rewriting paths for node.exe (no-op on WSL/Posix)
node "$HERE/strategy-files-tool.js" "$MODE" "$CFG" 2>/dev/null || printf '{"ok":false,"error":"node failed"}'
