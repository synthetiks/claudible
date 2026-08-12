#!/usr/bin/env bash
# test/delete-safety.test.sh — deleting work that exists nowhere else must REFUSE, not warn.
#
# Three layers share one override env, CLAUDIBLE_FORCE_DELETE=1, which ONLY the user's second, explicit
# "delete anyway" confirm ever sets:
#   * wsl/delete-workspace.sh — a repo folder with uncommitted changes, or commits the upstream never saw,
#     refuses the trash-move outright (the renderer then asks a second time).
#   * wsl/delete-session.sh   — a transcript that has not reached the sessions-sync worktree yet refuses the
#     same way; CLAUDIBLE_CHECK_ONLY=1 answers that question WITHOUT deleting, so the renderer can ask before
#     it re-points tabs and ends a live share (a refusal after that teardown is not a refusal).
#   * wsl/trash-prune.sh      — a trashed repo still holding unsaved work outlives the age AND size caps;
#     only the user-confirmed "Delete trash" (CLAUDIBLE_TRASH_EMPTY_ALL) purges it.
#
# Every case drives the REAL scripts against a throwaway $HOME, and every destructive case plants a CANARY
# outside the managed directories that must survive. Run: bash test/delete-safety.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DELWS="$ROOT/wsl/delete-workspace.sh"
DELSESS="$ROOT/wsl/delete-session.sh"
PRUNE="$ROOT/wsl/trash-prune.sh"
pass=0; fail=0
ok() { if [ "$1" = "$2" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL $3: expected [$2] got [$1]"; fi; }
has() { case "$1" in *"$2"*) echo yes ;; *) echo no ;; esac; }
json() { printf '%s' "$1" | sed -n "s/.*\"$2\":\([0-9]*\).*/\1/p"; }
there() { if [ -e "$1" ]; then echo kept; else echo gone; fi; }

if ! command -v git >/dev/null 2>&1; then echo "delete-safety: SKIP (no git on PATH)"; exit 0; fi
# Identity + defaults inline, never from the machine: the sandbox $HOME has no config, and a developer's global
# commit.gpgsign / init.defaultBranch must not decide whether this test can commit.
G() { git -c user.email=t@example.invalid -c user.name=claudible-test -c commit.gpgsign=false -c init.defaultBranch=main "$@"; }

# a sandbox $HOME with the managed dirs and a CANARY that must never be touched
mkbox() { local d; d="$(mktemp -d)"; mkdir -p "$d/.claudible/repos" "$d/.claudible/trash" "$d/CANARY"; echo precious > "$d/CANARY/data.txt"; printf '%s' "$d"; }
canary_ok() { if [ -f "$1/CANARY/data.txt" ] && [ "$(cat "$1/CANARY/data.txt")" = precious ]; then echo intact; else echo DESTROYED; fi; }

# --- 1. a project with uncommitted work refuses, and the override deletes it ---------------------------------
B="$(mkbox)"; D="$B/.claudible/repos/demo-proj"
G init -q "$D" >/dev/null 2>&1
echo wip > "$D/notes.txt"
out="$(HOME="$B" bash "$DELWS" repo demo-proj 'Demo Proj')"
ok "$(has "$out" '"needsForce":true')" "yes" "an uncommitted change refuses the delete"
ok "$(has "$out" '"ok":false')" "yes" "…and reports it as a refusal, not a success"
ok "$(there "$D")" "kept" "…leaving the project folder exactly where it was"
out="$(HOME="$B" CLAUDIBLE_FORCE_DELETE=1 bash "$DELWS" repo demo-proj 'Demo Proj')"
ok "$(has "$out" '"ok":true')" "yes" "the explicit override deletes anyway"
ok "$(there "$D")" "gone" "…the folder leaves ~/.claudible/repos"
ok "$(ls "$B/.claudible/trash" | wc -l | tr -d ' ')" "1" "…into the trash (recoverable), not into nothing"
ok "$(canary_ok "$B")" "intact" "…and nothing outside the managed dirs is touched"
rm -rf "$B"

# --- 2. a clean, fully-pushed project deletes with no second confirm -----------------------------------------
#     The upstream is a bare repo on disk: no network, no gh, no credentials — only the @{u}..HEAD arithmetic
#     the refusal actually depends on.
B="$(mkbox)"; D="$B/.claudible/repos/clean-proj"
G init -q "$D" >/dev/null 2>&1
echo hi > "$D/f.txt"; G -C "$D" add -A >/dev/null 2>&1; G -C "$D" commit -qm init >/dev/null 2>&1
G init -q --bare "$B/up.git" >/dev/null 2>&1
G -C "$D" remote add origin "$B/up.git" >/dev/null 2>&1
G -C "$D" push -q -u origin HEAD >/dev/null 2>&1
out="$(HOME="$B" bash "$DELWS" repo clean-proj 'Clean Proj')"
ok "$(has "$out" '"ok":true')" "yes" "a clean, fully-pushed project needs no second confirm"
ok "$(there "$D")" "gone" "…and is trashed on the first ask"
rm -rf "$B"

# --- 3. a commit the upstream never saw refuses, and says how many -------------------------------------------
B="$(mkbox)"; D="$B/.claudible/repos/ahead-proj"
G init -q "$D" >/dev/null 2>&1
echo hi > "$D/f.txt"; G -C "$D" add -A >/dev/null 2>&1; G -C "$D" commit -qm init >/dev/null 2>&1
G init -q --bare "$B/up.git" >/dev/null 2>&1
G -C "$D" remote add origin "$B/up.git" >/dev/null 2>&1
G -C "$D" push -q -u origin HEAD >/dev/null 2>&1
echo more > "$D/f2.txt"; G -C "$D" add -A >/dev/null 2>&1; G -C "$D" commit -qm second >/dev/null 2>&1
out="$(HOME="$B" bash "$DELWS" repo ahead-proj 'Ahead Proj')"
ok "$(has "$out" '"needsForce":true')" "yes" "a commit that never reached the remote refuses the delete"
ok "$(has "$out" '"unpushed":1')" "yes" "…and counts it, so the confirm can say what is at stake"
ok "$(there "$D")" "kept" "…with the folder untouched"
rm -rf "$B"

# --- 4. session delete: unsynced refuses, and the pre-flight probe deletes nothing ----------------------------
B="$(mkbox)"; P="$B/.claude/projects/P"; mkdir -p "$P"
printf '{}\n' > "$P/sess-abc.jsonl"
mkdir -p "$B/.claudible/sessions-sync/demo-proj/sessions/me"          # sync IS on for this workspace…
out="$(HOME="$B" CLAUDIBLE_PROJ=P CLAUDIBLE_WS_KIND=repo CLAUDIBLE_WS_SLUG=demo-proj bash "$DELSESS" sess-abc)"
ok "$(has "$out" '"needsForce":true')" "yes" "a conversation that has not reached GitHub refuses the delete"
ok "$(there "$P/sess-abc.jsonl")" "kept" "…and the transcript stays on disk"
# the pre-flight the renderer runs BEFORE it re-points tabs / ends a share: same answer, nothing moved
out="$(HOME="$B" CLAUDIBLE_CHECK_ONLY=1 CLAUDIBLE_PROJ=P CLAUDIBLE_WS_KIND=repo CLAUDIBLE_WS_SLUG=demo-proj bash "$DELSESS" sess-abc)"
ok "$(has "$out" '"needsForce":true')" "yes" "the pre-flight probe reports the same refusal"
ok "$(there "$P/sess-abc.jsonl")" "kept" "…without deleting anything"
# once a synced copy exists the refusal lifts — but a probe STILL deletes nothing
printf '{}\n' > "$B/.claudible/sessions-sync/demo-proj/sessions/me/sess-abc.jsonl"
out="$(HOME="$B" CLAUDIBLE_CHECK_ONLY=1 CLAUDIBLE_PROJ=P CLAUDIBLE_WS_KIND=repo CLAUDIBLE_WS_SLUG=demo-proj bash "$DELSESS" sess-abc)"
ok "$(has "$out" '"check":true')" "yes" "a passing pre-flight answers ok, not a delete"
ok "$(there "$P/sess-abc.jsonl")" "kept" "…and still deletes nothing"
out="$(HOME="$B" CLAUDIBLE_PROJ=P CLAUDIBLE_WS_KIND=repo CLAUDIBLE_WS_SLUG=demo-proj bash "$DELSESS" sess-abc)"
ok "$(has "$out" '"ok":true')" "yes" "the real delete then goes through"
ok "$(there "$P/sess-abc.jsonl")" "gone" "…and the transcript is soft-deleted"
rm -rf "$B"

# --- 5. trash-prune keeps a dirty trashed repo past the age cap; only Delete trash purges it ------------------
B="$(mkbox)"; T="$B/.claudible/trash"
G init -q "$T/ws-repo-dirty" >/dev/null 2>&1
echo wip > "$T/ws-repo-dirty/wip.txt"
echo old > "$T/plain.jsonl"
touch -d "60 days ago" "$T/plain.jsonl"
touch -d "60 days ago" "$T/ws-repo-dirty"
out="$(HOME="$B" bash "$PRUNE")"
ok "$(there "$T/ws-repo-dirty")" "kept" "an aged trashed repo holding unsaved work outlives the age cap"
ok "$(json "$out" keptDirty)" "1" "…and the sweep reports it kept"
ok "$(there "$T/plain.jsonl")" "gone" "…while an ordinary aged entry still goes"
out="$(HOME="$B" CLAUDIBLE_TRASH_EMPTY_ALL=1 bash "$PRUNE")"
ok "$(there "$T/ws-repo-dirty")" "gone" "the user-confirmed Delete trash IS the override"
ok "$(canary_ok "$B")" "intact" "…and it still never leaves the trash"
rm -rf "$B"

echo "delete-safety: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
