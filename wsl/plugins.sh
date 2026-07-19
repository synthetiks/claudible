#!/usr/bin/env bash
# Claudible — list installed Claude Code PLUGINS (read-only from disk) and enable/disable them via the
# `claude plugin` CLI (never hand-edit installed_plugins.json — it has computed paths/timestamps).
# Args: $1 = op (list|toggle); for toggle: $2 = plugin key (name@marketplace), $3 = enable|disable.
# Emits JSON.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"   # absolute BEFORE the ops below (some `unset`/branch first) — finishes the $HERE sweep so a future `cd` can't repoint the node-tool paths
. "$HERE/node-path.sh" 2>/dev/null || true             # nvm's node isn't on PATH for non-interactive shells → resolve it

op="${1:-list}"
case "$op" in

  list)
    unset MSYS_NO_PATHCONV  # win-native: runner sets MSYS_NO_PATHCONV, so git-bash wont convert the /c/.. path(s) below to a Windows path for node.exe; clear it here (no-op on WSL/Posix)
    node "$HERE/plugins-tool.js" list 2>/dev/null || printf '[]'
    ;;

  toggle)
    key="${2:-}"; act="${3:-}"
    case "$key" in '' | *[!A-Za-z0-9@._/-]*) printf '{"ok":false,"error":"bad key"}'; exit 0 ;; esac
    case "$act" in enable|disable) ;; *) printf '{"ok":false,"error":"bad action"}'; exit 0 ;; esac
    command -v claude >/dev/null 2>&1 || { printf '{"ok":false,"error":"claude CLI not found"}'; exit 0; }
    if claude plugin "$act" "$key" >/dev/null 2>&1; then
      [ "$act" = "enable" ] && printf '{"ok":true,"enabled":true}' || printf '{"ok":true,"enabled":false}'
    else
      printf '{"ok":false,"error":"plugin %s failed"}' "$act"
    fi
    ;;

  available)
    # Browse what's installable from the registered marketplaces (the official one + any others).
    unset MSYS_NO_PATHCONV  # win-native: runner sets MSYS_NO_PATHCONV, so git-bash wont convert the /c/.. path(s) below to a Windows path for node.exe; clear it here (no-op on WSL/Posix)
    node "$HERE/plugins-tool.js" available 2>/dev/null || printf '[]'
    ;;

  *) printf '{"ok":false,"error":"bad op"}' ;;
esac
