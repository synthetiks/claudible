#!/usr/bin/env bash
# test/rename-repo.test.sh — wsl/rename-repo.sh against a stubbed `gh` and a REAL fixture clone.
#
# This is the highest-consequence untested script in the repo: it renames a real GitHub repo and rewrites
# the local clone's origin. Every branch below is exercised with gh replaced by a recording stub, so the
# ONE thing never tested here is the ONE thing that must never run in a test: a real network rename.
#
# Covered: the three arg validations · gh missing · gh unauthenticated · not-owner refusal · GitHub rename
# failure (and that origin is NOT touched on that path) · the happy path (origin rewritten, ghId captured,
# gh called with exactly the right args) · a failing/absent ghId degrades to ok-without-id · a missing local
# clone and a clone with no origin remote both stay ok:true (best-effort by design).
# NOT covered: the WSL-interop guard (gh resolving to *.exe or /mnt/*) — hitting it requires planting a stub
# under /mnt, which is not writable on every machine. The guard is a one-line case pattern; eyeball it.
# Run: bash test/rename-repo.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/wsl/rename-repo.sh"
# Hermetic git — same rule as presence-plumbing: a dev's global config must not reach the fixture repo.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
unset CLAUDIBLE_WS_DIR CLAUDIBLE_PROJ 2>/dev/null || true

pass=0; fail=0
ok() { if [ "$1" = "$2" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL $3: expected [$2] got [$1]"; fi; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---- a restricted PATH with everything the script needs EXCEPT gh (for the not-installed case), and a
#      stub-gh dir we prepend for every other case. The stub records its argv lines to $TMP/gh.calls and
#      obeys $GH_LOGIN / $GH_RENAME_RC / $GH_ID so each case scripts its behavior via env, not rewrites.
BIN="$TMP/bin"; mkdir -p "$BIN"
# bash included: PATH="$BIN" must be able to find the interpreter itself, not just the script's tools.
for t in bash git uname dirname; do p="$(command -v "$t")" && ln -s "$p" "$BIN/$t"; done
cat > "$BIN/gh.stub" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_CALLS"
case "$1 $2" in
  'api user')   [ -n "${GH_LOGIN:-}" ] && { printf '%s\n' "$GH_LOGIN"; exit 0; } || exit 1 ;;
  'repo rename') exit "${GH_RENAME_RC:-0}" ;;
  'api repos'*) : ;;   # unreachable shape; the real call is "api repos/<owner>/<name>"
esac
case "$1" in
  api) case "$2" in repos/*) [ -n "${GH_ID:-}" ] && { printf '%s\n' "$GH_ID"; exit 0; } || exit 1 ;; esac ;;
esac
exit 0
STUB
chmod +x "$BIN/gh.stub"
export GH_CALLS="$TMP/gh.calls"

# run <workspace-slug> <args...> — executes the script with HOME sandboxed to $TMP and the stub gh visible.
run() { s="$1"; shift; HOME="$TMP" CLAUDIBLE_WS_KIND=repo CLAUDIBLE_WS_SLUG="$s" PATH="$TMP/ghbin:$BIN" bash "$SCRIPT" "$@" 2>/dev/null; }
mkdir -p "$TMP/ghbin"; ln -s "$BIN/gh.stub" "$TMP/ghbin/gh"

# The fixture clone the script's origin-rewrite half operates on.
WS="$TMP/.claudible/repos/testws"
mkfixture() {
  rm -rf "$WS"; mkdir -p "$WS"
  git -C "$WS" init -q
  git -C "$WS" remote add origin "https://github.com/crazy/oldname.git"
}
origin_of() { git -C "$WS" remote get-url origin 2>/dev/null || echo NONE; }

# ---- 1. argument validation refuses anything outside the slug charset, before touching gh or git ----
: > "$GH_CALLS"
ok "$(run testws 'bad owner!' old new)" '{"ok":false,"error":"bad owner"}'    "an owner outside [A-Za-z0-9-] is refused"
ok "$(run testws crazy 'old/../x' new)" '{"ok":false,"error":"bad name"}'     "a path-shaped current name is refused"
ok "$(run testws crazy old 'new name')" '{"ok":false,"error":"bad new name"}' "a spaced new name is refused"
ok "$(run testws '' old new)"           '{"ok":false,"error":"bad owner"}'    "an empty owner is refused"
ok "$(cat "$GH_CALLS" | wc -l | tr -d ' ')" "0" "validation failures never invoke gh"

# ---- 2. gh missing entirely (PATH without the stub) ----
out="$(HOME="$TMP" CLAUDIBLE_WS_KIND=repo CLAUDIBLE_WS_SLUG=testws PATH="$BIN" bash "$SCRIPT" crazy old new 2>/dev/null)"
ok "$out" '{"ok":false,"error":"the GitHub CLI (gh) is not installed in WSL"}' "a missing gh is reported, not crashed on"

# ---- 3. authentication and ownership gates ----
# no GH_LOGIN in the stub's env = `gh api user` fails = the not-signed-in state
out="$(run testws crazy old new)"
ok "$out" '{"ok":false,"error":"gh is not authenticated"}' "an unauthenticated gh is refused"
out="$(GH_LOGIN=somebodyelse run testws crazy old new)"
ok "$out" '{"ok":false,"error":"not-owner"}' "a non-owner login is refused (caller degrades to label-only)"

# ---- 4. the GitHub rename fails -> error out, and the local origin must NOT have been rewritten ----
mkfixture
out="$(GH_LOGIN=crazy GH_RENAME_RC=1 run testws crazy oldname newname)"
case "$out" in '{"ok":false,"error":"could not rename on GitHub'*) pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL rename failure surfaces (got: $out)";; esac
ok "$(origin_of)" "https://github.com/crazy/oldname.git" "a failed GitHub rename leaves origin untouched"

# ---- 5. happy path: rename succeeds, origin rewritten to the canonical URL, ghId captured ----
mkfixture; : > "$GH_CALLS"
out="$(GH_LOGIN=crazy GH_ID=12345 run testws crazy oldname newname)"
ok "$out" '{"ok":true,"repoName":"newname","repoUrl":"https://github.com/crazy/newname","ghId":12345}' "the success JSON carries name, url and numeric id"
ok "$(origin_of)" "https://github.com/crazy/newname.git" "origin is repointed to the canonical new URL (no redirect reliance)"
grep -q '^repo rename newname --repo crazy/oldname -y$' "$GH_CALLS"; ok "$?" "0" "gh was invoked with exactly the rename it was asked for"
grep -q '^api repos/crazy/newname --jq .id$' "$GH_CALLS";            ok "$?" "0" "the id is read from the NEW name (the old one is gone)"

# ---- 6. a missing/garbage id degrades to ok WITHOUT ghId (discovery falls back to name matching) ----
mkfixture
out="$(GH_LOGIN=crazy GH_ID= run testws crazy oldname newname)"
ok "$out" '{"ok":true,"repoName":"newname","repoUrl":"https://github.com/crazy/newname"}' "a failing id lookup still reports the successful rename"
mkfixture
out="$(GH_LOGIN=crazy GH_ID=notanumber run testws crazy oldname newname)"
ok "$out" '{"ok":true,"repoName":"newname","repoUrl":"https://github.com/crazy/newname"}' "a non-numeric id is discarded whole, not embedded as broken JSON"

# ---- 7. the origin-rewrite half is best-effort BY DESIGN: no clone / no origin remote stay ok:true ----
rm -rf "$WS"
out="$(GH_LOGIN=crazy GH_ID=12345 run testws crazy oldname newname)"
case "$out" in '{"ok":true,'*) pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL no local clone is still a successful rename (got: $out)";; esac
rm -rf "$WS"; mkdir -p "$WS"; git -C "$WS" init -q   # a clone with NO origin remote: set-url fails, || true holds
out="$(GH_LOGIN=crazy GH_ID=12345 run testws crazy oldname newname)"
case "$out" in '{"ok":true,'*) pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL a clone without an origin remote is still ok (got: $out)";; esac

# ---- 8. every emitted line is valid single-line JSON (the caller does JSON.parse on the raw stdout) ----
mkfixture
for args in "bad! o n" "crazy oldname newname"; do
  # shellcheck disable=SC2086
  out="$(GH_LOGIN=crazy GH_ID=7 run testws $args)"
  printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{JSON.parse(s)})' 2>/dev/null
  ok "$?" "0" "output parses as JSON for args [$args]"
done

echo "rename-repo: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
