#!/usr/bin/env bash
# Claudible — list the Claude Code conversations for the embedded session's project dir, as JSON.
# Each conversation is a <session-id>.jsonl under ~/.claude/projects/<encoded cwd>/. We emit
# [{id, mtime, preview, msgs}] sorted newest-first so the renderer can show a session switcher.
set -u
SDIR="$HOME/.claudible/session"
# Same encoding Claude uses: every non-alphanumeric char in the cwd path → '-'.
PROJ="$HOME/.claude/projects/$(printf '%s' "$SDIR" | sed 's#[^A-Za-z0-9]#-#g')"

python3 - "$PROJ" <<'PY' 2>/dev/null || printf '[]'
import sys, os, json, glob
proj = sys.argv[1]
out = []
for f in glob.glob(os.path.join(proj, "*.jsonl")):
    sid = os.path.basename(f)[:-6]
    try: mtime = int(os.path.getmtime(f))
    except Exception: mtime = 0
    preview, msgs = "", 0
    try:
        with open(f, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try: o = json.loads(line)
                except Exception: continue
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
    out.append({"id": sid, "mtime": mtime, "preview": preview or "(empty session)", "msgs": msgs})
out.sort(key=lambda x: x["mtime"], reverse=True)
print(json.dumps(out))
PY
