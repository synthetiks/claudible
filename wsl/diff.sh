#!/usr/bin/env bash
# Claudible — report a workspace's git changes as structured JSON, for the in-app Diff Review panel. Read-only.
# Resolves the SAME per-workspace cwd as sessions.sh, then emits BOTH:
#   * uncommitted working-tree changes (`git diff HEAD`) → files → hunks, each with a self-contained patch
#     `git apply -R` can reverse (so the UI can revert one hunk). Untracked files are listed separately.
#   * recently-COMMITTED changes (net diff of the last few commits) → so work that's already committed is still
#     reviewable (git diff HEAD alone shows nothing once Claude commits). Committed changes are review-only.
set -u
WS_KIND="${CLAUDIBLE_WS_KIND:-legacy}"
WS_SLUG="${CLAUDIBLE_WS_SLUG:-}"
case "$WS_SLUG" in *[!A-Za-z0-9-]*) WS_SLUG="" ;; esac
if [ "$WS_KIND" = "local" ] && [ -n "$WS_SLUG" ]; then
  SDIR="$HOME/.claudible/workspaces/$WS_SLUG"
elif [ "$WS_KIND" = "repo" ] && [ -n "$WS_SLUG" ]; then
  SDIR="$HOME/.claudible/repos/$WS_SLUG"
else
  SDIR="$HOME/.claudible/session"
fi
[ -n "${CLAUDIBLE_WS_DIR:-}" ] && SDIR="$CLAUDIBLE_WS_DIR"
cd "$SDIR" 2>/dev/null || { printf '{"ok":true,"repo":false,"files":[],"untracked":[],"committed":[],"commits":[]}'; exit 0; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { printf '{"ok":true,"repo":false,"files":[],"untracked":[],"committed":[],"commits":[]}'; exit 0; }

# Uncommitted: raw unified diff of the whole working tree vs HEAD (python skips binary).
diff_text="$(git -c core.quotepath=false diff HEAD --no-color 2>/dev/null)"
untracked="$(git -c core.quotepath=false ls-files --others --exclude-standard 2>/dev/null)"

# Committed: net diff of the last N commits (so work Claude already committed is still visible). Bounded so we
# never dump the whole history; never reaches past the root commit.
ccount="$(git rev-list --count HEAD 2>/dev/null || echo 0)"
N=0
if [ "${ccount:-0}" -gt 1 ]; then N=10; [ "$ccount" -le "$N" ] && N=$((ccount-1)); fi
cdiff_text=""; clog=""
if [ "$N" -gt 0 ]; then
  cdiff_text="$(git -c core.quotepath=false diff "HEAD~$N" HEAD --no-color 2>/dev/null)"
  clog="$(git log --no-color --format='%h%x1f%s%x1f%an%x1f%ad' --date=short "HEAD~$N"..HEAD 2>/dev/null)"
fi

DIFF="$diff_text" UNTRACKED="$untracked" CDIFF="$cdiff_text" CLOG="$clog" node "$(dirname "$0")/diff-tool.js" 2>/dev/null || printf '{"ok":true,"repo":true,"files":[],"untracked":[],"committed":[],"commits":[]}'
