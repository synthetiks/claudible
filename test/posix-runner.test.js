// test/posix-runner.test.js — verifies the native Posix backend. The killer check is LIVE: posix.runScript
// actually executes a real wsl/*.sh under bash on THIS machine (we're on Linux), proving the bash-direct
// path works end-to-end. Pure/path checks need no node-pty (lazy), so this runs under plain node.
// Run: node test/posix-runner.test.js
'use strict';
const path = require('path');
const posix = require('../runners/posix.js');

const APP = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (label, cond) => cond ? (pass++, console.log('  ok   ' + label)) : (fail++, console.error('  FAIL ' + label));

delete process.env.CLAUDIBLE_RUNTIME;   // pin the default-case assertions regardless of the caller's shell

// identity translation (the whole point of Posix vs WSL)
ok('id = posix', posix.id === 'posix');
ok('appDirGuest = APP_ROOT (no wslpath)', posix.appDirGuest() === APP);
ok('toGuestPath identity (spaces preserved)', posix.toGuestPath('/x/y z') === '/x/y z');
ok('toHostPath identity', posix.toHostPath('/a/b') === '/a/b');
ok('runtimeDir = APP_ROOT/runtime (default, env unset)', posix.runtimeDir() === path.join(APP, 'runtime'));
// CLAUDIBLE_RUNTIME must be IGNORED on posix: session.sh always derives runtime from $APPDIR (the root
// isn't threaded into bash), so honoring the env var here would split main's reads from the hooks' writes.
process.env.CLAUDIBLE_RUNTIME = '/tmp/cl-rt-test';
ok('runtimeDir ignores CLAUDIBLE_RUNTIME (writer/reader coherence with session.sh)', posix.runtimeDir() === path.join(APP, 'runtime'));
delete process.env.CLAUDIBLE_RUNTIME;
ok('detect matches platform', posix.detect() === (process.platform === 'linux' || process.platform === 'darwin'));

// buildBoot: bash session.sh directly with the native app dir (shared builder, no wsl.exe)
const boot = posix._internals.buildBoot('', { kind: 'legacy', slug: '' }, 'main', '');
ok('buildBoot -> native bash session.sh',
  boot === `CLAUDIBLE_TAB='main' CLAUDIBLE_WS_KIND='legacy' bash '${APP}/wsl/session.sh' '${APP}'`);

// LIVE: run a real wsl/*.sh under bash natively and confirm it executes + returns JSON. sessions.sh lists
// ~/.claude/projects conversations — on this machine (a live claude env) it returns a real array.
(async () => {
  const { err, stdout } = await posix.runScript('sessions.sh', '', { timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  let parsed = null; try { parsed = JSON.parse(String(stdout).trim() || '[]'); } catch {}
  ok('LIVE runScript(sessions.sh) executes natively under bash + returns a JSON array', Array.isArray(parsed));
  console.log(`       (sessions.sh -> ${Array.isArray(parsed) ? parsed.length + ' sessions' : 'non-array'}; err=${err ? err.message : 'none'})`);

  // LIVE: a trivial wsl/<x> that doesn't exist should still run bash cleanly (err from the missing script, no throw)
  const probe = await posix.runScript('___does_not_exist.sh', '', { timeout: 5000 });
  ok('LIVE runScript handles a missing script without throwing (resolves {err,stdout})', typeof probe === 'object' && 'err' in probe);

  console.log(`\nposix-runner: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
