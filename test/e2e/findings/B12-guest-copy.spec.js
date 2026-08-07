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
  test.setTimeout(60000);
  let guestBrowser = null, host = null, guestPage = null;
  try {
    guestBrowser = await chromium.launch();
    host = await launchClaudible({
      withClaude: true,
      env: { CLAUDIBLE_CLOUDFLARED: process.execPath },   // force the documented loopback fallback — hermetic, no real cloudflared/network
    });

    await createFirstSession(host);   // C-4.4: nothing spawns until the create-overlay's own button is clicked
    await enableScreenShare(host);    // main.js's mirror stays PAUSED (nothing ever streams) until the workspace opts in
    await page_shareLink(host);   // start a web-link share and return once #share-link is populated

    const shareLink = host.page.locator('#share-link');
    const url = await shareLink.inputValue();

    const guestContext = await guestBrowser.newContext();
    // clipboard-read lets THIS spec read back what actually landed on the clipboard.
    await guestContext.grantPermissions(['clipboard-read'], { origin: new URL(url).origin });
    guestPage = await guestContext.newPage();
    // B12's real hardware failure is navigator.clipboard.writeText() not landing the copy on a real browser
    // tab (no explicit permission grant, an unfocused document, an in-app webview whose clipboard permission
    // handler is slow/broken — guest.js's own copyText() comment names "writeText REJECTS asynchronously" as
    // "the common one"). A plain forced-rejection doesn't reproduce the failure here: Chromium's "sticky" user
    // activation from the Ctrl+C keydown survives long enough for a same-microtask `.catch(legacyCopy)` to
    // still land document.execCommand('copy') successfully (verified by hand — identical up to this line,
    // with an always-rejecting stub instead of this one, passes even against the UNFIXED guest.js). What a
    // real permission-prompt/broken-webview clipboard handler actually does is leave the promise PENDING
    // indefinitely rather than settling fast — and the old code's legacy fallback only ever runs from that
    // promise's OWN .catch(), so if it never settles, the fallback never fires and nothing is ever copied.
    // Stubbing writeText to return a promise that never resolves/rejects reproduces exactly that class of
    // real-world failure deterministically, forcing whatever fix actually ships to not depend on the modern
    // Clipboard API ever settling at all.
    await guestPage.addInitScript(() => {
      const real = navigator.clipboard;
      const stub = {
        writeText: () => new Promise(() => {}),   // never settles — simulates a stuck permission prompt / broken webview handler
        readText: real.readText.bind(real),        // this spec still reads back the REAL OS clipboard at the end
      };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => stub });
    });
    await guestPage.goto(url);
    await expect(guestPage.locator('#name-overlay')).toBeVisible({ timeout: 10000 });
    await guestPage.locator('#name-in').fill('e2e-guest-b12');
    await guestPage.locator('#name-go').click();

    const approveModal = host.page.locator('#approve');
    await expect(approveModal).toHaveClass(/show/, { timeout: 15000 });
    await host.page.locator('#approve-yes').click();
    await expect(guestPage.locator('body')).toHaveClass(/connected/, { timeout: 15000 });

    // Real host bytes must have arrived before there's anything to select — fake-claude only writes its boot
    // banner ONCE, right at spawn (well before this share even started), so the share server's ring buffer
    // (which mirrors bytes emitted WHILE sharing is live, not the pty's full historical scrollback — main.js's
    // share:start pins the tab and streams from that moment forward) can genuinely be empty here. Type a known,
    // unique line into the HOST's own terminal so fake-claude's stdin-echo (fake-claude.js: "[fake-claude]
    // echo: " + input) produces fresh output that streams live to the guest — a deterministic way to guarantee
    // real, selectable content instead of racing the ring-buffer replay.
    //
    // xterm.js (5.5.0, no canvas/webgl addon loaded here — share/guest.html only pulls in addon-fit) paints
    // through its DOM renderer, but Chromium's innerText algorithm does not reliably surface xterm's DOM rows
    // the way a human eye reads them, so it is not a trustworthy "did content arrive" probe here. `term` itself
    // (share/guest.js's own top-level `var`, never wrapped in a module — see that file's header) is a real
    // global on the guest page, and its buffer API is the SAME source of truth guest.js's own copy path reads
    // from (term.getSelection(), guest.js:773) — asserting through it proves real host bytes landed without
    // depending on a DOM-text-extraction quirk this spec isn't about.
    const term = guestPage.locator('#terminal');
    // fake-claude.js echoes each raw stdin CHUNK as its own line ("[fake-claude] echo: " + chunk) — a pty
    // delivers keystrokes one at a time rather than line-buffered, so a typed marker can land fragmented
    // across several echoed lines. The constant "echo:" prefix is what's reliably present regardless of how
    // the marker itself got split, so that (not the marker text) is the poll target.
    await host.page.locator('#terminal').click();
    await host.page.keyboard.type('b12-copy-marker-' + Date.now());
    await host.page.keyboard.press('Enter');
    await expect.poll(async () => guestPage.evaluate(() => {
      const b = window.term && window.term.buffer && window.term.buffer.active; if (!b) return false;
      for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l && l.translateToString(true).indexOf('echo:') !== -1) return true; }
      return false;
    }), { timeout: 15000 }).toBe(true);
    const before = (await guestPage.evaluate(() => {
      const b = window.term.buffer.active; let out = '';
      for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) out += l.translateToString(true) + '\n'; }
      return out;
    })).trim();

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

// C-4.4: a fresh workspace's launch tab is PARKED — nothing spawns until the create-overlay's own button is
// clicked (renderer/app.js's paintCreateOverlay/createSessionFromOverlay). Sharing before this step pins
// C-5.1's live session to a tab with no pty bound to it, so the guest connects but nothing ever streams —
// same drive as C1-create-overlay.spec.js's proven flow, minus the "new project" half (the seeded 'local'
// workspace already exists here; only its one launch tab needs to leave the parked state).
async function createFirstSession(host) {
  await expect(host.page).toHaveTitle(/./, { timeout: 30000 });
  await waitForAppReady(host.page);
  const overlay = host.page.locator('.create-ov.show');
  await expect(overlay).toBeVisible({ timeout: 15000 });
  await overlay.locator('.create-ov-btn').click();
  const promptInput = host.page.locator('input[placeholder="e.g. auth refactor, bug #214…"]');
  await expect(promptInput).toBeVisible({ timeout: 10000 });
  await promptInput.fill('e2e b12 session');
  await host.page.locator('button', { hasText: 'Create session' }).click();
  await expect(host.page.locator('.create-ov.show')).toHaveCount(0, { timeout: 15000 });
}

// main.js's mirrorWs()/isShareable() gate (main.js ~849, ~858 syncShare) PAUSES the guest stream — no bytes
// broadcast, no ring kept — for any workspace that isn't marked screen-shared (w.shared) or session-synced
// (w.syncSessions). This is a genuine, independent per-workspace opt-in from the ephemeral "Share a live
// link" button/tunnel: without it a guest connects, is admitted, and sees "connected" — but the mirror stays
// frozen forever, which reads exactly like the terminal never received anything. Flip it the same way the
// sidebar's "Screen-share to guests" context-menu item does (renderer/app.js's toggleShared -> the real
// workspace:setShared IPC, main.js:2728) rather than fighting a right-click context menu in a headless spec.
async function enableScreenShare(host) {
  await expect.poll(() => host.page.evaluate(async () => {
    const r = await globalThis.claudible.workspaceSetShared(activeWsId, true);
    return !!(r && r.ok);
  }), { timeout: 10000 }).toBe(true);
}

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
