#!/usr/bin/env bash
# Diff-based parity: prove hooks/statusline.js + hooks/hook.js reproduce the bash+python3 hooks
# BYTE-FOR-BYTE (the status.json content, the statusline stdout incl. trailing newline, and the
# appended hooks.ndjson line). Runs the REAL old bash scripts vs the new Node hooks over real +
# edge-case payloads. Requires node + python3 (what the old statusline used). Run: bash test/hooks-parity.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0

# --- the ORIGINAL bash hooks, verbatim from the pre-0.5 session.sh (heredoc-expanded form) ---
cat > "$TMP/statusline.sh" <<'EOF'
#!/usr/bin/env bash
in=$(cat)
out="${CLAUDIBLE_STATUS:-/dev/null}"
printf '%s' "$in" > "$out"
printf '%s' "$in" | python3 -c "import sys,json
try:
    d=json.load(sys.stdin); c=d.get('context_window',{})
    print('claudible · %s%% ctx' % c.get('used_percentage','?'))
except: print('claudible')" 2>/dev/null || printf 'claudible'
EOF
cat > "$TMP/hook.sh" <<'EOF'
#!/usr/bin/env bash
line=$(cat)
out="${CLAUDIBLE_HOOKS:-/dev/null}"
printf '%s\n' "$line" >> "$out"
exit 0
EOF

st_case() {  # $1=label  $2=input (printf %s, no auto newline)
  local label="$1" input="$2"
  printf '%s' "$input" | CLAUDIBLE_STATUS="$TMP/b_s" bash    "$TMP/statusline.sh"        > "$TMP/b_o" 2>/dev/null
  printf '%s' "$input" | CLAUDIBLE_STATUS="$TMP/n_s" node "$ROOT/hooks/statusline.js"    > "$TMP/n_o" 2>/dev/null
  if diff -q "$TMP/b_s" "$TMP/n_s" >/dev/null 2>&1; then echo "  ok   [$label] status.json identical";
  else echo "  FAIL [$label] status.json DIFFERS"; fail=1; fi
  if diff -q "$TMP/b_o" "$TMP/n_o" >/dev/null 2>&1; then echo "  ok   [$label] statusline = $(cat "$TMP/n_o")";
  else echo "  FAIL [$label] statusline DIFFERS: bash=[$(cat "$TMP/b_o")] node=[$(cat "$TMP/n_o")]"; fail=1; fi
}

echo "== statusline parity =="
st_case "num int"        '{"context_window":{"used_percentage":66}}'
st_case "num float"      '{"context_window":{"used_percentage":66.5}}'
st_case "null value"     '{"context_window":{"used_percentage":null}}'
st_case "key missing"    '{"context_window":{}}'
st_case "no ctx_window"  '{"foo":1}'
st_case "invalid json"   'not json at all'
st_case "trailing nl"    '{"context_window":{"used_percentage":42}}
'
# the REAL captured payload from the running session, if present
REAL="$TMP/real-status.json"
SRC="/tmp/claude-1000/-mnt-c-Users-daisy-Claudible-Release/a56cc2b2-599f-410c-a075-69acb845a95c/scratchpad/hooktest/real-status.json"
[ -f "$SRC" ] && st_case "REAL session" "$(cat "$SRC")"

echo "== documented: whole-number float renders cleaner (status.json still byte-identical) =="
printf '%s' '{"context_window":{"used_percentage":66.0}}' | CLAUDIBLE_STATUS="$TMP/fb_s" bash    "$TMP/statusline.sh"     > "$TMP/fb_o" 2>/dev/null
printf '%s' '{"context_window":{"used_percentage":66.0}}' | CLAUDIBLE_STATUS="$TMP/fn_s" node "$ROOT/hooks/statusline.js" > "$TMP/fn_o" 2>/dev/null
if diff -q "$TMP/fb_s" "$TMP/fn_s" >/dev/null 2>&1; then echo "  ok   [float 66.0] status.json identical (the meter-critical output)"; else echo "  FAIL [float 66.0] status.json DIFFERS"; fail=1; fi
echo "  note [float 66.0] TUI line bash=[$(cat "$TMP/fb_o")] node=[$(cat "$TMP/fn_o")] (cosmetic, documented)"
[ "$(cat "$TMP/fn_o")" = "claudible · 66% ctx" ] && echo "  ok   [float 66.0] node renders the documented 'claudible · 66% ctx'" || { echo "  FAIL [float 66.0] unexpected node output"; fail=1; }

echo "== argv fallback: env unset -> node uses the baked path arg (matches bash defense-in-depth) =="
printf '%s' '{"context_window":{"used_percentage":50}}' | env -u CLAUDIBLE_STATUS node "$ROOT/hooks/statusline.js" "$TMP/argv_s" >/dev/null 2>&1
if [ "$(cat "$TMP/argv_s" 2>/dev/null)" = '{"context_window":{"used_percentage":50}}' ]; then echo "  ok   [argv status] wrote to baked path when env unset"; else echo "  FAIL [argv status] ignored baked path"; fail=1; fi
: > "$TMP/argv_h"; printf '%s' '{"hook_event_name":"Stop"}' | env -u CLAUDIBLE_HOOKS node "$ROOT/hooks/hook.js" "$TMP/argv_h" >/dev/null 2>&1
if [ "$(cat "$TMP/argv_h" 2>/dev/null)" = '{"hook_event_name":"Stop"}' ]; then echo "  ok   [argv hook] appended to baked path when env unset"; else echo "  FAIL [argv hook] ignored baked path"; fail=1; fi

echo "== hook (ndjson append) parity =="
hk_case() {
  local label="$1" input="$2"
  : > "$TMP/b_h"; : > "$TMP/n_h"
  printf '%s' "$input" | CLAUDIBLE_HOOKS="$TMP/b_h" bash    "$TMP/hook.sh"
  printf '%s' "$input" | CLAUDIBLE_HOOKS="$TMP/n_h" node "$ROOT/hooks/hook.js"
  if diff -q "$TMP/b_h" "$TMP/n_h" >/dev/null 2>&1; then echo "  ok   [$label] ndjson line identical";
  else echo "  FAIL [$label] ndjson DIFFERS"; fail=1; fi
}
hk_case "stop event"   '{"hook_event_name":"Stop","last_assistant_message":"done"}'
hk_case "agent event"  '{"hook_event_name":"PostToolUse","tool_name":"Agent","tool_response":{"totalTokens":1234}}'
hk_case "trailing nl"  '{"hook_event_name":"UserPromptSubmit"}
'

echo
[ "$fail" = 0 ] && echo "hooks-parity: ALL PASS" || echo "hooks-parity: FAILURES ABOVE"
exit "$fail"
