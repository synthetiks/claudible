#!/usr/bin/env bash
# Claudible — install/remove the plan-big-execute-small team files.
# $1 = 'on' | 'off' | 'graph'. All logic (templates, the only-touch-owned-paths guard) lives in strategy-files-tool.js;
# this wrapper only resolves node and runs it GUEST-SIDE so ~/.claude is the same home claude itself uses
# (WSL: the distro home · win: git-bash HOME = the Windows profile · posix: $HOME). Prints the tool's JSON.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/node-path.sh" 2>/dev/null || true              # nvm's node isn't on PATH for non-interactive shells → resolve it

MODE="${1:-}"
CFG="${2:-}"   # optional JSON seat overrides (custom strategy); the tool allowlists every value
# THE ALLOWLIST MUST MATCH main.js's installStrategyFiles (`:3245`), which sends 'on', 'off' or 'graph'.
# 'graph' was missing here from the day custom graphs shipped: the app sent it, this line rejected it, and the
# whole feature failed at its first step for everyone with a well-formed error nobody surfaced. Nothing caught it
# because no test reads this file — if you add a mode to main.js, add it here and pin the pair together.
case "$MODE" in on|off|graph) ;; *) printf '{"ok":false,"error":"mode must be on|off|graph"}'; exit 0 ;; esac

unset MSYS_NO_PATHCONV  # win-native: keep git-bash from rewriting paths for node.exe (no-op on WSL/Posix)
node "$HERE/strategy-files-tool.js" "$MODE" "$CFG" 2>/dev/null || printf '{"ok":false,"error":"node failed"}'
