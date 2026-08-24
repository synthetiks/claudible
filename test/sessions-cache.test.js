'use strict';
// test/sessions-cache.test.js — the transcript parse cache must be INVISIBLE.
//
// The session list re-read and re-parsed every transcript in a project on every call. A cache keyed on file
// identity makes the steady state nearly free, and its entire risk is one failure mode: serving a stale answer
// with no error anywhere. A wrong cache does not crash, it lies — so every case below is about the cache
// NOTICING a change, not about it being fast.
//
// The hard case is a collaborator's transcript. sessions-sync.sh stamps every import
// `touch -d '2000-01-01T00:00:00'`, so its mtime is pinned at that sentinel forever and never advances no
// matter how many times the file is replaced. A key of (size, mtime) would therefore degenerate to size-only
// for exactly the files that change behind your back. That is what the ctime half of the key is for, and the
// same-size-same-mtime case below is the one that proves it.
//
// Run: node test/sessions-cache.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'wsl', 'sessions-tool.js');

let pass = 0, fail = 0;
const ok = (got, want, label) => {
  if (String(got) === String(want)) { pass++; return; }
  fail++; console.error(`  FAIL ${label}: got ${JSON.stringify(String(got))}, want ${JSON.stringify(String(want))}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudible-sesscache-'));
const proj = path.join(tmp, 'proj');
const cacheDir = path.join(tmp, 'cache');
fs.mkdirSync(proj); fs.mkdirSync(cacheDir);

const run = () => cp.execFileSync(process.execPath, [TOOL, proj], {
  env: Object.assign({}, process.env, { CLAUDIBLE_CACHE_DIR: cacheDir }),
  encoding: 'utf8',
});
const rec = (out, id) => (JSON.parse(out) || []).find((r) => r.id === id) || {};
const turn = (text, ts) => JSON.stringify({ type: 'user', timestamp: ts, message: { content: text } }) + '\n';

const F = path.join(proj, 'aaaaaaaa-1111-2222-3333-444444444444.jsonl');
const ID = 'aaaaaaaa-1111-2222-3333-444444444444';

// --- 1. a cached answer is the SAME answer -----------------------------------------------------------------
fs.writeFileSync(F, turn('alpha', '2026-01-01T00:00:00.000Z'));
const cold = run();
const warm = run();
ok(warm, cold, 'a cached run returns something different from the cold run');
ok(rec(cold, ID).preview, 'alpha', 'the cold run did not read the transcript');
ok(fs.readdirSync(cacheDir).filter((f) => f.startsWith('sessions-')).length, 1, 'no cache file was written');

// --- 2. a grown file is re-read ------------------------------------------------------------------------------
fs.appendFileSync(F, turn('beta', '2026-01-01T00:00:01.000Z'));
ok(rec(run(), ID).msgs, 2, 'appending a turn did not invalidate the cached record');

// --- 3. THE FOREIGN-IMPORT CASE: same size, same (sentinel) mtime, new ctime ---------------------------------
//     This is what an import does — replace the bytes, then stamp the sentinel date back on. Only ctime moves.
const SENTINEL = new Date('2000-01-01T00:00:00Z');
fs.writeFileSync(F, turn('alpha', '2026-01-01T00:00:00.000Z'));
fs.utimesSync(F, SENTINEL, SENTINEL);
ok(rec(run(), ID).preview, 'alpha', 'the sentinel-dated file did not read as alpha');
const sizeBefore = fs.statSync(F).size;

const swap = F + '.swap';
fs.writeFileSync(swap, turn('omega', '2026-01-01T00:00:00.000Z'));   // 'omega' is the same length as 'alpha'
fs.utimesSync(swap, SENTINEL, SENTINEL);
ok(fs.statSync(swap).size, sizeBefore, 'the swap file is not the same size — the case being tested is not set up');
fs.renameSync(swap, F);
ok(fs.statSync(F).mtimeMs, SENTINEL.getTime(), 'mtime moved — the sentinel case is not being exercised');
ok(rec(run(), ID).preview, 'omega', 'SAME SIZE + SAME SENTINEL MTIME + NEW CTIME served a stale answer');

// --- 4. a corrupt cache costs a parse, never an error --------------------------------------------------------
for (const f of fs.readdirSync(cacheDir)) fs.writeFileSync(path.join(cacheDir, f), '{ this is not json');
ok(rec(run(), ID).preview, 'omega', 'a corrupt cache did not fall back to a full parse');

// --- 5. a cache entry of the wrong SHAPE is refused, not trusted ---------------------------------------------
for (const f of fs.readdirSync(cacheDir)) {
  fs.writeFileSync(path.join(cacheDir, f), JSON.stringify({
    v: 1, e: { [ID]: { k: fs.statSync(F).size + ':' + fs.statSync(F).mtimeMs + ':' + fs.statSync(F).ctimeMs, p: 42, m: 'x', c: null, l: null } },
  }));
}
ok(rec(run(), ID).preview, 'omega', 'a well-keyed but wrong-shaped cache entry was trusted');

// --- 6. a deleted transcript leaves the cache ----------------------------------------------------------------
fs.unlinkSync(F);
run();
const left = JSON.parse(fs.readFileSync(path.join(cacheDir, fs.readdirSync(cacheDir)[0]), 'utf8'));
ok(Object.keys(left.e || {}).length, 0, 'a deleted session stayed in the cache');

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
console.log(`sessions-cache: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
