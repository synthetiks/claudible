#!/usr/bin/env bash
# test/sessions-divergence.test.sh — proves wsl/sessions-sync.sh import_sessions AUTO-FLAGS a true fork regardless
# of author-dir glob order (the "sometimes doesn't flag" bug: a later ff/identical resolution from another author
# dir used to clear a divergence flagged earlier the SAME pass), and still CLEARS a stale flag on a clean
# fast-forward (the guard must not over-protect). Drives the REAL import_sessions: sources the script in a
# controlled env (fake `gh`, the benign `status` op — no worktree, no network), then feeds it fixtures.
# Run: bash test/sessions-divergence.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/wsl/sessions-sync.sh"
pass=0; fail=0
ok() { if [ "$1" = "$2" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL $3: expected [$2] got [$1]"; fi; }

# Byte-exact fixture contents (each line is valid JSON so the import's head-c1='{' sanity check passes;
# the first line carries "type":"user" like every real transcript, so the promptless-stub import guard passes):
LOCAL_C='{"type":"user","m":"a"}
{"m":"b"}
'                                            # the machine's local copy (2 turns)
FORK_C='{"type":"user","m":"a"}
{"m":"z"}
'                                            # a TRUE fork: same first turn, diverged second (same size, neither a prefix)
FF_C='{"type":"user","m":"a"}
{"m":"b"}
{"m":"c"}
'                                            # a clean fast-forward: local + one more turn

# Run import_sessions on a fresh sandbox. $1 = a shell snippet that lays out fixtures using $WT/$PROJ/$DDSET/$AKSET.
# Echoes "FLAGGED" if id "ID" is in .claudible-diverged afterward, else "CLEAR". Isolated in a subshell so flag
# files + IMPORTED/UPDATED/DIVERGED globals never leak between scenarios.
run_case() (
  TMP="$(mktemp -d)"
  export HOME="$TMP"
  mkdir -p "$TMP/bin"
  printf '#!/usr/bin/env bash\necho tester\n' > "$TMP/bin/gh"; chmod +x "$TMP/bin/gh"
  export PATH="$TMP/bin:$PATH"
  export CLAUDIBLE_WS_KIND=repo CLAUDIBLE_WS_SLUG=testws CLAUDIBLE_PROJ=testproj
  mkdir -p "$TMP/.claudible/repos/testws/.git"        # satisfy [ -d "$SDIR/.git" ]
  # shellcheck disable=SC1090
  source "$SCRIPT" status >/dev/null 2>&1             # defines functions + sets WT/PROJ/DDSET/AKSET/FSET (status op is inert here)
  mkdir -p "$PROJ" "$WT/sessions"
  eval "$1"                                           # scenario lays out fixtures
  import_sessions >/dev/null 2>&1
  if grep -qxF "ID" "$DDSET" 2>/dev/null; then echo "FLAGGED"; else echo "CLEAR"; fi
)

# helper snippets share these; expanded inside the subshell where $WT/$PROJ are set.
mkfix='printf %s "$LOCAL_C" > "$PROJ/ID.jsonl"'

# --- Scenario 1: fork dir sorts BEFORE the ff dir (this is the order the OLD code got wrong) ---
r=$(LOCAL_C="$LOCAL_C" FORK_C="$FORK_C" FF_C="$FF_C" run_case '
  printf %s "$LOCAL_C" > "$PROJ/ID.jsonl"
  mkdir -p "$WT/sessions/aaa_fork" "$WT/sessions/zzz_ff"
  printf %s "$FORK_C" > "$WT/sessions/aaa_fork/ID.jsonl"
  printf %s "$FF_C"   > "$WT/sessions/zzz_ff/ID.jsonl"
')
ok "$r" "FLAGGED" "fork flagged when fork-dir sorts first"

# --- Scenario 2: ff dir sorts BEFORE the fork dir (the control — must also end flagged) ---
r=$(LOCAL_C="$LOCAL_C" FORK_C="$FORK_C" FF_C="$FF_C" run_case '
  printf %s "$LOCAL_C" > "$PROJ/ID.jsonl"
  mkdir -p "$WT/sessions/aaa_ff" "$WT/sessions/zzz_fork"
  printf %s "$FF_C"   > "$WT/sessions/aaa_ff/ID.jsonl"
  printf %s "$FORK_C" > "$WT/sessions/zzz_fork/ID.jsonl"
')
ok "$r" "FLAGGED" "fork flagged when ff-dir sorts first (order-independent)"

# --- Scenario 3: a clean ff with NO fork present must CLEAR a stale flag (guard must not over-protect) ---
r=$(LOCAL_C="$LOCAL_C" FF_C="$FF_C" run_case '
  printf %s "$LOCAL_C" > "$PROJ/ID.jsonl"
  printf "ID\n" > "$DDSET"                            # a stale flag from a previous run
  mkdir -p "$WT/sessions/aaa_ff"
  printf %s "$FF_C" > "$WT/sessions/aaa_ff/ID.jsonl"
')
ok "$r" "CLEAR" "stale flag cleared on a clean fast-forward"

# --- Scenario 4: a promptless stub (no "type":"user" line — a fork artifact / killed boot) must be REFUSED
# on import, while a real transcript in the same pass imports fine. Own probe (file existence, not the flag).
run_stub_case() (
  TMP="$(mktemp -d)"
  export HOME="$TMP"
  mkdir -p "$TMP/bin"
  printf '#!/usr/bin/env bash\necho tester\n' > "$TMP/bin/gh"; chmod +x "$TMP/bin/gh"
  export PATH="$TMP/bin:$PATH"
  export CLAUDIBLE_WS_KIND=repo CLAUDIBLE_WS_SLUG=testws CLAUDIBLE_PROJ=testproj
  mkdir -p "$TMP/.claudible/repos/testws/.git"
  # shellcheck disable=SC1090
  source "$SCRIPT" status >/dev/null 2>&1
  mkdir -p "$PROJ" "$WT/sessions/aaa_peer"
  printf '%s\n' '{"type":"ai-title","aiTitle":"x"}' > "$WT/sessions/aaa_peer/STUB.jsonl"   # promptless stub
  printf %s "$LOCAL_C" > "$WT/sessions/aaa_peer/REAL.jsonl"                                # real transcript
  import_sessions >/dev/null 2>&1
  s="SKIPPED"; [ -e "$PROJ/STUB.jsonl" ] && s="IMPORTED"
  r="MISSING"; [ -e "$PROJ/REAL.jsonl" ] && r="IMPORTED"
  echo "$s $r"
)
r=$(LOCAL_C="$LOCAL_C" run_stub_case)
ok "$r" "SKIPPED IMPORTED" "promptless stub refused on import; real transcript still imports"

echo "sessions-divergence: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
