#!/usr/bin/env bash
# Claudible — B17 UX: list this user's PENDING (not yet accepted) GitHub repository collaborator invitations.
# sessions-discover.sh's /user/repos call only ever returns repos the user ALREADY has access to — a fresh
# repo:invite is invisible there until the invited side goes to github.com and clicks Accept themselves, which
# is the exact "total invisibility" gap this closes. Surfaced as a row in the New-project modal (app.js
# refreshPendingInvites) with a one-click Accept (see accept-invitation.sh).
# Emits a JSON array: [{"id":<numeric invitation id>,"owner":"...","repo":"..."}]. Degrades to '[]' on ANY
# failure — gh missing, not signed in, token lacks scope, network down — this is a "nice to notice" affordance
# layered on top of the real (accept-on-GitHub) flow, never a gate on it.
set -u
printf_empty() { printf '[]'; exit 0; }
command -v gh >/dev/null 2>&1 || printf_empty
# Same Windows/WSL interop guard sessions-discover.sh uses: a gh.exe leaking through WSL interop reads the
# WINDOWS credential store, which is a different (or absent) auth session from the one the app expects.
case "$(uname -r 2>/dev/null)" in *[Mm]icrosoft*) case "$(command -v gh 2>/dev/null)" in *.exe|/mnt/*) printf_empty ;; esac ;; esac
me="$(gh api user --jq .login 2>/dev/null)"
case "$me" in '' | *[!A-Za-z0-9-]*) printf_empty ;; esac

# /user/repository_invitations lists invitations for repos where the user has NOT yet accepted collaborator
# access. --paginate + --jq emits ONE JSON array literal PER PAGE (gh concatenates them, it does not merge), so
# — same as sessions-discover.sh's own /user/repos call — the jq filter here emits flat TSV rows instead, and
# the array is assembled by hand below from every row across every page.
rows="$(gh api --paginate user/repository_invitations \
          --jq '.[] | [(.id|tostring), .repository.owner.login, .repository.name] | @tsv' 2>/dev/null)"
[ -n "$rows" ] || printf_empty

first=1
printf '['
while IFS="$(printf '\t')" read -r id owner repo; do
  case "$id" in ''|*[!0-9]*) continue ;; esac
  case "$owner" in '' | *[!A-Za-z0-9-]*) continue ;; esac
  case "$repo" in '' | . | .. | *[!A-Za-z0-9._-]*) continue ;; esac   # GitHub's own repo-name charset (C-3.4)
  [ "$first" = 1 ] || printf ','
  first=0
  printf '{"id":%s,"owner":"%s","repo":"%s"}' "$id" "$owner" "$repo"
done <<EOF
$rows
EOF
printf ']\n'
