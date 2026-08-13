// test/e2e/share-guest.spec.js — mission task 3: drive the REAL "Share a live link" dialog on a host
// instance, extract the minted URL, open it in a genuine Playwright BROWSER context (not another Electron
// window) as the guest, drive the host's approval, and assert the guest page actually connects and mirrors.
//
// TUNNEL INVESTIGATION (per the mission): share:start (main.js:1345) refuses OUTRIGHT — no share at all —
// only when cloudflared is genuinely MISSING (main.js:1387-1391, reason:'missing'). Any OTHER tunnel failure
// (spawned but never registered, no URL, DNS never published, …) falls through to a LOOPBACK link instead:
// `base` stays `http://127.0.0.1:${port}` and share:start still resolves {ok:true, url: base+'/?t=..&sid=..'}
// (main.js:1394-1398) — the exact link the renderer's #share-link shows (renderer/app.js:2312 `showLink
// (lastShareUrl)`, where lastShareUrl is that same `r.url`). So YES, a share can run on localhost without a
// working cloudflared — main.js:1369 unconditionally starts the local share server first; the tunnel is only
// ever the LAST hop to the public internet.
//
// This harness deliberately FORCES that loopback path rather than depending on real cloudflared / the real
// Cloudflare network (this dev box happens to have a real cloudflared installed — verified once, then
// intentionally NOT relied on, to keep this spec hermetic and fast): CLAUDIBLE_CLOUDFLARED is pointed at this
// harness's OWN node.exe (env.CLAUDIBLE_CLOUDFLARED — share/cloudflared.js:33, checked FIRST, before any real
// install). `node.exe tunnel --no-autoupdate --url ...` is not a script node can run — it exits near-instantly
// with a MODULE_NOT_FOUND error on stderr, printing nothing that matches the trycloudflare.com URL pattern
// (share/cloudflared.js:26). awaitUrl's 'exit' handler then rejects with no `.reason` set, main.js's catch
// defaults `reason` to 'unverified' (NOT 'missing'), and share:start falls straight through to the loopback
// link — deterministically, in well under a second, with zero real network calls. A real guest browser can
// reach that http://127.0.0.1:<port> URL directly; only a REMOTE guest on another network could not, and this
// spec's guest is (honestly, by design) same-machine — the loopback IS "whatever is reachable" here.
'use strict';
const { test, expect, chromium } = require('playwright/test');
const { launchClaudible, listDescendantPids } = require('./_fixtures');

test('host shares a live link; a real browser guest connects, is approved, and mirrors the terminal', async () => {
  // A DEDICATED chromium instance, launched and closed entirely within this test — not the `browser` fixture
  // parameter, which Playwright keeps alive for the whole WORKER (i.e. across every spec file in this run,
  // since playwright.config.js pins workers:1). Left running, it competed for CPU with smoke.spec.js's own
  // orphan-process teardown right after this spec, tightening that spec's already-un-retried post-stop() pid
  // check enough to flake under combined-suite runs (never in isolation). Owning the full lifecycle here keeps
  // every other spec's timing exactly what it would be if this file never ran.
  let guestBrowser = null, host = null, guestPage = null;
  try {
    guestBrowser = await chromium.launch();
    host = await launchClaudible({
      withClaude: true,   // a live pty tab is what gets shared — see the fake-claude shim's own rationale
      env: {
        // See the file header — this deliberately forces main.js's documented loopback fallback instead of a
        // real (or real-but-unregistered) cloudflared tunnel.
        CLAUDIBLE_CLOUDFLARED: process.execPath,
      },
    });

    // ---- host: wait for the fake-claude pty so there is something live to share (same poll as smoke.spec.js) ----
    let descendants = [];
    const spawnDeadline = Date.now() + 15000;
    while (Date.now() < spawnDeadline && descendants.length === 0) {
      descendants = listDescendantPids(host.pid);
      if (descendants.length === 0) await new Promise((r) => setTimeout(r, 500));
    }
    expect(descendants.length, 'expected the fake-claude shim to have spawned before sharing').toBeGreaterThan(0);

    // ---- host: drive the REAL share dialog (renderer/app.js's shareBtn -> namemodal -> doStartSharing) ----
    await host.page.locator('#share-btn').click();
    await expect(host.page.locator('#namemodal')).toHaveClass(/show/, { timeout: 10000 });
    await host.page.locator('#host-name-in').fill('crazy-e2e-host');
    await host.page.locator('#name-start').click();

    // doStartSharing() sets shareOut to 'creating your live link…' then, on success, calls showLink() which
    // sets #share-link.value and shows it (renderer/app.js:2220 showLink, :2311-2317). Our forced-loopback
    // cloudflared exits near-instantly, so this should resolve in well under the share dialog's own budget.
    const shareLink = host.page.locator('#share-link');
    await expect(shareLink).toBeVisible({ timeout: 20000 });
    await expect.poll(async () => (await shareLink.inputValue()) || '', { timeout: 20000 }).not.toBe('');
    const url = await shareLink.inputValue();
    expect(url, 'share link should be a loopback URL (the forced tunnel fallback) — got: ' + url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=/);

    // ---- guest: a REAL Playwright browser context (not another Electron window) navigating to that URL ----
    const guestContext = await guestBrowser.newContext();
    guestPage = await guestContext.newPage();

    // Record what the session chip reads at the moment each server message ARRIVES — i.e. before the page's
    // own handler processes it. A listener attached from a wrapped constructor is registered ahead of the
    // page's onmessage, so the label captured alongside the first tracker push is the label the join
    // actually displayed for the whole gap between admission and the host sending any session details.
    await guestPage.addInitScript(() => {
      window.__chipTrace = [];
      const Native = window.WebSocket;
      function Traced(url, protocols) {
        const sock = protocols === undefined ? new Native(url) : new Native(url, protocols);
        sock.addEventListener('message', (ev) => {
          if (typeof ev.data !== 'string') return;
          let kind = '';
          try { kind = (JSON.parse(ev.data) || {}).type || ''; } catch (e) { return; }
          const el = document.getElementById('sess-chip-text');
          window.__chipTrace.push({ kind, label: el ? el.textContent : null });
        });
        return sock;
      }
      Traced.prototype = Native.prototype;
      ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((k) => { Traced[k] = Native[k]; });
      window.WebSocket = Traced;
    });

    await guestPage.goto(url);

    // name gate (share/guest.html #name-overlay / #name-in / #name-go)
    await expect(guestPage.locator('#name-overlay')).toBeVisible({ timeout: 10000 });
    await guestPage.locator('#name-in').fill('e2e-guest');
    await guestPage.locator('#name-go').click();

    // ---- host: approve the guest (renderer/app.js's #approve modal, showNextApproval/decideApproval) ----
    const approveModal = host.page.locator('#approve');
    await expect(approveModal).toHaveClass(/show/, { timeout: 15000 });
    await expect(host.page.locator('#approve-title')).toContainText('e2e-guest');
    await host.page.locator('#approve-yes').click();

    // ---- guest: connected + mirroring — share/guest.js's 'hello' handler (share/guest.js:591-613) clears
    // the waiting overlay, sets the status text, and marks body.connected once admitted. ----
    await expect(guestPage.locator('#overlay')).not.toHaveClass(/show/, { timeout: 15000 });
    await expect(guestPage.locator('body')).toHaveClass(/connected/, { timeout: 10000 });
    await expect(guestPage.locator('#stxt')).toHaveText(/connected/i, { timeout: 10000 });

    // The host pushes its tracker as soon as a viewer joins; until that lands the guest knows nothing about
    // the session, so the chip must not have shown anything a viewer would read as the session's name.
    await expect
      .poll(async () => guestPage.evaluate(() => window.__chipTrace.some((e) => e.kind === 'status')), { timeout: 20000 })
      .toBe(true);
    const chipTrace = await guestPage.evaluate(() => window.__chipTrace);
    const untilFirstStatus = chipTrace.slice(0, chipTrace.findIndex((e) => e.kind === 'status') + 1).map((e) => e.label);
    expect(untilFirstStatus, 'the session chip showed a name-shaped label before the host sent any session details')
      .not.toContain('live session');

    // ---- guest: the session chip must never invent a name while it waits. The chip is painted the moment the
    // socket is admitted, ~1s before the first status push carries the real session name; during that gap it
    // must read as a wait state, never as a session called "live session". Sample it tightly from the instant
    // we are connected until a real name lands (or the budget runs out), and fail on the first bad sample. ----
    {
      const chipText = guestPage.locator('#sess-chip-text');
      const seen = [];
      const chipDeadline = Date.now() + 10000;
      let named = false;
      while (Date.now() < chipDeadline && !named) {
        const t = ((await chipText.textContent()) || '').trim();
        // The first status push has landed once the chip is neither empty nor the neutral loading label. That
        // sample is the FINAL label (a genuinely unnamed session legitimately settles on "live session" there),
        // so it ends the sampling window rather than joining it — only the pre-push samples are judged.
        if (t && t !== 'loading…') { named = true; break; }
        if (t) seen.push(t);
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(seen.filter((t) => t === 'live session'),
        'the session chip showed a name-like placeholder before the first status push — samples: ' + JSON.stringify(seen)).toEqual([]);
    }

    // The scrollback ring buffer replays on hello (share/server.js:398 `if (!paused && ring.length) ws.send
    // (ring)`) — the fake-claude shim's own boot banner should already be in it by the time we got here, so a
    // real xterm terminal actually rendered real host bytes, not just an empty connected shell.
    await expect(guestPage.locator('#terminal')).toBeVisible();
    await expect
      .poll(async () => guestPage.locator('#terminal').innerHTML().then((h) => h.length), { timeout: 10000 })
      .toBeGreaterThan(0);
  } finally {
    if (guestPage) { try { await guestPage.context().close(); } catch {} }
    if (guestBrowser) { try { await guestBrowser.close(); } catch {} }
    if (host) await host.stop();
  }
});
