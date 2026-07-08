#!/usr/bin/env bash
# Claudible — report a workspace's git changes as structured JSON, for the in-app Diff Review panel. Read-only.
# Resolves the SAME per-workspace cwd as sessions.sh, then emits BOTH:
#   * uncommitted working-tree changes (`git diff HEAD`) → files → hunks, each with a self-contained patch
#     `git apply -R` can reverse (so the UI can revert one hunk). Untracked files are listed separately.
#   * recently-COMMITTED changes (net diff of the last few commits) → so work that's already committed is still
#     reviewable (git diff HEAD alone shows nothing once Claude commits). Committed changes are review-only.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"                   # ABSOLUTE script dir, resolved BEFORE we cd into the repo — else
                                                        # `node "$(dirname "$0")/diff-tool.js"` resolves against the WORKSPACE
                                                        # and dies with MODULE_NOT_FOUND (which the old `|| printf ok:true`
                                                        # fallback then reported as a perfectly healthy, empty repo).
                                                        # Mirrors checkpoint.sh, which already does exactly this.
. "$HERE/node-path.sh" 2>/dev/null || true              # nvm's node isn't on PATH for non-interactive shells → resolve it
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

# Committed: the commits from the LAST 7 DAYS ("recent" = this week), plus their NET diff.
#
# The commit LIST and the net DIFF are gathered INDEPENDENTLY, on purpose:
#   * The list comes straight from `git log --since` — which walks every parent, so a week containing a MERGE
#     commit is listed correctly. The old code counted with `--since` (all parents) but fetched with `HEAD~N`
#     (first-parent only). On any merge those disagree, `HEAD~N` doesn't exist, git errored into /dev/null, and
#     the panel showed NOTHING for a repo that had just merged a branch. `-n` caps the list; `git log` clamps at
#     the root commit by itself, so no `ccount-1` fudge (which used to silently drop a young repo's first commit,
#     and hid a repo whose only commit was its root).
#   * The net diff is `<last commit BEFORE the window>..HEAD`, or the EMPTY TREE when the whole history is inside
#     the window (a repo younger than a week). It may legitimately come back empty — commit-then-revert nets to
#     nothing — and that must NOT erase the commit list (the renderer used to gate the list on this diff).
ccount="$(git rev-list --count HEAD 2>/dev/null || echo 0)"          # lifetime tally (card header)
rcount="$(git rev-list --count --since='7 days ago' HEAD 2>/dev/null || echo 0)"   # commits this week (all parents)
EMPTY_TREE=4b825dc642cb6eb9a060e54bf8d69288fbee4904                  # git's well-known empty tree object
clog=""; cdiff_text=""
if [ "${rcount:-0}" -gt 0 ]; then
  clog="$(git log --no-color --since='7 days ago' -n 50 --format='%h%x1f%s%x1f%an%x1f%ad' --date=short HEAD 2>/dev/null)"
  base="$(git rev-list -1 --before='7 days ago' HEAD 2>/dev/null)"   # newest commit OLDER than the window (may be empty)
  [ -z "$base" ] && base="$EMPTY_TREE"                               # whole history is inside the window → diff from nothing
  cdiff_text="$(git -c core.quotepath=false diff "$base" HEAD --no-color 2>/dev/null)"
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
# A node-side crash used to be printed as a SUCCESSFUL, empty repo ({"ok":true,...,"total":0}) — indistinguishable
# from "this repo has no commits", with the real error swallowed by 2>/dev/null. Emit ok:false instead so the panel
# can say "couldn't read changes" (and log it) rather than lying that there's nothing here. Keep stderr for the log.
DIFF="$diff_text" UNTRACKED="$untracked" CDIFF="$cdiff_text" CLOG="$clog" TOTAL="$ccount" WEEK="$rcount" node "$HERE/diff-tool.js" || printf '{"ok":false,"repo":true,"error":"diff-tool failed","total":0,"week":0,"files":[],"untracked":[],"committed":[],"commits":[]}'
