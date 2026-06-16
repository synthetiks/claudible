#!/usr/bin/env bash
# Claudible — session bootstrap (runs inside the embedded terminal's pty).
# Installs statusLine + hooks into a DEDICATED session dir (keeps them out of the user's repos
# and global ~/.claude), then launches the real Claude session directly (no tmux — tmux's alternate
# screen has no scrollback, which would break the mouse wheel in xterm.js).
set -u

SDIR="$HOME/.claudible/session"
# Runtime files live on the Windows FS so the Electron app reads them natively (NOT over the flaky
# \\wsl.localhost 9P boundary). The app passes its OWN folder (as a /mnt path) in $1 — no hardcoded home.
APPDIR="${1:?usage: session.sh <app-dir-as-wsl-path>}"
RT="$APPDIR/runtime"
STATUS="$RT/status.json"
HOOKS="$RT/hooks.ndjson"

mkdir -p "$SDIR/.claude" "$RT"
: > "$HOOKS"            # fresh hook stream per launch
printf '{}' > "$STATUS" # clear stale status so the meter starts blank, not on last session's numbers

# --- statusLine: dump the rich JSON to STATUS, print a compact line for the TUI ---
cat > "$SDIR/.claude/statusline.sh" <<EOF
#!/usr/bin/env bash
in=\$(cat)
printf '%s' "\$in" > "$STATUS"
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
printf '%s\n' "\$line" >> "$HOOKS"
exit 0
EOF
chmod +x "$SDIR/.claude/hook.sh"

cat > "$SDIR/.claude/settings.json" <<EOF
{
  "statusLine": { "type": "command", "command": "bash $SDIR/.claude/statusline.sh" },
  "hooks": {
    "Stop":             [{"hooks":[{"type":"command","command":"bash $SDIR/.claude/hook.sh"}]}],
    "UserPromptSubmit": [{"hooks":[{"type":"command","command":"bash $SDIR/.claude/hook.sh"}]}]
  }
}
EOF

cd "$SDIR"
# Run Claude DIRECTLY — no tmux. tmux uses the terminal's ALTERNATE screen, which has no
# scrollback, so the mouse wheel can't scroll. Verified: Claude Code uses the NORMAL buffer
# (+ bracketed paste) and does NOT grab the mouse, so xterm.js scrollback gives clean basic scroll.
# Persistence WITHOUT tmux: resume the most recent conversation if one exists, else start fresh.
if ls "$HOME/.claude/projects/"*claudible*session*/*.jsonl >/dev/null 2>&1; then
  exec claude --dangerously-skip-permissions --continue --add-dir "$HOME"
else
  exec claude --dangerously-skip-permissions --add-dir "$HOME"
fi
