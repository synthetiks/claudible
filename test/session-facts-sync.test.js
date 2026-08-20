// test/session-facts-sync.test.js — drives the sync tool's session-fact subcommands
// (wsl/sessions-sync-tool.js: fact-append, fact-read, fact-restore) against real files and a real
// throwaway git repo. These are the pieces that would silently do nothing rather than fail loudly,
// so they get exercised end to end rather than reasoned about.
// Runs on any OS with git. Run: node test/session-facts-sync.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
function eq(label, a, b) { try { assert.deepStrictEqual(a, b); pass++; } catch { fail++; console.error(`  FAIL ${label}\n    got: ${JSON.stringify(a)}\n    exp: ${JSON.stringify(b)}`); } }
function ok(label, c) { c ? pass++ : (fail++, console.error('  FAIL ' + label)); }

const TOOL = path.join(__dirname, '..', 'wsl', 'sessions-sync-tool.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudible-facts-'));
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const run = (sub, env) => spawnSync(process.execPath, [TOOL, sub], { encoding: 'utf8', env: Object.assign({}, process.env, env) });
const fact = (id, type, ts, data) => JSON.stringify({ id, type, seq: 0, ts, author: 'MK', authorId: '', machine: { id: '', host: '', os: '' }, required: false, data });
const lines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()); } catch { return []; } };

// ---- fact-append: adds one line, and refuses anything that would poison the record ----
const F1 = path.join(tmp, 'facts', 'MK.jsonl');
eq('append creates the file and the directory', run('fact-append', { CL_FILE: F1, CL_B64: b64(fact('f1', 'session.renamed', 100, { sessionId: 's1', title: 'One' })) }).status, 0);
eq('one fact, one line', lines(F1).length, 1);
run('fact-append', { CL_FILE: F1, CL_B64: b64(fact('f2', 'session.cleared', 200, { sessionId: 's2', continuesFrom: 's1' })) });
eq('append adds rather than replaces', lines(F1).length, 2);
eq('the first fact is still the first line', JSON.parse(lines(F1)[0]).id, 'f1');

// A display name is arbitrary user text — quotes, newlines, unicode — and must survive the trip.
const nasty = 'He said "hi"\\ — über\nsecond line';
run('fact-append', { CL_FILE: F1, CL_B64: b64(fact('f3', 'session.renamed', 300, { sessionId: 's3', title: nasty })) });
eq('a fact stays on one line even when its text contains newlines', lines(F1).length, 3);
eq('quotes and unicode survive the round trip', JSON.parse(lines(F1)[2]).data.title.indexOf('über') > -1, true);

// Refusals: each of these would break the merge for every machine, so they fail loudly at the door.
ok('append refuses a fact with no id', run('fact-append', { CL_FILE: F1, CL_B64: b64('{"ts":1}') }).status !== 0);
ok('append refuses a fact with no timestamp', run('fact-append', { CL_FILE: F1, CL_B64: b64('{"id":"x"}') }).status !== 0);
ok('append refuses text that is not json', run('fact-append', { CL_FILE: F1, CL_B64: b64('not json') }).status !== 0);
ok('append refuses an empty fact', run('fact-append', { CL_FILE: F1, CL_B64: '' }).status !== 0);
ok('append refuses with no file', run('fact-append', { CL_B64: b64(fact('f9', 'session.renamed', 1, {})) }).status !== 0);
eq('no refusal wrote anything', lines(F1).length, 3);

// ---- fact-restore: the conflict path must not lose an unpushed decision ----
// A hard reset to origin is how a merge conflict is stopped from wedging sync forever. Everything
// else it discards can be re-derived from this machine; a fact cannot.
const DEST = path.join(tmp, 'restore', 'MK.jsonl');
const SNAP = path.join(tmp, 'snapshot.jsonl');
fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.writeFileSync(DEST, fact('a', 'session.renamed', 1, { sessionId: 's', title: 'origin' }) + '\n');
fs.writeFileSync(SNAP, [fact('a', 'session.renamed', 1, { sessionId: 's', title: 'origin' }), fact('b', 'session.deleted', 2, { sessionId: 's2' })].join('\n') + '\n');
run('fact-restore', { CL_FILE: DEST, CL_SAVED: SNAP });
eq('restore keeps the unpushed fact', lines(DEST).map((l) => JSON.parse(l).id), ['a', 'b']);
run('fact-restore', { CL_FILE: DEST, CL_SAVED: SNAP });
eq('restore is idempotent — running it twice does not duplicate', lines(DEST).length, 2);
// Origin ahead of us: nothing of theirs may be dropped either.
fs.writeFileSync(DEST, [fact('a', 'session.renamed', 1, {}), fact('c', 'session.renamed', 3, {})].join('\n') + '\n');
run('fact-restore', { CL_FILE: DEST, CL_SAVED: SNAP });
eq('restore unions both sides', lines(DEST).map((l) => JSON.parse(l).id).sort(), ['a', 'b', 'c']);
// A missing snapshot is the normal case (nothing local to keep) and must be a clean no-op.
const before = lines(DEST).length;
run('fact-restore', { CL_FILE: DEST, CL_SAVED: path.join(tmp, 'nope.jsonl') });
eq('a missing snapshot changes nothing', lines(DEST).length, before);

// ---- fact-read: every author's facts, straight off the branch ----
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
const REPO = path.join(tmp, 'repo');
fs.mkdirSync(REPO, { recursive: true });
let gitOk = git(REPO, 'init', '-q').status === 0;
if (gitOk) {
  git(REPO, 'config', 'user.email', 'test@example.com');
  git(REPO, 'config', 'user.name', 'Test');
  fs.mkdirSync(path.join(REPO, 'facts'), { recursive: true });
  fs.writeFileSync(path.join(REPO, 'facts', 'MK.jsonl'), [fact('r1', 'session.renamed', 10, { sessionId: 's', title: 'mine' }), 'torn line {', fact('r2', 'session.deleted', 20, { sessionId: 't' })].join('\n') + '\n');
  fs.writeFileSync(path.join(REPO, 'facts', 'crazy.jsonl'), fact('r3', 'session.cleared', 30, { sessionId: 'u', continuesFrom: 's' }) + '\n');
  fs.writeFileSync(path.join(REPO, 'facts', 'notes.txt'), 'ignore me\n');
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-q', '-m', 'facts');
  // fact-read reads origin/<br>; point origin at ourselves so the fixture needs no network.
  git(REPO, 'remote', 'add', 'origin', REPO);
  git(REPO, 'fetch', '-q', 'origin');
  const r = run('fact-read', { CL_WT: REPO, CL_BR: (git(REPO, 'rev-parse', '--abbrev-ref', 'HEAD').stdout || 'main').trim() });
  let out = null;
  try { out = JSON.parse(r.stdout.trim()); } catch { out = null; }
  ok('fact-read emits one parseable json line', !!out && out.ok === true);
  const ids = out ? out.facts.map((f) => f.id).sort() : [];
  eq('fact-read collects every author', ids, ['r1', 'r2', 'r3']);
  eq('fact-read drops a torn line without losing its neighbours', out ? out.facts.length : -1, 3);
  const r2 = run('fact-read', { CL_WT: REPO, CL_BR: 'no-such-branch' });
  let empty = null;
  try { empty = JSON.parse(r2.stdout.trim()); } catch { empty = null; }
  ok('an unknown branch reads as empty, not as a crash', !!empty && empty.ok === true && empty.facts.length === 0);
} else {
  console.log('  SKIP fact-read (git unavailable)');
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`session-facts-sync: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
