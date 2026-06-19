#!/usr/bin/env bash
# Claudible — clone an EXISTING repo workspace you've been invited to, into ~/.claudible/repos/<slug>.
# Used by discovery (and lazily on first open) so a collaborator's workspace becomes usable locally.
# Args: $1 = owner (github login), $2 = slug. Both strict [A-Za-z0-9-]. Emits one JSON line.
set -u
owner="${1:-}"
slug="${2:-}"
case "$owner" in '' | -* | *- | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad owner"}'; exit 0 ;; esac
case "$slug"  in '' | -* | *- | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad slug"}'; exit 0 ;; esac

dir="$HOME/.claudible/repos/$slug"
if [ -d "$dir/.git" ]; then printf '{"ok":true,"already":true,"slug":"%s"}' "$slug"; exit 0; fi   # already cloned
command -v gh >/dev/null 2>&1 || { printf '{"ok":false,"error":"the GitHub CLI (gh) is not installed in WSL"}'; exit 0; }
mkdir -p "$HOME/.claudible/repos" 2>/dev/null
if gh repo clone "$owner/$slug" "$dir" >/dev/null 2>&1; then
  printf '{"ok":true,"slug":"%s","owner":"%s","repoUrl":"https://github.com/%s/%s"}' "$slug" "$owner" "$owner" "$slug"
else
  rm -rf "$dir" 2>/dev/null
  printf '{"ok":false,"error":"clone failed (check access to %s/%s)"}' "$owner" "$slug"
fi
