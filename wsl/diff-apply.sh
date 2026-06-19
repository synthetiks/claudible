#!/usr/bin/env bash
# Claudible — apply a Diff Review action in a workspace's git repo. Resolves the SAME cwd as diff.sh.
# All user/repo-controlled data is read from an APP-CONTROLLED temp file ($2), never inlined into the
# command, so repo paths/patch text can't break the shell. Emits one JSON line.
#   $1 = mode: 'apply-reverse' (revert a hunk/file patch) | 'discard' (delete an untracked file)
#   $2 = path to a temp file: the unified patch (apply-reverse) OR the target path (discard)
set -u
emit() { printf '%s\n' "$1"; }
mode="${1:-}"; tmp="${2:-}"
[ -n "$tmp" ] && [ -f "$tmp" ] || { emit '{"ok":false,"error":"bad args"}'; exit 0; }
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
cd "$SDIR" 2>/dev/null || { emit '{"ok":false,"error":"no workspace"}'; exit 0; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { emit '{"ok":false,"error":"not a git repo"}'; exit 0; }

case "$mode" in
  apply-reverse)
    # Reverse-apply the patch (revert that hunk/file). --recount tolerates small line drift.
    if git apply -R --recount "$tmp" 2>/dev/null; then emit '{"ok":true}'; else emit '{"ok":false,"error":"could not revert (the file changed since this diff — refresh)"}'; fi
    ;;
  discard)
    target="$(cat "$tmp")"
    # Only delete a file git considers UNTRACKED inside this repo (never a tracked or out-of-tree path).
    case "$target" in ""|/*|*..*) emit '{"ok":false,"error":"bad path"}'; exit 0 ;; esac
    if git ls-files --others --exclude-standard -z 2>/dev/null | grep -qzxF -- "$target"; then
      rm -f -- "$target" 2>/dev/null && emit '{"ok":true}' || emit '{"ok":false,"error":"delete failed"}'
    else
      emit '{"ok":false,"error":"not an untracked file"}'
    fi
    ;;
  *) emit '{"ok":false,"error":"bad mode"}' ;;
esac
