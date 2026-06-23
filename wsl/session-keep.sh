#!/usr/bin/env bash
# Claudible — "Keep locally" a session a collaborator deleted on GitHub: record the id in .claudible-kept so the
# red "deleted on GitHub" badge clears. The transcript stays on disk; it is tombstoned on the branch so it is
# never re-shared. Arg $1 = session id. Emits {"ok":true} / {"ok":false,"error":...}.
set -u
id="${1:-}"
case "$id" in
  '' | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad id"}'; exit 0 ;;   # strict allowlist
esac
# Same project-dir derivation as sessions.sh / delete-session.sh, scoped to the SELECTED workspace's cwd.
WS_KIND="${CLAUDIBLE_WS_KIND:-legacy}"
WS_SLUG="${CLAUDIBLE_WS_SLUG:-}"
case "$WS_SLUG" in *[!A-Za-z0-9-]*) WS_SLUG="" ;; esac
if [ "$WS_KIND" = "local" ] && [ -n "$WS_SLUG" ]; then
  SDIR="$HOME/.claudible/workspaces/$WS_SLUG"
elif [ "$WS_KIND" = "repo" ] && [ -n "$WS_SLUG" ]; then
  SDIR="$HOME/.claudible/repos/$WS_SLUG"
else
  SDIR="$HOME/.claudible/session"
fi
[ -n "${CLAUDIBLE_WS_DIR:-}" ] && SDIR="$CLAUDIBLE_WS_DIR"   # custom save-location override
PROJ="$HOME/.claude/projects/${CLAUDIBLE_PROJ:-$(printf '%s' "$SDIR" | sed 's#[^A-Za-z0-9]#-#g')}"
mkdir -p "$PROJ" 2>/dev/null
kept="$PROJ/.claudible-kept"
grep -qxF -- "$id" "$kept" 2>/dev/null || printf '%s\n' "$id" >> "$kept"
printf '{"ok":true}'
