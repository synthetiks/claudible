#!/usr/bin/env bash
# Claudible — tag an existing GitHub repo as a Claudible workspace (the `claudible-workspace` topic), so OTHER
# collaborators' discovery finds it. create-workspace.sh tags at creation, but imported repos (workspace:import)
# never got the tag — an imported repo stayed invisible to every other machine's discovery forever, and inviting
# a collaborator on GitHub changed nothing (discovery filters on the topic, not on access). Best-effort by
# design: topic editing needs admin on the repo; when the importer lacks it we stay silent — the marker-file
# fallback and a later tag by the owner both still work. No clone, no commit, nothing local: one metadata call.
# Args: $1 = owner (strict [A-Za-z0-9-]); $2 = repo (GitHub's own charset — see clone-workspace.sh's C-3.4 note).
# Emits one JSON line: {ok:true,tagged:true|false} | {ok:false,error}
set -u
owner="${1:-}"
repo="${2:-}"
case "$owner" in '' | -* | *- | *[!A-Za-z0-9-]*) printf '{"ok":false,"error":"bad owner"}'; exit 0 ;; esac
case "$repo" in '' | . | .. | *[!A-Za-z0-9._-]*) printf '{"ok":false,"error":"bad repo name"}'; exit 0 ;; esac
if gh repo edit "$owner/$repo" --add-topic claudible-workspace >/dev/null 2>&1; then
  printf '{"ok":true,"tagged":true}'
else
  printf '{"ok":true,"tagged":false}'
fi
