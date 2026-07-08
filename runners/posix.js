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
// session.sh ALWAYS derives runtime from $APPDIR (the root isn't threaded into bash), so CLAUDIBLE_RUNTIME
// is deliberately ignored — honoring it would split main's reads from the hooks' writes (see wsl.js).
function runtimeDir() { return path.join(APP_ROOT, 'runtime'); }

// buildBoot via the shared pure builder (appdir = the native app root).
function buildBoot(session, ws, runtimeId, effort, permMode, modelStrategy) { return shared.bootStr(APP_ROOT, session, ws, runtimeId, effort, permMode, modelStrategy); }

// node-pty backend (same loader as wsl.js; lazy so requiring this module never forces the native load).
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
    try {
      cp.execFile('bash', ['-lc', cmd], o, (err, stdout) => resolve({ err: err || null, stdout: stdout || '' }));
    } catch (e) { resolve({ err: e, stdout: '' }); }
  });
}

// Voice services natively (services.sh runs on Linux/macOS — same script; binds loopback on a single host).
function startVoiceServices() {
  try {
    cp.execFile('bash', ['-lc', `bash '${APP_ROOT}/wsl/services.sh'`],
      (err, _stdout, stderr) => { if (err) console.error('[claudible] services.sh:', err.message, stderr || ''); });
  } catch (e) { console.error('[claudible] failed to start voice services:', e.message); }
}
async function voiceHealth() {
  const probe = async (url) => { try { const r = await fetch(url, { method: 'GET' }); return r.status < 500; } catch { return false; } };
  const whisper = process.env.CLAUDIBLE_WHISPER || 'http://localhost:2022';
  const kokoro = process.env.CLAUDIBLE_KOKORO || 'http://localhost:8880';
  const [w, k] = await Promise.all([probe(whisper), probe(kokoro)]);
  return { whisper: w, kokoro: k };
}

// detect: this backend serves the non-Windows platforms.
function detect() { return process.platform === 'linux' || process.platform === 'darwin'; }

// installHooks: NO-OP — session.sh (run natively under bash) stages the shared Node hooks + writes
// settings.json on every boot, exactly as on WSL (0.5). Native node is on PATH, so the node path is taken.
function installHooks(_sessionDir) { /* handled by session.sh under bash */ }

// setup: the Linux/macOS voice build is `bash setup/setup.sh` run natively; driven by the platform installer.
function setup(_opts) { return Promise.resolve({ ok: true, note: 'Posix setup is bash setup/setup.sh (native)' }); }

// detectDeps: the provisioner's dependency probe. Same cross-runner preflight.sh, run natively under bash.
async function detectDeps() {
  try {
    const { stdout } = await runScript('preflight.sh', '', { timeout: 12000 });
    const o = JSON.parse(String(stdout).trim() || '{}');
    return Object.assign({ gitBash: true }, (o && typeof o === 'object') ? o : {});
  } catch { return { gitBash: true }; }
}

module.exports = {
  id: 'posix',
  detect, detectDeps,
  appDirGuest, toGuestPath, toHostPath, runtimeDir,
  ptyInfo, spawnClaude, runScript,
  startVoiceServices, voiceHealth,
  installHooks, setup,
  _internals: { buildBoot, APP_ROOT },
};
