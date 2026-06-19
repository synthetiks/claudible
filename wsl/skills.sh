#!/usr/bin/env bash
# Claudible — list Claude Code SKILLS (user + active-workspace project scope) and toggle their visibility.
# Skills have no scriptable CLI, so we scan SKILL.md frontmatter directly (mirrors Claude's discovery) and
# read/write skillOverrides in the workspace's .claude/settings.local.json.
# Args: $1 = op (list|set); for set: $2 = skill name, $3 = state (on|off|name-only|user-invocable-only).
# cwd derived from CLAUDIBLE_WS_KIND/CLAUDIBLE_WS_SLUG like the other scripts. Emits JSON.
set -u

WS_KIND="${CLAUDIBLE_WS_KIND:-legacy}"
WS_SLUG="${CLAUDIBLE_WS_SLUG:-}"
case "$WS_SLUG" in *[!A-Za-z0-9-]*) WS_SLUG="" ;; esac
if [ "$WS_KIND" = "local" ] && [ -n "$WS_SLUG" ]; then SDIR="$HOME/.claudible/workspaces/$WS_SLUG"
elif [ "$WS_KIND" = "repo" ] && [ -n "$WS_SLUG" ]; then SDIR="$HOME/.claudible/repos/$WS_SLUG"
else SDIR="$HOME/.claudible/session"; fi

op="${1:-list}"
case "$op" in

  list)
    python3 - "$SDIR" <<'PY' 2>/dev/null || printf '[]'
import sys, os, json, glob, re
sdir = sys.argv[1]; home = os.path.expanduser("~")
def front(path):
    try: t = open(path, encoding="utf-8").read()
    except Exception: return {}
    if not t.startswith("---"): return {}
    end = t.find("\n---", 3)
    if end < 0: return {}
    out = {}
    for line in t[3:end].splitlines():
        m = re.match(r'\s*([A-Za-z0-9_-]+)\s*:\s*(.*)', line)
        if m: out[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return out
items, seen = [], set()
def scan(base, scope):
    for sk in sorted(glob.glob(os.path.join(base, "*", "SKILL.md"))):
        fm = front(sk); nm = fm.get("name") or os.path.basename(os.path.dirname(sk))
        if nm in seen: continue
        seen.add(nm)
        items.append({"name": nm, "scope": scope, "description": (fm.get("description") or "")[:240]})
scan(os.path.join(home, ".claude", "skills"), "user")
if sdir: scan(os.path.join(sdir, ".claude", "skills"), "project")
ov = {}
try: ov = (json.load(open(os.path.join(sdir, ".claude", "settings.local.json"))).get("skillOverrides") or {})
except Exception: pass
for it in items: it["state"] = ov.get(it["name"], "on")
print(json.dumps(items))
PY
    ;;

  set)
    name="${2:-}"; state="${3:-}"
    case "$name"  in '' | *[!A-Za-z0-9:/_.-]*) printf '{"ok":false,"error":"bad name"}';  exit 0 ;; esac
    case "$state" in on|off|name-only|user-invocable-only) ;; *) printf '{"ok":false,"error":"bad state"}'; exit 0 ;; esac
    python3 - "$SDIR" "$name" "$state" <<'PY' 2>/dev/null || printf '{"ok":false,"error":"write failed"}'
import sys, os, json
sdir, name, state = sys.argv[1], sys.argv[2], sys.argv[3]
d = os.path.join(sdir, ".claude"); os.makedirs(d, exist_ok=True)
p = os.path.join(d, "settings.local.json")
try: cfg = json.load(open(p))
except Exception: cfg = {}
if not isinstance(cfg, dict): cfg = {}
ov = cfg.get("skillOverrides") or {}
if state == "on": ov.pop(name, None)        # 'on' is the default → just clear any override
else: ov[name] = state
cfg["skillOverrides"] = ov
json.dump(cfg, open(p, "w"), indent=2)
print(json.dumps({"ok": True, "state": state}))
PY
    ;;

  *) printf '{"ok":false,"error":"bad op"}' ;;
esac
