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
const { snapshot, resolve, restore, numstat, parseNumstat } = require('../lib/checkpoint.js');

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

// --- numstat: what changed between two checkpoints (feeds entry.files → "3 files (+42/-10)") ---
{
  W('a.txt', 'L1\nL2\nL3\n'); W('n.txt', 'N1\n');
  snapshot(git, 'ns1', tmpIdx);
  W('a.txt', 'L1\nCHANGED\nL3\nL4\n'); rmFile('n.txt'); W('m.txt', 'M1\n');
  snapshot(git, 'ns2', tmpIdx);
  const files = numstat(git, 'ns1', 'ns2');
  const by = Object.fromEntries(files.map((f) => [f.path, f]));
  ok('numstat sees the modified file', by['a.txt'] && by['a.txt'].add >= 1 && by['a.txt'].del >= 1);
  ok('numstat sees the deleted file', by['n.txt'] && by['n.txt'].del >= 1 && by['n.txt'].add === 0);
  ok('numstat sees the added file', by['m.txt'] && by['m.txt'].add >= 1 && by['m.txt'].del === 0);
  ok('numstat with an unresolvable ref → [] (best-effort, no throw)', Array.isArray(numstat(git, 'nope', 'ns2')) && numstat(git, 'nope', 'ns2').length === 0);
}
// --- parseNumstat: pure text→data (binary "-" → 0/0, junk lines dropped) ---
{
  const p = parseNumstat('12\t3\tsrc/x.js\n-\t-\tassets/logo.png\n\ngarbage line\n0\t7\tgone.txt\n');
  eq('parseNumstat count (junk dropped)', p.length, 3);
  ok('parseNumstat add/del parsed', p[0].path === 'src/x.js' && p[0].add === 12 && p[0].del === 3);
  ok('parseNumstat binary → 0/0 with path kept', p[1].path === 'assets/logo.png' && p[1].add === 0 && p[1].del === 0);
  ok('parseNumstat empty/null input → []', parseNumstat('').length === 0 && parseNumstat(null).length === 0);
}

fs.rmSync(repo, { recursive: true, force: true });
console.log(`\ncheckpoint (real temp repo): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
