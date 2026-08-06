#!/usr/bin/env bash
# Claudible — permanently delete a repo workspace's GitHub repo (C-3.6's "Delete from GitHub"). OWNER-only,
# and needs the gh CLI's delete_repo scope, which most tokens don't carry by default.
# Args: $1 = owner, $2 = repo name. Both strict [A-Za-z0-9-] (Claudible slug charset — same restriction
# rename-repo.sh/repo-invite.sh already apply; C-3.4's dot/underscore gap is a separate, known, open issue).
#
# Deliberately does NOT touch the local clone — main.js runs this FIRST and only falls through to the existing
# delete-workspace.sh trash-move (workspaceDeleteCore) once this reports {"ok":true}, so a failed GitHub delete
# never half-deletes a project.
set -u

owner="${1:-}"
name="${2:-}"
case "$owner" in '' | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad owner"}'; exit 0 ;; esac
case "$name"  in '' | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad name"}';  exit 0 ;; esac

command -v gh >/dev/null 2>&1 || { printf '{"ok":false,"error":"the GitHub CLI (gh) is not installed"}'; exit 0; }
case "$(uname -r 2>/dev/null)" in *[Mm]icrosoft*) case "$(command -v gh 2>/dev/null)" in *.exe|/mnt/*) { printf '{"ok":false,"error":"gh resolves to a Windows gh.exe via interop — install the Linux gh inside WSL"}'; exit 0; } ;; esac ;; esac   # a Windows gh.exe leaking through WSL interop reads the WINDOWS credential store and mangles Linux paths
me="$(gh api user --jq .login 2>/dev/null)"
[ -z "$me" ] && { printf '{"ok":false,"error":"gh is not authenticated"}'; exit 0; }
if [ "$me" != "$owner" ]; then
  printf '{"ok":false,"error":"only the repo owner (%s) can delete it on GitHub"}' "$owner"
  exit 0
fi

out="$(gh repo delete "$owner/$name" --yes 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then
  printf '{"ok":true}'
else
  # The common case: the signed-in token has no delete_repo scope (gh scopes it separately from every other
  # repo permission on purpose, precisely because it's irreversible). Say the exact fix, same convention as
  # install-claude.sh's EACCES/network classification — raw gh/npm noise is never the message a user sees.
  case "$out" in
    *delete_repo*|*"HTTP 403"*|*Forbidden*|*"not authorized"*|*"insufficient"*)
      err="missing the delete_repo permission on your GitHub token — run:  gh auth refresh -h github.com -s delete_repo   then try again" ;;
    *"HTTP 404"*|*"Could not resolve"*)
      err="GitHub doesn't have a repo at $owner/$name (already deleted, or the name/owner changed)" ;;
    *)
      err="gh repo delete failed: $(printf '%s' "$out" | tail -3 | tr '\n' ' ' | tr -d '\r\000-\037"\\')" ;;
  esac
  printf '{"ok":false,"error":"%s"}' "$err"
fi
