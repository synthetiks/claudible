#!/usr/bin/env bash
# Claudible — refresh THIS branch's `origin/<branch>` ref, so the Project History panel can tell which commits
# GitHub already has and which are still only on this machine.
#
# Why a fetch and not the GitHub API: after a fetch, `origin/<branch>` IS the history GitHub's web UI shows for
# that branch. Reading a ref needs no token, works offline (you see the last known state), and — unlike the API —
# it can also see the local commits GitHub has never been told about. That comparison is the whole feature.
#
# Safety, in order of how badly each could go wrong:
#   * `git fetch` writes ONLY FETCH_HEAD and refs/remotes/<remote>/<branch>. It never touches the working tree,
#     the index, or HEAD. Verified: a failing fetch leaves .git/index byte-identical and creates no index.lock.
#   * An EXPLICIT branch, never a bare `git fetch origin` — a bare fetch would also rewrite
#     refs/remotes/origin/claudible/sessions, the ref the session-sync worktree owns.
#   * NEVER interactive. GIT_TERMINAL_PROMPT=0 alone is not enough on Windows: Git Credential Manager is a
#     *helper* and pops a GUI without ever consulting the terminal. `-c credential.helper=` resets the whole
#     (multi-valued) helper chain to empty, so no GUI helper can run.
#   * …but that reset is total: it also clears the URL-scoped `credential.https://github.com.helper` that
#     `gh auth setup-git` installs, and MK's repos are private — so a bare reset means every fetch fails with
#     "could not read Username" and the panel silently freezes on stale refs. Verified empirically. We therefore
#     reset the chain and re-add EXACTLY ONE helper, `gh auth git-credential`, scoped to github.com so a GitHub
#     token can never be offered to gitlab or a self-hosted remote. No gh → no helper → a private fetch simply
#     fails fast, and the panel keeps showing the last state it knew.
#   * ssh remotes can't prompt either: this runs with no controlling tty, and SSH_ASKPASS is cleared so ssh
#     cannot escalate to a GUI passphrase dialog.
#   * A dead network fails in milliseconds; the http.lowSpeed* pair bounds a *stalled* transfer too.
# Read-only. Emits one JSON line. Never fails loudly: "no upstream" is the normal state of a local-only repo.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"                   # absolute BEFORE the cd (see diff.sh)
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
cd "$SDIR" 2>/dev/null || { printf '{"ok":false,"error":"no such folder"}'; exit 0; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { printf '{"ok":false,"error":"not a git repo"}'; exit 0; }

# Resolve the tracking config directly rather than splitting `@{u}` on '/': a branch named `feature/x` makes
# `origin/feature/x` ambiguous to a naive split, and `@{u}` fatals on a detached/unborn HEAD anyway.
branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || printf '')"
[ -n "$branch" ] || { printf '{"ok":false,"error":"detached HEAD"}'; exit 0; }
remote="$(git config --get "branch.$branch.remote" 2>/dev/null || printf '')"
merge="$(git config --get "branch.$branch.merge" 2>/dev/null || printf '')"   # e.g. refs/heads/main
rbranch="${merge#refs/heads/}"
[ -n "$remote" ] && [ -n "$rbranch" ] || { printf '{"ok":false,"error":"no upstream"}'; exit 0; }
# These come from .git/config, which is repo-controlled data in an ADOPTED folder — never let one be read as a
# flag, and keep them out of the JSON below unless they're plain.
case "$remote"  in -* | *\"* | *\\*) printf '{"ok":false,"error":"unusable remote"}'; exit 0 ;; esac
case "$rbranch" in -* | *\"* | *\\*) printf '{"ok":false,"error":"unusable branch"}'; exit 0 ;; esac

#   gc.auto=0        never trigger a repack inside somebody else's repo as a side effect of our polling
#   http.lowSpeed*   a STALLED transfer (connected, no bytes) aborts in 8s instead of hanging to the app's timeout
CFG=(-c credential.helper= -c core.askpass= -c gc.auto=0 -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=8)
GH="$(command -v gh 2>/dev/null || printf '')"
# The path goes inside a single-quoted string that git hands to `sh -c`, so a quote/backslash/newline in it
# would break out. Spaces are fine (`C:/Program Files/GitHub CLI/gh.exe`) — that's what the quoting is for.
# NB: `$'\n'`, not `"$(printf '\n')"` — command substitution strips trailing newlines, so the latter is the
# EMPTY string, making the pattern `*""*` match every path and silently disable the helper. (It did.)
case "$GH" in *\'* | *\\* | *$'\n'*) GH="" ;; esac
[ -n "$GH" ] && CFG+=(-c "credential.https://github.com.helper=!'$GH' auth git-credential")

export GIT_TERMINAL_PROMPT=0   # no username/password prompt on the terminal
export SSH_ASKPASS_REQUIRE=never   # …and ssh may not escalate a passphrase prompt into a GUI dialog
unset GIT_ASKPASS SSH_ASKPASS DISPLAY 2>/dev/null || true
if git "${CFG[@]}" fetch --no-tags --no-recurse-submodules --quiet "$remote" "$rbranch" >/dev/null 2>&1; then
  printf '{"ok":true,"fetched":true,"upstream":"%s/%s"}' "$remote" "$rbranch"
else
  # Offline, no credentials, repo gone — all normal. The panel keeps showing the last fetched state.
  printf '{"ok":true,"fetched":false,"upstream":"%s/%s"}' "$remote" "$rbranch"
fi
