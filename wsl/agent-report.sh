#!/usr/bin/env bash
# Claudible — per-agent OBSERVED model/effort/usage for a session's subagents.
# Same resolution as agent-tokens.sh (one workspace-dir rule, one projects-dir key); the heavy lifting is
# agent-report-tool.js. $1 = session id. Prints a JSON array ('[]' on any miss — callers never see an error).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"                   # ABSOLUTE script dir, resolved BEFORE any cd into the workspace
. "$HERE/node-path.sh" 2>/dev/null || true              # nvm's node isn't on PATH for non-interactive shells → resolve it
. "$HERE/_ws-dir.sh"                                    # defines WS_KIND / WS_SLUG / SDIR — the one workspace-dir resolution

SID="${1:-}"
case "$SID" in '' | *[!A-Za-z0-9-]*) printf '[]'; exit 0 ;; esac
PROJ="$HOME/.claude/projects/${CLAUDIBLE_PROJ:-$(printf '%s' "$SDIR" | sed 's#[^A-Za-z0-9]#-#g')}"
SA="$PROJ/$SID/subagents"
[ -d "$SA" ] || { printf '[]'; exit 0; }

unset MSYS_NO_PATHCONV  # win-native: keep git-bash from rewriting the /c/.. path for node.exe (no-op on WSL/Posix)
node "$HERE/agent-report-tool.js" "$SA" 2>/dev/null || printf '[]'
