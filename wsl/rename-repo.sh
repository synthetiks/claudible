#!/usr/bin/env bash
# Claudible — rename a repo workspace's GitHub repo (OWNER-only) and repoint the local clone's origin remote.
# Args: $1 = owner, $2 = current repo name, $3 = new repo name. All strict [A-Za-z0-9-] (Claudible slug charset).
#
# The workspace SLUG is deliberately NOT changed by the caller: it names ~/.claudible/repos/<slug> and, through
# that, ~/.claude/projects/<encoded cwd>/ — i.e. EVERY Claude transcript for this project. Renaming it would
# silently orphan all of them. So this only moves the REMOTE identity: it renames on GitHub and rewrites the
# folder's `origin` URL so sync stops depending on GitHub's (squatting-fragile) redirect. Emits one JSON line.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/_git-safe.sh"                                  # neutralize command-executing .git/config keys before the `git remote set-url` below (tree-wide invariant — see test/adopt-workspace.test.js)
. "$HERE/_ws-dir.sh"                                    # defines WS_KIND / WS_SLUG / SDIR — the one workspace-dir resolution

owner="${1:-}"
old="${2:-}"
new="${3:-}"
case "$owner" in '' | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad owner"}';    exit 0 ;; esac
case "$old"   in '' | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad name"}';     exit 0 ;; esac
case "$new"   in '' | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad new name"}'; exit 0 ;; esac

command -v gh >/dev/null 2>&1 || { printf '{"ok":false,"error":"the GitHub CLI (gh) is not installed in WSL"}'; exit 0; }
me="$(gh api user --jq .login 2>/dev/null)"
[ -z "$me" ] && { printf '{"ok":false,"error":"gh is not authenticated"}'; exit 0; }
[ "$me" = "$owner" ] || { printf '{"ok":false,"error":"not-owner"}'; exit 0; }   # only the owner can rename a repo — the caller degrades this to a label-only rename

# Rename on GitHub. Fails if the new name already exists under the owner, or the repo doesn't exist.
if ! gh repo rename "$new" --repo "$owner/$old" -y >/dev/null 2>&1; then
  printf '{"ok":false,"error":"could not rename on GitHub — the name may be taken, or the repo does not exist under %s"}' "$owner"
  exit 0
fi

# Repoint the local clone's origin to the canonical new URL so sync no longer relies on GitHub's redirect (which
# breaks the moment anyone squats the old name). Best-effort: a missing/differently-remoted folder keeps working
# via the redirect, so a failure here is not fatal to the rename that already happened on GitHub.
if [ -d "$SDIR/.git" ]; then
  git -C "$SDIR" remote set-url origin "https://github.com/$owner/$new.git" >/dev/null 2>&1 || true
fi

# The repo's stable numeric id — the caller stores it so discovery dedupes by identity, not by name (a name-based
# dedupe would re-add the renamed repo as a phantom duplicate on the very next launch, on every machine).
ghid="$(gh api "repos/$owner/$new" --jq .id 2>/dev/null)"
case "$ghid" in '' | *[!0-9]*) ghid="" ;; esac

if [ -n "$ghid" ]; then
  printf '{"ok":true,"repoName":"%s","repoUrl":"https://github.com/%s/%s","ghId":%s}' "$new" "$owner" "$new" "$ghid"
else
  printf '{"ok":true,"repoName":"%s","repoUrl":"https://github.com/%s/%s"}' "$new" "$owner" "$new"
fi
