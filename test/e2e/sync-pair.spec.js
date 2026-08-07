// test/e2e/sync-pair.spec.js — the two-machine simulation (mission task 2): instance A ("crazy-e2e") and
// instance B ("mk-e2e") share ONE repo workspace pointed at a local bare git repo standing in for GitHub
// (see test/e2e/_fixtures.js's launchPair/localBareRemote). Neither instance has the shared workspace
// ACTIVE at boot (seedRepoWorkspace's comment explains why: an open tab would also engage main.js's regular
// adaptive poll, main.js:1975, which — unlike the beacon — only syncs a workspace that has one. Keeping the
// shared project tab-less isolates the ONE mechanism the hardware finding below is actually about).
//
// REPRO ATTEMPT — hardware findings B18 / C29 (HARDWARE-SMOKE-RESULTS.md): on the owners' hardware run,
// "sync-sessions was already ON, yet project settings still showed a clickable 'Sync sessions now'... clicking
// it made the out-of-sync chip appear instantly... So the resolve/one-click path (C-0.8) PASSES — what fails
// is the AUTOMATIC divergence detection (C-0.7): the beacon sees peers push but doesn't raise the indicator or
// pull on its own." This spec drives exactly that scenario against a LOCAL bare remote (no GitHub, no real
// network latency): A fabricates and pushes a real, qualifying session; B is watched for auto-detection with
// no manual action, then a manual "Sync sessions now" (session:syncNow) is exercised independently.
//
// RESULT ON THIS HEAD, THIS ENVIRONMENT: repeated runs show the beacon (main.js's remote-head probe,
// ~main.js:2046-2159) DOES reliably auto-detect A's push within single-digit seconds here — B18/C29 does NOT
// reproduce over a same-machine bare remote. That is itself a useful, reportable result (see the run summary):
// it narrows the hardware bug toward something conditioned on real GitHub round-trip timing / API behavior
// that a local git remote can't recreate, rather than a deterministic logic bug in the beacon's own code path.
// Both assertions below are therefore plain, must-pass expectations of CORRECT behavior — not test.fail()
// expected-failures — because forcing an expected-fail here would misreport what this harness actually
// observes. A future run that DOES see B18/C29 reproduce should turn test 2 red for real; that is the signal
// to re-open the finding, not a mark to remove.
'use strict';
const { test, expect } = require('playwright/test');
const { launchPair, writeFakeTranscript, sleep, syncNowRetry } = require('./_fixtures');

test.describe.configure({ mode: 'serial' });   // each test builds on the previous one's pushed session(s)

let pair = null;

test.beforeAll(async () => {
  pair = await launchPair({ slug: 'shared-proj' });
});

test.afterAll(async () => {
  if (!pair) return;
  await Promise.all([pair.A.stop(), pair.B.stop()]);
});

test('both instances boot with the shared repo workspace registered (but NOT the active/open tab)', async () => {
  const { A, B } = pair;
  await expect(A.page).toHaveTitle(/./, { timeout: 30000 });
  await expect(B.page).toHaveTitle(/./, { timeout: 30000 });

  // Real preload IPC round-trip, same shape as smoke.spec.js — proves each window is live, not just painted.
  // workspace:list resolves { activeId, workspaces, firstRun } (main.js:2439), not a bare array. The shared
  // workspace is deliberately NOT active (see seedRepoWorkspace's comment in _fixtures.js) — this asserts the
  // seeding landed, not that it's in the foreground.
  const aWs = await A.page.evaluate(() => globalThis.claudible.workspaceList());
  const bWs = await B.page.evaluate(() => globalThis.claudible.workspaceList());
  expect(Array.isArray(aWs.workspaces) && aWs.workspaces.some((w) => w.id === A.wsId)).toBe(true);
  expect(Array.isArray(bWs.workspaces) && bWs.workspaces.some((w) => w.id === B.wsId)).toBe(true);
  expect(aWs.activeId).not.toBe(A.wsId);
  expect(bWs.activeId).not.toBe(B.wsId);
});

test('A pushes a real session; B auto-detects it via the beacon alone, no manual action (B18/C29 repro attempt)', async () => {
  const { A, B } = pair;
  const sid = 'e2e-sess-auto-' + Date.now();
  writeFakeTranscript(A, A.ws, sid, 'hello from crazy — advancing shared state for the two-machine sim');

  // Retried through 'sync-busy' (see syncNowRetry) — A's OWN beacon/poll can legitimately hold the lock the
  // instant this fires; that is incidental contention, not the thing under test.
  const pushed = await syncNowRetry(A.page, A.wsId);
  expect(pushed && pushed.ok, 'A\'s push (session:syncNow) should succeed: ' + JSON.stringify(pushed)).toBe(true);

  // A must see its OWN session immediately (no sync needed for your own machine).
  const aList = await A.page.evaluate((wid) => globalThis.claudible.sessionListWs(wid), A.wsId);
  expect(Array.isArray(aList) && aList.some((s) => s.id === sid), 'A should see its own pushed session: ' + JSON.stringify(aList)).toBe(true);

  // THE ASSERTION UNDER TEST: does B notice on its own, with NO manual sync call, inside a generous window?
  // B has no open tab on this workspace (see the file header) — only the beacon can pick this up. Its own
  // cadence is ~1.5s (main.js BEACON_MS) plus git round-trips; 25s is generous for a local bare remote.
  let seenOnB = false;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const bList = await B.page.evaluate((wid) => globalThis.claudible.sessionListWs(wid), B.wsId);
    if (Array.isArray(bList) && bList.some((s) => s.id === sid)) { seenOnB = true; break; }
    await sleep(1000);
  }
  expect(seenOnB, 'B should auto-detect A\'s pushed session via the beacon with no manual action').toBe(true);
});

test('A pushes a second session; B\'s manual "Sync sessions now" pulls it on demand (C29\'s resolve-works half)', async () => {
  const { A, B } = pair;
  // A fresh id, pushed and then IMMEDIATELY pulled via the manual IPC — proves the explicit "Sync sessions
  // now" affordance (session:syncNow) is itself a working, on-demand path, independent of whatever the
  // background beacon happens to be doing. Mirrors the owners' own hardware click (C29): "clicking it made
  // the out-of-sync chip appear instantly and pulled MK's message in correctly."
  const sid = 'e2e-sess-manual-' + Date.now();
  writeFakeTranscript(A, A.ws, sid, 'hello from crazy — second turn, pulled on demand');

  const pushed = await syncNowRetry(A.page, A.wsId);
  expect(pushed && pushed.ok, 'A\'s push (session:syncNow) should succeed: ' + JSON.stringify(pushed)).toBe(true);

  const r = await syncNowRetry(B.page, B.wsId);
  expect(r && r.ok, 'B\'s manual sync (session:syncNow) should succeed: ' + JSON.stringify(r)).toBe(true);

  const after = await B.page.evaluate((wid) => globalThis.claudible.sessionListWs(wid), B.wsId);
  expect(Array.isArray(after) && after.some((s) => s.id === sid), 'B should have the freshly-pushed id right after a manual sync: got ' + JSON.stringify(after)).toBe(true);

  // Watch the sidebar DOM too, not just the IPC list. B booted with 'Local' active (deliberately — see
  // seedRepoWorkspace's comment), so switch the ACTUAL UI over to the shared project via the same IPC the
  // sidebar's own click handler uses, then let refreshSessions() paint it for real.
  const switched = await B.page.evaluate((wid) => globalThis.claudible.workspaceOpen(wid), B.wsId);
  expect(switched && switched.ok !== false, 'workspace:open should not refuse switching to the shared project: ' + JSON.stringify(switched)).toBeTruthy();
  const sessList = B.page.locator('#sess-list');
  await expect(sessList).toBeAttached();
  await expect(sessList.locator('.sess')).not.toHaveCount(0, { timeout: 15000 });
});
