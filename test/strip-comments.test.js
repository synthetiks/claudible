// test/strip-comments.test.js — guards the comment stripper the static pins are built on
// (test/_strip-comments.js). This file exists because the failure it prevents is INVISIBLE: a pin
// that cannot find its pattern still reports PASS whenever it asserts an absence, so a stripper that
// quietly eats code turns a wall of guards into decoration and the suite still says everything is
// fine. Run: node test/strip-comments.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { stripComments, assertStripSane, stripCode } = require('./_strip-comments.js');

let pass = 0, fail = 0;
function eq(label, a, b) { try { assert.deepStrictEqual(a, b); pass++; } catch { fail++; console.error(`  FAIL ${label}\n    got: ${JSON.stringify(a)}\n    exp: ${JSON.stringify(b)}`); } }
function ok(label, c) { c ? pass++ : (fail++, console.error('  FAIL ' + label)); }
const has = (s, t) => s.indexOf(t) !== -1;

// ---- the regression, first and by name ----
// A glob inside a LINE comment is not the start of a block comment. The old two-regex stripper read
// it as one, found no terminator, and lay dormant until somebody added a real /* … */ below it —
// whereupon everything between them vanished.
const REGRESSION = [
  "const script = path.join(__dirname, 'setup', 'setup-win.ps1');   // shipped in the bundle (asar:false, setup/** included)",
  'const KEEP_ME = 1;',
  'function alsoKeepMe() { return 2; }',
  '/* an ordinary block comment, added months later */',
  'const AND_ME = 3;',
].join('\n');
const stripped = stripComments(REGRESSION);
ok('a /* inside a line comment does not open a block comment', has(stripped, 'KEEP_ME'));
ok('…and the code after the later real block comment survives too', has(stripped, 'AND_ME'));
ok('…and the function between them survives', has(stripped, 'alsoKeepMe'));
ok('the real block comment is still removed', !has(stripped, 'an ordinary block comment'));
ok('the line comment is still removed', !has(stripped, 'shipped in the bundle'));
ok('the code on the line comment’s own line survives', has(stripped, 'setup-win.ps1'));

// ---- ordinary comment removal still works ----
eq('a bare line comment goes, leaving its newline behind', stripComments('a\n// gone\nb').replace(/\n+/g, '\n'), 'a\nb');
eq('…and the newline really is still there before collapsing', stripComments('a\n// gone\nb'), 'a\n\nb');
ok('a trailing line comment goes but its code stays', has(stripComments('const a = 1; // gone'), 'const a = 1;') && !has(stripComments('const a = 1; // gone'), 'gone'));
ok('a block comment goes', !has(stripComments('a /* gone */ b'), 'gone'));
ok('a multi-line block comment goes', !has(stripComments('a\n/* gone\nstill gone */\nb'), 'still gone'));
ok('code either side of a block comment survives', has(stripComments('keepA /* gone */ keepB'), 'keepA') && has(stripComments('keepA /* gone */ keepB'), 'keepB'));

// ---- literals are never mistaken for comments ----
ok('a url in a string survives', has(stripComments("const u = 'https://example.com/x';"), 'https://example.com/x'));
ok('a url in a double-quoted string survives', has(stripComments('const u = "https://example.com/y";'), 'https://example.com/y'));
ok('a url in a template literal survives', has(stripComments('const u = `https://example.com/z`;'), 'https://example.com/z'));
ok('a comment marker inside a string is not a comment', has(stripComments("const s = 'a // b';"), 'a // b'));
ok('a block marker inside a string is not a comment', has(stripComments("const s = 'a /* b */ c';"), 'a /* b */ c'));
ok('an escaped quote does not end the string early', has(stripComments("const s = 'it\\'s // fine'; const after = 1;"), 'after'));
ok('a glob in a string survives', has(stripComments("const g = 'setup/**';"), 'setup/**'));

// ---- regex literals are code, not comments ----
ok('a regex containing a slash survives', has(stripComments('const r = /a\\/b/;'), 'a\\/b'));
ok('a regex containing a comment marker survives', has(stripComments('const r = /\\/\\*/;'), '/\\/\\*/'));
ok('a character class containing a slash survives', has(stripComments('const r = /[/]/; const after = 1;'), 'after'));
ok('division is not read as a regex', has(stripComments('const q = a / b; const after = 1;'), 'after'));
ok('a regex after return survives', has(stripComments('function f() { return /x\\/y/.test(s); }'), 'x\\/y'));

// ---- unterminated things must not swallow the file ----
ok('an unterminated string stops at the newline', has(stripComments("const s = 'oops\nconst after = 1;"), 'after'));
ok('an unterminated regex is treated as division', has(stripComments('const q = a / b\nconst after = 1;'), 'after'));

// ---- the backstop ----
let threw = false;
try { assertStripSane('x'.repeat(10000), 'x'.repeat(100), 'fake.js'); } catch (e) { threw = /removed 9\d% of fake\.js/.test(e.message); }
ok('assertStripSane throws when most of the file disappeared', threw);
let quiet = true;
try { assertStripSane('x'.repeat(10000), 'x'.repeat(9000), 'fake.js'); } catch { quiet = false; }
ok('assertStripSane is silent for a normal strip', quiet);
let smallOk = true;
try { assertStripSane('short', '', 'tiny.js'); } catch { smallOk = false; }
ok('assertStripSane ignores tiny inputs (a fixture is not a corpus)', smallOk);

// ---- and against the real files the pins actually read ----
const ROOT = path.resolve(__dirname, '..');
for (const rel of ['main.js', 'renderer/app.js']) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  let out = '';
  let ok1 = true;
  try { out = stripCode(src, rel); } catch (e) { ok1 = false; console.error('  ' + e.message); }
  ok(rel + ': strips without tripping the backstop', ok1);
  ok(rel + ': keeps most of the file', out.length > src.length * 0.4);
  ok(rel + ': removes something (there ARE comments in there)', out.length < src.length);
}
// The specific line that caused all this, checked against the live file rather than a fixture.
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
if (has(MAIN, 'setup/**')) {
  const nc = stripComments(MAIN);
  ok('main.js: the glob line no longer eats the rest of the file', nc.length > MAIN.length * 0.4);
} else {
  console.log('  note: main.js no longer contains the setup/** glob — the live-file check is moot');
  pass++;
}

console.log(`strip-comments: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
