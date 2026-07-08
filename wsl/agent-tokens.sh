#!/usr/bin/env bash
# Claudible — sum the tokens a session's SUBAGENTS/swarm agents consumed. The main statusLine meter only
# reports the main thread's usage, so big agent runs are invisible there. We count each agent turn's
# output_tokens + cache_creation_input_tokens (the agents' genuinely-NEW work); raw input_tokens re-counts
# the resent context every turn and cache_read_input_tokens is re-reads, so both are excluded.
# $1 = session id. Workspace cwd from CLAUDIBLE_WS_* (mirrors the other scripts). Prints one integer.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"                   # ABSOLUTE script dir, resolved BEFORE any cd into the workspace
. "$HERE/node-path.sh" 2>/dev/null || true              # nvm's node isn't on PATH for non-interactive shells → resolve it
. "$HERE/_ws-dir.sh"                                    # defines WS_KIND / WS_SLUG / SDIR — the one workspace-dir resolution

SID="${1:-}"
case "$SID" in '' | *[!A-Za-z0-9-]*) printf '0'; exit 0 ;; esac
PROJ="$HOME/.claude/projects/${CLAUDIBLE_PROJ:-$(printf '%s' "$SDIR" | sed 's#[^A-Za-z0-9]#-#g')}"
SA="$PROJ/$SID/subagents"
[ -d "$SA" ] || { printf '0'; exit 0; }

unset MSYS_NO_PATHCONV  # win-native: runner sets MSYS_NO_PATHCONV, so git-bash wont convert the /c/.. path(s) below to a Windows path for node.exe; clear it here (no-op on WSL/Posix)
node "$(dirname "$0")/agent-tokens-tool.js" "$SA" 2>/dev/null || printf '0'
