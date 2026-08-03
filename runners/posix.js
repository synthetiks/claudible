// runners/posix.js — the native Linux / macOS backend (configs 3 & 4 of OS-CONVERSION-PLAN).
//
// Native Posix is the WSL backend MINUS the wsl.exe wrapper and wslpath translation: the Electron app
// runs ON Linux/macOS, so it spawns `bash` directly and the app dir IS the execution dir (identity
// paths). It reuses ALL of wsl/*.sh and the shared Node hooks unchanged — those already target a
// Unix/bash environment. Command construction is shared with wsl.js via _shared.js so they never drift.
//
// macOS caveat (Part C): setup.sh/services.sh use apt + `ss`; macOS needs brew + `lsof` branches. That's
// install/voice-build only — the RUNTIME runner here is identical for Linux and macOS.
// Known gap (Part B installer): node-pty must be built/fetched for linux/<arch> (node-pty 1.1.0 ships
// darwin + win32 prebuilds but NOT linux) — see docs/OS-CONVERSION-PLAN.md §8 multiarch.

const path = require('path');
const cp = require('child_process');
const shared = require('./_shared');

const APP_ROOT = path.resolve(__dirname, '..');

// Identity translation — on native Posix the host IS the execution space (no wslpath).
function appDirGuest() { return APP_ROOT; }
function toGuestPath(p) { return String(p == null ? '' : p); }
function toHostPath(p) { return String(p == null ? '' : p); }
// B1: CLAUDIBLE_RUNTIME is now honored here, mirroring win.js — session.sh and killtree.sh read the SAME env
// (absolute-path-guarded on both sides), so writer, reaper and main's pollers resolve one dir. This is what
// lets a PACKAGED Linux/macOS build (read-only AppImage mount, root-owned /opt) write per-tab state under
// ~/.claudible/runtime. Dev/source installs leave the env unset → APP_ROOT/runtime, exactly as before.
// (wsl.js still deliberately ignores it: Windows env does not cross wsl.exe, so WSL's writer could never
// follow — see its header. test/e2e-boot.test.js isolates by copying APP_ROOT, which remains valid.)
function runtimeDir() {
  const rt = process.env.CLAUDIBLE_RUNTIME;
  return (rt && path.isAbsolute(rt)) ? rt : path.join(APP_ROOT, 'runtime');
}

// buildBoot via the shared pure builder (appdir = the native app root).
function buildBoot(session, ws, runtimeId, effort, permMode, modelStrategy) { return shared.bootStr(APP_ROOT, session, ws, runtimeId, effort, permMode, modelStrategy); }

// node-pty backend (same loader as wsl.js; lazy so requiring this module never forces the native load).
let _pty = undefined;
function ptyInfo() {
  if (_pty === undefined) {
    let mod = null, err = null;
    // node-pty is the primary; node-pty-prebuilt-multiarch is a FALLBACK for platforms node-pty 1.1.0 has no
    // prebuild for (notably linux/<arch>). It is intentionally NOT a package.json dependency — that would pull
    // prebuild-install's whole tree into every Windows/Mac install for a Linux-only fallback. Release builds add
    // it explicitly (`npm run dist:linux` + the CI build job, both `npm install --no-save …@^0.10.1-pre.5`). A
    // plain `npm install && npm start` on native Linux that skips that step falls through to the clear error below.
    for (const name of ['node-pty', 'node-pty-prebuilt-multiarch']) {
      try { mod = require(name); err = null; console.log('[claudible] pty loaded via', name); break; }
      catch (e) { console.error(`[claudible] require('${name}') failed:`, e.message); err = `${name}: ${e.message}`; }
    }
    if (!mod) console.error('[claudible] no pty backend available');
    _pty = { mod, err };
  }
  return _pty;
}

// Spawn the Claude TUI directly under bash (no wsl.exe). cwd = $HOME (Posix), env inherited.
function spawnClaude(tabId, { cols, rows, session, ws, effort, runtimeId, permMode, modelStrategy } = {}) {
  const pty = ptyInfo();
  if (!pty.mod) return null;
  return pty.mod.spawn('bash', ['-lc', buildBoot(session, ws, runtimeId, effort, permMode, modelStrategy)], {
    name: 'xterm-256color', cols: cols || 120, rows: rows || 32, cwd: process.env.HOME, env: process.env,
  });
}

// Run wsl/<name> directly under bash — the scripts are bash and run natively on Linux/macOS. The command
// string is the shared, OS-agnostic scriptCmd; this backend just drops the wsl.exe wrapper.
function runScript(name, argStr = '', opts = {}) {
  return new Promise((resolve) => {
    const cmd = shared.scriptCmd(APP_ROOT, name, argStr, opts);
    const o = { encoding: 'utf8' };
    if (opts.timeout !== undefined) o.timeout = opts.timeout;
    if (opts.maxBuffer !== undefined) o.maxBuffer = opts.maxBuffer;
    if (opts.detach) o.detached = true;   // quit-path scripts must survive app.quit() — see wsl.js runScript
    try {
      const child = cp.execFile('bash', ['-lc', cmd], o, (err, stdout) => resolve({ err: err || null, stdout: stdout || '' }));
      if (opts.detach && child && child.unref) {
        // Tell the caller the moment the OS has actually CREATED the process. A quit-path caller must not
        // exit before this: app.exit() is a hard kill, and a spawn that has not reached the OS yet simply
        // never happens (on Windows the wsl.exe interop bridge takes hundreds of ms to come up).
        try { if (opts.onSpawn) child.once('spawn', () => { try { opts.onSpawn(); } catch {} }); } catch {}
        child.unref();
      }
    } catch (e) { resolve({ err: e, stdout: '' }); }
  });
}

// Voice services natively. B2: services.sh defaults CLAUDIBLE_BIND_HOST to 0.0.0.0 — correct on WSL (the app
// reaches the services ACROSS the WSL2 NAT, which also shields them from the LAN) but on native Linux/macOS
// there is no NAT wall: 0.0.0.0 exposes whisper (:2022) and kokoro (:8880) to the local network. Bind loopback
// explicitly, exactly as win.js does — the app talks to localhost on a single host here, nothing else needs in.
function startVoiceServices() {
  try {
    // via scriptCmd, not a hand-rolled string: it is the ONE builder that escapes the app dir (see _shared.js shq).
    const env = Object.assign({}, process.env, { CLAUDIBLE_BIND_HOST: '127.0.0.1' });
    cp.execFile('bash', ['-lc', shared.scriptCmd(APP_ROOT, 'services.sh')], { env },
      (err, _stdout, stderr) => { if (err) console.error('[claudible] services.sh:', err.message, stderr || ''); });
  } catch (e) { console.error('[claudible] failed to start voice services:', e.message); }
}

// detect: this backend serves the non-Windows platforms.
function detect() { return process.platform === 'linux' || process.platform === 'darwin'; }

// NOTE: as on WSL, hook installation is fused into spawnClaude (session.sh stages the shared Node hooks +
// writes settings.json on every boot), and the install-time voice build is `bash setup/setup.sh`, driven by
// the platform installer. Neither needs a runner method here.

// detectDeps: the provisioner's dependency probe. Same cross-runner preflight.sh, run natively under bash.
// Same trap as wsl.js: runScript resolves `{err, stdout:''}` rather than rejecting, so a preflight that couldn't run
// at all used to be indistinguishable from "every dependency is missing". Report the real cause.
async function detectDeps() {
  const { err, stdout } = await runScript('preflight.sh', '', { timeout: 12000 });
  if (err) { console.error('[claudible] preflight (posix):', err.message); return { gitBash: true, unavailable: 'shell' }; }
  let o = {};
  try { o = JSON.parse(String(stdout).trim() || '{}'); } catch { return { gitBash: true, unavailable: 'shell' }; }
  return Object.assign({ gitBash: true }, (o && typeof o === 'object') ? o : {});
}

module.exports = {
  id: 'posix',
  detect, detectDeps,
  appDirGuest, toGuestPath, toHostPath, runtimeDir,
  ptyInfo, spawnClaude, runScript,
  startVoiceServices,
  _internals: { buildBoot, APP_ROOT },
};
