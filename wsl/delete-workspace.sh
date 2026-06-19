#!/usr/bin/env bash
# Claudible — soft-delete a workspace's folder (move to ~/.claudible/trash, recoverable). Args: $1=kind, $2=slug.
# For a repo workspace this only removes the LOCAL clone — the GitHub repo is left intact. Never the legacy dir.
set -u
kind="${1:-}"
slug="${2:-}"
case "$slug" in '' | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad slug"}'; exit 0 ;; esac
case "$kind" in
  local) dir="$HOME/.claudible/workspaces/$slug" ;;
  repo)  dir="$HOME/.claudible/repos/$slug" ;;
  *) printf '{"ok":false,"error":"bad kind"}'; exit 0 ;;
esac
[ -d "$dir" ] || { printf '{"ok":true,"note":"already gone"}'; exit 0; }
trash="$HOME/.claudible/trash"; mkdir -p "$trash" 2>/dev/null
ts="$(date +%Y%m%d-%H%M%S)"
if mv -f "$dir" "$trash/ws-$kind-$slug.$ts" 2>/dev/null; then
  printf '{"ok":true}'
else
  printf '{"ok":false,"error":"move failed"}'
fi
