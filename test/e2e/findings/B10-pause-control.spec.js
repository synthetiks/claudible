// test/e2e/findings/B10-pause-control.spec.js — HARDWARE-SMOKE-RESULTS.md finding B10 (CRAZY SOLO, "BLOCKED —
// feature missing"): "There is NO pause control in the share UI — only 'Stop sharing.' The whole paused-mirror
// privacy feature C-5.6 describes has no user-facing entry point. Owner decision needed: build a Pause
// control, or drop C-5.6."
//
// C-5.6 (CLAUDIBLE-CONSTITUTION.md): "While the host has paused the mirror for privacy, NOTHING a guest sends
// may change anything on the host..." — the constitution's own text presupposes a pause the host can reach.
//
// FIXED: main.js now exposes a `manualPause` override (independent of the automatic isShareable() derivation —
// see derivePaused/setSharePaused) behind a new share:pause IPC, bridged as claudible.sharePause/onSharePaused.
// renderer/index.html adds #pause-btn to the chat-head-actions row (same control family as #chat-terminate,
// host-only — a joiner never sees it) and app.js's updatePauseBtn()/onSharePaused wiring keeps its Pause/Resume
// label the single source of truth, including transitions the button didn't itself cause (e.g. the host tabbing
// into a private workspace still auto-pauses, and this button reflects that too).
//
// This spec drives the REAL control end-to-end against a REAL guest browser: click #pause-btn on the host,
// confirm the host UI visibly flips to "paused" (the button label + the #livebar itself), confirm the guest
// page's own existing paused-mirror treatment (#paused-ov) appears, and — the actual C-5.6 guarantee — that
// typing AND pasting from the guest while paused change nothing on the host. Resuming is then proven to be a
// real un-pause, not just a UI label flip: a marker typed after Resume DOES land on the host, so the earlier
// non-arrival during the pause is proven to be the pause itself, not some unrelated broken input path.
'use strict';
const { test, expect, chromium } = require('playwright/test');
const { launchClaudible, waitForAppReady, listDescendantPids } = require('../_fixtures');

test('a Pause control exists in the share UI and actually blocks the guest while paused (B10 / C-5.6)', async () => {
  test.setTimeout(150000);   // host+guest handshake, THEN a pause/type/paste/resume/type round trip on top of it
  let guestBrowser = null, host = null, guestPage = null;
  try {
    guestBrowser = await chromium.launch();
    host = await launchClaudible({
      withClaude: true,
      env: { CLAUDIBLE_CLOUDFLARED: process.execPath },   // force the documented loopback fallback — hermetic, no real cloudflared/network
    });
    await expect(host.page).toHaveTitle(/./, { timeout: 30000 });
    await waitForAppReady(host.page);   // <title> can resolve before app.js's own click handlers are wired up under cross-spec load

    // Wait for the fake-claude pty so there is something live to share (same poll as share-guest.spec.js).
    let descendants = [];
    const spawnDeadline = Date.now() + 15000;
    while (Date.now() < spawnDeadline && descendants.length === 0) {
      descendants = listDescendantPids(host.pid);
      if (descendants.length === 0) await new Promise((r) => setTimeout(r, 500));
    }
    expect(descendants.length, 'expected the fake-claude shim to have spawned before sharing').toBeGreaterThan(0);

    // main.js's mirror stays PAUSED (isShareable(mirrorWs()) false) for the default local workspace until it
    // opts in to screen-share — same gate B12-guest-copy.spec.js drives around, and independent of the manual
    // Pause control this spec is actually testing.
    await expect.poll(() => host.page.evaluate(async () => {
      const r = await globalThis.claudible.workspaceSetShared(activeWsId, true);
      return !!(r && r.ok);
    }), { timeout: 10000 }).toBe(true);

    // ---- host: drive the REAL share dialog, CO-DRIVE on (view-only is checked by default — uncheck it, since
    // this spec needs the guest to actually be able to type/paste for the pause-blocks-input assertion to mean
    // anything at all). ----
    await host.page.locator('#share-btn').click();
    await expect(host.page.locator('#namemodal')).toHaveClass(/show/, { timeout: 10000 });
    await host.page.locator('#host-name-in').fill('crazy-e2e-b10');
    // #share-ro is a real checkbox but visually hidden (`.toggle input{display:none}` — index.html:489); the
    // clickable surface is its label (#ro-toggle), same as a real user would use.
    const roToggle = host.page.locator('#share-ro');
    if (await roToggle.isChecked()) await host.page.locator('#ro-toggle').click();
    await host.page.locator('#name-start').click();
    const shareLink = host.page.locator('#share-link');
    await expect(shareLink).toBeVisible({ timeout: 20000 });
    await expect.poll(async () => (await shareLink.inputValue()) || '', { timeout: 20000 }).not.toBe('');
    const url = await shareLink.inputValue();

    // ---- guest: a REAL Playwright browser context (not another Electron window) ----
    const guestContext = await guestBrowser.newContext();
    guestPage = await guestContext.newPage();
    await guestPage.goto(url);
    await expect(guestPage.locator('#name-overlay')).toBeVisible({ timeout: 10000 });
    await guestPage.locator('#name-in').fill('e2e-guest-b10');
    await guestPage.locator('#name-go').click();

    const approveModal = host.page.locator('#approve');
    await expect(approveModal).toHaveClass(/show/, { timeout: 15000 });
    await host.page.locator('#approve-yes').click();
    await expect(guestPage.locator('body')).toHaveClass(/connected/, { timeout: 15000 });

    // ==== LIVE CONFIRMATION #1: the Pause control is discoverable while a share is genuinely live (this is
    // what used to be the whole spec's assertion, marked test.fail — it now must actually be visible). ====
    const pauseBtn = host.page.locator('#pause-btn');
    await expect(pauseBtn).toBeVisible({ timeout: 10000 });
    await expect(pauseBtn).toHaveText('Pause');
    await expect(pauseBtn).toHaveAttribute('aria-pressed', 'false');

    // Prove input reaches the host NORMALLY first (fake-claude echoes stdin — see B12's identical rationale),
    // so the later non-arrival during the pause is provably the pause, not a generally-broken guest keyboard.
    const hostTerm = host.page.locator('.term-host.active');
    const guestTerm = guestPage.locator('#terminal');
    const before1 = 'b10-before-pause-' + Date.now();
    await guestTerm.click();
    await guestPage.keyboard.type(before1);
    await guestPage.keyboard.press('Enter');
    await expect.poll(async () => (await hostTerm.innerText()).includes(before1), { timeout: 15000 }).toBe(true);

    // ==== ACT: click the real Pause control ====
    await pauseBtn.click();
    await expect(pauseBtn).toHaveText('Resume', { timeout: 10000 });
    await expect(pauseBtn).toHaveClass(/active/);
    await expect(pauseBtn).toHaveAttribute('aria-pressed', 'true');
    // Obvious on the host beyond just the button itself — the live bar visibly flips too (C-5.6: "obvious on
    // the host").
    await expect(host.page.locator('#livebar')).toHaveClass(/paused/, { timeout: 10000 });

    // ==== guest-side: the EXISTING paused-mirror treatment guest.js already renders (share/guest.js's
    // applyPaused → #paused-ov.show) — this spec only had to wire the host control to trigger it. ====
    await expect(guestPage.locator('#paused-ov')).toHaveClass(/show/, { timeout: 10000 });

    // ==== THE ACTUAL C-5.6 GUARANTEE: typing from the guest while paused changes nothing on the host. ====
    // No guestTerm.click() here — #paused-ov (position:absolute, inset:0, z-index:6 — share/guest.html:299)
    // now COVERS #terminal, so a real click would hang retrying against an intercepted target forever (that IS
    // arguably correct browser behavior: the terminal is genuinely un-clickable while the privacy card is up).
    // Focus from the pre-pause click above is still on xterm's own hidden helper textarea; typing continues
    // to reach it exactly as a real guest's keystrokes would.
    const typedWhilePaused = 'b10-typed-while-paused-' + Date.now();
    await guestPage.keyboard.type(typedWhilePaused);
    await guestPage.keyboard.press('Enter');
    await guestPage.waitForTimeout(1500);   // give a real (wrongly-delivered) frame time to land if the gate were broken
    await expect(hostTerm).not.toContainText(typedWhilePaused);

    // ==== …and pasting from the guest while paused changes nothing on the host either (share/server.js gates
    // BOTH 'input' and 'paste' frames on `paused`, same rule — drive the real guest paste path, not the IPC). ====
    const pastedWhilePaused = 'b10-pasted-while-paused-' + Date.now();
    await guestPage.evaluate((text) => {
      // window.DataTransfer/window.ClipboardEvent (not the bare globals) — the harness's eslint config declares
      // browser globals for evaluate() callbacks individually, and adding two more there for one spec isn't
      // worth it when `window.X` says the exact same thing and needs no config change.
      const dt = new window.DataTransfer();
      dt.setData('text/plain', text);
      const ev = new window.ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      document.getElementById('terminal').dispatchEvent(ev);
    }, pastedWhilePaused);
    await guestPage.waitForTimeout(1500);
    await expect(hostTerm).not.toContainText(pastedWhilePaused);

    // ==== ACT: Resume — proves the control is a real toggle, not a one-way switch. ====
    await pauseBtn.click();
    await expect(pauseBtn).toHaveText('Pause', { timeout: 10000 });
    await expect(pauseBtn).not.toHaveClass(/active/);
    await expect(pauseBtn).toHaveAttribute('aria-pressed', 'false');
    await expect(host.page.locator('#livebar')).not.toHaveClass(/paused/, { timeout: 10000 });
    await expect(guestPage.locator('#paused-ov')).not.toHaveClass(/show/, { timeout: 10000 });

    // Sanity: a marker typed AFTER Resume DOES land on the host — the earlier blocks were the pause, not a
    // coincidentally-broken guest keyboard for the rest of the test.
    const afterResume = 'b10-after-resume-' + Date.now();
    await guestTerm.click();
    await guestPage.keyboard.type(afterResume);
    await guestPage.keyboard.press('Enter');
    await expect.poll(async () => (await hostTerm.innerText()).includes(afterResume), { timeout: 15000 }).toBe(true);
  } finally {
    if (guestPage) { try { await guestPage.context().close(); } catch {} }
    if (guestBrowser) { try { await guestBrowser.close(); } catch {} }
    if (host) await host.stop();
  }
});
