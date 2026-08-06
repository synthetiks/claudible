#!/usr/bin/env bash
# Claudible — apply a Diff Review action in a workspace's git repo. Resolves the SAME cwd as diff.sh.
# All user/repo-controlled data is read from an APP-CONTROLLED temp file ($2), never inlined into the
# command, so repo paths/patch text can't break the shell. Emits one JSON line.
#   $1 = mode: 'apply-reverse' (revert a hunk/file patch) | 'discard' (move an untracked file to the trash)
#   $2 = path to a temp file: the unified patch (apply-reverse) OR the target path (discard)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"                   # ABSOLUTE script dir, resolved BEFORE any cd into the workspace
. "$HERE/_git-safe.sh"   # a hostile .git/config (adopted repo) can run commands via git — neutralize before `git apply`
emit() { printf '%s\n' "$1"; }
mode="${1:-}"; tmp="${2:-}"
[ -n "$tmp" ] && [ -f "$tmp" ] || { emit '{"ok":false,"error":"bad args"}'; exit 0; }
. "$HERE/_ws-dir.sh"                                    # defines WS_KIND / WS_SLUG / SDIR — the one workspace-dir resolution
cd "$SDIR" 2>/dev/null || { emit '{"ok":false,"error":"no workspace"}'; exit 0; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { emit '{"ok":false,"error":"not a git repo"}'; exit 0; }

case "$mode" in
  apply-reverse)
    # Reverse-apply the patch (revert that hunk/file). --recount tolerates small line drift.
    if git apply -R --recount "$tmp" 2>/dev/null; then emit '{"ok":true}'; else emit '{"ok":false,"error":"could not revert (the file changed since this diff — refresh)"}'; fi
    ;;
  discard)
    target="$(cat "$tmp")"
    # Only move a file git considers UNTRACKED inside this repo (never a tracked or out-of-tree path).
    case "$target" in ""|/*|*..*) emit '{"ok":false,"error":"bad path"}'; exit 0 ;; esac
    if git ls-files --others --exclude-standard -z 2>/dev/null | grep -qzxF -- "$target"; then
      # C-8.3: a "brand-new" file is still real work — route it through the same recoverable Claudible
      # trash every other delete uses (delete-workspace.sh/delete-session.sh's own convention) instead of
      # rm -f'ing it into oblivion. trash-prune.sh's 30-day/2GB sweep bounds it from here on, same as
      # everything else in the trash.
      trashdir="$HOME/.claudible/trash/discarded-files"; mkdir -p "$trashdir" 2>/dev/null
      base="$(basename -- "$target")"
      ts="$(date +%Y%m%d-%H%M%S)"
      dest="$trashdir/$ts-$$-$base"   # pid-suffixed: two discards of same-named files in the same second must not clobber each other in trash
      if mv -f -- "$target" "$dest" 2>/dev/null; then emit '{"ok":true}'; else emit '{"ok":false,"error":"could not move to trash"}'; fi
    else
      emit '{"ok":false,"error":"not an untracked file"}'
    fi
    ;;
  *) emit '{"ok":false,"error":"bad mode"}' ;;
esac
