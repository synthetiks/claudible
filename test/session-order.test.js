// test/session-order.test.js — executes the REAL ordering pipeline lifted out of renderer/app.js
// (mergeSessionOrder + orderForWs + orderedSessionsFor), the one helper all three session-list surfaces
// (authoritative list, switch pre-fill, expanded tree) now share.
//
// The bug this pins: the tree used to sort by used/mtime while the other two used the saved order, so the same
// rows visibly swapped places the instant you clicked into a project. The property that matters is PARITY —
// same workspace + same list ⇒ byte-identical order on every surface — which is exactly what one shared function
// guarantees and three hand-rolled sorts never did. Run: node test/session-order.test.js
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (label, c, extra) => { if (c) pass++; else { fail++; console.error('  FAIL ' + label + (extra ? '\n    ' + extra : '')); } };
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`);

const APP = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const lift = (re, label) => { const m = APP.match(re); ok(label + ' found in app.js', !!m); return m ? m[0] : ''; };
const srcMerge = lift(/function mergeSessionOrder\(saved, list\) \{[\s\S]*?\n\}/, 'mergeSessionOrder');
const srcForWs = lift(/function orderForWs\(wsId\) \{.*\n?/, 'orderForWs');
const srcOrdered = lift(/function orderedSessionsFor\(wsId, list\) \{[\s\S]*?\n\}/, 'orderedSessionsFor');

// Real functions, stubbed prefs. loadPrefs is the ONLY dependency; savePrefs is a tripwire — the helper must
// never persist (only refreshSessions' setOrder does), so any call here is an instant failure.
function make(prefs) {
  const scope = new Function('loadPrefs', 'savePrefs', `
    ${srcMerge}\n${srcForWs}\n${srcOrdered}
    return { mergeSessionOrder, orderForWs, orderedSessionsFor };
  `);
  let saved = 0;
  const api = scope(() => prefs, () => { saved++; });
  return { ...api, saves: () => saved };
}

const S = (id, created, used) => ({ id, created, used, mtime: created });

// ---- parity: the three surfaces' inputs produce ONE order -------------------------------------------------
{
  const prefs = { 'wsOrder2_repo-a': ['s2', 's1'] };
  const { orderedSessionsFor, saves } = make(prefs);
  const list = [S('s1', 100, 900), S('s2', 200, 100), S('s3', 300, 500)];   // used order: s1,s3,s2 — saved order: s3(fresh),s2,s1
  const authoritative = orderedSessionsFor('repo-a', list).map((s) => s.id);
  const prefill = orderedSessionsFor('repo-a', list.slice().reverse()).map((s) => s.id);   // input order must not matter
  const tree = orderedSessionsFor('repo-a', list).slice(0, 60).map((s) => s.id);
  eq('authoritative order: fresh-by-created first, then the saved order', authoritative, ['s3', 's2', 's1']);
  eq('pre-fill parity (input order irrelevant)', prefill, authoritative);
  eq('tree parity (same order, capped)', tree, authoritative);
  ok('the OLD tree sort (used desc) would have differed — the glitch was real',
    JSON.stringify(list.slice().sort((a, b) => b.used - a.used).map((s) => s.id)) !== JSON.stringify(authoritative));
  eq('the helper never persists', saves(), 0);
}

// ---- a workspace never opened on this machine: no saved order → shared created-desc ------------------------
{
  const { orderedSessionsFor } = make({});
  const list = [S('old', 100, 999), S('new', 300, 1), S('mid', 200, 500)];
  eq('no saved order → created desc (same for every collaborator), NOT used desc',
    orderedSessionsFor('repo-b', list).map((s) => s.id), ['new', 'mid', 'old']);
}

// ---- the order is keyed to the REQUESTED workspace, never ambient state ------------------------------------
{
  const prefs = { 'wsOrder2_ws-A': ['a2', 'a1'], 'wsOrder2_ws-B': ['a1', 'a2'] };
  const { orderedSessionsFor } = make(prefs);
  const list = [S('a1', 100, 0), S('a2', 200, 0)];
  eq('ws-A uses ws-A’s saved order', orderedSessionsFor('ws-A', list).map((s) => s.id), ['a2', 'a1']);
  eq('ws-B uses ws-B’s saved order', orderedSessionsFor('ws-B', list).map((s) => s.id), ['a1', 'a2']);
}

// ---- robustness: saved ids that no longer exist are dropped; unknown fields tolerated ----------------------
{
  const { orderedSessionsFor } = make({ 'wsOrder2_w': ['gone', 's1', 'alsogone'] });
  eq('deleted ids in the saved order are skipped, not rendered as holes',
    orderedSessionsFor('w', [S('s1', 1, 0)]).map((s) => s.id), ['s1']);
  eq('empty list → empty order', orderedSessionsFor('w', []), []);
  eq('non-array input → empty order', orderedSessionsFor('w', null), []);
}

console.log(`\nsession-order: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
