// test/live-teardown.test.js — executes the REAL stopLiveSharing() lifted out of main.js (prefs-bound.test.js
// technique: regex the function source out, new Function() it with stubbed deps), because main.js cannot be
// require()d under the test runner.
//
// The load-bearing property is ORDERING, which a static grep cannot see: advertisedWs/advertisedSid must be
// captured BEFORE stopAdvertiseHeartbeat() nulls them, or the presence-clear runs with ws=null — clearing the
// wrong (or no) repo and leaving live/<login>.json on the branch, i.e. the exact "MK still sees me live after I
// quit" bug. This test drives the shipped code through both states and fails if the capture is reordered.
// Run: node test/live-teardown.test.js
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (label, c, extra) => { if (c) pass++; else { fail++; console.error('  FAIL ' + label + (extra ? '\n    ' + extra : '')); } };
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const m = MAIN.match(/function stopLiveSharing\(\) \{[\s\S]*?\n\}/);
ok('stopLiveSharing() exists in main.js', !!m);
if (!m) { console.log(`\nlive-teardown: ${pass} passed, ${fail} failed`); process.exit(1); }

// Execute the lifted body inside a scope whose `advertisedWs`/`advertisedSid` are REAL mutable bindings that the
// stubbed stopAdvertiseHeartbeat nulls — reproducing main.js's module state exactly. `src` lets a mutation test
// run a deliberately-broken variant through the identical harness.
function drive(state, src) {
  const calls = [];
  const stubs = {
    stopAdvertiseHeartbeat: () => calls.push(['heartbeat-stop']),   // the null-out happens in the harness below
    runPresence: (op, cb, ws) => calls.push(['presence', op, ws]),
    share: { stop: () => calls.push(['share-stop']) },
  };
  const body = (src || m[0]).replace(/^function stopLiveSharing\(\) \{/, '').replace(/\n\}$/, '');
  new Function('stubs', 'ws0', 'sid0', `
    let advertisedWs = ws0, advertisedSid = sid0;
    const runPresence = stubs.runPresence, share = stubs.share;
    // Mirror the real stopAdvertiseHeartbeat: it NULLS both globals. That is the trap the capture must beat.
    const stopAdvertiseHeartbeat = () => { stubs.stopAdvertiseHeartbeat(); advertisedWs = null; advertisedSid = null; };
    ${body}
  `)(stubs, state.ws, state.sid);
  return calls;
}

// ---- hosting: presence-clear must fire, on the CAPTURED ws, despite the heartbeat teardown nulling it --------
{
  const WS = { id: 'repo-mk-crazy' };
  const calls = drive({ ws: WS, sid: 'sess-1' });
  const presence = calls.find((c) => c[0] === 'presence');
  ok('presence-clear fires when we were advertising', !!presence, JSON.stringify(calls));
  eq('…with op presence-clear', presence && presence[1], 'presence-clear');
  ok('…on the ADVERTISED ws captured before the heartbeat teardown nulled it', presence && presence[2] === WS,
    'got ' + JSON.stringify(presence && presence[2]) + ' — the capture happened AFTER stopAdvertiseHeartbeat()');
  eq('order: heartbeat stops before the clear (no beat can re-stamp after)',
    calls.map((c) => c[0]), ['heartbeat-stop', 'presence', 'share-stop']);
}

// ---- not advertising (web-link-only share): no presence to clear, but the server still stops -----------------
{
  const calls = drive({ ws: null, sid: null });
  ok('no presence-clear when we never advertised', !calls.some((c) => c[0] === 'presence'), JSON.stringify(calls));
  eq('…but the share server still stops', calls.map((c) => c[0]), ['heartbeat-stop', 'share-stop']);
}

// ---- self-check: the harness genuinely catches the reordering bug -------------------------------------------
// Build the buggy variant (capture AFTER the heartbeat teardown — the shipped quit-path mistake) and run it
// through the SAME harness: it must fail to clear presence. If this ever passes, the harness has gone vacuous.
{
  const reordered = m[0].replace(
    /const advWs = advertisedWs, wasAdvertising = !!advertisedSid;([^\n]*\n)(\s*)stopAdvertiseHeartbeat\(\);/,
    'stopAdvertiseHeartbeat();\n$2const advWs = advertisedWs, wasAdvertising = !!advertisedSid;');
  ok('self-check: the buggy variant is genuinely different source', reordered !== m[0]);
  const calls = drive({ ws: { id: 'repo-x' }, sid: 'sess-1' }, reordered);
  ok('self-check: the capture-after-stop variant FAILS to clear presence (harness is not vacuous)',
    !calls.some((c) => c[0] === 'presence'), JSON.stringify(calls));
}

console.log(`\nlive-teardown: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
