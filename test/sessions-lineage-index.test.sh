#!/usr/bin/env bash
# test/sessions-lineage-index.test.sh — session lineage recording + generated INDEX.md.
#
# Drives wsl/sessions-sync-tool.js's "lineage-write" and "index-write" subcommands directly (the same way
# test/port-parity.sh drives "title-write": env vars + a node spawn, no worktree/network needed), plus
# titleWrite's now-preserving merge. Covers:
#   (a) the drift path: lineage-write adds continuesFrom to the new id's meta entry without disturbing an
#       existing title/ts, and survives a LATER title-write on the same id (order independence)
#   (b) index-write over a fixture meta + transcript pair produces the plan's table shape: a parent row and
#       a "↳ continued after /clear" child row, both with correct short ids
#   (c) the plan's named inverse test — a real new session with NO continuesFrom gets its own plain row,
#       never a lineage/child row
#   (d) C3 smoke — the transcript files on disk are byte-identical before/after (index-write never renames
#       or rewrites a transcript)
#
# Run: bash test/sessions-lineage-index.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOL="$ROOT/wsl/sessions-sync-tool.js"
pass=0; fail=0
ok() { if [ "$1" = "$2" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL $3: expected [$2] got [$1]"; fi; }
contains() { case "$1" in *"$2"*) pass=$((pass+1)); return ;; esac; fail=$((fail+1)); echo "  FAIL $3: expected to find [$2] in output"; }
not_contains() { case "$1" in *"$2"*) fail=$((fail+1)); echo "  FAIL $3: did NOT expect to find [$2] in output"; return ;; esac; pass=$((pass+1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- (a) lineage-write: adds continuesFrom, preserves an existing title/ts -------------------------------
META="$TMP/a-meta.json"
printf '{"newid00-1111-2222-3333-444444444444": {"title": "MK-Sessions", "ts": 1000}}' > "$META"
CL_ID="newid00-1111-2222-3333-444444444444" CL_FROM="oldid00-1111-2222-3333-444444444444" CL_FILE="$META" \
  node "$TOOL" lineage-write
OUT="$(cat "$META")"
contains "$OUT" '"continuesFrom": "oldid00-1111-2222-3333-444444444444"' "lineage-write adds continuesFrom"
contains "$OUT" '"title": "MK-Sessions"' "lineage-write preserves existing title"
contains "$OUT" '"ts": 1000' "lineage-write preserves existing ts"

# order independence: a LATER title-write on the same id must not drop continuesFrom (titleWrite now merges
# instead of clobbering the whole entry — see the comment in sessions-sync-tool.js titleWrite())
B64="$(printf '%s' 'MK-Sessions' | base64 -w0 2>/dev/null || printf '%s' 'MK-Sessions' | base64)"
CL_ID="newid00-1111-2222-3333-444444444444" CL_B64="$B64" CL_FILE="$META" node "$TOOL" title-write
OUT2="$(cat "$META")"
contains "$OUT2" '"continuesFrom": "oldid00-1111-2222-3333-444444444444"' "a later title-write does not drop lineage"

# a brand-new id (no prior entry) → lineage-write still adds the field, no title required
META2="$TMP/a2-meta.json"
printf '{}' > "$META2"
CL_ID="freshid1-1111-2222-3333-444444444444" CL_FROM="parentid-1111-2222-3333-444444444444" CL_FILE="$META2" \
  node "$TOOL" lineage-write
contains "$(cat "$META2")" '"continuesFrom": "parentid-1111-2222-3333-444444444444"' "lineage-write on a fresh id creates the entry"

# --- (b) index-write: parent row + continued-child row, right short ids ----------------------------------
PARENT="65735b71-aaaa-bbbb-cccc-000000000001"
CHILD="116e8abc-aaaa-bbbb-cccc-000000000002"
SESSDIR="$TMP/b-sessions"; mkdir -p "$SESSDIR"
printf '{"type":"user","message":{"content":"hi"}}\n' > "$SESSDIR/$PARENT.jsonl"
sleep 1 2>/dev/null || true
printf '{"type":"user","message":{"content":"/clear"}}\n' > "$SESSDIR/$CHILD.jsonl"
META3="$TMP/b-meta.json"
printf '{"%s": {"title": "MK-Sessions", "ts": 1}, "%s": {"title": "MK-Sessions", "ts": 2, "continuesFrom": "%s"}}' \
  "$PARENT" "$CHILD" "$PARENT" > "$META3"
BEFORE_P="$(cat "$SESSDIR/$PARENT.jsonl")"; BEFORE_C="$(cat "$SESSDIR/$CHILD.jsonl")"
ls "$SESSDIR" | sort > "$TMP/before-listing.txt"                    # snapshot BEFORE index-write ever runs (C3: it must add INDEX.md, never touch the transcripts)
OUTIDX="$SESSDIR/INDEX.md"   # matches real usage: sessions-sync.sh's write_index() writes INDEX.md INTO the same dir it reads transcripts from
CL_META="$META3" CL_SESSDIR="$SESSDIR" CL_OUT="$OUTIDX" node "$TOOL" index-write
IDX="$(cat "$OUTIDX")"
contains "$IDX" '| Session | Started | Last active | Id |' "index-write emits the plan's table header"
contains "$IDX" "\`${PARENT:0:8}\`" "index-write includes the parent's short id"
contains "$IDX" "\`${CHILD:0:8}\`" "index-write includes the child's short id"
contains "$IDX" '↳ continued after /clear' "index-write emits the continued-child row"
contains "$IDX" 'DERIVED' "index-write header documents the file as derived/regenerable"
# the child row must come AFTER the parent row (nested directly under it, not sorted away)
PPOS=$(printf '%s\n' "$IDX" | grep -n "${PARENT:0:8}" | head -1 | cut -d: -f1)
CPOS=$(printf '%s\n' "$IDX" | grep -n "${CHILD:0:8}" | head -1 | cut -d: -f1)
[ "$CPOS" -gt "$PPOS" ] 2>/dev/null && { pass=$((pass+1)); } || { fail=$((fail+1)); echo "  FAIL: child row not after parent row"; }

# --- (c) the plan's named inverse test: a real new session (no continuesFrom) gets its own plain row -----
SOLO="99999999-aaaa-bbbb-cccc-000000000003"
SESSDIR2="$TMP/c-sessions"; mkdir -p "$SESSDIR2"
printf '{"type":"user","message":{"content":"hi"}}\n' > "$SESSDIR2/$SOLO.jsonl"
META4="$TMP/c-meta.json"
printf '{"%s": {"title": "Solo Session", "ts": 1}}' "$SOLO" > "$META4"
OUTIDX2="$TMP/c-INDEX.md"
CL_META="$META4" CL_SESSDIR="$SESSDIR2" CL_OUT="$OUTIDX2" node "$TOOL" index-write
IDX2="$(cat "$OUTIDX2")"
contains "$IDX2" "\`${SOLO:0:8}\`" "solo session's short id appears"
contains "$IDX2" 'Solo Session' "solo session's own title is used as the row label"
not_contains "$IDX2" '↳' "a real new session never gets a continued/child row"

# --- (d) C3: index-write never touches (renames, rewrites) the transcript files it read -------------------
# Re-run it (idempotency) and compare against the BEFORE-index-write snapshot taken above.
CL_META="$META3" CL_SESSDIR="$SESSDIR" CL_OUT="$OUTIDX" node "$TOOL" index-write
ls "$SESSDIR" | sort > "$TMP/after-listing.txt"
AFTER_P="$(cat "$SESSDIR/$PARENT.jsonl")"
AFTER_C="$(cat "$SESSDIR/$CHILD.jsonl")"
ok "$BEFORE_P" "$AFTER_P" "index-write leaves the parent transcript byte-identical"
ok "$BEFORE_C" "$AFTER_C" "index-write leaves the child transcript byte-identical"
# set-difference (after minus before) must be exactly INDEX.md — nothing renamed, nothing else added/removed
NEW="$(grep -vFxf "$TMP/before-listing.txt" "$TMP/after-listing.txt")"
ok "$NEW" "INDEX.md" "index-write only ADDS INDEX.md to the directory — no transcript is renamed (C3)"
GONE="$(grep -vFxf "$TMP/after-listing.txt" "$TMP/before-listing.txt")"
ok "$GONE" "" "index-write never removes/renames-away an existing transcript filename (C3)"

echo "sessions-lineage-index: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
