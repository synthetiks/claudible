#!/usr/bin/env bash
# Claudible — read ONE Claude conversation's transcript as JSON messages, for the read-only guest browser.
# This NEVER resumes/executes anything — it only renders saved text — so a foreign transcript is safe here
# (unlike --resume, which would let its contents drive tools). Arg $1 = session id (strict [A-Za-z0-9-]).
# Resolves the SAME per-workspace project dir as sessions.sh. Emits [{role:'you'|'claude',text}] oldest-first,
# capping message count + per-message length so a huge transcript can't blow up the payload.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"                   # ABSOLUTE script dir, resolved BEFORE any cd into the workspace
. "$HERE/node-path.sh" 2>/dev/null || true              # nvm's node isn't on PATH for non-interactive shells → resolve it
id="${1:-}"
case "$id" in '' | *[!A-Za-z0-9-]*) printf '[]'; exit 0 ;; esac
. "$HERE/_ws-dir.sh"                                    # defines WS_KIND / WS_SLUG / SDIR — the one workspace-dir resolution
# Same encoding Claude uses: every non-alphanumeric char in the cwd path → '-'.
PROJ="$HOME/.claude/projects/${CLAUDIBLE_PROJ:-$(printf '%s' "$SDIR" | sed 's#[^A-Za-z0-9]#-#g')}"
f="$PROJ/$id.jsonl"
[ -f "$f" ] || { printf '[]'; exit 0; }

unset MSYS_NO_PATHCONV  # win-native: runner sets MSYS_NO_PATHCONV, so git-bash wont convert the /c/.. path(s) below to a Windows path for node.exe; clear it here (no-op on WSL/Posix)
node "$(dirname "$0")/transcript-tool.js" "$f" 2>/dev/null || printf '[]'
