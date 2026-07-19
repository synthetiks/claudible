#!/usr/bin/env bash
# test/path-guards.test.sh — the four workspace scripts must REFUSE a path they cannot round-trip, refuse it
# BEFORE touching the disk or the network, and still accept the unusual-but-legal paths people really have.
#
# lib/pathSafe.js rejects these upstream (test/path-safe.test.js proves that). This is the belt: workspaces.json
# is a plain file the user can edit, and its `ws.path` reaches clone-workspace.sh and upgrade-workspace.sh.
#
# Each script is driven with a real argv array — never through a shell string — so the hostile bytes arrive
# exactly as the runner delivers them.
#
# ASSERT ON THE EXACT ERROR, never merely on ok:false. Every one of these scripts has several ways to fail:
# clone-workspace.sh with an unguarded backslash sails past the guard, calls `gh repo clone`, fails on the
# network, and returns {"ok":false,"error":"clone failed …"}. An `ok:false` assertion passes — while the guard
# is gone, and the script just made a network call with an attacker-shaped path. The first draft of this test
# did exactly that, and its mutation run passed. Only the error STRING distinguishes "refused" from "tried".
#
# Run: bash test/path-guards.test.sh   (hermetic: every guard fires before the first gh/mkdir call)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WSL="$(cd "$HERE/.." && pwd)/wsl"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); printf '  FAIL %s\n    %s\n' "$1" "$2"; }

json_err() { printf '%s' "$1" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception as e: print("<<UNPARSEABLE: %s>>" % e); raise SystemExit
print(("ok:true" if d.get("ok") else d.get("error","<<no error field>>")))' 2>/dev/null || printf '<<UNPARSEABLE>>'; }

# The script must refuse with EXACTLY this error — proving the guard fired, not a downstream failure.
refuses_with() {
  local label="$1" want="$2"; shift 2
  local out got
  out="$("$@" 2>/dev/null)"
  got="$(json_err "$out")"
  if [ "$got" = "$want" ]; then ok; else bad "$label" "error was [$got], expected [$want]  (raw: ${out:0:110})"; fi
}
absent() { if [ -e "$2" ]; then bad "$1 — touched the disk" "$2 exists"; else ok; fi; }

echo "== characters that break a single-quoted bash arg, or the JSON printf'd around it =="
NL="$(printf '\nx')"; NL="${NL%x}"
TAB="$(printf '\tx')"; TAB="${TAB%x}"
CR="$(printf '\rx')"; CR="${CR%x}"
BADS=( "a'b" 'a"b' 'a\b' "a${NL}b" "a${TAB}b" "a${CR}b" )
NAMES=( single-quote double-quote backslash newline tab carriage-return )

i=0
for n in "${NAMES[@]}"; do
  raw="${BADS[$i]}"; i=$((i+1))

  # Each script gets its OWN parent, so one script's disk write can't satisfy another's canary.
  d1="$TMP/create-$raw"; d2="$TMP/clone-$raw"; d3="$TMP/upgrade-$raw"; d4="$TMP/adopt-$raw"

  # create-workspace.sh local <slug> <parent>   — this argument had NO guard whatsoever
  refuses_with "create-workspace ($n)" "bad dir" bash "$WSL/create-workspace.sh" local proj "$d1"
  absent       "create-workspace ($n)" "$d1"

  # clone-workspace.sh <owner> <slug> <dir>     — guard was missing backslash + control bytes.
  # "bad dir" also proves it never reached `gh repo clone`.
  refuses_with "clone-workspace ($n)" "bad dir" bash "$WSL/clone-workspace.sh" someowner someslug "$d2"
  absent       "clone-workspace ($n)" "$d2"

  # upgrade-workspace.sh <slug> <dir>           — same guard. "bad dir", not "workspace folder not found".
  refuses_with "upgrade-workspace ($n)" "bad dir" bash "$WSL/upgrade-workspace.sh" someslug "$d3"

  # adopt-workspace.sh <dir>                    — had ' " \ ; now control bytes too. Emits the shared "bad dir"
  # code (like its three siblings), which renderer humanError() translates — NOT "that folder does not exist".
  refuses_with "adopt-workspace ($n)" "bad dir" bash "$WSL/adopt-workspace.sh" "$d4"
done

echo "== a legal, unusual path must still WORK — the guard must not lock users out of their own folders =="
GOOD="$TMP/My Prøjects (2024) \$var;x & more"
mkdir -p "$GOOD"
out="$(bash "$WSL/create-workspace.sh" local myproj "$GOOD" 2>/dev/null)"
got="$(json_err "$out")"
if [ "$got" = "ok:true" ]; then ok; else bad "create-workspace accepts spaces/unicode/\$/;/& " "error was [$got]"; fi
if [ -d "$GOOD/myproj/.claude" ]; then ok; else bad "…and actually created it" "$GOOD/myproj/.claude missing"; fi
# The emitted path must survive JSON.parse as the exact directory it created — that is the whole contract.
p="$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["path"])' 2>/dev/null)"
if [ "$p" = "$GOOD/myproj" ]; then ok; else bad "emitted path round-trips exactly" "got [$p] want [$GOOD/myproj]"; fi

echo "== the default (no custom parent) path is untouched =="
out="$(HOME="$TMP/home" bash "$WSL/create-workspace.sh" local defproj 2>/dev/null)"
got="$(json_err "$out")"
if [ "$got" = "ok:true" ]; then ok; else bad "create-workspace with no parent dir" "error was [$got]"; fi
if [ -d "$TMP/home/.claudible/workspaces/defproj/.claude" ]; then ok; else bad "default location used" "missing"; fi

echo "== a bad SLUG must still be rejected as a bad slug, not swallowed by the new dir guard =="
refuses_with "create-workspace (bad slug)" "bad slug" bash "$WSL/create-workspace.sh" local 'a/b' "$TMP"
refuses_with "clone-workspace (bad owner)" "bad owner" bash "$WSL/clone-workspace.sh" 'a/b' someslug "$TMP"

echo "== clone-workspace must NEVER rm -rf a folder it did not create =="
# The rollback exists to drop a half-done clone. Before the guard, a pre-existing NON-git folder sailed past the
# only check ("$dir/.git"), `gh repo clone` failed on the non-empty target, and `rm -rf "$dir"` ate the user's work.
# Assert the EXACT refusal (a downstream "clone failed" would mean the guard is gone and the network was hit),
# AND that the bytes survive. Both directions matter: revert the guard and the second assertion fails.
EXISTS_MSG='that folder already exists and is not empty — pick another location'
PRE="$TMP/precious"; mkdir -p "$PRE"; printf 'uncommitted work\n' > "$PRE/work.txt"
refuses_with "clone-workspace (pre-existing non-empty dir)" "$EXISTS_MSG" bash "$WSL/clone-workspace.sh" someowner someslug "$PRE"
if [ -f "$PRE/work.txt" ]; then ok; else bad "clone-workspace DELETED a pre-existing folder" "$PRE/work.txt is gone"; fi

PREF="$TMP/afile"; printf 'x' > "$PREF"
refuses_with "clone-workspace (target is a plain file)" "$EXISTS_MSG" bash "$WSL/clone-workspace.sh" someowner someslug "$PREF"
if [ -f "$PREF" ]; then ok; else bad "clone-workspace DELETED a pre-existing file" "$PREF is gone"; fi

# …and an EMPTY pre-existing dir is still a legal clone target — don't over-tighten into refusing it. A stub `gh`
# that always fails keeps this hermetic (no network) AND drives the rollback branch: the dir we did NOT create
# must survive the failure.
STUB="$TMP/bin"; mkdir -p "$STUB"; printf '#!/bin/sh\nexit 1\n' > "$STUB/gh"; chmod +x "$STUB/gh"
PREE="$TMP/emptydir"; mkdir -p "$PREE"
out="$(PATH="$STUB:$PATH" bash "$WSL/clone-workspace.sh" someowner someslug "$PREE" 2>/dev/null)"
got="$(json_err "$out")"
if [ "$got" = "clone failed (check access to someowner/someslug)" ]; then ok; else bad "clone-workspace mishandles an EMPTY pre-existing dir" "error was [$got]"; fi
if [ -d "$PREE" ]; then ok; else bad "clone-workspace deleted an EMPTY dir it did not create" "$PREE is gone"; fi

printf '\npath-guards: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
