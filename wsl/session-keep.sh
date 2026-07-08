#!/usr/bin/env bash
# Claudible — "Keep locally" a session a collaborator deleted on GitHub: record the id in .claudible-kept so the
# red "deleted on GitHub" badge clears. The transcript stays on disk; it is tombstoned on the branch so it is
# never re-shared. Arg $1 = session id. Emits {"ok":true} / {"ok":false,"error":...}.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"                   # ABSOLUTE script dir, resolved BEFORE any cd into the workspace
id="${1:-}"
case "$id" in
  '' | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad id"}'; exit 0 ;;   # strict allowlist
esac
# Same project-dir derivation as sessions.sh / delete-session.sh, scoped to the SELECTED workspace's cwd.
. "$HERE/_ws-dir.sh"                                    # defines WS_KIND / WS_SLUG / SDIR — the one workspace-dir resolution
PROJ="$HOME/.claude/projects/${CLAUDIBLE_PROJ:-$(printf '%s' "$SDIR" | sed 's#[^A-Za-z0-9]#-#g')}"
mkdir -p "$PROJ" 2>/dev/null
kept="$PROJ/.claudible-kept"
grep -qxF -- "$id" "$kept" 2>/dev/null || printf '%s\n' "$id" >> "$kept"
printf '{"ok":true}'
