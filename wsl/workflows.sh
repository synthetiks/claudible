#!/usr/bin/env bash
# Claudible — emit LIVE workflow/swarm agent state for one session as JSON, for the Agents tab.
# Workflow agents (the Workflow tool / agent swarms) do NOT fire Task hooks, so the hook-fed Agents
# view never sees them. They DO write per-agent files under the session's subagents dir, which we read
# here (WSL side — these live in ~/.claude, off the Windows FS) and hand back to the renderer.
#
#   ~/.claude/projects/<encoded cwd>/<session-id>/subagents/workflows/wf_<id>/
#       journal.jsonl        — {type:'started'|'result', agentId, ...}  (status per agent)
#       agent-<agentId>.jsonl — that agent's transcript (first user msg = its prompt → our label)
#
# Output: JSON array of recent/active workflows, each { wf, mtime, total, done, running, agents:[…] }.
# $1 = session id (sanitized). Workspace cwd comes from CLAUDIBLE_WS_* (mirrors sessions.sh).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"                   # ABSOLUTE script dir, resolved BEFORE any cd into the workspace
. "$HERE/node-path.sh" 2>/dev/null || true              # nvm's node isn't on PATH for non-interactive shells → resolve it
. "$HERE/_ws-dir.sh"                                    # defines WS_KIND / WS_SLUG / SDIR — the one workspace-dir resolution
SID="${1:-}"
case "$SID" in '' | *[!A-Za-z0-9-]*) printf '[]'; exit 0 ;; esac      # need a clean session id
PROJ="$HOME/.claude/projects/${CLAUDIBLE_PROJ:-$(printf '%s' "$SDIR" | sed 's#[^A-Za-z0-9]#-#g')}"
WF_ROOT="$PROJ/$SID/subagents/workflows"
[ -d "$WF_ROOT" ] || { printf '[]'; exit 0; }

unset MSYS_NO_PATHCONV  # win-native: runner sets MSYS_NO_PATHCONV, so git-bash wont convert the /c/.. path(s) below to a Windows path for node.exe; clear it here (no-op on WSL/Posix)
node "$(dirname "$0")/workflows-tool.js" --with-model "$WF_ROOT" 2>/dev/null || printf "[]"   # --with-model: per-agent model for the Agents tab (parity tests run the tool WITHOUT the flag)
