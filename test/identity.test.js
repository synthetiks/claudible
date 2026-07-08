// test/identity.test.js — unit-tests the session-history identity/attribution PURE core
// (lib/identity.js). No IO, no deps. Run: node test/identity.test.js
'use strict';
const assert = require('assert');
const { resolveAuthor, machineRecord } = require('../lib/identity.js');

let pass = 0, fail = 0;
function eq(label, a, b) { try { assert.deepStrictEqual(a, b); pass++; } catch { fail++; console.error(`  FAIL ${label}\n    got: ${JSON.stringify(a)}\n    exp: ${JSON.stringify(b)}`); } }

// ---- resolveAuthor ----
eq('author from username', resolveAuthor({ username: 'MK' }), 'MK');
eq('author trims whitespace', resolveAuthor({ username: '  MK  ' }), 'MK');
eq('author falls back when blank', resolveAuthor({ username: '', fallback: 'crazy' }), 'crazy');
eq('author never empty -> unknown', resolveAuthor({}), 'unknown');

// ---- machineRecord ----
eq('machine prefers saved id', machineRecord({ savedId: 'S', uuid: 'U', host: 'PC', os: 'win32' }), { id: 'S', host: 'PC', os: 'win32' });
eq('machine falls back to fresh uuid', machineRecord({ savedId: '', uuid: 'U', host: 'PC', os: 'win32' }), { id: 'U', host: 'PC', os: 'win32' });

eq('machine trims + tolerates absent os', machineRecord({ savedId: ' S ', host: ' PC ' }), { id: 'S', host: 'PC', os: '' });
eq('machine empty input -> clean defaults', machineRecord({}), { id: '', host: '', os: '' });

console.log(`\nidentity (pure core): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
