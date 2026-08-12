#!/usr/bin/env bash
# Claudible — clone an EXISTING repo workspace you've been invited to, into ~/.claudible/repos/<slug>.
# Used by discovery (and lazily on first open) so a collaborator's workspace becomes usable locally.
#
# C-3.4 — TWO separate name values, on purpose. $2 (repo) is the EXACT name GitHub has on file — its own
# charset (letters, digits, dot, underscore, dash: my_repo, next.js) — and is what gets cloned. $3 (slug) is
# the LOCAL folder name, strict [A-Za-z0-9-], and is what everything on disk (the folder, every Claude
# transcript path) is keyed on. The old one-arg version sanitized the repo name down to the slug charset FIRST
# and cloned the sanitized result — `my_repo` silently cloned `myrepo`, a different repository. Never collapse
# these back into one value.
#
# Args: $1 = owner (github login, strict [A-Za-z0-9-]); $2 = repo (GitHub's own charset, see above);
# $3 = slug (strict [A-Za-z0-9-]); $4 = optional custom absolute WSL dir (already validated by main.js) — when
# omitted, clone into ~/.claudible/repos/<slug>. Emits one JSON line; on success it echoes the resolved "path"
# so main can record it (ws.path -> CLAUDIBLE_WS_DIR).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/_git-safe.sh"
owner="${1:-}"
repo="${2:-}"
slug="${3:-}"
dir_in="${4:-}"
case "$owner" in '' | -* | *- | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad owner"}'; exit 0 ;; esac
# GitHub's own repo-name charset. A `'` ends the single-quoted bash arg this reaches; a `"`, a `\` or a control
# byte breaks the JSON we printf below — none of those are in this charset, so nothing here needs escaping.
# `.` and `..` are refused directly: they are magic to path resolution and no real GitHub repo is named either.
case "$repo" in '' | . | .. | *[!A-Za-z0-9._-]*) printf '{"ok":false,"error":"bad repo name"}'; exit 0 ;; esac
case "$slug"  in '' | -* | *- | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad slug"}'; exit 0 ;; esac
# Same charset as lib/pathSafe.js (main.js rejects it first) and as adopt-workspace.sh. Belt: workspaces.json is hand-editable.
# CASE-24: also refuse traversal segments — main.js's isContainedPath is the primary guard; this is the belt.
case "$dir_in" in *\'* | *\"* | *\\* | *[[:cntrl:]]* | .. | ../* | */.. | */../*) printf '{"ok":false,"error":"bad dir"}'; exit 0 ;; esac

if [ -n "$dir_in" ]; then dir="$dir_in"; else dir="$HOME/.claudible/repos/$slug"; fi
# Windows git-bash: the runner sets MSYS_NO_PATHCONV, so gh/git.exe read our path literally and turn the MSYS
# '/c/…' form into 'C:\c\…' — the clone lands in the wrong place and the recorded path never matches Claude's
# transcript store (missing sessions). Normalize to the mixed 'C:/…' form that git AND bash both accept, and
# RETURN that form so ws.path stays consistent everywhere. No-op on WSL/Posix (cygpath absent) or a C:/ dir.
if command -v cygpath >/dev/null 2>&1; then dir="$(cygpath -m "$dir" 2>/dev/null || printf '%s' "$dir")"; fi
if [ -d "$dir/.git" ]; then printf '{"ok":true,"already":true,"slug":"%s","repoName":"%s","path":"%s"}' "$slug" "$repo" "$dir"; exit 0; fi   # already cloned
# NEVER rm -rf a directory we did not create. The rollback below exists to drop a HALF-DONE clone, but the only
# pre-clone check used to be "$dir/.git" — so a path that already held the user's own (non-git) files sailed
# straight through, `gh repo clone` failed on the non-empty target, and the rollback deleted their work.
# create-workspace.sh has always refused a pre-existing dir outright; this is the same guard, one step softer:
#   * a plain file, or a non-empty dir -> refuse, touch nothing
#   * exists but is an empty dir        -> clone into it, but remember NOT to remove it on failure
if [ -e "$dir" ] && { [ ! -d "$dir" ] || [ -n "$(find "$dir" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; }; then
  printf '{"ok":false,"error":"that folder already exists and is not empty — pick another location"}'; exit 0
fi
pre_existed=0; [ -e "$dir" ] && pre_existed=1
command -v gh >/dev/null 2>&1 || { printf '{"ok":false,"error":"the GitHub CLI (gh) is not installed in WSL"}'; exit 0; }
case "$(uname -r 2>/dev/null)" in *[Mm]icrosoft*) case "$(command -v gh 2>/dev/null)" in *.exe|/mnt/*) { printf '{"ok":false,"error":"gh resolves to a Windows gh.exe via interop — install the Linux gh inside WSL"}'; exit 0; } ;; esac ;; esac   # a Windows gh.exe leaking through WSL interop reads the WINDOWS credential store and mangles Linux paths
mkdir -p "$(dirname "$dir")" 2>/dev/null
# Clone the EXACT repo ($owner/$repo) — the folder is named by $slug, but the thing fetched from GitHub is
# never the sanitized value. This is the fix: before, $slug was cloned here too, so a name GitHub allows but
# Claudible's folder charset doesn't (my_repo, next.js) silently fetched a DIFFERENT, sanitized-name repo.
if gh repo clone "$owner/$repo" "$dir" >/dev/null 2>&1; then
  # WIRE THE SESSIONS REMOTE. Without this a collaborator's clone has no `claudible-sessions` remote, so
  # sessions-sync falls back to origin and pushes THEIR transcripts onto the CODE repo — re-creating, on their
  # machine, the exact exposure the split exists to prevent. Silent, and invisible to the project owner.
  # The pairing is read from the committed marker rather than guessed from a naming convention, so it stays
  # correct if the convention ever changes or the repo is renamed.
  sess="$(sed -n 's/.*"sessionsRepo"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$dir/.claudible-workspace" 2>/dev/null | head -1)"
  case "$sess" in
    */*) case "$sess" in
           *[!A-Za-z0-9._/-]*) sess="" ;;   # owner/repo charset only — this string reaches a git remote URL
         esac ;;
    *) sess="" ;;
  esac
  [ -n "$sess" ] && git -C "$dir" remote add claudible-sessions "https://github.com/$sess.git" >/dev/null 2>&1
  printf '{"ok":true,"slug":"%s","owner":"%s","repoName":"%s","repoUrl":"https://github.com/%s/%s","path":"%s"}' "$slug" "$owner" "$repo" "$owner" "$repo" "$dir"
else
  [ "$pre_existed" = 0 ] && rm -rf "$dir" 2>/dev/null   # only ever remove the dir this run created
  printf '{"ok":false,"error":"clone failed (check access to %s/%s)"}' "$owner" "$repo"
fi
