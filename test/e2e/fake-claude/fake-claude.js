#!/usr/bin/env node
// test/e2e/fake-claude/fake-claude.js — the "minimal behavior the spawn path needs" stand-in for a
// real, signed-in `claude` CLI (see the harness's HARD RULES: terminal-spawning specs must not depend
// on one). Not a claude.exe fake in the visual-fidelity sense — it exists only so runners/win.js's
// spawnClaude() (node-pty spawn of the resolved `claude` binary) has SOMETHING runnable at the far
// end of the pty that (a) prints something the test can assert on, (b) echoes input back so a spec
// can prove keystrokes reach the pty, and (c) stays alive until killed, exactly like a real claude
// session sitting at its prompt — so kill()/onExit() plumbing gets exercised for real instead of
// racing a process that exited on its own.
'use strict';

process.stdout.write('[fake-claude] ready argv=' + JSON.stringify(process.argv.slice(2)) + '\n');

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { process.stdout.write('[fake-claude] echo: ' + chunk); });
process.stdin.resume();

// Stay alive indefinitely — a real claude session sits at its TUI prompt until the user (or the
// harness's stop()/pty kill) ends it. No timers/intervals needed: stdin being resumed is enough to
// keep the Node event loop alive.
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
