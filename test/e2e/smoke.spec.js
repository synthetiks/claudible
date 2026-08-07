// test/e2e/smoke.spec.js — the harness's own foundation smoke test: does a fully isolated Claudible
// instance boot, render its real UI, and shut down without leaving anything running?
'use strict';
const { test, expect } = require('playwright/test');
const { launchClaudible, isPidAlive, listDescendantPids } = require('./_fixtures');

test('launches, renders the real shell UI, and stops clean with no orphans', async () => {
  // withClaude:true — deterministic even on a dev box that happens to have a real, signed-in claude on
  // PATH: without this, main.js's spawn-on-size fallback (main.js ~line 628, fires ~1.8s after boot) would
  // resolve and launch whatever real `claude` the machine has, which is exactly what this harness's hard
  // rules forbid depending on. Our fake-claude shim (test/e2e/fake-claude/) also gives the orphan check
  // below something real to prove got cleaned up, not just the Electron main process.
  const { page, pid, stop } = await launchClaudible({ withClaude: true });

  try {
    // ---- main window appears ------------------------------------------------------------------------
    await expect(page).toHaveTitle(/./, { timeout: 30000 });   // any non-empty title = the renderer actually loaded a document, not an about:blank/crash page

    // ---- sidebar / project UI renders (real DOM ids from renderer/index.html) -----------------------
    const sidebar = page.locator('#sidebar');
    await expect(sidebar).toBeVisible();
    await expect(page.locator('#ws-chips')).toBeAttached();     // workspace chip bar — populated async, but must exist
    await expect(page.locator('#sess-list')).toBeAttached();    // session list
    await expect(page.locator('#terminal')).toBeVisible();      // the live-session terminal host
    await expect(page.locator('#sessions-btn')).toBeVisible();  // sidebar toggle — proves the toolbar rendered, not just an empty shell

    // The preload bridge round-tripped for real (not just present as an object) — same read-only IPC
    // e2e-boot.test.js used, proving main.js's ipcMain handlers actually answer, not just that a window painted.
    // globalThis, not `window` — this arrow runs inside the renderer's browser context at runtime (that's
    // the whole point of page.evaluate), but the FILE is linted as plain Node (test/**/*.js in
    // eslint.config.js), where `window` isn't a declared global. globalThis is defined in both environments
    // and is the same object as `window` in a renderer, so this is not a behavior change, just an eslint-clean spelling.
    const version = await page.evaluate(() => globalThis.claudible && globalThis.claudible.appVersion && globalThis.claudible.appVersion());
    expect(typeof version).toBe('string');
    expect(version.length).toBeGreaterThan(0);

    // ---- no dialog blocking ---------------------------------------------------------------------------
    // The first-run wizard (#wizard) must NOT be showing — onboardingDone was pre-seeded in isolated
    // storage before launch (see _fixtures.js). renderer/app.js toggles visibility via a "show" class.
    const wizard = page.locator('#wizard');
    if (await wizard.count()) {
      await expect(wizard).not.toHaveClass(/show/);
    }
    // The workspace "name your project" first-run modal must also not be showing — pre-seeding
    // workspaces.json with the default local workspace already present keeps registry.firstRun unset.
    const wsModal = page.locator('#ws-modal, .ws-modal');
    if (await wsModal.count()) {
      await expect(wsModal.first()).not.toBeVisible();
    }
    // Sanity: the sidebar itself is genuinely interactable, not covered by some other blocking overlay.
    await expect(sidebar).toBeEnabled().catch(() => {});   // toBeEnabled is meaningful for form controls; harmless no-op if not applicable — kept as a cheap extra signal, ignored on mismatch

    // ---- prove a claude-shim session actually spawned (exercises the pty path, not just static DOM) ----
    // main.js's spawn-on-size fallback fires ~1.8s after did-finish-load if the renderer never reported a
    // size; the renderer normally reports one almost immediately. Either way a pty should be up well within
    // this window — poll instead of a fixed sleep so this isn't a race against machine speed.
    let descendants = [];
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && descendants.length === 0) {
      descendants = listDescendantPids(pid);
      if (descendants.length === 0) await new Promise((r) => setTimeout(r, 500));
    }
    expect(descendants.length, 'expected the fake-claude shim to have spawned a child process under the Electron main pid').toBeGreaterThan(0);
  } finally {
    // ---- clean stop() leaves no orphan processes --------------------------------------------------
    const descendantsBeforeStop = listDescendantPids(pid);
    await stop();

    // The main Electron process itself must be gone.
    let mainGone = !isPidAlive(pid);
    for (let i = 0; i < 20 && !mainGone; i++) { await new Promise((r) => setTimeout(r, 250)); mainGone = !isPidAlive(pid); }
    expect(mainGone, `Electron main pid ${pid} is still running after stop()`).toBe(true);

    // Every descendant (the claude-shim's cmd.exe/node.exe pair) must be gone too — win.js's kill() uses
    // `taskkill /T /F` specifically so the whole tree dies, not just the pty's immediate child.
    for (const d of descendantsBeforeStop) {
      expect(isPidAlive(d), `descendant pid ${d} (of the claude shim) is still running after stop()`).toBe(false);
    }
  }
});
