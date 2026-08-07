// playwright.config.js — Electron E2E harness config.
//
// Electron has no true headless mode, so every spec here launches a REAL, visible window
// (see test/e2e/_fixtures.js). That is expected on this Windows dev box, not a bug.
//
// Everything this harness needs lives under test/e2e/ (specs + fixtures + the fake-claude
// shim) — this file and the "test:e2e" script in package.json are the only two things outside
// that directory the harness touches. No app source (main.js/renderer/share/runners/wsl) is
// modified by anything here.
'use strict';
const { defineConfig } = require('playwright/test');

module.exports = defineConfig({
  testDir: 'test/e2e',
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,   // each test launches a whole Electron process (own isolated HOME/runtime) — cheap to serialize, and avoids N windows fighting for focus on one desktop
  retries: 0,
  workers: 1,
  reporter: [['list']],
  // No `use.baseURL`/browser project: we never launch Playwright's own browser — every test
  // drives an Electron BrowserWindow via `_electron.launch()` inside the fixture itself.
});
