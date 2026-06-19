#!/usr/bin/env bash
# Claudible — discover repo workspaces this user has been INVITED to co-work on, so the app can auto-add
# them ("invites just appear"). Lists private repos the user is a collaborator on (incl. ones owned by
# others), then keeps only those carrying the .claudible-workspace marker that create-workspace.sh commits.
# Emits a JSON array: [{"slug":"<repo>","owner":"<login>","repoUrl":"https://github.com/<login>/<repo>"}].
# main.js dedupes against the local registry and clones+registers anything new. Read-only; no side effects.
set -u
emit() { printf '%s\n' "$1"; }

command -v gh >/dev/null 2>&1 || { emit '[]'; exit 0; }
me="$(gh api user --jq .login 2>/dev/null)"
case "$me" in '' | *[!A-Za-z0-9-]*) emit '[]'; exit 0 ;; esac

# Private repos the user can push to via collaborator/org membership (excludes repos they merely own and
# never shared). owner+name only; both are validated below before any are emitted.
repos="$(gh api --paginate '/user/repos?affiliation=collaborator,organization_member&per_page=100' \
           --jq '.[] | select(.private==true) | [.owner.login, .name] | @tsv' 2>/dev/null)"
[ -n "$repos" ] || { emit '[]'; exit 0; }

first=1
printf '['
while IFS="$(printf '\t')" read -r owner name; do
  case "$owner" in '' | *[!A-Za-z0-9-]*) continue ;; esac
  case "$name"  in '' | *[!A-Za-z0-9-]*) continue ;; esac     # only repos whose name is a valid slug
  # The marker file is the definitive "this is a Claudible workspace" signal. 200 => present.
  gh api "repos/$owner/$name/contents/.claudible-workspace" >/dev/null 2>&1 || continue
  [ "$first" = 1 ] || printf ','
  first=0
  printf '{"slug":"%s","owner":"%s","repoUrl":"https://github.com/%s/%s"}' "$name" "$owner" "$owner" "$name"
done <<EOF
$repos
EOF
printf ']\n'
