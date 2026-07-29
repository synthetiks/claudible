// test/runner-select.test.js — runners/runner.js select(): the dispatcher every OS-coupled call routes
// through. The three backends it returns are each well-tested; the SELECTION was not — and a selection bug
// is total (the app boots against the wrong OS backend or crashes requiring one). Pins: the CLAUDIBLE_RUNNER
// override (exact, case/space-insensitive), the unknown-value soft-fail, the per-platform defaults —
// including that Windows deliberately still defaults to the PROVEN wsl backend, not the native win one
// (flipping that is an explicit release decision gated on docs/SMOKE.md) — and the contract surface of all
// three registered backends, so a backend can't drift from the seam main.js codes against.
// Run: node test/runner-select.test.js
'use strict';
const assert = require('assert');
const runner = require('../runners/runner.js');

let pass = 0;
function ok(label, fn) { fn(); pass++; }
function withEnv(value, fn) {
  const had = 'CLAUDIBLE_RUNNER' in process.env, old = process.env.CLAUDIBLE_RUNNER;
  if (value == null) delete process.env.CLAUDIBLE_RUNNER; else process.env.CLAUDIBLE_RUNNER = value;
  try { return fn(); } finally { if (had) process.env.CLAUDIBLE_RUNNER = old; else delete process.env.CLAUDIBLE_RUNNER; }
}
function withPlatform(platform, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try { return fn(); } finally { Object.defineProperty(process, 'platform', desc); }
}

// ---- the explicit override ----
ok('CLAUDIBLE_RUNNER picks each registered backend by id', () => {
  for (const id of ['wsl', 'posix', 'win']) {
    assert.strictEqual(withEnv(id, () => runner.select()), runner.REGISTRY[id], id);
  }
});
ok('the override is trimmed and case-folded (a .env file with "Win " must not soft-fail)', () => {
  assert.strictEqual(withEnv('  WIN  ', () => runner.select()), runner.win);
  assert.strictEqual(withEnv('Posix', () => runner.select()), runner.posix);
});

// ---- unknown values fail SOFT to the platform default, and say so ----
ok('an unknown CLAUDIBLE_RUNNER warns and falls back instead of crashing or picking blindly', () => {
  const errs = [];
  const orig = console.error; console.error = (...a) => errs.push(a.join(' '));
  try {
    const picked = withEnv('electron', () => withPlatform('linux', () => runner.select()));
    assert.strictEqual(picked, runner.posix, 'unknown value must yield the platform default');
  } finally { console.error = orig; }
  assert(errs.some((l) => l.includes("'electron'") && l.includes('unknown')), 'the fallback must be loud, not silent');
});

// ---- platform defaults (the release-gated decision pinned) ----
ok('win32 defaults to the PROVEN wsl backend — native win stays opt-in until the Windows smoke passes', () => {
  assert.strictEqual(withEnv(null, () => withPlatform('win32', () => runner.select())), runner.wsl);
});
ok('linux and darwin default to posix', () => {
  for (const p of ['linux', 'darwin']) {
    assert.strictEqual(withEnv(null, () => withPlatform(p, () => runner.select())), runner.posix, p);
  }
});
ok('an empty/whitespace override is "not set", not "unknown" (no spurious warning)', () => {
  const errs = [];
  const orig = console.error; console.error = (...a) => errs.push(a.join(' '));
  try { withEnv('   ', () => withPlatform('linux', () => runner.select())); } finally { console.error = orig; }
  assert.strictEqual(errs.length, 0, 'whitespace-only must not warn');
});

// ---- the contract surface: every registered backend implements the seam main.js codes against ----
ok('all three backends expose the full Runner contract with matching ids', () => {
  const METHODS = ['detect', 'appDirGuest', 'toGuestPath', 'toHostPath', 'runtimeDir', 'ptyInfo',
    'spawnClaude', 'runScript', 'startVoiceServices', 'detectDeps'];
  for (const [id, mod] of Object.entries(runner.REGISTRY)) {
    assert.strictEqual(mod.id, id, `REGISTRY key '${id}' names a backend whose id is '${mod.id}'`);
    for (const m of METHODS) assert.strictEqual(typeof mod[m], 'function', `${id}.${m} missing from the contract`);
  }
});

console.log(`runner-select: ${pass} passed, 0 failed`);
