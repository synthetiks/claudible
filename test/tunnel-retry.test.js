// test/tunnel-retry.test.js — the live-share tunnel self-heal (main.js). main.js can't be require()'d under
// plain node (electron import), so like discovery.test.js's ordering guard these are static text assertions:
// the retry cluster exists, every share-end path disarms it, both spawn paths adopt through ONE function, and
// the dangling "ensureTunnel" promise (a comment that named a function nobody ever wrote — how the wsl flavor
// shipped with no tunnel recovery at all) can never quietly return. Run: node test/tunnel-retry.test.js
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(label, c) { c ? pass++ : (fail++, console.error('  FAIL ' + label)); }

const R = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const MAIN = R('main.js'), PRELOAD = R('preload.js'), APP = R('renderer/app.js');

// ---- the retry cluster exists, in full ----
for (const fn of ['armTunnelRetry', 'disarmTunnelRetry', 'kickTunnelRetryNow', 'attemptTunnelRetry', 'adoptTunnel', 'presenceBeatOnce']) {
  ok('main.js defines ' + fn, MAIN.includes('function ' + fn + '('));
}
ok('main.js: the retry timer is registered in appTimers (quit sweep disarms it for free)',
  /const appTimers = \{[^}]*tunnelRetry/.test(MAIN));

// ---- ONE adopt path: share:start's launch AND the background retry both go through adoptTunnel ----
{
  const calls = (MAIN.match(/adoptTunnel\(/g) || []).length - 1;   // minus the definition
  ok('adoptTunnel is CALLED from at least two sites (share:start + retry), got ' + calls, calls >= 2);
}

// ---- a failed tunnel at share-start arms the self-heal instead of staying silently degraded forever ----
ok('share:start fallback arms the retry', /note = String\(tunErr\.message \|\| tunErr\); armTunnelRetry\(\);/.test(MAIN));

// ---- an unexpected tunnel death re-arms from inside the (single) exit handler, and beats presence on recovery ----
{
  const iDef = MAIN.indexOf('function adoptTunnel(');
  const body = iDef > -1 ? MAIN.slice(iDef, MAIN.indexOf('\n}\n', iDef)) : '';
  ok("adoptTunnel's exit handler announces tunnel-down", body.includes("winSend('share:tunnel-down'"));
  ok("adoptTunnel's exit handler re-arms the retry (the promised self-heal)", body.includes('armTunnelRetry()'));
  ok('adoptTunnel beats presence immediately (recovery is tunnel-time, not tunnel + heartbeat)', body.includes('presenceBeatOnce()'));
  ok('adoptTunnel announces tunnel-up to the renderer', body.includes("winSend('share:tunnel-up'"));
}

// ---- every share-end path disarms: stopLiveSharing is the single choke point (share:stop, quit, force-end) ----
{
  const i = MAIN.indexOf('function stopLiveSharing(');
  const body = i > -1 ? MAIN.slice(i, MAIN.indexOf('\n}', i)) : '';
  ok('stopLiveSharing disarms the retry (no post-stop orphan tunnel)', body.includes('disarmTunnelRetry()'));
}

// ---- a mid-share cloudflared install skips the 45s cadence (env is applied just before the kick) ----
{
  const iKick = MAIN.indexOf("if (id === 'cloudflared'");
  const iEnv = MAIN.indexOf('s.depEnv = Object.assign');
  ok('preflight:install kicks the retry for cloudflared', iKick > -1 && MAIN.slice(iKick, iKick + 120).includes('kickTunnelRetryNow()'));
  ok('…AFTER the env persist/apply block (candidates() reads process.env synchronously)', iEnv > -1 && iEnv < iKick);
}

// ---- the regression that started it all: no dangling "ensureTunnel" name in main.js, ever again ----
ok('main.js contains no reference to the never-written ensureTunnel', !MAIN.includes('ensureTunnel'));

// ---- renderer plumbing: the bridge, the standing warning, and the recovery handler all exist ----
ok('preload bridges share:tunnel-up', PRELOAD.includes('onShareTunnelUp'));
ok('renderer defines the standing warning (renderTunnelWarn)', APP.includes('function renderTunnelWarn('));
ok('renderer handles share:tunnel-up', APP.includes('onShareTunnelUp'));
ok('renderer warning chip exists in the markup', R('renderer/index.html').includes('id="tunnel-warn"'));

console.log('tunnel-retry: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
