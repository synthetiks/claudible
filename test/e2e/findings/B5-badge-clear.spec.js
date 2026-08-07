// test/e2e/findings/B5-badge-clear.spec.js — HARDWARE-SMOKE-RESULTS.md finding B5 (BOTH TOGETHER, "FAIL
// (mild)"): "Stop-badge gone <=5s (C-0.5) ... 5-15s to clear. The realtime 'end' signal isn't driving the
// native sidebar badge; a slower fallback is."
//
// ROOT CAUSE: the realtime relay (_relayPub in main.js, lib/presenceRelay.js) is INERT by default —
// DEFAULT_RELAY_URL is '' at HEAD and no CLAUDIBLE_RELAY_URL is deployed for real users, so its <1s 'end'
// push never actually fires for anyone today. EVERY badge update — live or ended — travels the git beacon
// alone (main.js's per-workspace remote-head probe chain). That beacon's own anti-jam backoff (_beaconDelay,
// C-6.2: "the next check waits at least 4x as long as the last one actually took") is correct medicine for a
// QUIET workspace on a slow link, but it also floors the cadence for a workspace someone is ACTIVELY
// WATCHING because a collaborator is live — exactly the moment a peer is staring at the badge waiting for it
// to clear. On real GitHub round-trips (B21 measured 1.1-3.3s per probe) that floor alone is 4-13s, which is
// the observed 5-15s.
//
// THE FIX: main.js now skips the cost*4 floor (never the FAILURE backoff — an unreachable remote still backs
// off) while the beacon's last confirmed read still shows a joinable peer for that workspace
// (_beaconHasLivePeer) — a bounded, self-expiring fast lane that reverts the instant a probe finds the
// branch quiet, so ordinary quiet workspaces are completely unaffected.
//
// REPRODUCING NETWORK LATENCY LOCALLY: this harness's shared remote is a same-machine `git init --bare` repo
// (test/e2e/_fixtures.js's localBareRemote) that answers in milliseconds — nothing like the GitHub round-trip
// B21 measured, so the bug cannot be exercised over it as-is. A PATH-shadowing "slow git" shim (fake-gh/gh's
// own technique) was tried FIRST and does not work for `git` specifically: MSYS bash's own startup
// unconditionally prepends its native /mingw64/bin (containing the real git.exe) ahead of ANY inherited PATH
// entry, so a shim placed earlier on PATH is never reached (confirmed empirically — a shim invocation log
// stayed empty across full runs). wsl/sessions-sync.sh's remote-head op therefore gets a small, guarded,
// OFF-BY-DEFAULT test-only hook instead: CLAUDIBLE_E2E_SLOW_PROBE_S sleeps before the ls-remote call, exactly
// where B21's real latency lands — same pattern as that file's existing CLAUDIBLE_NOW/CLAUDIBLE_DIRECT_READ
// test-support env vars, digit/decimal-guarded so a malformed or (every real install's) absent value is a
// silent no-op.
//
// SCENARIO: A shares a real (resolved, writeFakeTranscript-seeded) session live via the in-app collab toggle
// (toggleShareSession — the exact function the sidebar's "Share live" ▾ item calls) with the SAME loopback-
// tunnel trick share-guest.spec.js documents. B watches the native sidebar's live-peer row for that project
// (kept ACTIVE, matching the real "watching the badge" scenario) with B's remote-head probe slowed.
//
// TIMING REALITY IN THIS HARNESS: measured directly, both ways (fix reverted via `git stash`, then restored).
// This box's own baseline git-bash/node spawn overhead is substantial BEFORE any artificial slowdown is even
// added — a bare ls-remote against a same-machine remote was independently observed costing ~5s in
// B15-rename-repaint.spec.js's own debug run, the same C-0.12-violating class of cost sync-pair.spec.js's
// header documents for this identical beacon. That baseline dominates enough run-to-run variance that a
// single fixed wall-clock ceiling cannot cleanly separate every individual run (two Electron + git-bash
// instances contending for CPU on one box is noisy) — so CLAUDIBLE_E2E_SLOW_PROBE_S adds 3s on top of that
// baseline so the fix's real, structural effect (skip vs. apply a 4x floor) dominates the noise: WITHOUT the
// fix the badge does not reliably even APPEAR within a two-minute window (the SAME floor governs "someone
// went live" before any peer is confirmed, since the fast lane only engages once one is — confirmed directly,
// see below); WITH the fix, appearance completes and the clear lands in single-digit-to-teens seconds.
// Neither number is the literal 5s hardware budget (C-0.5) — this sandboxed box's baseline spawn
// cost alone exceeds that before the fix even engages — so, like B15-rename-repaint.spec.js's own honestly
// documented ceiling, the assertion below is a generous-but-real ceiling proving the fix's actual, structural
// effect rather than a number this specific CI box's raw spawn cost cannot deliver.
'use strict';
const fs = require('fs');
const path = require('path');
const { test, expect } = require('playwright/test');
const {
  launchClaudible, resolveGitBash, localBareRemote, seedRepoWorkspace, writeFakeTranscript,
  listDescendantPids, sleep,
} = require('../_fixtures');

function setActiveWorkspace(persistDir, wsId) {
  const wsFile = path.join(persistDir, 'workspaces.json');
  const reg = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
  reg.activeId = wsId;
  fs.writeFileSync(wsFile, JSON.stringify(reg));
}

test('a Stop-shared LIVE badge clears on the peer within a bounded window once truly live (B5)', async () => {
  test.setTimeout(280000);
  const gitBash = resolveGitBash();
  test.skip(!gitBash, 'no usable git-bash found on this machine — sync requires it');

  const slug = 'b5-proj-' + Date.now();
  const bareRemote = localBareRemote();
  const sid = 'e2e-b5-' + Date.now();

  let aWs = null, bWs = null;
  const A = await launchClaudible({
    withClaude: true, withGh: true, gitBash, ghLogin: 'crazy-e2e',
    env: { CLAUDIBLE_CLOUDFLARED: process.execPath },   // documented loopback fallback (share-guest.spec.js's header)
    seed: (ctx) => {
      aWs = seedRepoWorkspace(ctx, { slug, owner: 'crazy-e2e', remote: bareRemote });
      writeFakeTranscript(ctx, aWs, sid, 'hello from crazy — B5 badge-clear repro, a real resolved session to share');
      setActiveWorkspace(ctx.persist, aWs.id);   // boot straight into the shared project (mirrors C5-adopt-while-live.spec.js's realism note)
    },
  });
  const B = await launchClaudible({
    withClaude: true, withGh: true, gitBash, ghLogin: 'mk-e2e',
    // Simulates B21's real-GitHub round-trip on the beacon's remote-head probe ONLY — see the file header for
    // why this couldn't be a PATH-shimmed `git` and lives in wsl/sessions-sync.sh (guarded, off by default)
    // instead. Every other git operation B performs (clone/fetch/push) is untouched.
    env: { CLAUDIBLE_E2E_SLOW_PROBE_S: '3' },
    seed: (ctx) => {
      bWs = seedRepoWorkspace(ctx, { slug, owner: 'crazy-e2e', remote: bareRemote });
      setActiveWorkspace(ctx.persist, bWs.id);   // B watches the SAME project's badge, actively (not merely expanded) — the real "staring at the badge" case
    },
  });

  try {
    // ---- A: boot restores straight into the real resolved session (no create-overlay) ----------------------
    await expect(A.page).toHaveTitle(/./, { timeout: 30000 });
    await expect.poll(() => A.page.evaluate(() => activeSession), { timeout: 20000 }).toBe(sid);
    let aDescendants = [];
    const spawnDeadline = Date.now() + 15000;
    while (Date.now() < spawnDeadline && aDescendants.length === 0) {
      aDescendants = listDescendantPids(A.pid);
      if (aDescendants.length === 0) await sleep(500);
    }
    expect(aDescendants.length, 'the fake-claude shim should have spawned for A\'s real session').toBeGreaterThan(0);
    await expect.poll(() => A.page.evaluate((id) => !!(typeof sessIndex !== 'undefined' && sessIndex[id]), sid), { timeout: 20000 }).toBe(true);

    // ---- B: confirm it booted onto the SAME (empty, from its own view) shared project, active --------------
    await expect(B.page).toHaveTitle(/./, { timeout: 30000 });
    expect(await B.page.evaluate(() => activeWsId)).toBe(bWs.id);

    // ---- ACT 1: A shares the session live (the sidebar's "Share live" ▾ item — driven directly, exactly the
    // function that item calls: renderer/app.js's savedSessMenuItems act:()=>toggleShareSession(s)). ----------
    await A.page.evaluate((id) => { toggleShareSession(sessIndex[id]); }, sid);
    await expect.poll(() => A.page.evaluate(() => tunnelUp), { timeout: 20000 }).toBe(true);
    await expect.poll(() => A.page.evaluate(() => advertisedSession), { timeout: 20000 }).toBe(sid);

    // ---- B: the LIVE peer row appears (B4, C-0.4 — already known-good; generous ceiling here since B's own
    // probe cadence is artificially slowed BEFORE any peer is confirmed live, which is expected and outside
    // B5's own scope — see main.js's _beaconHasLivePeer comment). ------------------------------------------
    const peerRow = B.page.locator('.sess-peer-live');
    await expect(peerRow).toBeVisible({ timeout: 90000 });

    // Give the fast lane a moment to actually engage (one more probe cycle past the row's first appearance,
    // so _lastPeers on B reliably reflects the FULL url+token stamp, not just the phase-1 "starting" one) —
    // matches the same settle-then-act shape B10/B14's specs use before their own timed assertions.
    await sleep(3000);

    // ---- ACT 2 / THE ASSERTION UNDER TEST: A stops sharing; B's badge must clear in a bounded window. --------
    const t0 = Date.now();
    await A.page.evaluate((id) => { toggleShareSession(sessIndex[id]); }, sid);   // sharedSessionId === id now → the SAME function's "stop" branch
    await expect.poll(() => A.page.evaluate(() => tunnelUp), { timeout: 20000 }).toBe(false);

    await expect.poll(async () => (await peerRow.count()), { timeout: 60000, intervals: [200, 500, 1000] }).toBe(0);
    const elapsedMs = Date.now() - t0;
    console.log('[B5] LIVE badge cleared on B after', elapsedMs, 'ms — ideal hardware budget (C-0.5) is 5000ms; see the file header for why this harness cannot promise that literal number');
    // 25s ceiling — see the file header's TIMING REALITY section for the measured before/after numbers this
    // is calibrated against. Before the fix, this reliably exceeds it (the cost*4 floor on a probe already
    // slowed for the test alone clears 25s); after it, the fast lane keeps it comfortably under.
    expect(elapsedMs, 'the LIVE badge should clear on the peer within this harness’ generous, documented ceiling').toBeLessThanOrEqual(25000);
  } finally {
    await Promise.all([A.stop(), B.stop()]);
  }
});
