#!/usr/bin/env bash
# Claudible — SOFT-delete a Claude conversation: move <id>.jsonl into ~/.claudible/trash/ so it's
# recoverable, not erased. Arg $1 = session id. Refuses anything outside the id charset.
# Emits {"ok":true} / {"ok":false,"error":...} for the renderer.
set -u
id="${1:-}"
case "$id" in
  '' | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad id"}'; exit 0 ;;   # strict allowlist
esac
# Same project-dir derivation as sessions.sh (the embedded session always runs in ~/.claudible/session).
SDIR="$HOME/.claudible/session"
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
