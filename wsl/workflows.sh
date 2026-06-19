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
SID="${1:-}"
case "$SID" in '' | *[!A-Za-z0-9-]*) printf '[]'; exit 0 ;; esac      # need a clean session id
PROJ="$HOME/.claude/projects/$(printf '%s' "$SDIR" | sed 's#[^A-Za-z0-9]#-#g')"
WF_ROOT="$PROJ/$SID/subagents/workflows"
[ -d "$WF_ROOT" ] || { printf '[]'; exit 0; }

python3 - "$WF_ROOT" <<'PY' 2>/dev/null || printf '[]'
import sys, os, json, glob, time, datetime
root = sys.argv[1]
now = time.time()
RECENT = 900   # prune any workflow with no file activity within this window (15 min)
STALE = 180    # an agent with no 'result' whose transcript hasn't been written in this long = ended, not running

def head_info(f):
    """Cheaply read only the head of an agent transcript: its first prompt (label) + first timestamp (start)."""
    start = None; label = ''
    try:
        with open(f, encoding='utf-8') as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try: o = json.loads(line)
                except Exception: continue
                if start is None and o.get('timestamp'):
                    try: start = datetime.datetime.fromisoformat(o['timestamp'].replace('Z', '+00:00')).timestamp()
                    except Exception: pass
                if o.get('type') == 'user' and isinstance(o.get('message'), dict):
                    c = o['message'].get('content')
                    if isinstance(c, list):
                        txt = ' '.join(x.get('text', '') for x in c if isinstance(x, dict) and x.get('type') == 'text')
                    else:
                        txt = c if isinstance(c, str) else ''
                    txt = (txt or '').strip()
                    if txt and not txt.startswith('<'):
                        label = ' '.join(txt.split())[:90]
                        break
    except Exception:
        pass
    return label, start

out = []
wfs = sorted(glob.glob(os.path.join(root, 'wf_*')),
             key=lambda p: (os.path.getmtime(p) if os.path.exists(p) else 0), reverse=True)
for wf in wfs[:6]:
    jpath = os.path.join(wf, 'journal.jsonl')
    seen = []; done = set()
    try:
        with open(jpath, encoding='utf-8') as fh:
            for line in fh:
                line = line.strip()
                if not line: continue
                try: o = json.loads(line)
                except Exception: continue
                aid = o.get('agentId')
                if not aid: continue
                if aid not in seen: seen.append(aid)
                if o.get('type') == 'result': done.add(aid)
    except Exception:
        pass
    agents = []
    for aid in seen:
        af = os.path.join(wf, 'agent-%s.jsonl' % aid)
        label, start = head_info(af) if os.path.exists(af) else ('', None)
        last = None
        try: last = int(os.path.getmtime(af))
        except Exception: pass
        # RUNNING only if it has no 'result' AND its transcript was written recently — a swarm killed
        # before writing results would otherwise look 'running' forever (the phantom/flashing bug).
        is_running = (aid not in done) and (last is not None) and ((now - last) <= STALE)
        agents.append({'id': aid[:9], 'label': label or 'agent',
                       'status': 'running' if is_running else 'done',
                       'start': int(start) if start else None, 'last': last})
    if not agents:
        continue
    running = sum(1 for a in agents if a['status'] == 'running')
    # liveness = newest of journal + every agent file (the dir mtime is frozen at creation, so it can't
    # gauge activity). Prune anything stale REGARDLESS of a lingering 'running' flag (no escape hatch).
    acts = [a['last'] for a in agents if a.get('last')]
    try: acts.append(int(os.path.getmtime(jpath)))
    except Exception: pass
    activity = max(acts) if acts else 0
    if (now - activity) > RECENT:
        continue
    out.append({'wf': os.path.basename(wf), 'mtime': activity,
                'total': len(agents), 'done': sum(1 for a in agents if a['status'] != 'running'),
                'running': running, 'agents': agents})
print(json.dumps(out))
PY
