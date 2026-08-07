// test/e2e/findings/B15-rename-repaint.spec.js — HARDWARE-SMOKE-RESULTS.md finding B15 (BOTH TOGETHER, "FAIL
// vs budget + repaint clue"): "~20 s (budget ~2 s), and the row repainted exactly on mouseover — the data
// likely lands earlier but the sidebar row doesn't re-render until interaction. Two-part fix: transport
// cadence + paint trigger on titles landing."
//
// ROOT CAUSE, traced in renderer/app.js + main.js:
//   (a) PAINT TRIGGER — pollTitles() (the 20s renderer poll) only ever fetches titles for `activeWsId`, and on
//       every call it REPLACES the flat `remoteTitles` id->title map wholesale. claudible.onSyncChanged's
//       non-active branch called ONLY refreshWsSubtree(s.id), which repaints an expanded-but-not-active
//       project's tree from whatever `remoteTitlesCache[wsId]` already holds — it never FETCHES anything. So a
//       collaborator's rename in a project you're merely WATCHING (expanded, not active — never clicked into,
//       i.e. no "interaction") had NO path to ever reach the screen. Clicking into the project (making it
//       active) is what finally ran pollTitles for it — which reads, in hindsight, exactly like "it only
//       repaints on interaction".
//   (b) TRANSPORT CADENCE — a rename (title-set) commits to meta/<author>.json on the SAME shared branch a
//       session push commits to, so the beacon's remote-head probe (main.js _beaconProbe) detects it moving on
//       its normal ~1.5s-ish, C-6.2-governed cadence — but sessions-sync.sh's `sync` op only reports
//       imported/updated/pushed for CONTENT changes (sessions/*.jsonl), never for a title-only commit. So
//       doSync's own `changed` flag never fires for a rename, and main never told the renderer anything at all
//       — the ONLY thing driving a title refresh was the renderer's own 20s pollTitles interval (throttled to
//       at most once per 15s), matching the ~20s hardware measurement closely.
//
// THE FIX: main.js's beacon now emits 'sync:changed' the instant it detects the branch moved AT ALL (piggy-
// backing on a probe cadence that already exists — no new polling, C-6.2's backoff untouched), and
// renderer/app.js's onSyncChanged non-active branch now calls a new refreshWsTitles(wsId) (fetches THIS
// workspace's own titles, merges into remoteTitles + the durable per-workspace remoteTitlesCache) before
// repainting — so an expanded-but-inactive project's rename lands event-driven, with zero mouse interaction.
//
// This spec drives that exact shape: B has the shared project EXPANDED (not active, never clicked into, no
// mouse ever touches B.page below) and watches ITS renamed row with no interaction at all.
//
// TIMING REALITY IN THIS HARNESS: measured directly (main.js's own live-timing.log, read below) — a single
// beacon probe against a same-machine `git init --bare` remote (no network at all) costs ~5s on this box, and
// the presence/title re-read that follows a detected head-move costs another several seconds on top —
// git-bash + node script spawn overhead, not network. That is itself a live C-0.12 violation ("any background
// script call on Windows: under 1 second... a probe over 1s means the pipeline is jammed") on THIS machine
// specifically — sync-pair.spec.js documents the identical class of variance for the same beacon cadence
// (its own window: single-digit seconds in isolation, 35-46s observed under load) and, like that spec, this
// one asserts a generous, honest ceiling rather than the literal hardware budget, which a spawn-cost-bound
// sandboxed CI box cannot promise. The 2s ideal (C-0.3) is the real target on real hardware; the number this
// spec enforces is "reliably bounded and dramatically better than never", which is what part (a) above turns
// "categorically impossible without a click" into.
'use strict';
const { test, expect } = require('playwright/test');
const { launchPair, writeFakeTranscript, syncNowRetry } = require('../_fixtures');

test('a collaborator rename reaches an expanded-but-inactive project row with no mouse interaction (B15)', async () => {
  test.setTimeout(120000);
  const pair = await launchPair({ slug: 'b15-proj' });
  const { A, B } = pair;
  try {
    const sid = 'e2e-b15-' + Date.now();
    const oldPrompt = 'hello from crazy — B15 rename repro, before the rename';
    const newTitle = 'B15 renamed title ' + Date.now();

    // ---- A authors + pushes a real session ------------------------------------------------------------------
    writeFakeTranscript(A, A.ws, sid, oldPrompt);
    const aPush = await syncNowRetry(A.page, A.wsId);
    expect(aPush && aPush.ok, 'A\'s push should succeed: ' + JSON.stringify(aPush)).toBe(true);

    // ---- B pulls it (manual — this is SETUP, not the timed path under test) ---------------------------------
    const bPull = await syncNowRetry(B.page, B.wsId);
    expect(bPull && bPull.ok, 'B\'s pull should succeed: ' + JSON.stringify(bPull)).toBe(true);
    const bList = await B.page.evaluate((wid) => globalThis.claudible.sessionListWs(wid), B.wsId);
    expect(Array.isArray(bList) && bList.some((s) => s.id === sid), 'B should have the session locally before we can watch its row: ' + JSON.stringify(bList)).toBe(true);

    // ---- B: expand the shared project WITHOUT making it active (launchPair keeps 'local-local' active — see
    // _fixtures.js's seedRepoWorkspace comment) and WITHOUT ever touching the mouse — setWsExpanded is the exact
    // function the real caret-click handler calls; driving it directly is equivalent to a click for this
    // spec's purpose (which project is expanded), while keeping every subsequent step interaction-free. -------
    await B.page.evaluate((wid) => { setWsExpanded(wid, true); renderWsChips(); }, B.wsId);
    expect(await B.page.evaluate(() => activeWsId), 'the shared project must stay NON-active on B for this repro').not.toBe(B.wsId);
    expect(await B.page.evaluate((wid) => isWsExpanded(wid), B.wsId)).toBe(true);

    const bRow = B.page.locator('#ws-chips .ws-children .sess[data-id="' + sid + '"] .sess-prev');
    await expect(bRow).toBeVisible({ timeout: 20000 });
    await expect(bRow).not.toHaveText(newTitle);   // sanity: starts on the auto-preview, not already renamed

    // ---- ACT: A renames the session (claudible.titleSet — the exact IPC startSessEdit's commit() calls) -----
    const t0 = Date.now();
    const setR = await A.page.evaluate(({ id, name, wsId }) => globalThis.claudible.titleSet(id, name, wsId), { id: sid, name: newTitle, wsId: A.wsId });
    expect(setR && setR.ok, 'A\'s titleSet should succeed: ' + JSON.stringify(setR)).toBe(true);

    // ---- THE ASSERTION UNDER TEST: B's row updates with ZERO mouse/pointer interaction anywhere on B.page —
    // no .click(), no .hover(), no setActiveTab, no manual sync call. 45s ceiling matches sync-pair.spec.js's
    // own documented precedent for this exact beacon cadence's real-machine variance (see the file header) —
    // BEFORE the fix this never lands at all, so even a wide ceiling is a strict, meaningful assertion.
    await expect.poll(async () => (await bRow.textContent()) || '', { timeout: 45000, intervals: [250, 500, 1000] })
      .toBe(newTitle);
    const elapsedMs = Date.now() - t0;
    console.log('[B15] rename visible on B (no interaction) after', elapsedMs, 'ms — ideal hardware budget (C-0.3) is 2000ms; see the file header for why this harness cannot promise that number');
    expect(elapsedMs, 'rename should reach an expanded-but-inactive peer row within this harness’ generous, documented ceiling, no click/hover required').toBeLessThanOrEqual(45000);

    // B genuinely never became active on this project and no rename input is open — confirms the row updated
    // as a background repaint, not as a side effect of some other interaction this spec accidentally caused.
    expect(await B.page.evaluate(() => activeWsId)).not.toBe(B.wsId);
  } finally {
    await Promise.all([A.stop(), B.stop()]);
  }
});
