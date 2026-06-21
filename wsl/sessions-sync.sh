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

emit() { printf '%s\n' "$1"; }
fail() { emit "{\"ok\":false,\"error\":\"$1\"}"; exit 0; }

op="${1:-status}"
case "$op" in init|push|pull|sync|status|delete|presence-set|presence-clear|presence-list|title-set|title-list) ;; *) fail "bad op" ;; esac

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
PROJ="$HOME/.claude/projects/$(printf '%s' "$SDIR" | sed 's#[^A-Za-z0-9]#-#g')"

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
mark_diverged() { grep -qxF -- "$1" "$DDSET" 2>/dev/null || printf '%s\n' "$1" >> "$DDSET"; }
clear_diverged() { [ -e "$DDSET" ] || return 0; { grep -vxF -- "$1" "$DDSET" 2>/dev/null || true; } > "$DDSET.tmp"; mv -f "$DDSET.tmp" "$DDSET" 2>/dev/null; }
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
  # first gate of every op. Origin wins; our OWN session content is re-derived from $PROJ on the next
  # export, so reset loses nothing real. This self-heals the one-account-two-machines same-id case.
  gitwt merge --abort >/dev/null 2>&1
  gitwt reset --hard "origin/$BR" >/dev/null 2>&1 || return 1
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
apply_tombstones() { purge_tombstoned; }   # import_sessions calls this name — keep the shim
import_sessions() {
  mkdir -p "$PROJ" 2>/dev/null
  apply_tombstones                                                  # honor collaborators' "delete everywhere"
  IMPORTED=0; UPDATED=0; DIVERGED=0
  [ -d "$WT/sessions" ] || return 0
  local f id dest dsz
  for f in "$WT"/sessions/*/*.jsonl; do
    [ -e "$f" ] || continue
    id="$(basename "$f" .jsonl)"
    case "$id" in '' | -* | *- | *[!A-Za-z0-9-]*) continue ;; esac  # reject leading/trailing-dash ids (argv tricks)
    tombstoned "$id" && continue                                    # deleted everywhere → never re-import
    head -c 1 "$f" 2>/dev/null | grep -q '{' || continue            # must look like line-delimited JSON
    dest="$PROJ/$id.jsonl"
    if [ ! -e "$dest" ]; then                                       # new on the branch → import (untrusted, atomic)
      import_file "$f" "$dest" "$id" && { IMPORTED=$((IMPORTED+1)); clear_diverged "$id"; }; continue
    fi
    if cmp -s "$f" "$dest"; then clear_diverged "$id"; continue; fi  # identical → leave trust status unchanged, resolve any fork flag
    dsz="$(wc -c < "$dest" 2>/dev/null || echo 0)"
    if [ "$(wc -c < "$f")" -gt "$dsz" ] && head -c "$dsz" "$f" | cmp -s - "$dest"; then
      import_file "$f" "$dest" "$id" && { UPDATED=$((UPDATED+1)); clear_diverged "$id"; }   # remote = local + more turns → ff (now foreign)
    elif head -c "$(wc -c < "$f")" "$dest" | cmp -s - "$f"; then
      clear_diverged "$id"                                          # local is ahead of remote → our push handles it
    else
      DIVERGED=$((DIVERGED+1)); mark_diverged "$id"                 # true fork → leave local untouched, flag it per-row
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
    m="$(stat -c %Y "$f" 2>/dev/null || echo 0)"; age=$(( $(date +%s) - m ))   # torn-write guard: skip a file still
    [ "$age" -ge 0 ] && [ "$age" -lt "${CLAUDIBLE_SYNC_MIN_AGE:-2}" ] && continue   # being written (~2s); ignore future mtimes (clock skew)
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

case "$op" in
  init)
    ensure_worktree || fail "could not set up the sessions branch"
    emit "{\"ok\":true,\"op\":\"init\",\"synced\":$(count_synced)}"
    ;;
  pull)
    ensure_worktree || fail "could not set up the sessions branch"
    pull_branch || fail "pull failed"
    import_sessions
    emit "{\"ok\":true,\"op\":\"pull\",\"imported\":$IMPORTED,\"updated\":$UPDATED,\"diverged\":$DIVERGED}"
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
    emit "{\"ok\":true,\"op\":\"sync\",\"imported\":$IMPORTED,\"updated\":$UPDATED,\"diverged\":$DIVERGED,\"pushed\":$PUSHED}"
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
    mkdir -p "$WT/live" 2>/dev/null
    printf '{"login":"%s","session":"%s","url":"%s","token":"%s","name":"%s","ts":%s}\n' "$author" "$psid" "$purl" "$ptok" "$pname" "$(date +%s)" > "$WT/live/$author.json"
    gitwt add -A -- "live/$author.json" >/dev/null 2>&1
    gitwt diff --cached --quiet >/dev/null 2>&1 || gitwt commit -m "claudible: presence $author" >/dev/null 2>&1
    for i in 1 2 3; do gitwt push origin "$BR" >/dev/null 2>&1 && break; pull_branch || break; done
    emit "{\"ok\":true,\"op\":\"presence-set\"}"
    ;;
  presence-clear)
    ensure_worktree || fail "could not set up the sessions branch"
    pull_branch || fail "pull failed"
    if [ -e "$WT/live/$author.json" ]; then
      gitwt rm -q --ignore-unmatch -- "live/$author.json" >/dev/null 2>&1
      gitwt diff --cached --quiet >/dev/null 2>&1 || gitwt commit -m "claudible: presence clear $author" >/dev/null 2>&1
      for i in 1 2 3; do gitwt push origin "$BR" >/dev/null 2>&1 && break; pull_branch || break; done
    fi
    emit "{\"ok\":true,\"op\":\"presence-clear\"}"
    ;;
  presence-list)
    # Read every collaborator's live/*.json straight off origin via fetch + git show — NO worktree merge, so this
    # frequent (~10s) poll can never fight the background sync's merge on the same worktree. Renderer filters stale ts.
    ensure_worktree || fail "could not set up the sessions branch"
    git -C "$WT" fetch origin "$BR" >/dev/null 2>&1
    out=""
    for path in $(git -C "$WT" ls-tree -r --name-only "origin/$BR" -- live/ 2>/dev/null); do
      case "$path" in live/*.json) ;; *) continue ;; esac
      [ "$path" = "live/$author.json" ] && continue                  # skip my own advertisement
      line="$(git -C "$WT" show "origin/$BR:$path" 2>/dev/null | head -c 4096 | tr -d '\n\r')"
      case "$line" in '{'*'}') ;; *) continue ;; esac                # only well-formed single-object lines
      [ -n "$out" ] && out="$out,$line" || out="$line"
    done
    emit "{\"ok\":true,\"op\":\"presence-list\",\"peers\":[$out]}"
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
    CL_ID="$tid" CL_B64="$tb64" CL_FILE="$WT/meta/$author.json" python3 - <<'PY' || fail "title write failed"
import json, os, time, base64
f = os.environ['CL_FILE']; i = os.environ['CL_ID']
try:
    n = base64.b64decode(os.environ.get('CL_B64', '')).decode('utf-8', 'replace')
except Exception:
    n = ''
n = ''.join(c for c in n if ord(c) >= 32)[:200].strip()   # strip control chars/newlines, cap length
try:
    d = json.load(open(f))
    if not isinstance(d, dict): d = {}
except Exception:
    d = {}
d[i] = {"title": n, "ts": int(time.time())}
tmp = f + '.tmp'
json.dump(d, open(tmp, 'w'), ensure_ascii=False)
os.replace(tmp, f)
PY
    gitwt add -- "meta/$author.json" >/dev/null 2>&1
    gitwt diff --cached --quiet >/dev/null 2>&1 || gitwt commit -m "claudible: title $author" >/dev/null 2>&1
    for i in 1 2 3; do gitwt push origin "$BR" >/dev/null 2>&1 && break; pull_branch || break; done
    emit "{\"ok\":true,\"op\":\"title-set\"}"
    ;;
  title-list)
    # Resolve every id to its newest title across all authors (last-writer-wins by ts). Read straight off origin
    # via fetch + show — NO worktree merge — like presence-list, so this poll never fights the background sync.
    ensure_worktree || fail "could not set up the sessions branch"
    git -C "$WT" fetch origin "$BR" >/dev/null 2>&1
    CL_WT="$WT" CL_BR="$BR" python3 - <<'PY' || fail "title read failed"
import json, os, subprocess
wt = os.environ['CL_WT']; br = os.environ['CL_BR']
def git(*a):
    return subprocess.run(['git', '-C', wt, *a], capture_output=True, text=True).stdout
paths = [p for p in git('ls-tree', '-r', '--name-only', 'origin/' + br, '--', 'meta/').split('\n')
         if p.endswith('.json')]
best = {}   # id -> (ts, title)
for p in paths:
    try:
        d = json.loads(git('show', 'origin/%s:%s' % (br, p)) or '{}')
    except Exception:
        continue
    if not isinstance(d, dict):
        continue
    for i, v in d.items():
        if not isinstance(v, dict):
            continue
        ts = v.get('ts', 0); t = v.get('title', '')
        if not isinstance(ts, (int, float)) or not isinstance(t, str):
            continue
        if i not in best or ts > best[i][0]:
            best[i] = (ts, t)
print(json.dumps({"ok": True, "op": "title-list", "titles": {i: t for i, (ts, t) in best.items()}}))
PY
    ;;
  status)
    if [ -d "$WT" ] && git -C "$WT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      emit "{\"ok\":true,\"op\":\"status\",\"ready\":true,\"synced\":$(count_synced)}"
    else
      emit "{\"ok\":true,\"op\":\"status\",\"ready\":false,\"synced\":0}"
    fi
    ;;
esac
