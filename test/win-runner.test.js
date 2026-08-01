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
// The exe token is UNQUOTED. Claude Code hands a hook command to the user's shell and does not promise WHICH
// one: cmd.exe on some Windows boxes, Windows PowerShell on others. A leading QUOTED path is correct cmd but a
// PowerShell PARSER ERROR ("Unexpected token ... in expression or statement") — it fails before node starts, so
// every hook dies silently and hooks.ndjson stays 0 bytes (observed on a real machine: telemetry, the identity
// context block and the status line had never once worked there). Verified in both shells: an unquoted first
// token passes in each, `& "path"` passes PowerShell and BREAKS cmd. Arguments stay quoted — both agree on those.
eq('settings statusLine cmd', s.statusLine.command,
  'C:\\node.exe "C:\\Users\\X\\.claudible\\session\\.claude\\statusline.js" "C:\\rt\\status.json"');
eq('settings Stop hook cmd', s.hooks.Stop[0].hooks[0].command,
  'C:\\node.exe "C:\\Users\\X\\.claudible\\session\\.claude\\hook.js" "C:\\rt\\hooks.ndjson"');
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
  'C:\\node.exe "C:\\Users\\X\\.claudible\\session\\.claude\\context-hook.js" "C:\\rt\\context.json"');
eq('contextPath → UserPromptSubmit has telemetry + context (2 hooks)', sc.hooks.UserPromptSubmit[0].hooks.length, 2);
eq('contextPath → telemetry hook still first', sc.hooks.UserPromptSubmit[0].hooks[0].command, s.hooks.Stop[0].hooks[0].command);
ok('contextPath settings still valid JSON', (() => { try { JSON.parse(JSON.stringify(sc)); return true; } catch { return false; } })());
// The real-world case: Node installs to "C:\Program Files\nodejs\node.exe". That path CANNOT be emitted bare
// (the space would split it into two tokens) and CANNOT be emitted quoted (PowerShell parser error), so it
// falls back to bare `node` — safe precisely because whichNode() resolved this path via `where node`, i.e.
// node is provably on PATH. This is the exact configuration that was broken in the field.
const sp = settingsJson('C:\\p\\.claude', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\rt\\status.json', 'C:\\rt\\hooks.ndjson', 'C:\\rt\\context.json');
eq('a node path WITH SPACES falls back to bare node (never a quoted first token)', sp.hooks.Stop[0].hooks[0].command,
  'node "C:\\p\\.claude\\hook.js" "C:\\rt\\hooks.ndjson"');
// One sweep over EVERY generated command in both shapes: no command may start with a quote. This is the
// regression that matters — a future edit re-adding `"${nodeBin}"` would silently kill hooks on PowerShell
// machines while every other assertion here kept passing.
{
  const cmds = [];
  for (const o of [s, sc, sp]) {
    cmds.push(o.statusLine.command);
    for (const ev of Object.values(o.hooks)) for (const g of ev) for (const h of g.hooks) cmds.push(h.command);
  }
  ok('no generated hook/statusLine command starts with a quote (PowerShell parse-error shape)',
    cmds.length >= 15 && cmds.every((c) => !c.startsWith('"')));
  ok('every generated command still quotes its ARGUMENTS (paths with spaces must survive both shells)',
    cmds.every((c) => (c.match(/"/g) || []).length >= 4));
}

// ---- spawnEnv (the SPACEBAR fix: suppress Claude's blocking "resume from summary?" modal that swallows
//      every keystroke — space included — on big/old resumed sessions; parity with wsl/session.sh) ----
const { spawnEnv } = win._internals;
const be = { PATH: '/x', HOME: 'C:\\Users\\X' };   // a fixed base env so the assertions don't depend on process.env
const e1 = spawnEnv('tab-7', be);
eq('spawnEnv sets the resume MINUTES threshold out of reach', e1.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES, '2000000000');
eq('spawnEnv sets the resume TOKEN threshold out of reach', e1.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD, '2000000000');
ok('spawnEnv thresholds parse to a real number far past any real session (~3805 yrs / 2B tok)',
  Number(e1.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES) > 1e9 && Number(e1.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD) > 1e9);
eq('spawnEnv still passes the base env through', e1.PATH, '/x');
eq('spawnEnv always stamps this tab’s CLAUDIBLE_TAB', e1.CLAUDIBLE_TAB, 'tab-7');
eq('spawnEnv missing runtimeId -> default tab', spawnEnv('', be).CLAUDIBLE_TAB, 'default');
// an explicit user override in the real env WINS (we only supply a default) — never fight a deliberate setting
eq('spawnEnv honors a user override of the threshold',
  spawnEnv('t', { CLAUDE_CODE_RESUME_THRESHOLD_MINUTES: '5' }).CLAUDE_CODE_RESUME_THRESHOLD_MINUTES, '5');
// "plan big, execute small": strategy on → subagents pinned to Sonnet 5 + the hook-nudge env var; off/absent → neither
eq('spawnEnv strategy on pins the subagent model', spawnEnv('t', be, 'planBigExecSmall').CLAUDE_CODE_SUBAGENT_MODEL, 'claude-sonnet-5');
eq('spawnEnv strategy on exports the nudge var', spawnEnv('t', be, 'planBigExecSmall').CLAUDIBLE_MODEL_STRATEGY, 'planBigExecSmall');
ok('spawnEnv strategy off sets neither var', (() => { const e = spawnEnv('t', be, 'off'); return e.CLAUDE_CODE_SUBAGENT_MODEL === undefined && e.CLAUDIBLE_MODEL_STRATEGY === undefined; })());
ok('spawnEnv strategy absent sets neither var', (() => { const e = spawnEnv('t', be); return e.CLAUDE_CODE_SUBAGENT_MODEL === undefined && e.CLAUDIBLE_MODEL_STRATEGY === undefined; })());
eq('spawnEnv user override of subagent model wins',
  spawnEnv('t', { CLAUDE_CODE_SUBAGENT_MODEL: 'claude-haiku-4-5' }, 'planBigExecSmall').CLAUDE_CODE_SUBAGENT_MODEL, 'claude-haiku-4-5');

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

// ---- shouldFallbackToFresh (F-LIFE-2 port: mirror of wsl/session.sh's resume-refusal fallback,
//      lines 288-318) — a resume that exits almost instantly (< 4s) with a plain exit (no signal, not
//      OUR kill) is a refusal, not a used-then-quit session; only a RESUME can ever fall back. ----
const { shouldFallbackToFresh } = win._internals;
const T0 = 1_000_000;
// fast refusal: resume, exited quickly, no signal, we did not kill it -> fall back
ok('fast refusal -> true', shouldFallbackToFresh(T0, T0 + 500, 1, undefined, false, true) === true);
ok('fast refusal with exit code 0 -> still true (session.sh does not gate on the code value)',
  shouldFallbackToFresh(T0, T0 + 10, 0, undefined, false, true) === true);
// fast KILL (tab switch/close mid-resume): we killed it ourselves -> never a phantom fresh session
ok('fast kill -> false', shouldFallbackToFresh(T0, T0 + 500, 1, undefined, true, true) === false);
// slow exit: a real session that ran a while then quit normally -> not a refusal
ok('slow exit -> false', shouldFallbackToFresh(T0, T0 + 5000, 0, undefined, false, true) === false);
// this spawn was already a FRESH launch (not a resume) -> nothing to fall back from, ever
ok('fresh spawn -> false', shouldFallbackToFresh(T0, T0 + 500, 1, undefined, false, false) === false);
// died to a signal, not a plain exit -> treat like our-own-kill, never a refusal
ok('signal exit -> false', shouldFallbackToFresh(T0, T0 + 500, null, 15, false, true) === false);
// boundary: exactly 4000ms elapsed counts as "slow" (not a refusal) — matches session.sh's `-ge 4`
ok('exactly-4000ms boundary counts as slow (not a refusal)', shouldFallbackToFresh(T0, T0 + 4000, 1, undefined, false, true) === false);
ok('3999ms is still fast (a refusal)', shouldFallbackToFresh(T0, T0 + 3999, 1, undefined, false, true) === true);

console.log(`\nwin-runner (pure core): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
