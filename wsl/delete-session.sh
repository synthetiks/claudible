#!/usr/bin/env bash
# Claudible — SOFT-delete a Claude conversation: move <id>.jsonl into ~/.claudible/trash/ so it's
# recoverable, not erased. Arg $1 = session id. Refuses anything outside the id charset.
# Emits {"ok":true} / {"ok":false,"error":...} for the renderer.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"                   # ABSOLUTE script dir, resolved BEFORE any cd into the workspace
id="${1:-}"
case "$id" in
  '' | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad id"}'; exit 0 ;;   # strict allowlist
esac
# Same project-dir derivation as sessions.sh, scoped to the SELECTED workspace's cwd.
# Unset / bad slug → the original single session dir. Slug is a strict [A-Za-z0-9-] leaf.
. "$HERE/_ws-dir.sh"                                    # defines WS_KIND / WS_SLUG / SDIR — the one workspace-dir resolution
PROJ="$HOME/.claude/projects/${CLAUDIBLE_PROJ:-$(printf '%s' "$SDIR" | sed 's#[^A-Za-z0-9]#-#g')}"
src="$PROJ/$id.jsonl"
[ -f "$src" ] || { printf '{"ok":false,"error":"not found"}'; exit 0; }
# Sync-awareness only (this is a REPO workspace's shared-session sync worktree, never the workspace's
# own .git — soft-delete already keeps the transcript recoverable, so this is not the dirty-repo check above).
# If sync is on for this workspace and no synced copy of this session exists yet, deleting now would delete
# the ONLY copy anywhere. Default refuses; CLAUDIBLE_FORCE_DELETE=1 (the renderer's explicit re-confirm) skips it.
if [ "${CLAUDIBLE_FORCE_DELETE:-}" != 1 ] && [ -n "${WS_SLUG:-}" ] && [ -d "$HOME/.claudible/sessions-sync/$WS_SLUG" ]; then
  synced=""
  for f in "$HOME/.claudible/sessions-sync/$WS_SLUG"/sessions/*/"$id.jsonl"; do
    [ -e "$f" ] && { synced=1; break; }
  done
  if [ -z "$synced" ]; then
    printf '{"ok":false,"needsForce":true,"error":"this conversation has not synced to GitHub yet — sync first, or confirm delete anyway"}'
    exit 0
  fi
fi
# Delete pre-flight: the renderer must know whether this delete WOULD be refused BEFORE it re-points the tabs
# holding this session and ends a live share on it — none of which is undoable, so a refusal discovered after
# them is no refusal at all. CHECK_ONLY answers with the same shape as a real run (the needsForce branch above
# has already exited if it applies) and stops here: nothing is moved, nothing is written, no marker is touched.
if [ "${CLAUDIBLE_CHECK_ONLY:-}" = 1 ]; then printf '{"ok":true,"needsForce":false,"check":true}'; exit 0; fi
trash="$HOME/.claudible/trash"
mkdir -p "$trash" 2>/dev/null
ts="$(date +%Y%m%d-%H%M%S)"
if mv -f "$src" "$trash/$id.$ts.jsonl" 2>/dev/null; then
  # drop any "kept"/"diverged" flags for this id so a future same-id session can't inherit a stale badge
  for sc in "$PROJ/.claudible-kept" "$PROJ/.claudible-diverged"; do
    [ -e "$sc" ] && { { grep -vxF -- "$id" "$sc" 2>/dev/null || true; } > "$sc.tmp"; mv -f "$sc.tmp" "$sc" 2>/dev/null; }
  done
  # LOCAL delete marker ("id size-at-delete", one line each, per machine — never synced): on a sync-enabled
  # workspace the shared branch still holds a copy of this transcript (a local-scope delete doesn't propagate
  # removals), so without this the very next pull re-imported it — "deleted sessions come back". Sync's import
  # skips a marked id unless the remote copy has GROWN past this size (a collaborator kept the session going —
  # real new activity SHOULD return, and returning clears the marker).
  sz="$(wc -c < "$trash/$id.$ts.jsonl" 2>/dev/null || echo 0)"
  dl="$PROJ/.claudible-deleted"
  { grep -v "^$id " "$dl" 2>/dev/null || true; } > "$dl.tmp.$$"   # PID-unique (R24): sessions-sync.sh rewrites this same file from its own process
  printf '%s %s\n' "$id" "$sz" >> "$dl.tmp.$$"
  mv -f "$dl.tmp.$$" "$dl" 2>/dev/null
  printf '{"ok":true}'
else
  printf '{"ok":false,"error":"move failed"}'
fi
