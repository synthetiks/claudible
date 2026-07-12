#!/usr/bin/env bash
# Claudible — sync a repo workspace's Claude conversations between collaborators over GitHub.
#
# WHY a separate worktree + orphan branch:
#   Claude's transcripts live OUTSIDE the repo at ~/.claude/projects/<encoded cwd>/<id>.jsonl, and the
#   encoded dir name is derived from $HOME (so it differs per machine/user). We therefore COPY the bare
#   <id>.jsonl files into a dedicated git branch and, on the other side, copy them back into THAT machine's
#   own encoded projects dir. The branch is an ORPHAN branch (claudible/sessions) checked out in a SEPARATE
#   worktree (~/.claudible/sessions-sync/<slug>), so syncing it NEVER touches the user's code working tree
#   (~/.claudible/repos/<slug>) or main's history — a background pull can't disturb the live session's files.
#
# WHY per-author dirs:
#   Each install writes ONLY to sessions/<my-github-login>/<id>.jsonl. Two collaborators therefore never
#   touch the same path, so the branch ALWAYS merges with disjoint paths — no git conflicts in the normal
#   case. Same-id divergence (someone resumed someone else's session) is contained on IMPORT, not by git.
#
# Subcommands ($1): init | push | pull | sync | status   (sync = pull then push)
# Env: CLAUDIBLE_WS_KIND=repo, CLAUDIBLE_WS_SLUG=<slug>, CLAUDIBLE_LIVE_SESSION=<id-to-skip-on-push|''>
# Emits ONE JSON line on stdout for the renderer; all git chatter is muted.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"                  # absolute, so the sources below survive any later cd
. "$HERE/node-path.sh" 2>/dev/null || true             # nvm's node isn't on PATH for non-interactive shells → resolve it (title read/write)
. "$HERE/_git-safe.sh"                                 # 22 git calls in a workspace repo. It's a repo WE cloned, so the config is ours — but that's an assumption about the caller, and this file is the one place it would cost nothing to stop assuming. Enforced tree-wide by test/adopt-workspace.test.js.

emit() { printf '%s\n' "$1"; }
fail() { emit "{\"ok\":false,\"error\":\"$1\"}"; exit 0; }

op="${1:-status}"
case "$op" in init|push|pull|sync|status|delete|resolve|presence-set|presence-clear|presence-list|title-set|title-list) ;; *) fail "bad op" ;; esac

# --- workspace must be a repo workspace (only those have a GitHub remote to sync over) ---
WS_KIND="${CLAUDIBLE_WS_KIND:-legacy}"
WS_SLUG="${CLAUDIBLE_WS_SLUG:-}"
case "$WS_SLUG" in '' | -* | *- | *[!A-Za-z0-9-]*) fail "bad workspace" ;; esac
[ "$WS_KIND" = "repo" ] || fail "sync is only available for repo workspaces"

SDIR="$HOME/.claudible/repos/$WS_SLUG"               # the code working tree (the user's clone)
[ -n "${CLAUDIBLE_WS_DIR:-}" ] && SDIR="$CLAUDIBLE_WS_DIR"   # custom save-location override
[ -d "$SDIR/.git" ] || fail "repo workspace not found"

# Same encoder Claude uses (must match session.sh exactly): EVERY non-alphanumeric char in the absolute
# cwd path -> a single '-'. This is recomputed locally on each machine, so the per-machine dir is correct.
PROJ="$HOME/.claude/projects/${CLAUDIBLE_PROJ:-$(printf '%s' "$SDIR" | sed 's#[^A-Za-z0-9]#-#g')}"

# Trust boundary: a session is TRUSTED (may run under --dangerously-skip-permissions) ONLY if it was
# created locally by Claude here. The moment ANY content is copied in from the shared branch, the id is
# recorded here as foreign — permanently. We key trust on this, NOT on the sessions/<login>/ dir name,
# because any push-access collaborator can write to ANY author dir (including one named after you), so the
# dir name is attacker-controlled and cannot be a trust signal. session.sh consults this same file.
FSET="$PROJ/.claudible-foreign"
mark_foreign() { grep -qxF -- "$1" "$FSET" 2>/dev/null || printf '%s\n' "$1" >> "$FSET"; }
# A true fork (same id edited on both machines) is recorded here so sessions.sh can flag a per-row "diverged"
# badge; cleared the moment the fork resolves (clean import / fast-forward / identical / local-ahead).
DDSET="$PROJ/.claudible-diverged"
# A fork the user chose to KEEP-LOCAL is acked in AKSET so import stops re-nagging it (it IS still out of sync, but
# the user decided). Any natural resolution clears BOTH, so a genuinely new divergence can still surface later.
AKSET="$PROJ/.claudible-diverged-ack"
_rmline() { [ -e "$2" ] || return 0; { grep -vxF -- "$1" "$2" 2>/dev/null || true; } > "$2.tmp.$$"; mv -f "$2.tmp.$$" "$2" 2>/dev/null; }   # PID-unique tmp: a background sync + a resolve clearing different ids must not clobber each other's rewrite
mark_diverged() { grep -qxF -- "$1" "$DDSET" 2>/dev/null || printf '%s\n' "$1" >> "$DDSET"; }
mark_ack() { grep -qxF -- "$1" "$AKSET" 2>/dev/null || printf '%s\n' "$1" >> "$AKSET"; }
is_acked() { grep -qxF -- "$1" "$AKSET" 2>/dev/null; }
clear_diverged() { _rmline "$1" "$DDSET"; _rmline "$1" "$AKSET"; }   # a resolved fork drops both the badge flag AND the keep-local ack
# Within a SINGLE import pass, divergence must WIN regardless of author-dir glob order: once an id is flagged a fork
# (or protected as a kept-local ack) THIS run, a later ff / identical / local-ahead resolution from a DIFFERENT
# author dir for the same id must not clear it — that ordering hole was the "sometimes doesn't auto-flag" bug. The
# caller (import_sessions) seeds a run-scoped `_divset` of space-delimited ids; we skip the clear only for those.
clear_diverged_run() { case " ${_divset:-} " in *" $1 "*) return 0 ;; esac; clear_diverged "$1"; }
# Install a branch transcript so it is ONLY ever visible in final, already-foreign, already-aged form:
# record foreign FIRST, copy to a temp, age the temp, then atomically rename into place. This closes the
# TOCTOU window in which a concurrently-spawned session.sh could observe a trusted, current-mtime
# collaborator file at $dest and resume it under --dangerously-skip-permissions (RCE).
import_file() {   # $1=src  $2=dest  $3=id
  mark_foreign "$3" || return 1   # if we can't record it as foreign, DO NOT place it — never import an unflagged (would-be-trusted) transcript
  cp -f "$1" "$2.cltmp" 2>/dev/null || return 1
  touch -d '2000-01-01T00:00:00' "$2.cltmp" 2>/dev/null
  mv -f "$2.cltmp" "$2" 2>/dev/null
}

WT="$HOME/.claudible/sessions-sync/$WS_SLUG"         # the isolated sessions worktree
BR="claudible/sessions"                              # the orphan branch sessions ride on

# Windows git-bash: the runner sets MSYS_NO_PATHCONV, so git.exe receives our paths LITERALLY and misreads the
# MSYS '/c/…' form as 'C:\c\…' — which silently breaks `worktree add`/`-C` (the cause of "could not set up the
# sessions branch" + missing synced sessions). Normalize the two paths git.exe actually touches — the clone dir
# (SDIR) and the worktree (WT) — to the mixed 'C:/…' form, a real Windows path that BOTH git and bash accept.
# No-op on WSL/Posix (cygpath absent). PROJ is left alone: it's only ever read via bash `cp`, and its encoding
# comes from CLAUDIBLE_PROJ on Windows so it already matches Claude's transcript store.
if command -v cygpath >/dev/null 2>&1; then
  SDIR="$(cygpath -m "$SDIR" 2>/dev/null || printf '%s' "$SDIR")"
  WT="$(cygpath -m "$WT" 2>/dev/null || printf '%s' "$WT")"
fi
LIVE="${CLAUDIBLE_LIVE_SESSION:-}"
case "$LIVE" in *[!A-Za-z0-9-]*) LIVE="" ;; esac     # only a clean id can name the live session

command -v gh >/dev/null 2>&1 || fail "the GitHub CLI (gh) is not installed in WSL"
author="$(gh api user --jq .login 2>/dev/null)"
case "$author" in '' | *[!A-Za-z0-9-]*) fail "gh is not authenticated — run: gh auth login" ;; esac

# git in the worktree with a stable identity (the user may not have configured git globally), no editor.
gitwt() { GIT_EDITOR=true git -C "$WT" -c user.name="$author" -c user.email="$author@users.noreply.github.com" "$@"; }

# --- ensure the sessions worktree exists and tracks origin/claudible/sessions -----------------------------
ensure_worktree() {
  if [ -d "$WT" ] && git -C "$WT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    # Heal a partially-checked-out worktree so a later `add` can't stage missing files as deletions.
    [ -n "$(git -C "$WT" ls-files -d 2>/dev/null)" ] && git -C "$WT" checkout-index -f -a >/dev/null 2>&1
    return 0
  fi
  # A stale path (e.g. the worktree was pruned) must be cleared or `worktree add` refuses.
  rm -rf "$WT" 2>/dev/null
  git -C "$SDIR" worktree prune >/dev/null 2>&1
  mkdir -p "$(dirname "$WT")" 2>/dev/null
  git -C "$SDIR" fetch origin "$BR" >/dev/null 2>&1
  if git -C "$SDIR" show-ref --verify --quiet "refs/remotes/origin/$BR"; then
    # Remote branch exists → attach a worktree. If a local branch already exists (possibly with unpushed
    # self-healing commits), attach it as-is and let pull_branch merge origin in; only create-from-origin
    # when there is no local branch, so we never force-reset away local commits.
    if git -C "$SDIR" show-ref --verify --quiet "refs/heads/$BR"; then
      git -C "$SDIR" worktree add "$WT" "$BR" >/dev/null 2>&1 || return 1
    else
      git -C "$SDIR" worktree add -B "$BR" "$WT" "origin/$BR" >/dev/null 2>&1 || return 1
    fi
    return 0
  fi
  # Remote branch does NOT exist → create a true orphan (no shared history with main) via plumbing,
  # which is cleaner and more version-robust than `checkout --orphan` inside a fresh worktree.
  local empty_tree root
  empty_tree="$(git -C "$SDIR" hash-object -w -t tree /dev/null 2>/dev/null)"
  [ -n "$empty_tree" ] || return 1
  root="$(git -C "$SDIR" -c user.name="$author" -c user.email="$author@users.noreply.github.com" \
            commit-tree "$empty_tree" -m "claudible: init sessions branch" 2>/dev/null)"
  [ -n "$root" ] || return 1
  git -C "$SDIR" branch "$BR" "$root" >/dev/null 2>&1
  git -C "$SDIR" worktree add "$WT" "$BR" >/dev/null 2>&1 || return 1
  printf 'sessions/**/*.jsonl binary\n' > "$WT/.gitattributes"   # 'binary' = -text -diff -merge (a real macro; merge=binary names an unconfigured driver and is a no-op)
  mkdir -p "$WT/sessions" 2>/dev/null; : > "$WT/sessions/.gitkeep"
  gitwt add -A >/dev/null 2>&1
  gitwt commit -m "claudible: init sessions branch" >/dev/null 2>&1
  if ! gitwt push -u origin "$BR" >/dev/null 2>&1; then
    # Race: a collaborator created the branch first → adopt theirs (our empty init is discardable).
    git -C "$SDIR" fetch origin "$BR" >/dev/null 2>&1
    gitwt reset --hard "origin/$BR" >/dev/null 2>&1
    gitwt branch --set-upstream-to="origin/$BR" "$BR" >/dev/null 2>&1
  fi
  return 0
}

# Pull remote sessions into the worktree. Disjoint per-author paths => clean auto-merge, never a conflict.
pull_branch() {
  git -C "$WT" fetch origin "$BR" >/dev/null 2>&1 || return 1
  git -C "$WT" show-ref --verify --quiet "refs/remotes/origin/$BR" || return 0   # nothing pushed yet
  gitwt merge --no-edit "origin/$BR" >/dev/null 2>&1 && return 0
  # A conflict should not happen (disjoint per-author paths) but must NEVER wedge sync — pull_branch is the
  # first gate of every op. Origin wins; our OWN session content is re-derived from $PROJ on the next export, so
  # reset loses nothing real — EXCEPT tombstones (deletion markers aren't re-derivable). Snapshot any local
  # tombstones and re-apply them after the reset, so a not-yet-pushed "delete everywhere" survives the conflict
  # instead of resurrecting the session for collaborators.
  gitwt merge --abort >/dev/null 2>&1
  local keep; keep="$(tombstone_ids 2>/dev/null)"
  gitwt reset --hard "origin/$BR" >/dev/null 2>&1 || return 1
  if [ -n "$keep" ]; then
    mkdir -p "$WT/sessions/.tombstones" 2>/dev/null
    local t; for t in $keep; do case "$t" in *[!A-Za-z0-9-]*) continue ;; esac; : > "$WT/sessions/.tombstones/$t"; done
    gitwt add -A -- "sessions/.tombstones" >/dev/null 2>&1
    gitwt diff --cached --quiet >/dev/null 2>&1 || gitwt commit -m "claudible: preserve local tombstones across conflict reset" >/dev/null 2>&1
  fi
  return 0
}

# Import every transcript from the branch into THIS machine's encoded projects dir.
#  - new id           -> copy in
#  - remote extends local (append-only fast-forward) -> update in place
#  - genuinely diverged (same id edited on both sides) -> SKIP and flag (no silent overwrite, no risky
#    rename: resuming a renamed transcript is unverified, so v1 stays safe and surfaces the conflict)
# SECURITY: transcripts from ANOTHER author dir are untrusted. We (a) record their ids in a sidecar so
# session.sh resumes them sandboxed and never auto-opens them, and (b) age their mtime into the past so
# the most-recent-local heuristic can never select one. A basic JSONL sanity check rejects junk files.
# A session the user deleted "everywhere" leaves a positive marker on the branch (an ADD, so it propagates
# even though commit_and_push refuses to propagate plain removals). We never import or re-publish a
# tombstoned id, and we trash any local copy — so the delete reaches every collaborator on their next pull.
tombstoned() {   # disk OR HEAD: the resurrection bug IS the worktree tombstone going missing while it lives in HEAD
  [ -e "$WT/sessions/.tombstones/$1" ] && return 0
  gitwt cat-file -e "HEAD:sessions/.tombstones/$1" 2>/dev/null
}
# Every id ever tombstoned — UNION of the worktree dir AND HEAD. Reading HEAD is load-bearing: a sibling sync
# sharing this single worktree can race its index/checkout and momentarily drop the tombstone from disk while it
# is still committed in HEAD; a disk-only scan would then skip exactly the file that must be purged.
tombstone_ids() {
  { ls "$WT/sessions/.tombstones" 2>/dev/null
    gitwt ls-tree --name-only "HEAD:sessions/.tombstones" 2>/dev/null
  } | sort -u
}
# Make tombstones AUTHORITATIVE, not merely honored: STAGE the removal of the deleted transcript from EVERY
# author dir (git rm stages it, unlike commit_and_push's --ignore-removal, so the deletion self-propagates and
# self-heals no matter who re-added the file), and trash any local copy so this machine can never re-export it.
# Idempotent; a no-op when nothing is tombstoned.
purge_tombstoned() {
  local id
  for id in $(tombstone_ids); do
    case "$id" in '' | *[!A-Za-z0-9-]*) continue ;; esac
    gitwt rm -q -f --ignore-unmatch -- "sessions/*/$id.jsonl" >/dev/null 2>&1   # quoted: git does the glob (all author dirs), not the shell
    # The recipient's LOCAL copy is intentionally KEPT — sessions.sh flags it 'deletedRemote' so the user gets a
    # red "!" prompt (Fully delete / Keep locally). It can never be re-shared (export skips tombstoned ids), and
    # the deleter's own copy was already trashed by the delete op. So no local trash here.
  done
}
import_sessions() {
  mkdir -p "$PROJ" 2>/dev/null
  purge_tombstoned                                                  # honor collaborators' "delete everywhere"
  IMPORTED=0; UPDATED=0; DIVERGED=0; CHANGED_IDS=""
  [ -d "$WT/sessions" ] || return 0
  # _divset seeds the run-scoped guard read by clear_diverged_run: an id added here (a fork flagged, or a kept-local
  # ack) can no longer be cleared by a later author dir THIS pass, so a fork is flagged no matter the glob order.
  local f id dest dsz _divset=" " _dl _dsz
  for f in "$WT"/sessions/*/*.jsonl; do
    [ -e "$f" ] || continue
    id="$(basename "$f" .jsonl)"
    case "$id" in '' | -* | *- | *[!A-Za-z0-9-]*) continue ;; esac  # reject leading/trailing-dash ids (argv tricks)
    tombstoned "$id" && continue                                    # deleted everywhere → never re-import
    # LOCAL delete marker (written by delete-session.sh): this machine deliberately trashed the transcript, so
    # the branch's identical copy must NOT resurrect it on the next pull. Only a remote copy that has GROWN
    # past the recorded size (a collaborator kept the session going) returns — and clears the marker.
    if [ -e "$PROJ/.claudible-deleted" ]; then
      _dl="$(grep -m1 "^$id " "$PROJ/.claudible-deleted" 2>/dev/null)"
      if [ -n "$_dl" ]; then
        _dsz="${_dl#* }"
        case "$_dsz" in '' | *[!0-9]*) _dsz=0 ;; esac
        if [ "$(wc -c < "$f")" -le "$_dsz" ]; then continue; fi
        { grep -v "^$id " "$PROJ/.claudible-deleted" 2>/dev/null || true; } > "$PROJ/.claudible-deleted.tmp"
        mv -f "$PROJ/.claudible-deleted.tmp" "$PROJ/.claudible-deleted" 2>/dev/null
      fi
    fi
    head -c 1 "$f" 2>/dev/null | grep -q '{' || continue            # must look like line-delimited JSON
    grep -aq '"type":"user"' "$f" 2>/dev/null || continue            # never import a promptless stub (defense against collaborators on builds that still export them)
    dest="$PROJ/$id.jsonl"
    if [ ! -e "$dest" ]; then                                       # new on the branch → import (untrusted, atomic)
      import_file "$f" "$dest" "$id" && { IMPORTED=$((IMPORTED+1)); CHANGED_IDS="$CHANGED_IDS $id"; clear_diverged_run "$id"; }; continue
    fi
    if cmp -s "$f" "$dest"; then clear_diverged_run "$id"; continue; fi  # identical → leave trust status unchanged, resolve any fork flag
    dsz="$(wc -c < "$dest" 2>/dev/null || echo 0)"
    if [ "$(wc -c < "$f")" -gt "$dsz" ] && head -c "$dsz" "$f" | cmp -s - "$dest"; then
      import_file "$f" "$dest" "$id" && { UPDATED=$((UPDATED+1)); CHANGED_IDS="$CHANGED_IDS $id"; clear_diverged_run "$id"; }   # remote = local + more turns → ff (now foreign)
    elif head -c "$(wc -c < "$f")" "$dest" | cmp -s - "$f"; then
      clear_diverged_run "$id"                                       # local is ahead of remote → our push handles it
    elif is_acked "$id"; then
      _divset="$_divset$id "                                        # user chose KEEP-LOCAL: honor it AND protect the ack from a same-run clear by another author dir (don't re-nag)
    else
      DIVERGED=$((DIVERGED+1)); mark_diverged "$id"; _divset="$_divset$id "   # true fork → leave local untouched, flag it, and make the flag sticky for the rest of this pass
    fi
  done
  return 0
}

# Copy this machine's transcripts into our own author dir. Skips: the live session, and any session that
# ORIGINATED elsewhere (already present under another author on the branch) — we never re-publish an
# imported session under our own name, so attribution and the disjoint-path invariant both hold.
export_sessions() {
  mkdir -p "$WT/sessions/$author" 2>/dev/null
  PUSHED=0
  local f id dest m age
  for f in "$PROJ"/*.jsonl; do
    [ -e "$f" ] || continue
    id="$(basename "$f" .jsonl)"
    case "$id" in '' | -* | *- | *[!A-Za-z0-9-]*) continue ;; esac
    [ "$id" = "$LIVE" ] && continue                                  # never sync the currently-live session
    tombstoned "$id" && continue                                    # deleted everywhere → never re-publish
    grep -qxF -- "$id" "$FSET" 2>/dev/null && continue              # imported (foreign) → never republish under our name
    m="$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0)"; age=$(( $(date +%s) - m ))   # torn-write guard: skip a file still (GNU stat -c, BSD/macOS stat -f fallback)
    [ "$age" -ge 0 ] && [ "$age" -lt "${CLAUDIBLE_SYNC_MIN_AGE:-2}" ] && continue   # being written (~2s); ignore future mtimes (clock skew)
    grep -aq '"type":"user"' "$f" 2>/dev/null || continue            # promptless stub (fork artifact / killed boot) — noise that must never spread to collaborators; it exports once it gains a real prompt
    dest="$WT/sessions/$author/$id.jsonl"
    if ! cmp -s "$f" "$dest" 2>/dev/null; then cp -f "$f" "$dest" 2>/dev/null && PUSHED=$((PUSHED+1)); fi
  done
  return 0
}

# Commit staged session changes and push, retrying once through a fetch+merge on a non-ff rejection.
commit_and_push() {
  purge_tombstoned                                  # STAGE removal of any tombstoned file FIRST (authoritative deletion)
  gitwt add --ignore-removal -- . >/dev/null 2>&1   # never propagate INCIDENTAL deletions (a partial checkout must not delete others' sessions)
  if ! gitwt diff --cached --quiet >/dev/null 2>&1; then
    gitwt commit -m "claudible: sync sessions ($author)" >/dev/null 2>&1
  fi
  local i
  for i in 1 2 3; do
    gitwt push origin "$BR" >/dev/null 2>&1 && return 0
    git -C "$WT" rev-parse "@{upstream}" >/dev/null 2>&1 || gitwt branch --set-upstream-to="origin/$BR" "$BR" >/dev/null 2>&1
    pull_branch || return 1                                          # integrate the new remote tip, then retry
    purge_tombstoned                                                 # the merge may have re-introduced a raced re-add — purge + re-stage before retrying
    gitwt add --ignore-removal -- . >/dev/null 2>&1
    gitwt diff --cached --quiet >/dev/null 2>&1 || gitwt commit -m "claudible: sync sessions ($author)" >/dev/null 2>&1
  done
  return 1
}

count_synced() { ls "$WT"/sessions/*/*.jsonl 2>/dev/null | wc -l | tr -d ' '; }

# JSON array of the session ids import_sessions changed on disk this run. Safe to interpolate raw:
# every id passed the strict [A-Za-z0-9-] filter above. The app uses this to reload any OPEN tab
# whose transcript was just replaced — the "out of sync doesn't refresh the open session" fix.
ids_json() {
  local out="" i
  for i in ${CHANGED_IDS:-}; do out="$out,\"$i\""; done   # :- guards set -u if an op ever emits without importing
  printf '[%s]' "${out#,}"
}

case "$op" in
  init)
    ensure_worktree || fail "could not set up the sessions branch"
    emit "{\"ok\":true,\"op\":\"init\",\"synced\":$(count_synced)}"
    ;;
  pull)
    ensure_worktree || fail "could not set up the sessions branch"
    pull_branch || fail "pull failed"
    import_sessions
    emit "{\"ok\":true,\"op\":\"pull\",\"imported\":$IMPORTED,\"updated\":$UPDATED,\"diverged\":$DIVERGED,\"ids\":$(ids_json)}"
    ;;
  push)
    ensure_worktree || fail "could not set up the sessions branch"
    pull_branch || fail "pull failed"
    export_sessions
    commit_and_push || fail "push failed (no access, or network)"
    emit "{\"ok\":true,\"op\":\"push\",\"pushed\":$PUSHED}"
    ;;
  sync)
    ensure_worktree || fail "could not set up the sessions branch"
    pull_branch || fail "pull failed"
    import_sessions
    export_sessions
    commit_and_push || fail "push failed (no access, or network)"
    emit "{\"ok\":true,\"op\":\"sync\",\"imported\":$IMPORTED,\"updated\":$UPDATED,\"diverged\":$DIVERGED,\"pushed\":$PUSHED,\"ids\":$(ids_json)}"
    ;;
  delete)
    # "Delete everywhere": drop a tombstone on the branch + remove the transcript from EVERY author dir, so
    # the session can't resurrect on anyone's sync. Arg $2 = id.
    ensure_worktree || fail "could not set up the sessions branch"
    did="${2:-}"
    case "$did" in '' | -* | *- | *[!A-Za-z0-9-]*) fail "bad id" ;; esac
    pull_branch || fail "pull failed"
    mkdir -p "$WT/sessions/.tombstones" 2>/dev/null
    : > "$WT/sessions/.tombstones/$did"                    # positive marker (an ADD → propagates)
    rm -f "$WT"/sessions/*/"$did.jsonl" 2>/dev/null        # remove from every author dir on the branch
    if [ -e "$PROJ/$did.jsonl" ]; then                     # and locally (recoverable trash)
      mkdir -p "$HOME/.claudible/trash" 2>/dev/null
      mv -f "$PROJ/$did.jsonl" "$HOME/.claudible/trash/$did.$(date +%Y%m%d-%H%M%S).deleted.jsonl" 2>/dev/null
    fi
    gitwt add -A >/dev/null 2>&1                           # stage the tombstone ADD + the explicit removals (intended here, unlike sync)
    gitwt diff --cached --quiet >/dev/null 2>&1 || gitwt commit -m "claudible: delete session $did" >/dev/null 2>&1
    pushed=0
    for i in 1 2 3; do
      if gitwt push origin "$BR" >/dev/null 2>&1; then pushed=1; break; fi
      pull_branch || break                                 # integrate the new tip (keeps our commit), then retry
    done
    [ "$pushed" = 1 ] || fail "push failed (no access, or network)"
    emit "{\"ok\":true,\"op\":\"delete\",\"id\":\"$did\"}"
    ;;
  resolve)
    # Resolve an out-of-sync (forked) session. $2=id, $3=strategy:
    #   remote = TAKE THE SHARED COPY (the collaborator's/originator's version on the branch). Reuses import_file,
    #            so it lands foreign + aged + atomic, exactly like a normal import — no new trust surface. The local
    #            fork was never published (export skips foreign ids), so the branch holds ONLY the shared copy; after
    #            taking it local == branch and the next sync clears the flag for good.
    #   local  = KEEP MY COPY — clear the flag and ACK it so import stops re-nagging (still a fork, but I chose).
    ensure_worktree || fail "could not set up the sessions branch"
    rid="${2:-}"; rstrat="${3:-remote}"
    case "$rid" in '' | -* | *- | *[!A-Za-z0-9-]*) fail "bad id" ;; esac
    case "$rstrat" in remote|local) ;; *) fail "bad strategy" ;; esac
    pull_branch || fail "pull failed"
    tombstoned "$rid" && fail "that session was deleted everywhere"
    if [ "$rstrat" = local ]; then
      clear_diverged "$rid"; mark_ack "$rid"                         # clear_diverged drops both flags; re-ack so it sticks
      emit "{\"ok\":true,\"op\":\"resolve\",\"strategy\":\"local\",\"id\":\"$rid\"}"
    else
      best=""; bestsz=-1
      for f in "$WT"/sessions/*/"$rid.jsonl"; do
        [ -e "$f" ] || continue
        head -c 1 "$f" 2>/dev/null | grep -q '{' || continue        # must look like JSONL
        sz="$(wc -c < "$f" 2>/dev/null || echo 0)"
        [ "$sz" -gt "$bestsz" ] && { best="$f"; bestsz="$sz"; }       # take the largest shared copy (most turns ≈ latest)
      done
      [ -n "$best" ] || fail "no shared copy to take (nothing on the branch for this session)"
      import_file "$best" "$PROJ/$rid.jsonl" "$rid" || fail "could not write the shared copy"
      clear_diverged "$rid"
      emit "{\"ok\":true,\"op\":\"resolve\",\"strategy\":\"remote\",\"id\":\"$rid\"}"
    fi
    ;;
  presence-set)
    # Advertise "I'm live in session $2, joinable at $3 with token $4" so a collaborator in this workspace can
    # join natively — no link to paste. One small file per author under live/. Ignored by the session import.
    ensure_worktree || fail "could not set up the sessions branch"
    psid="${2:-}"; purl="${3:-}"; ptok="${4:-}"; pname_b64="${5:-}"
    case "$psid" in '' | *[!A-Za-z0-9-]*) fail "bad id" ;; esac
    case "$purl" in https://*|http://127.0.0.1:*|http://localhost:*) ;; *) fail "bad url" ;; esac
    case "$purl" in *[!A-Za-z0-9:/._-]*) fail "bad url" ;; esac
    case "$ptok" in '' | *[!A-Za-z0-9._~-]*) fail "bad token" ;; esac
    case "$pname_b64" in *[!A-Za-z0-9+/=]*) fail "bad name" ;; esac
    # The chosen display name arrives base64 (arbitrary text); decode then strip JSON-breakers (quotes, backslashes,
    # control chars incl. newlines) so it drops safely into the one-line JSON. Renderer falls back to login if empty.
    pname=""
    [ -n "$pname_b64" ] && pname="$(printf '%s' "$pname_b64" | base64 -d 2>/dev/null | tr -d '"\\' | tr -d '\000-\037')"
    pull_branch || fail "pull failed"
    # ONE live host per session: if another collaborator already holds a FRESH claim on this session, refuse
    # instead of publishing a second advertisement (two hosts on one session = two divergent "live" copies and
    # an ambiguous Join target). The tool prints a complete refusal line when blocked, nothing when free — and
    # never self-refuses (my own fresh claim = the ~2-min heartbeat re-stamping). Re-checked after every
    # push-retry pull below: per-author files merge cleanly, so a simultaneous rival claim arrives via THAT
    # pull — the tool's deterministic tie-break (earlier ts, then login) makes exactly one of us yield.
    # win-native: subshell unsets MSYS_NO_PATHCONV so git-bash converts node's /c/.. script path
    live_refuse() { (unset MSYS_NO_PATHCONV; CL_DIR="$WT/live" CL_SID="$psid" CL_ME="$author" node "$(dirname "$0")/sessions-sync-tool.js" live-holder 2>/dev/null); }
    refuse="$(live_refuse)"
    if [ -n "$refuse" ]; then
      # Yield cleanly: if OUR OWN (losing) claim for this same session is already on the branch — a lost push
      # race being re-checked by the heartbeat, or a legacy double-share — retract it now, so peers converge on
      # ONE live host immediately instead of showing two until the loser's stale claim ages past the TTL.
      if [ -e "$WT/live/$author.json" ] && grep -q "\"session\":\"$psid\"" "$WT/live/$author.json" 2>/dev/null; then
        gitwt rm -q --ignore-unmatch -- "live/$author.json" >/dev/null 2>&1
        gitwt diff --cached --quiet >/dev/null 2>&1 || gitwt commit -m "claudible: presence yield $author" >/dev/null 2>&1
        for j in 1 2 3; do gitwt push origin "$BR" >/dev/null 2>&1 && break; pull_branch || break; done
      fi
      emit "$refuse"; exit 0
    fi
    mkdir -p "$WT/live" 2>/dev/null
    printf '{"login":"%s","session":"%s","url":"%s","token":"%s","name":"%s","ts":%s}\n' "$author" "$psid" "$purl" "$ptok" "$pname" "$(date +%s)" > "$WT/live/$author.json"
    gitwt add -A -- "live/$author.json" >/dev/null 2>&1
    gitwt diff --cached --quiet >/dev/null 2>&1 || gitwt commit -m "claudible: presence $author" >/dev/null 2>&1
    pushed=0
    for i in 1 2 3; do
      gitwt push origin "$BR" >/dev/null 2>&1 && { pushed=1; break; }
      pull_branch || break
      refuse="$(live_refuse)"
      if [ -n "$refuse" ]; then
        # A rival won the race while we were pushing: RETRACT the claim we already committed (it merged in
        # alongside theirs — leaving it would advertise a second host) and tell the renderer who holds it.
        gitwt rm -q --ignore-unmatch -- "live/$author.json" >/dev/null 2>&1
        gitwt diff --cached --quiet >/dev/null 2>&1 || gitwt commit -m "claudible: presence yield $author" >/dev/null 2>&1
        for j in 1 2 3; do gitwt push origin "$BR" >/dev/null 2>&1 && break; pull_branch || break; done
        emit "$refuse"; exit 0
      fi
    done
    [ "$pushed" = 1 ] && emit "{\"ok\":true,\"op\":\"presence-set\"}" || emit "{\"ok\":false,\"op\":\"presence-set\",\"error\":\"push failed\"}"
    ;;
  presence-clear)
    ensure_worktree || fail "could not set up the sessions branch"
    pull_branch || fail "pull failed"
    pushed=1
    if [ -e "$WT/live/$author.json" ]; then
      gitwt rm -q --ignore-unmatch -- "live/$author.json" >/dev/null 2>&1
      gitwt diff --cached --quiet >/dev/null 2>&1 || gitwt commit -m "claudible: presence clear $author" >/dev/null 2>&1
      pushed=0; for i in 1 2 3; do gitwt push origin "$BR" >/dev/null 2>&1 && { pushed=1; break; }; pull_branch || break; done
    fi
    [ "$pushed" = 1 ] && emit "{\"ok\":true,\"op\":\"presence-clear\"}" || emit "{\"ok\":false,\"op\":\"presence-clear\",\"error\":\"push failed\"}"
    ;;
  presence-list)
    # Read every collaborator's live/*.json straight off origin via fetch + git show — NO worktree merge, so this
    # frequent (~10s) poll can never fight the background sync's merge on the same worktree. Renderer filters stale ts.
    ensure_worktree || fail "could not set up the sessions branch"
    git -C "$WT" fetch origin "$BR" >/dev/null 2>&1
    # Emit each collaborator's live/<author>.json blob on its own line, then let node JSON-validate each so a single
    # corrupt/torn/concatenated file ("{}x{}") is DROPPED instead of poisoning the whole peers[] array — which would
    # make the renderer's JSON.parse throw and silently kill the roster / "Join live" badge (the brace-only guard
    # this replaces accepted such junk verbatim). NUL-delimited (-z) + read -d '' keeps push-controlled filenames
    # from word-splitting; the case-guard blocks non-live/*.json paths (defense-in-depth). head -c 4096 caps a
    # pathological file so it can't blow up the parse. One node spawn total.
    # win-native: subshell unsets MSYS_NO_PATHCONV so git-bash converts node's /c/.. script path
    result="$(
      while IFS= read -r -d '' path; do
        case "$path" in live/*.json) ;; *) continue ;; esac
        [ "$path" = "live/$author.json" ] && continue                # skip my own advertisement
        git -C "$WT" show "origin/$BR:$path" 2>/dev/null | head -c 4096 | tr -d '\n\r'; printf '\n'
      done < <(git -C "$WT" ls-tree -r --name-only -z "origin/$BR" -- live/ 2>/dev/null) \
      | (unset MSYS_NO_PATHCONV; node "$(dirname "$0")/sessions-sync-tool.js" presence-filter)
    )"
    [ -n "$result" ] && emit "$result" || emit "{\"ok\":true,\"op\":\"presence-list\",\"peers\":[]}"   # node absent/failed → still emit a valid (empty) list so the renderer never chokes
    ;;
  title-set)
    # Share a session's display NAME across the workspace: merge {id:{title,ts}} into my OWN meta/<author>.json
    # (one file per author => disjoint paths => conflict-free, exactly like sessions/<author>/ and live/). The name
    # arrives base64 in $3 so arbitrary text — quotes, spaces, unicode — can never break the shell. Empty => clear.
    ensure_worktree || fail "could not set up the sessions branch"
    tid="${2:-}"; tb64="${3:-}"
    case "$tid" in '' | -* | *- | *[!A-Za-z0-9-]*) fail "bad id" ;; esac
    case "$tb64" in *[!A-Za-z0-9+/=]*) fail "bad name" ;; esac
    pull_branch || fail "pull failed"
    mkdir -p "$WT/meta" 2>/dev/null
    # win-native: subshell unsets MSYS_NO_PATHCONV so git-bash converts node's /c/.. script path (the gitwt push below still needs MSYS_NO_PATHCONV for the $BR refspec)
    (unset MSYS_NO_PATHCONV; CL_ID="$tid" CL_B64="$tb64" CL_FILE="$WT/meta/$author.json" node "$(dirname "$0")/sessions-sync-tool.js" title-write) || fail "title write failed"
    gitwt add -- "meta/$author.json" >/dev/null 2>&1
    gitwt diff --cached --quiet >/dev/null 2>&1 || gitwt commit -m "claudible: title $author" >/dev/null 2>&1
    pushed=0; for i in 1 2 3; do gitwt push origin "$BR" >/dev/null 2>&1 && { pushed=1; break; }; pull_branch || break; done
    [ "$pushed" = 1 ] && emit "{\"ok\":true,\"op\":\"title-set\"}" || emit "{\"ok\":false,\"op\":\"title-set\",\"error\":\"push failed\"}"
    ;;
  title-list)
    # Resolve every id to its newest title across all authors (last-writer-wins by ts). Read straight off origin
    # via fetch + show — NO worktree merge — like presence-list, so this poll never fights the background sync.
    ensure_worktree || fail "could not set up the sessions branch"
    git -C "$WT" fetch origin "$BR" >/dev/null 2>&1
    # win-native: subshell unsets MSYS_NO_PATHCONV so git-bash converts node's /c/.. script path
    (unset MSYS_NO_PATHCONV; CL_WT="$WT" CL_BR="$BR" CL_TS=1 node "$(dirname "$0")/sessions-sync-tool.js" title-read) || fail "title read failed"
    ;;
  status)
    if [ -d "$WT" ] && git -C "$WT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      emit "{\"ok\":true,\"op\":\"status\",\"ready\":true,\"synced\":$(count_synced)}"
    else
      emit "{\"ok\":true,\"op\":\"status\",\"ready\":false,\"synced\":0}"
    fi
    ;;
esac
