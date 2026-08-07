// test/e2e/findings/B1-pin-law.spec.js — HARDWARE-SMOKE-RESULTS.md finding B1 (critical, twofold), replayed
// against the owners' EXACT scenario and the C-5.1 pin law it produced:
//   "A hosts an in-app collab share on session X (drive toggleShareSession's UI), then clicks into another
//    session Y, then clicks 'Share a live link'."
// The 2026-08-07 hardware run found: (1) the second share was handed out with NO refusal, and the link showed
// X's terminal mislabeled as whatever the host clicked into — the host's foreground tab, not the pinned one;
// (2) a connected guest's view followed the host's browsing at all — design the owners ruled OUT the same day
// (C-5.1: "the share is welded to the session the host chose — it NEVER follows the host").
//
// The pin-law commits (renderer/app.js toggleShareSession + doStartSharing, both citing "C-5.1 B13 guard") were
// already on HEAD when this spec was written — per the mission, this should PASS now. It is deliberately NOT
// marked expected-fail: a red run here is itself the headline finding, not a known gap being tracked.
//
// SCOPE: "Share live" (the in-app collab toggle under a session's ▾ menu) only renders for a REPO workspace
// (renderer/app.js savedSessMenuItems: `if (aw && aw.kind === 'repo')`) — so this needs a seeded repo workspace
// with two REAL (msgs>0) sessions, X and Y, both already on disk before boot (writeFakeTranscript), and made the
// ACTIVE workspace so the sidebar actually lists them (session:list-ws only serves the active/queried workspace).
'use strict';
const { test, expect, chromium } = require('playwright/test');
const path = require('path');
const fs = require('fs');
const {
  launchClaudible, seedRepoWorkspace, writeFakeTranscript, localBareRemote, resolveGitBash, waitForAppReady,
} = require('../_fixtures');

test('second share (web link) is refused while an in-app session share is live, and the guest keeps seeing ONLY the originally-shared session (C-5.1)', async () => {
  test.setTimeout(120000);
  let guestBrowser = null, host = null, guestPage = null;
  try {
    guestBrowser = await chromium.launch();

    const gitBash = resolveGitBash();
    if (!gitBash) throw new Error('no usable git-bash found — install Git for Windows');
    const remote = localBareRemote();
    let ws = null, sidX = 'e2e-x-' + Date.now(), sidY = 'e2e-y-' + Date.now();
    host = await launchClaudible({
      withClaude: true,      // the shared session's own pty (fake-claude)
      withGh: true,          // session:list-ws / share presence both shell through runScript() -> git-bash
      gitBash,
      env: { CLAUDIBLE_CLOUDFLARED: process.execPath },   // force the documented loopback fallback (see share-guest.spec.js's header) — hermetic, no real cloudflared/network
      seed: (ctx) => {
        ws = seedRepoWorkspace(ctx, { slug: 'pinlaw-proj', owner: 'crazy-e2e', remote });
        writeFakeTranscript(ctx, ws, sidX, 'session X — the one that gets shared live');
        writeFakeTranscript(ctx, ws, sidY, 'session Y — the one the host merely browses to afterwards');
        // Make the seeded repo workspace ACTIVE (unlike sync-pair.spec.js's deliberate non-active seeding) —
        // this spec needs the sidebar to actually be showing X/Y, not just have them registered on disk.
        const wsFile = path.join(ctx.persist, 'workspaces.json');
        const reg = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
        reg.activeId = ws.id;
        fs.writeFileSync(wsFile, JSON.stringify(reg));
      },
    });

    await waitForAppReady(host.page);   // see _fixtures.js — <title> can resolve before app.js has even started under cross-spec load

    // ---- sidebar shows both real sessions -------------------------------------------------------------
    const rowX = host.page.locator('.sess[data-id="' + sidX + '"]');
    const rowY = host.page.locator('.sess[data-id="' + sidY + '"]');
    await expect(rowX).toBeAttached({ timeout: 20000 });
    await expect(rowY).toBeAttached({ timeout: 20000 });

    // ---- host: "Share live" on X, from its ▾ menu (toggleShareSession) --------------------------------
    await rowX.locator('.sess-menu-btn').click();
    await host.page.locator('#sess-menu .ws-mi', { hasText: 'Share live' }).click();

    // toggleShareSession focuses X's tab (openSession) before ensureTunnel pins it — wait for that to settle,
    // then for the tunnel to actually come up. lastShareUrl (and the others read below) are top-level `let`
    // bindings in the classic (non-module) app.js script — NOT properties of `window`/globalThis (a bare `let`
    // at script top level lives in the realm's declarative Global Environment Record, not its object record), so
    // this reads the bare identifier — exactly what a devtools-console eval in this page would also resolve —
    // rather than `globalThis.xxx`, which would silently read back `undefined` forever.
    await expect.poll(() => host.page.evaluate(() => activeSession)).toBe(sidX);
    await expect.poll(() => host.page.evaluate(() => sharedSessionId), { timeout: 20000 }).toBe(sidX);
    let shareUrl = '';
    await expect.poll(async () => { shareUrl = await host.page.evaluate(() => lastShareUrl || ''); return shareUrl; }, { timeout: 20000 }).not.toBe('');
    expect(shareUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=/);

    const tabIdX = await host.page.evaluate(() => sharedTabIdR);
    expect(tabIdX, 'main should have pinned sharedTabId to X\'s tab').not.toBeNull();

    // ---- a real browser guest joins and is approved (same flow as share-guest.spec.js) ----------------
    const guestContext = await guestBrowser.newContext();
    guestPage = await guestContext.newPage();
    await guestPage.goto(shareUrl);
    await expect(guestPage.locator('#name-overlay')).toBeVisible({ timeout: 10000 });
    await guestPage.locator('#name-in').fill('e2e-guest-b1');
    await guestPage.locator('#name-go').click();

    const approveModal = host.page.locator('#approve');
    await expect(approveModal).toHaveClass(/show/, { timeout: 15000 });
    await host.page.locator('#approve-yes').click();
    await expect(guestPage.locator('#overlay')).not.toHaveClass(/show/, { timeout: 15000 });
    await expect(guestPage.locator('body')).toHaveClass(/connected/, { timeout: 10000 });

    // ---- host browses to Y (plain sidebar click) — C-5.1: this must change NOTHING for the guest -------
    await rowY.click();
    await expect.poll(() => host.page.evaluate(() => activeSession)).toBe(sidY);
    const tabIdY = await host.page.evaluate(() => activeTabId);
    expect(tabIdY, 'Y should have opened in its OWN tab, distinct from the pinned X tab').not.toBe(tabIdX);

    // the pin must NOT have followed the host to Y
    expect(await host.page.evaluate(() => sharedTabIdR)).toBe(tabIdX);
    expect(await host.page.evaluate(() => sharedSessionId)).toBe(sidX);

    // ---- host clicks "Share a live link" — the owners' exact second half of the exposure ---------------
    await host.page.locator('#share-btn').click();
    await expect(host.page.locator('#namemodal')).toHaveClass(/show/, { timeout: 10000 });
    await host.page.locator('#host-name-in').fill('crazy-e2e-host-2');
    await host.page.locator('#name-start').click();

    // REFUSAL, not a new link: doStartSharing's C-5.1 B13 guard returns before ever touching webShare/ensureTunnel.
    await expect(host.page.locator('#share-out')).toContainText(/already sharing/i, { timeout: 10000 });
    // The pin and the advertised session must be UNCHANGED — no re-pin, no relabel.
    expect(await host.page.evaluate(() => sharedTabIdR)).toBe(tabIdX);
    expect(await host.page.evaluate(() => sharedSessionId)).toBe(sidX);
    // lastShareUrl must be the SAME url as before (no new tunnel/link was minted).
    expect(await host.page.evaluate(() => lastShareUrl)).toBe(shareUrl);

    // ---- the connected guest keeps receiving X, and ONLY X -----------------------------------------------
    const markerX = 'X-ONLY-MARKER-' + Date.now();
    const markerY = 'Y-ONLY-MARKER-' + Date.now();
    // Send distinct bytes into EACH tab's real pty (fake-claude echoes stdin verbatim) — X's tab is the one
    // pinned (tabIdX); Y's is the one the host is merely looking at (tabIdY). If the mirror ever followed the
    // host's foreground (the pre-2026-08-07 "mirror follows focus" bug this law killed), markerY would appear.
    await host.page.evaluate(({ id, m }) => globalThis.claudible.ptyInput(id, m + '\n'), { id: tabIdX, m: markerX });
    await host.page.evaluate(({ id, m }) => globalThis.claudible.ptyInput(id, m + '\n'), { id: tabIdY, m: markerY });

    const guestTerm = guestPage.locator('#terminal');
    await expect.poll(async () => (await guestTerm.innerText()).includes(markerX), { timeout: 15000 }).toBe(true);
    // Give any (bugged) cross-wire a fair chance to show up before asserting its permanent absence.
    await guestPage.waitForTimeout(3000);
    expect((await guestTerm.innerText()).includes(markerY), 'guest must NEVER see Y\'s bytes — the mirror must not follow the host').toBe(false);
  } finally {
    if (guestPage) { try { await guestPage.context().close(); } catch {} }
    if (guestBrowser) { try { await guestBrowser.close(); } catch {} }
    if (host) await host.stop();
  }
});
