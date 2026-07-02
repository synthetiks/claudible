#!/usr/bin/env bash
# Claudible — kill the WSL/posix-side process tree of ONE tab generation (bash session.sh + claude + children).
#
# WHY: node-pty's ConPTY kill() only terminates WINDOWS-side console processes (wsl.exe and friends) — nothing
# in the stack reaches into the WSL guest, so the Linux-side bash/claude routinely SURVIVES a tab switch/close
# (relay-parented processes on this project outlived days of app restarts). A surviving claude keeps the old
# session id open (forcing Claude Code to FORK on the next resume → "(empty session)" stubs) and keeps writing
# telemetry. main.js calls this after every pty kill, and at startup for leftover generations from a crash.
#
# $1 = the tab GENERATION id (runtime/tabs/<id>/ — strict [A-Za-z0-9-]). session.sh wrote its own PID to
# boot.pid in that dir at boot; we kill that pid's whole descendant tree, deepest-first.
set -u
TAB="${1:-}"
case "$TAB" in '' | *[!A-Za-z0-9-]*) exit 0 ;; esac
PIDFILE="$(cd "$(dirname "$0")/.." && pwd)/runtime/tabs/$TAB/boot.pid"
[ -f "$PIDFILE" ] || exit 0
read -r PID STIME < "$PIDFILE" 2>/dev/null || true   # `read` exits nonzero on a newline-less file but still fills the vars — don't bail on that
case "$PID" in '' | *[!0-9]*) exit 0 ;; esac
# Recycled-pid guard: the pidfile carries the bootstrap's kernel START-TIME; only kill if the pid's current
# start-time still matches. Stronger than a cmdline check (survives session.sh's `exec claude` — same pid,
# same start-time) and a crash-leftover pidfile whose pid was recycled can never take an innocent process down.
NOW_STIME="$(sed 's/.*) //' "/proc/$PID/stat" 2>/dev/null | awk '{print $20}')"
[ -n "$NOW_STIME" ] && [ "$NOW_STIME" = "${STIME:-}" ] || { rm -f "$PIDFILE" 2>/dev/null; exit 0; }
kill_tree() {
  local c
  for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c"; done
  kill -KILL "$1" 2>/dev/null
}
kill_tree "$PID"
rm -f "$PIDFILE" 2>/dev/null
exit 0
