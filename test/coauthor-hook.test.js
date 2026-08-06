// test/coauthor-hook.test.js — integration-tests lib/coauthorHook.js (C-10.6) against a plain throwaway
// directory standing in for a repo's real `.git/hooks`. Covers the load-bearing guarantee: a pre-existing
// FOREIGN hook is never clobbered — it's backed up once and chained to, and uninstall restores it byte-exact.
// Run: node test/coauthor-hook.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ch = require('../lib/coauthorHook.js');

let pass = 0, fail = 0;
function ok(label, c) { c ? pass++ : (fail++, console.error('  FAIL ' + label)); }
function eq(label, a, b) { try { assert.strictEqual(a, b); pass++; } catch { fail++; console.error(`  FAIL ${label}\n    got: ${JSON.stringify(a)}\n    exp: ${JSON.stringify(b)}`); } }

const mkHooksDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cl-coauth-'));
const hookFile = (d) => path.join(d, 'prepare-commit-msg');
const backupFile = (d) => hookFile(d) + '.pre-claudible';

// --- fresh install: no pre-existing hook ---
{
  const d = mkHooksDir();
  const r = ch.install(d);
  ok('fresh install ok', r.ok === true);
  eq('fresh install is not chained (nothing to chain to)', r.chained, false);
  ok('hook file exists', fs.existsSync(hookFile(d)));
  ok('hook file carries the marker', fs.readFileSync(hookFile(d), 'utf8').includes(ch.MARKER));
  ok('no backup file was created', !fs.existsSync(backupFile(d)));

  // uninstall with nothing to restore -> deletes our own file
  const u = ch.uninstall(d);
  ok('uninstall ok', u.ok === true);
  eq('uninstall reports nothing restored (fresh install)', u.restored, false);
  ok('hook file is gone', !fs.existsSync(hookFile(d)));
}

// --- NEVER CLOBBER: a foreign hook already exists ---
{
  const d = mkHooksDir();
  const foreign = '#!/bin/sh\necho "a pre-existing user hook"\nexit 0\n';
  fs.writeFileSync(hookFile(d), foreign);
  fs.chmodSync(hookFile(d), 0o755);

  const r = ch.install(d);
  ok('install over a foreign hook is ok', r.ok === true);
  eq('install over a foreign hook chains', r.chained, true);
  ok('the foreign hook was backed up VERBATIM', fs.readFileSync(backupFile(d), 'utf8') === foreign);
  const installed = fs.readFileSync(hookFile(d), 'utf8');
  ok('the installed hook carries our marker', installed.includes(ch.MARKER));
  ok('the installed hook chains to the backup', installed.includes('prepare-commit-msg.pre-claudible'));
  ok('the original foreign content is NOT the live hook file anymore (it moved to the backup)', installed !== foreign);

  // installing again must NOT re-backup (would silently drop anything that ran between the two installs)
  const r2 = ch.install(d);
  ok('second install ok', r2.ok === true);
  eq('second install still reports chained', r2.chained, true);
  eq('the backup is untouched by a second install', fs.readFileSync(backupFile(d), 'utf8'), foreign);

  // uninstall restores the ORIGINAL foreign hook exactly, and cleans up the backup
  const u = ch.uninstall(d);
  ok('uninstall ok', u.ok === true);
  eq('uninstall reports the foreign hook was restored', u.restored, true);
  eq('the foreign hook is back, byte-exact', fs.readFileSync(hookFile(d), 'utf8'), foreign);
  ok('the backup file is gone after restore', !fs.existsSync(backupFile(d)));
}

// --- a hook that is neither ours nor backed up is left completely alone ---
{
  const d = mkHooksDir();
  const foreign = '#!/bin/sh\necho "someone replaced our file by hand"\n';
  fs.writeFileSync(hookFile(d), foreign);   // no MARKER, no backup — install() never ran here
  const u = ch.uninstall(d);
  ok('uninstall on an unowned hook refuses', u.ok === false);
  eq('the unowned hook is untouched', fs.readFileSync(hookFile(d), 'utf8'), foreign);
}

// --- buildCoauthorLines: email > login+id noreply > login-only noreply > skip ---
{
  const { lines, skipped } = ch.buildCoauthorLines([
    { name: 'Ada', email: 'ada@example.com' },
    { name: 'Bo', login: 'bo-dev', id: 123 },
    { name: 'Cy', login: 'cy-dev' },
    { name: 'Dee' },                          // no email, no login -> skipped, never fabricated
    { name: '' },                              // no name at all -> silently dropped, not "skipped" (nothing to report)
  ]);
  eq('email wins verbatim', lines[0], 'Ada <ada@example.com>');
  eq('login+id -> GitHub id+login noreply convention', lines[1], 'Bo <123+bo-dev@users.noreply.github.com>');
  eq('login only -> plain login noreply', lines[2], 'Cy <cy-dev@users.noreply.github.com>');
  eq('exactly one entry skipped', skipped.length, 1);
  eq('the unknown-identity guest is named in skipped, not fabricated', skipped[0], 'Dee');
  eq('no stray 4th line for the nameless/skipped entries', lines.length, 3);
}

// --- writeCoauthorsFile: writes, and clears (unlinks) rather than leaving an empty file ---
{
  const d = mkHooksDir();
  const gitDir = path.join(d, '.git');
  fs.mkdirSync(gitDir);
  const w1 = ch.writeCoauthorsFile(gitDir, ['Ada <ada@example.com>']);
  ok('write ok', w1.ok === true);
  eq('file content matches', fs.readFileSync(path.join(gitDir, ch.COAUTHORS_FILE), 'utf8'), 'Ada <ada@example.com>\n');
  const w2 = ch.writeCoauthorsFile(gitDir, []);
  ok('clear ok', w2.ok === true);
  ok('empty list REMOVES the file rather than leaving 0 bytes on disk', !fs.existsSync(path.join(gitDir, ch.COAUTHORS_FILE)));
}

// --- the hook script itself: a merge/squash source is skipped BEFORE it reads the coauthors file ---
{
  const script = ch.hookScript('');
  ok('checks $2 against merge|squash before doing anything else', /case "\$src" in merge\|squash\) exit 0 ;; esac/.test(script));
  ok('a missing/empty coauthors file is a silent no-op (solo commits get no trailer)', /\[ -s "\$coauthors" \] \|\| exit 0/.test(script));
  ok('never appends a trailer already present (idempotent re-run / amend)', /grep -qF "Co-authored-by: \$line" "\$msgfile"/.test(script));
}

console.log(`\ncoauthor-hook: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
