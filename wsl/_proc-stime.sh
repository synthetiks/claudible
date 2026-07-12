# shellcheck shell=bash
# Claudible — ONE portable answer to "when did this pid start?". session.sh WRITES the token into the tab's
# boot.pid; killtree.sh VERIFIES it before killing. Together they are the recycled-pid guard: reap this tab's
# process tree only if the pid we recorded is still the SAME process, and not an innocent one that inherited its
# number after a crash left a stale pidfile behind.
#
# Linux / WSL: field 22 of /proc/<pid>/stat — start time in clock ticks since boot. Strip past the LAST ')' first,
# because comm can itself contain spaces and parentheses.
#
# macOS / BSD: there is NO /proc. Both scripts read it anyway, got the empty string, and killtree's guard —
#     [ -n "$NOW_STIME" ] && [ "$NOW_STIME" = "${STIME:-}" ] || { rm -f "$PIDFILE"; exit 0; }
# — then took the give-up branch EVERY time. So on a Mac the process tree was never killed, on every tab close and
# every tab switch, silently, by default. That is exactly the leak killtree.sh exists to prevent: a surviving
# `claude` holds the old session id open, which forces Claude Code to FORK on the next resume — the "(empty
# session)" stubs. `ps -o lstart=` is the portable answer: an absolute start time that survives session.sh's
# `exec claude` (same process, so same start time — a cmdline check would not survive it), and that differs for a
# recycled pid. Squeezed to a whitespace-free token so boot.pid stays a clean two-field line: `read -r PID STIME`
# would actually hand the whole remainder to STIME, so a spaced token round-trips — but only by accident of read's
# last-variable rule, and any future field appended to that line would then silently land inside STIME. One word.
#
# Resolution, stated honestly: Linux's token is clock ticks since boot; macOS's `lstart` is only 1-second precise.
# That is not a weakness here, because the guard only ever compares ONE pid's recorded start-time against THAT SAME
# pid's current start-time. For a false match, a recycled pid would have to be re-issued to a new process within the
# same second as the original — which requires the pid space to wrap around in under a second. Two unrelated
# processes sharing an lstart is harmless: they are never compared to each other.
#
# If neither source works, this prints nothing — and an empty token means killtree declines to kill. That is the
# safe direction: leaking a process is recoverable, killing the wrong one is not.
proc_stime() {
  if [ -r "/proc/$1/stat" ]; then
    sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | awk '{print $20}'
    return
  fi
  ps -o lstart= -p "$1" 2>/dev/null | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//' | tr ' :' '__'
}
