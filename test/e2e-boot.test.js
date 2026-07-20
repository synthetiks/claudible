// test/e2e-boot.test.js — does the app actually BOOT? Launches the real Electron binary and drives the renderer
// over the Chrome DevTools Protocol using the `ws` dependency the app already ships (no Playwright, no Spectron).
//
// This is the only thing in the repo that can catch a TDZ error, a missing preload export, or a renderer syntax
// error before a human opens the app. `node --check` sees syntax; eslint's no-undef sees globals; contract.test.js
// sees the string-keyed seams. None of them run main.js — it can't even be require()'d (it destructures
// `require('electron')`, which is a *string* under plain node).
//
// ============================ WHY THIS REFUSES TO RUN BY DEFAULT ============================
// Launching Electron from the app directory opens a REAL window and, without isolation, points the app at the
// developer's LIVE registry (runtime/workspaces.json), their real ~/.claudible, and can spawn real ptys.
// I did exactly that once on MK's machine — two Claudible windows appeared on his desktop. Nothing was damaged,
// but nothing about that was acceptable. So:
//
//   * It SKIPS unless CLAUDIBLE_E2E=1 is set explicitly. `npm test` never sets it. CI does.
//   * It ABORTS unless HOME and CLAUDIBLE_RUNTIME both point inside the temp dir it just created. If the guard
//     can't prove isolation, it does not launch anything.
//
// Run in CI: `xvfb-run -a npm run test:e2e`.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (label, c) => c ? (pass++, console.log('  ok   ' + label)) : (fail++, console.error('  FAIL ' + label));
const done = () => { console.log(`\ne2e-boot: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); };

if (process.env.CLAUDIBLE_E2E !== '1') {
  console.log('e2e-boot: SKIPPED (set CLAUDIBLE_E2E=1 to run — it launches a real Electron window).');
  process.exit(0);
}

// ---- isolation, established BEFORE anything is spawned -----------------------------------------------------
// The app's registry lives at `runner.runtimeDir()/workspaces.json`, and runtimeDir() is `APP_ROOT/runtime` on the
// wsl AND posix runners — they deliberately IGNORE $CLAUDIBLE_RUNTIME, because wsl/session.sh hardcodes
// RT="$APPDIR/runtime" and main must read where the script writes. (Only win.js honors the env var; a packaged
// Windows install has a read-only APP_ROOT.) So $CLAUDIBLE_RUNTIME cannot isolate this on Linux/WSL — the app
// would write straight into the developer's live runtime/. That is not a hypothetical: it is what happened.
//
// The only isolation that actually holds is to make APP_ROOT itself disposable. Copy the app into the sandbox and
// run Electron from there; node_modules is symlinked (it's ~300MB and read-only for our purposes).
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'claudible-e2e-'));
const APP = path.join(SANDBOX, 'app');
const HOME = path.join(SANDBOX, 'home');
const USERDATA = path.join(SANDBOX, 'userdata');
[APP, HOME, USERDATA].forEach((d) => fs.mkdirSync(d, { recursive: true }));

// Everything the app loads at runtime (mirrors electron-builder's `files` list, minus docs/tests).
for (const entry of ['main.js', 'preload.js', 'package.json', 'lib', 'renderer', 'hooks', 'runners', 'wsl', 'share', 'assets']) {
  const src = path.join(ROOT, entry);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(APP, entry), { recursive: true });
}
try { fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(APP, 'node_modules'), 'junction'); }
catch { fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(APP, 'node_modules')); }

// Hard guard: nothing may resolve outside the sandbox. If we can't PROVE isolation, we launch nothing.
const inside = (p) => path.resolve(p).startsWith(path.resolve(SANDBOX) + path.sep);
if (!inside(APP) || !inside(HOME) || !inside(USERDATA) || !fs.existsSync(path.join(APP, 'main.js'))) {
  console.error('e2e-boot: REFUSING to launch — sandbox is not isolated.');
  process.exit(1);
}
// Snapshot the REAL runtime dir so we can prove afterwards that the app never touched it.
const REAL_RUNTIME = path.join(ROOT, 'runtime');
const realRuntimeBefore = fs.existsSync(REAL_RUNTIME)
  ? fs.readdirSync(REAL_RUNTIME).sort().join(',') + '|' + String(fs.statSync(REAL_RUNTIME).mtimeMs)
  : '(absent)';

const electronBin = (() => {
  try { return require(path.join(ROOT, 'node_modules/electron')); } catch { return null; }
})();
if (!electronBin || typeof electronBin !== 'string') {
  console.log('e2e-boot: SKIPPED (electron not installed).');
  process.exit(0);
}

const PORT = 9222 + (process.pid % 500);   // avoid collisions between concurrent runs
let child = null;
const cleanup = () => {
  if (child && !child.killed) { try { child.kill('SIGKILL'); } catch {} }
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

// ---- launch ------------------------------------------------------------------------------------------------
child = cp.spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USERDATA}`, '--no-sandbox'], {
  cwd: APP,                                 // APP_ROOT — and therefore runtimeDir() — is the sandbox copy
  env: {
    ...process.env,
    HOME,                                   // isolated: ~/.claudible, ~/.claude
    USERPROFILE: HOME,                      // Windows equivalent
    CLAUDIBLE_RUNTIME: path.join(APP, 'runtime'),   // only the win runner reads this; harmless (and correct) elsewhere
    CLAUDIBLE_E2E: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderrBuf = '';
child.stderr.on('data', (d) => { stderrBuf += d.toString(); });

// ---- CDP over the `ws` dep ---------------------------------------------------------------------------------
const getJson = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => { let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } }); })
    .on('error', reject);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage(deadline) {
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  return null;
}

(async () => {
  const page = await findPage(Date.now() + 30000);
  ok('the app boots and exposes a renderer page over CDP', !!page);
  if (!page) { console.error('  stderr:\n' + stderrBuf.slice(-1500)); return done(); }

  const WebSocket = require('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  const exceptions = [];
  const consoleErrors = [];
  const send = (method, params) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params: params || {} }));
  });

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      return m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params && m.params.exceptionDetails;
      exceptions.push((d && (d.exception && d.exception.description)) || (d && d.text) || 'unknown');
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push((m.params.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 200));
    }
  });

  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(4000);   // let the renderer boot, load prefs, paint the first tab

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception || {}).description);
    return r.result.value;
  };

  // The renderer got far enough to define its globals and paint the shell.
  ok('no uncaught renderer exceptions', exceptions.length === 0);
  if (exceptions.length) exceptions.slice(0, 5).forEach((e) => console.error('      ' + String(e).split('\n')[0]));

  ok('the preload bridge is exposed', (await evaluate('typeof window.claudible')) === 'object');
  ok('the terminal host is in the DOM', (await evaluate("!!document.getElementById('terminal')")) === true);
  ok('the session sidebar is in the DOM', (await evaluate("!!document.getElementById('sess-list')")) === true);
  ok('the workspace chip bar is in the DOM', (await evaluate("!!document.getElementById('ws-chips')")) === true);

  // A read-only IPC round-trip through the REAL preload bridge → real ipcMain handler.
  const version = await evaluate('window.claudible.appVersion()');
  ok('a read-only IPC round-trip works (app:version)', typeof version === 'string' && version.length > 0);
  const wsList = await evaluate('window.claudible.workspaceList().then(r => JSON.stringify(r))');
  ok('workspace:list round-trips and returns a registry', typeof wsList === 'string' && wsList.includes('workspaces'));

  // A fresh sandbox HOME has no prior workspaces.json, so ensureDefaultLocal() (main.js) synthesized the default
  // Local workspace IN MEMORY with firstRun=true — but loadRegistry()/workspace:list are pure reads; main.js only
  // calls saveRegistry() from a MUTATING path (switch/add/rename workspace, sync toggle, workspace:firstRunDone,
  // …), by design, exactly as it did before R4 relocated WHERE the file lives. Booting alone therefore never
  // wrote workspaces.json — the assertion below used to fail on every boot for that reason, not a HOME/R4 bug
  // (confirmed: app.getPath('home') tracks a custom $HOME correctly on Linux). Drive the same signal a real
  // fresh install's first-run wizard sends on dismissal, so this test actually exercises the write it asserts on.
  await evaluate('window.claudible.workspaceFirstRunDone().then(r => JSON.stringify(r))');

  // Isolation is ASSERTED, not assumed — both directions.
  // R4: durable state moved OUT of the app folder to ~/.claudible/app — the sandbox's HOME anchors it here.
  ok('the app wrote its registry inside the sandbox HOME (R4: survives delete-and-reclone)',
    fs.existsSync(path.join(HOME, '.claudible', 'app', 'workspaces.json')));
  const realRuntimeAfter = fs.existsSync(REAL_RUNTIME)
    ? fs.readdirSync(REAL_RUNTIME).sort().join(',') + '|' + String(fs.statSync(REAL_RUNTIME).mtimeMs)
    : '(absent)';
  ok("the repo's own runtime/ was never touched", realRuntimeAfter === realRuntimeBefore);
  if (realRuntimeAfter !== realRuntimeBefore) {
    console.error(`      before: ${realRuntimeBefore}\n      after:  ${realRuntimeAfter}`);
  }

  if (consoleErrors.length) {
    console.log(`  note: ${consoleErrors.length} console.error during boot (not gated; a pty/claude is absent in CI):`);
    consoleErrors.slice(0, 3).forEach((e) => console.log('      ' + e));
  }

  try { ws.close(); } catch {}
  done();
})().catch((e) => {
  console.error('  FAIL e2e-boot threw: ' + (e && e.message));
  console.error('  stderr:\n' + stderrBuf.slice(-1500));
  fail++;
  done();
});
