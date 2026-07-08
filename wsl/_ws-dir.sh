# shellcheck shell=bash
# Claudible — THE workspace-directory resolution. SOURCE this (`. "$HERE/_ws-dir.sh"`); never execute it.
#
# Each Claudible workspace runs in its OWN directory, so Claude's per-cwd history isolates for free
# (~/.claude/projects/<encoded cwd>/). The app inlines a kind + slug through wsEnv(); an unset kind — or a slug
# carrying anything outside [A-Za-z0-9-] — falls back to the original single session dir, so installs that
# predate workspaces keep working. The slug is a strict [A-Za-z0-9-] leaf with no path characters, and a slug
# that fails that test is DISCARDED WHOLE rather than stripped, so it can never redirect the interpolation into
# a different directory.
#
# Defines: WS_KIND, WS_SLUG, SDIR. WS_KIND/WS_SLUG stay in scope on purpose — sessions.sh reads them again
# afterwards to derive its sessions-sync worktree path.
#
# This block lived, character for character, in TWELVE scripts. Two had drifted to a different line wrapping and
# three carried three different trailing comments. All harmless — but it meant any change to how a workspace
# resolves had to be made twelve times and verified twelve times, and the next person to fix a bug here would
# fix it in the one file they were looking at. That is the exact shape of every sibling-call-site bug this
# codebase has shipped. There is one copy now, and test/ws-dir.test.sh proves no script grew a thirteenth.
#
# TWO deliberate non-users, both load-bearing — do NOT "unify" them:
#   * wsl/sessions-sync.sh resolves repo workspaces ONLY and hard-fails on a bad/empty/dash-edged slug instead
#     of falling back to the legacy dir. A sync that quietly targeted ~/.claudible/session would push the wrong
#     tree.
#   * runners/win.js `sessionDir()` re-implements this in Windows paths, because the native-Windows backend
#     never shells out to bash. A change here must land there too (test/win-runner.test.js covers it).

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
# Custom save-location — set only for workspaces with a stored path. Written as a full `if` rather than the
# `[ -n … ] && SDIR=…` one-liner it replaces: that form leaves $? = 1 when the variable is unset, and this is
# the LAST line of a sourced file, so `. _ws-dir.sh` would return non-zero on the common path.
if [ -n "${CLAUDIBLE_WS_DIR:-}" ]; then SDIR="$CLAUDIBLE_WS_DIR"; fi
