#!/usr/bin/env bash
# test/diff-commits.test.sh — the "commit history" panel must list a repo's recent commits.
#
# It never did, for most real repos. Five ways it silently reported "no changes" while commits existed:
#   1. commit + revert in the same week → the NET diff is empty → the commit list was gated on that diff
#   2. a big week (net diff > 110KB) → diff.sh drops the diff on purpose → list vanished with it
#   3. ANY merge commit → the count used `--since` (walks all parents) but the fetch used `HEAD~N`
#      (first-parent only); on a merge `HEAD~N` doesn't exist, git errored into /dev/null → zero commits
#   4. a repo whose whole history fits in the window → the `ccount-1` root clamp dropped the OLDEST commit
#   5. a repo with exactly one commit → the `ccount > 1` guard skipped the log entirely
#
# Each case builds a throwaway repo, runs the REAL wsl/diff.sh against it, and asserts the emitted JSON both
# counts (`week`) and lists (`commits`) what git actually did. Run: bash test/diff-commits.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIFF_SH="$ROOT/wsl/diff.sh"
pass=0; fail=0

command -v node >/dev/null 2>&1 || { echo "diff-commits: node not on PATH — skipping"; exit 0; }

# Emit "week commits committed_files window" for a repo dir, via the real script.
probe() {
  CLAUDIBLE_WS_KIND=local CLAUDIBLE_WS_DIR="$1" bash "$DIFF_SH" 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let j; try { j = JSON.parse(s); } catch { console.log("PARSE_FAIL"); return; }
      if (!j.ok) { console.log("NOT_OK"); return; }
      console.log([j.week, (j.commits || []).length, (j.committed || []).length, j.window].join(" "));
    });'
}
# Emit an arbitrary field of the JSON (dotted path unsupported — top level only), or a JS expression over `j`.
field() { CLAUDIBLE_WS_KIND=local CLAUDIBLE_WS_DIR="$1" bash "$DIFF_SH" 2>/dev/null | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    let j; try { j = JSON.parse(s); } catch { console.log("PARSE_FAIL"); return; }
    console.log(String(eval(process.argv[1])));
  });' "$2"; }
ok() { if [ "$1" = "$2" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL $3: expected [$2] got [$1]"; fi; }

# A fixture's branch name must NOT depend on the machine: git falls back to `master` when init.defaultBranch is
# unset (every CI runner), and to `main` on a configured dev box. `symbolic-ref HEAD` on an unborn repo pins it on
# ANY git version — `git init -b` would need >= 2.28. The product is branch-agnostic; the assertions below aren't.
gitinit() { git init -q ${2:+--bare} "$1"; git -C "$1" symbolic-ref HEAD refs/heads/main; }
newrepo() {   # echoes a fresh repo dir with an initial commit
  local d; d="$(mktemp -d)"
  gitinit "$d"
  git -C "$d" config user.email t@t; git -C "$d" config user.name T
  git -C "$d" config commit.gpgsign false
  echo root > "$d/root.txt"; git -C "$d" add -A; git -C "$d" commit -qm "root commit"
  printf '%s' "$d"
}

# --- 1. commit then revert: the week's NET diff is empty, but three commits happened ---
D="$(newrepo)"
echo tmp > "$D/tmp.txt"; git -C "$D" add -A; git -C "$D" commit -qm "add tmp"
git -C "$D" rm -q tmp.txt; git -C "$D" commit -qm "remove tmp"
r="$(probe "$D")"; ok "$(echo "$r" | cut -d' ' -f1-2)" "3 3" "net-zero week still lists its 3 commits"
ok "$(echo "$r" | cut -d' ' -f4)" "week" "…and reports the 7-day window"
rm -rf "$D"

# --- 2. a commit far bigger than the 110KB net-diff cap: diff dropped, list must survive ---
D="$(newrepo)"
node -e 'require("fs").writeFileSync(process.argv[1], "lorem ipsum dolor sit amet consectetur\n".repeat(4000))' "$D/big.txt"
git -C "$D" add -A; git -C "$D" commit -qm "big commit"
r="$(probe "$D")"
ok "$(echo "$r" | cut -d' ' -f1-2)" "2 2" "oversized week still lists its commits"
ok "$(echo "$r" | cut -d' ' -f3)" "0" "oversized net diff is dropped (as designed)"
rm -rf "$D"

# --- 3. a MERGE commit: --since counts 7, first-parent depth is only 2 (the killer) ---
D="$(newrepo)"
git -C "$D" checkout -qb feat
for i in 1 2 3 4 5; do echo "l$i" >> "$D/f2.txt"; git -C "$D" add -A; git -C "$D" commit -qm "feat $i"; done
git -C "$D" checkout -q -; git -C "$D" merge -q --no-ff feat -m "merge feat"
r="$(probe "$D")"; ok "$(echo "$r" | cut -d' ' -f1-2)" "7 7" "a merged branch lists every commit (HEAD~N would have failed)"
rm -rf "$D"

# --- 4. whole history inside the window: the oldest commit must NOT be dropped ---
D="$(mktemp -d)"
gitinit "$D"; git -C "$D" config user.email t@t; git -C "$D" config user.name T; git -C "$D" config commit.gpgsign false
echo a > "$D/a.txt"; git -C "$D" add -A; git -C "$D" commit -qm "first"
echo b >> "$D/a.txt"; git -C "$D" commit -qam "second"
r="$(probe "$D")"; ok "$(echo "$r" | cut -d' ' -f1-2)" "2 2" "young repo keeps its oldest commit"
rm -rf "$D"

# --- 5. exactly one commit ever (the root) — the old `ccount > 1` guard hid it ---
D="$(mktemp -d)"
gitinit "$D"; git -C "$D" config user.email t@t; git -C "$D" config user.name T; git -C "$D" config commit.gpgsign false
echo only > "$D/a.txt"; git -C "$D" add -A; git -C "$D" commit -qm "the only commit"
r="$(probe "$D")"; ok "$(echo "$r" | cut -d' ' -f1-2)" "1 1" "a lone root commit is listed"
rm -rf "$D"

# --- 6. a QUIET repo: zero commits this week, but a history that exists. The 7-day window was always a display
#        choice, never a fact about the repo — reporting "no commits" for a repo you touch monthly is a lie, and
#        it's exactly what made this panel look permanently dead. `week` must stay honest (0) while the list falls
#        back to the latest commits and says so (`window: "latest"`).
#        NB: `git log/rev-list --since` filters on the COMMITTER date, not the author date — so the fixture must
#        backdate BOTH (a `--date=` amend moves only the author date, leaving the commit "today" to --since).
D="$(mktemp -d)"
gitinit "$D"; git -C "$D" config user.email t@t; git -C "$D" config user.name T; git -C "$D" config commit.gpgsign false
echo old > "$D/a.txt"; git -C "$D" add -A
# an ABSOLUTE date (git rejects "30 days ago" for GIT_*_DATE); comfortably outside any 7-day window
GIT_AUTHOR_DATE="2020-01-01T00:00:00" GIT_COMMITTER_DATE="2020-01-01T00:00:00" git -C "$D" commit -qm "an old commit"
lifetime="$(git -C "$D" rev-list --count HEAD 2>/dev/null || echo 0)"
ok "$lifetime" "1" "the backdated commit actually landed (else the next assert passes for the wrong reason)"
r="$(probe "$D")"
ok "$(echo "$r" | cut -d' ' -f1)" "0" "a repo with no commits this week reports week=0"
ok "$(echo "$r" | cut -d' ' -f2,4)" "1 latest" "…but still LISTS its latest commit, flagged as the latest-window"
# the net diff of that fallback window is real: its base is the oldest listed commit's parent (here: none → empty tree)
ok "$(echo "$r" | cut -d' ' -f3)" "1" "the latest-window carries a net diff (root commit → empty-tree base)"
rm -rf "$D"

# --- 6b. the latest-window is capped at 20 and its diff base is the OLDEST LISTED commit's parent, not the root ---
D="$(mktemp -d)"
gitinit "$D"; git -C "$D" config user.email t@t; git -C "$D" config user.name T; git -C "$D" config commit.gpgsign false
for i in $(seq 1 25); do
  echo "line $i" >> "$D/a.txt"; git -C "$D" add -A
  GIT_AUTHOR_DATE="2020-01-01T00:00:00" GIT_COMMITTER_DATE="2020-01-01T00:00:00" git -C "$D" commit -qm "old $i"
done
r="$(probe "$D")"; ok "$(echo "$r" | cut -d' ' -f1,2,4)" "0 20 latest" "an old 25-commit repo lists its latest 20"
ok "$(field "$D" 'j.total')" "25" "…while the lifetime tally still counts all 25"
rm -rf "$D"

# --- 7. not a git repo at all → repo:false, never a crash ---
D="$(mktemp -d)"
out="$(CLAUDIBLE_WS_KIND=local CLAUDIBLE_WS_DIR="$D" bash "$DIFF_SH" 2>/dev/null)"
case "$out" in *'"repo": false'*|*'"repo":false'*) pass=$((pass+1)) ;; *) fail=$((fail+1)); echo "  FAIL non-repo reports repo:false (got: ${out:0:80})" ;; esac
rm -rf "$D"

# --- 8a. a huge UNTRACKED tree (un-ignored node_modules/dist) must not kill the whole read. The path list is
#         passed as ONE env var to node; over ~128KB (MAX_ARG_STRLEN) the exec dies "Argument list too long" and
#         a repo full of real commits reported nothing. Only the two diffs were capped; untracked was exempt.
D="$(newrepo)"
echo z >> "$D/root.txt"; git -C "$D" commit -qam "a real commit"
node -e '
  const fs = require("fs"), p = process.argv[1] + "/node_modules/pkg/deeply/nested";
  fs.mkdirSync(p, { recursive: true });
  for (let i = 0; i < 6000; i++) fs.writeFileSync(p + "/some_long_module_filename_" + i + ".js", "x");' "$D"
bytes="$(git -C "$D" ls-files --others --exclude-standard | wc -c)"
ok "$([ "$bytes" -gt 130000 ] && echo big || echo small)" "big" "fixture really does exceed MAX_ARG_STRLEN ($bytes bytes)"
r="$(probe "$D")"; ok "$(echo "$r" | cut -d' ' -f1-2)" "2 2" "a huge untracked tree still lists the repo's commits"
unt="$(CLAUDIBLE_WS_KIND=local CLAUDIBLE_WS_DIR="$D" bash "$DIFF_SH" 2>/dev/null | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s); console.log((j.untracked||[]).length);});')"
ok "$unt" "200" "the untracked list is bounded, not dropped"
rm -rf "$D"

# --- 8b. diff.sh must survive being invoked by a RELATIVE path: it cd's into the repo, so `dirname $0` used to
#         resolve diff-tool.js against the WORKSPACE (MODULE_NOT_FOUND), which the old fallback then reported as a
#         healthy empty repo. Run it as `bash wsl/diff.sh` from the app root, the way a careless caller would.
D="$(newrepo)"
echo z >> "$D/root.txt"; git -C "$D" commit -qam "rel-path commit"
rel="$(cd "$ROOT" && CLAUDIBLE_WS_KIND=local CLAUDIBLE_WS_DIR="$D" bash wsl/diff.sh 2>/dev/null | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s); console.log([j.ok===true,(j.commits||[]).length].join(" "));});')"
ok "$rel" "true 2" "a relative-path invocation still finds diff-tool.js (no masked MODULE_NOT_FOUND)"
rm -rf "$D"

# --- 8. the commit list carries real metadata (hash/subject/author/date), not blanks ---
D="$(newrepo)"
echo z >> "$D/root.txt"; git -C "$D" commit -qam "a meaningful subject"
meta="$(CLAUDIBLE_WS_KIND=local CLAUDIBLE_WS_DIR="$D" bash "$DIFF_SH" 2>/dev/null | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s); const c=(j.commits||[])[0]||{};
    console.log([!!c.hash, c.subject === "a meaningful subject", c.author === "T", /^\d{4}-\d{2}-\d{2}$/.test(c.date||"")].join(" "));});')"
ok "$meta" "true true true true" "each commit carries hash, subject, author, ISO date"
# the displayed date must be the COMMITTER date — the same clock `--since` filtered on. An amended/rebased commit
# would otherwise be listed under "last 7 days" while showing an author date from months ago.
D2="$(mktemp -d)"
gitinit "$D2"; git -C "$D2" config user.email t@t; git -C "$D2" config user.name T; git -C "$D2" config commit.gpgsign false
echo a > "$D2/a.txt"; git -C "$D2" add -A
GIT_AUTHOR_DATE="2020-03-04T00:00:00" git -C "$D2" commit -qm "old author date, committed today"
today="$(date +%Y-%m-%d)"
shown="$(CLAUDIBLE_WS_KIND=local CLAUDIBLE_WS_DIR="$D2" bash "$DIFF_SH" 2>/dev/null | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s); console.log(((j.commits||[])[0]||{}).date||"");});')"
ok "$shown" "$today" "a rebased/amended commit shows its committer date (matches the --since window)"
rm -rf "$D2"
rm -rf "$D"

# ===========================================================================================================
# 9. WHAT GITHUB HAS. `origin/<branch>` after a fetch IS the history github.com shows for that branch, so the
#    panel compares HEAD against that ref rather than calling the API: no token, works offline, and — unlike the
#    API — it can still see the commits GitHub has never been told about. Every assert below is about not lying:
#    a commit is only ever marked "not on GitHub" when there is a real upstream to have missed it.
# ===========================================================================================================
withupstream() {   # echoes "<tmpdir>" containing work/ (branch main) and bare.git, with work tracking origin/main
  local d b; d="$(mktemp -d)"; b="$d/bare.git"
  gitinit "$b" bare
  gitinit "$d/work"
  git -C "$d/work" config user.email t@t; git -C "$d/work" config user.name T; git -C "$d/work" config commit.gpgsign false
  echo one > "$d/work/a.txt"; git -C "$d/work" add -A; git -C "$d/work" commit -qm "pushed commit"
  git -C "$d/work" remote add origin "$b"
  git -C "$d/work" push -q -u origin main
  printf '%s' "$d"
}

# --- 9a. two local commits the remote has never seen: ahead=2, and exactly those two are flagged unpushed ---
D="$(withupstream)"; W="$D/work"
echo two >> "$W/a.txt"; git -C "$W" commit -qam "local only 1"
echo three >> "$W/a.txt"; git -C "$W" commit -qam "local only 2"
ok "$(field "$W" 'j.ahead')" "2" "two unpushed commits → ahead=2"
ok "$(field "$W" 'j.behind')" "0" "…and nothing to pull"
ok "$(field "$W" 'j.upstream')" "origin/main" "the upstream ref is reported by name"
ok "$(field "$W" 'j.branch')" "main" "…alongside the local branch"
# newest-first: [local only 2, local only 1, pushed commit]
ok "$(field "$W" 'j.commits.map(c=>c.pushed).join(",")')" "false,false,true" "exactly the unpushed commits are flagged"
rm -rf "$D"

# --- 9b. `pushed` uses FULL 40-char hashes. `%h`'s abbreviation length is dynamic (git grows it past 7 chars on a
#         large repo), so a set-membership test on abbreviated hashes would silently stop matching. Pin that the
#         CLOG carries %H and that the emitted `hash` is still the SHORT one the UI renders.
D="$(withupstream)"; W="$D/work"
echo two >> "$W/a.txt"; git -C "$W" commit -qam "local only"
ok "$(field "$W" '/^[0-9a-f]{7,}$/.test(j.commits[0].hash) && j.commits[0].hash.length < 40')" "true" "the UI still gets the short hash"
ok "$(field "$W" 'j.commits[0].pushed === false')" "true" "…and its push state, resolved against full hashes"
rm -rf "$D"

# --- 9c. the remote moved on: behind counts what GitHub has that we don't ---
D="$(withupstream)"; W="$D/work"
git clone -q "$D/bare.git" "$D/other"
git -C "$D/other" config user.email t@t; git -C "$D/other" config user.name T; git -C "$D/other" config commit.gpgsign false
echo remote >> "$D/other/a.txt"; git -C "$D/other" commit -qam "someone else pushed this"; git -C "$D/other" push -q origin main
git -C "$W" fetch -q origin main
ok "$(field "$W" 'j.behind')" "1" "a commit pushed by someone else → behind=1"
ok "$(field "$W" 'j.ahead')" "0" "…with nothing of our own to push"
rm -rf "$D"

# --- 9d. NO upstream (the normal state of a local-only repo). The panel must say NOTHING rather than mark every
#         commit "not on GitHub": `pushed` is absent, not false, and ahead/behind aren't emitted at all.
D="$(newrepo)"
ok "$(field "$D" 'j.upstream')" "" "a local-only repo reports no upstream"
ok "$(field "$D" '"ahead" in j')" "false" "…emits no ahead count"
ok "$(field "$D" '"behind" in j')" "false" "…emits no behind count"
ok "$(field "$D" 'j.commits.every(c => !("pushed" in c))')" "true" "…and never claims a commit is missing from GitHub"
rm -rf "$D"

# --- 9e. an upstream CONFIGURED but never fetched. `@{u}` resolves from config alone, so it names a ref that
#         doesn't exist locally; every rev-list against it fatals. Treat it as "no upstream", never as ahead=0.
D="$(newrepo)"
br="$(git -C "$D" symbolic-ref --short HEAD)"
git -C "$D" remote add origin https://github.com/definitely-does-not-exist-xyz/nope.git
git -C "$D" config "branch.$br.remote" origin
git -C "$D" config "branch.$br.merge" "refs/heads/$br"
ok "$(field "$D" 'j.ok')" "true" "a configured-but-never-fetched upstream doesn't break the read"
ok "$(field "$D" 'j.upstream')" "" "…and is reported as no upstream (the ref isn't here)"
ok "$(field "$D" 'j.commits.every(c => !("pushed" in c))')" "true" "…so no commit is labelled either way"
rm -rf "$D"

# --- 9f. a DETACHED HEAD has no branch and no upstream, and must still read cleanly ---
D="$(newrepo)"
git -C "$D" checkout -q --detach HEAD
ok "$(field "$D" 'j.ok')" "true" "a detached HEAD still reads"
ok "$(field "$D" 'j.branch')" "" "…with an empty branch name (never the literal string HEAD)"
rm -rf "$D"

# --- 9g. an UNBORN HEAD (git init, nothing committed). `git rev-list --count HEAD` FATALS here — it does not
#         print 0 — so the `|| echo 0` fallbacks are what keep this a clean, empty read instead of a crash.
D="$(mktemp -d)"; gitinit "$D"
r="$(probe "$D")"; ok "$r" "0 0 0 none" "a repo with no commits at all: no window, no commits, no crash"
ok "$(field "$D" 'j.total')" "0" "…and a zero lifetime tally"
rm -rf "$D"

# --- 10. git-fetch.sh: read-only, non-interactive, and it only ever touches ITS branch's remote ref ----------
FETCH_SH="$ROOT/wsl/git-fetch.sh"
D="$(withupstream)"; W="$D/work"
# A second branch on the remote, mirroring the ref layout that matters: the sessions-sync worktree owns
# refs/remotes/origin/claudible/sessions, and a bare `git fetch origin` would rewrite it under this script's feet.
# Seed it locally, advance BOTH branches on the remote, then prove only `main`'s ref moves.
git -C "$D/bare.git" branch other-branch
git -C "$W" fetch -q origin other-branch:refs/remotes/origin/other-branch
git clone -q "$D/bare.git" "$D/c2"
git -C "$D/c2" config user.email t@t; git -C "$D/c2" config user.name T; git -C "$D/c2" config commit.gpgsign false
echo x >> "$D/c2/a.txt"; git -C "$D/c2" commit -qam "advance main"; git -C "$D/c2" push -q origin HEAD:main
git -C "$D/c2" push -q origin HEAD:other-branch
before_other="$(git -C "$W" rev-parse refs/remotes/origin/other-branch 2>/dev/null || echo none)"
remote_other="$(git -C "$D/bare.git" rev-parse other-branch)"
# non-vacuity: the ref must EXIST locally and be STALE, else "it didn't move" proves nothing
ok "$([ "$before_other" != none ] && [ "$before_other" != "$remote_other" ] && echo staged || echo bad)" "staged" "fixture: origin/other-branch exists locally and is stale"
idx_before="$(stat -c '%Y %s' "$W/.git/index" 2>/dev/null || echo none)"
out="$(CLAUDIBLE_WS_KIND=local CLAUDIBLE_WS_DIR="$W" bash "$FETCH_SH" 2>/dev/null)"
case "$out" in *'"fetched":true'*) pass=$((pass+1)) ;; *) fail=$((fail+1)); echo "  FAIL git-fetch reports success (got: $out)" ;; esac
ok "$(field "$W" 'j.behind')" "1" "after the fetch, the panel sees the commit GitHub has"
after_other="$(git -C "$W" rev-parse refs/remotes/origin/other-branch 2>/dev/null || echo none)"
ok "$after_other" "$before_other" "a targeted fetch leaves OTHER remote refs alone (claudible/sessions must never move)"
ok "$(stat -c '%Y %s' "$W/.git/index" 2>/dev/null || echo none)" "$idx_before" "fetch never touches the index"
ok "$(ls "$W/.git" | grep -c 'index.lock' || true)" "0" "…and leaves no index.lock behind"
rm -rf "$D"

# --- 10b. no upstream / not a repo / detached: git-fetch.sh declines cleanly, never hangs, never prompts ---
D="$(newrepo)"
out="$(CLAUDIBLE_WS_KIND=local CLAUDIBLE_WS_DIR="$D" bash "$FETCH_SH" 2>/dev/null)"
case "$out" in *'"error":"no upstream"'*) pass=$((pass+1)) ;; *) fail=$((fail+1)); echo "  FAIL git-fetch declines a repo with no upstream (got: $out)" ;; esac
git -C "$D" checkout -q --detach HEAD
out="$(CLAUDIBLE_WS_KIND=local CLAUDIBLE_WS_DIR="$D" bash "$FETCH_SH" 2>/dev/null)"
case "$out" in *'"error":"detached HEAD"'*) pass=$((pass+1)) ;; *) fail=$((fail+1)); echo "  FAIL git-fetch declines a detached HEAD (got: $out)" ;; esac
rm -rf "$D"
D="$(mktemp -d)"
out="$(CLAUDIBLE_WS_KIND=local CLAUDIBLE_WS_DIR="$D" bash "$FETCH_SH" 2>/dev/null)"
case "$out" in *'"error":"not a git repo"'*) pass=$((pass+1)) ;; *) fail=$((fail+1)); echo "  FAIL git-fetch declines a non-repo (got: $out)" ;; esac
rm -rf "$D"

# --- 10c. an unreachable remote must FAIL FAST and never block the panel behind it. GIT_TERMINAL_PROMPT=0 alone
#          does not stop Git Credential Manager (a *helper*, which pops a GUI without consulting the terminal) —
#          `-c credential.helper=` resetting the chain is what actually guarantees this. Budget: well under 10s.
D="$(newrepo)"
br="$(git -C "$D" symbolic-ref --short HEAD)"
git -C "$D" remote add origin https://github.com/definitely-does-not-exist-xyz/nope.git
git -C "$D" config "branch.$br.remote" origin
git -C "$D" config "branch.$br.merge" "refs/heads/$br"
t0=$(date +%s)
out="$(CLAUDIBLE_WS_KIND=local CLAUDIBLE_WS_DIR="$D" bash "$FETCH_SH" 2>/dev/null)"
el=$(( $(date +%s) - t0 ))
case "$out" in *'"ok":true'*'"fetched":false'*) pass=$((pass+1)) ;; *) fail=$((fail+1)); echo "  FAIL a dead remote reports fetched:false, not an error (got: $out)" ;; esac
ok "$([ "$el" -lt 10 ] && echo fast || echo slow)" "fast" "an unreachable/credential-less remote fails fast (${el}s), never prompts"
rm -rf "$D"

# --- 10d. SECURITY: a repo-controlled `branch.<b>.remote` is REPO data in an adopted folder. The old guard only
#          rejected a leading '-'/'"'/'\', so `ext::sh -c <cmd>` sailed through into `git fetch "$remote"`, where
#          git's `ext` transport runs <cmd> as a subprocess. git blocks ext/file by default on current builds, but
#          that default is the ONLY thing stopping it and is version-dependent — and this fires automatically from
#          the 4s Project-History poll. The fix: only fetch a remote git itself LISTS by name, and pin
#          protocol.{ext,file}.allow=never. This test plants the exact PoC and asserts the command never runs.
D="$(newrepo)"
br="$(git -C "$D" symbolic-ref --short HEAD)"
MARK="$D/PWNED"
git -C "$D" config "branch.$br.remote" "ext::sh -c touch>$MARK"   # a poisoned remote value, no leading dash/quote/backslash
git -C "$D" config "branch.$br.merge" "refs/heads/$br"
out="$(CLAUDIBLE_WS_KIND=local CLAUDIBLE_WS_DIR="$D" bash "$FETCH_SH" 2>/dev/null)"
ok "$([ -e "$MARK" ] && echo PWNED || echo safe)" "safe" "an ext:: remote NEVER executes its command"
case "$out" in *'"error":"unusable remote"'*) pass=$((pass+1)) ;; *) fail=$((fail+1)); echo "  FAIL an ext:: remote is rejected as unusable (got: $out)" ;; esac
# belt: even a remote NAMED like a helper string, added via `git remote add`, can't reach the ext transport
git -C "$D" remote add "weird" "ext::sh -c touch>$MARK" 2>/dev/null || true
git -C "$D" config "branch.$br.remote" "weird"
CLAUDIBLE_WS_KIND=local CLAUDIBLE_WS_DIR="$D" bash "$FETCH_SH" >/dev/null 2>&1
ok "$([ -e "$MARK" ] && echo PWNED || echo safe)" "safe" "…and protocol.ext.allow=never blocks it even past the name check"
rm -rf "$D"

# --- 10e. SECURITY: a hostile .git/config is more than a poisoned remote. `core.sshCommand` is a config value git
#          RUNS when fetching an ssh origin — and `origin` is a perfectly valid remote NAME, so the allowlist in 10d
#          can't help. (Found only by testing, not by the first fix — exactly the "sibling call site" trap.) The fix
#          neutralizes every command-executing config key via `-c` overrides; this pins that core.sshCommand can't fire.
D="$(newrepo)"
br="$(git -C "$D" symbolic-ref --short HEAD)"
MARK="$D/PWNED_SSH"
git -C "$D" remote add origin "git@github.com:definitely-does-not-exist-xyz/nope.git"
git -C "$D" config "branch.$br.remote" origin
git -C "$D" config "branch.$br.merge" "refs/heads/$br"
git -C "$D" config core.sshCommand "sh -c 'touch $MARK' #"
CLAUDIBLE_WS_KIND=local CLAUDIBLE_WS_DIR="$D" timeout 20 bash "$FETCH_SH" >/dev/null 2>&1
ok "$([ -e "$MARK" ] && echo PWNED || echo safe)" "safe" "a malicious core.sshCommand in .git/config never runs"
rm -rf "$D"

# --- 10f. SECURITY: the same hostile-config surface is bigger than git-fetch — `core.fsmonitor` is a command git
#          runs on ordinary `git diff HEAD` / `git ls-files`, i.e. it reaches DIFF.SH, which the Project-History
#          panel runs on every card every 4 seconds. `_git-safe.sh` (sourced by diff.sh/diff-apply.sh/checkpoint.sh/
#          git-fetch.sh) neutralizes it process-wide. Plant it and prove diff.sh both stays safe AND still works.
D="$(newrepo)"
echo "a change" >> "$D/root.txt"                                   # a working-tree change so diff.sh does real work
git -C "$D" config core.fsmonitor "sh -c 'touch $D/FSMON' #"
git -C "$D" config core.alternateRefsCommand "sh -c 'touch $D/ALT' #"
r="$(CLAUDIBLE_WS_KIND=local CLAUDIBLE_WS_DIR="$D" bash "$DIFF_SH" 2>/dev/null | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s); console.log([j.ok, (j.files||[]).length].join(" "));});')"
ok "$([ -e "$D/FSMON" ] && echo PWNED || echo safe)" "safe" "diff.sh: a malicious core.fsmonitor never runs (the 4s-poll surface)"
ok "$r" "true 1" "…and diff.sh still reports the working-tree change (hardening didn't break the read)"
rm -rf "$D"

echo "diff-commits: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
