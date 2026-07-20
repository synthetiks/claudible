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
ok('script: remote-head is a bare BOUNDED ls-remote (a big session push must not stretch the probe)',
  /ls-remote origin "refs\/heads\/\$BR"/.test(SH) && !/fetch origin "\$BR"[\s\S]{0,400}op\\":\\"remote-head/.test(SH.slice(SH.indexOf('"$op" = "remote-head"'), SH.indexOf('"$op" = "remote-head"') + 1400)));
ok('script: remote-head reports an unreachable remote as ok:false (the per-ws backoff signal)',
  /remote unreachable/.test(SH));
ok('script: remote-head answers BEFORE the gh-api author block (API-budget invariant)',
  SH.indexOf('"$op" = "remote-head"') !== -1 && SH.indexOf('"$op" = "remote-head"') < SH.indexOf('author="$(gh api user'));
ok('script: presence-list under CLAUDIBLE_DIRECT_READ is a lock-free CODE-CLONE read (bounded fetch, no worktree)',
  /if \[ -n "\$\{CLAUDIBLE_DIRECT_READ:-\}" \]; then/.test(SH) && /GD="\$SDIR"/.test(SH) && /git -C "\$GD" ls-tree/.test(SH));
ok('script: presence-starting stamps a url-less starting:true entry',
  /\\"starting\\":true/.test(SH));
ok('script: presence-starting still runs the one-host arbiter',
  (() => { const i = SH.indexOf('presence-starting)'); return i !== -1 && SH.slice(i, SH.indexOf('presence-clear)')).includes('presence_holder_refuse'); })());
ok('script: presence writes are worktree-FREE plumbing (no pull, no worktree, no index on the critical path)', (() => {
  // presence-set / presence-starting / presence-clear must build the commit directly (mktree + commit-tree +
  // push) and never call pull_branch or gitwt inside their blocks — the worktree path is what made stamps
  // wait behind syncs and made the app-quit clear die on index.lock corpses. Behavior: presence-plumbing.test.sh.
  if (!/gitp commit-tree/.test(SH) || !/gitp mktree/.test(SH) || !/update-ref "refs\/remotes\/origin\/\$BR"/.test(SH)) return false;
  const spans = [['  presence-set)', '  presence-starting)'], ['  presence-starting)', '  presence-clear)'], ['  presence-clear)', '  presence-list)']];
  for (const [from, to] of spans) {
    const i = SH.indexOf(from), j = SH.indexOf(to);
    if (i === -1 || j === -1 || j <= i) return false;
    const block = SH.slice(i, j);
    if (block.includes('pull_branch') || block.includes('gitwt ')) return false;
    if (!/presence_attempt/.test(block)) return false;
  }
  return true;
})());

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
ok('main: a branch change pushes the fresh presence straight to the renderer', /winSend\('live:peers-push'/.test(MAIN));
ok('main: the beacon presence read is direct (outside the queue) with the bounded on-change fetch',
  /direct: true, extraEnv: 'CLAUDIBLE_DIRECT_READ=1 '/.test(MAIN));
ok('main: announce fires exactly once per head move (baseline advances BEFORE the sync, not after it)',
  /_beaconHeads\.set\(wsId, r\.head\);\s*\n\s*_beaconDirty\.set\(wsId, r\.head\);/.test(MAIN) && /_beaconDirty\.delete\(wsId\)/.test(MAIN));
ok('main: workspaces probe on INDEPENDENT chains (one dead remote must not slow the others)',
  /_beaconArm\(wsId, _beaconDelay\(wsId\)\)/.test(MAIN) && !/Promise\.all\(targets\.map/.test(MAIN));
ok('main: a failing workspace probe backs off exponentially instead of burning a spawn per tick',
  /_beaconErr\.set\(wsId, \(_beaconErr\.get\(wsId\) \|\| 0\) \+ 1\)/.test(MAIN) && /Math\.pow\(2, errs\)/.test(MAIN));
ok('main: presence ops ride their OWN lane, never behind a transcript sync',
  /const _presQ = makeKeyedQueue\(\)/.test(MAIN) && /\/\^presence-\/\.test\(args\) \? _presQ : _syncQ/.test(MAIN));
ok('main: tunnel-down advertise pushes the phase-1 starting presence', /presence-starting '\$\{sid\}'/.test(MAIN));
ok('main: renderer pollers survive minimize (backgroundThrottling:false)', /backgroundThrottling: false/.test(MAIN));

// ---- renderer + preload: consuming the fast path ----
ok('preload: onLivePeersPush bridges live:peers-push', /onLivePeersPush[^\n]*live:peers-push/.test(PRELOAD));
ok('renderer: the push paints through the SAME sig/repaint path as the poll',
  /onLivePeersPush\(/.test(APP) && /function livePeersSigOf\(/.test(APP) && (APP.match(/livePeersSigOf\(next\)/g) || []).length >= 2);
ok('renderer: a failed/raced advertise un-latches so the retry can fire',
  /advertisedSession === want\) advertisedSession = null/.test(APP));
ok('renderer: starting stamps pass the peers filter with their own short TTL',
  /STARTING_TTL_S/.test(APP) && /p\.starting/.test(APP));
ok('renderer: advertise is no longer gated on tunnelUp (two-phase advertise)',
  !/const want = \(tunnelUp && aw/.test(APP) && /const want = \(aw && aw\.kind === 'repo'/.test(APP));
ok('renderer: a starting row is inert (no join handler until the full stamp)',
  /peer\.starting/.test(APP) && /going live/.test(APP));

console.log(`beacon: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
