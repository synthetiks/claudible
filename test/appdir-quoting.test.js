// test/appdir-quoting.test.js — the app's own install path may contain a single quote.
//
// An OS account name can legally contain an apostrophe (O'Brien, D'Angelo), so the app's install dir can be
// C:\Users\O'Brien\… . Every bash-backed runner interpolates that dir into a SINGLE-QUOTED bash argument:
//
//     bash '<appdir>/wsl/session.sh' '<appdir>'
//
// Raw, the apostrophe CLOSES the quote and bash re-parses the path as /home/OBrien/… — a directory that does not
// exist. Result: not a crash, not an error message — every session/workspace/diff/clone command silently pointed
// at nothing, and the only symptom the user saw was a generic "node-pty unavailable". Reproduced end to end.
//
// This is a BEHAVIOURAL test, deliberately, not a grep for `shq(`. A grep proves an escaper was CALLED; it cannot
// prove the escaper is CORRECT. So instead we build the real command with a real hostile path and hand it to a
// real bash, then assert the path bash actually receives is byte-identical to the one we put in. A wrong escaper
// fails this. A missing escaper fails this. A new interpolation site that forgets to escape fails this.

const assert = require('assert');
const cp = require('child_process');
const shared = require('../runners/_shared');

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  ✓ ' + name); pass++; };
const eq = (name, a, b) => { assert.strictEqual(a, b, `${name}\n    got:  ${JSON.stringify(a)}\n    want: ${JSON.stringify(b)}`); console.log('  ✓ ' + name); pass++; };

// win32: resolve a REAL bash (never the WSL interop launcher — see test/_bash-resolve.js); every other
// platform is untouched (BASH stays null, bashBin()/bashArgs() are 'bash'/identity).
const BASH = process.platform === 'win32' ? require('./_bash-resolve') : null;
const bashBin = () => (BASH ? BASH.resolve().bin : 'bash');
const bashArgs = (args) => (BASH ? BASH.toArgs(args) : args);

let HAS_BASH = true;
try { cp.execFileSync(bashBin(), bashArgs(['-c', 'true']), { stdio: 'ignore' }); } catch { HAS_BASH = false; }

console.log('\nrunners/_shared.js — the app dir survives bash intact\n');

// The paths that actually break things, plus the ordinary ones that must not regress.
const PATHS = [
  ['a plain path', '/home/daisy/claudible'],
  ['an apostrophe in the user name (the reported blocker)', "/home/O'Brien/claudible"],
  ['a WSL mount of a Windows profile with an apostrophe', "/mnt/c/Users/O'Brien/AppData/Local/Programs/claudible"],
  ['two apostrophes', "/home/O'B'rien/claudible"],
  ['a trailing apostrophe', "/home/daisy'/claudible"],
  ['a space (already worked — must not regress)', '/mnt/c/Program Files/claudible'],
  ['a space AND an apostrophe', "/mnt/c/Users/O'Brien/My Apps/claudible"],
];

// ---- shq itself: the escape is the POSIX one ('\'' closes, escapes, reopens) --------------------------------
eq('shq: leaves a quote-free string untouched', shared.shq('/home/daisy/claudible'), '/home/daisy/claudible');
eq("shq: turns ' into '\\'' ", shared.shq("O'Brien"), "O'\\''Brien");
eq('shq: escapes EVERY quote, not just the first', shared.shq("a'b'c"), "a'\\''b'\\''c");
eq('shq: null/undefined degrade to the empty string, never the literal "undefined"', shared.shq(undefined), '');

if (!HAS_BASH) {
  console.log('\n  (bash unavailable — skipped the round-trip leg)\n');
  console.log(`appdir-quoting: ${pass} passed\n`);
  return;
}

// ---- the round trip: what does bash ACTUALLY receive? ---------------------------------------------------------
// Run the built command with something standing in for `bash` that prints its argv instead of executing the
// script. That is the true test: not "did we call an escaper" but "did the path arrive intact at the other end".
const fs = require('fs');
const os = require('os');
const path = require('path');

// win32: reuse the same resolution as HAS_BASH above (never the WSL interop launcher); every other platform
// keeps the original POSIX candidate list untouched.
const REAL_BASH = BASH ? bashBin() : (['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'].find((b) => fs.existsSync(b)) || 'bash');

let argvSeenBy;
let shim = null;   // only the POSIX (PATH-shim) branch below creates one; cleaned up at the bottom
if (BASH) {
  // A PATH-prepended shim (the POSIX approach below) cannot win here: MSYS bash unconditionally re-prepends
  // its own /mingw64/bin:/usr/bin:… ahead of whatever PATH a caller supplies at every `-c` invocation (proven
  // empirically — not documented anywhere reachable), so a same-named file earlier in OUR prepended PATH still
  // loses to the real /usr/bin/bash MSYS puts back in front of it. A shell FUNCTION named `bash`, defined in
  // the same script, is not subject to that fixup: function lookup wins over PATH search regardless of what
  // PATH contains, so it intercepts the built command's own literal `bash '<path>' …` call cleanly.
  const FN = 'bash() { for a in "$@"; do printf "%s\\n" "$a"; done; }; ';
  argvSeenBy = (cmd) => cp.execFileSync(REAL_BASH, bashArgs(['-c', FN + cmd]), { encoding: 'utf8' }).split('\n').filter(Boolean);
} else {
  shim = fs.mkdtempSync(path.join(os.tmpdir(), 'claudible-shq-'));
  fs.writeFileSync(path.join(shim, 'bash'), '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n');
  fs.chmodSync(path.join(shim, 'bash'), 0o755);
  // Run `cmd` under a real bash whose PATH puts our argv-printing shim first, and return the argv the shim saw.
  // The OUTER bash is invoked by absolute path on purpose — resolving it through PATH would hit the shim itself.
  argvSeenBy = (cmd) => cp.execFileSync(REAL_BASH, ['-c', cmd], {
    encoding: 'utf8', env: Object.assign({}, process.env, { PATH: shim + ':' + process.env.PATH }),
  }).split('\n').filter(Boolean);
}

for (const [label, appdir] of PATHS) {
  // bootStr: `bash '<appdir>/wsl/session.sh' '<appdir>'` → the shim sees the script path, then the app dir.
  const boot = argvSeenBy(shared.bootStr(appdir, '', null, 'default', 'default', 'default'));
  eq(`bootStr — session.sh path arrives intact (${label})`, boot[0], appdir + '/wsl/session.sh');
  eq(`bootStr — the appdir ARGUMENT arrives intact (${label})`, boot[1], appdir);

  // scriptCmd: every workspace/diff/sync/clone command in the app goes through this one builder.
  const script = argvSeenBy(shared.scriptCmd(appdir, 'diff.sh'));
  eq(`scriptCmd — script path arrives intact (${label})`, script[0], appdir + '/wsl/diff.sh');

  // scriptCmd with an arg tail + a workspace env prefix — the shape main.js actually uses.
  const withArgs = argvSeenBy(shared.scriptCmd(appdir, 'sessions-sync.sh', "'push'", { ws: { kind: 'repo', slug: 'demo' } }));
  eq(`scriptCmd — path intact even with an env prefix and args (${label})`, withArgs[0], appdir + '/wsl/sessions-sync.sh');
  eq(`scriptCmd — the arg tail still arrives (${label})`, withArgs[1], 'push');
}

// The command must be ONE bash word per argument — an unescaped quote would split the path into several.
const hostile = argvSeenBy(shared.scriptCmd("/home/O'Brien/claudible", 'diff.sh'));
eq('a hostile appdir yields exactly ONE argv entry (not a path split into shell words)', hostile.length, 1);
ok('…and it contains the apostrophe, rather than having silently dropped it', hostile[0].includes("O'Brien"));

if (shim) { try { fs.rmSync(shim, { recursive: true, force: true }); } catch {} }

console.log(`\nappdir-quoting: ${pass} passed\n`);
