// test/e2e/sidebar-refresh.spec.js — the sidebar must keep its last good session list painted THROUGH a
// refresh triggered by a sync.
//
// THE BUG THIS PINS: when a sync reported that it had pulled changes, the renderer threw away that project's
// cached session list outright and then asked the backend for a fresh one. That fetch is a shell + node round
// trip (hundreds of milliseconds to a couple of seconds on a real machine), and for its whole duration the
// sidebar had nothing to paint from — so a full list of sessions blinked to "loading…" / empty and back, every
// time a sync landed. The list is now MARKED out of date instead of dropped: the rows already on screen stay
// on screen, and the fresh list replaces them when it actually arrives.
//
// WHAT THIS SPEC DOES: seeds a real repo workspace with three real (msgs>0) transcripts on disk, makes it
// ACTIVE so the sidebar lists them, then fires the same main→renderer "this project just changed" event the
// sync machinery sends (main.js's own `sync:changed` push) and watches the live DOM across the entire refresh.
// A MutationObserver plus a fast interval sampler record the LOW-WATER row count and whether the empty notice
// was ever painted — a mid-refresh blank that lasts a single frame still fails this test.
'use strict';
const { test, expect } = require('playwright/test');
const path = require('path');
const fs = require('fs');
const {
  launchClaudible, seedRepoWorkspace, writeFakeTranscript, localBareRemote, resolveGitBash, waitForAppReady, sleep,
} = require('./_fixtures');

test('a sync-triggered refresh never blanks the sidebar: rows stay painted and the empty notice never appears', async () => {
  test.setTimeout(120000);
  let inst = null;
  try {
    const gitBash = resolveGitBash();
    if (!gitBash) throw new Error('no usable git-bash found — install Git for Windows');
    const remote = localBareRemote();
    const stamp = Date.now();
    const sids = [`e2e-a-${stamp}`, `e2e-b-${stamp}`, `e2e-c-${stamp}`];
    let ws = null;

    inst = await launchClaudible({
      withClaude: true,      // main.js's spawn-on-size fallback resolves SOME claude shortly after boot regardless of what this spec cares about (see smoke.spec.js) — keep it OUR shim
      withGh: true,          // session:list-ws shells through runScript() -> git-bash
      gitBash,
      seed: (ctx) => {
        ws = seedRepoWorkspace(ctx, { slug: 'sidebar-refresh-proj', owner: 'crazy-e2e', remote });
        sids.forEach((sid, i) => writeFakeTranscript(ctx, ws, sid, `seeded session ${i + 1}`));
        // Make it ACTIVE — the sidebar's own list only ever shows the active workspace's sessions.
        const wsFile = path.join(ctx.persist, 'workspaces.json');
        const reg = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
        reg.activeId = ws.id;
        fs.writeFileSync(wsFile, JSON.stringify(reg));
      },
    });
    const page = inst.page;
    await waitForAppReady(page);

    // ---- the sidebar is genuinely populated before we start -------------------------------------------
    for (const sid of sids) await expect(page.locator('.sess[data-id="' + sid + '"]')).toBeAttached({ timeout: 30000 });
    const baseline = await page.locator('#sess-list .sess').count();
    expect(baseline, 'baseline sidebar row count').toBeGreaterThanOrEqual(sids.length);

    // ---- watch the list continuously (mutations AND a fast tick, so a sub-frame blank is still caught) --
    await page.evaluate(() => {
      const el = document.getElementById('sess-list');
      const w = { minRows: el.querySelectorAll('.sess').length, sawEmptyNotice: false, sawLoading: false, samples: 0 };
      globalThis.__sidebarWatch = w;
      const sample = () => {
        const n = el.querySelectorAll('.sess').length;
        if (n < w.minRows) w.minRows = n;
        // Read the WHOLE-LIST placeholder only (.sess-empty), never the list's text as a whole: an individual
        // row legitimately carries its own 'loading…' caption while its name is still being confirmed, and
        // that is not the cold-start placeholder this assertion is about.
        let txt = '';
        el.querySelectorAll('.sess-empty').forEach((e) => { txt += (e.textContent || '') + '\n'; });
        if (txt.indexOf('No saved sessions yet') >= 0) w.sawEmptyNotice = true;
        if (txt.indexOf('loading') >= 0) w.sawLoading = true;
        w.samples++;
      };
      globalThis.__sidebarWatchStop = () => { try { clearInterval(globalThis.__sidebarWatchTimer); } catch (e) {} };
      // globalThis.MutationObserver, not a bare `new MutationObserver` — this file is linted as plain Node
      // (see eslint.config.js), where that constructor is not a declared global; it is the same object either
      // way inside the renderer this callback actually runs in.
      new globalThis.MutationObserver(sample).observe(el, { childList: true, subtree: true, characterData: true });
      globalThis.__sidebarWatchTimer = setInterval(sample, 20);
      sample();
    });

    // ---- fire the real "this project just changed" push, twice, exactly as main.js sends it -------------
    for (let i = 0; i < 2; i++) {
      await inst.app.evaluate(({ BrowserWindow }, wsId) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.webContents.send('sync:changed', { id: wsId, ids: [] });
      }, ws.id);
      await sleep(4000);   // comfortably longer than a real list fetch (shell + node round trip) takes to answer
    }

    const w = await page.evaluate(() => { try { globalThis.__sidebarWatchStop(); } catch (e) {} return globalThis.__sidebarWatch; });
    expect(w.samples, 'the watcher must actually have sampled').toBeGreaterThan(10);
    expect(w.sawEmptyNotice, 'the sidebar showed "No saved sessions yet" during a refresh of a populated project').toBe(false);
    // Floor is the seeded session count, not `baseline`: a draft/live row of the boot tab is allowed to come and
    // go on its own schedule, but the saved rows must never leave the sidebar (and the list must never hit 0).
    expect(w.minRows, `the sidebar row count fell to ${w.minRows} during a refresh (baseline ${baseline}) — saved rows must stay painted`).toBeGreaterThanOrEqual(sids.length);
    expect(w.sawLoading, 'the sidebar fell back to its cold-start placeholder over a list that was already painted').toBe(false);

    // ---- and the list is still correct after everything settles -----------------------------------------
    for (const sid of sids) await expect(page.locator('.sess[data-id="' + sid + '"]')).toBeAttached();
  } finally {
    if (inst) await inst.stop();
  }
});
