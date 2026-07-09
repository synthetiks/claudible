#!/usr/bin/env bash
# Claudible — clone an EXISTING repo workspace you've been invited to, into ~/.claudible/repos/<slug>.
# Used by discovery (and lazily on first open) so a collaborator's workspace becomes usable locally.
# Args: $1 = owner (github login), $2 = slug (both strict [A-Za-z0-9-]); $3 = optional custom absolute WSL dir
# (already validated by main.js) — when omitted, clone into ~/.claudible/repos/<slug>. Emits one JSON line; on
# success it echoes the resolved "path" so main can record it (ws.path -> CLAUDIBLE_WS_DIR).
set -u
owner="${1:-}"
slug="${2:-}"
dir_in="${3:-}"
case "$owner" in '' | -* | *- | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad owner"}'; exit 0 ;; esac
case "$slug"  in '' | -* | *- | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad slug"}'; exit 0 ;; esac
# A `'` ends the single-quoted bash arg; a `"`, a `\` or a control byte breaks the JSON we printf below.
# Same charset as lib/pathSafe.js (main.js rejects it first) and as adopt-workspace.sh. Belt: workspaces.json is hand-editable.
case "$dir_in" in *\'* | *\"* | *\\* | *[[:cntrl:]]*) printf '{"ok":false,"error":"bad dir"}'; exit 0 ;; esac

if [ -n "$dir_in" ]; then dir="$dir_in"; else dir="$HOME/.claudible/repos/$slug"; fi
# Windows git-bash: the runner sets MSYS_NO_PATHCONV, so gh/git.exe read our path literally and turn the MSYS
# '/c/…' form into 'C:\c\…' — the clone lands in the wrong place and the recorded path never matches Claude's
# transcript store (missing sessions). Normalize to the mixed 'C:/…' form that git AND bash both accept, and
# RETURN that form so ws.path stays consistent everywhere. No-op on WSL/Posix (cygpath absent) or a C:/ dir.
if command -v cygpath >/dev/null 2>&1; then dir="$(cygpath -m "$dir" 2>/dev/null || printf '%s' "$dir")"; fi
if [ -d "$dir/.git" ]; then printf '{"ok":true,"already":true,"slug":"%s","path":"%s"}' "$slug" "$dir"; exit 0; fi   # already cloned
# NEVER rm -rf a directory we did not create. The rollback below exists to drop a HALF-DONE clone, but the only
# pre-clone check used to be "$dir/.git" — so a path that already held the user's own (non-git) files sailed
# straight through, `gh repo clone` failed on the non-empty target, and the rollback deleted their work.
# create-workspace.sh has always refused a pre-existing dir outright; this is the same guard, one step softer:
#   * a plain file, or a non-empty dir -> refuse, touch nothing
#   * exists but is an empty dir        -> clone into it, but remember NOT to remove it on failure
if [ -e "$dir" ] && { [ ! -d "$dir" ] || [ -n "$(find "$dir" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; }; then
  printf '{"ok":false,"error":"that folder already exists and is not empty — pick another location"}'; exit 0
fi
pre_existed=0; [ -e "$dir" ] && pre_existed=1
command -v gh >/dev/null 2>&1 || { printf '{"ok":false,"error":"the GitHub CLI (gh) is not installed in WSL"}'; exit 0; }
mkdir -p "$(dirname "$dir")" 2>/dev/null
if gh repo clone "$owner/$slug" "$dir" >/dev/null 2>&1; then
  printf '{"ok":true,"slug":"%s","owner":"%s","repoUrl":"https://github.com/%s/%s","path":"%s"}' "$slug" "$owner" "$owner" "$slug" "$dir"
else
  [ "$pre_existed" = 0 ] && rm -rf "$dir" 2>/dev/null   # only ever remove the dir this run created
  printf '{"ok":false,"error":"clone failed (check access to %s/%s)"}' "$owner" "$slug"
fi
