// test/history.test.js — unit-tests the session-history PURE event-log core (lib/history.js): the
// append-only log that backs the Repo Review activity feed + revert. Runs on any OS, no deps.
// Run: node test/history.test.js
'use strict';
const assert = require('assert');
const { makeEntry, ringPush, mergeLogs, summarizeFiles, MAX_ENTRIES } = require('../lib/history.js');

let pass = 0, fail = 0;
function eq(label, a, b) { try { assert.deepStrictEqual(a, b); pass++; } catch { fail++; console.error(`  FAIL ${label}\n    got: ${JSON.stringify(a)}\n    exp: ${JSON.stringify(b)}`); } }
function ok(label, c) { c ? pass++ : (fail++, console.error('  FAIL ' + label)); }

// ---- makeEntry: normalizes shape, deterministic (id/ts injected, no Date.now) ----
const e1 = makeEntry({ id: 1, seq: 1, ts: 100, author: 'MK', prompt: 'hi', files: [{ path: 'a', add: 2, del: 1 }] });
eq('makeEntry stringifies id', e1.id, '1');
eq('makeEntry defaults machine', e1.machine, { id: '', host: '', os: '' });
eq('makeEntry defaults checkpointRef null', e1.checkpointRef, null);
ok('makeEntry keeps files', e1.files.length === 1);
eq('makeEntry coerces missing prompt to ""', makeEntry({ id: 2, seq: 2 }).prompt, '');
// regression: a real Date.now() ms timestamp must survive intact (a `| 0` here would 32-bit-truncate it)
eq('makeEntry preserves a full ms timestamp', makeEntry({ id: 3, ts: 1782855565601 }).ts, 1782855565601);

// ---- ringPush: caps to newest MAX by seq, pure (no mutation) ----
let log = [];
for (let i = 1; i <= 12; i++) log = ringPush(log, makeEntry({ id: i, seq: i, ts: i, author: 'MK', prompt: 'p' + i }));
eq('ring capped at MAX', log.length, MAX_ENTRIES);
eq('ring kept newest', log[log.length - 1].seq, 12);
eq('ring dropped oldest (1,2 gone -> starts at 3)', log[0].seq, 3);
const before = []; const after = ringPush(before, e1);
ok('ringPush does not mutate input', before.length === 0 && after.length === 1);

// ---- mergeLogs: union by id, dedupe, sorted by seq (the sync/join reconcile) ----
const A = [makeEntry({ id: 'x', seq: 1, ts: 1, prompt: 'a' }), makeEntry({ id: 'y', seq: 2, ts: 2, prompt: 'b' })];
const B = [makeEntry({ id: 'y', seq: 2, ts: 2, prompt: 'b' }), makeEntry({ id: 'z', seq: 3, ts: 3, prompt: 'c' })];
const m = mergeLogs(A, B);
eq('merge dedupes by id', m.length, 3);
eq('merge ordered by seq', m.map(e => e.id), ['x', 'y', 'z']);
eq('merge respects cap', mergeLogs(log, [makeEntry({ id: 99, seq: 99, ts: 99 })]).length, MAX_ENTRIES);

// ---- summarizeFiles: the feed's GitHub-style one-liner ----
eq('summary none', summarizeFiles([]), 'no file changes');
eq('summary plural sums', summarizeFiles([{ path: 'a', add: 40, del: 8 }, { path: 'b', add: 2, del: 2 }]), '2 files (+42/-10)');
eq('summary singular', summarizeFiles([{ path: 'a', add: 1, del: 0 }]), '1 file (+1/-0)');

console.log(`\nhistory (pure core): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
