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
# the first line is a REAL prompt — type:"user" with non-empty message.content text — because the stub gate
# now applies sessions-tool.js's actual msgs rule (via prompt-scan.js), not a bare '"type":"user"' grep:
LOCAL_C='{"type":"user","message":{"content":"a"}}
{"m":"b"}
'                                            # the machine's local copy (2 turns)
FORK_C='{"type":"user","message":{"content":"a"}}
{"m":"z"}
'                                            # a TRUE fork: same first turn, diverged second (same size, neither a prefix)
FF_C='{"type":"user","message":{"content":"a"}}
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
  export CLAUDIBLE_SYNC_MIN_AGE=0                     # fixtures are written this instant — disable the 2s torn-write guard (import shares export's knob)
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
  export CLAUDIBLE_SYNC_MIN_AGE=0                     # fixtures are written this instant — disable the 2s torn-write guard (import shares export's knob)
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

# --- Scenario 5: import_sessions reports WHICH ids it changed (ids_json) — the app uses this list to
# respawn any OPEN tab whose transcript was just replaced (the "out of sync doesn't refresh the open
# session" fix). A new import + a fast-forward update are listed; an untouched fork is NOT.
run_ids_case() (
  TMP="$(mktemp -d)"
  export HOME="$TMP"
  mkdir -p "$TMP/bin"
  printf '#!/usr/bin/env bash\necho tester\n' > "$TMP/bin/gh"; chmod +x "$TMP/bin/gh"
  export PATH="$TMP/bin:$PATH"
  export CLAUDIBLE_WS_KIND=repo CLAUDIBLE_WS_SLUG=testws CLAUDIBLE_PROJ=testproj
  export CLAUDIBLE_SYNC_MIN_AGE=0                     # fixtures are written this instant — disable the 2s torn-write guard (import shares export's knob)
  mkdir -p "$TMP/.claudible/repos/testws/.git"
  # shellcheck disable=SC1090
  source "$SCRIPT" status >/dev/null 2>&1
  mkdir -p "$PROJ" "$WT/sessions/aaa_peer"
  printf %s "$LOCAL_C" > "$PROJ/bb-ff.jsonl"                       # will fast-forward
  printf %s "$LOCAL_C" > "$PROJ/cc-fork.jsonl"                     # will fork (untouched)
  printf %s "$LOCAL_C" > "$WT/sessions/aaa_peer/aa-new.jsonl"      # new on the branch → import
  printf %s "$FF_C"    > "$WT/sessions/aaa_peer/bb-ff.jsonl"       # local + one more turn → update
  printf %s "$FORK_C"  > "$WT/sessions/aaa_peer/cc-fork.jsonl"     # true fork → flagged, NOT listed
  import_sessions >/dev/null 2>&1
  echo "$(ids_json) $IMPORTED $UPDATED $DIVERGED"
)
r=$(LOCAL_C="$LOCAL_C" FF_C="$FF_C" FORK_C="$FORK_C" run_ids_case)
ok "$r" '["aa-new","bb-ff"] 1 1 1' "changed ids listed (import+ff), fork excluded"

# --- Scenario 6 (R11): per-machine tags in the OWN author dir. "My login's branch copy differs from my
# local" is only self-compaction when it came from THIS machine — a copy tagged by ANOTHER of my machines is
# a real fork between my own two devices and must flag like any collaborator fork (it used to be silently
# masked; last pusher overwrote the other device's turns). Untagged = legacy export → old rule (no re-nag
# during transition).
r=$(CLAUDIBLE_MACHINE_ID=machine-B LOCAL_C="$LOCAL_C" FORK_C="$FORK_C" run_case '
  printf %s "$LOCAL_C" > "$PROJ/ID.jsonl"
  mkdir -p "$WT/sessions/tester"
  printf %s "$FORK_C" > "$WT/sessions/tester/ID.jsonl"
  printf "ID machine-A\n" > "$WT/sessions/tester/.machine-tags"
')
ok "$r" "FLAGGED" "own-dir fork tagged by ANOTHER machine → flagged (R11)"

r=$(CLAUDIBLE_MACHINE_ID=machine-A LOCAL_C="$LOCAL_C" FORK_C="$FORK_C" run_case '
  printf %s "$LOCAL_C" > "$PROJ/ID.jsonl"
  mkdir -p "$WT/sessions/tester"
  printf %s "$FORK_C" > "$WT/sessions/tester/ID.jsonl"
  printf "ID machine-A\n" > "$WT/sessions/tester/.machine-tags"
')
ok "$r" "CLEAR" "own-dir fork tagged by THIS machine → self-compaction, no nag (R11)"

r=$(CLAUDIBLE_MACHINE_ID=machine-A LOCAL_C="$LOCAL_C" FORK_C="$FORK_C" run_case '
  printf %s "$LOCAL_C" > "$PROJ/ID.jsonl"
  mkdir -p "$WT/sessions/tester"
  printf %s "$FORK_C" > "$WT/sessions/tester/ID.jsonl"
')
ok "$r" "CLEAR" "own-dir fork with NO tag (legacy export) → old rule kept (R11 transition)"

# --- Scenario 7 (R11): export stamps the tag. After export_sessions, .machine-tags records id + this machine.
run_tag_case() (
  TMP="$(mktemp -d)"
  export HOME="$TMP"
  mkdir -p "$TMP/bin"
  printf '#!/usr/bin/env bash\necho tester\n' > "$TMP/bin/gh"; chmod +x "$TMP/bin/gh"
  export PATH="$TMP/bin:$PATH"
  export CLAUDIBLE_WS_KIND=repo CLAUDIBLE_WS_SLUG=testws CLAUDIBLE_PROJ=testproj
  export CLAUDIBLE_SYNC_MIN_AGE=0 CLAUDIBLE_MACHINE_ID=machine-A
  mkdir -p "$TMP/.claudible/repos/testws/.git"
  # shellcheck disable=SC1090
  source "$SCRIPT" status >/dev/null 2>&1
  mkdir -p "$PROJ"
  printf %s "$LOCAL_C" > "$PROJ/EXP.jsonl"
  export_sessions >/dev/null 2>&1
  grep -cx "EXP machine-A" "$WT/sessions/tester/.machine-tags" 2>/dev/null || echo 0
)
r=$(LOCAL_C="$LOCAL_C" run_tag_case)
ok "$r" "1" "export stamps the exporting machine's tag (R11)"

echo "sessions-divergence: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
