#!/usr/bin/env bash
# Claudible — list a repo's GitHub collaborators (login + stable numeric id) so a workspace's ws.collaborators
# can carry real GitHub identity data REGARDLESS of how access was granted: through Claudible's own repo:invite
# button, through workspace:acceptInvite on the joining side, or added straight on GitHub outside Claudible
# entirely before this wiring existed. That last case is exactly the B14 hardware finding (C-10.6): the owners'
# claudible-development workspace had an empty ws.collaborators, so the live-session co-author hook had nothing
# to match a connected guest against and installed nothing — silently. main.js's refreshCollaborators() calls
# this to backfill real metadata for any repo workspace, not just ones invited through the app.
#
# Args: $1 = repo name (GitHub's own charset — letters, digits, dot, underscore, dash; C-3.4), $2 = owner
# (strict [A-Za-z0-9-] — GitHub logins can't hold a dot/underscore).
# Read-only: one paginated GET (`gh api --paginate`, so a repo with more than one page of collaborators is
# still covered). Emits a JSON array: [{"login":"...","id":123}, ...] — `id` omitted when it couldn't be
# parsed as a number rather than emitted as a lie.
set -u

slug="${1:-}"
owner="${2:-}"
case "$slug"  in '' | . | .. | *[!A-Za-z0-9._-]*) printf '{"ok":false,"error":"bad repo name"}'; exit 0 ;; esac
case "$owner" in '' | *[!A-Za-z0-9-]*)             printf '{"ok":false,"error":"bad owner"}';    exit 0 ;; esac

command -v gh >/dev/null 2>&1 || { printf '{"ok":false,"error":"the GitHub CLI (gh) is not installed in WSL"}'; exit 0; }
case "$(uname -r 2>/dev/null)" in *[Mm]icrosoft*) case "$(command -v gh 2>/dev/null)" in *.exe|/mnt/*) { printf '{"ok":false,"error":"gh resolves to a Windows gh.exe via interop — install the Linux gh inside WSL"}'; exit 0; } ;; esac ;; esac   # a Windows gh.exe leaking through WSL interop reads the WINDOWS credential store and mangles Linux paths
me="$(gh api user --jq .login 2>/dev/null)"
[ -z "$me" ] && { printf '{"ok":false,"error":"gh is not authenticated"}'; exit 0; }

# Gate on gh's EXIT STATUS, not on "did it print something" — a 404/403 writes the raw error JSON to stdout and
# exits 1 (same reasoning as repo-identity.sh), so a naive non-empty check would hand that blob to the parser.
if ! out="$(gh api --paginate "repos/$owner/$slug/collaborators" --jq '.[] | [.login, (.id|tostring)] | @tsv' 2>/dev/null)"; then
  printf '{"ok":false,"error":"could not list collaborators — check the repo exists and you can read it"}'; exit 0
fi

first=1
printf '['
while IFS="$(printf '\t')" read -r login id; do
  [ -n "$login" ] || continue
  case "$login" in *[!A-Za-z0-9-]*) continue ;; esac   # GitHub logins are strictly [A-Za-z0-9-]
  case "$id" in *[!0-9]*) id="" ;; esac                # numeric id only; empty means "unknown" rather than a lie
  [ "$first" = 1 ] || printf ','
  first=0
  if [ -n "$id" ]; then
    printf '{"login":"%s","id":%s}' "$login" "$id"
  else
    printf '{"login":"%s"}' "$login"
  fi
done <<EOF
$out
EOF
printf ']\n'
