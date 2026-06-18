#!/usr/bin/env bash
# Claudible — invite a GitHub user as a PUSH collaborator on a repo workspace's repo (Stage 2 collab).
# Args: $1 = repo slug, $2 = github login. Both strict [A-Za-z0-9-]. Owner resolved at runtime (gh api user).
# `gh api -X PUT collaborators` SENDS an invite (201) or is a no-op if already a collaborator (204); the
# invitee must accept out-of-band before push access is live. Emits one JSON line for the renderer.
set -u

slug="${1:-}"
login="${2:-}"
case "$slug"  in '' | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad slug"}';     exit 0 ;; esac
case "$login" in '' | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad username"}'; exit 0 ;; esac

command -v gh >/dev/null 2>&1 || { printf '{"ok":false,"error":"the GitHub CLI (gh) is not installed in WSL"}'; exit 0; }
owner="$(gh api user --jq .login 2>/dev/null)"
[ -z "$owner" ] && { printf '{"ok":false,"error":"gh is not authenticated"}'; exit 0; }

if gh api -X PUT "repos/$owner/$slug/collaborators/$login" -f permission=push >/dev/null 2>&1; then
  printf '{"ok":true,"status":"invited"}'
else
  printf '{"ok":false,"error":"invite failed — check the username, and that the repo exists under %s"}' "$owner"
fi
