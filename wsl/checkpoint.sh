#!/usr/bin/env bash
# Claudible — per-prompt worktree checkpoints behind the Session History "Revert" button. Resolves the SAME
# per-workspace repo as diff.sh / sessions.sh, then runs the tested lib/checkpoint.js (via checkpoint-tool.js) to
# snapshot / restore / prune. Subcommands: snapshot <id> | restore <id> | prune <keepId...>. Emits ONE JSON line.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"                   # resolve the script dir as an ABSOLUTE path BEFORE we cd into the repo (else the tool path below resolves against the repo)
. "$HERE/node-path.sh" 2>/dev/null || true             # nvm's node isn't on PATH for non-interactive shells → resolve it

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

cd "$SDIR" 2>/dev/null || { printf '{"ok":false,"error":"no workspace dir"}\n'; exit 0; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { printf '{"ok":false,"repo":false,"error":"not a git repo"}\n'; exit 0; }

# win-native: subshell unsets MSYS_NO_PATHCONV so git-bash converts node's /c/.. script path (no-op on WSL)
(unset MSYS_NO_PATHCONV; node "$HERE/checkpoint-tool.js" "$@")
