// test/last-json-line.test.js — lib/lastJsonLine.js, the banner-proof script-result extractor.
// The defect it exists for: runScript wraps every wsl/ script in `bash -lc` — a LOGIN shell — so whatever a
// user's profile prints (nvm's "Now using node v22", conda's activation notice, a corporate MOTD) lands in
// stdout ABOVE the script's single JSON result line. The old bare JSON.parse threw on the banner, and the
// SyntaxError's own text became the "install error" the onboarding wizard displayed.
// Run: node test/last-json-line.test.js
'use strict';
const assert = require('assert');
const { lastJsonLine } = require('../lib/lastJsonLine.js');

let pass = 0;
const FB = { ok: false, error: 'no output' };
function eq(label, a, b) { assert.deepStrictEqual(a, b, label); pass++; }

// the clean case — exactly what every wsl/ script emits
eq('a bare JSON line parses', lastJsonLine('{"ok":true,"version":"2.1.0"}', FB), { ok: true, version: '2.1.0' });
eq('surrounding whitespace/newlines are fine', lastJsonLine('\n  {"ok":true}  \n\n', FB), { ok: true });

// the defect case — profile banners above the result
eq('an nvm banner above the result is ignored',
  lastJsonLine('Now using node v22.12.0 (npm v10.9.0)\n{"ok":true}', FB), { ok: true });
eq('a multi-line corporate MOTD above the result is ignored',
  lastJsonLine('*** AUTHORIZED USE ONLY ***\nThis system is monitored.\n\n{"ok":false,"error":"npm said: EACCES"}', FB),
  { ok: false, error: 'npm said: EACCES' });
eq('banner text BELOW the result loses to the result (scan is from the end, first JSON wins)',
  lastJsonLine('{"ok":true}\ngoodbye from .bash_logout', FB), { ok: true });

// the LAST JSON line is the verdict — a script that echoed progress objects reports its final state
eq('with several JSON lines, the last one wins',
  lastJsonLine('{"step":1}\n{"step":2}\n{"ok":true,"done":true}', FB), { ok: true, done: true });

// arrays are results too (transcript/list scripts)
eq('a JSON array line is a valid result', lastJsonLine('noise\n[1,2,3]', FB), [1, 2, 3]);

// things that must NOT be mistaken for a result
eq('a parseable SCALAR line (a stray "0" from a profile) is not a result', lastJsonLine('0\ntrue\n"str"', FB), FB);
eq('a banner line that merely CONTAINS braces is not a result', lastJsonLine('usage: foo {a|b}', FB), FB);
eq('a TRUNCATED JSON line (maxBuffer cut) falls through to the fallback', lastJsonLine('{"ok":true,"err', FB), FB);
eq('empty input → fallback', lastJsonLine('', FB), FB);
eq('null input → fallback', lastJsonLine(null, FB), FB);
eq('pure banner, no JSON at all → fallback', lastJsonLine('Welcome to Ubuntu 24.04 LTS\n', FB), FB);

// the fallback is returned AS GIVEN (callers pass their own shape)
eq('the fallback object is the caller’s, verbatim', lastJsonLine('nope', { ok: false, error: 'x' }), { ok: false, error: 'x' });

console.log(`last-json-line: ${pass} passed, 0 failed`);
