// test/e2e/findings/B12-guest-copy.spec.js — HARDWARE-SMOKE-RESULTS.md finding B12 (CRAZY SOLO, "PARTIAL
// FAIL"): "Browser guest: paste / copy / interrupt — Paste ✓, Ctrl+C interrupt ✓, copy-out ✗ (selecting
// terminal text and copying to the clipboard doesn't work in the browser guest)."
//
// C-5.8: "Inside a joined session: paste works, copy works, Ctrl+C interrupts." This drives the REAL guest
// keyboard path (share/guest.js's own window keydown listener, guest.js:758-789): focus inside #terminal,
// Ctrl+A (mod+isA -> term.selectAll()), Ctrl+C (mod+isC -> term.getSelection() -> copyText() ->
// navigator.clipboard.writeText). Nothing here calls xterm/clipboard APIs directly from the test — every step
// is a real keypress, so a focus/selection/permission regression anywhere in that chain shows up honestly.
'use strict';
const { test, expect, chromium } = require('playwright/test');
const { launchClaudible, waitForAppReady } = require('../_fixtures');

test('a browser guest can select terminal text and copy it to the clipboard (C-5.8)', async () => {
  test.fail(true, 'B12 — copy-out from the browser guest terminal does not work (HARDWARE-SMOKE-RESULTS.md)');
  test.setTimeout(60000);
  let guestBrowser = null, host = null, guestPage = null;
  try {
    guestBrowser = await chromium.launch();
    host = await launchClaudible({
      withClaude: true,
      env: { CLAUDIBLE_CLOUDFLARED: process.execPath },   // force the documented loopback fallback — hermetic, no real cloudflared/network
    });

    await page_shareLink(host);   // start a web-link share and return once #share-link is populated

    const shareLink = host.page.locator('#share-link');
    const url = await shareLink.inputValue();

    const guestContext = await guestBrowser.newContext();
    // clipboard-write is required for navigator.clipboard.writeText to succeed without a user-gesture prompt;
    // clipboard-read lets THIS spec read back what actually landed on the clipboard.
    await guestContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
    guestPage = await guestContext.newPage();
    await guestPage.goto(url);
    await expect(guestPage.locator('#name-overlay')).toBeVisible({ timeout: 10000 });
    await guestPage.locator('#name-in').fill('e2e-guest-b12');
    await guestPage.locator('#name-go').click();

    const approveModal = host.page.locator('#approve');
    await expect(approveModal).toHaveClass(/show/, { timeout: 15000 });
    await host.page.locator('#approve-yes').click();
    await expect(guestPage.locator('body')).toHaveClass(/connected/, { timeout: 15000 });

    // Real host bytes must have arrived (fake-claude's own boot banner) before there's anything to select.
    const term = guestPage.locator('#terminal');
    await expect.poll(async () => (await term.innerText()).trim().length, { timeout: 15000 }).toBeGreaterThan(0);
    const before = (await term.innerText()).trim();

    // Real keyboard path: focus the terminal, select all, copy — exactly the guest.js listener's own contract.
    await term.click();
    await guestPage.keyboard.press('Control+a');
    await guestPage.keyboard.press('Control+c');
    await guestPage.waitForTimeout(500);   // copyText()'s clipboard write is async (a Promise); give it a beat

    const clipboardText = await guestPage.evaluate(() => navigator.clipboard.readText().catch(() => ''));
    // CORRECT behavior (C-5.8): the clipboard should now hold the selected terminal text.
    expect(clipboardText.length, 'expected the clipboard to hold the copied terminal text, got: ' + JSON.stringify(clipboardText)).toBeGreaterThan(0);
    expect(before.includes(clipboardText.trim()) || clipboardText.trim().length > 0).toBe(true);
  } finally {
    if (guestPage) { try { await guestPage.context().close(); } catch {} }
    if (guestBrowser) { try { await guestBrowser.close(); } catch {} }
    if (host) await host.stop();
  }
});

// Drives the real "Share a live link" dialog to completion (same flow as share-guest.spec.js) — factored out
// only because this file has one long test and no other spec to share it with.
async function page_shareLink(host) {
  await expect(host.page).toHaveTitle(/./, { timeout: 30000 });
  await waitForAppReady(host.page);   // see _fixtures.js — <title> can resolve before app.js's own click handlers are wired up under cross-spec load
  await host.page.locator('#share-btn').click();
  await expect(host.page.locator('#namemodal')).toHaveClass(/show/, { timeout: 10000 });
  await host.page.locator('#host-name-in').fill('crazy-e2e-b12-host');
  await host.page.locator('#name-start').click();
  await expect(host.page.locator('#share-link')).toBeVisible({ timeout: 20000 });
  await expect.poll(async () => (await host.page.locator('#share-link').inputValue()) || '', { timeout: 20000 }).not.toBe('');
}
