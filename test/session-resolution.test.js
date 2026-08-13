// test/session-resolution.test.js — sessionToOpenFor, EXECUTED (lifted out of renderer/app.js and run against
// stubbed collaborators). It moved here from contract.test.js check 60 when the helper became async — a
// synchronous file can't await it, and these cases are the ones that reproduce two real bugs:
//   * the PHANTOM DRAFT: a never-visited project's cache is cold, and the old resolver answered 'new' without
//     looking — a shared project full of a collaborator's sessions opened as a blank draft. The resolver must
//     FETCH on a cold cache and say 'new' only for a genuinely empty project.
//   * the DEAD SPACEBAR's first domino: the normal switch path used this resolver's absence ('' fallback) to
//     skip the duplicate-session dedupe. Every id this function returns feeds that dedupe, so its answers must
//     be real ids, deterministically ordered.
// Run: node test/session-resolution.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');

let pass = 0, fail = 0;
const eq = (label, a, b) => { try { assert.strictEqual(a, b); pass++; } catch { fail++; console.error(`  FAIL ${label}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); } };
const ok = (label, c) => { c ? pass++ : (fail++, console.error('  FAIL ' + label)); };

// lift the real function — including its `async` keyword, or the await inside it is a SyntaxError
const m = APP.match(/async function sessionToOpenFor\(wsId, targetSession(?:, \w+)?\)[\s\S]*?\n\}/);
if (!m) { console.error('  FAIL sessionToOpenFor not found in renderer/app.js'); process.exit(1); }

// mk(remembered, warmList, fetch) → the lifted resolver wired to stubs. `calls` records every IPC the
// resolver makes, so the no-fetch-when-warm cases can assert silence, not just the right answer.
// `forgotten` records every pointer the resolver drops, so "a deleted session is not resumed" can be asserted as
// two separate facts: the answer it gives, and whether it cleaned up the dead record behind it.
function mk(remembered, warmList, fetchImpl) {
  const calls = [];
  const forgotten = [];
  const cache = new Map(warmList ? [['W', { list: warmList, ts: 1 }]] : []);
  const claudible = { sessionListWs: async (id) => { calls.push(id); return fetchImpl(id); } };
  const fn = new Function('lastSessionFor', 'forgetLastSession', '_wsSessCache', 'hasExplicitTitle', 'orderedSessionsFor', 'claudible', 'Date',
    m[0] + '; return sessionToOpenFor;')(
    () => remembered, (ws) => forgotten.push(ws), cache, () => false, (ws, l) => l, claudible, Date);
  return { fn, calls, cache, forgotten };
}

(async () => {
  // ---- the resolution ladder, cheap rungs first (no IPC when the answer is already known) ----
  { const { fn, calls } = mk(null, null, async () => [{ id: 'S1', msgs: 3 }]);
    eq('an explicitly requested session wins', await fn('W', 'EXPLICIT'), 'EXPLICIT');
    eq('…without fetching', calls.length, 0); }
  { const { fn, calls } = mk('REMEMBERED', null, async () => [{ id: 'S1', msgs: 3 }]);
    eq('the session you were last in wins', await fn('W'), 'REMEMBERED');
    eq('…without fetching', calls.length, 0); }
  { const { fn, calls } = mk(null, [{ id: 'S1', msgs: 3 }, { id: 'S2', msgs: 1 }], async () => { throw new Error('no'); });
    eq('a warm cache resolves the project’s top saved session', await fn('W'), 'S1');
    eq('…without fetching', calls.length, 0); }

  // ---- A REMEMBERED SESSION THAT NO LONGER EXISTS IS NOT RESUMED ----
  // Resuming a deleted id put `--resume <dead id>` on the pty, the CLI answered "No conversation found with
  // session ID: …", and the tab came up on a session it could never open — whose fresh id was then recorded as
  // a continuation of a parent that is gone. The check is deliberately one-sided: only a GOOD list can convict.
  { const { fn, calls, forgotten } = mk('DELETED', [{ id: 'S1', msgs: 3 }, { id: 'S2', msgs: 1 }], async () => { throw new Error('no'); });
    eq('a remembered session absent from a good list is not resumed — the project opens its top session instead', await fn('W'), 'S1');
    eq('…and the dead pointer is dropped rather than left to lose the race again', forgotten.length, 1);
    eq('…still without fetching', calls.length, 0); }
  { const { fn, forgotten } = mk('S2', [{ id: 'S1', msgs: 3 }, { id: 'S2', msgs: 1 }], async () => { throw new Error('no'); });
    eq('a remembered session the list confirms still wins', await fn('W'), 'S2');
    eq('…and nothing is forgotten', forgotten.length, 0); }
  { const { fn, calls, forgotten } = mk('REMEMBERED', null, async () => [{ id: 'S1', msgs: 3 }]);
    eq('a COLD cache cannot convict: the record is trusted, not second-guessed', await fn('W'), 'REMEMBERED');
    eq('…the pointer survives an unverifiable check', forgotten.length, 0);
    eq('…and the fast path stays fast (no boot-path round trip)', calls.length, 0); }
  { const { fn, cache, forgotten } = mk('DELETED', [{ id: 'S1', msgs: 3 }], async () => { throw new Error('no'); });
    cache.get('W').stale = true;   // a sync landed changes since this list was read — it proves nothing about a missing id
    eq('a STALE cache cannot convict either', await fn('W'), 'DELETED');
    eq('…so the pointer survives', forgotten.length, 0); }

  // ---- THE PHANTOM-DRAFT FIX: a cold cache is fetched, not guessed ----
  { const { fn, calls, cache } = mk(null, null, async () => [{ id: 'SYNCED-IN', msgs: 5 }]);
    eq('a never-visited project with synced-in sessions opens one of them, not a blank draft', await fn('W'), 'SYNCED-IN');
    eq('…via exactly one fetch', calls.length, 1);
    ok('…and the fetch warmed the cache (the switch repaint gets real rows, not skeletons)',
      cache.has('W') && cache.get('W').list[0].id === 'SYNCED-IN'); }
  { const { fn } = mk(null, [], async () => [{ id: 'SYNCED-IN', msgs: 5 }]);
    eq('a warm-but-EMPTY cache is re-fetched too (an empty answer is a guess, not a fact)', await fn('W'), 'SYNCED-IN'); }

  // ---- honest 'new': only when the project is GENUINELY empty, and never a crash on a failed fetch ----
  { const { fn } = mk(null, null, async () => []);
    eq('a genuinely empty project opens a blank draft', await fn('W'), 'new'); }
  { const { fn } = mk(null, null, async () => { throw new Error('ipc dead'); });
    eq('a FAILED fetch degrades to a draft instead of throwing into the switch path', await fn('W'), 'new'); }
  { const { fn } = mk(null, null, async () => 'not-an-array');
    eq('a malformed fetch result is discarded, not cached or crashed on', await fn('W'), 'new'); }
  { const { fn } = mk(null, [{ id: 'STUB', msgs: 0 }], async () => [{ id: 'STUB', msgs: 0 }]);
    eq('promptless stubs never count as “has sessions”', await fn('W'), 'new'); }

  // ---- determinism: whatever ordering helper the app uses is the one this resolver obeys ----
  { const calls = [];
    const cache = new Map([['W', { list: [{ id: 'A', msgs: 1 }, { id: 'B', msgs: 9 }], ts: 1 }]]);
    const fn = new Function('lastSessionFor', 'forgetLastSession', '_wsSessCache', 'hasExplicitTitle', 'orderedSessionsFor', 'claudible', 'Date',
      m[0] + '; return sessionToOpenFor;')(
      () => null, () => {}, cache, () => false, (ws, l) => [...l].reverse(), { sessionListWs: async () => { calls.push(1); return []; } }, Date);
    eq('the TOP OF THE ORDER wins, not raw list position (same helper as every render path)', await fn('W'), 'B'); }

  // ---- the phantom-draft ROOT fix + safety net (grep pins over the shipped renderer) ----
  // Fix A lives in main.js. C-4.4 (owners' decision, 2026-08-06) retired the renderer half's auto-draft-and-
  // reconcile dance entirely: a project that resolves 'new' is PARKED — no pty ever starts for it — and shows
  // a create/retry overlay until an explicit Create/Retry click (or a session CONFIRMED to already exist).
  // These pins now check that mechanism instead of the retired autoDraft one.
  // The SOURCE half of "a deleted session is never resumed": clearing the pointer as part of the delete itself,
  // so it cannot outlive the transcript. deleteSession's re-point loop only covers tabs SITTING on that session,
  // so a session deleted while no tab holds it — and any delete followed by a quit before the next refresh —
  // would otherwise leave the pointer naming a session that is gone, and the next boot would resume it.
  ok('deleting a session clears the workspace pointer that names it',
    /if \(lastSessionFor\(myWs\) === id\) forgetLastSession\(myWs\);/.test(APP));
  ok('…gated on the delete having actually happened (a failed delete must keep the pointer)',
    /if \(r && \(r\.ok \|\| r\.localDone\)\) \{[\s\S]{0,900}?forgetLastSession\(myWs\);/.test(APP));
  ok('tab records default parked:false', /session: session \|\| '', altFrac: 0, parked: false, parkReason: '',/.test(APP));
  ok('commitParkedTab is the only place a parked tab turns real (id===\'new\' spawns fresh, any other id opens in place)',
    /function commitParkedTab\(t, id, name\)/.test(APP) && /t\.parked = false; t\.parkReason = '';/.test(APP));
  ok('onStatus stopped clearing a retired autoDraft flag when a real session id lands (nothing to clear anymore)',
    !/t\.autoDraft = false;/.test(APP));
  ok('onSyncChanged reconciles ONLY an active, parked, still-\'new\', non-busy tab, and re-checks after the async resolve',
    /at\.session === 'new' && at\.parked && !at\.busy/.test(APP)
    && /t2\.session === 'new' && t2\.parked && !t2\.busy/.test(APP)
    && /commitParkedTab\(t2, want, sessIndex\[want\]/.test(APP));

  // ---- the BOOT fix: the launch tab is parked — no pty starts — until the restored workspace's real session
  // (or its confirmed absence) is known, resolved ONCE right after the workspace binds. Mirrors onSyncChanged's
  // discipline (re-check after the async resolve, never hijack a tab the user has since acted on).
  ok('the boot tab is parked so a restored, already-synced project never guesses a session before it is known',
    /mt\.session = 'new'; mt\.parked = true; mt\.parkReason = 'empty';/.test(APP));
  ok('boot resolves the restored project\'s real session in place instead of leaving a blank draft',
    /await refreshWorkspaces\(\);[\s\S]{0,600}?want = await sessionToOpenFor\(at\.wsId, null, info\)/.test(APP)
    && /t2\.session === 'new' && t2\.parked && !t2\.busy/.test(APP)
    && /commitParkedTab\(t2, want, sessIndex\[want\] \? sessTitle\(sessIndex\[want\]\) : ''\)/.test(APP));

  console.log(`session-resolution: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
