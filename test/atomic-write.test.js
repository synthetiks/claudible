// test/atomic-write.test.js — lib/atomicWrite.js, the tmp+rename every JSON file in the app is written with.
//
// This is worth testing precisely because its failure mode is invisible: every reader in the app turns a
// parse error into a silent default ({} / [] / a rebuilt registry). So the guarantees below are the only
// thing standing between a force-kill and a user losing their whole project library. Run: node test/atomic-write.test.js
'use strict';
const assert = require('assert');
const realFs = require('fs');
const os = require('os');
const path = require('path');
const { atomicWrite, atomicWriteJson } = require('../lib/atomicWrite.js');
const histStore = require('../lib/historyStore.js');

let pass = 0, fail = 0;
function eq(label, a, b) { try { assert.deepStrictEqual(a, b); pass++; } catch { fail++; console.error(`  FAIL ${label}\n    got: ${JSON.stringify(a)}\n    exp: ${JSON.stringify(b)}`); } }
function ok(label, cond) { if (cond) pass++; else { fail++; console.error(`  FAIL ${label}`); } }
function throws(label, fn, want) {
  try { fn(); fail++; console.error(`  FAIL ${label} (did not throw)`); }
  catch (e) { if (!want || String(e.message).includes(want)) pass++; else { fail++; console.error(`  FAIL ${label}\n    got: ${e.message}\n    want substring: ${want}`); } }
}

// A fake fs that records the exact call ORDER — the whole point of this module is that the target is never
// opened for writing, so we assert on the sequence, not just the end state.
function fakeFs(opts) {
  const o = opts || {};
  const files = new Map(), calls = [];
  return {
    files, calls,
    writeFileSync(f, data) { calls.push(['write', f]); if (o.failWrite) throw new Error('ENOSPC write'); files.set(f, data); },
    renameSync(a, b) { calls.push(['rename', a, b]); if (o.failRename) throw new Error('EPERM rename'); files.set(b, files.get(a)); files.delete(a); },
    unlinkSync(f) { calls.push(['unlink', f]); if (o.failUnlink) throw new Error('ENOENT unlink'); files.delete(f); },
  };
}

// ---- the target is written by rename, never by write ----
{
  const fs = fakeFs();
  fs.files.set('/x/a.json', 'OLD');
  atomicWrite(fs, '/x/a.json', 'NEW');
  eq('call order is write-tmp then rename', fs.calls, [['write', '/x/a.json.tmp'], ['rename', '/x/a.json.tmp', '/x/a.json']]);
  ok('target never passed to writeFileSync', !fs.calls.some((c) => c[0] === 'write' && c[1] === '/x/a.json'));
  eq('target holds the new bytes', fs.files.get('/x/a.json'), 'NEW');
  ok('tmp is gone', !fs.files.has('/x/a.json.tmp'));
}

// ---- a failed write leaves the OLD file intact and no corpse ----
{
  const fs = fakeFs({ failWrite: true });
  fs.files.set('/x/a.json', 'OLD');
  throws('write failure propagates', () => atomicWrite(fs, '/x/a.json', 'NEW'), 'ENOSPC');
  eq('old content survives a failed write', fs.files.get('/x/a.json'), 'OLD');
  ok('tmp cleaned up after a failed write', !fs.files.has('/x/a.json.tmp'));
  ok('cleanup was attempted', fs.calls.some((c) => c[0] === 'unlink' && c[1] === '/x/a.json.tmp'));
}

// ---- a failed RENAME is the dangerous one: the tmp exists and holds a full payload ----
{
  const fs = fakeFs({ failRename: true });
  fs.files.set('/x/a.json', 'OLD');
  throws('rename failure propagates', () => atomicWrite(fs, '/x/a.json', 'NEW'), 'EPERM');
  eq('old content survives a failed rename', fs.files.get('/x/a.json'), 'OLD');
  ok('tmp cleaned up after a failed rename', !fs.files.has('/x/a.json.tmp'));
}

// ---- cleanup itself may fail (read-only dir); the ORIGINAL error must still be what the caller sees ----
{
  const fs = fakeFs({ failWrite: true, failUnlink: true });
  throws('unlink failure never masks the real error', () => atomicWrite(fs, '/x/a.json', 'NEW'), 'ENOSPC');
}

// ---- atomicWriteJson is byte-identical to the hand-rolled JSON.stringify writes it replaced ----
{
  const fs = fakeFs();
  const v = { b: 2, a: [1, { c: null }] };
  atomicWriteJson(fs, '/x/r.json', v);
  eq('default indent 2, no trailing newline', fs.files.get('/x/r.json'), JSON.stringify(v, null, 2));
  atomicWriteJson(fs, '/x/c.json', v, 0);
  eq('indent 0 is compact (the per-tab context.json)', fs.files.get('/x/c.json'), JSON.stringify(v));
  ok('key order is preserved', fs.files.get('/x/c.json').indexOf('"b"') < fs.files.get('/x/c.json').indexOf('"a"'));
}

// ---- historyStore.save() must still emit the exact bytes it did before the extraction ----
{
  const fs = fakeFs();
  const log = [{ id: 'e1', prompt: 'hi' }];
  histStore.save(fs, '/x/history.json', log);
  eq('historyStore.save bytes unchanged', fs.files.get('/x/history.json'), JSON.stringify(log, null, 2));
  eq('historyStore.save goes through tmp+rename', fs.calls.map((c) => c[0]), ['write', 'rename']);
}

// ---- and against the REAL fs, in a temp dir ----
{
  const dir = realFs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
  const f = path.join(dir, 'w.json');
  atomicWriteJson(realFs, f, { hello: 'wörld "quoted"\n' });
  eq('real fs round-trip', JSON.parse(realFs.readFileSync(f, 'utf8')), { hello: 'wörld "quoted"\n' });
  atomicWriteJson(realFs, f, { hello: 2 });
  eq('real fs overwrite', JSON.parse(realFs.readFileSync(f, 'utf8')), { hello: 2 });
  eq('no .tmp left in the directory', realFs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
  // writing into a directory that does not exist must throw, not half-succeed
  throws('missing parent dir throws', () => atomicWriteJson(realFs, path.join(dir, 'nope', 'x.json'), {}), 'ENOENT');
  eq('…and leaves nothing behind', realFs.readdirSync(dir).sort(), ['w.json']);
  realFs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\natomic-write: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
