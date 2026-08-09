#!/usr/bin/env bash
# Claudible — invite a GitHub user as a PUSH collaborator on a repo workspace's repo (Stage 2 collab).
# Args: $1 = repo name (GitHub's own charset — letters, digits, dot, underscore, dash; C-3.4), $2 = github
# login, $3 = the repo's OWNER (both strict [A-Za-z0-9-] — GitHub logins can't hold a dot/underscore).
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
# C-3.4 — widened from [A-Za-z0-9-] to GitHub's own repo-name charset: an invite to my_repo/next.js used to be
# refused here (or worse, silently re-sanitized upstream to myrepo/nextjs — a DIFFERENT repo). $slug is used
# ONLY inside a double-quoted `gh api` path segment below, so a dot/underscore needs no extra escaping.
case "$slug"  in '' | . | .. | *[!A-Za-z0-9._-]*) printf '{"ok":false,"error":"bad repo name"}'; exit 0 ;; esac
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
  # INVITE TO THE SESSIONS REPO TOO. A project's transcripts live in a SEPARATE private repo
  # (<slug>-sessions, created by create-workspace.sh) so the code repo can be made public safely. Access to
  # the code repo alone therefore buys a collaborator nothing on the sessions side: their sync would fail to
  # fetch and fail to push, and the symptom is the one this project has already burned hours on — sharing
  # that silently does nothing. Same push permission, same invite semantics.
  # Only attempted when the repo actually exists: projects created before the split have no second repo, and
  # a 404 there is normal, not an error. The code invite above is what decides ok — a sessions-repo hiccup
  # is reported in `note` rather than failing an invite that genuinely succeeded.
  sess="$slug-sessions"
  if gh repo view "$owner/$sess" >/dev/null 2>&1; then
    if gh api -X PUT "repos/$owner/$sess/collaborators/$login" -f permission=push >/dev/null 2>&1; then
      printf '{"ok":true,"status":"invited","sessionsRepo":"%s/%s"}' "$owner" "$sess"
    else
      printf '{"ok":true,"status":"invited","note":"invited to the project, but adding them to the private sessions repo (%s) failed — they will not receive synced sessions until that is fixed"}' "$sess"
    fi
  else
    printf '{"ok":true,"status":"invited"}'
  fi
else
  printf '{"ok":false,"error":"invite failed — check the username, and that the repo exists under %s"}' "$owner"
fi
