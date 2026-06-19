#!/usr/bin/env bash
# Claudible — session bootstrap (runs inside the embedded terminal's pty).
# Installs statusLine + hooks into a DEDICATED session dir (keeps them out of the user's repos
# and global ~/.claude), then launches the real Claude session directly (no tmux — tmux's alternate
# screen has no scrollback, which would break the mouse wheel in xterm.js).
set -u

# --- workspace cwd: each Claudible workspace runs in its OWN dir, so Claude's per-cwd history
# isolates for free (projects/<encoded cwd>/). The app inlines a kind + slug; unset (or a bad slug)
# falls back to the original single session dir — fully backward compatible. The slug is a strict
# [A-Za-z0-9-] leaf (no path chars), so it can't escape the workspace root even though it's interpolated.
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
[ -n "${CLAUDIBLE_WS_DIR:-}" ] && SDIR="$CLAUDIBLE_WS_DIR"   # custom save-location (set only for workspaces with a stored path)
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
# Exported so Claude — and the hook/statusline subprocesses it spawns — inherit the per-tab paths.
# The generated scripts below read these at RUNTIME (not bake-time), so the SHARED scripts route each
# tab's output to its own files based on that tab's Claude process env (env inheritance is verified).
export CLAUDIBLE_TAB CLAUDIBLE_STATUS="$STATUS" CLAUDIBLE_HOOKS="$HOOKS"

mkdir -p "$SDIR/.claude" "$RT"
: > "$HOOKS"            # fresh hook stream for THIS tab per launch (other tabs' files untouched)
printf '{}' > "$STATUS" # clear stale status so the meter starts blank, not on last session's numbers

# --- statusLine: dump the rich JSON to STATUS, print a compact line for the TUI ---
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

# --- hooks: append each payload as one NDJSON line ---
cat > "$SDIR/.claude/hook.sh" <<EOF
#!/usr/bin/env bash
line=\$(cat)
out="\${CLAUDIBLE_HOOKS:-$HOOKS}"   # per-tab path from the inheriting Claude env; baked path is the fallback
printf '%s\n' "\$line" >> "\$out"
exit 0
EOF
chmod +x "$SDIR/.claude/hook.sh"

cat > "$SDIR/.claude/settings.json" <<EOF
{
  "statusLine": { "type": "command", "command": "bash '$SDIR/.claude/statusline.sh'" },
  "hooks": {
    "Stop":             [{"hooks":[{"type":"command","command":"bash '$SDIR/.claude/hook.sh'"}]}],
    "UserPromptSubmit": [{"hooks":[{"type":"command","command":"bash '$SDIR/.claude/hook.sh'"}]}],
    "PreToolUse":       [{"matcher":"Task","hooks":[{"type":"command","command":"bash '$SDIR/.claude/hook.sh'"}]}],
    "PostToolUse":      [{"matcher":"Task","hooks":[{"type":"command","command":"bash '$SDIR/.claude/hook.sh'"}]}]
  }
}
EOF

cd "$SDIR"
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
PROJ="$HOME/.claude/projects/$(printf '%s' "$SDIR" | sed 's#[^A-Za-z0-9]#-#g')"
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
resume_one() {   # $1 = session id — trusted (own) runs skip-permissions; foreign runs sandboxed (prompts)
  if is_foreign "$1"; then
    echo "[claudible] opening a collaborator's session — Claude will ask before running tools."
    claude --resume "$1" "${EFF[@]}"
  else
    claude --dangerously-skip-permissions --resume "$1" --add-dir "$HOME" "${EFF[@]}"
  fi
}
FRESH=(claude --dangerously-skip-permissions --add-dir "$HOME" "${EFF[@]}")
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
  resume_one "$SEL"
  [ $(( $(date +%s) - START )) -ge 4 ] && exit 0
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
  START=$(date +%s)
  claude --dangerously-skip-permissions --resume "$LATEST" --add-dir "$HOME" "${EFF[@]}"
  [ $(( $(date +%s) - START )) -ge 4 ] && exit 0   # resumed and used, then quit normally — done
  echo "[claudible] couldn't resume the previous conversation — starting a fresh one."
fi
exec "${FRESH[@]}"
