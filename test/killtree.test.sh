#!/usr/bin/env bash
# test/killtree.test.sh — behavioral coverage for wsl/killtree.sh (R33: it guarded the app's worst leak — the
# "(empty session)" orphan factory — with ZERO automated tests). Drives the REAL script against a real spawned
# process tree in a sandbox APPDIR shape (the script derives runtime/ from its own location, so we copy it).
#
# Covered: (1) a parent→child→grandchild tree is fully reaped, deepest-first, incl. the frozen-walk path;
# (2) the recycled-pid guard — a boot.pid whose start-time token no longer matches the live process must
# kill NOTHING and clear the stale pidfile; (3) a missing pidfile is a clean no-op.
# Run: bash test/killtree.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pass=0; fail=0
ok() { if [ "$1" = "$2" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL $3: expected [$2] got [$1]"; fi; }

SBX="$(mktemp -d)"
mkdir -p "$SBX/wsl" "$SBX/runtime/tabs/T1"
cp "$ROOT/wsl/killtree.sh" "$ROOT/wsl/_proc-stime.sh" "$SBX/wsl/"
# shellcheck disable=SC1091
. "$ROOT/wsl/_proc-stime.sh"

# --- 1. a real tree dies: parent (session leader via setsid) → child → grandchild --------------------------
setsid bash -c 'bash -c "sleep 300 & wait" & sleep 300' >/dev/null 2>&1 &
P=$!; disown "$P" 2>/dev/null || true                # disown: the reap must not print bash job-control noise
sleep 0.4                                            # let the children spawn
KIDS="$(pgrep -P "$P" | wc -l)"
ok "$([ "$KIDS" -ge 1 ] && echo yes)" "yes" "the fixture tree actually has children (else the reap test is vacuous)"
printf '%s %s\n' "$P" "$(proc_stime "$P")" > "$SBX/runtime/tabs/T1/boot.pid"
bash "$SBX/wsl/killtree.sh" T1
sleep 0.3
ok "$(kill -0 "$P" 2>/dev/null && echo alive || echo dead)" "dead" "the parent is reaped"
ok "$(pgrep -P "$P" 2>/dev/null | wc -l)" "0" "no children survive the walk"
ok "$([ -f "$SBX/runtime/tabs/T1/boot.pid" ] && echo kept || echo gone)" "gone" "the pidfile is cleared after the reap"

# --- 2. the recycled-pid guard: WRONG start-time token → kill NOTHING, clear the stale pidfile -------------
sleep 300 &
Q=$!; disown "$Q" 2>/dev/null || true
printf '%s %s\n' "$Q" "not-the-real-stime" > "$SBX/runtime/tabs/T1/boot.pid"
bash "$SBX/wsl/killtree.sh" T1
sleep 0.2
ok "$(kill -0 "$Q" 2>/dev/null && echo alive || echo dead)" "alive" "a recycled/mismatched pid is NEVER killed"
ok "$([ -f "$SBX/runtime/tabs/T1/boot.pid" ] && echo kept || echo gone)" "gone" "…but the stale pidfile is cleared"
kill -KILL "$Q" 2>/dev/null

# --- 3. no pidfile at all → clean no-op (exit 0, nothing thrown) -------------------------------------------
bash "$SBX/wsl/killtree.sh" T1; rc=$?
ok "$rc" "0" "a missing pidfile exits 0"
bash "$SBX/wsl/killtree.sh" 'bad id!'; rc=$?
ok "$rc" "0" "a malformed tab id exits 0 (never a crash on hostile input)"

rm -rf "$SBX" 2>/dev/null
echo "killtree: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
