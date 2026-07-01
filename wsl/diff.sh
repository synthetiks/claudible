#!/usr/bin/env bash
# Claudible — report a workspace's git changes as structured JSON, for the in-app Diff Review panel. Read-only.
# Resolves the SAME per-workspace cwd as sessions.sh, then emits BOTH:
#   * uncommitted working-tree changes (`git diff HEAD`) → files → hunks, each with a self-contained patch
#     `git apply -R` can reverse (so the UI can revert one hunk). Untracked files are listed separately.
#   * recently-COMMITTED changes (net diff of the last few commits) → so work that's already committed is still
#     reviewable (git diff HEAD alone shows nothing once Claude commits). Committed changes are review-only.
set -u
. "$(dirname "$0")/node-path.sh" 2>/dev/null || true   # nvm's node isn't on PATH for non-interactive shells → resolve it
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

# Committed: net diff of the commits from the LAST 7 DAYS ("recent" = this week). Bounded so a very busy week never
# dumps the world; never reaches past the root commit. ccount = lifetime total commits (shown as the tally).
ccount="$(git rev-list --count HEAD 2>/dev/null || echo 0)"
rcount="$(git rev-list --count --since='7 days ago' HEAD 2>/dev/null || echo 0)"
N=0
if [ "${ccount:-0}" -gt 1 ]; then
  N="${rcount:-0}"
  [ "$N" -gt 20 ] && N=20                          # cap the net diff for a hyperactive week
  [ "$N" -gt "$((ccount-1))" ] && N=$((ccount-1))  # never reach past the root commit
fi
cdiff_text=""; clog=""
if [ "$N" -gt 0 ]; then
  cdiff_text="$(git -c core.quotepath=false diff "HEAD~$N" HEAD --no-color 2>/dev/null)"
  clog="$(git log --no-color --format='%h%x1f%s%x1f%an%x1f%ad' --date=short "HEAD~$N"..HEAD 2>/dev/null)"
fi

# A single env var > ~128KB (Linux MAX_ARG_STRLEN) makes the node exec below fail ("Argument list too long").
# Keep each diff safely under that: truncate a giant working-tree diff at a line boundary; drop a giant committed
# net-diff entirely (the commit LIST still shows — that's what "recent" is really about).
# MAX_ARG_STRLEN is a BYTE limit, but bash ${#…}/slicing count CHARACTERS under a UTF-8 locale — so a multibyte-heavy
# diff (CJK/Cyrillic/etc.) could pass the char cap yet exceed the byte limit, failing the exec → silent empty diff.
# Measure + slice in BYTES (LC_ALL=C); the trailing-newline trim then drops any half-cut multibyte char at the cut.
maxb=110000
_lc="${LC_ALL-}"; _lcset="${LC_ALL+x}"; LC_ALL=C
if [ "${#diff_text}" -gt "$maxb" ]; then diff_text="${diff_text:0:$maxb}"; diff_text="${diff_text%$'\n'*}"; fi
[ "${#cdiff_text}" -gt "$maxb" ] && cdiff_text=""
if [ -n "$_lcset" ]; then LC_ALL="$_lc"; else unset LC_ALL; fi

unset MSYS_NO_PATHCONV  # win-native: runner sets MSYS_NO_PATHCONV, so git-bash wont convert the /c/.. path(s) below to a Windows path for node.exe; clear it here (no-op on WSL/Posix)
DIFF="$diff_text" UNTRACKED="$untracked" CDIFF="$cdiff_text" CLOG="$clog" TOTAL="$ccount" node "$(dirname "$0")/diff-tool.js" 2>/dev/null || printf '{"ok":true,"repo":true,"total":0,"files":[],"untracked":[],"committed":[],"commits":[]}'
