// test/ps1-ascii.test.js — every tracked PowerShell script, AND every setup/*.sh script, must be pure
// ASCII (and BOM-free stays fine).
//
// WHY THIS GATE EXISTS (v0.9.1 smoke, 2026-07-31): Windows PowerShell 5.1 reads a BOM-less .ps1 as the
// system ANSI codepage, NOT UTF-8. An em dash in a double-quoted string in setup-win.ps1 decoded as
// cp1252 bytes ending in 0x94 = a CURLY CLOSING QUOTE — which PowerShell treats as a real quote
// terminator. The string ended mid-line, the parser's quote state flipped for the rest of the file, and
// every packaged/native install died at parse ("The string is missing the terminator") before installing
// voice. The WSL flavor never executes these files and no linter in CI parses .ps1, so it shipped silently.
// ASCII-only makes the decode identical under every codepage, which is the whole fix.
//
// setup/*.sh (C-7.5) GETS THE SAME GATE, for a different but related reason: it is setup.sh's job to stay
// a byte-for-byte mirror of setup-win.ps1's behavior on the posix/WSL side, and setup.sh had accumulated
// its own em dashes/ellipses (harmless to bash, which is UTF-8-agnostic at the byte level for comments —
// but a silent asymmetry with the file it mirrors is exactly the kind of drift this whole gate exists to
// catch before it becomes two scripts that quietly disagree). Scanning setup/*.sh costs nothing and closes
// that gap.
// Run: node test/ps1-ascii.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (label, c) => { c ? pass++ : (fail++, console.error('  FAIL ' + label)); };

// git-tracked .ps1 only (node_modules ships third-party scripts we don't own)
const files = execSync('git ls-files "*.ps1"', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
ok('the repo actually tracks PowerShell scripts (empty list = this gate is dead)', files.length >= 4);

// setup/*.sh — the posix/WSL half of the same setup pair; git-tracked only, same reasoning as above.
const setupShFiles = execSync('git ls-files "setup/*.sh"', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
ok('the repo actually tracks setup/*.sh scripts (empty list = this gate is dead)', setupShFiles.length >= 1);

function checkAscii(rel) {
  const buf = fs.readFileSync(path.join(ROOT, rel));
  const bad = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] > 0x7f) {
      // report the line number of the first few offenders so the failure is fixable without a hexdump
      if (bad.length < 3) bad.push('line ' + (buf.slice(0, i).toString('utf8').split('\n').length) + ' byte 0x' + buf[i].toString(16));
      else break;
    }
  }
  return bad;
}

for (const rel of files) {
  const bad = checkAscii(rel);
  ok(`${rel} is pure ASCII (PS 5.1 decodes BOM-less files as ANSI; smart punctuation can become QUOTES)` +
    (bad.length ? ` -> ${bad.join(', ')}` : ''), bad.length === 0);
}

for (const rel of setupShFiles) {
  const bad = checkAscii(rel);
  ok(`${rel} is pure ASCII (mirrors setup-win.ps1's gate -- no non-ASCII drift between the two setup halves)` +
    (bad.length ? ` -> ${bad.join(', ')}` : ''), bad.length === 0);
}

console.log(`ps1-ascii: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
