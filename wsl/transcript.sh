#!/usr/bin/env bash
# Claudible — read ONE Claude conversation's transcript as JSON messages, for the read-only guest browser.
# This NEVER resumes/executes anything — it only renders saved text — so a foreign transcript is safe here
# (unlike --resume, which would let its contents drive tools). Arg $1 = session id (strict [A-Za-z0-9-]).
# Resolves the SAME per-workspace project dir as sessions.sh. Emits [{role:'you'|'claude',text}] oldest-first,
# capping message count + per-message length so a huge transcript can't blow up the payload.
set -u
id="${1:-}"
case "$id" in '' | *[!A-Za-z0-9-]*) printf '[]'; exit 0 ;; esac
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
[ -n "${CLAUDIBLE_WS_DIR:-}" ] && SDIR="$CLAUDIBLE_WS_DIR"
# Same encoding Claude uses: every non-alphanumeric char in the cwd path → '-'.
PROJ="$HOME/.claude/projects/$(printf '%s' "$SDIR" | sed 's#[^A-Za-z0-9]#-#g')"
f="$PROJ/$id.jsonl"
[ -f "$f" ] || { printf '[]'; exit 0; }

python3 - "$f" <<'PY' 2>/dev/null || printf '[]'
import sys, json
f = sys.argv[1]
MAX_MSGS = 500          # keep the most recent N turns
MAX_LEN  = 6000         # cap each message so one giant turn can't bloat the payload
def textof(content):
    if isinstance(content, list):
        return " ".join(x.get("text", "") for x in content if isinstance(x, dict) and x.get("type") == "text").strip()
    if isinstance(content, str):
        return content.strip()
    return ""
out = []
try:
    with open(f, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try: o = json.loads(line)
            except Exception: continue
            typ = o.get("type")
            if typ not in ("user", "assistant"): continue
            msg = o.get("message")
            if not isinstance(msg, dict): continue
            t = textof(msg.get("content"))
            if not t: continue
            # skip tool-result / system-ish user turns and the injected caveat preface
            if typ == "user" and (t.startswith("<") or t.startswith("Caveat")): continue
            if len(t) > MAX_LEN: t = t[:MAX_LEN] + "\n…(truncated)"
            out.append({"role": "you" if typ == "user" else "claude", "text": t})
except Exception:
    out = []
if len(out) > MAX_MSGS:
    out = out[-MAX_MSGS:]
print(json.dumps(out))
PY
