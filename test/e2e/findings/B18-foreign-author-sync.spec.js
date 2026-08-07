// test/e2e/findings/B18-foreign-author-sync.spec.js — HARDWARE-SMOKE-RESULTS.md finding B18 (BOTH TOGETHER,
// "FAIL — hard"): "CRAZY continued a session AUTHORED BY MK; MK's open terminal never updated and NO
// out-of-sync chip appeared in 2 min. Evidence: sync branch shows the title commit + presence, but NO
// transcript commit for the turn — CRAZY's side never pushed the content. Working theory: transcript sync
// skips foreign-authored sessions. Sender-half bug."
//
// THE DELTA vs sync-pair.spec.js's clean-room auto-detect test (#11 there, which PASSES): that spec has A
// push a session A itself authored. Here, B is the one who ADDS the new turn to a session A originally
// authored — B only has the transcript locally because an earlier sync IMPORTED it (wsl/sessions-sync.sh
// marks any imported id "foreign" in $PROJ/.claudible-foreign, a permanent SECURITY trust marker so a
// collaborator's transcript is never auto-resumed with --dangerously-skip-permissions). export_sessions()
// used that SAME foreign marker to permanently refuse to ever re-publish that id under B's own name — "we
// never re-publish an imported session under our own name" — with no exception for "but I actually typed
// new turns into it". That blanket rule is the bug: it conflates "republish an untouched import" (correctly
// forbidden — pointless noise) with "publish MY OWN new turns in a session I resumed" (must be allowed, or
// every turn added to a resumed collaborator session vanishes into the ether forever, exactly as CRAZY's
// hardware run showed).
//
// SEQUENCE: A authors + pushes a session -> B pulls it (now foreign on B, per the trust boundary above) ->
// B's Claude appends a new turn to that SAME transcript file (simulated directly on disk, same technique
// writeFakeTranscript uses) -> B pushes (session:syncNow, exactly the manual "Sync sessions now" affordance)
// -> assert the push actually carried the new content (before the fix: 0 pushed, no content commit — the
// exact hardware symptom) -> assert A picks it up via the beacon ALONE, no manual action on A's side (same
// isolation sync-pair.spec.js relies on: neither instance has the shared workspace's tab open, so only the
// beacon's remote-head probe chain can ever notice — see seedRepoWorkspace's comment in _fixtures.js).
'use strict';
const fs = require('fs');
const path = require('path');
const { test, expect } = require('playwright/test');
const { launchPair, writeFakeTranscript, sleep, syncNowRetry, resolveGitBash } = require('../_fixtures');

test('B continues a session authored by A; B pushes the new content and A auto-detects it (B18 repro)', async () => {
  test.setTimeout(90000);
  test.skip(!resolveGitBash(), 'no usable git-bash found on this machine — sync is git-bash-dependent end to end');

  const pair = await launchPair({ slug: 'b18-proj' });
  const { A, B } = pair;
  try {
    const sid = 'e2e-b18-' + Date.now();

    // ---- A authors and pushes the session (a plain sync-pair-style push — A owns this id) ------------------
    writeFakeTranscript(A, A.ws, sid, 'hello from crazy — the session MK is about to continue');
    const aPush = await syncNowRetry(A.page, A.wsId);
    expect(aPush && aPush.ok, 'A\'s initial push should succeed: ' + JSON.stringify(aPush)).toBe(true);

    // ---- B pulls it: this is the moment wsl/sessions-sync.sh marks the id FOREIGN in B's .claudible-foreign,
    // the trust boundary the export bug (mis-)reused as a permanent "never republish" gate. -------------------
    const bPull = await syncNowRetry(B.page, B.wsId);
    expect(bPull && bPull.ok, 'B\'s pull of A\'s session should succeed: ' + JSON.stringify(bPull)).toBe(true);
    const bFile = path.join(B.projDir, sid + '.jsonl');
    await expect.poll(() => fs.existsSync(bFile), { timeout: 15000, message: 'expected A\'s session to land on B\'s disk after pulling' }).toBe(true);
    const foreignSet = path.join(B.projDir, '.claudible-foreign');
    await expect.poll(() => fs.existsSync(foreignSet) && fs.readFileSync(foreignSet, 'utf8').split('\n').includes(sid), {
      timeout: 15000, message: 'expected the imported id to be recorded as foreign on B (the trust boundary the export bug conflated with "never export")',
    }).toBe(true);

    // ---- B "continues" the session: append a real new turn to the SAME transcript file (what a resumed
    // Claude would do), then age the mtime past the torn-write guard (CLAUDIBLE_SYNC_MIN_AGE, default 2s) so
    // this write is never mistaken for one still in flight. --------------------------------------------------
    const marker = 'mk continues — a brand new turn typed on B, ' + Date.now();
    const grown = fs.readFileSync(bFile, 'utf8') + JSON.stringify({ type: 'user', message: { content: marker } }) + '\n';
    fs.writeFileSync(bFile, grown);
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(bFile, old, old);

    // ---- B pushes (the manual "Sync sessions now" affordance, session:syncNow) — THE ASSERTION UNDER TEST:
    // before the fix, export_sessions() sees `sid` in $PROJ/.claudible-foreign and skips it unconditionally,
    // so `pushed` stays 0 and no content commit ever lands (title/presence commits from earlier ops are the
    // only thing on the branch — exactly CRAZY's hardware evidence). ------------------------------------------
    const bPush = await syncNowRetry(B.page, B.wsId);
    expect(bPush && bPush.ok, 'B\'s push of its continuation should succeed: ' + JSON.stringify(bPush)).toBe(true);
    expect(bPush.pushed, 'B should have pushed the extended (foreign-authored) session\'s new content, not skipped it: ' + JSON.stringify(bPush)).toBeGreaterThan(0);
    expect(bPush.diverged || 0, 'a clean append onto the imported copy is not a fork — no divergence chip should ever appear: ' + JSON.stringify(bPush)).toBe(0);

    // ---- A auto-detects with NO manual action — only the beacon's remote-head probe chain is running here
    // (neither instance has the shared workspace's tab open; see seedRepoWorkspace's comment in _fixtures.js
    // and sync-pair.spec.js's identical isolation for the same reason). ---------------------------------------
    const aFile = path.join(A.projDir, sid + '.jsonl');
    let seen = false;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (fs.existsSync(aFile) && fs.readFileSync(aFile, 'utf8').includes(marker)) { seen = true; break; }
      await sleep(1000);
    }
    expect(seen, 'A should auto-detect and pull B\'s new turn via the beacon alone, no manual sync').toBe(true);
  } finally {
    await Promise.all([A.stop(), B.stop()]);
  }
});
