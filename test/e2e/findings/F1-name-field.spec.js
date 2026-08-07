// test/e2e/findings/F1-name-field.spec.js — HARDWARE-SMOKE-RESULTS.md finding F1 ("NEW BUG: project-name
// field dead"): "MK, create-project modal, Shared-GitHub tile, PLAIN name: letters never appeared in
// #ws-name-in; hard restart fixed it. ... Leading theory: focus stolen — keystrokes going to the terminal;
// the session-name popup has focus-protection, the project-name modal may not."
//
// Deliberately typed via REAL keyboard events (page.keyboard.type), never .fill() — .fill() sets the DOM
// value directly and does not exercise whatever focus-stealing path the hardware bug lived in. A real
// terminal (withClaude:true) is kept ACTIVELY receiving fake-claude's own boot/echo output underneath the
// modal — a stand-in for the exact condition MK was in (a live session running while the modal is open) —
// since the leading theory was keystrokes being redirected to that terminal.
//
// The hardware note calls this INTERMITTENT, so this is not marked expected-fail (an intermittent bug can't
// be honestly asserted as "always reproduces here either way") — it is run for real 10x in one spec, per the
// mission, so a race has ten independent chances to show up. Every character landing every time is a genuine
// pass; any single miss is the regression, reported precisely either way.
'use strict';
const { test, expect } = require('playwright/test');
const { launchClaudible, waitForAppReady } = require('../_fixtures');

test('every typed character lands in the create-project name field, 10 independent attempts (Shared-GitHub tile)', async () => {
  test.setTimeout(90000);
  const { page, stop } = await launchClaudible({ withClaude: true });
  try {
    await expect(page).toHaveTitle(/./, { timeout: 30000 });
    await waitForAppReady(page);   // see _fixtures.js — <title> can resolve before app.js's own click handlers are wired up under cross-spec load

    const misses = [];
    for (let i = 0; i < 10; i++) {
      await page.locator('#ws-add').click();
      await expect(page.locator('#ws-modal')).toHaveClass(/show/, { timeout: 10000 });
      // "Shared-GitHub tile selected" per the mission — ch-repo ("Shared GitHub project").
      await page.locator('#ch-repo').click();
      await expect(page.locator('#ch-repo')).toHaveClass(/sel/);

      const field = page.locator('#ws-name-in');
      await field.click();
      await field.fill('');   // start clean without touching the field's own keydown/focus wiring
      const typed = 'e2e-focus-test-' + i + '-plain-name';
      await field.pressSequentially(typed, { delay: 35 });   // real per-key keydown/keypress/keyup, not a single value assignment
      await page.waitForTimeout(150);   // let any async focus-steal actually manifest before reading back
      const landed = await field.inputValue();
      if (landed !== typed) misses.push({ attempt: i, typed, landed });

      // Cancel and close for the next attempt — a fresh modal open is a fresh chance to reproduce, matching
      // the hardware report of a fresh create-project attempt, not a single held-open field.
      await page.locator('#ws-cancel').click();
      await expect(page.locator('#ws-modal')).not.toHaveClass(/show/, { timeout: 10000 });
    }

    expect(misses, 'every character should land every attempt — misses: ' + JSON.stringify(misses)).toEqual([]);
  } finally {
    await stop();
  }
});
