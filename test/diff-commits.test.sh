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

# Emit "week commits committed_files" for a repo dir, via the real script.
probe() {
  CLAUDIBLE_WS_KIND=local CLAUDIBLE_WS_DIR="$1" bash "$DIFF_SH" 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let j; try { j = JSON.parse(s); } catch { console.log("PARSE_FAIL"); return; }
      if (!j.ok) { console.log("NOT_OK"); return; }
      console.log([j.week, (j.commits || []).length, (j.committed || []).length].join(" "));
    });'
}
ok() { if [ "$1" = "$2" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL $3: expected [$2] got [$1]"; fi; }

newrepo() {   # echoes a fresh repo dir with an initial commit
  local d; d="$(mktemp -d)"
  git -C "$d" init -q
  git -C "$d" config user.email t@t; git -C "$d" config user.name T
  git -C "$d" config commit.gpgsign false
  echo root > "$d/root.txt"; git -C "$d" add -A; git -C "$d" commit -qm "root commit"
  printf '%s' "$d"
}

# --- 1. commit then revert: the week's NET diff is empty, but three commits happened ---
D="$(newrepo)"
echo tmp > "$D/tmp.txt"; git -C "$D" add -A; git -C "$D" commit -qm "add tmp"
git -C "$D" rm -q tmp.txt; git -C "$D" commit -qm "remove tmp"
r="$(probe "$D")"; ok "${r% *}" "3 3" "net-zero week still lists its 3 commits"
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
git -C "$D" init -q; git -C "$D" config user.email t@t; git -C "$D" config user.name T; git -C "$D" config commit.gpgsign false
echo a > "$D/a.txt"; git -C "$D" add -A; git -C "$D" commit -qm "first"
echo b >> "$D/a.txt"; git -C "$D" commit -qam "second"
r="$(probe "$D")"; ok "$(echo "$r" | cut -d' ' -f1-2)" "2 2" "young repo keeps its oldest commit"
rm -rf "$D"

# --- 5. exactly one commit ever (the root) — the old `ccount > 1` guard hid it ---
D="$(mktemp -d)"
git -C "$D" init -q; git -C "$D" config user.email t@t; git -C "$D" config user.name T; git -C "$D" config commit.gpgsign false
echo only > "$D/a.txt"; git -C "$D" add -A; git -C "$D" commit -qm "the only commit"
r="$(probe "$D")"; ok "$(echo "$r" | cut -d' ' -f1-2)" "1 1" "a lone root commit is listed"
rm -rf "$D"

# --- 6. a genuinely quiet repo reports zero (no false positives). NB: `git log/rev-list --since` filters on the
#        COMMITTER date, not the author date — so the fixture must backdate BOTH (a `--date=` amend moves only the
#        author date and would leave the commit "today" as far as --since is concerned).
D="$(mktemp -d)"
git -C "$D" init -q; git -C "$D" config user.email t@t; git -C "$D" config user.name T; git -C "$D" config commit.gpgsign false
echo old > "$D/a.txt"; git -C "$D" add -A
# an ABSOLUTE date (git rejects "30 days ago" for GIT_*_DATE); comfortably outside any 7-day window
GIT_AUTHOR_DATE="2020-01-01T00:00:00" GIT_COMMITTER_DATE="2020-01-01T00:00:00" git -C "$D" commit -qm "an old commit"
lifetime="$(git -C "$D" rev-list --count HEAD 2>/dev/null || echo 0)"
ok "$lifetime" "1" "the backdated commit actually landed (else the next assert passes for the wrong reason)"
r="$(probe "$D")"; ok "$(echo "$r" | cut -d' ' -f1-2)" "0 0" "a repo with no commits this week reports zero"
rm -rf "$D"

# --- 7. not a git repo at all → repo:false, never a crash ---
D="$(mktemp -d)"
out="$(CLAUDIBLE_WS_KIND=local CLAUDIBLE_WS_DIR="$D" bash "$DIFF_SH" 2>/dev/null)"
case "$out" in *'"repo": false'*|*'"repo":false'*) pass=$((pass+1)) ;; *) fail=$((fail+1)); echo "  FAIL non-repo reports repo:false (got: ${out:0:80})" ;; esac
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
rm -rf "$D"

echo "diff-commits: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
