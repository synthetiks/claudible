#!/usr/bin/env bash
# Claudible — list Claude Code SKILLS (user + active-workspace project scope) and toggle their visibility.
# Skills have no scriptable CLI, so we scan SKILL.md frontmatter directly (mirrors Claude's discovery) and
# read/write skillOverrides in the workspace's .claude/settings.local.json.
# Args: $1 = op (list|set); for set: $2 = skill name, $3 = state (on|off|name-only|user-invocable-only).
# cwd derived from CLAUDIBLE_WS_KIND/CLAUDIBLE_WS_SLUG like the other scripts. Emits JSON.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"                   # ABSOLUTE script dir, resolved BEFORE any cd into the workspace
. "$HERE/node-path.sh" 2>/dev/null || true              # nvm's node isn't on PATH for non-interactive shells → resolve it

. "$HERE/_ws-dir.sh"                                    # defines WS_KIND / WS_SLUG / SDIR — the one workspace-dir resolution

op="${1:-list}"
case "$op" in

  list)
    unset MSYS_NO_PATHCONV  # win-native: runner sets MSYS_NO_PATHCONV, so git-bash wont convert the /c/.. path(s) below to a Windows path for node.exe; clear it here (no-op on WSL/Posix)
    node "$HERE/skills-tool.js" list "$SDIR" 2>/dev/null || printf '[]'
    ;;

  set)
    name="${2:-}"; state="${3:-}"
    case "$name"  in '' | *[!A-Za-z0-9:/_.-]*) printf '{"ok":false,"error":"bad name"}';  exit 0 ;; esac
    case "$state" in on|off|name-only|user-invocable-only) ;; *) printf '{"ok":false,"error":"bad state"}'; exit 0 ;; esac
    unset MSYS_NO_PATHCONV  # win-native: runner sets MSYS_NO_PATHCONV, so git-bash wont convert the /c/.. path(s) below to a Windows path for node.exe; clear it here (no-op on WSL/Posix)
    node "$HERE/skills-tool.js" set "$SDIR" "$name" "$state" 2>/dev/null || printf '{"ok":false,"error":"write failed"}'
    ;;

  *) printf '{"ok":false,"error":"bad op"}' ;;
esac
