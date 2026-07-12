#!/usr/bin/env bash
# Claudible — session bootstrap (runs inside the embedded terminal's pty).
# Installs statusLine + hooks into a DEDICATED session dir (keeps them out of the user's repos
# and global ~/.claude), then launches the real Claude session directly (no tmux — tmux's alternate
# screen has no scrollback, which would break the mouse wheel in xterm.js).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"                   # ABSOLUTE script dir, resolved BEFORE any cd into the workspace
. "$HERE/_ws-dir.sh"                                    # defines WS_KIND / WS_SLUG / SDIR — the one workspace-dir resolution
# Runtime files live on the Windows FS so the Electron app reads them natively (NOT over the flaky
# \\wsl.localhost 9P boundary). The app passes its OWN folder (as a /mnt path) in $1 — no hardcoded home.
APPDIR="${1:?usage: session.sh <app-dir-as-wsl-path>}"
# Per-TAB runtime isolation: each Claudible tab is its own live session/pty, but they share one Windows
# runtime/ dir. Status + hooks must live under runtime/tabs/<tab>/ so two concurrent sessions never
# truncate or interleave each other's streams. The app inlines CLAUDIBLE_TAB (a strict [A-Za-z0-9-]
# leaf); unset/bad falls back to 'default', so a lone session stays fully backward compatible.
TAB="${CLAUDIBLE_TAB:-}"
case "$TAB" in '' | *[!A-Za-z0-9-]*) TAB="default" ;; esac
RT="$APPDIR/runtime/tabs/$TAB"
STATUS="$RT/status.json"
HOOKS="$RT/hooks.ndjson"
CONTEXT="$RT/context.json"   # app→Claude identity/live-state (main writes it; the context hook reads it to tell the model which machine/user/live-session it's on)
# Exported so Claude — and the hook/statusline subprocesses it spawns — inherit the per-tab paths.
# The generated scripts below read these at RUNTIME (not bake-time), so the SHARED scripts route each
# tab's output to its own files based on that tab's Claude process env (env inheritance is verified).
export CLAUDIBLE_TAB CLAUDIBLE_STATUS="$STATUS" CLAUDIBLE_HOOKS="$HOOKS" CLAUDIBLE_CONTEXT="$CONTEXT"

# SPACEBAR / "can't type into a resumed session" fix. Claude Code 2.1.x (gate tengu_gleaming_fair) shows a
# BLOCKING "resume from summary?" selection modal when you resume a session older than
# CLAUDE_CODE_RESUME_THRESHOLD_MINUTES (default 70) AND above CLAUDE_CODE_RESUME_TOKEN_THRESHOLD (default
# 100k). That modal is a 1/2/3 list that SWALLOWS every ordinary keystroke — space included — until you
# arrow/number+Enter or Esc. In the embedded terminal a user just sees "I open a big/old session and my
# typing (spaces) does nothing", while a brand-new session (0 tokens/0 age → no modal) types fine. Co-workers
# who reopen large shared sessions hit it constantly. Claudible already keeps full context by choice
# (autoCompactEnabled:false), so we push both thresholds out of reach → resumed sessions land straight in the
# composer, exactly like a new one. Respect an explicit user override if one is already set.
export CLAUDE_CODE_RESUME_THRESHOLD_MINUTES="${CLAUDE_CODE_RESUME_THRESHOLD_MINUTES:-2000000000}"
export CLAUDE_CODE_RESUME_TOKEN_THRESHOLD="${CLAUDE_CODE_RESUME_TOKEN_THRESHOLD:-2000000000}"

# "PLAN BIG, EXECUTE SMALL" (Anthropic cookbook pattern; app setting, default ON). The main session plans and
# synthesizes on the user's chosen model; SUBAGENTS — the token-heavy leg (bulk reading, sweeps, workflows) —
# run on Sonnet 5 via Claude Code's CLAUDE_CODE_SUBAGENT_MODEL. On a Fable 5/Opus main model this is the
# cookbook's measured ~2.5×-cheaper split at matched rigor; on a Sonnet main it's a harmless no-op. An
# explicit user override of CLAUDE_CODE_SUBAGENT_MODEL always wins. The exported strategy var is inherited
# by the context hook, which injects the delegation nudge (the savings only happen if the model delegates).
if [ "${CLAUDIBLE_MODEL_STRATEGY:-}" = "planBigExecSmall" ]; then
  export CLAUDE_CODE_SUBAGENT_MODEL="${CLAUDE_CODE_SUBAGENT_MODEL:-claude-sonnet-5}"
  export CLAUDIBLE_MODEL_STRATEGY
fi

# The project folder is GONE — deleted or moved outside Claudible, or an unmounted drive. `mkdir -p` below would
# silently RECREATE the whole path and launch Claude in an empty directory where the user's code used to be, with no
# warning whatsoever. Only a PERMISSION failure was ever reported; a vanished folder was not. Say it, loudly, first.
# (We warn rather than refuse: a dead tab with no way forward is worse, and for a Claudible-created workspace an
# empty dir is the correct state anyway. For an adopted folder it is emphatically not — hence the wording.)
if [ ! -d "$SDIR" ]; then
  echo "" >&2
  echo "[claudible] WARNING — this project's folder does not exist:" >&2
  echo "[claudible]   $SDIR" >&2
  echo "[claudible] It was deleted or moved outside Claudible (or its drive isn't mounted)." >&2
  echo "[claudible] Recreating it EMPTY. Your files are NOT here. If the folder still exists somewhere," >&2
  echo "[claudible] quit, restore or remount it, and reopen the project — don't work in this directory." >&2
  echo "" >&2
fi
mkdir -p "$SDIR/.claude" "$RT" || { echo "[claudible] FATAL: could not create the session dir ($SDIR) or runtime dir ($RT) — aborting instead of launching Claude in the wrong place." >&2; exit 1; }
# Our pid + start-time, so killtree.sh can reap this generation's whole tree (ConPTY kills never reach the WSL
# side). The start-time makes the pidfile recycle-proof, and unlike a cmdline check it survives the FRESH branch's
# exec into claude (exec keeps pid AND start-time). It is read through proc_stime(), which is /proc on Linux/WSL
# and `ps -o lstart=` on macOS — where /proc does not exist and this line used to write an EMPTY start-time, which
# made killtree.sh decline to kill ANYTHING, on every tab close, forever. See wsl/_proc-stime.sh.
. "$HERE/_proc-stime.sh"
printf '%s %s\n' "$$" "$(proc_stime "$$")" > "$RT/boot.pid"
: > "$HOOKS"            # fresh hook stream for THIS tab per launch (other tabs' files untouched)
printf '{}' > "$STATUS" # clear stale status so the meter starts blank, not on last session's numbers

# --- taking ownership of $SDIR/.claude ---------------------------------------------------------------
# Everything below stages Claudible's runtime into $SDIR/.claude and OVERWRITES each file unconditionally. For a
# workspace Claudible CREATED, those names have never meant anything else. An ADOPTED folder is the user's own
# project: a hand-rolled .claude/statusline.js is a common thing to have, and settings.json may hold their
# permissions, MCP servers and hooks. Snapshot every name we are about to take, ONCE, before the first write.
#
# The sidecar — not a marker key inside settings.json — records that we already did: Claude Code validates that
# file against a schema and warns on unknown keys. Keep this list in sync with what gets written below (node
# hooks, bash-fallback hooks, settings) and with runners/win.js's installHooks(), its Windows-native twin.
#
# Workspaces created before the sidecar existed have a .claude full of OUR files and no marker. Backing those up
# would litter every existing install with a "pre-claudible" copy of Claudible's own settings. So recognize our
# own settings.json first, by two things together that no hand-written config would both carry: the
# DISABLE_AUTO_COMPACT env we set, and a statusLine command pointing inside this workspace's .claude. The bias is
# deliberate — a false "not ours" costs one stray backup file, a false "ours" costs the user their config.
if [ ! -e "$SDIR/.claude/.claudible-owned" ]; then
  if [ -f "$SDIR/.claude/settings.json" ] \
     && grep -q 'DISABLE_AUTO_COMPACT' "$SDIR/.claude/settings.json" 2>/dev/null \
     && grep -q '\.claude/statusline' "$SDIR/.claude/settings.json" 2>/dev/null; then
    : # this .claude was already Claudible's — adopt the sidecar, back nothing up
  else
    for _f in settings.json statusline.js hook.js context-hook.js statusline.sh hook.sh context-hook.sh; do
      [ -f "$SDIR/.claude/$_f" ] && cp "$SDIR/.claude/$_f" "$SDIR/.claude/$_f.pre-claudible" 2>/dev/null
    done
  fi
  : > "$SDIR/.claude/.claudible-owned" 2>/dev/null || true
fi

# --- statusLine + hooks ----------------------------------------------------------------------------
# Prefer the SHARED Node hooks ($APPDIR/hooks/*.js — ONE implementation reused by WSL / Windows-native /
# Posix, and no python3). Fall back to inline bash hooks if node can't be found: a minimal native-claude
# install may ship no node on PATH, and WSL always has bash, so telemetry/agents NEVER silently die. The
# two Node hooks are byte-for-byte equivalent to the bash ones (test/hooks-parity.sh). Per-tab routing
# rides the inherited CLAUDIBLE_STATUS/HOOKS env in BOTH modes; the staged path stays in $SDIR/.claude
# (fast local reads, no per-tick /mnt/c hit).
. "$HERE/node-path.sh" 2>/dev/null || true              # nvm's node isn't on PATH for non-interactive shells → resolve it
NODE_BIN="$(command -v node 2>/dev/null || true)"
# Guard: a Windows node.exe (or any /mnt-mounted node) reached via WSL interop can't write Linux per-tab
# paths — reject it so we fall back to bash rather than silently no-op telemetry. (command -v node won't
# normally resolve to node.exe under interop, but this bulletproofs the most-consumed pipeline.)
case "$NODE_BIN" in *.exe | /mnt/*) NODE_BIN="" ;; esac
HOOK_MODE="bash"
if [ -n "$NODE_BIN" ] && [ -f "$APPDIR/hooks/statusline.js" ] && [ -f "$APPDIR/hooks/hook.js" ]; then
  # Stage the context hook too when present; it's additive, so its absence must NOT force the bash fallback
  # (an older bundle without it still gets telemetry via the two required hooks).
  [ -f "$APPDIR/hooks/context-hook.js" ] && cp "$APPDIR/hooks/context-hook.js" "$SDIR/.claude/" 2>/dev/null || true
  if cp "$APPDIR/hooks/statusline.js" "$APPDIR/hooks/hook.js" "$SDIR/.claude/" 2>/dev/null; then
    HOOK_MODE="node"
  else
    echo "[claudible] WARN: couldn't stage the node hooks into $SDIR/.claude — using bash hooks." >&2
  fi
fi

if [ "$HOOK_MODE" = "node" ]; then
  # Bake the ABSOLUTE node path (no PATH-resolution doubt in Claude's hook-invocation context) AND the
  # per-tab status/hooks path as a trailing arg. The .js prefers the inherited CLAUDIBLE_STATUS/HOOKS env
  # (per-tab routing) and uses this baked arg only as a fallback — mirroring the bash ${CLAUDIBLE_STATUS:-$STATUS}
  # defense-in-depth, so a dropped env never silently loses telemetry/agents/voice/sync.
  SL_CMD="'$NODE_BIN' '$SDIR/.claude/statusline.js' '$STATUS'"
  HK_CMD="'$NODE_BIN' '$SDIR/.claude/hook.js' '$HOOKS'"
  # Identity/live-state context hook (only if it staged). CX_CMD empty → the SessionStart/UserPromptSubmit
  # context entries are omitted below, so an older bundle behaves exactly as before.
  [ -f "$SDIR/.claude/context-hook.js" ] && CX_CMD="'$NODE_BIN' '$SDIR/.claude/context-hook.js' '$CONTEXT'" || CX_CMD=""
else
  # bash fallback — generate the original two scripts inline (statusLine via python3; hook = append).
  cat > "$SDIR/.claude/statusline.sh" <<EOF
#!/usr/bin/env bash
in=\$(cat)
out="\${CLAUDIBLE_STATUS:-$STATUS}"   # per-tab path from the inheriting Claude env; baked path is the fallback
printf '%s' "\$in" > "\$out"
printf '%s' "\$in" | python3 -c "import sys,json
try:
    d=json.load(sys.stdin); c=d.get('context_window',{})
    print('claudible · %s%% ctx' % c.get('used_percentage','?'))
except: print('claudible')" 2>/dev/null || printf 'claudible'
EOF
  chmod +x "$SDIR/.claude/statusline.sh"
  cat > "$SDIR/.claude/hook.sh" <<EOF
#!/usr/bin/env bash
line=\$(cat)
out="\${CLAUDIBLE_HOOKS:-$HOOKS}"   # per-tab path from the inheriting Claude env; baked path is the fallback
printf '%s\n' "\$line" >> "\$out"
exit 0
EOF
  chmod +x "$SDIR/.claude/hook.sh"
  # bash-fallback context hook: pure shell, no node, so the model STILL learns which machine/user it's on even
  # on a node-less install. Ground-truth ONLY (hostname/whoami/git/cwd) — app state (context.json: collab name,
  # live session, typist, flavor) is deliberately NOT parsed here: those values are collaborator/guest-influenced
  # and the node hook's sanitizer is the only vetted injection defense for them. MUST exit 0 — a non-zero
  # UserPromptSubmit hook would reject the user's prompt.
  cat > "$SDIR/.claude/context-hook.sh" <<'EOF'
#!/usr/bin/env bash
# Pure-shell identity hook (node-less installs). Emits the SAME additionalContext JSON as context-hook.js, so the
# model learns which machine/user it's on even without node. MUST exit 0 (a non-zero UserPromptSubmit hook rejects
# the prompt) and MUST emit VALID JSON. j=() sanitizes every interpolated value: strip the JSON-breakers " and \,
# strip < > (so a value can't forge/close the <claudible-runtime> tag — prompt-injection defense), and drop control
# chars/newlines onto one line. Applied to git name/email/host/cwd alike (defense in depth).
payload=$(cat 2>/dev/null)
ev=$(printf '%s' "$payload" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
case "$ev" in ''|*[!A-Za-z0-9_-]*) ev="UserPromptSubmit" ;; esac   # only a clean event name; else default
j() { printf '%s' "$1" | tr -d '"\\<>' | tr '\n\r\t' '   ' | tr -cd '\040-\176' | cut -c1-200; }
host=$(j "$(hostname 2>/dev/null)"); who=$(j "$(whoami 2>/dev/null)")
gname=$(j "$(git config user.name 2>/dev/null)"); gmail=$(j "$(git config user.email 2>/dev/null)")
cwd=$(j "$(pwd 2>/dev/null)")
ctx="This block is injected by Claudible each turn — the AUTHORITATIVE live runtime; trust it over machine/identity details in the conversation summary (which may have been written on another collaborator's machine and synced here)."
ctx="$ctx\nUser: ${gname:-$who}\nMachine: ${host:-unknown} (login ${who:-unknown})"
[ -n "$gmail" ] && ctx="$ctx\nGit identity here: ${gname} <${gmail}>"
[ -n "$cwd" ] && ctx="$ctx\nWorking directory: ${cwd}"
# Static text only (no interpolated values → nothing to sanitize): the plan-big-execute-small nudge. The
# strategy env is app-set (session.sh export), never collaborator-influenced.
[ "${CLAUDIBLE_MODEL_STRATEGY:-}" = "planBigExecSmall" ] && ctx="$ctx\nModel strategy: plan big, execute small — your subagents run on Sonnet 5 (the cheap tier). Delegate token-heavy legs (bulk reading, repo sweeps, searches, mechanical edits) to subagents and keep planning/synthesis in the main loop. Skip delegation for narrow tasks or judgment-heavy analysis a cheap reader could summarize away."
printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"<claudible-runtime>\\n%s\\n</claudible-runtime>"}}\n' "$ev" "$ctx"
exit 0
EOF
  chmod +x "$SDIR/.claude/context-hook.sh"
  SL_CMD="bash '$SDIR/.claude/statusline.sh'"
  HK_CMD="bash '$SDIR/.claude/hook.sh'"
  CX_CMD="bash '$SDIR/.claude/context-hook.sh'"
fi

# The context hook is additive: when CX_CMD is set, it runs ALONGSIDE the telemetry hook on UserPromptSubmit
# (both run; Claude merges their output — telemetry emits nothing to stdout, the context hook injects the
# runtime block), and on SessionStart so a fresh/resumed/cleared/compacted session re-learns the machine +
# identity. Injecting every UserPromptSubmit is what makes it survive context compaction.
if [ -n "${CX_CMD:-}" ]; then
  UPS_HOOKS="[{\"type\":\"command\",\"command\":\"$HK_CMD\"},{\"type\":\"command\",\"command\":\"$CX_CMD\"}]"
  SESSIONSTART_LINE="\"SessionStart\":     [{\"hooks\":[{\"type\":\"command\",\"command\":\"$CX_CMD\"}]}],"
else
  UPS_HOOKS="[{\"type\":\"command\",\"command\":\"$HK_CMD\"}]"
  SESSIONSTART_LINE=""
fi
# settings.json is one of the names the ownership snapshot above already backed up. This overwrite is safe.
cat > "$SDIR/.claude/settings.json" <<EOF
{
  "autoCompactEnabled": false,
  "env": { "DISABLE_AUTO_COMPACT": "1" },
  "statusLine": { "type": "command", "command": "$SL_CMD" },
  "hooks": {
    $SESSIONSTART_LINE
    "Stop":             [{"hooks":[{"type":"command","command":"$HK_CMD"}]}],
    "UserPromptSubmit": [{"hooks":$UPS_HOOKS}],
    "PreToolUse":       [{"matcher":"Task|Agent","hooks":[{"type":"command","command":"$HK_CMD"}]}],
    "PostToolUse":      [{"matcher":"Task|Agent","hooks":[{"type":"command","command":"$HK_CMD"}]}]
  }
}
EOF

cd "$SDIR" || { echo "[claudible] FATAL: could not enter the session dir ($SDIR) — refusing to launch Claude (with --dangerously-skip-permissions) in the wrong directory." >&2; exit 1; }
# Run Claude DIRECTLY — no tmux. tmux uses the terminal's ALTERNATE screen, which has no
# scrollback, so the mouse wheel can't scroll. Verified: Claude Code uses the NORMAL buffer
# (+ bracketed paste) and does NOT grab the mouse, so xterm.js scrollback gives clean basic scroll.
# Persistence WITHOUT tmux: resume the most recent conversation if one exists, else start fresh.
# Gate on THIS session dir's own project history only. Claude stores each cwd's conversations under
# projects/<cwd with every non-alphanumeric character replaced by '-'>; a broad *claudible*session*
# glob also matches other installs (e.g. a claudible-v2 dir), which would pass --continue with nothing
# here to continue and exit with "No conversation found to continue". Deriving the exact dir from $SDIR
# keeps the check de-hardcoded. The char class must match Claude's encoder exactly: it maps EVERY
# non-alphanumeric char (incl. '_', spaces, etc. — not just '/' and '.') to a single '-'.
PROJ="$HOME/.claude/projects/${CLAUDIBLE_PROJ:-$(printf '%s' "$SDIR" | sed 's#[^A-Za-z0-9]#-#g')}"
# SECURITY: Claudible runs Claude with --dangerously-skip-permissions for frictionless local use. But a
# transcript synced from a collaborator is UNTRUSTED input — resuming it with approvals disabled would let
# its contents drive tool execution (RCE) with full $HOME access. So a foreign session resumes in NORMAL
# approval-prompting mode (and without --add-dir "$HOME"), and is NEVER auto-resumed — only opened by an
# explicit user choice in the switcher. sessions-sync.sh records foreign ids in this sidecar on import.
FOREIGN_LIST="$PROJ/.claudible-foreign"
is_foreign() { [ -f "$FOREIGN_LIST" ] && grep -qxF -- "$1" "$FOREIGN_LIST"; }
# Default reasoning effort — a remembered Claudible setting inlined as CLAUDIBLE_EFFORT. Invalid/empty → omit
# (Claude uses its own default). Applied to fresh AND resumed launches.
EFFORT="${CLAUDIBLE_EFFORT:-}"
case "$EFFORT" in low|medium|high|xhigh|max) EFF=(--effort "$EFFORT") ;; *) EFF=() ;; esac
# Default PERMISSION mode for the user's OWN (trusted) sessions — a remembered Claudible setting inlined as
# CLAUDIBLE_PERMISSION_MODE. A FOREIGN session ALWAYS stays sandboxed (resume_one's is_foreign branch never uses
# PERM — the RCE guard). Empty/invalid → Claude Code's normal prompting default (NOT bypass).
case "${CLAUDIBLE_PERMISSION_MODE:-}" in
  bypass)      PERM=(--dangerously-skip-permissions --add-dir "$HOME") ;;
  acceptEdits) PERM=(--permission-mode acceptEdits) ;;
  *)           PERM=() ;;                                # default → Claude asks before running tools
esac
# KILL-AWARENESS — the phantom-session fix. The "<4s ⇒ resume refused" heuristic below cannot, by itself,
# tell "claude refused to resume" from "the user switched tabs and the pty was torn down under us": both
# return fast. Falling through to FRESH after a KILL is what minted the multiplying "(empty session)"
# stubs (an orphaned, promptless claude creates a new .jsonl). Two guards:
#  • trap: a delivered HUP/TERM (pty teardown) exits IMMEDIATELY — never reaches the fallback.
#  • exit-code: claude dying to a SIGNAL (rc >= 128) means WE were killed, not refused — checked at both
#    fallback sites. A genuine refusal exits with a normal code and still gets the fresh-session fallback.
trap 'exit 0' HUP TERM
mark_used() {   # stamp "this session was ACTIVATED now" — sessions-tool folds the stamp's mtime into `used`,
  # the sidebar's last-used clock. Opening a conversation to READ it appends nothing to the .jsonl, and a
  # foreign import's file mtime is deliberately aged to 2000 — this sidecar is the only activation signal we
  # control. A separate dir (never the transcript itself!) so the aged-mtime auto-resume guard stays intact.
  case "$1" in '' | *[!A-Za-z0-9-]*) return 0 ;; esac
  { mkdir -p "$PROJ/.claudible-used" && touch "$PROJ/.claudible-used/$1"; } 2>/dev/null
  return 0
}
resume_one() {   # $1 = session id — trusted (own) launches in PERM mode; foreign ALWAYS sandboxed (prompts)
  mark_used "$1"
  if is_foreign "$1"; then
    echo "[claudible] opening a collaborator's session — Claude will ask before running tools."
    claude --resume "$1" "${EFF[@]}"
  else
    claude "${PERM[@]}" --resume "$1" "${EFF[@]}"
  fi
}
FRESH=(claude "${PERM[@]}" "${EFF[@]}")
# The app's session switcher passes a choice in CLAUDIBLE_SESSION: 'new' (fresh), a specific
# <session-id> (resume exactly that), or empty (default = resume most-recent LOCAL conversation).
SEL="${CLAUDIBLE_SESSION:-}"
case "$SEL" in -*) SEL="" ;; esac          # a dash-prefixed id could be read as a claude flag — ignore it

if [ "$SEL" = "new" ]; then
  exec "${FRESH[@]}"
fi

if [ -n "$SEL" ]; then
  # Resume the SPECIFIC session picked in the switcher. Some Claude builds refuse to resume a given
  # session (e.g. one that ended mid-tool-call) and exit IMMEDIATELY rather than opening the TUI; a real
  # resumed session blocks until quit, so a return in under ~4s means resume failed → fall back to fresh.
  START=$(date +%s)
  resume_one "$SEL"; RC=$?
  [ $(( $(date +%s) - START )) -ge 4 ] && exit 0
  [ "$RC" -ge 128 ] && exit 0   # claude died to a signal = OUR pty was killed (tab switch/close) — a fresh session here would be an orphaned phantom
  echo "[claudible] couldn't resume that session — starting a fresh one."
  exec "${FRESH[@]}"
fi

# Default (no explicit selection): resume the most-recent LOCALLY-AUTHORED conversation, chosen by id
# (newest mtime, skipping foreign ids) instead of --continue — so a synced collaborator session can never
# be auto-opened, and never auto-run under --dangerously-skip-permissions.
LATEST=""
while IFS= read -r f; do
  cand="$(basename "$f" .jsonl)"
  case "$cand" in -*) continue ;; esac
  is_foreign "$cand" && continue
  LATEST="$cand"; break
done < <(ls -1t "$PROJ"/*.jsonl 2>/dev/null)
if [ -n "$LATEST" ]; then
  mark_used "$LATEST"
  START=$(date +%s)
  claude "${PERM[@]}" --resume "$LATEST" "${EFF[@]}"; RC=$?
  [ $(( $(date +%s) - START )) -ge 4 ] && exit 0   # resumed and used, then quit normally — done
  [ "$RC" -ge 128 ] && exit 0   # killed mid-resume (tab switch/close), not refused — no phantom fresh session
  echo "[claudible] couldn't resume the previous conversation — starting a fresh one."
fi
exec "${FRESH[@]}"
