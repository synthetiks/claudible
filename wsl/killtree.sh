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
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/_proc-stime.sh"                             # portable start-time: /proc on Linux/WSL, `ps -o lstart=` on macOS
TAB="${1:-}"
case "$TAB" in '' | *[!A-Za-z0-9-]*) exit 0 ;; esac
PIDFILE="$(cd "$(dirname "$0")/.." && pwd)/runtime/tabs/$TAB/boot.pid"
[ -f "$PIDFILE" ] || exit 0
read -r PID STIME < "$PIDFILE" 2>/dev/null || true   # `read` exits nonzero on a newline-less file but still fills the vars — don't bail on that
case "$PID" in '' | *[!0-9]*) exit 0 ;; esac
# Recycled-pid guard: the pidfile carries the bootstrap's START-TIME; only kill if the pid's current start-time
# still matches. Stronger than a cmdline check (survives session.sh's `exec claude` — same pid, same start-time),
# and a crash-leftover pidfile whose pid was recycled can never take an innocent process down.
# This read USED to be a bare /proc/$PID/stat — which does not exist on macOS, so NOW_STIME came back empty and the
# guard below took its give-up branch on EVERY tab close, on every Mac: the process tree was never reaped at all.
NOW_STIME="$(proc_stime "$PID")"
[ -n "$NOW_STIME" ] && [ "$NOW_STIME" = "${STIME:-}" ] || { rm -f "$PIDFILE" 2>/dev/null; exit 0; }
# STOP-then-walk: freeze each process BEFORE enumerating its children, so nothing can fork into the
# gap between the pgrep snapshot and the kill (the old snapshot-then-kill walk lost that race — a child
# spawned mid-walk was never enumerated and survived as the very orphan this script exists to reap).
# SIGKILL still lands on a stopped process, so no explicit CONT is needed.
kill_tree() {
  local c
  kill -STOP "$1" 2>/dev/null
  for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c"; done
  kill -KILL "$1" 2>/dev/null
}
# The bootstrap's SESSION id covers everything that ever ran on this tab's pty — including processes
# that double-fork-detached and re-parented to init (invisible to any parent-pointer walk, but they
# keep their sid unless they setsid() themselves). Capture it BEFORE the walk kills $PID. Swept ONLY
# when the bootstrap is the session LEADER (sid==pid, which session.sh always is — verified live):
# a non-leader pid would mean the sid is a session we share with strangers, and sweeping it could
# kill another tab's tree.
SID="$(ps -o sess= -p "$PID" 2>/dev/null | tr -d ' ')"
[ "$SID" = "$PID" ] || SID=""
kill_tree "$PID"
case "$SID" in '' | 0 | *[!0-9]*) ;; *)
  for _p in $(ps -eo pid=,sess= 2>/dev/null | awk -v s="$SID" '$2==s {print $1}'); do
    kill -KILL "$_p" 2>/dev/null
  done ;;
esac
rm -f "$PIDFILE" 2>/dev/null
exit 0
