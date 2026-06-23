// runners/win.js — the native Windows backend (config 2 of OS-CONVERSION-PLAN; Part A).
//
// Windows-native runs the WINDOWS claude.exe directly (no WSL). Two mechanisms, each chosen for safety:
//   • spawnClaude: a pure-Node session bootstrap (compute the session dir, write settings.json + stage
//     the shared Node hooks, pick the resume target) then node-pty spawns claude.exe with WINDOWS-path
//     args. This avoids handing MSYS paths to claude.exe. The bootstrap is pure + unit-tested (below).
//   • runScript: the 16 wsl/*.sh run UNCHANGED via git-bash (`bash.exe -lc`). Git for Windows is already
//     an install prerequisite and ships bash + coreutils + sed, so the whole fleet is reused with zero
//     rewrite. App-dir is translated to MSYS form via `cygpath` (the git-bash analogue of wslpath).
//
// STATUS: 🟡 the pure bootstrap (sessionDir/claudeProjectsDir/pickResumeTarget/claudeArgv/settingsJson)
// is verified by test/win-runner.test.js on Linux. The live glue (ConPTY claude.exe spawn, git-bash
// runScript, the Windows voice services) needs a Windows smoke test — see docs/SMOKE.md. NOT runtime-run.

const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const shared = require('./_shared');

const APP_ROOT = path.resolve(__dirname, '..');
const HOME = () => process.env.USERPROFILE || process.env.HOME || '';

// ---- git-bash resolution (for runScript: reuse the wsl/*.sh fleet) ------------------------------
let _bash = undefined;
function gitBash() {
  if (_bash !== undefined) return _bash;
  const cands = [
    process.env.CLAUDIBLE_GIT_BASH,
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) { _bash = c; return _bash; } } catch {} }
  try { const w = cp.execFileSync('where', ['bash.exe'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim(); if (w) { _bash = w; return _bash; } } catch {}
  _bash = null; return _bash;   // null -> runScript degrades (workspaces/sync/diff), but terminal+voice still work
}
// App dir as git-bash (MSYS) sees it: C:\Users\X\claudible -> /c/Users/X/claudible (via cygpath).
let _appdirMsys = undefined;
function appDirGuest() {
  if (_appdirMsys !== undefined) return _appdirMsys;
  const bash = gitBash();
  if (!bash) { _appdirMsys = null; return _appdirMsys; }
  try { _appdirMsys = cp.execFileSync(bash, ['-lc', `cygpath -u '${APP_ROOT.replace(/'/g, "'\\''")}'`], { encoding: 'utf8' }).trim() || null; }
  catch (e) { console.error('[claudible] cygpath failed:', e.message); _appdirMsys = null; }
  return _appdirMsys;
}
function toGuestPath(p) {
  const bash = gitBash(); if (!bash) return '';
  try { return cp.execFileSync(bash, ['-lc', `cygpath -u '${String(p).replace(/'/g, "'\\''")}'`], { encoding: 'utf8' }).trim(); } catch { return ''; }
}
function toHostPath(p) {
  const bash = gitBash(); if (!bash) return '';
  try { return cp.execFileSync(bash, ['-lc', `cygpath -w '${String(p).replace(/'/g, "'\\''")}'`], { encoding: 'utf8' }).trim(); } catch { return ''; }
}
function runtimeDir() { return path.join(APP_ROOT, 'runtime'); }

// ---- PURE session-bootstrap core (unit-tested in test/win-runner.test.js) ------------------------
// Mirror of wsl/session.sh's SDIR logic (lines 12-22), but in Windows paths.
function sessionDir(ws, home) {
  const kind = ws && ['local', 'repo', 'legacy'].includes(ws.kind) ? ws.kind : 'legacy';
  let slug = String((ws && ws.slug) || '');
  if (/[^A-Za-z0-9-]/.test(slug)) slug = '';   // session.sh REJECTS the whole slug if it has any non-[A-Za-z0-9-] char (not strip -> can't redirect to a different dir)
  let sdir;
  if (kind === 'local' && slug) sdir = path.win32.join(home, '.claudible', 'workspaces', slug);
  else if (kind === 'repo' && slug) sdir = path.win32.join(home, '.claudible', 'repos', slug);
  else sdir = path.win32.join(home, '.claudible', 'session');
  if (ws && ws.path && typeof ws.path === 'string' && !ws.path.includes("'")) sdir = ws.path;   // custom save-location
  return sdir;
}
// Claude Code's own transcript store for a cwd: $HOME/.claude/projects/<cwd, every non-alnum -> '-'>.
// MUST match Claude's Windows encoder (verify on smoke). (SEAMS §8 open item — claudeProjectsDir.)
function claudeProjectsDir(sdir, home) {
  return path.win32.join(home, '.claude', 'projects', String(sdir).replace(/[^A-Za-z0-9]/g, '-'));
}
// Resume selection, mirror of session.sh (114-148). jsonl = [{id}] newest-first (caller reads the dir);
// foreign = Set of collaborator-imported ids that must NEVER auto-resume under skip-permissions.
function pickResumeTarget(sel, jsonl, foreign) {
  sel = String(sel || '');
  if (sel.startsWith('-')) sel = '';                       // a dash-prefixed id could read as a flag -> ignore (session.sh:115)
  sel = sel.replace(/[^A-Za-z0-9-]/g, '');
  if (sel === 'new') return { mode: 'fresh' };
  if (sel) return { mode: 'resume', id: sel, foreign: foreign.has(sel) };
  for (const f of (jsonl || [])) {                         // default: newest LOCAL conversation (skip foreign + dash)
    const id = String(f && f.id || '');
    if (!id || id.startsWith('-') || foreign.has(id)) continue;
    return { mode: 'resume', id, foreign: false };
  }
  return { mode: 'fresh' };
}
// claude.exe argv for a launch decision. Foreign sessions run SANDBOXED (no skip-perms, no --add-dir) —
// an untrusted synced transcript must never drive tools with full $HOME (session.sh:103-111).
function claudeArgv(launch, home, effort) {
  const lvl = effort === 'ultracode' ? 'xhigh' : effort;   // 'ultracode' is injected post-settle by main.js
  const eff = ['low', 'medium', 'high', 'xhigh', 'max'].includes(lvl) ? ['--effort', lvl] : [];
  if (launch.mode === 'fresh') return ['--dangerously-skip-permissions', '--add-dir', home, ...eff];
  if (launch.foreign) return ['--resume', launch.id, ...eff];                                  // sandboxed
  return ['--dangerously-skip-permissions', '--resume', launch.id, '--add-dir', home, ...eff];
}
// settings.json content (Node hooks invoked via the Windows node path, per-tab paths baked as argv).
function settingsJson(claudeDir, nodeBin, statusPath, hooksPath) {
  const sl = `"${nodeBin}" "${path.win32.join(claudeDir, 'statusline.js')}" "${statusPath}"`;
  const hk = `"${nodeBin}" "${path.win32.join(claudeDir, 'hook.js')}" "${hooksPath}"`;
  const oneHook = [{ hooks: [{ type: 'command', command: hk }] }];
  const tagHook = [{ matcher: 'Task|Agent', hooks: [{ type: 'command', command: hk }] }];
  return {
    statusLine: { type: 'command', command: sl },
    hooks: { Stop: oneHook, UserPromptSubmit: oneHook, PreToolUse: tagHook, PostToolUse: tagHook },
  };
}
// Stage the shared Node hooks + write settings.json into <sdir>\.claude. Returns the runtime paths.
function installHooks(sdir, tabRuntimeId) {
  const cdir = path.win32.join(sdir, '.claude');
  const rt = path.join(APP_ROOT, 'runtime', 'tabs', String(tabRuntimeId || 'default'));
  const statusPath = path.join(rt, 'status.json');
  const hooksPath = path.join(rt, 'hooks.ndjson');
  fs.mkdirSync(cdir, { recursive: true }); fs.mkdirSync(rt, { recursive: true });
  try { fs.writeFileSync(hooksPath, ''); fs.writeFileSync(statusPath, '{}'); } catch {}   // fresh per launch
  fs.copyFileSync(path.join(APP_ROOT, 'hooks', 'statusline.js'), path.win32.join(cdir, 'statusline.js'));
  fs.copyFileSync(path.join(APP_ROOT, 'hooks', 'hook.js'), path.win32.join(cdir, 'hook.js'));
  const nodeBin = process.execPath;   // the Electron/Node exe — always present, absolute
  fs.writeFileSync(path.win32.join(cdir, 'settings.json'),
    JSON.stringify(settingsJson(cdir, nodeBin, statusPath, hooksPath), null, 2));
  return { cdir, statusPath, hooksPath };
}

// ---- node-pty backend (same loader) -------------------------------------------------------------
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
function whichClaude() {
  if (process.env.CLAUDIBLE_CLAUDE) return process.env.CLAUDIBLE_CLAUDE;
  try { return cp.execFileSync('where', ['claude'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim() || 'claude'; } catch { return 'claude'; }
}

// 🟡 spawnClaude — the live glue (needs a Windows smoke). Runs the pure bootstrap, then ConPTY-spawns
// the Windows claude with WINDOWS-path args. ConPTY hosts a native console app fine (it hosts cmd/pwsh).
function spawnClaude(tabId, { cols, rows, session, ws, effort, runtimeId } = {}) {
  const pty = ptyInfo(); if (!pty.mod) return null;
  const home = HOME();
  const sdir = sessionDir(ws, home);
  installHooks(sdir, runtimeId);
  // pick resume target from claude's own projects store
  let jsonl = [], foreign = new Set();
  try {
    const pdir = claudeProjectsDir(sdir, home);
    const files = fs.readdirSync(pdir).filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ id: f.replace(/\.jsonl$/, ''), m: (() => { try { return fs.statSync(path.win32.join(pdir, f)).mtimeMs; } catch { return 0; } })() }))
      .sort((a, b) => b.m - a.m);
    jsonl = files;
    try { fs.readFileSync(path.win32.join(pdir, '.claudible-foreign'), 'utf8').split(/\r?\n/).forEach((l) => l.trim() && foreign.add(l.trim())); } catch {}
  } catch {}
  const launch = pickResumeTarget(session, jsonl, foreign);
  const argv = claudeArgv(launch, home, effort);
  const claude = whichClaude();
  // node-pty + a .cmd shim: spawn via cmd /c so the shim resolves (the known ConPTY .cmd quirk).
  const isCmd = /\.cmd$|\.bat$/i.test(claude) || claude === 'claude';
  const file = isCmd ? (process.env.COMSPEC || 'cmd.exe') : claude;
  const args = isCmd ? ['/c', claude, ...argv] : argv;
  const env = Object.assign({}, process.env, { CLAUDIBLE_TAB: String(runtimeId || 'default') });
  return pty.mod.spawn(file, args, { name: 'xterm-256color', cols: cols || 120, rows: rows || 32, cwd: sdir, env });
}

// 🟡 runScript — reuse the wsl/*.sh fleet UNCHANGED via git-bash. Same shared scriptCmd; the wrapper is
// git-bash instead of wsl.exe. Degrades cleanly (resolves an error) if git-bash isn't installed.
function runScript(name, argStr = '', opts = {}) {
  return new Promise((resolve) => {
    const bash = gitBash(); const appdir = appDirGuest();
    if (!bash || !appdir) return resolve({ err: new Error('git-bash unavailable (Windows runScript)'), stdout: '' });
    const cmd = shared.scriptCmd(appdir, name, argStr, opts);
    const o = { encoding: 'utf8' };
    if (opts.timeout !== undefined) o.timeout = opts.timeout;
    if (opts.maxBuffer !== undefined) o.maxBuffer = opts.maxBuffer;
    try { cp.execFile(bash, ['-lc', cmd], o, (err, stdout) => resolve({ err: err || null, stdout: stdout || '' })); }
    catch (e) { resolve({ err: e, stdout: '' }); }
  });
}

// 🟡 voice — A0 proved whisper-server.exe runs on Windows; this wires the Windows voice start. Built/
// installed by the Windows installer (A5): whisper-server.exe (prebuilt) + kokoro via uv. Until that
// installer lands this is a documented stub; the renderer's :2022/:8880 client is unchanged.
function startVoiceServices() { /* A3: launch whisper-server.exe + kokoro uvicorn on 127.0.0.1 — see A0 */ }
async function voiceHealth() {
  const probe = async (url) => { try { const r = await fetch(url, { method: 'GET' }); return r.status < 500; } catch { return false; } };
  const [w, k] = await Promise.all([probe(process.env.CLAUDIBLE_WHISPER || 'http://localhost:2022'), probe(process.env.CLAUDIBLE_KOKORO || 'http://localhost:8880')]);
  return { whisper: w, kokoro: k };
}
function detect() { return process.platform === 'win32' && whichClaude() !== 'claude'; }   // native claude present
function setup(_opts) { return Promise.resolve({ ok: true, note: 'Windows-native setup is install.ps1 -Native (A5)' }); }

module.exports = {
  id: 'win',
  detect,
  appDirGuest, toGuestPath, toHostPath, runtimeDir,
  ptyInfo, spawnClaude, runScript,
  startVoiceServices, voiceHealth,
  installHooks, setup,
  // pure core, exported for the unit test:
  _internals: { sessionDir, claudeProjectsDir, pickResumeTarget, claudeArgv, settingsJson, gitBash, whichClaude, APP_ROOT },
};
