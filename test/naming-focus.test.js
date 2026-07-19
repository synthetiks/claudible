// test/naming-focus.test.js — guards "typing into a rename/name box can never be silently stolen or destroyed".
//
// ROOT CAUSE (2026-07-19, agent audit): the renderer had ~15 independent deferred `term.focus()` timers
// (0-350ms) — boot, closing the drawer/agents view, command pills, git commands, workspace switches, wizard
// finish. Every naming/rename input is ALSO focused via its own short timer (30/60ms), so whichever timer's
// real fire time landed last won the keyboard. Open a "Name this session" prompt or a rename right after an
// action that scheduled a terminal-refocus, and keystrokes silently went to the terminal — the intermittent
// "the field won't let me type" bug (an old 50ms hold-focus loop fought the same disease until bbad946
// removed it). Separately, two sidebar repaint paths could DESTROY an open rename input mid-typing.
//
// The fix, pinned here:
//   1. typingElsewhere() + focusTermSoon(): every deferred terminal-focus routes through one guard that
//      refuses to steal while a modal (.back / .approve.show) is open or a real text field has the keyboard.
//   2. modalPrompt's input reclaims focus if it lands in the terminal while the prompt is still open.
//   3. (commit B) the sidebar repaint paths bail while a rename input is open — pinned once those land.
//
// Source-guard style (matches tab-focus.test.js). Run: node test/naming-focus.test.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (label, c) => c ? pass++ : (fail++, console.error('  FAIL ' + label));

// ---- 1. the guard exists and is the ONLY way a deferred terminal-focus fires ----
ok('typingElsewhere() is defined', /function typingElsewhere\(\)/.test(APP));
ok('typingElsewhere treats an open modal as typing', /querySelector\('\.back, \.approve\.show'\)/.test(APP));
ok("typingElsewhere excludes xterm's own hidden textarea", /!ae\.closest\('\.xterm'\)/.test(APP));
ok('focusTermSoon() is defined and guarded', /function focusTermSoon\(ms\) \{ setTimeout\(\(\) => \{ try \{ if \(term && !typingElsewhere\(\)\) term\.focus\(\);/.test(APP));

// No bare deferred term.focus() may exist outside the helper — a bare timer is the regression.
const bare = APP.split('\n').filter((l) => /setTimeout\(.*term\.focus\(\)/.test(l) && !/typingElsewhere/.test(l));
ok('every deferred term.focus routes through focusTermSoon (found: ' + bare.length + ' bare)', bare.length === 0);

// The discipline is actually in use across the renderer, not just defined.
const uses = (APP.match(/focusTermSoon\(/g) || []).length - 1;   // minus the definition
ok('focusTermSoon is used at 12+ call sites (found ' + uses + ')', uses >= 12);

// Synchronous terminal-focus sites are guarded too (setActiveTab + live-hello).
ok('no unguarded synchronous rec.term.focus on the hello/setActiveTab paths',
  !APP.split('\n').some((l) => /rec\.term\.focus\(\)/.test(l) && !/typingElsewhere/.test(l)));

// ---- 2. sidebar repaints defer while a rename is being typed ----
const nasStart = APP.indexOf('function renderWsNonActiveSessions(');
ok('renderWsNonActiveSessions found', nasStart >= 0);
ok('non-active tree fill() defers while a rename is open in its subtree',
  /kids\.querySelector\('\.sess-rename'\)\) return;/.test(APP.slice(nasStart, nasStart + 2500)));
const rwcStart = APP.indexOf('function renderWsChips(');
ok('renderWsChips found', rwcStart >= 0);
ok('renderWsChips structural rebuild defers while any rename is open',
  /el\.querySelector\('\.sess-rename, \.ws-rename'\)\) return;/.test(APP.slice(rwcStart, rwcStart + 2000)));
// The active list's own long-standing guards must stay (before AND after its await).
ok('refreshSessions keeps its pre-await rename guard', (APP.match(/sessListEl\.querySelector\('\.sess-rename'\)\) return;/g) || []).length >= 2);

// ---- 3. modalPrompt self-heals a stolen keyboard ----
const mpStart = APP.indexOf('function modalPrompt(');
ok('modalPrompt found', mpStart >= 0);
const mpBody = APP.slice(mpStart, mpStart + 4000);
ok('modalPrompt input reclaims focus from the terminal while open', /inp\.addEventListener\('blur',[\s\S]{0,220}closest\('\.xterm'\)[\s\S]{0,40}inp\.focus\(\)/.test(mpBody));

console.log(`naming-focus: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
