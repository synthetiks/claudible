#!/usr/bin/env bash
# test/trash-prune.test.sh — the only `rm -rf` in the codebase gets the strongest test in the suite.
#
# ~/.claudible/trash receives soft-deleted session transcripts AND entire deleted project folders (an adopted repo,
# node_modules and all). Nothing in the app ever listed, restored, or emptied it, so it grew without bound.
# wsl/trash-prune.sh sweeps it on launch: anything older than MAX_AGE_DAYS, then oldest-first until under MAX_MB.
#
# Every case below drives the REAL script against a throwaway $HOME, and every destructive case plants a CANARY
# outside the trash that must survive. Run: bash test/trash-prune.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PRUNE="$ROOT/wsl/trash-prune.sh"
pass=0; fail=0
ok() { if [ "$1" = "$2" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL $3: expected [$2] got [$1]"; fi; }
json() { printf '%s' "$1" | sed -n "s/.*\"$2\":\([0-9]*\).*/\1/p"; }

# a sandbox $HOME with a trash dir and a CANARY that must never be touched
mkbox() { local d; d="$(mktemp -d)"; mkdir -p "$d/.claudible/trash" "$d/CANARY"; echo precious > "$d/CANARY/data.txt"; printf '%s' "$d"; }
canary_ok() { [ -f "$1/CANARY/data.txt" ] && [ "$(cat "$1/CANARY/data.txt")" = precious ] && echo intact || echo DESTROYED; }

# --- 1. age: old entries go, recent ones stay --------------------------------------------------------------
B="$(mkbox)"; T="$B/.claudible/trash"
echo old > "$T/old.jsonl";  touch -d "60 days ago" "$T/old.jsonl"
echo new > "$T/new.jsonl";  touch -d "1 day ago"   "$T/new.jsonl"
mkdir -p "$T/ws-repo-old/node_modules"; echo x > "$T/ws-repo-old/node_modules/pkg"; touch -d "60 days ago" "$T/ws-repo-old"
out="$(HOME="$B" bash "$PRUNE")"
ok "$(json "$out" removed)" "2" "an old transcript and an old project folder are both swept"
ok "$([ -f "$T/new.jsonl" ] && echo kept || echo gone)" "kept" "a recent entry is kept"
ok "$([ -e "$T/old.jsonl" ] && echo kept || echo gone)" "gone" "…and the old one is gone"
ok "$(canary_ok "$B")" "intact" "nothing outside the trash is touched"
rm -rf "$B"

# --- 2. a symlink in the trash is UNLINKED, never followed ---------------------------------------------------
#     Without this, `rm -rf` on an aged symlink pointing at $HOME would recurse into it.
B="$(mkbox)"; T="$B/.claudible/trash"
ln -s "$B/CANARY" "$T/evil"; touch -h -d "60 days ago" "$T/evil" 2>/dev/null || true
out="$(HOME="$B" bash "$PRUNE")"
ok "$([ -L "$T/evil" ] && echo kept || echo gone)" "gone" "an aged symlink is removed"
ok "$(canary_ok "$B")" "intact" "…by unlinking it, NOT by following it into the canary"
ok "$([ -d "$B/CANARY" ] && echo yes || echo no)" "yes" "…and its target directory still exists"
rm -rf "$B"

# --- 3. size cap: oldest-first until under the cap, ages irrelevant -------------------------------------------
B="$(mkbox)"; T="$B/.claudible/trash"
for i in 1 2 3 4 5; do dd if=/dev/zero of="$T/f$i.bin" bs=1M count=1 status=none; touch -d "$((10 - i)) days ago" "$T/f$i.bin"; done
out="$(HOME="$B" CLAUDIBLE_TRASH_MAX_AGE_DAYS=365 CLAUDIBLE_TRASH_MAX_MB=3 bash "$PRUNE")"
ok "$([ -e "$T/f1.bin" ] && echo kept || echo gone)" "gone" "cap: the oldest goes first"
ok "$([ -e "$T/f5.bin" ] && echo kept || echo gone)" "kept" "cap: the newest survives"
ok "$([ "$(du -sm "$T" | cut -f1)" -le 3 ] && echo under || echo over)" "under" "cap: the trash ends up under the limit"
ok "$(canary_ok "$B")" "intact" "cap: nothing outside the trash is touched"
rm -rf "$B"

# --- 4. GUARD: the resolved path must be a real .claudible/trash leaf -----------------------------------------
#     A symlinked trash pointing anywhere else must make the script refuse entirely.
B="$(mktemp -d)"; mkdir -p "$B/.claudible" "$B/elsewhere"; echo keep > "$B/elsewhere/file"
ln -s "$B/elsewhere" "$B/.claudible/trash"
touch -d "60 days ago" "$B/elsewhere/file"
out="$(HOME="$B" bash "$PRUNE")"
case "$out" in *'"ok":false'*'refusing to prune'*) pass=$((pass+1)) ;; *) fail=$((fail+1)); echo "  FAIL a trash symlinked outside .claudible/trash is refused (got: $out)" ;; esac
ok "$([ -f "$B/elsewhere/file" ] && echo intact || echo DESTROYED)" "intact" "…and nothing there is deleted"
rm -rf "$B"

# --- 5. hostile filenames survive the loop intact -------------------------------------------------------------
B="$(mkbox)"; T="$B/.claudible/trash"
printf 'x' > "$T/name with spaces.jsonl";       touch -d "60 days ago" "$T/name with spaces.jsonl"
printf 'x' > "$T/quote'and\$dollar.jsonl";      touch -d "60 days ago" "$T/quote'and\$dollar.jsonl"
printf 'x' > "$T/-leading-dash.jsonl";          touch -d "60 days ago" "$T/-leading-dash.jsonl"
printf 'x' > "$T/keep-me.jsonl";                touch -d "1 day ago"   "$T/keep-me.jsonl"
out="$(HOME="$B" bash "$PRUNE")"
ok "$(json "$out" removed)" "3" "spaces, quotes, \$dollar and a leading dash are all handled"
ok "$([ -f "$T/keep-me.jsonl" ] && echo kept || echo gone)" "kept" "…and the recent one still survives"
ok "$(canary_ok "$B")" "intact" "…with the canary untouched"
rm -rf "$B"

# --- 6. no trash / empty trash: clean no-ops, never an error ---------------------------------------------------
B="$(mktemp -d)"
out="$(HOME="$B" bash "$PRUNE")"
case "$out" in *'"ok":true'*'no trash directory'*) pass=$((pass+1)) ;; *) fail=$((fail+1)); echo "  FAIL a missing trash dir is a clean no-op (got: $out)" ;; esac
mkdir -p "$B/.claudible/trash"
out="$(HOME="$B" bash "$PRUNE")"
ok "$(json "$out" removed)" "0" "an empty trash removes nothing"
case "$out" in *'"ok":true'*) pass=$((pass+1)) ;; *) fail=$((fail+1)); echo "  FAIL an empty trash reports ok:true" ;; esac
rm -rf "$B"

# --- 7. the defaults are the ones the UI promises ("kept 30 days") ---------------------------------------------
B="$(mkbox)"
out="$(HOME="$B" bash "$PRUNE")"
ok "$(json "$out" maxAgeDays)" "30" "default retention is the 30 days the delete dialogs promise"
rm -rf "$B"
grep -q "kept 30 days" "$ROOT/renderer/app.js" && pass=$((pass+1)) || { fail=$((fail+1)); echo "  FAIL the UI states the 30-day retention window"; }

echo "trash-prune: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
