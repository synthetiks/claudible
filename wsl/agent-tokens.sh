#!/usr/bin/env bash
# Claudible — sum the tokens a session's SUBAGENTS/swarm agents consumed. The main statusLine meter only
# reports the main thread's usage, so big agent runs are invisible there. We count each agent turn's
# output_tokens + cache_creation_input_tokens (the agents' genuinely-NEW work); raw input_tokens re-counts
# the resent context every turn and cache_read_input_tokens is re-reads, so both are excluded.
# $1 = session id. Workspace cwd from CLAUDIBLE_WS_* (mirrors the other scripts). Prints one integer.
set -u
WS_KIND="${CLAUDIBLE_WS_KIND:-legacy}"
WS_SLUG="${CLAUDIBLE_WS_SLUG:-}"
case "$WS_SLUG" in *[!A-Za-z0-9-]*) WS_SLUG="" ;; esac
if [ "$WS_KIND" = "local" ] && [ -n "$WS_SLUG" ]; then SDIR="$HOME/.claudible/workspaces/$WS_SLUG"
elif [ "$WS_KIND" = "repo" ] && [ -n "$WS_SLUG" ]; then SDIR="$HOME/.claudible/repos/$WS_SLUG"
else SDIR="$HOME/.claudible/session"; fi
[ -n "${CLAUDIBLE_WS_DIR:-}" ] && SDIR="$CLAUDIBLE_WS_DIR"

SID="${1:-}"
case "$SID" in '' | *[!A-Za-z0-9-]*) printf '0'; exit 0 ;; esac
PROJ="$HOME/.claude/projects/$(printf '%s' "$SDIR" | sed 's#[^A-Za-z0-9]#-#g')"
SA="$PROJ/$SID/subagents"
[ -d "$SA" ] || { printf '0'; exit 0; }

python3 - "$SA" <<'PY' 2>/dev/null || printf '0'
import sys, os, glob, json
d = sys.argv[1]; tot = 0
for f in glob.glob(os.path.join(d, '**', '*.jsonl'), recursive=True):
    try:
        for line in open(f, encoding='utf-8', errors='ignore'):
            try: o = json.loads(line)
            except Exception: continue
            u = (o.get('message') or {}).get('usage') or {}
            tot += (u.get('output_tokens', 0) or 0) + (u.get('cache_creation_input_tokens', 0) or 0)
    except Exception:
        pass
print(tot)
PY
