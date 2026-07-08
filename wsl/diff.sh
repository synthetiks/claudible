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
. "$HERE/_git-safe.sh"                                   # a hostile .git/config in an ADOPTED repo can run commands (core.fsmonitor fires on `git diff HEAD`, verified) — neutralize before ANY git call
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
# Bounded at the source: an un-ignored node_modules/dist/vendor tree yields tens of thousands of paths, and this
# whole string is passed as ONE env var to node below — over ~128KB (MAX_ARG_STRLEN) the exec dies with "Argument
# list too long", taking the commit list down with it. diff-tool.js only ever renders the first 200 anyway.
untracked="$(git -c core.quotepath=false ls-files --others --exclude-standard 2>/dev/null | head -n 200)"

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

# --- what GitHub knows ------------------------------------------------------------------------------------
# "Track the GitHub commits, not the folder's" — but after a fetch, `origin/<branch>` IS GitHub's history for
# that branch: the exact commits its web UI lists. So the remote state is a REF here, not an API call. That's
# strictly better than the API: it needs no token, works offline (showing the last fetched state), and it can
# still see the local commits GitHub has never been told about — which is precisely what "unpushed" means.
# git-fetch.sh refreshes the ref in the background; this script only ever reads.
#
# Every command below is failure-tolerant on purpose. `git rev-parse '@{u}'` FATALS (exit 128, stderr) whenever
# there is no upstream — unborn branch, detached HEAD, no remote, remote branch never pushed — and under `set -u`
# an unset var would abort the whole read. Capture, swallow, default to "".
branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || printf '')"          # "" on a detached HEAD
upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || printf '')"
# The folder's own `origin`. An adopted project's registry entry caches this as ws.repoId (for the card's GitHub
# link) at adopt time — but it's the USER's repo and they can repoint or drop the remote at any moment, so main.js
# reconciles the cache against this on every read. Quotes/backslashes/spaces would break the JSON; drop those.
origin="$(git remote get-url origin 2>/dev/null || printf '')"
case "$origin" in *\'* | *\"* | *\\* | *' '*) origin="" ;; esac
# `@{u}` resolves purely from config: a branch configured to track origin/main that has NEVER been fetched
# yields a name whose ref doesn't exist, and every rev-list below would then fail into a silent 0.
if [ -n "$upstream" ] && ! git rev-parse --verify --quiet "$upstream^{commit}" >/dev/null 2>&1; then upstream=""; fi
ahead=0; behind=0; unpushed=""
if [ -n "$upstream" ]; then
  ahead="$(git rev-list --count "$upstream..HEAD" 2>/dev/null || echo 0)"           # local commits GitHub hasn't seen
  behind="$(git rev-list --count "HEAD..$upstream" 2>/dev/null || echo 0)"          # commits on GitHub you don't have
  # FULL 40-char hashes: `%h`'s abbreviation length is dynamic (core.abbrev auto-grows with repo size), so a
  # set-membership test against abbreviated hashes could silently miss. The log below emits %H alongside %h.
  [ "${ahead:-0}" -gt 0 ] && unpushed="$(git rev-list "$upstream..HEAD" 2>/dev/null | head -n 500)"
fi

# Which commits to show. `week` is the honest count for "this week"; `window` says what the list actually is.
# A repo you commit to monthly is not a repo with "no commits" — when the 7-day window is empty but history
# exists, fall back to the latest 20 so the panel shows the truth instead of an encouraging void.
window=none
clog=""; cdiff_text=""
if [ "${rcount:-0}" -gt 0 ]; then
  window=week
  # %cd (COMMITTER date), not %ad: `--since` filters on the committer date, so a rebased/amended commit would
  # otherwise be listed under "last 7 days" while displaying an author date from months ago.
  clog="$(git log --no-color --since='7 days ago' -n 50 --format='%h%x1f%s%x1f%an%x1f%cd%x1f%H' --date=short HEAD 2>/dev/null)"
  base="$(git rev-list -1 --before='7 days ago' HEAD 2>/dev/null)"   # newest commit OLDER than the window (may be empty)
  [ -z "$base" ] && base="$EMPTY_TREE"                               # whole history is inside the window → diff from nothing
  cdiff_text="$(git -c core.quotepath=false diff "$base" HEAD --no-color 2>/dev/null)"
elif [ "${ccount:-0}" -gt 0 ]; then
  window=latest
  clog="$(git log --no-color -n 20 --format='%h%x1f%s%x1f%an%x1f%cd%x1f%H' --date=short HEAD 2>/dev/null)"
  # Net diff of exactly the commits listed: from the OLDEST listed commit's first parent to HEAD. `^` fails on a
  # root commit (nothing before it) → the empty tree, same as the week path's whole-history-inside-the-window case.
  oldest="$(git log --no-color -n 20 --format='%H' HEAD 2>/dev/null | tail -n 1)"
  base="$(git rev-parse --verify --quiet "${oldest}^" 2>/dev/null || printf '')"   # --quiet: a ROOT commit has no ^ → exit 1, no output
  [ -z "$base" ] && base="$EMPTY_TREE"
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
# untracked was the one env var NOT capped here — 200 pathological paths can still blow the byte limit.
if [ "${#untracked}" -gt "$maxb" ]; then untracked="${untracked:0:$maxb}"; untracked="${untracked%$'\n'*}"; fi
if [ -n "$_lcset" ]; then LC_ALL="$_lc"; else unset LC_ALL; fi

unset MSYS_NO_PATHCONV  # win-native: runner sets MSYS_NO_PATHCONV, so git-bash wont convert the /c/.. path(s) below to a Windows path for node.exe; clear it here (no-op on WSL/Posix)
# A node-side crash used to be printed as a SUCCESSFUL, empty repo ({"ok":true,...,"total":0}) — indistinguishable
# from "this repo has no commits", with the real error swallowed by 2>/dev/null. Emit ok:false instead so the panel
# can say "couldn't read changes" (and log it) rather than lying that there's nothing here. Keep stderr for the log.
DIFF="$diff_text" UNTRACKED="$untracked" CDIFF="$cdiff_text" CLOG="$clog" TOTAL="$ccount" WEEK="$rcount" \
WINDOW="$window" BRANCH="$branch" UPSTREAM="$upstream" AHEAD="$ahead" BEHIND="$behind" UNPUSHED="$unpushed" ORIGIN="$origin" \
  node "$HERE/diff-tool.js" || printf '{"ok":false,"repo":true,"error":"diff-tool failed","total":0,"week":0,"files":[],"untracked":[],"committed":[],"commits":[]}'
