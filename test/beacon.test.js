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
  /ls-remote "\$SREM" "refs\/heads\/\$BR"/.test(SH) && !/fetch "\$SREM" "\$BR"[\s\S]{0,400}op\\":\\"remote-head/.test(SH.slice(SH.indexOf('"$op" = "remote-head"'), SH.indexOf('"$op" = "remote-head"') + 1400)));
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
  if (!/gitp commit-tree/.test(SH) || !/gitp mktree/.test(SH) || !/update-ref "refs\/remotes\/\$SREM\/\$BR"/.test(SH)) return false;
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
ok('main: beacon roster timer is registered in appTimers (quit sweep clears it)', /appTimers = \{[^}]*beacon: null/.test(MAIN));
ok('main: teardown sweeps the PER-WORKSPACE chains too and blocks re-arm (a mid-await probe must not resurrect one post-quit)',
  /_beaconTimers\.values\(\)\) clearTimeout\(t\)/.test(MAIN) && /_quitting\) return;/.test(MAIN));
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
ok('advertise names the SHARED project explicitly (never main ambient activeWorkspace)', (() => {
  // A host focused on a LOCAL project made every presence write fail ("sync is only available for repo
  // workspaces") — the renderer knew the share's project, main guessed from its foreground tab.
  const preload = read('preload.js');
  return /liveAdvertise: \(sessionId, name, wsId\)/.test(preload)
    && /liveAdvertise\(want, collabName\(\), sharedWsId \|\| activeWsId\)/.test(APP)
    && /_wsById\(payload && payload\.wsId\) \|\| activeWorkspace/.test(MAIN);
})());
ok('main: tunnel-down advertise pushes the phase-1 starting presence', /presence-starting '\$\{shq\(sid\)\}'/.test(MAIN));
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
// NO `() =>` here. ok(label, c) does `c ? pass++ : fail++`, so passing an un-invoked arrow makes the argument a
// function reference — always truthy — and the check silently rubber-stamps whatever it claims to guard. This one
// shipped that way and never ran. Every sibling above passes the expression directly; keep it that way.
ok('renderer: a stale "going live…" row is re-read, and the fallback poll can never latch off',
  /_pollLiveInFlight && Date\.now\(\) - _pollLiveSince > 30000/.test(APP) && /_startingRowSeen\) \{ try \{ pollLivePeers/.test(APP) && (APP.match(/_notePendingRows\(next\)/g) || []).length === 2);
ok('renderer: a starting row is inert (no join handler until the full stamp)',
  /peer\.starting/.test(APP) && /going live/.test(APP));

// ---- the four audited ~10s closers (2026-07-20 Opus audit) ----
ok('renderer: EXPANDING a project fetches presence immediately (the push-gate promise, kept)',
  /if \(on && !was\) \{ try \{ pollLivePeers\(\); \} catch \(e\) \{\} \}/.test(APP));
ok('main: the beacon hidden-window delay stays UNDER the 10s fallback poll',
  /BEACON_HIDDEN_MS = 8000/.test(MAIN));
ok('main: first sighting announces current state too (already-live-before-I-looked)',
  (MAIN.match(/direct: true, extraEnv: 'CLAUDIBLE_DIRECT_READ=1 '/g) || []).length >= 2);
ok('script: a failed direct-read fetch falls back to the worktree path instead of a silent stale read',
  /if \[ -n "\$\{CLAUDIBLE_DIRECT_READ:-\}" \]; then[\s\S]{0,1600}?GD="\$WT"/.test(SH));

// ---- B5 (HARDWARE-SMOKE-RESULTS.md, C-0.5): the "Stop-badge gone <=5s" fast lane ----
// A wall-clock e2e assertion for this alone is environment-noisy (see test/e2e/findings/B5-badge-clear.spec.js's
// own header — this box's baseline git-bash spawn cost is itself several seconds, swamping small timing
// margins run to run) — these pins are the DETERMINISTIC tripwire: revert _beaconHasLivePeer's short-circuit
// and this file goes red immediately, independent of any machine's spawn-cost variance.
ok('main: _beaconHasLivePeer exists and reads the confirmed peers cache, not a guess',
  /function _beaconHasLivePeer\(wsId\) \{/.test(MAIN) && /_lastPeers\.get\(wsId\)/.test(MAIN.slice(MAIN.indexOf('function _beaconHasLivePeer'), MAIN.indexOf('function _beaconHasLivePeer') + 300)));
ok('main: _beaconDelay skips the slow-quiet-network floor while a peer is confirmed live, BEFORE computing it',
  (() => {
    const i = MAIN.indexOf('function _beaconDelay(wsId) {');
    if (i < 0) return false;
    const body = MAIN.slice(i, i + 1600);
    const liveLine = body.indexOf('_beaconHasLivePeer(wsId)');
    const floorLine = body.indexOf('cost * 4');
    return liveLine > -1 && floorLine > -1 && liveLine < floorLine;
  })());
ok('main: the fast lane never bypasses the FAILURE backoff (an unreachable remote still backs off)',
  /if \(_beaconHasLivePeer\(wsId\)\) return backoff;/.test(MAIN));

// ---- B15 (HARDWARE-SMOKE-RESULTS.md, C-0.3): rename reaches an expanded-but-inactive project ----
ok('main: the beacon emits sync:changed on ANY head move, not only content changes (a rename moves the branch too)',
  (() => {
    const moved = MAIN.indexOf('_liveTiming(`beacon: head moved ${wsId}');
    const pushed = MAIN.indexOf("winSend('sync:changed', { id: wsId, ids: [] })");
    return moved > -1 && pushed > -1 && pushed > moved && pushed - moved < 1200;
  })());
ok('renderer: refreshWsTitles exists and merges into BOTH remoteTitles and the durable per-workspace cache',
  /async function refreshWsTitles\(wsId\)/.test(APP) && /remoteTitles = Object\.assign\(\{\}, remoteTitles, m\)/.test(APP) && /remoteTitlesCache/.test(APP));
ok('renderer: onSyncChanged fetches titles for a non-active EXPANDED workspace, not just the active one',
  (() => {
    const sub = APP.indexOf('refreshWsSubtree(s.id);');
    const fetch = APP.indexOf('if (isWsExpanded(s.id)) { try { refreshWsTitles(s.id).then(() => refreshWsSubtree(s.id)); } catch (e) {} }');
    return sub > -1 && fetch > -1 && fetch > sub && fetch - sub < 800;
  })());

console.log(`beacon: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
