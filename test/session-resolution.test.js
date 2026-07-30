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
const m = APP.match(/async function sessionToOpenFor\(wsId, targetSession\)[\s\S]*?\n\}/);
if (!m) { console.error('  FAIL sessionToOpenFor not found in renderer/app.js'); process.exit(1); }

// mk(remembered, warmList, fetch) → the lifted resolver wired to stubs. `calls` records every IPC the
// resolver makes, so the no-fetch-when-warm cases can assert silence, not just the right answer.
function mk(remembered, warmList, fetchImpl) {
  const calls = [];
  const cache = new Map(warmList ? [['W', { list: warmList, ts: 1 }]] : []);
  const claudible = { sessionListWs: async (id) => { calls.push(id); return fetchImpl(id); } };
  const fn = new Function('lastSessionFor', '_wsSessCache', 'hasExplicitTitle', 'orderedSessionsFor', 'claudible', 'Date',
    m[0] + '; return sessionToOpenFor;')(
    () => remembered, cache, () => false, (ws, l) => l, claudible, Date);
  return { fn, calls, cache };
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
    const fn = new Function('lastSessionFor', '_wsSessCache', 'hasExplicitTitle', 'orderedSessionsFor', 'claudible', 'Date',
      m[0] + '; return sessionToOpenFor;')(
      () => null, cache, () => false, (ws, l) => [...l].reverse(), { sessionListWs: async () => { calls.push(1); return []; } }, Date);
    eq('the TOP OF THE ORDER wins, not raw list position (same helper as every render path)', await fn('W'), 'B'); }

  // ---- the phantom-draft ROOT fix + safety net (grep pins over the shipped renderer) ----
  // Fix A lives in main.js; the renderer half is the auto-draft marker + the onSyncChanged reconcile that can
  // NEVER hijack a deliberate + New or a typed draft.
  ok('tab records default autoDraft:false', /session: session \|\| '', altFrac: 0, autoDraft: false,/.test(APP));
  ok('any real keystroke clears autoDraft (a typed draft becomes the user\'s, un-reconcilable)',
    /if \(r && r\.autoDraft\) r\.autoDraft = false; claudible\.ptyInput/.test(APP));
  ok('adopting a real session id clears autoDraft', /t\.session = s\.sessionId;[\s\S]{0,120}?t\.autoDraft = false;/.test(APP));
  ok('auto-draft is marked ONLY when the resolver returned \'new\' (a real id is never an auto-draft)',
    (APP.match(/autoDraft = \(want === 'new'\)/g) || []).length >= 2 && /t\.autoDraft = \(sess === 'new'\)/.test(APP));
  ok('onSyncChanged reconciles ONLY an active, autoDraft, still-\'new\', non-busy tab, and re-checks after the async resolve',
    /at\.session === 'new' && at\.autoDraft && !at\.busy/.test(APP)
    && /want && want !== 'new' && t2 && t2 === AT\(\) && t2\.session === 'new' && t2\.autoDraft && !t2\.busy/.test(APP)
    && /openSession\(want, sessIndex\[want\]/.test(APP));

  // ---- the BOOT phantom-draft fix: the launch tab ('' placeholder, never resolved) is marked auto-draft and
  // reconciled ONCE after the workspace binds — mirroring onSyncChanged but gated on session==='' (only ever the
  // boot tab), since no sync:changed event fires for an already-synced project on restart.
  ok('the boot tab is marked auto-draft so a restored, already-synced project is reconcilable (no boot phantom draft)',
    /tabs\.get\('main'\)\.autoDraft = true;/.test(APP));
  ok('boot resolves the restored project\'s real session in place instead of leaving a blank \'\' draft',
    /await refreshWorkspaces\(\);[\s\S]{0,600}?want = await sessionToOpenFor\(at\.wsId\)/.test(APP)
    && /want && want !== 'new' && t2 && t2 === AT\(\) && t2\.session === '' && t2\.autoDraft && !t2\.busy/.test(APP)
    && /await openSession\(want, sessIndex\[want\] \? sessTitle\(sessIndex\[want\]\) : '', \{ inPlace: true \}\)/.test(APP));

  console.log(`session-resolution: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
