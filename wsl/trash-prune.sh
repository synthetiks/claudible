#!/usr/bin/env bash
# Claudible — bound ~/.claudible/trash. Deleting a session moves its transcript here; deleting a PROJECT moves the
# entire folder here (an adopted repo, node_modules, build artifacts). Nothing in the app ever listed, restored, or
# emptied it, so it grew forever. This prunes it on launch:
#   * anything older than MAX_AGE_DAYS goes (the "recoverable" window the UI promises)
#   * if it's still over MAX_MB, oldest entries go until it's under
# Emits one JSON line. Read-mostly: it never touches anything outside the trash directory.
#
# This is the only `rm -rf` in the codebase, so every guard is explicit and none of them are clever:
#   1. The path must literally end in /.claudible/trash, AFTER symlink resolution.
#   2. Only DIRECT children are ever removed — never a recursive find, never a glob that could escape.
#   3. A child that is a symlink is unlinked, never followed (so a symlink to $HOME can't be recursed into).
#   4. Every deletion is by exact path from `find -mindepth 1 -maxdepth 1 -print0` — no word splitting, no globbing.
# Args: none. Env: CLAUDIBLE_TRASH_MAX_AGE_DAYS, CLAUDIBLE_TRASH_MAX_MB (both optional, for the test),
# CLAUDIBLE_TRASH_EMPTY_ALL (C-3.6's "Delete trash" settings button — skip the age/size floor, remove everything
# now; the renderer already confirmed this via the modal, stating it is permanent).
set -u

MAX_AGE_DAYS="${CLAUDIBLE_TRASH_MAX_AGE_DAYS:-30}"
MAX_MB="${CLAUDIBLE_TRASH_MAX_MB:-2048}"
EMPTY_ALL="${CLAUDIBLE_TRASH_EMPTY_ALL:-}"
case "$MAX_AGE_DAYS" in ''|*[!0-9]*) MAX_AGE_DAYS=30 ;; esac
case "$MAX_MB"       in ''|*[!0-9]*) MAX_MB=2048 ;; esac

TRASH="$HOME/.claudible/trash"
[ -d "$TRASH" ] || { printf '{"ok":true,"removed":0,"note":"no trash directory"}'; exit 0; }

# GUARD 1 — resolve symlinks, then require the canonical path to be exactly a .claudible/trash leaf. If `cd`+`pwd -P`
# can't confirm that, we do nothing at all. (A caller can't point this at another directory by faking $HOME either:
# the suffix check is on the RESOLVED path.)
REAL="$(cd "$TRASH" 2>/dev/null && pwd -P)" || { printf '{"ok":false,"error":"cannot resolve trash"}'; exit 0; }
case "$REAL" in
  */.claudible/trash) ;;
  *) printf '{"ok":false,"error":"refusing to prune a path that is not .claudible/trash"}'; exit 0 ;;
esac

kb_of() { du -sk "$1" 2>/dev/null | awk '{print $1}'; }   # a directory's size in KiB

removed=0
freed_kb=0

# Remove one direct child, by exact path. Symlinks are unlinked, never followed.
zap() {
  local p="$1" sz
  case "$p" in "$REAL"/*) ;; *) return 0 ;; esac        # GUARD 2 (again, per-entry): must be inside the trash
  case "$p" in *"/.."*) return 0 ;; esac                 # paranoia: no traversal components
  if [ -L "$p" ]; then rm -f -- "$p" 2>/dev/null && removed=$((removed+1)); return 0; fi   # GUARD 3
  sz="$(kb_of "$p")"; [ -n "$sz" ] || sz=0
  if rm -rf -- "$p" 2>/dev/null; then removed=$((removed+1)); freed_kb=$((freed_kb + sz)); fi
}

if [ -n "$EMPTY_ALL" ]; then
  # --- "Delete trash": every direct child, right now, age/size irrelevant. Same zap() guards as passes 1+2
  # below (must live under $REAL, symlinks unlinked never followed) — this only removes the floor, not the safety.
  while IFS= read -r -d '' p; do zap "$p"; done < <(find "$REAL" -mindepth 1 -maxdepth 1 -print0 2>/dev/null)
else
  # --- pass 1: age -------------------------------------------------------------------------------------------
  while IFS= read -r -d '' p; do zap "$p"; done < <(find "$REAL" -mindepth 1 -maxdepth 1 -mtime "+$MAX_AGE_DAYS" -print0 2>/dev/null)

  # --- pass 2: size cap. Oldest first, until under MAX_MB. ----------------------------------------------------
  # `ls -1dtr` sorts oldest-last→first and exists on GNU *and* BSD (`find -printf` is GNU-only and would silently
  # no-op the whole cap on macOS). A path containing a newline would split into two lines here — both then fail
  # zap()'s "must live under $REAL" guard, so it degrades to skipping that entry, never to deleting the wrong one.
  # (Our own delete-session.sh / delete-workspace.sh only ever write `<sanitized-id-or-label>.<timestamp>` names
  # anyway — delete-workspace.sh's label_clean strips whitespace/newlines the same way the id sanitizers do.)
  total_kb="$(kb_of "$REAL")"; [ -n "$total_kb" ] || total_kb=0
  cap_kb=$((MAX_MB * 1024))
  if [ "$total_kb" -gt "$cap_kb" ]; then
    oldest_first="$(find "$REAL" -mindepth 1 -maxdepth 1 -print0 2>/dev/null | xargs -0 -r ls -1dtr 2>/dev/null)"
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      [ "$total_kb" -gt "$cap_kb" ] || break
      sz="$(kb_of "$p")"; [ -n "$sz" ] || sz=0
      zap "$p"
      total_kb=$((total_kb - sz))
    done <<EOF
$oldest_first
EOF
  fi
fi

remaining_kb="$(kb_of "$REAL")"; [ -n "$remaining_kb" ] || remaining_kb=0
printf '{"ok":true,"removed":%d,"freedKb":%d,"remainingKb":%d,"maxAgeDays":%d,"maxMb":%d}' \
  "$removed" "$freed_kb" "$remaining_kb" "$MAX_AGE_DAYS" "$MAX_MB"
