// test/beacon.test.js — the remote-head beacon + two-phase advertise wiring (the "peer sees it in seconds"
// path). Everything collaborators share rides ONE branch, so main polls a cheap head-sha probe (~2.5s) and
// only a real change fires the sync/presence pipeline; the host stamps a url-less "going live…" presence the
// moment Share is clicked, replaced by the full handle when the tunnel lands. This test pins the wiring that
// makes that true — contract-test style (grep-level, zero deps) over the shipped source, plus the two
// invariants that are easy to silently regress: the probe must answer BEFORE the script's per-invocation
// gh-api call (or the beacon alone would eat the GitHub API budget), and the probe must never join the
// per-workspace sync queue (a queued probe behind a 120s sync is a dead beacon).
// Run: node test/beacon.test.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SH = read('wsl/sessions-sync.sh');
const MAIN = read('main.js');
const APP = read('renderer/app.js');
const PRELOAD = read('preload.js');

let pass = 0, fail = 0;
function ok(label, c) { c ? pass++ : (fail++, console.error('  FAIL ' + label)); }

// ---- script: the remote-head probe ----
ok('script: remote-head + presence-starting are allowlisted ops',
  /case "\$op" in [^\n]*remote-head[^\n]*presence-starting[^\n]*\) ;; \*\) fail "bad op"/.test(SH));
ok('script: remote-head probes via git ls-remote (no fetch, no worktree)',
  /ls-remote origin "refs\/heads\/\$BR"/.test(SH));
ok('script: remote-head answers BEFORE the gh-api author block (API-budget invariant)',
  SH.indexOf('"$op" = "remote-head"') !== -1 && SH.indexOf('"$op" = "remote-head"') < SH.indexOf('author="$(gh api user'));
ok('script: presence-starting stamps a url-less starting:true entry',
  /"starting":true/.test(SH));
ok('script: presence-starting still runs the one-host arbiter (live-holder)',
  (() => { const i = SH.indexOf('presence-starting)'); return i !== -1 && SH.slice(i, SH.indexOf('presence-clear)')).includes('live-holder'); })());

// ---- main: the beacon loop ----
ok('main: startBeacon exists and is started at boot', /function startBeacon\(/.test(MAIN) && /startBeacon\(\);/.test(MAIN));
ok('main: beacon timer is registered in appTimers (quit sweep clears it)', /appTimers = \{[^}]*beacon: null/.test(MAIN));
ok('main: beacon calls the remote-head op', /runScript\('sessions-sync\.sh', 'remote-head'/.test(MAIN));
ok('main: the probe does NOT ride the per-ws sync queue', (() => {
  // every _syncQ.run callsite must not wrap the remote-head probe
  const probe = MAIN.indexOf("'remote-head'");
  if (probe === -1) return false;
  const before = MAIN.slice(Math.max(0, probe - 200), probe);
  return !before.includes('_syncQ.run');
})());
ok('main: a branch change nudges the renderer presence poll', /winSend\('live:peers-nudge'/.test(MAIN));
ok('main: tunnel-down advertise pushes the phase-1 starting presence', /presence-starting '\$\{sid\}'/.test(MAIN));
ok('main: renderer pollers survive minimize (backgroundThrottling:false)', /backgroundThrottling: false/.test(MAIN));

// ---- renderer + preload: consuming the fast path ----
ok('preload: onLivePeersNudge bridges live:peers-nudge', /onLivePeersNudge[^\n]*live:peers-nudge/.test(PRELOAD));
ok('renderer: the nudge triggers pollLivePeers', /onLivePeersNudge\(\(\) => \{ pollLivePeers\(\); \}\)/.test(APP));
ok('renderer: starting stamps pass the peers filter with their own short TTL',
  /STARTING_TTL_S/.test(APP) && /p\.starting/.test(APP));
ok('renderer: advertise is no longer gated on tunnelUp (two-phase advertise)',
  !/const want = \(tunnelUp && aw/.test(APP) && /const want = \(aw && aw\.kind === 'repo'/.test(APP));
ok('renderer: a starting row is inert (no join handler until the full stamp)',
  /peer\.starting/.test(APP) && /going live/.test(APP));

console.log(`beacon: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
