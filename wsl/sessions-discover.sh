#!/usr/bin/env bash
# Claudible — discover the user's Claudible workspaces on GitHub so they "just appear" (a) on this user's OTHER
# devices and (b) when they've been invited to co-work. Lists private repos the user OWNS or collaborates on
# (owner + collaborator + org), keeping only those tagged with the `claudible-workspace` TOPIC. The topic is
# returned INLINE by /user/repos, so this is ONE paginated call with NO per-repo lookups — fast + seamless,
# unlike the old per-repo marker scan. Older repos that predate the topic are still caught by a marker fallback.
# Emits a JSON array: [{"slug":"<repo>","owner":"<login>","repoUrl":"https://github.com/<login>/<repo>"}].
# main.js dedupes against the local registry and clones+registers anything new. Read-only; no side effects.
set -u
emit() { printf '%s\n' "$1"; }

command -v gh >/dev/null 2>&1 || { emit '[]'; exit 0; }
me="$(gh api user --jq .login 2>/dev/null)"
case "$me" in '' | *[!A-Za-z0-9-]*) emit '[]'; exit 0 ;; esac

# ONE paginated /user/repos call (affiliation includes `owner` so the user's OWN synced workspaces surface on
# their other devices — the old query excluded owned repos). The inline `topics` array tells us, with NO extra
# request, whether a repo is already tagged. We partition: tagged repos are workspaces immediately (the fast,
# seamless common case); UNTAGGED repos (created before the topic, or only collaborated on) get a marker check
# — but BOUNDED to 60 checks total so it can never become the slow per-repo storm the old script was. This must
# run for every account (not just when the fast path is empty), else a mix of tagged + pre-topic repos would
# permanently drop the untagged ones.
all="$(gh api --paginate '/user/repos?affiliation=owner,collaborator,organization_member&per_page=100' \
         --jq '.[] | select(.private==true) | [.owner.login, .name, (if (.topics and (.topics|index("claudible-workspace"))) then "1" else "0" end)] | @tsv' 2>/dev/null)"
[ -n "$all" ] || { emit '[]'; exit 0; }

repos=""; checks=0
while IFS="$(printf '\t')" read -r o n tagged; do
  case "$o" in '' | *[!A-Za-z0-9-]*) continue ;; esac
  case "$n" in '' | *[!A-Za-z0-9-]*) continue ;; esac
  if [ "$tagged" = "1" ]; then
    repos="$repos$o	$n
"
  elif [ "$checks" -lt 60 ]; then
    checks=$((checks + 1))
    if gh api "repos/$o/$n/contents/.claudible-workspace" >/dev/null 2>&1; then
      repos="$repos$o	$n
"
    fi
  fi
done <<EOF
$all
EOF

[ -n "$repos" ] || { emit '[]'; exit 0; }

first=1
printf '['
while IFS="$(printf '\t')" read -r owner name; do
  case "$owner" in '' | *[!A-Za-z0-9-]*) continue ;; esac
  case "$name"  in '' | *[!A-Za-z0-9-]*) continue ;; esac     # only repos whose name is a valid slug
  [ "$first" = 1 ] || printf ','
  first=0
  printf '{"slug":"%s","owner":"%s","repoUrl":"https://github.com/%s/%s"}' "$name" "$owner" "$owner" "$name"
done <<EOF
$repos
EOF
printf ']\n'
