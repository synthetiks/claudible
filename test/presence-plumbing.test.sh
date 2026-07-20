#!/usr/bin/env bash
# test/presence-plumbing.test.sh — the worktree-free presence path (presence-set / presence-starting /
# presence-clear) against a REAL bare origin. These ops commit directly on the object graph (mktree +
# commit-tree + push) so a stamp can never wait behind a running sync and the app-quit clear can never die
# on an index.lock corpse — the two field-observed causes of slow/zombie live rows. Proves, with real git:
#   · a stamp lands on origin and carries the right payload (url variant + starting variant)
#   · a STALE local view still lands (push rejected → fetch → rebuild → retry) WITHOUT clobbering the
#     commit that beat us (the non-destructive property the whole shared branch depends on)
#   · a fresh index.lock in the clone does not block a stamp (the quit-path regression)
#   · the one-host arbiter still refuses a fresh rival claim
#   · clear removes exactly my blob; clearing when already clear is an honest ok
# Run: bash test/presence-plumbing.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/wsl/sessions-sync.sh"
unset CLAUDIBLE_WS_DIR CLAUDIBLE_PROJ 2>/dev/null || true
pass=0; fail=0
ok() { if [ "$1" = "$2" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL $3: expected [$2] got [$1]"; fi; }
okc() { if eval "$1" >/dev/null 2>&1; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL $2"; fi; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP"
mkdir -p "$TMP/bin"
printf '#!/usr/bin/env bash\necho tester\n' > "$TMP/bin/gh"; chmod +x "$TMP/bin/gh"   # author = tester
export PATH="$TMP/bin:$PATH"
export CLAUDIBLE_WS_KIND=repo CLAUDIBLE_WS_SLUG=testws
export GIT_CONFIG_NOSYSTEM=1

BR=claudible/sessions
ORIGIN="$TMP/origin.git"
git init -q --bare "$ORIGIN"

# Seed the sessions branch from a scratch clone: a rival-free live/ dir plus unrelated content that every
# later presence commit must PRESERVE (meta/, sessions/ — proving the tree rewrite is surgical).
SCRATCH="$TMP/scratch"
git init -q "$SCRATCH"; git -C "$SCRATCH" checkout -q --orphan "$BR"
mkdir -p "$SCRATCH/live" "$SCRATCH/meta" "$SCRATCH/sessions"
printf 'sessions/**/*.jsonl binary\n' > "$SCRATCH/.gitattributes"
printf '{"keep":"me"}\n' > "$SCRATCH/meta/other.json"
: > "$SCRATCH/sessions/.gitkeep"
git -C "$SCRATCH" add -A
git -C "$SCRATCH" -c user.name=seed -c user.email=seed@x commit -qm seed
git -C "$SCRATCH" remote add origin "$ORIGIN"
git -C "$SCRATCH" push -q origin "$BR"

# The workspace clone the script operates on.
SDIR="$TMP/.claudible/repos/testws"
git clone -q "$ORIGIN" "$SDIR" 2>/dev/null || { git init -q "$SDIR"; git -C "$SDIR" remote add origin "$ORIGIN"; }
git -C "$SDIR" fetch -q origin "$BR"

run() { bash "$SCRIPT" "$@" 2>/dev/null; }
oshow() { git -C "$ORIGIN" show "$BR:$1" 2>/dev/null; }

# ---- 1. full stamp lands on origin with the right payload ----
out="$(run presence-set 'sid-1' 'https://x.trycloudflare.com' 'tok1' '')"
ok "$out" '{"ok":true,"op":"presence-set"}' 'presence-set emits ok'
okc '[ -n "$(oshow live/tester.json)" ]' 'stamp blob exists on origin'
okc 'oshow live/tester.json | grep -q "\"session\":\"sid-1\""' 'stamp carries the session id'
okc 'oshow live/tester.json | grep -q "\"url\":\"https://x.trycloudflare.com\""' 'stamp carries the tunnel url'
okc 'oshow .gitattributes | grep -q binary' 'unrelated root entries survive the tree rewrite'
okc 'oshow meta/other.json | grep -q keep' 'unrelated subtrees survive the tree rewrite'

# ---- 1b. build sha (arg 6) rides the stamp; junk sha is dropped, not injected ----
out="$(run presence-set 'sid-1' 'https://x.trycloudflare.com' 'tok1' '' 'abc123abc123')"
ok "$out" '{"ok":true,"op":"presence-set"}' 'presence-set with sha emits ok'
okc 'oshow live/tester.json | grep -q "\"sha\":\"abc123abc123\""' 'stamp carries the publisher build sha'
out="$(run presence-set 'sid-1' 'https://x.trycloudflare.com' 'tok1' '' 'NOT$AFE')"
okc 'oshow live/tester.json | grep -q "\"sha\":\"\""' 'junk sha is emptied, never injected'

# ---- 2. starting variant: url-less, starting:true ----
out="$(run presence-starting 'sid-1' '')"
ok "$out" '{"ok":true,"op":"presence-starting"}' 'presence-starting emits ok'
okc 'oshow live/tester.json | grep -q "\"starting\":true"' 'starting stamp is flagged'
okc '! oshow live/tester.json | grep -q "\"url\""' 'starting stamp has no url'

# ---- 3. STALE local view: someone pushed after our last fetch → reject → fetch → rebuild → land, non-destructively ----
git -C "$SCRATCH" pull -q origin "$BR" 2>/dev/null                 # scratch must build on the branch the script's stamps advanced
printf '{"login":"daisy","session":"other","ts":1}\n' > "$SCRATCH/live/daisy.json"
git -C "$SCRATCH" add -A && git -C "$SCRATCH" -c user.name=d -c user.email=d@x commit -qm rival-file && git -C "$SCRATCH" push -q origin "$BR"
out="$(run presence-set 'sid-2' 'https://y.trycloudflare.com' 'tok2' '')"   # SDIR's origin ref is now stale
ok "$out" '{"ok":true,"op":"presence-set"}' 'stale-base stamp still lands (reject→fetch→retry)'
okc 'oshow live/tester.json | grep -q "\"session\":\"sid-2\""' 'retried stamp carries the new session'
okc 'oshow live/daisy.json | grep -q other' "the commit that beat us survives (non-destructive rebuild)"

# ---- 4. index.lock immunity: the app-quit regression ----
touch "$SDIR/.git/index.lock"
out="$(run presence-set 'sid-3' 'https://z.trycloudflare.com' 'tok3' '')"
ok "$out" '{"ok":true,"op":"presence-set"}' 'a FRESH index.lock does not block a plumbing stamp'
rm -f "$SDIR/.git/index.lock"

# ---- 5. one-host arbiter: a fresh rival claim refuses ----
git -C "$SCRATCH" pull -q origin "$BR" 2>/dev/null
printf '{"login":"daisy","session":"sid-4","name":"Daisy","ts":%s}\n' "$(date +%s)" > "$SCRATCH/live/daisy.json"
git -C "$SCRATCH" add -A && git -C "$SCRATCH" -c user.name=d -c user.email=d@x commit -qm rival-claim && git -C "$SCRATCH" push -q origin "$BR"
git -C "$SDIR" fetch -q origin "$BR"
out="$(run presence-set 'sid-4' 'https://w.trycloudflare.com' 'tok4' '')"
okc 'printf %s "$out" | grep -q "\"error\":\"already-live\""' 'fresh rival claim → already-live refusal'
okc 'printf %s "$out" | grep -q "\"by\":\"Daisy\""' 'refusal names the holder'

# ---- 6. clear removes exactly my blob; already-clear is an honest ok ----
out="$(run presence-clear)"
ok "$out" '{"ok":true,"op":"presence-clear"}' 'presence-clear emits ok'
okc '! git -C "$ORIGIN" cat-file -e "$BR:live/tester.json"' 'my blob is gone from origin'
okc 'oshow live/daisy.json | grep -q sid-4' "clear did not touch the rival's blob"
git -C "$SDIR" fetch -q origin "$BR"
out="$(run presence-clear)"
ok "$out" '{"ok":true,"op":"presence-clear"}' 'clearing when already clear is an honest ok'

echo "presence-plumbing: $pass passed, $fail failed"
exit "$((fail ? 1 : 0))"
