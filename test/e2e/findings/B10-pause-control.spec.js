// test/e2e/findings/B10-pause-control.spec.js — HARDWARE-SMOKE-RESULTS.md finding B10 (CRAZY SOLO, "BLOCKED —
// feature missing"): "There is NO pause control in the share UI — only 'Stop sharing.' The whole paused-mirror
// privacy feature C-5.6 describes has no user-facing entry point. Owner decision needed: build a Pause
// control, or drop C-5.6."
//
// C-5.6 (CLAUDIBLE-CONSTITUTION.md): "While the host has paused the mirror for privacy, NOTHING a guest sends
// may change anything on the host..." — the constitution's own text presupposes a pause the host can reach.
//
// STATIC CONFIRMATION FIRST: renderer/index.html has NO "Pause" string anywhere near the share/collab UI (the
// only "pause" hits in the whole renderer are wsPaused/paused-ov, which is the GUEST-side share/guest.js
// concept of the HOST being on a private project — not a host-facing control). This spec re-confirms that
// against the REAL running DOM rather than trusting the static grep alone, while a share is actually live (the
// one state a Pause control would need to exist in).
//
// EXPECTED-FAIL: the feature is confirmed absent in source, not flaky — marked so this spec is the tripwire for
// whenever a Pause control is finally built (an unexpected PASS here is exactly that day, and Playwright will
// say so loudly).
'use strict';
const { test, expect } = require('playwright/test');
const { launchClaudible, waitForAppReady } = require('../_fixtures');

test('a Pause control exists in the share UI while a share is live (B10 — feature missing)', async () => {
  // This asserts the CORRECT behavior (a discoverable Pause control) — confirmed absent on HEAD both by static
  // grep (renderer/index.html has no "Pause" string near the share/collab UI) and, below, against the real
  // running DOM. test.fail() marks the WHOLE assertion (not an inverted "it's missing" check) as expected to
  // fail — an inverted assertion would silently keep passing forever and could never announce the day a Pause
  // control ships; this way, that day flips Playwright to an "unexpected pass", loudly.
  test.fail(true, 'B10 — no Pause control exists yet (HARDWARE-SMOKE-RESULTS.md); tripwire for when it ships');

  const { page, stop } = await launchClaudible({
    withClaude: true,
    env: { CLAUDIBLE_CLOUDFLARED: process.execPath },   // force the documented loopback fallback — hermetic, no real cloudflared/network
  });
  try {
    await expect(page).toHaveTitle(/./, { timeout: 30000 });
    await waitForAppReady(page);   // see _fixtures.js — <title> can resolve before app.js's own click handlers are wired up under cross-spec load

    // Go live so any pause control that only renders while sharing gets a fair chance to appear.
    await page.locator('#share-btn').click();
    await expect(page.locator('#namemodal')).toHaveClass(/show/, { timeout: 10000 });
    await page.locator('#host-name-in').fill('crazy-e2e-b10');
    await page.locator('#name-start').click();
    await expect.poll(() => page.evaluate(() => lastShareUrl || ''), { timeout: 20000 }).not.toBe('');
    await expect(page.locator('#share-link')).toBeVisible({ timeout: 10000 });

    // Look for ANY control that could plausibly be "Pause" — a labeled button/toggle near the share controls,
    // by visible text OR by a name/id containing "pause" anywhere in the whole document.
    const byText = await page.getByRole('button', { name: /pause/i }).count();
    const byLabelText = await page.locator('text=/pause/i').count();
    const byIdOrClass = await page.locator('[id*="pause" i], [class*="pause" i]').count();

    // CORRECT behavior: a Pause control should be discoverable somewhere in the running share UI.
    expect(byText + byLabelText + byIdOrClass, 'expected a discoverable Pause control while live-sharing (C-5.6 has no entry point today)').toBeGreaterThan(0);
  } finally {
    await stop();
  }
});
