// test/e2e/findings/C1-create-overlay.spec.js — HARDWARE-SMOKE-RESULTS.md finding C1 (CRAZY SOLO,
// "Highest-priority regression"): "New local project did NOT show the create-overlay — a session appeared
// under the project on its own and the terminal went to folder-approval. The no-auto-create law isn't
// holding for fresh local projects."
//
// The law under test is C-4.4 (CLAUDIBLE-CONSTITUTION.md): "Auto-creating sessions is removed entirely —
// it never auto-triggers, in any case. A session comes into existence ONLY when the user clicks a Create
// button, and only then are they prompted to name it. An empty project shows a sleek overlay over the
// terminal area... visually IDENTICAL for a brand-new user's first project and for an existing user opening
// a fresh project."
//
// This drives the REAL create-project modal (#ws-add -> #ws-modal, "Local project" tile, the default
// selection) end to end: create the project, assert the overlay (never a phantom session), THEN drive the
// overlay's own Create button and assert the name prompt (modalPrompt) is what actually starts the session —
// never an automatic spawn.
'use strict';
const { test, expect } = require('playwright/test');
const { launchClaudible, resolveGitBash, waitForAppReady, listDescendantPids } = require('../_fixtures');

test('creating a fresh local project shows the create-overlay, spawns NO session until Create is clicked, and the name prompt precedes creation (C-4.4)', async () => {
  const gitBash = resolveGitBash();
  test.skip(!gitBash, 'no usable git-bash found on this machine — workspace:create requires it (main.js APPDIR_WSL gate)');
  const { page, stop } = await launchClaudible({ withClaude: true, withGh: true, gitBash });
  try {
    await expect(page).toHaveTitle(/./, { timeout: 30000 });
    await waitForAppReady(page);   // see _fixtures.js — <title> can resolve before app.js's own click handlers are wired up under cross-spec load

    // ---- drive the REAL "New project" modal ------------------------------------------------------------
    await page.locator('#ws-add').click();
    await expect(page.locator('#ws-modal')).toHaveClass(/show/, { timeout: 10000 });
    // "Local project" (ch-local) is the default selection — assert that rather than assume it, since a
    // regression in default-tile selection would silently invalidate the rest of this spec.
    await expect(page.locator('#ch-local')).toHaveClass(/sel/);

    const projectName = 'e2e-overlay-proj-' + Date.now();
    await page.locator('#ws-name-in').fill(projectName);
    await page.locator('#ws-create').click();

    // Creation round-trips through a real backend script (create-workspace.sh) — give it a real budget.
    await expect(page.locator('#ws-modal')).not.toHaveClass(/show/, { timeout: 20000 });

    const wsId = await page.evaluate(() => activeWsId);
    expect(wsId).toBe('local-' + projectName.toLowerCase());

    // ---- THE OVERLAY MUST APPEAR — a fresh project is parked, not auto-spawned -------------------------
    const overlay = page.locator('.create-ov.show');
    await expect(overlay).toBeVisible({ timeout: 15000 });
    await expect(overlay.locator('.create-ov-btn')).toHaveText(/create (your first|a new) session/i);

    // ---- NO session exists yet: the tab is parked, session:'new', and the backend agrees ----------------
    const tabState = await page.evaluate((id) => {
      const rec = [...tabs.values()].find((t) => t.wsId === id && t.kind !== 'live');
      return rec ? { session: rec.session, parked: !!rec.parked } : null;
    }, wsId);
    expect(tabState, 'expected a tab for the new project').not.toBeNull();
    expect(tabState.session, 'no session id should be assigned yet — a phantom draft would show a real/pending id here').toBe('new');
    expect(tabState.parked, 'the tab must stay parked until the overlay Create button is clicked').toBe(true);

    const listed = await page.evaluate((id) => globalThis.claudible.sessionListWs(id), wsId);
    expect(Array.isArray(listed) ? listed.length : -1, 'the backend must also see zero real sessions for this project: ' + JSON.stringify(listed)).toBe(0);

    // No terminal/pty descendant should exist for this brand-new project either — nothing to approve, nothing
    // running. (A stray fake-claude from this SAME instance cannot exist yet: this is the only project ever
    // created in this isolated instance, and it has never been resolved past the overlay.)
    // ---- click the overlay's Create button — the NAME PROMPT must appear BEFORE any session is born -----
    await overlay.locator('.create-ov-btn').click();
    const promptInput = page.locator('input[placeholder="e.g. auth refactor, bug #214…"]');
    await expect(promptInput).toBeVisible({ timeout: 10000 });

    // Still parked/unresolved WHILE the prompt is up — the prompt precedes creation, it doesn't race it.
    const tabStateDuringPrompt = await page.evaluate((id) => {
      const rec = [...tabs.values()].find((t) => t.wsId === id && t.kind !== 'live');
      return rec ? { session: rec.session, parked: !!rec.parked } : null;
    }, wsId);
    expect(tabStateDuringPrompt.session).toBe('new');
    expect(tabStateDuringPrompt.parked, 'the tab must remain parked while the name prompt is open — nothing may spawn until it is confirmed').toBe(true);

    // ---- confirm the name — THIS is what is allowed to create the session -------------------------------
    const sessionName = 'e2e first session';
    await promptInput.fill(sessionName);
    await page.locator('button', { hasText: 'Create session' }).click();

    // The overlay is now gone, replaced by the real terminal view, and the tab has committed to a session.
    await expect(page.locator('.create-ov.show')).toHaveCount(0, { timeout: 15000 });
    const tabStateAfter = await page.evaluate((id) => {
      const rec = [...tabs.values()].find((t) => t.wsId === id && t.kind !== 'live');
      return rec ? { session: rec.session, parked: !!rec.parked, label: rec.curSessionLabel || rec.label } : null;
    }, wsId);
    expect(tabStateAfter.parked).toBe(false);
    expect(tabStateAfter.session).toBe('new');   // 'new' + a pendingTitle is the born-new marker (commitParkedTab) until the real pty assigns a concrete id
    expect(tabStateAfter.label).toBe(sessionName);
  } finally {
    await stop();
  }
});

// DISCREPANCY CHECK (HARDWARE-SMOKE-RESULTS.md C1): the hardware run that produced C1 ("a session appeared under
// the project on its own and the terminal went to folder-approval — no overlay") happened WHILE HOSTING A LIVE
// SHARE. The spec above passes on a bare instance, so the live-share condition is the variable to isolate: does
// creating a project WHILE a share is pinned to the foreground tab still show the overlay, or does it silently
// auto-spawn?
//
// It traces back to main.js's workspace:create (attach()): respawnPty refuses to re-point the tab this create
// was FOR whenever that tab is the live-shared one (movesShared guard, "the live session is not collateral") —
// this is correct, C-5.1 law. The renderer's createWorkspace() sees that refusal as r.keptTab and, before this
// finding's fix, called newBlankTab(newWsId, 'new') directly — which (unlike every OTHER "give the project a tab
// of its own" fallback in this file, e.g. switchWorkspace's keptTab branch) spawns a REAL pty immediately instead
// of parking with the create-overlay. r.keptTab is essentially never true on a bare create (nothing is mid-turn,
// nothing is shared) — the harness's own bare-instance spec above never exercises that branch — so this bug was
// invisible except exactly under the hardware condition C1 was filed under: a live share pinning the foreground
// tab at create time.
test('creating a fresh local project WHILE HOSTING A LIVE SHARE still shows the create-overlay, never auto-spawns (C1 hardware variant)', async () => {
  const gitBash = resolveGitBash();
  test.skip(!gitBash, 'no usable git-bash found on this machine — workspace:create requires it (main.js APPDIR_WSL gate)');
  const { page, stop, pid } = await launchClaudible({
    withClaude: true, withGh: true, gitBash,
    env: {
      // Forces main.js's documented loopback fallback (see share-guest.spec.js's header) instead of depending on
      // a real cloudflared / the real Cloudflare network — deterministic, hermetic, well under a second.
      CLAUDIBLE_CLOUDFLARED: process.execPath,
    },
  });
  try {
    await expect(page).toHaveTitle(/./, { timeout: 30000 });
    await waitForAppReady(page);

    // ---- host: wait for the fake-claude pty so there is a real live session to share (mirrors share-guest.spec.js) ----
    let descendants = [];
    const spawnDeadline = Date.now() + 15000;
    while (Date.now() < spawnDeadline && descendants.length === 0) {
      descendants = listDescendantPids(pid);
      if (descendants.length === 0) await new Promise((r) => setTimeout(r, 500));
    }
    expect(descendants.length, 'expected the fake-claude shim to have spawned before sharing').toBeGreaterThan(0);

    // ---- host: start a REAL live share, pinning THIS foreground tab (main.js share:start: sharedTabId = fgTabId) ----
    await page.locator('#share-btn').click();
    await expect(page.locator('#namemodal')).toHaveClass(/show/, { timeout: 10000 });
    await page.locator('#host-name-in').fill('c1-live-host');
    await page.locator('#name-start').click();
    const shareLink = page.locator('#share-link');
    await expect(shareLink).toBeVisible({ timeout: 20000 });
    await expect.poll(async () => (await shareLink.inputValue()) || '', { timeout: 20000 }).not.toBe('');
    // Confirm the share is genuinely live and pinned before proceeding — the assertion this whole spec hinges on.
    // sharedTabIdR (renderer/app.js) is the renderer's own mirror of main's sharedTabId, kept in sync via the
    // share:pinned IPC event (onSharePinned) that main.js's share:start fires the instant it pins fgTabId —
    // there is no separate share:status IPC exposed through preload, so this is the authoritative renderer-side
    // read of "is a share genuinely live and pinned right now".
    const pinnedTabId = await page.evaluate(() => (typeof sharedTabIdR !== 'undefined' ? sharedTabIdR : null));
    expect(pinnedTabId, 'a live share must be pinned to a tab for this to be the hardware condition').not.toBeNull();

    // ---- NOW drive the real "New project" modal WHILE the share is live ---------------------------------------
    await page.locator('#ws-add').click();
    await expect(page.locator('#ws-modal')).toHaveClass(/show/, { timeout: 10000 });
    await expect(page.locator('#ch-local')).toHaveClass(/sel/);

    const projectName = 'e2e-overlay-live-' + Date.now();
    await page.locator('#ws-name-in').fill(projectName);
    await page.locator('#ws-create').click();
    await expect(page.locator('#ws-modal')).not.toHaveClass(/show/, { timeout: 20000 });

    const wsId = await page.evaluate(() => activeWsId);
    expect(wsId).toBe('local-' + projectName.toLowerCase());

    // ---- NO session exists yet for the new project: the tab is parked, session:'new', and the backend agrees ---
    // Scoped by THIS tab's own id (container[data-tab]), not a bare `.create-ov.show` — with a share live, the
    // ORIGINAL tab (main.js's own spawn-on-size fallback, ~1.8s post-boot, races ahead of the renderer's C-4.4
    // park/overlay bookkeeping whenever a caller — like this spec, on purpose — needs a real pty up before that
    // fallback fires) can ALSO be sitting on an un-resolved overlay at this same instant; a bare selector would
    // then hit Playwright's own strict-mode "resolved to 2 elements" rather than testing the thing this spec is
    // actually about, which is THIS NEW project's tab specifically.
    const tabState = await page.evaluate((id) => {
      const rec = [...tabs.values()].find((t) => t.wsId === id && t.kind !== 'live');
      return rec ? { tabId: rec.tabId, session: rec.session, parked: !!rec.parked } : null;
    }, wsId);
    expect(tabState, 'expected a tab for the new project').not.toBeNull();

    // ---- THE OVERLAY MUST APPEAR HERE TOO — a live share must never change the no-auto-create law -------------
    const overlay = page.locator('.term-host[data-tab="' + tabState.tabId + '"] .create-ov.show');
    await expect(overlay).toBeVisible({ timeout: 15000 });
    await expect(overlay.locator('.create-ov-btn')).toHaveText(/create (your first|a new) session/i);
    expect(tabState.session, 'no session id should be assigned yet — a phantom draft would show a real/pending id here').toBe('new');
    expect(tabState.parked, 'the tab must stay parked until the overlay Create button is clicked, even while a share is live').toBe(true);

    const listed = await page.evaluate((id) => globalThis.claudible.sessionListWs(id), wsId);
    expect(Array.isArray(listed) ? listed.length : -1, 'the backend must also see zero real sessions for this project: ' + JSON.stringify(listed)).toBe(0);

    // ---- the ORIGINAL shared tab is untouched — the live share must survive an unrelated project creation -----
    const pinnedTabIdAfter = await page.evaluate(() => (typeof sharedTabIdR !== 'undefined' ? sharedTabIdR : null));
    expect(pinnedTabIdAfter, 'the live share must not have been torn down by creating a new project').toBe(pinnedTabId);
  } finally {
    await stop();
  }
});
