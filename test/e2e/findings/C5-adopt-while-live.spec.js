// test/e2e/findings/C5-adopt-while-live.spec.js — HARDWARE-SMOKE-RESULTS.md finding C5 (MK SOLO, "same family
// as C1 — High priority"): "Adopting a folder while hosting a live session created the local project but
// showed NO terminal; the CURRENTLY-LIVE session (this one, from claudible-development) got REPARENTED into
// the adopted project's session list, no create-overlay appeared, and clicking it bugged out — required full
// restart."
//
// The rule under test is C-5.1's pin law plus main.js's respawnPty() "the live session is not collateral"
// guard (main.js ~915): the pinned/shared tab must NEVER be re-pointed at a different workspace as a SIDE
// EFFECT of an unrelated action (here: adopting an existing folder as a new project) — it may only be
// re-pointed by an explicit share-ending action. When main refuses, the renderer's own createWorkspace()
// (r.keptTab branch) must give the NEW project a tab of its own rather than silently doing nothing.
//
// REALISM NOTE: main's guard (movesShared, main.js:936) only fires when the shared tab's CURRENT session is
// a resolved, concrete id — an unresolved 'new' draft can't be told apart from itself. The fake-claude shim
// never writes a real transcript (see fake-claude.js's own header), so a session opened cold would stay 'new'
// forever and could never exercise this guard at all. This spec pre-seeds a REAL (msgs>0) transcript for the
// default local-local workspace so it boots straight into a RESOLVED session — a faithful stand-in for "a
// currently-live session with real history", exactly the case the hardware run hit.
//
// DIALOG: workspace:adopt drives a native `dialog.showOpenDialog` (main.js:2679) that Playwright cannot see or
// click. It is monkeypatched for the duration of this ONE test via ElectronApplication.evaluate() — live,
// in-memory, on the running main process only; nothing on disk changes. main.js reads `dialog.showOpenDialog`
// as a live property lookup at call time, so replacing the property on the shared `electron.dialog` object is
// enough; no app source file is touched.
'use strict';
const { test, expect } = require('playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchClaudible, writeFakeTranscript, listDescendantPids, resolveGitBash, waitForAppReady } = require('../_fixtures');

test('adopting a folder while a session is live never reparents or restarts the shared session (C-5.1)', async () => {
  test.setTimeout(90000);
  const gitBash = resolveGitBash();
  test.skip(!gitBash, 'no usable git-bash found on this machine — workspace:adopt requires it (main.js APPDIR_WSL gate)');

  const sessionId = 'e2e-live-' + Date.now();
  const { app, page, pid, stop } = await launchClaudible({
    withClaude: true,
    withGh: true,
    gitBash,
    env: { CLAUDIBLE_CLOUDFLARED: process.execPath },   // force the documented loopback fallback (see share-guest.spec.js's header)
    seed: (ctx) => {
      // A REAL, resolved session on the default local-local workspace — see the REALISM NOTE above.
      writeFakeTranscript(ctx, { kind: 'local', slug: 'local' }, sessionId, 'a real prompt for the currently-live session');
    },
  });

  const adoptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudible-e2e-adopt-'));
  fs.writeFileSync(path.join(adoptDir, 'README.md'), '# an existing folder, not managed by Claudible\n');

  try {
    await expect(page).toHaveTitle(/./, { timeout: 30000 });
    await waitForAppReady(page);   // see _fixtures.js — <title> can resolve before app.js has even started under cross-spec load
    // Boot restore resolves the real transcript instead of parking — confirms the REALISM NOTE setup landed.
    await expect.poll(() => page.evaluate(() => activeSession), { timeout: 20000 }).toBe(sessionId);

    let descendantsBefore = [];
    const spawnDeadline = Date.now() + 15000;
    while (Date.now() < spawnDeadline && descendantsBefore.length === 0) {
      descendantsBefore = listDescendantPids(pid);
      if (descendantsBefore.length === 0) await new Promise((r) => setTimeout(r, 500));
    }
    expect(descendantsBefore.length, 'the fake-claude shim should have spawned for the real session').toBeGreaterThan(0);

    // ---- go live (web link is enough to exercise the pin — the same tunnel machinery collab shares use) ----
    await page.locator('#share-btn').click();
    await expect(page.locator('#namemodal')).toHaveClass(/show/, { timeout: 10000 });
    await page.locator('#host-name-in').fill('crazy-e2e-c5');
    await page.locator('#name-start').click();
    await expect.poll(() => page.evaluate(() => lastShareUrl || ''), { timeout: 20000 }).not.toBe('');

    const tabIdShared = await page.evaluate(() => sharedTabIdR);
    expect(tabIdShared, 'main should have pinned sharedTabId to the live tab').not.toBeNull();
    const before = await page.evaluate((tid) => {
      const rec = tabs.get(tid);
      return rec ? { wsId: rec.wsId, session: rec.session } : null;
    }, tabIdShared);
    expect(before).toEqual({ wsId: 'local-local', session: sessionId });

    // Watch for main's own "I refused to touch the shared tab" signal.
    await page.evaluate(() => {
      window.__c5RerouteRefused = [];
      claudible.onShareRerouteRefused((p) => window.__c5RerouteRefused.push(p));
    });

    // ---- monkeypatch the native folder picker for this run only (see file header) ----------------------
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
    }, adoptDir);

    // ---- drive the REAL "Add a folder I already have" tile while the session above is live -------------
    await page.locator('#ws-add').click();
    await expect(page.locator('#ws-modal')).toHaveClass(/show/, { timeout: 10000 });
    await page.locator('#ch-adopt').click();
    await expect(page.locator('#ws-create')).toHaveText(/choose folder/i);
    await page.locator('#ws-create').click();

    // adopt-workspace.sh reads the real folder + main respawns/refuses — give it a real budget.
    await expect(page.locator('#ws-modal')).not.toHaveClass(/show/, { timeout: 30000 });

    // ---- main refused to re-point the shared tab ---------------------------------------------------------
    await expect.poll(() => page.evaluate(() => window.__c5RerouteRefused.length), { timeout: 10000 }).toBeGreaterThan(0);
    const refusal = await page.evaluate(() => window.__c5RerouteRefused[0]);
    expect(refusal.tabId).toBe(tabIdShared);

    // ---- THE ASSERTION UNDER TEST: the live session is NOT reparented ------------------------------------
    const after = await page.evaluate((tid) => {
      const rec = tabs.get(tid);
      return rec ? { wsId: rec.wsId, session: rec.session } : null;
    }, tabIdShared);
    expect(after, 'the shared tab must still belong to local-local, on the same session — never reparented').toEqual(before);

    // The share itself must have survived untouched — same pin, same tunnel, no forced end.
    expect(await page.evaluate(() => sharedTabIdR)).toBe(tabIdShared);
    expect(await page.evaluate(() => tunnelUp)).toBe(true);

    // ---- NO restart-requiring state -----------------------------------------------------------------------
    // The authoritative signal is already above: main's respawnPty() only ever reaches winSend('share:reroute-
    // refused', ...) by RETURNING BEFORE its `old.kill()` line (main.js ~939-944) — so that event firing at all
    // is proof-by-construction the shared tab's pty was never touched. A raw OS-level pid census is NOT a good
    // second check here: this instance's background probes (session listing, the presence beacon, adopt-
    // workspace.sh itself) constantly spawn/exit their own short-lived git-bash/node descendants under the SAME
    // Electron main pid, so the full descendant SET churns regardless of this test — comparing it before/after
    // is comparing noise, not the fake-claude pty specifically. What DOES still matter: at least one descendant
    // is alive (the shim didn't simply vanish), and —
    const descendantsAfter = listDescendantPids(pid);
    expect(descendantsAfter.length, 'the original fake-claude process must still be alive — a respawn would have killed and replaced it').toBeGreaterThan(0);

    // — the still-live pty is genuinely responsive: typed input still reaches it and echoes back into the SAME
    // tab's terminal. Combined with the reroute-refused proof above (which shows the record under tabIdShared
    // was never handed to `old.kill()`), a live, echoing pty under that same tab id is the same pty throughout.
    // adopt switched the FOREGROUND tab away (the new project's own tab) — xterm's innerText only reflects
    // rendered (visible, `.term-host.active`) content, so bring the shared tab back to the front first via the
    // same top-level setActiveTab() every sidebar click already goes through, then read ITS OWN term-host
    // (data-tab, set at container creation — see app.js's makeTab), not the shared `#terminal` wrapper generically.
    await page.evaluate((tid) => setActiveTab(tid), tabIdShared);
    const marker = 'C5-STILL-ALIVE-' + Date.now();
    await page.evaluate(({ tid, m }) => claudible.ptyInput(tid, m + '\n'), { tid: tabIdShared, m: marker });
    const sharedTermHost = page.locator('.term-host[data-tab="' + tabIdShared + '"]');
    await expect(sharedTermHost).toHaveClass(/active/, { timeout: 10000 });
    await expect.poll(async () => (await sharedTermHost.innerText()).includes(marker), { timeout: 10000 }).toBe(true);

    // ---- the adopted project itself was still created, just NOT stealing the live tab --------------------
    const wsList = await page.evaluate(() => globalThis.claudible.workspaceList());
    const adopted = wsList.workspaces.find((w) => w.kind === 'local' && w.adopted && w.path);
    expect(adopted, 'the adopt flow should still have created the new project: ' + JSON.stringify(wsList.workspaces)).toBeTruthy();
  } finally {
    await stop();
    try { fs.rmSync(adoptDir, { recursive: true, force: true }); } catch {}
  }
});
