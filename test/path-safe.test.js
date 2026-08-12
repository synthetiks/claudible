// test/path-safe.test.js — lib/pathSafe.js, the one predicate guarding every filesystem path that crosses
// into a bash argument and comes back out through a script's JSON.
//
// The whole point is the boundary between "unusual but legal" and "unusable". A path with a space, a unicode
// name, a dash, a dot must pass — rejecting those would lock users out of their own folders. A path with a
// quote, a backslash or a raw control byte must fail — those corrupt the shell arg or the JSON, and by the time
// the app notices, the folder is already on disk. Run: node test/path-safe.test.js
'use strict';
const { isSafePath, safePath, PATH_UNSAFE_MSG, isContainedPath, PATH_TRAVERSAL_MSG } = require('../lib/pathSafe.js');

let pass = 0, fail = 0;
function is(label, got, want) { if (got === want) pass++; else { fail++; console.error(`  FAIL ${label}\n    got: ${got}  want: ${want}`); } }
const CTRL = (n) => String.fromCharCode(n);

// ---- must be ALLOWED: real paths people really have -------------------------------------------------------
const ALLOWED = [
  '/home/niburu/.claudible/repos/MK-Crazy',
  '/mnt/c/Users/Micha/My Projects/claudible',      // spaces — the most common "unusual" path
  'C:/Users/Micha/claudible',                       // the win runner's mixed form
  '/home/a/proj-with-dashes',
  '/home/a/proj.with.dots',
  '/home/a/proj_with_underscores',
  '/home/üñîçø∂é/prøject',                          // non-ASCII: legal everywhere, must survive
  '/home/a/日本語',
  '/home/a/(parens) [brackets] {braces}',
  '/home/a/dollar$sign',                            // safe: single-quoted in bash, plain in JSON
  '/home/a/back`tick',                              // ditto — no command substitution inside single quotes
  '/home/a/semi;colon & pipe|',
  '/home/a/star*glob?',
  '/home/a/newline-ish\\\\n-as-literal-text'.replace(/\\\\/g, 'X'),   // the two chars X,n — not a control byte
];
for (const p of ALLOWED) is(`allow ${JSON.stringify(p)}`, isSafePath(p), true);

// ---- must be REJECTED: each one breaks the shell arg or the JSON ------------------------------------------
is("reject single quote (ends the bash quote)", isSafePath("/home/a'b/proj"), false);
is('reject double quote (ends the JSON string)', isSafePath('/home/a"b/proj'), false);
is('reject backslash (starts a JSON escape)', isSafePath('/home/a\\b/proj'), false);
is('reject newline (raw control in a JSON string)', isSafePath('/home/a' + CTRL(10) + 'b'), false);
is('reject carriage return', isSafePath('/home/a' + CTRL(13) + 'b'), false);
is('reject tab', isSafePath('/home/a' + CTRL(9) + 'b'), false);
is('reject NUL', isSafePath('/home/a' + CTRL(0) + 'b'), false);
is('reject ESC (would also inject terminal escapes)', isSafePath('/home/a' + CTRL(27) + '[31m'), false);
is('reject DEL', isSafePath('/home/a' + CTRL(127) + 'b'), false);
is('reject the boundary control byte 0x1f', isSafePath('/home/a' + CTRL(31) + 'b'), false);
is('ALLOW the byte just past it, 0x20 (space)', isSafePath('/home/a' + CTRL(32) + 'b'), true);

// `\b` is the trap that does NOT throw: JSON.parse turns "a\b" into a backspace, silently yielding a path
// that is not the one on disk. Prove both halves — that we reject it, and why.
is('reject a path whose JSON escape would PARSE, wrongly', isSafePath('/home/a\\b/proj'), false);
is('…and that is not paranoia: JSON.parse mangles it', JSON.parse('"/home/a\\b/proj"'), '/home/a\b/proj');

// ---- non-strings and empties ------------------------------------------------------------------------------
for (const v of [null, undefined, 0, 123, {}, [], true, '']) is(`reject ${JSON.stringify(v) ?? String(v)}`, isSafePath(v), false);

// ---- safePath() is the '' -> "use the default / refuse" adapter every call site expects --------------------
is('safePath passes a good path through', safePath('/home/a/b'), '/home/a/b');
is('safePath blanks a bad path', safePath("/home/a'b"), '');
is('safePath blanks a non-string', safePath(null), '');
is('safePath blanks empty', safePath(''), '');

// ---- the message the user sees names what is wrong --------------------------------------------------------
is('message mentions the quote', /quote/.test(PATH_UNSAFE_MSG), true);
is('message mentions the backslash', /backslash/.test(PATH_UNSAFE_MSG), true);
is('message is a sentence, so humanError() passes it through verbatim', /\s/.test(PATH_UNSAFE_MSG), true);

// ---- the round-trip this predicate exists to protect -------------------------------------------------------
// Simulate exactly what create-workspace.sh does: printf '{"path":"%s"}' "$dir", then JSON.parse it.
const roundTrips = (p) => { try { return JSON.parse(`{"path":"${p}"}`).path === p; } catch { return false; } };
for (const p of ALLOWED) is(`round-trips through the script's printf: ${JSON.stringify(p)}`, roundTrips(p), true);
for (const p of ["/home/a'b", '/home/a"b', '/home/a\\b', '/home/a' + CTRL(10) + 'b']) {
  // a `'` round-trips through JSON fine — it breaks the SHELL, not the JSON. The predicate covers both.
  is(`rejected by the predicate: ${JSON.stringify(p)}`, isSafePath(p), false);
}
is('the double quote genuinely breaks the round-trip', roundTrips('/home/a"b'), false);
is('the newline genuinely breaks the round-trip', roundTrips('/home/a' + CTRL(10) + 'b'), false);
is('the backslash silently CORRUPTS the round-trip (no throw)', roundTrips('/home/a\\b'), false);

// ---- isContainedPath — isSafePath AND absolute AND no '.'/'..' segment -----------------------------------
// Defense-in-depth against a hand-edited workspaces.json. Custom save locations are a real feature: this is
// NOT "under a fixed root" — it's "a real absolute path with no traversal segments".
for (const p of ['C:/work/proj', '/home/u/proj']) is(`isContainedPath allows ${JSON.stringify(p)}`, isContainedPath(p), true);
for (const p of ['relative/x', 'C:/a/../b', '../x', '/a/./b']) is(`isContainedPath rejects ${JSON.stringify(p)}`, isContainedPath(p), false);
// existing isSafePath behavior is untouched by isContainedPath's existence
for (const p of ALLOWED) is(`isSafePath unaffected by isContainedPath for ${JSON.stringify(p)}`, isSafePath(p), true);
is('PATH_TRAVERSAL_MSG is a sentence', /\s/.test(PATH_TRAVERSAL_MSG), true);

console.log(`\npath-safe: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
