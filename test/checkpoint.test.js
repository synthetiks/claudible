// test/checkpoint.test.js — integration-tests lib/checkpoint.js against a REAL throwaway git repo:
// snapshot captures tracked+untracked without touching HEAD/index; restore rolls the worktree back
// and deletes files added since. Fast (a handful of plumbing calls on a tiny repo). No network.
// Run: node test/checkpoint.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { snapshot, resolve, restore } = require('../lib/checkpoint.js');

let pass = 0, fail = 0;
function ok(label, c) { c ? pass++ : (fail++, console.error('  FAIL ' + label)); }
function eq(label, a, b) { try { assert.strictEqual(a, b); pass++; } catch { fail++; console.error(`  FAIL ${label}\n    got: ${JSON.stringify(a)}\n    exp: ${JSON.stringify(b)}`); } }

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-ckpt-'));
// a git runner bound to the repo: returns { code, stdout }; merges any env (e.g. GIT_INDEX_FILE)
function git(args, env) {
  try {
    const stdout = cp.execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: Object.assign({}, process.env, env || {}), stdio: ['ignore', 'pipe', 'ignore'] });
    return { code: 0, stdout };
  } catch (e) { return { code: e.status || 1, stdout: e.stdout ? String(e.stdout) : '' }; }
}
const W = (rel, txt) => fs.writeFileSync(path.join(repo, rel), txt);
const R = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
const rmFile = (rel) => fs.unlinkSync(path.join(repo, rel));
const tmpIdx = path.join(repo, '.git', 'cl-tmp-index');

git(['init', '-q']);
git(['config', 'user.email', 't@t.t']); git(['config', 'user.name', 'T']);
W('a.txt', 'A1'); git(['add', 'a.txt']); git(['commit', '-qm', 'base']);   // HEAD exists

// --- snapshot c1: a.txt modified + b.txt untracked ---
W('a.txt', 'A2'); W('b.txt', 'B1');
const headBefore = git(['rev-parse', 'HEAD']).stdout.trim();
const sha1 = snapshot(git, 'c1', tmpIdx);
ok('snapshot returns a sha', /^[0-9a-f]{40}$/.test(sha1));
ok('checkpoint ref exists', resolve(git, 'c1') === sha1);
eq('HEAD untouched by snapshot', git(['rev-parse', 'HEAD']).stdout.trim(), headBefore);
eq('real index untouched (a.txt still staged as base)', git(['diff', '--cached', '--name-only']).stdout.trim(), '');

// --- diverge: delete b, add c, change a ---
rmFile('b.txt'); W('c.txt', 'C1'); W('a.txt', 'A3');
ok('pre-restore state diverged', R('a.txt') === 'A3' && fs.existsSync(path.join(repo, 'c.txt')) && !fs.existsSync(path.join(repo, 'b.txt')));

// --- restore to c1 ---
const res = restore(git, 'c1', rmFile);
ok('restore ok', res.ok === true);
eq('a.txt rolled back to checkpoint', R('a.txt'), 'A2');
ok('b.txt (untracked-at-ckpt) restored', fs.existsSync(path.join(repo, 'b.txt')) && R('b.txt') === 'B1');
ok('c.txt (added after ckpt) removed', !fs.existsSync(path.join(repo, 'c.txt')));
ok('removed list names c.txt', res.removed.indexOf('c.txt') !== -1);
eq('HEAD still untouched after restore', git(['rev-parse', 'HEAD']).stdout.trim(), headBefore);

// --- missing checkpoint -> ok:false ---
ok('restore of unknown id -> ok:false', restore(git, 'nope', rmFile).ok === false);

fs.rmSync(repo, { recursive: true, force: true });
console.log(`\ncheckpoint (real temp repo): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
