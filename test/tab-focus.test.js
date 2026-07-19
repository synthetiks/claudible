// test/tab-focus.test.js — guards the "spacebar reaches the terminal" invariants.
//
// ROOT CAUSE (2026-07-19): xterm 5.5.0 delivers Space (keyCode 32) ONLY via the native `keypress` event —
// every other typable character is sent straight from its own keydown handler. A `keypress` fires only if the
// paired keydown's default was not prevented AND the keydown actually reached the terminal's textarea. The
// sidebar session/tab rows are role="button" tabIndex=0 divs; a real <button> gets native Space-activation for
// free, a div does not. So right after a session switch — while the just-clicked row still holds DOM focus and
// before setActiveTab's deferred term.focus() runs — a Space keydown landed on the row, hit no handler (rows
// only wired Enter), and fell through to the browser default: scrolling the sidebar. Net symptom: "letters type,
// spacebar does nothing." Two fixes, both pinned here:
//   A. every row-activation keydown handler accepts Enter AND Space.
//   B. setActiveTab focuses the terminal synchronously (not only via setTimeout), closing the race window.
// Also pins the M-1 push-to-talk invariant: a PTT rebind can never persist as a typing key (Space/Enter/…),
// which is the historical spacebar-eater (commit d2b27ab0).
//
// Source-guard style (matches tabs-share.test.js): the renderer is one non-modular script, so we pin the real
// source shape — a refactor that drops Space handling or the sync focus fails here instead of silently drifting.
// Run: node test/tab-focus.test.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (label, c) => c ? pass++ : (fail++, console.error('  FAIL ' + label));

// ---- A. every role=button sidebar row activates on Enter AND Space ----
// The three row-activation call shapes (setActiveTab from a live/joined tab row, openSession from a session row,
// go() from a ws session row). Each must fire on both keys; an Enter-only match is the regression.
const rowActions = [
  { label: 'live/joined-tab row → setActiveTab', re: /keydown'.*setActiveTab\(rec\.tabId\)/g },
  { label: 'session row → openSession',          re: /keydown'.*openSession\(s\.id/g },
  { label: 'ws-session row → go()',              re: /keydown'.*\bgo\(\);/g },
];
for (const { label, re } of rowActions) {
  const lines = APP.split('\n').filter((l) => re.test(l));
  ok(label + ' handler exists', lines.length > 0);
  for (const l of lines) {
    ok(label + " accepts Enter", /e\.key === 'Enter'/.test(l));
    ok(label + " accepts Space", /e\.key === ' '/.test(l));
  }
}

// No row-activation handler may be Enter-only. Catch any future row that calls one of the three actions from a
// keydown that tests Enter but not Space.
const enterOnlyRow = APP.split('\n').filter((l) =>
  /row\.addEventListener\('keydown'/.test(l) &&
  /(setActiveTab\(rec\.tabId\)|openSession\(s\.id|\bgo\(\);)/.test(l) &&
  /e\.key === 'Enter'/.test(l) && !/e\.key === ' '/.test(l));
ok('no Enter-only row-activation handler remains', enterOnlyRow.length === 0);

// ---- B. setActiveTab focuses the terminal synchronously, not only via setTimeout ----
const saStart = APP.indexOf('function setActiveTab(');
ok('setActiveTab found', saStart >= 0);
const saBody = APP.slice(saStart, APP.indexOf('\n}', saStart));
const syncFocusIdx = saBody.search(/\bterm\.focus\(\)/);       // rec.term.focus() called directly (guarded by typingElsewhere)
const deferFocusIdx = saBody.search(/focusTermSoon\(0\)/);     // the deferred fallback routes through the shared guard
ok('setActiveTab focuses the terminal synchronously', syncFocusIdx >= 0);
ok('the synchronous focus is typing-guarded (never steals from a modal/text field)', /typingElsewhere\(\)\) rec\.term\.focus\(\)/.test(saBody));
ok('setActiveTab keeps a deferred focus as fallback', deferFocusIdx >= 0);
ok('the synchronous focus runs before the deferred one', syncFocusIdx >= 0 && deferFocusIdx >= 0 && syncFocusIdx < deferFocusIdx);

// ---- M-1. a PTT rebind can never persist as a typing key (the historical spacebar-eater) ----
ok('PTT_SAFE regex excludes Space', /const PTT_SAFE =/.test(APP) && !/Space/.test((APP.match(/const PTT_SAFE = [^\n]*/) || [''])[0]));
ok('PTT rebind rejects non-safe keys', /if \(!isSafePttKey\(e\.code\)\)/.test(APP));
ok('PTT swallow re-checks isSafePttKey (defense in depth)', /e\.code === pttKey && isSafePttKey\(pttKey\)/.test(APP));
ok('pref load self-heals a bad saved pttKey', /if \(isSafePttKey\(p\.pttKey\)\) pttKey = p\.pttKey; else savePrefs\(\{ pttKey: 'AltLeft' \}\)/.test(APP));

console.log(`tab-focus: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
