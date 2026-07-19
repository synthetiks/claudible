// runners/wsl.js — the Windows + WSL backend (config 1, the default; SEAMS.md contract).
//
// This is a FAITHFUL extraction of the OS-coupled logic that lived inline in main.js. Behavior is
// byte-identical: same wsl.exe invocations, same buildBoot/wsEnv strings, same wslpath translation,
// same node-pty spawn. The acceptance gate is docs/SMOKE.md passing on Windows+WSL after the rewire.
//
// Design that keeps the rewire low-risk: runScript owns ONLY the `wsl.exe -e bash -lc` wrapper +
// the app-dir resolution + the optional wsEnv prefix. Each main.js call site passes its EXACT
// argument string (preserving its own quoting), so the per-script command text is unchanged.

const path = require('path');
const cp = require('child_process');
const shared = require('./_shared');   // OS-agnostic command construction (wsEnv/bootStr/scriptCmd), shared with posix.js
const { probeCloudflared } = require('../share/cloudflared');   // host-side probe — plain node (cp/fs/path), requires cleanly anywhere incl. test/CI

// App root = parent of this runners/ dir (main.js lives at the root; its __dirname == APP_ROOT).
const APP_ROOT = path.resolve(__dirname, '..');

// --- app dir as WSL sees it (C:\Users\X\claudible -> /mnt/c/Users/X/claudible) -------------------
// Pass forward slashes: single backslashes get stripped crossing the Windows->WSL arg boundary, so a
// raw C:\Users\... would reach wslpath as C:Users.... wslpath accepts forward slashes natively.
// (Was main.js:95; lazy-cached — first call happens early, same single console.error on failure.)
let _appdir = undefined;
function appDirGuest() {
  if (_appdir === undefined) {
    try { _appdir = cp.execFileSync('wsl.exe', ['wslpath', '-u', APP_ROOT.replace(/\\/g, '/')], { encoding: 'utf8' }).trim() || null; }
    catch (e) { console.error('[claudible] wslpath failed:', e.message); _appdir = null; }
  }
  return _appdir;
}

// Host<->guest path translation (was inline at main.js:814/861). Identity on native runners; wslpath here.
function toGuestPath(hostPath) {
  try { return cp.execFileSync('wsl.exe', ['wslpath', '-u', String(hostPath).replace(/\\/g, '/')], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
}
function toHostPath(guestPath) {
  try { return cp.execFileSync('wsl.exe', ['wslpath', '-w', String(guestPath)], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
}

// Host-FS runtime root the pollers read (was main.js:81). On WSL the scripts ALWAYS write
// $APPDIR/runtime (session.sh derives it from the app dir — the runtime root is not threaded into
// bash). CLAUDIBLE_RUNTIME is therefore deliberately IGNORED here: honoring it would split-brain the
// channel (main reads/writes the relocated dir while session.sh's hooks write the app dir → dead
// telemetry, a second settings.json, an unread context.json). Only the win runner — whose hook paths
// are baked from THIS function, keeping writer and reader coherent — honors the relocation.
// DELIBERATELY ignores $CLAUDIBLE_RUNTIME (unlike win.js, whose packaged APP_ROOT is read-only). wsl/session.sh
// hardcodes RT="$APPDIR/runtime/tabs/$TAB", so main MUST read where the script writes — honoring the env var here
// would silently split the writer and the reader. Consequence worth knowing: $CLAUDIBLE_RUNTIME cannot be used to
// point this runner at a scratch directory. To isolate the app (a test, a sandbox), copy APP_ROOT itself.
function runtimeDir() { return path.join(APP_ROOT, 'runtime'); }

// --- Claude Code session bootstrap (was main.js:103-122) -----------------------------------------
// Command construction (wsEnv + the boot string) is OS-agnostic and lives in _shared.js (also used by
// posix.js); this backend only adds the wsl.exe wrapper + wslpath app-dir. buildBoot injects the
// resolved guest app-dir into the shared pure builder.
function buildBoot(session, ws, runtimeId, effort, permMode, modelStrategy) { return shared.bootStr(appDirGuest(), session, ws, runtimeId, effort, permMode, modelStrategy); }

// --- node-pty backend (was main.js:156-161) ------------------------------------------------------
let _pty = undefined;
function ptyInfo() {
  if (_pty === undefined) {
    let mod = null, err = null;
    for (const name of ['node-pty', 'node-pty-prebuilt-multiarch']) {
      try { mod = require(name); err = null; console.log('[claudible] pty loaded via', name); break; }
      catch (e) { console.error(`[claudible] require('${name}') failed:`, e.message); err = `${name}: ${e.message}`; }
    }
    if (!mod) console.error('[claudible] no pty backend available');
    _pty = { mod, err };
  }
  return _pty;
}

// Spawn the live Claude TUI (was main.js:237-242). Returns the raw pty proc (or null if no backend);
// main.js owns the rec/handlers/armUltracode lifecycle around it. ConPTY (default Win11) preserves
// the dim ANSI attribute; its AttachConsole crash is neutralized by patches/node-pty + the
// uncaughtException net in main.js.
function spawnClaude(tabId, { cols, rows, session, ws, effort, runtimeId, permMode, modelStrategy } = {}) {
  const pty = ptyInfo();
  if (!pty.mod) return null;
  return pty.mod.spawn('wsl.exe', ['-e', 'bash', '-lc', buildBoot(session, ws, runtimeId, effort, permMode, modelStrategy)], {
    name: 'xterm-256color', cols: cols || 120, rows: rows || 32, cwd: process.env.USERPROFILE, env: process.env,
  });
}

// --- the universal script runner (was the 23 `cp.execFile('wsl.exe', …)` sites; SEAMS §7) --------
// Runs wsl/<name> with an optional wsEnv(ws) + extraEnv prefix. `argStr` is the VERBATIM tail each call
// site used, so command text is unchanged. The command string itself is built by the shared, OS-agnostic
// scriptCmd; this backend only adds the wsl.exe wrapper. Resolves {err, stdout}; callers parse JSON.
function runScript(name, argStr = '', opts = {}) {
  return new Promise((resolve) => {
    const appdir = appDirGuest();
    if (!appdir) return resolve({ err: new Error('WSL unavailable (wslpath)'), stdout: '' });
    const cmd = shared.scriptCmd(appdir, name, argStr, opts);
    // Only set timeout/maxBuffer when the caller actually provided them. Passing `undefined` OVERWRITES
    // execFile's defaults (notably maxBuffer 1 MB -> unlimited), so a missing key must stay missing to
    // preserve the exact behavior of the inline sites that omitted these options.
    const o = { encoding: 'utf8' };
    if (opts.timeout !== undefined) o.timeout = opts.timeout;
    if (opts.maxBuffer !== undefined) o.maxBuffer = opts.maxBuffer;
    // detach: quit-path scripts (presence-clear, killtree) MUST survive app.quit(). "the execFile'd wsl.exe
    // survives our exit" was an unenforced assumption — nothing prevented the child dying with the parent.
    // detached+unref makes it a guarantee; results still resolve normally while the app is alive.
    if (opts.detach) { o.detached = true; o.windowsHide = true; }
    try {
      const child = cp.execFile('wsl.exe', ['-e', 'bash', '-lc', cmd], o,
        (err, stdout) => resolve({ err: err || null, stdout: stdout || '' }));
      if (opts.detach && child && child.unref) child.unref();
    } catch (e) { resolve({ err: e, stdout: '' }); }
  });
}

// --- voice services (was main.js:148-154) --------------------------------------------------------
function startVoiceServices() {
  const appdir = appDirGuest();
  if (!appdir) return;
  try {
    // via scriptCmd, not a hand-rolled string: it is the ONE builder that escapes the app dir (see _shared.js shq).
    cp.execFile('wsl.exe', ['-e', 'bash', '-lc', shared.scriptCmd(appdir, 'services.sh')],
      (err, _stdout, stderr) => { if (err) console.error('[claudible] services.sh:', err.message, stderr || ''); });
  } catch (e) { console.error('[claudible] failed to start voice services:', e.message); }
}
// detect: is the WSL backend usable here? Cheap — reuse the wslpath resolution.
function detect() { return appDirGuest() != null; }

// NOTE: hook installation is fused into spawnClaude — session.sh regenerates settings.json + the hook
// scripts into $SDIR/.claude on every boot (SEAMS §4). Likewise install-time build is the installer's job
// (install.ps1 / `npm run setup`), not the runtime's. Neither needs a runner method here.

// detectDeps: the provisioner's dependency probe. Delegates to the cross-runner bash preflight.sh — the WSL
// guest is where node/git/claude/uv/gh actually live (and bash always exists here, so no chicken-and-egg).
// `runScript` NEVER rejects — it resolves `{ err, stdout: '' }`. So when WSL itself isn't installed, `err` was
// dropped, `JSON.parse('' || '{}')` succeeded, and this returned `{gitBash:true}` with no dependency data at all:
// the onboarding System-check then rendered node/git/claude/uv/gh/cloudflared as SIX separate "missing" rows, with
// nothing anywhere telling the user the single real cause. Report it, so the wizard can say the true thing.
async function detectDeps() {
  const { err, stdout } = await runScript('preflight.sh', '', { timeout: 12000 });
  if (err) { console.error('[claudible] preflight (wsl):', err.message); return { gitBash: true, unavailable: 'wsl' }; }
  let o = {};
  try { o = JSON.parse(String(stdout).trim() || '{}'); } catch { return { gitBash: true, unavailable: 'wsl' }; }
  const out = Object.assign({ gitBash: true }, (o && typeof o === 'object') ? o : {});
  // cloudflared must launch on THIS (Windows) host, not in the guest: share:start spawns it from the Electron
  // main, and a guest-side binary would tunnel to 127.0.0.1 INSIDE WSL while the share server binds the
  // Windows loopback — unreachable under WSL2 NAT. preflight.sh's row only proves a Linux binary exists, so a
  // green row over it lied for the only dep main.js itself spawns. Override with the SAME probe/order
  // startCloudflared() uses (share/cloudflared.js), so "ready" finally means "will actually work". try/catch:
  // one bad row must never blank the whole System-check (the class runner-parity's thrown-probe case guards).
  try { out.cloudflared = await probeCloudflared(); }
  catch { out.cloudflared = { installed: false, version: '', path: '' }; }
  return out;
}

module.exports = {
  id: 'wsl',
  detect, detectDeps,
  appDirGuest, toGuestPath, toHostPath, runtimeDir,
  ptyInfo, spawnClaude, runScript,
  startVoiceServices,
  // exposed for the parity test only (not used by main.js):
  _internals: { wsEnv: shared.wsEnv, buildBoot, _bootStr: shared.bootStr, _scriptCmd: shared.scriptCmd, APP_ROOT },
};
