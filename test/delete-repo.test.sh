#!/usr/bin/env bash
# test/delete-repo.test.sh — wsl/delete-repo.sh against a stubbed `gh`.
#
# This script permanently deletes a repository on GitHub, so the ONE thing that must never happen in a test is
# the one thing this file therefore never allows: a real `gh repo delete`. Every case below runs against a
# recording stub planted on PATH, and one of the assertions is specifically that the stub was NOT asked to
# delete anything when the script refuses.
#
# Covered: the owner-mismatch refusal (and that no delete is attempted after it) · a delete refused by GitHub
# for the missing repository-deletion permission, which must come back naming both the permission and the
# command that grants it · the happy path's success JSON.
# Run: bash test/delete-repo.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/wsl/delete-repo.sh"

pass=0; fail=0
ok() { if [ "$1" = "$2" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL $3: expected [$2] got [$1]"; fi; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A restricted PATH holding only what the script needs, plus the stub gh. The stub records its argv lines to
# $GH_CALLS and obeys $GH_LOGIN / $GH_DELETE_RC / $GH_DELETE_ERR, so each case scripts gh's behaviour via env.
BIN="$TMP/bin"; mkdir -p "$BIN"
for t in bash uname printf tail tr; do p="$(command -v "$t")" && ln -s "$p" "$BIN/$t" 2>/dev/null; done
cat > "$BIN/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_CALLS"
case "$1 $2" in
  'api user')     [ -n "${GH_LOGIN:-}" ] && { printf '%s\n' "$GH_LOGIN"; exit 0; }; exit 1 ;;
  'repo delete')  [ -n "${GH_DELETE_ERR:-}" ] && printf '%s\n' "$GH_DELETE_ERR" >&2; exit "${GH_DELETE_RC:-0}" ;;
esac
exit 0
STUB
chmod +x "$BIN/gh"
export GH_CALLS="$TMP/gh.calls"

run() { HOME="$TMP" PATH="$BIN" bash "$SCRIPT" "$@" 2>/dev/null; }

# ---- 1. someone else's repo: refused by name, and NOTHING is deleted ----
# The two halves are asserted together on purpose — "it printed a refusal" is worthless without "and it did not
# delete the repo anyway", so a regression in either half fails this single check.
: > "$GH_CALLS"
out="$(GH_LOGIN=somebodyelse run crazy newrepo123)"
ok "$out|$(grep -c '^repo delete' "$GH_CALLS")" \
   '{"ok":false,"error":"only the repo owner (crazy) can delete it on GitHub"}|0' \
   "a repo owned by someone else is refused, and no delete is attempted"

# ---- 2. GitHub refuses for the missing repository-deletion permission ----
# The raw gh text is unusable on its own; the message must name the permission AND the command that grants it.
: > "$GH_CALLS"
out="$(GH_LOGIN=crazy GH_DELETE_RC=1 GH_DELETE_ERR='HTTP 403: Must have admin rights to Repository. (needs the delete_repo scope)' run crazy newrepo123)"
case "$out" in
  *delete_repo*'gh auth refresh'*) pass=$((pass+1)) ;;
  *) fail=$((fail+1)); echo "  FAIL a refused delete names the permission and the command that grants it (got: $out)" ;;
esac

# ---- 3. happy path ----
: > "$GH_CALLS"
out="$(GH_LOGIN=crazy GH_DELETE_RC=0 run crazy newrepo123)"
ok "$out" '{"ok":true}' "a successful delete reports ok"

echo "delete-repo: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
