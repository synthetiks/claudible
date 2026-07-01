#!/usr/bin/env bash
# Claudible — list Claude Code SKILLS (user + active-workspace project scope) and toggle their visibility.
# Skills have no scriptable CLI, so we scan SKILL.md frontmatter directly (mirrors Claude's discovery) and
# read/write skillOverrides in the workspace's .claude/settings.local.json.
# Args: $1 = op (list|set); for set: $2 = skill name, $3 = state (on|off|name-only|user-invocable-only).
# cwd derived from CLAUDIBLE_WS_KIND/CLAUDIBLE_WS_SLUG like the other scripts. Emits JSON.
set -u
. "$(dirname "$0")/node-path.sh" 2>/dev/null || true   # nvm's node isn't on PATH for non-interactive shells → resolve it

WS_KIND="${CLAUDIBLE_WS_KIND:-legacy}"
WS_SLUG="${CLAUDIBLE_WS_SLUG:-}"
case "$WS_SLUG" in *[!A-Za-z0-9-]*) WS_SLUG="" ;; esac
if [ "$WS_KIND" = "local" ] && [ -n "$WS_SLUG" ]; then SDIR="$HOME/.claudible/workspaces/$WS_SLUG"
elif [ "$WS_KIND" = "repo" ] && [ -n "$WS_SLUG" ]; then SDIR="$HOME/.claudible/repos/$WS_SLUG"
else SDIR="$HOME/.claudible/session"; fi
[ -n "${CLAUDIBLE_WS_DIR:-}" ] && SDIR="$CLAUDIBLE_WS_DIR"   # custom save-location override

op="${1:-list}"
case "$op" in

  list)
    unset MSYS_NO_PATHCONV  # win-native: runner sets MSYS_NO_PATHCONV, so git-bash wont convert the /c/.. path(s) below to a Windows path for node.exe; clear it here (no-op on WSL/Posix)
    node "$(dirname "$0")/skills-tool.js" list "$SDIR" 2>/dev/null || printf '[]'
    ;;

  set)
    name="${2:-}"; state="${3:-}"
    case "$name"  in '' | *[!A-Za-z0-9:/_.-]*) printf '{"ok":false,"error":"bad name"}';  exit 0 ;; esac
    case "$state" in on|off|name-only|user-invocable-only) ;; *) printf '{"ok":false,"error":"bad state"}'; exit 0 ;; esac
    unset MSYS_NO_PATHCONV  # win-native: runner sets MSYS_NO_PATHCONV, so git-bash wont convert the /c/.. path(s) below to a Windows path for node.exe; clear it here (no-op on WSL/Posix)
    node "$(dirname "$0")/skills-tool.js" set "$SDIR" "$name" "$state" 2>/dev/null || printf '{"ok":false,"error":"write failed"}'
    ;;

  *) printf '{"ok":false,"error":"bad op"}' ;;
esac
