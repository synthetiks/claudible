// test/session-facts.test.js — unit-tests the append-only session-fact core (lib/sessionFacts.js):
// the permanent record of renames, clears and deletes that the sidebar is computed from. Runs on any
// OS, no deps. Run: node test/session-facts.test.js
'use strict';
const assert = require('assert');
const { makeFact, mergeFacts, serializeFact, parseFactLines, isReadable, unreadable, FACT_TYPES } = require('../lib/sessionFacts.js');

let pass = 0, fail = 0;
function eq(label, a, b) { try { assert.deepStrictEqual(a, b); pass++; } catch { fail++; console.error(`  FAIL ${label}\n    got: ${JSON.stringify(a)}\n    exp: ${JSON.stringify(b)}`); } }
function ok(label, c) { c ? pass++ : (fail++, console.error('  FAIL ' + label)); }

const F = (id, type, ts, data, extra) => makeFact(Object.assign({ id, type, ts, data, author: 'MK' }, extra || {}));

// ---- makeFact: normalizes, and REFUSES rather than inventing ----
const f1 = F('a1', 'session.renamed', 100, { sessionId: 's1', title: 'Hi' });
eq('makeFact keeps the type', f1.type, 'session.renamed');
eq('makeFact defaults machine', f1.machine, { id: '', host: '', os: '' });
eq('makeFact defaults required to false', f1.required, false);
eq('makeFact defaults data to an object', F('a2', 'session.deleted', 1).data, {});
ok('makeFact refuses a fact with no id', F('', 'session.renamed', 100, {}) === null);
ok('makeFact refuses an unknown type', F('a3', 'session.exploded', 100, {}) === null);
ok('makeFact refuses a missing timestamp', makeFact({ id: 'a4', type: 'session.renamed' }) === null);
ok('makeFact refuses a zero timestamp', F('a5', 'session.renamed', 0, {}) === null);
// regression: a real millisecond clock must survive intact — a `| 0` here would 32-bit-truncate it
eq('makeFact preserves a full ms timestamp', F('a6', 'session.renamed', 1782855565601, {}).ts, 1782855565601);

// ---- mergeFacts: the property the whole design rests on ----
// Unique ids are what make this commutative. The activity feed's merge overwrites per id on purpose;
// this one must never lose a fact, so the same inputs in either order MUST produce the same output.
const A = [F('m1', 'session.renamed', 10, { sessionId: 's', title: 'one' }), F('m2', 'session.renamed', 30, { sessionId: 's', title: 'three' })];
const B = [F('m3', 'session.renamed', 20, { sessionId: 's', title: 'two' })];
eq('merge unions and orders by ts', mergeFacts(A, B).map((f) => f.id), ['m1', 'm3', 'm2']);
eq('merge is order-independent', mergeFacts(A, B), mergeFacts(B, A));
eq('merge dedupes an identical fact seen twice', mergeFacts(A, A).length, 2);

// The adversarial case the feed's merge gets wrong and this one must not: two DIFFERENT facts that
// somehow carry one id. Neither order may silently produce a different answer than the other.
const clashL = F('dup', 'session.renamed', 10, { sessionId: 's', title: 'left' });
const clashR = F('dup', 'session.renamed', 10, { sessionId: 's', title: 'right' });
eq('same-id collision resolves identically in both orders', mergeFacts([clashL], [clashR]), mergeFacts([clashR], [clashL]));

// A shuffle test alone proves nothing (unique fixtures make it pass trivially), so shuffle a list
// that also contains ties and assert every ordering agrees.
const many = [];
for (let i = 0; i < 60; i++) many.push(F('s' + i, 'session.renamed', 1000 + (i % 7), { sessionId: 'x', title: 't' + i }));
const canonical = mergeFacts(many, []);
let shuffleStable = true;
for (let round = 0; round < 12; round++) {
  const copy = many.slice();
  for (let i = copy.length - 1; i > 0; i--) { const j = (i * 7 + round * 13) % (i + 1); const t = copy[i]; copy[i] = copy[j]; copy[j] = t; }
  try { assert.deepStrictEqual(mergeFacts(copy, []), canonical); } catch { shuffleStable = false; }
}
ok('merge is stable across shuffles, including timestamp ties', shuffleStable);

// NO CAP, EVER. A feed is a window and may be pruned; this is a lifetime record and may not — a
// dropped clear or delete does not degrade the sidebar, it corrupts it.
const big = [];
for (let i = 0; i < 500; i++) big.push(F('big' + i, 'session.cleared', 1 + i, { sessionId: 'c' + i, continuesFrom: 'p' + i }));
eq('merge never prunes: 500 in, 500 out', mergeFacts(big, []).length, 500);
eq('merge never prunes across two logs', mergeFacts(big.slice(0, 250), big.slice(250)).length, 500);

// ---- serialize / parse round trip ----
eq('round trip preserves the fact', parseFactLines(big.slice(0, 3).map(serializeFact).join('\n')).length, 3);
eq('parse survives a torn line without losing its neighbours', parseFactLines([serializeFact(f1), '{"id":"broken"', serializeFact(A[0])].join('\n')).length, 2);
eq('parse ignores blank lines', parseFactLines('\n\n' + serializeFact(f1) + '\n\n').length, 1);
eq('parse drops a line with no id', parseFactLines('{"ts":1,"type":"session.renamed"}').length, 0);
eq('parse drops a line with no timestamp', parseFactLines('{"id":"x","type":"session.renamed"}').length, 0);
eq('parse of nothing is an empty list', parseFactLines('').length, 0);

// ---- mixed builds: skip what is optional, refuse what is required ----
const futureOpt = { id: 'n1', type: 'session.teleported', ts: 5, required: false, data: {} };
const futureReq = { id: 'n2', type: 'session.teleported', ts: 6, required: true, data: {} };
ok('an unknown optional fact is skippable', isReadable(futureOpt));
ok('an unknown required fact is not', !isReadable(futureReq));
ok('a known fact is always readable', isReadable(f1));
eq('unreadable names only the required unknowns', unreadable([f1, futureOpt, futureReq]).map((f) => f.id), ['n2']);
eq('unreadable is empty for a log this build understands', unreadable([f1].concat(A)).length, 0);

// ---- the type list is the contract between machines ----
ok('every declared type is accepted by makeFact', FACT_TYPES.every((t, i) => F('t' + i, t, 1, {}) !== null));

console.log(`session-facts: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
