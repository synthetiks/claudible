// test/live-teardown.test.js — executes the REAL presence-teardown code lifted out of main.js (prefs-bound.test.js
// technique: regex the function source out, new Function() it with stubbed deps), because main.js cannot be
// require()d under the test runner.
//
// The load-bearing property is ORDERING, which a static grep cannot see: advertisedWs/advertisedSid must be
// captured BEFORE stopAdvertiseHeartbeat() nulls them, or the presence-clear runs with ws=null — clearing the
// wrong (or no) repo and leaving live/<login>.json on the branch, i.e. the exact "MK still sees me live after I
// quit" bug. This lives in stopAdvertising() now (extracted so every end path tears down the same way). This test
// drives the shipped code through both states and fails if the capture is reordered.
// Run: node test/live-teardown.test.js
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (label, c, extra) => { if (c) pass++; else { fail++; console.error('  FAIL ' + label + (extra ? '\n    ' + extra : '')); } };
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const m = MAIN.match(/function stopAdvertising\(\) \{[\s\S]*?\n\}/);
ok('stopAdvertising() exists in main.js', !!m);
if (!m) { console.log(`\nlive-teardown: ${pass} passed, ${fail} failed`); process.exit(1); }

// Execute the lifted stopAdvertising body inside a scope whose `advertisedWs`/`advertisedSid` are REAL mutable
// bindings that the stubbed stopAdvertiseHeartbeat nulls — reproducing main.js's module state exactly. The clear
// goes through clearPresenceWithRetry (a separate fn); we stub it to record the ws it was handed, which is the
// thing the capture-before-stop ordering protects. `src` lets a mutation test run a broken variant.
function drive(state, src) {
  const calls = [];
  const body = (src || m[0]).replace(/^function stopAdvertising\(\) \{/, '').replace(/\n\}$/, '');
  new Function('rec', 'ws0', 'sid0', `
    let advertisedWs = ws0, advertisedSid = sid0;
    const stopAdvertiseHeartbeat = () => { rec.push(['heartbeat-stop']); advertisedWs = null; advertisedSid = null; };
    const clearPresenceWithRetry = (ws) => rec.push(['presence-clear', ws]);
    ${body}
  `)(calls, state.ws, state.sid);
  return calls;
}

// ---- hosting: the clear must fire, on the CAPTURED ws, despite the heartbeat teardown nulling it -------------
{
  const WS = { id: 'repo-mk-crazy' };
  const calls = drive({ ws: WS, sid: 'sess-1' });
  const clear = calls.find((c) => c[0] === 'presence-clear');
  ok('the clear fires when we were advertising', !!clear, JSON.stringify(calls));
  ok('…on the ADVERTISED ws captured before the heartbeat teardown nulled it', clear && clear[1] === WS,
    'got ' + JSON.stringify(clear && clear[1]) + ' — the capture happened AFTER stopAdvertiseHeartbeat()');
  eq('order: heartbeat stops before the clear (no beat can re-stamp after)',
    calls.map((c) => c[0]), ['heartbeat-stop', 'presence-clear']);
}

// ---- not advertising (web-link-only share): no presence to clear ---------------------------------------------
{
  const calls = drive({ ws: null, sid: null });
  ok('no clear when we never advertised', !calls.some((c) => c[0] === 'presence-clear'), JSON.stringify(calls));
  eq('…but the heartbeat teardown still runs', calls.map((c) => c[0]), ['heartbeat-stop']);
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
    !calls.some((c) => c[0] === 'presence-clear'), JSON.stringify(calls));
}

// ---- clearPresenceWithRetry: a failed clear is RE-ATTEMPTED, not silently lost ------------------------------
{
  const cp = MAIN.match(/function clearPresenceWithRetry\(ws, attempt\) \{[\s\S]*?\n\}/);
  ok('clearPresenceWithRetry() exists', !!cp);
  if (cp) {
    const body = cp[0].replace(/^function clearPresenceWithRetry\(ws, attempt\) \{/, '').replace(/\n\}$/, '');
    // Inject runPresence (fails twice, then succeeds) + a synchronous setTimeout so the retry chain runs inline.
    const make = new Function('deps', `
      const console = deps.console, setTimeout = deps.setTimeout, runPresence = deps.runPresence;
      return function clearPresenceWithRetry(ws, attempt) { ${body} };
    `);
    let calls = 0, landed = false;
    const fn = make({
      console: { error: () => {} },
      setTimeout: (f) => { f(); return { unref() {} }; },
      runPresence: (op, cb) => { calls++; const okNow = calls >= 3; if (okNow) landed = true; cb(okNow ? { ok: true } : { ok: false, error: 'push failed' }); },
    });
    fn('repo-x', 0);
    ok('a failing clear retries until it lands (not silently lost)', landed && calls === 3, `calls=${calls} landed=${landed}`);
  }
}

// ---- stopLiveSharing composes stopAdvertising() then share.stop() -------------------------------------------
{
  const sls = (MAIN.match(/function stopLiveSharing\(\) \{[\s\S]*?\n\}/) || [''])[0];
  ok('stopLiveSharing() calls stopAdvertising() before share.stop()',
    /stopAdvertising\(\);[\s\S]*share\.stop\(\)/.test(sls), sls);
}

// ---- the two lazy end paths (close shared tab, delete shared workspace) now stop advertising directly --------
// Fix-2 invariant: they used to only freeze the mirror + winSend force-end and rely on an async renderer
// round-trip, during which the heartbeat kept re-stamping presence for an already-ended session.
{
  const tabClose = (MAIN.match(/ipcMain\.handle\('tab:close'[\s\S]*?\n\}\);/) || [''])[0];
  ok('tab:close calls stopAdvertising() when the shared tab closes',
    /sharedTabId === tabId\)\s*\{[\s\S]*?stopAdvertising\(\)/.test(tabClose), 'tab:close does not stop advertising on shared-tab close');
  // workspace-delete shared branch: stopAdvertising() must sit right beside the workspace-deleted force-end
  ok('workspace:delete calls stopAdvertising() when the shared session is deleted',
    /stopAdvertising\(\);[^\n]*\n[^\n]*reason: 'workspace-deleted'/.test(MAIN), 'workspace-delete shared branch does not stop advertising');
}

console.log(`\nlive-teardown: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
