#!/usr/bin/env bash
# Claudible — list the Claude Code conversations for the embedded session's project dir, as JSON.
# Each conversation is a <session-id>.jsonl under ~/.claude/projects/<encoded cwd>/. We emit
# [{id, mtime, preview, msgs}] sorted newest-first so the renderer can show a session switcher.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"                   # ABSOLUTE script dir, resolved BEFORE any cd into the workspace
. "$HERE/node-path.sh" 2>/dev/null || true   # nvm's node isn't on PATH for non-interactive shells → ensure it is, or this returns []
# Per-workspace cwd (mirrors session.sh): list conversations for the SELECTED workspace's dir.
# Unset / bad slug → the original single session dir. Slug is a strict [A-Za-z0-9-] leaf.
. "$HERE/_ws-dir.sh"                                    # defines WS_KIND / WS_SLUG / SDIR — the one workspace-dir resolution
# Same encoding Claude uses: every non-alphanumeric char in the cwd path → '-'.
PROJ="$HOME/.claude/projects/${CLAUDIBLE_PROJ:-$(printf '%s' "$SDIR" | sed 's#[^A-Za-z0-9]#-#g')}"
# Sessions-sync worktree (repo workspaces only): lets us flag sessions a collaborator deleted on GitHub.
WT=""
[ "$WS_KIND" = "repo" ] && [ -n "$WS_SLUG" ] && WT="$HOME/.claudible/sessions-sync/$WS_SLUG"

unset MSYS_NO_PATHCONV  # win-native: runner sets MSYS_NO_PATHCONV, so git-bash wont convert the /c/.. path(s) below to a Windows path for node.exe; clear it here (no-op on WSL/Posix)
node "$HERE/sessions-tool.js" --with-authors "$PROJ" "$WT" 2>/dev/null || printf "[]"   # --with-authors: stamp foreign sessions with their creator (parity tests run the tool WITHOUT the flag)
