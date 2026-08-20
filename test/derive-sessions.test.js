// test/derive-sessions.test.js — unit-tests the session-list projection (lib/deriveSessions.js): the
// pure function that turns transcripts + recorded facts into the rows the sidebar shows. The four
// partial-data states are the point of this file — they are what a real machine sits in for seconds
// at a time while transcripts and facts arrive by different routes.
// Runs on any OS, no deps. Run: node test/derive-sessions.test.js
'use strict';
const assert = require('assert');
const { deriveSessions } = require('../lib/deriveSessions.js');
const { makeFact } = require('../lib/sessionFacts.js');

let pass = 0, fail = 0;
function eq(label, a, b) { try { assert.deepStrictEqual(a, b); pass++; } catch { fail++; console.error(`  FAIL ${label}\n    got: ${JSON.stringify(a)}\n    exp: ${JSON.stringify(b)}`); } }
function ok(label, c) { c ? pass++ : (fail++, console.error('  FAIL ' + label)); }

const F = (id, type, ts, data) => makeFact({ id, type, ts, data, author: 'MK' });
const T = (...ids) => ids.map((id) => ({ id, title: '' }));
const idsOf = (rows) => rows.map((r) => r.id);

// ---- the plain case ----
eq('no facts: every transcript is its own row', idsOf(deriveSessions({ transcripts: T('a', 'b') })), ['a', 'b']);
eq('no transcripts: no rows', deriveSessions({ transcripts: [], facts: [F('f', 'session.renamed', 1, { sessionId: 'a', title: 'X' })] }).length, 0);
eq('input order is preserved — the caller owns sorting', idsOf(deriveSessions({ transcripts: T('z', 'a', 'm') })), ['z', 'a', 'm']);

// ---- renames: last write wins by timestamp, whichever order the facts arrive in ----
const renames = [
  F('r2', 'session.renamed', 200, { sessionId: 'a', title: 'Second' }),
  F('r1', 'session.renamed', 100, { sessionId: 'a', title: 'First' }),
];
eq('newest rename wins regardless of list order', deriveSessions({ transcripts: T('a'), facts: renames })[0].title, 'Second');
eq('and again with the list reversed', deriveSessions({ transcripts: T('a'), facts: renames.slice().reverse() })[0].title, 'Second');
eq('a transcript with no rename keeps its own title', deriveSessions({ transcripts: [{ id: 'a', title: 'On disk' }] })[0].title, 'On disk');
eq('a rename beats the title on disk', deriveSessions({ transcripts: [{ id: 'a', title: 'On disk' }], facts: [F('r', 'session.renamed', 5, { sessionId: 'a', title: 'Renamed' })] })[0].title, 'Renamed');

// ---- STATE 1: the continuation's transcript is here, the fact that records it is not ----
// The new session shows as its own row. Not wrong — just not folded yet.
eq('unrecorded continuation shows both rows', idsOf(deriveSessions({ transcripts: T('old', 'new') })), ['old', 'new']);

// ---- the fold, once the fact lands ----
const cleared = [F('c1', 'session.cleared', 300, { sessionId: 'new', continuesFrom: 'old' })];
eq('a recorded continuation folds the old row away', idsOf(deriveSessions({ transcripts: T('old', 'new'), facts: cleared })), ['new']);
eq('the surviving row remembers what it continues', deriveSessions({ transcripts: T('old', 'new'), facts: cleared })[0].continuesFrom, 'old');

// ---- STATE 2: the fact is here, the transcript it points at is not ----
// The fold is skipped ENTIRELY. Hiding the old session on the strength of a successor nobody can
// open would leave this conversation showing no row at all.
eq('a fold whose successor has not arrived does not hide the parent', idsOf(deriveSessions({ transcripts: T('old'), facts: cleared })), ['old']);

// ---- STATE 3: a delete is recorded, the transcript is still on disk ----
const del = [F('d1', 'session.deleted', 400, { sessionId: 'b' })];
eq('a recorded delete hides the session', idsOf(deriveSessions({ transcripts: T('a', 'b'), facts: del })), ['a']);

// ---- STATE 4: deleted before facts existed ----
eq('older deletion markers are still honoured', idsOf(deriveSessions({ transcripts: T('a', 'b'), tombstones: ['b'] })), ['a']);
eq('a marker and a fact for the same session agree', idsOf(deriveSessions({ transcripts: T('a', 'b'), tombstones: ['b'], facts: del })), ['a']);

// ---- deleting inside a chain must not strand the live conversation ----
// old -> mid -> new, with mid deleted. The live row is `new`; `old` stays folded away rather than
// reappearing beside it, which is exactly the duplicate this whole mechanism exists to prevent.
const chain = [
  F('c2', 'session.cleared', 10, { sessionId: 'mid', continuesFrom: 'old' }),
  F('c3', 'session.cleared', 20, { sessionId: 'new', continuesFrom: 'mid' }),
  F('d2', 'session.deleted', 30, { sessionId: 'mid' }),
];
eq('a deleted middle link leaves exactly one row', idsOf(deriveSessions({ transcripts: T('old', 'mid', 'new'), facts: chain })), ['new']);

// ---- a successor that was itself deleted gives the parent back ----
const deadChild = [
  F('c4', 'session.cleared', 10, { sessionId: 'new', continuesFrom: 'old' }),
  F('d3', 'session.deleted', 20, { sessionId: 'new' }),
];
eq('deleting the continuation restores its parent', idsOf(deriveSessions({ transcripts: T('old', 'new'), facts: deadChild })), ['old']);

// ---- live state is computed, never recorded ----
eq('the live session is flagged', deriveSessions({ transcripts: T('a', 'b'), liveState: { liveId: 'b' } }).map((r) => r.live), [false, true]);
eq('no live session means no live row', deriveSessions({ transcripts: T('a') })[0].live, false);

// ---- hostile input must not hang the sidebar ----
const cycle = [
  F('c5', 'session.cleared', 10, { sessionId: 'p', continuesFrom: 'q' }),
  F('c6', 'session.cleared', 20, { sessionId: 'q', continuesFrom: 'p' }),
];
let survived = true;
try { deriveSessions({ transcripts: T('p', 'q'), facts: cycle }); } catch { survived = false; }
ok('a continuation cycle terminates instead of hanging', survived);
eq('a self-referencing continuation is ignored', idsOf(deriveSessions({ transcripts: T('a'), facts: [F('c7', 'session.cleared', 1, { sessionId: 'a', continuesFrom: 'a' })] })), ['a']);

// ---- the whole point: two machines holding the same facts must agree ----
const shuffled = chain.slice().reverse();
eq('fact order cannot change what is displayed', deriveSessions({ transcripts: T('old', 'mid', 'new'), facts: chain }), deriveSessions({ transcripts: T('old', 'mid', 'new'), facts: shuffled }));

// ---- malformed facts are ignored rather than fatal ----
eq('a fact with no session id is skipped', idsOf(deriveSessions({ transcripts: T('a'), facts: [{ id: 'x', type: 'session.deleted', ts: 1, data: {} }] })), ['a']);
eq('a null in the fact list is skipped', idsOf(deriveSessions({ transcripts: T('a'), facts: [null] })), ['a']);
eq('missing input is an empty list, not a crash', deriveSessions().length, 0);

console.log(`derive-sessions: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
