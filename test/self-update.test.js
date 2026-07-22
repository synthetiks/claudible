// test/self-update.test.js — lib/selfUpdate.js (the drift chip's "Update & restart") against REAL git
// repos, plus the wiring pins that keep the restart path honest. The invariants that must never regress:
// a dirty tree is refused with evidence (never auto-stashed), a pull failure is classified into an
// actionable kind, deps-changed detection sees lockfile-only bumps, an Electron bump is refused before npm
// can try to overwrite the running binary, and the restart runs the SAME teardown as a normal quit.
// Run: node test/self-update.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const su = require('../lib/selfUpdate.js');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (label, c) => { c ? pass++ : (fail++, console.error('  FAIL ' + label)); };

function sh(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }
function mkrepo(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-selfupd-'));
  sh(d, 'init', '-q');
  for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(d, rel), content);
  sh(d, 'add', '-A');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'c1'], { cwd: d });
  return d;
}

(async () => {
  // ---- dirty detection: refused WITH the evidence ----
  {
    const d = mkrepo({ 'a.txt': 'one\n' });
    ok('clean tree reports clean', (await su.isDirty(d)).dirty === false);
    fs.writeFileSync(path.join(d, 'a.txt'), 'changed\n');
    const r = await su.isDirty(d);
    ok('dirty tree is detected', r.dirty === true);
    ok('…with the porcelain evidence attached', /a\.txt/.test(r.detail));
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ---- pull classification against real remotes ----
  {
    // clone from a local origin, then advance origin → ff pull succeeds
    const origin = mkrepo({ 'f.txt': 'v1\n' });
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-selfupd-c-'));
    execFileSync('git', ['clone', '-q', origin, clone]);
    fs.writeFileSync(path.join(origin, 'f.txt'), 'v2\n');
    sh(origin, 'add', '-A');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'c2'], { cwd: origin });
    const before = await su.currentSha(clone);
    ok('pull fast-forwards a clean clone', (await su.pull(clone)).ok === true);
    const after = await su.currentSha(clone);
    ok('sha moved across the pull', before && after && before !== after);

    // diverge: local commit not on origin + origin moves again → non-ff classified
    fs.writeFileSync(path.join(clone, 'local.txt'), 'mine\n');
    sh(clone, 'add', '-A');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'local'], { cwd: clone });
    fs.writeFileSync(path.join(origin, 'f.txt'), 'v3\n');
    sh(origin, 'add', '-A');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'c3'], { cwd: origin });
    const nf = await su.pull(clone);
    ok('diverged checkout → classified non-ff (never merged silently)', nf.ok === false && nf.kind === 'non-ff');

    // unreachable remote → offline-ish classification (never 'ok')
    const dead = mkrepo({ 'x.txt': 'x\n' });
    sh(dead, 'remote', 'add', 'origin', 'https://127.0.0.1:1/nope.git');
    const off = await su.pull(dead).catch(() => ({ ok: false, kind: 'git' }));
    ok('unreachable/untracked remote → a failure kind, never ok', off.ok === false && ['offline', 'git', 'no-branch'].includes(off.kind));
    fs.rmSync(origin, { recursive: true, force: true }); fs.rmSync(clone, { recursive: true, force: true }); fs.rmSync(dead, { recursive: true, force: true });
  }

  // ---- deps-changed: lockfile-only bumps count; unrelated files don't ----
  {
    const d = mkrepo({ 'package.json': '{"dependencies":{}}\n', 'package-lock.json': '{"v":1}\n', 'src.js': '1\n' });
    const s1 = await su.currentSha(d);
    fs.writeFileSync(path.join(d, 'src.js'), '2\n');
    sh(d, 'add', '-A');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'code-only'], { cwd: d });
    const s2 = await su.currentSha(d);
    ok('code-only change → no npm install needed', (await su.depsChanged(d, s1, s2)) === false);
    fs.writeFileSync(path.join(d, 'package-lock.json'), '{"v":2}\n');
    sh(d, 'add', '-A');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'lock-bump'], { cwd: d });
    const s3 = await su.currentSha(d);
    ok('lockfile-only bump → npm install IS needed', (await su.depsChanged(d, s2, s3)) === true);

    // electron devDependency bump is detected (the refuse-before-npm case)
    fs.writeFileSync(path.join(d, 'package.json'), '{"dependencies":{},"devDependencies":{"electron":"42.0.0"}}\n');
    sh(d, 'add', '-A');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'e1'], { cwd: d });
    const s4 = await su.currentSha(d);
    fs.writeFileSync(path.join(d, 'package.json'), '{"dependencies":{},"devDependencies":{"electron":"43.0.0"}}\n');
    sh(d, 'add', '-A');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'e2'], { cwd: d });
    const s5 = await su.currentSha(d);
    ok('electron version bump is detected across shas', (await su.electronVersionChanged(d, s4, s5)) === true);
    ok('no electron bump between identical manifests', (await su.electronVersionChanged(d, s2, s3)) === false);
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ---- diverged (force-pushed) clone recovers WITHOUT a human running git ----
  {
    const origin = mkrepo({ 'f.txt': 'v1\n' });
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-selfupd-d-'));
    execFileSync('git', ['clone', '-q', origin, clone]);
    // rewrite origin's history (what a force-push looks like to this clone)
    fs.writeFileSync(path.join(origin, 'f.txt'), 'rewritten\n');
    sh(origin, 'add', '-A');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '--amend', '-m', 'rewritten'], { cwd: origin });
    const pr = await su.pull(clone);
    ok('a force-pushed upstream is classified non-ff (pull can never succeed again)', pr.ok === false && pr.kind === 'non-ff');
    const rr = await su.resetToUpstream(clone);
    ok('resetToUpstream recovers it automatically', rr.ok === true);
    ok('…and the clone now matches the rewritten upstream', fs.readFileSync(path.join(clone, 'f.txt'), 'utf8').trim() === 'rewritten');
    fs.rmSync(origin, { recursive: true, force: true }); fs.rmSync(clone, { recursive: true, force: true });
  }

  // ---- wiring pins: the restart path must reuse the ONE quit teardown; the chip button exists; opt-out honored ----
  const MAIN = read('main.js');
  const APP = read('renderer/app.js');
  const HTML = read('renderer/index.html');
  const PRELOAD = read('preload.js');
  const INSTALL = read('install.ps1');
  ok('main: update:run refuses when -NoUpdate was persisted', /CLAUDIBLE_NO_UPDATE/.test(MAIN));
  ok('main: update:run refuses dirty trees and never stashes', /commit, stash, or discard/.test(MAIN) && !/git.*stash/.test(MAIN));
  ok('main: the restart runs teardownForExit() then relaunch/exit (app.exit bypasses window-all-closed)',
    /teardownForExit\(\);\s*\n\s*app\.relaunch\(\);\s*\n\s*app\.exit\(0\);/.test(MAIN));
  ok('main: single-flight lock on update:run', /updateInFlight/.test(MAIN));
  ok('main: a diverged checkout self-heals instead of telling the user to run git',
    /pr\.kind === 'non-ff'/.test(MAIN) && /resetToUpstream\(__dirname\)/.test(MAIN));
  ok('main: an Electron runtime bump is refused before npm can touch the running binary', /electronVersionChanged/.test(MAIN) && /re-run install\.ps1/.test(MAIN));
  ok('renderer: the chip button exists and confirms before killing busy/live work', /build-drift-update/.test(HTML) && /amHostingLive\(\)/.test(APP) && /Updating restarts Claudible now/.test(APP));
  ok('preload: updateRun/onUpdateProgress bridge the new channels', /update:run/.test(PRELOAD) && /update:progress/.test(PRELOAD));
  ok('install.ps1: -NoUpdate persists the opt-out env var for the in-app button', /CLAUDIBLE_NO_UPDATE/.test(INSTALL));

  console.log(`self-update: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
