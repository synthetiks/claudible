#!/usr/bin/env bash
# Claudible — soft-delete a workspace's folder (move to ~/.claudible/trash, recoverable). Args: $1=kind, $2=slug,
# $3=label (optional, the human project name shown in the UI — see main.js's workspace:delete, shq-escaped).
# For a repo workspace this only removes the LOCAL clone — the GitHub repo is left intact. Never the legacy dir.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"                   # ABSOLUTE script dir, resolved BEFORE any cd into the workspace
. "$HERE/_git-safe.sh"                                   # CASE-13: git now runs against $dir below — neutralize its config first
kind="${1:-}"
slug="${2:-}"
label="${3:-}"
case "$slug" in '' | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad slug"}'; exit 0 ;; esac
case "$kind" in
  local) dir="$HOME/.claudible/workspaces/$slug" ;;
  repo)  dir="$HOME/.claudible/repos/$slug" ;;
  *) printf '{"ok":false,"error":"bad kind"}'; exit 0 ;;
esac
# Custom-save-location workspaces store their real folder in CLAUDIBLE_WS_DIR (emitted by wsEnv); prefer it so we
# trash the actual directory rather than the default-location guess above (mirrors the other SDIR-aware scripts).
[ -n "${CLAUDIBLE_WS_DIR:-}" ] && dir="$CLAUDIBLE_WS_DIR"
[ -d "$dir" ] || { printf '{"ok":true,"note":"already gone"}'; exit 0; }
trash="$HOME/.claudible/trash"; mkdir -p "$trash" 2>/dev/null
ts="$(date +%Y%m%d-%H%M%S)"
# Owners' note: a trash entry used to be named ws-<kind>-<slug> — the internal, url-safe slug, not what the user
# ever saw in the UI ("ws-local-e-2-e-overlay-proj" for a project titled "E2E Overlay Proj"). Sanitize the human
# LABEL into a filesystem-safe name instead: collapse whitespace, replace anything unsafe for a path component
# with '-' (this is also what keeps a stray '/' from turning into a subdirectory — same class of guard trash-
# prune.sh's zap() relies on), and cap the length so a very long project name can't produce an unwieldy path.
# Uniqueness still comes from the same $ts suffix every entry already carried — the label is cosmetic, not the key.
label_clean="$(printf '%s' "$label" | tr -s ' \t\n' ' ' | sed "s/[^A-Za-z0-9 ._-]/-/g; s/^ *//; s/ *\$//" | cut -c1-60)"
[ -n "$label_clean" ] || label_clean="$slug"   # no label passed (older caller) or it sanitized to nothing → fall back to the slug, never to a blank name
# The workspace's WHOLE footprint goes to trash, not just the code dir — the other two pieces used to leak
# forever outside any managed lifecycle (trash-prune's age/size bounds now apply to all three):
#  * the Claude-Code shadow dir (~/.claude/projects/<encoded SDIR>) holding every transcript + the
#    .claudible-* sidecars — a later workspace re-created at the same path silently inherited the dead
#    project's sessions, and discovery's per-machine tombstones pointed at data that never left;
#  * (repo) the sessions-sync worktree (~/.claudible/sessions-sync/<slug>) — orphaned with a broken gitdir
#    link once the code dir moved, still holding every collaborator's exported transcripts.
# Encoding matches sessions.sh/session.sh exactly; CLAUDIBLE_PROJ overrides on win-native (same contract).
proj="$HOME/.claude/projects/${CLAUDIBLE_PROJ:-$(printf '%s' "$dir" | sed 's#[^A-Za-z0-9]#-#g')}"
# CASE-13: REFUSE-with-explicit-override — a repo workspace with uncommitted changes or commits never pushed
# to its upstream is work that only lives in this folder. Default refuses; the renderer's second, explicit
# "delete anyway" confirm re-calls with CLAUDIBLE_FORCE_DELETE=1, which is the only thing that skips this.
if [ -d "$dir/.git" ] && [ "${CLAUDIBLE_FORCE_DELETE:-}" != 1 ]; then
  u=$(git -C "$dir" status --porcelain 2>/dev/null | grep -c .)
  a=$(git -C "$dir" rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)
  case "$u" in ''|*[!0-9]*) u=0 ;; esac
  case "$a" in ''|*[!0-9]*) a=0 ;; esac
  if [ "$u" -gt 0 ] || [ "$a" -gt 0 ]; then
    printf '{"ok":false,"needsForce":true,"uncommitted":%s,"unpushed":%s,"error":"this project has work not on GitHub — push it first, or confirm delete anyway"}' "$u" "$a"
    exit 0
  fi
fi
if mv -f "$dir" "$trash/ws-$kind-$label_clean.$ts" 2>/dev/null; then
  [ -d "$proj" ] && mv -f "$proj" "$trash/proj-$kind-$label_clean.$ts" 2>/dev/null
  if [ "$kind" = "repo" ] && [ -d "$HOME/.claudible/sessions-sync/$slug" ]; then
    mv -f "$HOME/.claudible/sessions-sync/$slug" "$trash/syncwt-$label_clean.$ts" 2>/dev/null
  fi
  printf '{"ok":true}'
else
  printf '{"ok":false,"error":"move failed"}'
fi
