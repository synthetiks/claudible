// test/presence-relay.test.js — the realtime presence layer: lib/presenceRelay.js pure logic + the wiring
// contract across main.js / wsl/sessions-sync.sh / relay/worker.js / the renderer skew surfacing. The relay
// is a preview layer over the authoritative git branch — these tests pin the two invariants that keep it
// honest: frames merge into (never replace the authority of) the last authoritative list, and the publisher
// path never gates the git stamps.
// Run: node test/presence-relay.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { mergePeerFrame, reconcilePeerLists, roomKeyFor } = require('../lib/presenceRelay.js');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
function t(label, fn) { try { fn(); pass++; } catch (e) { fail++; console.error(`  FAIL ${label}: ${e.message}`); } }

// ---- roomKeyFor: stable, case-insensitive, name-hiding ----
t('roomKeyFor is 20 hex and case-insensitive', () => {
  const k = roomKeyFor('Acme', 'Widgets');
  assert.match(k, /^[0-9a-f]{20}$/);
  assert.strictEqual(k, roomKeyFor('acme', 'widgets'));
  assert.notStrictEqual(k, roomKeyFor('acme', 'widgets2'));
});

// ---- mergePeerFrame: one blob per author, frames key by login ----
const LIVE = { type: 'live', login: 'cd', session: 's1', url: 'https://x', token: 't', name: 'CD', ts: 9 };
t('live frame inserts a new author', () => {
  const out = mergePeerFrame([], LIVE);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].login, 'cd');
  assert.strictEqual(out[0].url, 'https://x');
});
t('live frame REPLACES the same author (starting → full handle)', () => {
  const out = mergePeerFrame([{ login: 'cd', session: 's1', starting: true, ts: 1 }, { login: 'mk', session: 's2', ts: 2 }], LIVE);
  assert.strictEqual(out.length, 2);
  const cd = out.find((p) => p.login === 'cd');
  assert.ok(cd.url && !cd.starting);
  assert.ok(out.find((p) => p.login === 'mk'));
});
t('end frame removes exactly that author', () => {
  const out = mergePeerFrame([{ login: 'cd', session: 's1', ts: 1 }, { login: 'mk', session: 's2', ts: 2 }], { type: 'end', login: 'cd', session: 's1' });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].login, 'mk');
});
t('foreign/bad frames change nothing (and never mutate the input)', () => {
  const base = [{ login: 'mk', session: 's2', ts: 2 }];
  for (const f of [null, {}, { type: 'chat', login: 'cd' }, { type: 'live', login: '' }, { type: 'live', login: 'cd' }]) {
    const out = mergePeerFrame(base, f);
    assert.strictEqual(out.length, 1);
    assert.notStrictEqual(out, base);
  }
});
t('starting frame carries starting:true and no fabricated url', () => {
  const out = mergePeerFrame([], { type: 'live', login: 'cd', session: 's1', starting: true, name: 'CD', ts: 3 });
  assert.strictEqual(out[0].starting, true);
  assert.strictEqual('url' in out[0], false);
});

// ---- reconcilePeerLists: git wins, except strictly-newer relay entries ----
t('reconcile: git list replaces stale prev entries', () => {
  const out = reconcilePeerLists([{ login: 'cd', session: 's1', ts: 10 }], [{ login: 'cd', session: 's0', ts: 5 }]);
  assert.strictEqual(out.length, 1); assert.strictEqual(out[0].session, 's1');
});
t('reconcile: a strictly-newer prev (relay) entry survives the overwrite', () => {
  const out = reconcilePeerLists([{ login: 'cd', session: 's1', ts: 10 }], [{ login: 'cd', session: 's2', ts: 99 }]);
  assert.strictEqual(out[0].session, 's2');
});
t('reconcile: dropped-by-git entries stay dropped unless newer than the WHOLE read', () => {
  const gone = reconcilePeerLists([{ login: 'mk', ts: 50 }], [{ login: 'cd', session: 's1', ts: 20 }]);
  assert.ok(!gone.find((p) => p.login === 'cd'), 'older-than-read entry must stay gone (ended session)');
  const kept = reconcilePeerLists([{ login: 'mk', ts: 50 }], [{ login: 'cd', session: 's1', ts: 99 }]);
  assert.ok(kept.find((p) => p.login === 'cd'), 'newer-than-read relay announce must survive one stale git read');
});
t('reconcile: tolerates junk', () => {
  assert.deepStrictEqual(reconcilePeerLists(null, null), []);
  assert.strictEqual(reconcilePeerLists([{ login: 'x', ts: 1 }], [null, {}]).length, 1);
});

// ---- wiring contract (grep-level, zero deps) ----
const MAIN = read('main.js');
const SH = read('wsl/sessions-sync.sh');
const WORKER = read('relay/worker.js');
const APP = read('renderer/app.js');
const PRELOAD = read('preload.js');

t('main: relay publishes ride ALONGSIDE the git stamps (starting, full, heartbeat, end)', () => {
  assert.ok((MAIN.match(/_relayPub\(/g) || []).length >= 4, 'fewer than 4 publish sites');
  assert.ok(/type: 'end', session: advSid/.test(MAIN), 'no end frame at stopAdvertising');
});
t('main: inbound frames merge into the last AUTHORITATIVE list, never replace authority', () =>
  assert.ok(/mergePeerFrame\(_lastPeers\.get\(wsId\), frame\)/.test(MAIN)));
t('main: beacon reads reset the authoritative baseline the relay merges into', () =>
  assert.ok((MAIN.match(/_lastPeers\.set\(wsId, peers\)/g) || []).length >= 2));
t('main: relay rooms reconcile with the beacon roster scan', () =>
  assert.ok(/_relay\.ensure\(/.test(MAIN) && /_relay\.release\(/.test(MAIN)));
t('main: a FAILED presence read never pushes (a blip must not erase live rows)', () =>
  assert.ok((MAIN.match(/pr\.ok === false/g) || []).length >= 2 && /read FAILED/.test(MAIN)));
t('main: beacon pushes reconcile against newer relay entries (no 45s flicker-to-gone)', () =>
  assert.ok((MAIN.match(/reconcilePeerLists\(pr\.peers, _lastPeers\.get\(wsId\)\)/g) || []).length === 2));
t('main: own-login frames are skipped (the git path self-skip, mirrored)', () =>
  assert.ok(/frame\.login === me\) return/.test(MAIN)));
t('script: relay-cred is allowlisted and emits login+token', () => {
  assert.ok(/\|relay-cred\|/.test(SH));
  assert.ok(/relay-cred\)/.test(SH) && /gh auth token/.test(SH));
});
t('worker: publish requires GitHub push permission and the login is FORCED server-side', () => {
  assert.ok(/permissions/.test(WORKER) && /p\.push \? 'publisher'/.test(WORKER));
  assert.ok(/login: att\.login/.test(WORKER), 'frames must carry the verified login, not the claimed one');
});
t('worker: room key is verified against the hello repo (no cross-room token reuse)', () =>
  assert.ok(/expect !== att\.roomKey/.test(WORKER)));

// ---- build-skew surfacing rides presence ----
t('script: presence stamps carry the publisher build sha', () =>
  assert.ok((SH.match(/\\"sha\\":\\"\$psha\\"/g) || []).length === 2));
t('main: stamps thread BUILD.short; drift check + boot line exist', () => {
  assert.ok((MAIN.match(/'\$\{BUILD\.short\}'/g) || []).length >= 3);   // starting + full + heartbeat (+ the starting retry)
  assert.ok(/function checkBuildDrift\(/.test(MAIN) && /winSend\('build:drift'/.test(MAIN));
  assert.ok(/_liveTiming\('boot: sha='/.test(MAIN));
});
t('renderer: sig repaints on sha change; skew note on badges; drift chip wired', () => {
  assert.ok(/p\.sha, !!sessIndex/.test(APP));
  assert.ok(/function _skewNote\(/.test(APP) && /_skewNote\(peer\)/.test(APP));
  assert.ok(/onBuildDrift\(/.test(APP) && /onBuildDrift[^\n]*build:drift/.test(PRELOAD));
});

console.log(`presence-relay: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
