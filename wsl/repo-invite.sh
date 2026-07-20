#!/usr/bin/env bash
# Claudible — invite a GitHub user as a PUSH collaborator on a repo workspace's repo (Stage 2 collab).
# Args: $1 = repo name, $2 = github login, $3 = the repo's OWNER. All strict [A-Za-z0-9-].
# R12: the owner used to be resolved as `gh api user` — the person CLICKING, not the repo's owner. A
# collaborator inviting a third person therefore PUT against their OWN namespace: a same-named repo of
# theirs got the invite, or it 404'd while the UI said "invited". The caller now passes ws.owner; if the
# signed-in user isn't that owner, refuse with the truth (GitHub only lets the owner/admin invite anyway).
# `gh api -X PUT collaborators` SENDS an invite (201) or is a no-op if already a collaborator (204); the
# invitee must accept out-of-band before push access is live. Emits one JSON line for the renderer.
set -u

slug="${1:-}"
login="${2:-}"
owner="${3:-}"
case "$slug"  in '' | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad slug"}';     exit 0 ;; esac
case "$login" in '' | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad username"}'; exit 0 ;; esac
case "$owner" in '' | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad owner"}';    exit 0 ;; esac

command -v gh >/dev/null 2>&1 || { printf '{"ok":false,"error":"the GitHub CLI (gh) is not installed in WSL"}'; exit 0; }
case "$(uname -r 2>/dev/null)" in *[Mm]icrosoft*) case "$(command -v gh 2>/dev/null)" in *.exe|/mnt/*) { printf '{"ok":false,"error":"gh resolves to a Windows gh.exe via interop — install the Linux gh inside WSL"}'; exit 0; } ;; esac ;; esac   # a Windows gh.exe leaking through WSL interop reads the WINDOWS credential store and mangles Linux paths
me="$(gh api user --jq .login 2>/dev/null)"
[ -z "$me" ] && { printf '{"ok":false,"error":"gh is not authenticated"}'; exit 0; }
if [ "$me" != "$owner" ]; then
  printf '{"ok":false,"error":"only the repo owner (%s) can invite collaborators — ask them to send the invite"}' "$owner"
  exit 0
fi

if gh api -X PUT "repos/$owner/$slug/collaborators/$login" -f permission=push >/dev/null 2>&1; then
  printf '{"ok":true,"status":"invited"}'
else
  printf '{"ok":false,"error":"invite failed — check the username, and that the repo exists under %s"}' "$owner"
fi
