// test/prefs-bound.test.js — `sessionTitles` / `sessionTitleTs` are PERSISTED to settings.json, and nothing ever
// removed a key: not on session delete, not on workspace delete. Every session ever renamed (locally, or by a
// collaborator's newest-wins reconcile) left a permanent entry. Slow, but it never shrinks.
//
// renderer/app.js can't be require()'d (it needs a browser + the preload bridge), and a hand-copied re-implementation
// of the trim would be free to drift from the shipped one. So this lifts the ACTUAL functions out of the source and
// runs THEM — the same pattern share-names.test.js uses to exercise the real GITHUB_REMOTE regex.
// Run: node test/prefs-bound.test.js
'use strict';
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'renderer/app.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (label, c) => c ? pass++ : (fail++, console.error('  FAIL ' + label));
const eq = (label, got, want) => ok(`${label} (got ${JSON.stringify(got)})`, got === want);

// Lift the shipped source of the cap + the two functions under test.
function lift(name) {
  const re = new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`);
  const m = APP.match(re);
  if (!m) throw new Error(`could not lift ${name}() from renderer/app.js`);
  return m[0];
}
const capLine = (APP.match(/const MAX_TITLE_PREFS = \d+;/) || [])[0];
ok('MAX_TITLE_PREFS is declared in the shipped source', !!capLine);
const MAX = Number((capLine || '').match(/\d+/)[0]);
ok('…and is a sane bound', MAX >= 50 && MAX <= 5000);

// Build a scope with a savePrefs stub + a loadPrefs stub, then hand back the REAL functions.
let saved = null;
let store = {};
const make = () => new Function(
  'savePrefs', 'loadPrefs', 'MAX_TITLE_PREFS', '_wsSessCache',
  `${lift('saveSessionTitles')}\n${lift('forgetSessionTitle')}\n${lift('forgetWorkspaceCaches')}\n` +
  'return { saveSessionTitles, forgetSessionTitle, forgetWorkspaceCaches };'
)(
  (patch) => { saved = patch; Object.assign(store, patch); },
  () => store,
  MAX,
  new Map(),
);
const fn = make();

// ---- the cap: only the NEWEST MAX survive, chosen by the ts map that already exists -------------------------
{
  const titles = {}, ts = {};
  for (let i = 0; i < MAX + 100; i++) { titles['s' + i] = 'name' + i; ts['s' + i] = 1000 + i; }   // s0 oldest … newest last
  fn.saveSessionTitles(titles, ts);
  eq('the cap trims to exactly MAX entries', Object.keys(saved.sessionTitles).length, MAX);
  eq('…and the timestamp map is trimmed in lockstep', Object.keys(saved.sessionTitleTs).length, MAX);
  ok('…the newest survives', 's' + (MAX + 99) in saved.sessionTitles);
  ok('…the oldest is evicted', !('s0' in saved.sessionTitles));
  ok('…no evicted id lingers in the ts map', !('s0' in saved.sessionTitleTs));
}
// under the cap, nothing is touched
{
  const titles = { a: 'A', b: 'B' }, ts = { a: 2, b: 1 };
  fn.saveSessionTitles(titles, ts);
  eq('under the cap, every entry is kept', Object.keys(saved.sessionTitles).length, 2);
}
// a missing ts sorts as oldest (0) rather than throwing
{
  const titles = {}, ts = {};
  for (let i = 0; i < MAX; i++) { titles['k' + i] = 'n'; ts['k' + i] = 5000 + i; }
  titles.noTs = 'orphan';                                        // no ts entry at all
  fn.saveSessionTitles(titles, ts);
  eq('an entry with no timestamp is treated as oldest and evicted first', 'noTs' in saved.sessionTitles, false);
  eq('…and the cap still holds', Object.keys(saved.sessionTitles).length, MAX);
}

// ---- explicit eviction: a deleted session's id can never recur ----------------------------------------------
{
  store = { sessionTitles: { keep: 'K', doomed: 'D' }, sessionTitleTs: { keep: 1, doomed: 2 } };
  saved = null;
  fn.forgetSessionTitle('doomed');
  ok('deleting a session drops its title', saved && !('doomed' in saved.sessionTitles));
  ok('…and its timestamp', saved && !('doomed' in saved.sessionTitleTs));
  ok('…while leaving the others', saved && saved.sessionTitles.keep === 'K');
}
{
  store = { sessionTitles: { keep: 'K' }, sessionTitleTs: { keep: 1 } };
  saved = null;
  fn.forgetSessionTitle('never-existed');
  ok('forgetting an unknown id writes nothing at all', saved === null);
}

// ---- workspace caches ----------------------------------------------------------------------------------------
{
  store = { remoteTitlesCache: { 'repo-a': { s: 'x' }, 'repo-b': { s: 'y' } } };
  saved = null;
  fn.forgetWorkspaceCaches('repo-a');
  ok('deleting a workspace drops its warm title cache', saved && !('repo-a' in saved.remoteTitlesCache));
  ok('…and keeps the others', saved && 'repo-b' in saved.remoteTitlesCache);
}
{
  store = { remoteTitlesCache: { 'repo-b': {} } };
  saved = null;
  fn.forgetWorkspaceCaches('repo-a');
  ok('a workspace with no cached titles writes nothing', saved === null);
}

// ---- the wiring: the three title write sites must go through the bounded helper ------------------------------
ok('no raw savePrefs({ sessionTitles … }) outside the two helpers',
  (APP.match(/savePrefs\(\{ sessionTitles/g) || []).length === 2);   // saveSessionTitles + forgetSessionTitle
ok('deleteSession evicts the deleted id', /forgetSessionTitle\(id\);/.test(APP));
ok('deleteWorkspace evicts its caches', /forgetWorkspaceCaches\(w\.id\);/.test(APP));

console.log(`prefs-bound: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
