// test/win-runner.test.js — unit-tests the WindowsRunner's PURE session-bootstrap core (the logic that
// replaces wsl/session.sh on Windows-native). Runs on any OS (uses path.win32 + pure functions; no
// node-pty, no Windows binaries). The live glue (ConPTY claude.exe, git-bash runScript) is NOT covered
// here — it's 🟡, gated on a Windows smoke test (docs/SMOKE.md). Run: node test/win-runner.test.js
'use strict';
const assert = require('assert');
const path = require('path');
const win = require('../runners/win.js');
const { sessionDir, claudeProjectsDir, pickResumeTarget, claudeArgv, settingsJson, pickClaudeBin } = win._internals;

const HOME = 'C:\\Users\\X';
let pass = 0, fail = 0;
function eq(label, a, b) { try { assert.deepStrictEqual(a, b); pass++; } catch { fail++; console.error(`  FAIL ${label}\n    got: ${JSON.stringify(a)}\n    exp: ${JSON.stringify(b)}`); } }
function ok(label, c) { c ? pass++ : (fail++, console.error('  FAIL ' + label)); }

// ---- pickClaudeBin (must avoid CreateProcess 193: prefer a runnable .cmd/.exe over npm's extensionless shim) ----
eq('pickClaudeBin prefers .cmd over the bare shim', pickClaudeBin(['C:\\Users\\X\\AppData\\Roaming\\npm\\claude', 'C:\\Users\\X\\AppData\\Roaming\\npm\\claude.cmd']), 'C:\\Users\\X\\AppData\\Roaming\\npm\\claude.cmd');
eq('pickClaudeBin prefers .exe (native install)', pickClaudeBin(['C:\\x\\claude', 'C:\\x\\claude.exe']), 'C:\\x\\claude.exe');
eq('pickClaudeBin keeps .cmd regardless of order', pickClaudeBin(['C:\\a\\claude.cmd', 'C:\\a\\claude']), 'C:\\a\\claude.cmd');
eq('pickClaudeBin falls back to first when no runnable form', pickClaudeBin(['C:\\only\\claude']), 'C:\\only\\claude');
eq('pickClaudeBin empty -> bare claude', pickClaudeBin([]), 'claude');

// ---- sessionDir (mirror session.sh SDIR) ----
eq('sessionDir legacy', sessionDir({ kind: 'legacy' }, HOME), 'C:\\Users\\X\\.claudible\\session');
eq('sessionDir local',  sessionDir({ kind: 'local', slug: 'proj' }, HOME), 'C:\\Users\\X\\.claudible\\workspaces\\proj');
eq('sessionDir repo',   sessionDir({ kind: 'repo', slug: 'r' }, HOME), 'C:\\Users\\X\\.claudible\\repos\\r');
eq('sessionDir bad-slug -> legacy', sessionDir({ kind: 'local', slug: '../evil' }, HOME), 'C:\\Users\\X\\.claudible\\session');
eq('sessionDir custom path wins', sessionDir({ kind: 'local', slug: 'p', path: 'D:\\custom\\ws' }, HOME), 'D:\\custom\\ws');

// ---- claudeProjectsDir (the non-alnum -> '-' encoding; must match Claude's encoder on Windows) ----
const sd = 'C:\\Users\\X\\.claudible\\session';
eq('claudeProjectsDir encoding', claudeProjectsDir(sd, HOME),
  path.win32.join('C:\\Users\\X', '.claude', 'projects', sd.replace(/[^A-Za-z0-9]/g, '-')));
ok('encoding maps every non-alnum to single dash', claudeProjectsDir(sd, HOME).endsWith('C--Users-X--claudible-session'));

// ---- pickResumeTarget (mirror session.sh 114-148) ----
const F = new Set(['foreignA']);
eq('pick new -> fresh', pickResumeTarget('new', [{ id: 's1' }], F), { mode: 'fresh' });
eq('pick specific own', pickResumeTarget('abc-1', [], F), { mode: 'resume', id: 'abc-1', foreign: false });
eq('pick specific foreign -> sandboxed flag', pickResumeTarget('foreignA', [], F), { mode: 'resume', id: 'foreignA', foreign: true });
eq('pick default = newest local', pickResumeTarget('', [{ id: 's1' }, { id: 's2' }], F), { mode: 'resume', id: 's1', foreign: false });
eq('pick default skips dash-id', pickResumeTarget('', [{ id: '-x' }, { id: 's2' }], F), { mode: 'resume', id: 's2', foreign: false });
eq('pick default skips foreign', pickResumeTarget('', [{ id: 'foreignA' }, { id: 's2' }], F), { mode: 'resume', id: 's2', foreign: false });
eq('pick default empty -> fresh', pickResumeTarget('', [], F), { mode: 'fresh' });
eq('pick dash-prefixed sel -> ignored -> fresh', pickResumeTarget('-evil', [], F), { mode: 'fresh' });

// ---- claudeArgv (mirror session.sh resume_one / FRESH) ----
eq('argv fresh+effort', claudeArgv({ mode: 'fresh' }, HOME, 'high'),
  ['--dangerously-skip-permissions', '--add-dir', HOME, '--effort', 'high']);
eq('argv resume own no-effort', claudeArgv({ mode: 'resume', id: 's1', foreign: false }, HOME, ''),
  ['--dangerously-skip-permissions', '--resume', 's1', '--add-dir', HOME]);
eq('argv resume FOREIGN is sandboxed', claudeArgv({ mode: 'resume', id: 'f1', foreign: true }, HOME, 'xhigh'),
  ['--resume', 'f1', '--effort', 'xhigh']);
eq('argv ultracode -> xhigh', claudeArgv({ mode: 'fresh' }, HOME, 'ultracode'),
  ['--dangerously-skip-permissions', '--add-dir', HOME, '--effort', 'xhigh']);
eq('argv bogus effort omitted', claudeArgv({ mode: 'fresh' }, HOME, 'turbo'),
  ['--dangerously-skip-permissions', '--add-dir', HOME]);

// ---- settingsJson (Node hooks via the Windows node path, per-tab args baked) ----
const s = settingsJson('C:\\Users\\X\\.claudible\\session\\.claude', 'C:\\node.exe', 'C:\\rt\\status.json', 'C:\\rt\\hooks.ndjson');
eq('settings statusLine cmd', s.statusLine.command,
  '"C:\\node.exe" "C:\\Users\\X\\.claudible\\session\\.claude\\statusline.js" "C:\\rt\\status.json"');
eq('settings Stop hook cmd', s.hooks.Stop[0].hooks[0].command,
  '"C:\\node.exe" "C:\\Users\\X\\.claudible\\session\\.claude\\hook.js" "C:\\rt\\hooks.ndjson"');
eq('settings PostToolUse matcher', s.hooks.PostToolUse[0].matcher, 'Task|Agent');
eq('settings PreToolUse matcher', s.hooks.PreToolUse[0].matcher, 'Task|Agent');
ok('settings is valid JSON', (() => { try { JSON.parse(JSON.stringify(s)); return true; } catch { return false; } })());

console.log(`\nwin-runner (pure core): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
