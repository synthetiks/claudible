#!/usr/bin/env bash
# Claudible — SOFT-delete a Claude conversation: move <id>.jsonl into ~/.claudible/trash/ so it's
# recoverable, not erased. Arg $1 = session id. Refuses anything outside the id charset.
# Emits {"ok":true} / {"ok":false,"error":...} for the renderer.
set -u
id="${1:-}"
case "$id" in
  '' | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad id"}'; exit 0 ;;   # strict allowlist
esac
# Same project-dir derivation as sessions.sh, scoped to the SELECTED workspace's cwd.
# Unset / bad slug → the original single session dir. Slug is a strict [A-Za-z0-9-] leaf.
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
PROJ="$HOME/.claude/projects/$(printf '%s' "$SDIR" | sed 's#[^A-Za-z0-9]#-#g')"
src="$PROJ/$id.jsonl"
[ -f "$src" ] || { printf '{"ok":false,"error":"not found"}'; exit 0; }
trash="$HOME/.claudible/trash"
mkdir -p "$trash" 2>/dev/null
ts="$(date +%Y%m%d-%H%M%S)"
if mv -f "$src" "$trash/$id.$ts.jsonl" 2>/dev/null; then
  printf '{"ok":true}'
else
  printf '{"ok":false,"error":"move failed"}'
fi
