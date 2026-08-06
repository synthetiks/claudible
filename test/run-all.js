#!/usr/bin/env node
// test/run-all.js — run EVERY test file, then report one aggregate.
//
// `npm test` used to be a 43-step `&&` chain. A single failure short-circuited it, so the 3 stale assertions in
// tunnel-retry/tabs-share (step 20 of 43) meant 23 steps — including ALL NINE shell tests: sessions-divergence,
// presence-plumbing, ws-dir, path-guards, diff-commits, trash-prune, killtree, hooks-parity, port-parity — had
// not executed locally or in CI for days. Worse, the tail of the output looked like a normal failure, so
// "one test is broken" and "over half the suite never ran" were indistinguishable.
//
// This runner never short-circuits: every file runs, every failure is listed, and the exit code is still
// non-zero if anything failed — so it remains a valid CI gate.
//
// Discovery, not a hardcoded list: any test/*.test.js or test/*.sh is picked up automatically, so a new test can
// never be silently left out of the suite (adding one to the old chain was a manual package.json edit).
// e2e-boot.test.js is excluded on purpose — it launches a real Electron binary and is gated behind
// CLAUDIBLE_E2E=1 via its own `npm run test:e2e` script.
//
// --windows-safe: run only the subset the windows-latest CI leg can trust (see WINDOWS_UNSAFE_JS below for
// exactly what's cut and why). This flag lives here, not duplicated as a file list in the workflow YAML, so
// there is one place that decides what "windows-safe" means.
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const DIR = __dirname;
const EXCLUDE = new Set(['e2e-boot.test.js', 'run-all.js']);

// --windows-safe (or CLAUDIBLE_TEST_WINDOWS_SAFE=1): the subset the windows-latest CI leg runs. Every file
// here was run and confirmed green on real Windows hardware first (2026-08-06) — this is not a guess.
// Excluded on purpose, not because they're untested but because they need something a plain windows-latest
// runner does not reliably have:
//   - every *.sh file: they need a real bash, and while C-1.4's Git Bash discovery works, gh-auth and
//     network-dependent shell tests still can't run in CI regardless of which bash answers.
//   - adopt-workspace.test.js: asserts POSIX-style canonical paths and single-quote shell-escaping that
//     don't hold on a Windows temp path (backslashes, drive letters) — 6 failures reproduced on hardware.
//   - build-identity.test.js, appdir-quoting.test.js: pass on a dev machine's Windows checkout, but depend
//     on git/appdir details (shallow-clone sha lookup, install-dir quoting) this repo hasn't yet proven
//     stable across a fresh windows-latest runner's environment — left out so a first CI run can't surprise
//     us. Revisit and move into the included list once someone confirms them green on an actual Actions run.
const WINDOWS_UNSAFE_JS = new Set(['adopt-workspace.test.js', 'build-identity.test.js', 'appdir-quoting.test.js']);
const windowsSafe = process.argv.includes('--windows-safe') || process.env.CLAUDIBLE_TEST_WINDOWS_SAFE === '1';

const all = fs.readdirSync(DIR);
const js = all
  .filter((f) => f.endsWith('.test.js') && !EXCLUDE.has(f))
  .filter((f) => !windowsSafe || !WINDOWS_UNSAFE_JS.has(f))
  .sort();
const sh = windowsSafe ? [] : all.filter((f) => f.endsWith('.sh')).sort();
// contract.test.js first: it is the broadest guard and the fastest way to see a wiring break.
js.sort((a, b) => (a === 'contract.test.js' ? -1 : b === 'contract.test.js' ? 1 : a.localeCompare(b)));

// win32: plain `bash` on PATH can resolve to the WSL interop launcher ahead of a real Git Bash, which mangles
// the *.sh step's own path in its argv translation (see test/_bash-resolve.js). Resolve once, up front — a
// no-op on every other platform, where bin stays 'bash' and the args below stay untouched (byte-identical to
// before this file existed).
const bash = process.platform === 'win32' ? require('./_bash-resolve') : null;
const steps = [...js.map((f) => ({ f, cmd: process.execPath })), ...sh.map((f) => ({ f, cmd: bash ? bash.resolve().bin : 'bash' }))];

const failures = [];
const t0 = Date.now();
for (const { f, cmd } of steps) {
  const started = Date.now();
  // sh.includes(f), not a flag on the step: keeps this loop's destructuring exactly `{ f, cmd }` (a *.test.js
  // step never needs translated args, and recomputing here is cheap against a handful of *.sh filenames).
  const args = bash && sh.includes(f) ? bash.toArgs([path.join(DIR, f)]) : [path.join(DIR, f)];
  const r = cp.spawnSync(cmd, args, { stdio: 'inherit', cwd: path.resolve(DIR, '..') });
  const code = r.status == null ? 1 : r.status;   // null = killed by a signal → treat as failure, never as a pass
  if (code !== 0) failures.push({ f, code, ms: Date.now() - started });
}

const total = steps.length;
console.log('\n' + '─'.repeat(64));
if (windowsSafe) console.log('mode: --windows-safe (no *.sh, no adopt-workspace/build-identity/appdir-quoting)');
console.log(`suite: ${total - failures.length}/${total} files passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (failures.length) {
  console.log(`\n${failures.length} FAILING file(s):`);
  for (const x of failures) console.log(`  ✗ test/${x.f} (exit ${x.code})`);
  console.log('\nEvery other file still ran — see their output above.');
}
console.log('─'.repeat(64));
process.exit(failures.length ? 1 : 0);
