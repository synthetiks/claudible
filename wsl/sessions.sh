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
PROJ="$HOME/.claude/projects/$(printf '%s' "$SDIR" | sed 's#[^A-Za-z0-9]#-#g')"
# Sessions-sync worktree (repo workspaces only): lets us flag sessions a collaborator deleted on GitHub.
WT=""
[ "$WS_KIND" = "repo" ] && [ -n "$WS_SLUG" ] && WT="$HOME/.claudible/sessions-sync/$WS_SLUG"

python3 - "$PROJ" "$WT" <<'PY' 2>/dev/null || printf '[]'
import sys, os, json, glob, datetime
proj = sys.argv[1]
wt = sys.argv[2] if len(sys.argv) > 2 else ""

def read_ids(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return set(x.strip() for x in fh if x.strip())
    except Exception:
        return set()

# A session deleted "everywhere" by a collaborator leaves a tombstone on the branch but we KEEP the local copy
# and flag it; .claudible-kept is the user's "keep locally" acknowledgement; .claudible-diverged is a true fork.
tombs = set()
if wt:
    try: tombs = set(os.listdir(os.path.join(wt, "sessions", ".tombstones")))
    except Exception: tombs = set()
kept = read_ids(os.path.join(proj, ".claudible-kept"))
diverged = read_ids(os.path.join(proj, ".claudible-diverged"))

def parse_ts(s):                                  # ISO timestamp from the transcript -> epoch (identical on every machine)
    try: return int(datetime.datetime.fromisoformat(s.strip().replace("Z", "+00:00")).timestamp())
    except Exception: return 0

out = []
for f in glob.glob(os.path.join(proj, "*.jsonl")):
    sid = os.path.basename(f)[:-6]
    try: mtime = int(os.path.getmtime(f))
    except Exception: mtime = 0
    preview, msgs, created = "", 0, 0
    try:
        with open(f, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try: o = json.loads(line)
                except Exception: continue
                if not created:
                    ts = o.get("timestamp")
                    if isinstance(ts, str): created = parse_ts(ts)
                if o.get("type") == "user" and isinstance(o.get("message"), dict):
                    c = o["message"].get("content")
                    if isinstance(c, list):
                        t = " ".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text")
                    else:
                        t = c if isinstance(c, str) else ""
                    t = (t or "").strip()
                    # skip tool-result/system-ish turns; we want a human-readable first prompt
                    if t and not t.startswith("<") and not t.startswith("Caveat"):
                        msgs += 1
                        if not preview:
                            preview = " ".join(t.split())[:90]
    except Exception:
        pass
    rec = {"id": sid, "mtime": mtime, "created": created or mtime, "preview": preview or "(empty session)", "msgs": msgs}
    if sid in tombs and sid not in kept: rec["deletedRemote"] = True
    if sid in diverged: rec["diverged"] = True
    out.append(rec)
out.sort(key=lambda x: x.get("created") or x["mtime"], reverse=True)   # shared, machine-independent order
print(json.dumps(out))
PY
