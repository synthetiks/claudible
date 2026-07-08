// test/runner-parity.test.js — proves runners/wsl.js reproduces main.js's command strings EXACTLY.
//
// The WslRunner is a faithful extraction: every `wsl.exe -e bash -lc <CMD>` it builds must equal the
// inline `<CMD>` main.js built before the refactor. The expected strings below are hand-derived from
// the pre-refactor main.js call sites (cited per case). Pure string assertions — no wsl.exe needed,
// so this runs under any node. Run:  node test/runner-parity.test.js
//
// This is the verifiable half of the 0.3 gate. The other half (the live wsl.exe plumbing + the GUI
// 10-point smoke test) is unchanged by construction: identical command strings => identical behavior.

const assert = require('assert');
const wsl = require('../runners/wsl.js');
const { _bootStr, _scriptCmd, wsEnv } = wsl._internals;

const APP = '/mnt/c/Users/X/claudible';                 // a representative appDirGuest() value
const legacy = { kind: 'legacy', slug: '' };
const repo = { kind: 'repo', slug: 'proj' };
const repoPath = { kind: 'repo', slug: 'p', path: '/home/me/dir' };

let pass = 0, fail = 0;
function eq(label, actual, expected) {
  try { assert.strictEqual(actual, expected); pass++; }
  catch { fail++; console.error(`\n  FAIL  ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`); }
}

// ---- wsEnv (main.js:103-110) ----
eq('wsEnv legacy', wsEnv(legacy), `CLAUDIBLE_WS_KIND='legacy'`);
eq('wsEnv repo+slug', wsEnv(repo), `CLAUDIBLE_WS_KIND='repo' CLAUDIBLE_WS_SLUG='proj'`);
eq('wsEnv repo+slug+path', wsEnv(repoPath), `CLAUDIBLE_WS_KIND='repo' CLAUDIBLE_WS_SLUG='p' CLAUDIBLE_WS_DIR='/home/me/dir'`);
eq('wsEnv null->legacy', wsEnv(null), `CLAUDIBLE_WS_KIND='legacy'`);

// ---- buildBoot / _bootStr (main.js:112-121, spawn at :237) ----
eq('boot resume legacy no-effort',
  _bootStr(APP, '', legacy, 'main', ''),
  `CLAUDIBLE_TAB='main' CLAUDIBLE_WS_KIND='legacy' bash '${APP}/wsl/session.sh' '${APP}'`);
eq('boot session+ultracode+repo',
  _bootStr(APP, 'sess-7', repo, 'tab2', 'ultracode'),
  `CLAUDIBLE_SESSION='sess-7' CLAUDIBLE_TAB='tab2' CLAUDIBLE_EFFORT='xhigh' CLAUDIBLE_WS_KIND='repo' CLAUDIBLE_WS_SLUG='proj' bash '${APP}/wsl/session.sh' '${APP}'`);
eq('boot new+high+legacy',
  _bootStr(APP, 'new', legacy, 'main', 'high'),
  `CLAUDIBLE_SESSION='new' CLAUDIBLE_TAB='main' CLAUDIBLE_EFFORT='high' CLAUDIBLE_WS_KIND='legacy' bash '${APP}/wsl/session.sh' '${APP}'`);
eq('boot strips leading-dash id',
  _bootStr(APP, '--evil', legacy, 'main', ''),
  `CLAUDIBLE_SESSION='evil' CLAUDIBLE_TAB='main' CLAUDIBLE_WS_KIND='legacy' bash '${APP}/wsl/session.sh' '${APP}'`);
eq('boot appdir null -> echo fallback',
  _bootStr(null, '', legacy, 'main', ''),
  `echo "[claudible] could not resolve the app path — is the environment set up?"; sleep 8`);
// permission mode: 'bypass'/'acceptEdits' inline CLAUDIBLE_PERMISSION_MODE (right after EFFORT); 'default'/unset omits it
eq('boot bypass after effort',
  _bootStr(APP, 'sess-7', repo, 'tab2', 'high', 'bypass'),
  `CLAUDIBLE_SESSION='sess-7' CLAUDIBLE_TAB='tab2' CLAUDIBLE_EFFORT='high' CLAUDIBLE_PERMISSION_MODE='bypass' CLAUDIBLE_WS_KIND='repo' CLAUDIBLE_WS_SLUG='proj' bash '${APP}/wsl/session.sh' '${APP}'`);
eq('boot acceptEdits no-effort',
  _bootStr(APP, 'new', legacy, 'main', '', 'acceptEdits'),
  `CLAUDIBLE_SESSION='new' CLAUDIBLE_TAB='main' CLAUDIBLE_PERMISSION_MODE='acceptEdits' CLAUDIBLE_WS_KIND='legacy' bash '${APP}/wsl/session.sh' '${APP}'`);
eq('boot default mode omits perm env',
  _bootStr(APP, 'new', legacy, 'main', 'high', 'default'),
  `CLAUDIBLE_SESSION='new' CLAUDIBLE_TAB='main' CLAUDIBLE_EFFORT='high' CLAUDIBLE_WS_KIND='legacy' bash '${APP}/wsl/session.sh' '${APP}'`);

// model strategy: 'planBigExecSmall' inlines CLAUDIBLE_MODEL_STRATEGY (after PERM); anything else omits it
eq('boot planBigExecSmall inlines the strategy env',
  _bootStr(APP, 'new', legacy, 'main', 'high', 'bypass', 'planBigExecSmall'),
  `CLAUDIBLE_SESSION='new' CLAUDIBLE_TAB='main' CLAUDIBLE_EFFORT='high' CLAUDIBLE_PERMISSION_MODE='bypass' CLAUDIBLE_MODEL_STRATEGY='planBigExecSmall' CLAUDIBLE_WS_KIND='legacy' bash '${APP}/wsl/session.sh' '${APP}'`);
eq('boot strategy off omits the env',
  _bootStr(APP, 'new', legacy, 'main', 'high', 'default', 'off'),
  `CLAUDIBLE_SESSION='new' CLAUDIBLE_TAB='main' CLAUDIBLE_EFFORT='high' CLAUDIBLE_WS_KIND='legacy' bash '${APP}/wsl/session.sh' '${APP}'`);
eq('boot unknown strategy value omitted (allowlist)',
  _bootStr(APP, 'new', legacy, 'main', 'high', 'default', "hax'; rm -rf /"),
  `CLAUDIBLE_SESSION='new' CLAUDIBLE_TAB='main' CLAUDIBLE_EFFORT='high' CLAUDIBLE_WS_KIND='legacy' bash '${APP}/wsl/session.sh' '${APP}'`);

// ---- runScript / _scriptCmd : every call-site shape (main.js line cited) ----
// sessions.sh — ws, no args  (main.js:562)
eq('sessions.sh (ws)', _scriptCmd(APP, 'sessions.sh', '', { ws: legacy }),
  `CLAUDIBLE_WS_KIND='legacy' bash '${APP}/wsl/sessions.sh'`);
// delete-session.sh — ws + quoted sid  (main.js:579)
eq('delete-session.sh (ws, sid)', _scriptCmd(APP, 'delete-session.sh', `'abc-123'`, { ws: legacy }),
  `CLAUDIBLE_WS_KIND='legacy' bash '${APP}/wsl/delete-session.sh' 'abc-123'`);
// sessions-sync.sh — extraEnv (live) + ws + quoted op  (main.js:635)
eq('sessions-sync.sh (live+ws+op)', _scriptCmd(APP, 'sessions-sync.sh', `'sync'`, { ws: repo, extraEnv: `CLAUDIBLE_LIVE_SESSION='sess-1' ` }),
  `CLAUDIBLE_LIVE_SESSION='sess-1' CLAUDIBLE_WS_KIND='repo' CLAUDIBLE_WS_SLUG='proj' bash '${APP}/wsl/sessions-sync.sh' 'sync'`);
// sessions-sync.sh — presence-set, multi unquoted+quoted args  (main.js:487/506/518)
eq('sessions-sync.sh (presence-set)', _scriptCmd(APP, 'sessions-sync.sh', `presence-set 'sid1' 'https://x.trycloudflare.com' 'tok' 'bmFtZQ=='`, { ws: legacy }),
  `CLAUDIBLE_WS_KIND='legacy' bash '${APP}/wsl/sessions-sync.sh' presence-set 'sid1' 'https://x.trycloudflare.com' 'tok' 'bmFtZQ=='`);
// clone-workspace.sh — NO wsEnv, default dir  (main.js:708)
eq('clone-workspace.sh (no-ws, default)', _scriptCmd(APP, 'clone-workspace.sh', `'me' 'proj'`, {}),
  `bash '${APP}/wsl/clone-workspace.sh' 'me' 'proj'`);
// clone-workspace.sh — NO wsEnv, custom dir arg  (main.js:707-708)
eq('clone-workspace.sh (no-ws, dirArg)', _scriptCmd(APP, 'clone-workspace.sh', `'me' 'proj' '/home/me/x'`, {}),
  `bash '${APP}/wsl/clone-workspace.sh' 'me' 'proj' '/home/me/x'`);
// skills.sh — ws + bare subcommand  (main.js:942)
eq('skills.sh list (ws)', _scriptCmd(APP, 'skills.sh', 'list', { ws: legacy }),
  `CLAUDIBLE_WS_KIND='legacy' bash '${APP}/wsl/skills.sh' list`);
// skills.sh — ws + subcommand + quoted args  (main.js:953)
eq('skills.sh set (ws)', _scriptCmd(APP, 'skills.sh', `set 'myskill' 'on'`, { ws: legacy }),
  `CLAUDIBLE_WS_KIND='legacy' bash '${APP}/wsl/skills.sh' set 'myskill' 'on'`);
// plugins.sh — NO wsEnv + bare subcommand  (main.js:961)
eq('plugins.sh list (no-ws)', _scriptCmd(APP, 'plugins.sh', 'list', {}),
  `bash '${APP}/wsl/plugins.sh' list`);
// agent-tokens.sh — ws + quoted sid  (main.js:1025)
eq('agent-tokens.sh (ws, sid)', _scriptCmd(APP, 'agent-tokens.sh', `'sid1'`, { ws: repo }),
  `CLAUDIBLE_WS_KIND='repo' CLAUDIBLE_WS_SLUG='proj' bash '${APP}/wsl/agent-tokens.sh' 'sid1'`);
// diff-apply.sh — ws + mode + guest temp-path arg  (main.js:1190)
eq('diff-apply.sh (ws, mode, tmp)', _scriptCmd(APP, 'diff-apply.sh', `apply-reverse '${APP}/runtime/diffaction-123-1.tmp'`, { ws: legacy }),
  `CLAUDIBLE_WS_KIND='legacy' bash '${APP}/wsl/diff-apply.sh' apply-reverse '${APP}/runtime/diffaction-123-1.tmp'`);
// services.sh — bare, no ws  (main.js:151 — note: this one is its own method, but the shape matches)
eq('plugins.sh available (no-ws)', _scriptCmd(APP, 'plugins.sh', 'available', {}),
  `bash '${APP}/wsl/plugins.sh' available`);

console.log(`\nrunner-parity: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
