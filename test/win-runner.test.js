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

// ---- claudeArgv (mirror session.sh resume_one / FRESH) — permission mode is the 4th arg ----
// 'bypass' = the old frictionless behaviour, now opt-in: --dangerously-skip-permissions + --add-dir
eq('argv fresh bypass+effort', claudeArgv({ mode: 'fresh' }, HOME, 'high', 'bypass'),
  ['--dangerously-skip-permissions', '--add-dir', HOME, '--effort', 'high']);
eq('argv resume own bypass', claudeArgv({ mode: 'resume', id: 's1', foreign: false }, HOME, '', 'bypass'),
  ['--dangerously-skip-permissions', '--add-dir', HOME, '--resume', 's1']);
eq('argv ultracode bypass -> xhigh', claudeArgv({ mode: 'fresh' }, HOME, 'ultracode', 'bypass'),
  ['--dangerously-skip-permissions', '--add-dir', HOME, '--effort', 'xhigh']);
eq('argv bogus effort omitted (bypass)', claudeArgv({ mode: 'fresh' }, HOME, 'turbo', 'bypass'),
  ['--dangerously-skip-permissions', '--add-dir', HOME]);
// 'default' (or unset) = Claude prompts — NO --dangerously, NO --add-dir
eq('argv fresh default = no bypass', claudeArgv({ mode: 'fresh' }, HOME, 'high'),
  ['--effort', 'high']);
eq('argv resume own default = no bypass', claudeArgv({ mode: 'resume', id: 's1', foreign: false }, HOME, '', 'default'),
  ['--resume', 's1']);
// 'acceptEdits' = auto-accept edits, no --add-dir
eq('argv fresh acceptEdits', claudeArgv({ mode: 'fresh' }, HOME, '', 'acceptEdits'),
  ['--permission-mode', 'acceptEdits']);
eq('argv resume own acceptEdits+effort', claudeArgv({ mode: 'resume', id: 's1', foreign: false }, HOME, 'high', 'acceptEdits'),
  ['--permission-mode', 'acceptEdits', '--resume', 's1', '--effort', 'high']);
// SECURITY: a FOREIGN session is ALWAYS sandboxed — even when the user's setting is 'bypass'
eq('argv resume FOREIGN sandboxed even with bypass', claudeArgv({ mode: 'resume', id: 'f1', foreign: true }, HOME, 'xhigh', 'bypass'),
  ['--resume', 'f1', '--effort', 'xhigh']);

// ---- settingsJson (Node hooks via the Windows node path, per-tab args baked) ----
const s = settingsJson('C:\\Users\\X\\.claudible\\session\\.claude', 'C:\\node.exe', 'C:\\rt\\status.json', 'C:\\rt\\hooks.ndjson');
eq('settings statusLine cmd', s.statusLine.command,
  '"C:\\node.exe" "C:\\Users\\X\\.claudible\\session\\.claude\\statusline.js" "C:\\rt\\status.json"');
eq('settings Stop hook cmd', s.hooks.Stop[0].hooks[0].command,
  '"C:\\node.exe" "C:\\Users\\X\\.claudible\\session\\.claude\\hook.js" "C:\\rt\\hooks.ndjson"');
eq('settings PostToolUse matcher', s.hooks.PostToolUse[0].matcher, 'Task|Agent');
eq('settings PreToolUse matcher', s.hooks.PreToolUse[0].matcher, 'Task|Agent');
ok('settings is valid JSON', (() => { try { JSON.parse(JSON.stringify(s)); return true; } catch { return false; } })());
eq('settings autoCompactEnabled off', s.autoCompactEnabled, false);                 // Claude Code auto-compact disabled by default
eq('settings DISABLE_AUTO_COMPACT env', s.env.DISABLE_AUTO_COMPACT, '1');
// no contextPath → identity hook omitted (parity with an older bundle / session.sh's CX guard)
ok('no contextPath → no SessionStart', s.hooks.SessionStart === undefined);
eq('no contextPath → UserPromptSubmit has only the telemetry hook', s.hooks.UserPromptSubmit[0].hooks.length, 1);
// WITH contextPath → the identity hook is wired on SessionStart + as a 2nd UserPromptSubmit hook
const sc = settingsJson('C:\\Users\\X\\.claudible\\session\\.claude', 'C:\\node.exe', 'C:\\rt\\status.json', 'C:\\rt\\hooks.ndjson', 'C:\\rt\\context.json');
ok('contextPath → SessionStart wired', Array.isArray(sc.hooks.SessionStart) && sc.hooks.SessionStart[0].hooks.length === 1);
eq('contextPath → SessionStart runs context-hook.js', sc.hooks.SessionStart[0].hooks[0].command,
  '"C:\\node.exe" "C:\\Users\\X\\.claudible\\session\\.claude\\context-hook.js" "C:\\rt\\context.json"');
eq('contextPath → UserPromptSubmit has telemetry + context (2 hooks)', sc.hooks.UserPromptSubmit[0].hooks.length, 2);
eq('contextPath → telemetry hook still first', sc.hooks.UserPromptSubmit[0].hooks[0].command, s.hooks.Stop[0].hooks[0].command);
ok('contextPath settings still valid JSON', (() => { try { JSON.parse(JSON.stringify(sc)); return true; } catch { return false; } })());

// ---- dependency detection (buildDepReport — the self-bootstrap provisioner's pure core) ----
const { buildDepReport, semverGte, pickRunnable } = win._internals;

ok('semverGte equal', semverGte('22.12.0', '22.12.0'));
ok('semverGte higher minor', semverGte('22.14.0', '22.12.0'));
ok('semverGte v-prefixed (node -v form)', semverGte('v22.12.0', '22.12.0'));
ok('semverGte lower major -> false', !semverGte('20.19.0', '22.12.0'));
ok('semverGte lower patch -> false', !semverGte('22.11.9', '22.12.0'));
ok('semverGte garbage -> false', !semverGte('not a version', '22.12.0'));

eq('pickRunnable prefers .exe over bare', pickRunnable(['C:\\a\\node', 'C:\\a\\node.exe']), 'C:\\a\\node.exe');
eq('pickRunnable falls back to first', pickRunnable(['C:\\only\\thing']), 'C:\\only\\thing');
eq('pickRunnable empty -> ""', pickRunnable([]), '');

// inject fake IO so the pure report logic runs on Linux (no `where`, no Windows binaries)
function fakeIO(spec) {
  return {
    gitBashPresent: () => !!spec.gitBash,
    resolveTool: (id) => (spec.present && id in spec.present) ? `C:\\bin\\${id}.exe` : '',
    toolVersion: (id) => (spec.present && spec.present[id]) || '',
    claudeSignedIn: () => !!(spec.signedIn && spec.signedIn.claude),
    ghAuth: () => (spec.signedIn && spec.signedIn.gh) || { signedIn: false, account: '' },
  };
}

const full = buildDepReport(fakeIO({ gitBash: true,
  present: { node: 'v22.14.0', git: 'git version 2.45.0', claude: '1.2.3 (Claude Code)', uv: 'uv 0.5.0', gh: 'gh version 2.40.0', cloudflared: '2024.1.0' },
  signedIn: { claude: true, gh: { signedIn: true, account: 'mk' } } }));
ok('full: node installed + ok (>=22.12)', full.node.installed && full.node.ok);
eq('full: node version captured', full.node.version, 'v22.14.0');
ok('full: claude installed + signedIn', full.claude.installed && full.claude.signedIn);
eq('full: gh account', full.gh.account, 'mk');
ok('full: gitBash true', full.gitBash === true);

const bare = buildDepReport(fakeIO({ gitBash: false, present: {}, signedIn: {} }));
ok('bare: node missing (no install, not ok)', !bare.node.installed && !bare.node.ok);
ok('bare: git missing', !bare.git.installed);
ok('bare: claude missing + not signed', !bare.claude.installed && !bare.claude.signedIn);
ok('bare: gh missing + not signed + no account', !bare.gh.installed && !bare.gh.signedIn && bare.gh.account === '');
ok('bare: gitBash false (chicken-and-egg signal)', bare.gitBash === false);

const oldNode = buildDepReport(fakeIO({ gitBash: true, present: { node: 'v20.19.0' }, signedIn: {} }));
ok('old node: installed but NOT ok (gates on 22.12)', oldNode.node.installed && !oldNode.node.ok);

const noLogin = buildDepReport(fakeIO({ gitBash: true, present: { claude: '1.0.0' }, signedIn: { claude: false } }));
ok('claude installed but not signed in (soft gate)', noLogin.claude.installed && !noLogin.claude.signedIn);

console.log(`\nwin-runner (pure core): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
