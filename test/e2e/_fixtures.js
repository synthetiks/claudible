// test/e2e/_fixtures.js — launches ONE fully isolated Claudible instance for a Playwright spec.
//
// ISOLATION — every mechanism below was confirmed by READING the app source (main.js / runners/win.js),
// not assumed:
//   • HOME + USERPROFILE   → main.js's PERSIST/RT defaults, ensureDefaultLocal()'s workspace dir, and
//                            runners/win.js's HOME() all resolve through process.env.USERPROFILE ||
//                            process.env.HOME. Pointing both at a fresh temp dir relocates ~/.claudible,
//                            ~/.claude, and the default "Local" workspace folder in one move.
//   • CLAUDIBLE_PERSIST     → main.js line ~208: settings.json/workspaces.json/history live here. Reads the
//                            env var FIRST, so this is a guaranteed override independent of how Electron's
//                            own app.getPath('home') resolves on this machine.
//   • CLAUDIBLE_RUNTIME     → per-tab status.json/hooks.ndjson/context.json. runners/win.js's runtimeDir()
//                            reads this env var UNCONDITIONALLY (not just when app.isPackaged, unlike
//                            main.js's own packaged-only default) — so setting it always relocates runtime,
//                            even in `electron .` dev mode.
//   • CLAUDIBLE_RUNNER=win  → forces the native-Windows runner instead of the platform-default WSL runner
//                            (runners/runner.js: `win32` → wsl unless CLAUDIBLE_RUNNER overrides it). wsl.js
//                            DELIBERATELY ignores CLAUDIBLE_RUNTIME (its header explains why: bash derives
//                            the runtime root from $APPDIR, and Windows env can't cross wsl.exe), so it is
//                            the one runner CLAUDIBLE_RUNTIME above cannot isolate. Forcing 'win' sidesteps
//                            that entirely and — as a bonus — means this harness has no dependency on WSL
//                            being installed on the machine running the tests.
//   • --user-data-dir       → Electron's own chromium profile (renderer localStorage/IndexedDB/session
//                            cookies) AND, critically, app.requestSingleInstanceLock() (main.js ~4173) is
//                            keyed off it — without a per-instance value, a second harness instance (or a
//                            real Claudible already running on the dev box) would lose the lock race and
//                            silently app.quit() before a window ever appears.
//   • APPDATA/LOCALAPPDATA  → defensive: main.js's refreshWindowsPath() and the win runner's gitBash()
//                            lookups fall back to these for portable-tool bins; nothing this harness does
//                            should ever touch the real machine's roaming config.
//
// FIRST-RUN WIZARD: not skipped via app source changes. main.js's preload reads settingsInitial via a
// SYNCHRONOUS 'settings:get' at boot (renderer/app.js loadPrefs()), which is CLAUDIBLE_PERSIST/settings.json
// — so pre-seeding that file with `onboardingDone:true` before launch is indistinguishable, from the app's
// point of view, from a real user who already finished onboarding (renderer/app.js:6105 gates the wizard on
// exactly that flag). Separately, a BRAND NEW workspaces.json has no local workspace yet, so main.js's
// ensureDefaultLocal() would materialize one and set registry.firstRun=true, which renderer/app.js's
// maybeFirstRun() turns into a "name your project" modal even with the wizard itself skipped — pre-seeding
// workspaces.json with the default local workspace already present avoids that too. No CLAUDIBLE_E2E hook
// was needed.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright/test');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FAKE_CLAUDE_DIR = path.join(__dirname, 'fake-claude');

function electronExecutable() {
  // Same resolution `electron .` (package.json's start script) relies on — the local devDependency, so the
  // native node-pty build matches the Electron ABI it was rebuilt against.
  const bin = require(path.join(REPO_ROOT, 'node_modules', 'electron'));
  if (!bin || typeof bin !== 'string' || !fs.existsSync(bin)) {
    throw new Error('electron binary not found at ' + bin + ' — run `npm install` first.');
  }
  return bin;
}

function seedIsolatedStorage({ persistDir, homeDir }) {
  fs.mkdirSync(persistDir, { recursive: true });
  // 1) Skip the first-run wizard (renderer/app.js:6105 gates it on loadPrefs().onboardingDone).
  fs.writeFileSync(
    path.join(persistDir, 'settings.json'),
    JSON.stringify({ onboardingDone: true, wsHintSeen: true }),
  );
  // 2) Pre-populate the registry with the SAME default-local shape main.js's ensureDefaultLocal() would
  //    synthesize (main.js DEFAULT_LOCAL) — this is why registry.firstRun never gets set, which is why the
  //    post-boot "name your project" ws-modal (renderer/app.js maybeFirstRun) never fires either.
  const wsId = 'local-local';
  fs.writeFileSync(
    path.join(persistDir, 'workspaces.json'),
    JSON.stringify({
      activeId: wsId,
      workspaces: [{ id: wsId, label: 'Local', kind: 'local', slug: 'local', createdAt: Date.now() }],
    }),
  );
  // Belt-and-suspenders: the real workspace folder main.js's runners/win.js sessionDir() would resolve to
  // for this workspace (home/.claudible/workspaces/local). installHooks() would mkdir -p it on first spawn
  // anyway, but creating it up front means even a spec that never spawns a session sees a sane filesystem.
  fs.mkdirSync(path.join(homeDir, '.claudible', 'workspaces', 'local'), { recursive: true });
}

// launchClaudible(opts) → { app, page, home, sandbox, stop() }
//   opts.withClaude   (bool, default false) — prepend test/e2e/fake-claude/ to PATH so runners/win.js's
//                     whichClaude()/pickClaudeBin() resolves OUR shim (a tiny node script that echoes input
//                     and stays alive) instead of any real claude on the dev machine. Leave this off for
//                     UI-only specs (sidebar/modals/share dialogs) per the harness's hard rules — they must
//                     not require a working claude at all.
//   opts.skipOnboarding (bool, default true) — pre-seed settings.json/workspaces.json as described above.
//   opts.env          (object) — extra env vars merged in last (can override anything above).
//   opts.timeout      (ms, default 30000) — Electron launch timeout.
async function launchClaudible(opts = {}) {
  const withClaude = !!opts.withClaude;
  const skipOnboarding = opts.skipOnboarding !== false;

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'claudible-e2e-'));
  const home = path.join(sandbox, 'home');
  const persist = path.join(home, '.claudible', 'app');
  const runtime = path.join(home, '.claudible', 'runtime');
  const userData = path.join(sandbox, 'userdata');
  const appData = path.join(sandbox, 'appdata');
  const localAppData = path.join(sandbox, 'localappdata');
  for (const d of [home, persist, runtime, userData, appData, localAppData]) fs.mkdirSync(d, { recursive: true });

  if (skipOnboarding) seedIsolatedStorage({ persistDir: persist, homeDir: home });

  const env = Object.assign({}, process.env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    CLAUDIBLE_PERSIST: persist,
    CLAUDIBLE_RUNTIME: runtime,
    CLAUDIBLE_RUNNER: 'win',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  });
  if (withClaude) env.PATH = FAKE_CLAUDE_DIR + path.delimiter + (process.env.PATH || '');
  if (opts.env) Object.assign(env, opts.env);

  const app = await electron.launch({
    executablePath: electronExecutable(),
    // Mirrors `electron .`: first positional arg is the app directory (package.json main=main.js).
    args: [REPO_ROOT, '--user-data-dir=' + userData],
    cwd: REPO_ROOT,
    env,
    timeout: opts.timeout || 30000,
  });

  const page = await app.firstWindow({ timeout: opts.timeout || 30000 });

  // Track the main process pid up front — stop()'s orphan check needs it even if close() itself hangs.
  const pid = app.process().pid;

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    try { await app.close(); }
    catch {
      // close() talks to the app over CDP; if the renderer/main is already wedged, fall back to a hard kill
      // so a broken spec still leaves no orphan process.
      try { app.process().kill(); } catch {}
    }
    // Best-effort sandbox cleanup — never fails the test over a locked file on a slow disk.
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {}
  }

  return { app, page, home, sandbox, persist, runtime, userData, pid, stop };
}

// ---- process helpers for orphan checks (Windows tasklist/CIM — this harness only runs on the Windows dev box) --

// Is a pid still alive? `tasklist /FI "PID eq N"` prints one CSV-ish row per match, or an
// "INFO: No tasks..." line when there are none — check for the pid as a distinct token rather than
// parsing full CSV, since the exact banner text is locale-dependent.
function isPidAlive(pid) {
  if (!pid) return false;
  const cp = require('child_process');
  try {
    const out = cp.execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    return new RegExp(`"${pid}"`).test(out);
  } catch { return false; }
}

// pids of every live descendant of `pid` (children, grandchildren, …), via WMI/CIM — used to prove a
// claude-shim spawn actually happened (and later, that it's gone) without hardcoding an image name.
function listDescendantPids(pid) {
  if (!pid) return [];
  const cp = require('child_process');
  const children = (ppid) => {
    try {
      const out = cp.execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "ParentProcessId=${ppid}" | Select-Object -ExpandProperty ProcessId`,
      ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      return out.split(/\r?\n/).map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n));
    } catch { return []; }
  };
  const all = [];
  const queue = [pid];
  const seen = new Set();
  while (queue.length) {
    const cur = queue.shift();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const c of children(cur)) { all.push(c); queue.push(c); }
  }
  return all;
}

module.exports = { launchClaudible, REPO_ROOT, FAKE_CLAUDE_DIR, isPidAlive, listDescendantPids };
