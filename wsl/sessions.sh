#!/usr/bin/env bash
# Claudible — list the Claude Code conversations for the embedded session's project dir, as JSON.
# Each conversation is a <session-id>.jsonl under ~/.claude/projects/<encoded cwd>/. We emit
# [{id, mtime, preview, msgs}] sorted newest-first so the renderer can show a session switcher.
set -u
# Per-workspace cwd (mirrors session.sh): list conversations for the SELECTED workspace's dir.
# Unset / bad slug → the original single session dir. Slug is a strict [A-Za-z0-9-] leaf.
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
[ -n "${CLAUDIBLE_WS_DIR:-}" ] && SDIR="$CLAUDIBLE_WS_DIR"   # custom save-location override
# Same encoding Claude uses: every non-alphanumeric char in the cwd path → '-'.
PROJ="$HOME/.claude/projects/${CLAUDIBLE_PROJ:-$(printf '%s' "$SDIR" | sed 's#[^A-Za-z0-9]#-#g')}"
# Sessions-sync worktree (repo workspaces only): lets us flag sessions a collaborator deleted on GitHub.
WT=""
[ "$WS_KIND" = "repo" ] && [ -n "$WS_SLUG" ] && WT="$HOME/.claudible/sessions-sync/$WS_SLUG"

node "$(dirname "$0")/sessions-tool.js" "$PROJ" "$WT" 2>/dev/null || printf '[]'
