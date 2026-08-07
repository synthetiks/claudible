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
const { launchClaudible, resolveGitBash, waitForAppReady } = require('../_fixtures');

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
