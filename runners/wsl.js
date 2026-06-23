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

// Host-FS runtime root the pollers read (was main.js:81). On WSL the scripts write here via the
// /mnt/c guest path passed as $APPDIR; on native it's just a local dir. Same value either way here.
function runtimeDir() { return path.join(APP_ROOT, 'runtime'); }

// --- Claude Code session bootstrap (was main.js:103-122) -----------------------------------------
// wsEnv: the env prefix the wsl scripts read to run in the active workspace's cwd. slug re-sanitized
// (defense in depth) since it's interpolated into bash; custom path must be single-quote-free.
function wsEnv(ws) {
  const kind = ws && ['local', 'repo', 'legacy'].includes(ws.kind) ? ws.kind : 'legacy';
  const slug = String((ws && ws.slug) || '').replace(/[^A-Za-z0-9-]/g, '');
  let s = `CLAUDIBLE_WS_KIND='${kind}'` + (slug ? ` CLAUDIBLE_WS_SLUG='${slug}'` : '');
  const p = ws && ws.path;   // custom save-location (absolute WSL path); single-quote-free for safe inlining
  if (p && typeof p === 'string' && !p.includes("'")) s += ` CLAUDIBLE_WS_DIR='${p}'`;
  return s;
}
// buildBoot: the `bash -lc` boot string for the Claude TUI. `effort` and `runtimeId` are passed in
// (decoupled from main's registry/tabRuntimeId) so this module owns no app state. 'ultracode' isn't a
// CLI value — it launches at xhigh and main.js injects `/effort ultracode` once the session settles.
// _bootStr is the PURE construction (appdir injected) so the parity test can verify it without wsl.exe.
function _bootStr(appdir, session, ws, runtimeId, effort) {
  if (!appdir) return 'echo "[claudible] could not resolve the app path via wslpath — is WSL installed?"; sleep 8';
  const sel = String(session || '').replace(/[^A-Za-z0-9-]/g, '').replace(/^-+/, '');   // strip leading dashes (no flag-lookalike ids)
  const tab = String(runtimeId || 'default');
  const effLevel = effort === 'ultracode' ? 'xhigh' : effort;
  const eff = ['low', 'medium', 'high', 'xhigh', 'max'].includes(effLevel) ? ` CLAUDIBLE_EFFORT='${effLevel}'` : '';
  const prefix = (sel ? `CLAUDIBLE_SESSION='${sel}' ` : '') + `CLAUDIBLE_TAB='${tab}'` + eff + ' ' + wsEnv(ws) + ' ';
  return `${prefix}bash '${appdir}/wsl/session.sh' '${appdir}'`;
}
function buildBoot(session, ws, runtimeId, effort) { return _bootStr(appDirGuest(), session, ws, runtimeId, effort); }

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
function spawnClaude(tabId, { cols, rows, session, ws, effort, runtimeId } = {}) {
  const pty = ptyInfo();
  if (!pty.mod) return null;
  return pty.mod.spawn('wsl.exe', ['-e', 'bash', '-lc', buildBoot(session, ws, runtimeId, effort)], {
    name: 'xterm-256color', cols: cols || 120, rows: rows || 32, cwd: process.env.USERPROFILE, env: process.env,
  });
}

// --- the universal script runner (was the 23 `cp.execFile('wsl.exe', …)` sites; SEAMS §7) --------
// Runs wsl/<name> with an optional wsEnv(ws) prefix and an optional extraEnv prefix. `argStr` is the
// VERBATIM tail each call site already used (e.g. "'<sid>'", "set '<n>' '<s>'", "presence-list"),
// so command text is unchanged from the inline versions. Resolves {err, stdout}; callers parse JSON.
// _scriptCmd is the PURE command construction (appdir injected) — the parity test asserts it matches
// each main.js inline site exactly. env keeps its own trailing space (e.g. the live-session prefix).
function _scriptCmd(appdir, name, argStr = '', opts = {}) {
  const env = opts.extraEnv ? String(opts.extraEnv) : '';
  const wsp = opts.ws ? wsEnv(opts.ws) + ' ' : '';
  const tail = String(argStr || '').trim();
  return `${env}${wsp}bash '${appdir}/wsl/${name}'${tail ? ' ' + tail : ''}`;
}
function runScript(name, argStr = '', opts = {}) {
  return new Promise((resolve) => {
    const appdir = appDirGuest();
    if (!appdir) return resolve({ err: new Error('WSL unavailable (wslpath)'), stdout: '' });
    const cmd = _scriptCmd(appdir, name, argStr, opts);
    try {
      cp.execFile('wsl.exe', ['-e', 'bash', '-lc', cmd],
        { encoding: 'utf8', timeout: opts.timeout, maxBuffer: opts.maxBuffer },
        (err, stdout) => resolve({ err: err || null, stdout: stdout || '' }));
    } catch (e) { resolve({ err: e, stdout: '' }); }
  });
}

// --- voice services (was main.js:148-154) --------------------------------------------------------
function startVoiceServices() {
  const appdir = appDirGuest();
  if (!appdir) return;
  try {
    cp.execFile('wsl.exe', ['-e', 'bash', '-lc', `bash '${appdir}/wsl/services.sh'`],
      (err, _stdout, stderr) => { if (err) console.error('[claudible] services.sh:', err.message, stderr || ''); });
  } catch (e) { console.error('[claudible] failed to start voice services:', e.message); }
}
// Probe whisper(:2022)+kokoro(:8880). Not wired into main.js today (health lives in services.sh);
// provided for the contract + future backends. Best-effort GET to each base.
async function voiceHealth() {
  const probe = async (url) => { try { const r = await fetch(url, { method: 'GET' }); return r.status < 500; } catch { return false; } };
  const whisper = process.env.CLAUDIBLE_WHISPER || 'http://localhost:2022';
  const kokoro = process.env.CLAUDIBLE_KOKORO || 'http://localhost:8880';
  const [w, k] = await Promise.all([probe(whisper), probe(kokoro)]);
  return { whisper: w, kokoro: k };
}

// detect: is the WSL backend usable here? Cheap — reuse the wslpath resolution.
function detect() { return appDirGuest() != null; }

// installHooks: NO-OP on WSL — session.sh regenerates settings.json + the hook scripts into
// $SDIR/.claude on every boot (fused into the bootstrap; SEAMS §4). Part 0.5 splits this out and
// Node-ports the hook bodies, at which point this writes the settings + drops node hooks/*.js.
function installHooks(_sessionDir) { /* fused into spawnClaude's session.sh today */ }

// setup: install-time build (setup/setup.sh), driven by install.ps1 / `npm run setup`, not the
// runtime. Kept for the contract; the WSL backend's setup is the existing installer.
function setup(_opts) { return Promise.resolve({ ok: true, note: 'WSL setup is driven by install.ps1 / npm run setup' }); }

module.exports = {
  id: 'wsl',
  detect,
  appDirGuest, toGuestPath, toHostPath, runtimeDir,
  ptyInfo, spawnClaude, runScript,
  startVoiceServices, voiceHealth,
  installHooks, setup,
  // exposed for the parity test only (not used by main.js):
  _internals: { wsEnv, buildBoot, _bootStr, _scriptCmd, APP_ROOT },
};
