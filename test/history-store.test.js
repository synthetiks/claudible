// test/history-store.test.js — exercises the event-log disk layer (lib/historyStore.js) against a
// REAL temp dir: roundtrip, ring-cap on disk, atomic write, corrupt-file tolerance.
// Run: node test/history-store.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load, append } = require('../lib/historyStore.js');
const { makeEntry, MAX_ENTRIES } = require('../lib/history.js');

let pass = 0, fail = 0;
function ok(label, c) { c ? pass++ : (fail++, console.error('  FAIL ' + label)); }
function eq(label, a, b) { try { assert.deepStrictEqual(a, b); pass++; } catch { fail++; console.error(`  FAIL ${label}\n    got: ${JSON.stringify(a)}`); } }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-hist-'));
const file = path.join(dir, 'history.json');

eq('load missing -> []', load(fs, file), []);

append(fs, file, makeEntry({ id: 'a', seq: 1, ts: 1, author: 'MK', prompt: 'one' }));
ok('file created', fs.existsSync(file));
eq('reload roundtrips', load(fs, file).map(e => e.id), ['a']);
ok('no .tmp left behind (atomic)', !fs.existsSync(file + '.tmp'));

for (let i = 2; i <= MAX_ENTRIES + 2; i++) append(fs, file, makeEntry({ id: 'e' + i, seq: i, ts: i, prompt: 'p' }));
eq('ring capped on disk', load(fs, file).length, MAX_ENTRIES);
eq('newest survives', load(fs, file).slice(-1)[0].id, 'e' + (MAX_ENTRIES + 2));

fs.writeFileSync(file, '{ not json');
eq('corrupt file -> [] (no throw)', load(fs, file), []);
append(fs, file, makeEntry({ id: 'z', seq: 99, ts: 99, prompt: 'recover' }));
eq('recovers after corruption', load(fs, file).map(e => e.id), ['z']);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nhistory-store (temp-dir IO): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
