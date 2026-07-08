#!/usr/bin/env bash
# test/ws-dir.test.sh — proves wsl/_ws-dir.sh resolves EXACTLY like the twelve inline blocks it replaced,
# and that no script has grown a thirteenth copy.
#
# The oracle below is the pre-extraction block, pasted verbatim from wsl/diff.sh@d9e7b4a. Same technique as
# test/port-parity.test.sh: keep the thing you replaced, run both, demand identical output. A test that only
# checked _ws-dir.sh against my own expectations would prove nothing about whether the extraction was faithful.
#
# Run: bash test/ws-dir.test.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WSL="$(cd "$HERE/.." && pwd)/wsl"
pass=0; fail=0
ok()   { pass=$((pass+1)); }
bad()  { fail=$((fail+1)); printf '  FAIL %s\n    got: %s\n    exp: %s\n' "$1" "$2" "$3"; }
eq()   { if [ "$2" = "$3" ]; then ok; else bad "$1" "$2" "$3"; fi; }

# ---- the oracle: the block as it existed in all twelve scripts, byte for byte ----------------------------
oracle() {
WS_KIND="${CLAUDIBLE_WS_KIND:-legacy}"
WS_SLUG="${CLAUDIBLE_WS_SLUG:-}"
case "$WS_SLUG" in *[!A-Za-z0-9-]*) WS_SLUG="" ;; esac
if [ "$WS_KIND" = "local" ] && [ -n "$WS_SLUG" ]; then
  SDIR="$HOME/.claudible/workspaces/$WS_SLUG"
elif [ "$WS_KIND" = "repo" ] && [ -n "$WS_SLUG" ]; then
  SDIR="$HOME/.claudible/repos/$WS_SLUG"
else
  SDIR="$HOME/.claudible/session"
fi
[ -n "${CLAUDIBLE_WS_DIR:-}" ] && SDIR="$CLAUDIBLE_WS_DIR"
printf '%s\n' "$SDIR"
}

# Run one env combo through BOTH. Each runs in its own subshell with `set -u`, exactly as the callers do.
# Args: label, then any of KIND=… SLUG=… DIR=… HOME=… (absent = the variable is UNSET, not empty).
probe() {
  local label="$1"; shift
  local kind='' slug='' wsdir='' home="$HOME" setk=0 sets=0 setd=0
  for a in "$@"; do
    case "$a" in
      KIND=*)  kind="${a#KIND=}";  setk=1 ;;
      SLUG=*)  slug="${a#SLUG=}";  sets=1 ;;
      DIR=*)   wsdir="${a#DIR=}";  setd=1 ;;
      HOME=*)  home="${a#HOME=}" ;;
    esac
  done
  local env=(env -u CLAUDIBLE_WS_KIND -u CLAUDIBLE_WS_SLUG -u CLAUDIBLE_WS_DIR "HOME=$home")
  [ "$setk" = 1 ] && env+=("CLAUDIBLE_WS_KIND=$kind")
  [ "$sets" = 1 ] && env+=("CLAUDIBLE_WS_SLUG=$slug")
  [ "$setd" = 1 ] && env+=("CLAUDIBLE_WS_DIR=$wsdir")

  local want got wrc grc
  want="$("${env[@]}" bash -c "set -u; $(declare -f oracle); oracle")"; wrc=$?
  got="$( "${env[@]}" bash -c "set -u; . '$WSL/_ws-dir.sh'; printf '%s\n' \"\$SDIR\"")"; grc=$?
  eq "$label — SDIR" "$got" "$want"
  eq "$label — exit status" "$grc" "$wrc"
}

echo "== _ws-dir.sh vs the twelve inline blocks it replaced =="
probe 'nothing set → legacy session dir'
probe 'legacy kind, no slug'            KIND=legacy
probe 'local + slug'                    KIND=local SLUG=myproj
probe 'repo + slug'                     KIND=repo  SLUG=MK-Crazy
probe 'local, empty slug → legacy'      KIND=local SLUG=
probe 'repo, empty slug → legacy'       KIND=repo  SLUG=
probe 'unknown kind + slug → legacy'    KIND=weird SLUG=myproj
probe 'slug is discarded whole, not stripped (slash)'  KIND=local SLUG='a/b'
probe 'slug traversal → legacy'         KIND=local SLUG='../../etc'
probe 'slug with a dot → legacy'        KIND=repo  SLUG='my.proj'
probe 'slug with a space → legacy'      KIND=local SLUG='my proj'
probe 'slug with $ → legacy'            KIND=local SLUG='a$HOME'
probe 'slug with a backtick → legacy'   KIND=local SLUG='a`id`'
probe 'slug with a quote → legacy'      KIND=local SLUG="a'b"
probe 'slug with a newline → legacy'    KIND=local SLUG="$(printf 'a\nb')"
probe 'leading-dash slug is ALLOWED here (unlike sessions-sync)' KIND=local SLUG='-x'
probe 'trailing-dash slug is allowed'   KIND=repo  SLUG='x-'
probe 'DIR overrides local'             KIND=local SLUG=myproj DIR=/tmp/custom
probe 'DIR overrides repo'              KIND=repo  SLUG=myproj DIR=/tmp/custom
probe 'DIR overrides the legacy fallback' DIR=/tmp/custom
probe 'DIR overrides even a rejected slug' KIND=local SLUG='a/b' DIR=/tmp/custom
probe 'DIR set but EMPTY → no override' KIND=local SLUG=myproj DIR=
probe 'DIR with spaces'                 DIR='/tmp/my folder'
probe 'DIR with a quote'                DIR="/tmp/it's"
probe 'DIR with a dollar'               DIR='/tmp/$HOME'
probe 'HOME with spaces'                KIND=local SLUG=myproj HOME='/home/a b'

# ---- the trailing-`&&` trap: sourcing must not leave $? = 1 on the common path ---------------------------
# The old last line was `[ -n "${CLAUDIBLE_WS_DIR:-}" ] && SDIR="$CLAUDIBLE_WS_DIR"`, which returns 1 when the
# variable is unset. Harmless inline; as the last line of a sourced file it becomes the source's exit status.
rc=0; ( env -u CLAUDIBLE_WS_DIR bash -c "set -u; . '$WSL/_ws-dir.sh'" ) || rc=$?
eq 'sourcing with no CLAUDIBLE_WS_DIR returns 0' "$rc" "0"
rc=0; ( env CLAUDIBLE_WS_DIR=/tmp/x bash -c "set -u; . '$WSL/_ws-dir.sh'" ) || rc=$?
eq 'sourcing with CLAUDIBLE_WS_DIR returns 0' "$rc" "0"

# ---- it must leave WS_KIND/WS_SLUG in scope: sessions.sh reads them again afterwards ---------------------
got="$(env CLAUDIBLE_WS_KIND=repo CLAUDIBLE_WS_SLUG=MK-Crazy bash -c "set -u; . '$WSL/_ws-dir.sh'; printf '%s|%s' \"\$WS_KIND\" \"\$WS_SLUG\"")"
eq 'WS_KIND/WS_SLUG survive the source' "$got" "repo|MK-Crazy"
got="$(env CLAUDIBLE_WS_KIND=repo CLAUDIBLE_WS_SLUG='bad/slug' bash -c "set -u; . '$WSL/_ws-dir.sh'; printf '%s|%s' \"\$WS_KIND\" \"\$WS_SLUG\"")"
eq 'a rejected slug is blanked, not left dirty' "$got" "repo|"

# ---- and sessions.sh's real derived path still works off them -------------------------------------------
got="$(env CLAUDIBLE_WS_KIND=repo CLAUDIBLE_WS_SLUG=MK-Crazy HOME=/h bash -c "set -u; . '$WSL/_ws-dir.sh'; WT=''; [ \"\$WS_KIND\" = repo ] && [ -n \"\$WS_SLUG\" ] && WT=\"\$HOME/.claudible/sessions-sync/\$WS_SLUG\"; printf '%s' \"\$WT\"")"
eq 'sessions.sh worktree path still derivable' "$got" "/h/.claudible/sessions-sync/MK-Crazy"

# ---- static: every script that used the block sources it, and NOBODY inlines it any more ----------------
echo "== no script has a thirteenth copy =="
USERS="agent-tokens checkpoint delete-session diff-apply diff git-fetch session-keep session sessions skills transcript workflows"
for f in $USERS; do
  if grep -q '^\. "\$HERE/_ws-dir\.sh"' "$WSL/$f.sh"; then ok; else bad "$f.sh sources _ws-dir.sh" "no" "yes"; fi
  # HERE must be assigned before the source line
  h=$(grep -n '^HERE=' "$WSL/$f.sh" | head -1 | cut -d: -f1)
  s=$(grep -n '_ws-dir\.sh' "$WSL/$f.sh" | head -1 | cut -d: -f1)
  if [ -n "$h" ] && [ -n "$s" ] && [ "$h" -lt "$s" ]; then ok; else bad "$f.sh defines HERE before sourcing" "HERE=$h source=$s" "HERE < source"; fi
done
# Any script that ASSIGNS SDIR itself is a new copy — except sessions-sync.sh, whose repo-only, fail-fast
# variant is deliberate (a sync that silently targeted ~/.claudible/session would push the wrong tree).
inliners=""
for f in "$WSL"/*.sh; do
  b="$(basename "$f")"
  case "$b" in _ws-dir.sh|sessions-sync.sh) continue ;; esac
  grep -q '^[[:space:]]*SDIR=' "$f" && inliners="$inliners $b"
done
eq 'no wsl script assigns SDIR outside _ws-dir.sh (sessions-sync.sh excepted)' "$(echo "$inliners" | xargs)" ""
# …and the exception really is still there, still repo-only, still fail-fast.
grep -q 'fail "sync is only available for repo workspaces"' "$WSL/sessions-sync.sh" && ok || bad "sessions-sync.sh keeps its repo-only guard" "gone" "present"
grep -q '_ws-dir\.sh' "$WSL/sessions-sync.sh" && bad "sessions-sync.sh must NOT source _ws-dir.sh" "sources it" "does not" || ok

printf '\nws-dir: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
