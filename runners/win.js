// runners/win.js — the native Windows backend (config 2 of OS-CONVERSION-PLAN; Part A).
//
// Windows-native runs the WINDOWS claude.exe directly (no WSL). Two mechanisms, each chosen for safety:
//   • spawnClaude: a pure-Node session bootstrap (compute the session dir, write settings.json + stage
//     the shared Node hooks, pick the resume target) then node-pty spawns claude.exe with WINDOWS-path
//     args. This avoids handing MSYS paths to claude.exe. The bootstrap is pure + unit-tested (below).
//   • runScript: the 16 wsl/*.sh run via git-bash (`bash.exe -lc`). Git for Windows is already an install
//     prerequisite (ships bash + coreutils + sed). Two ENV bridges (no script rewrite): CLAUDIBLE_PROJ (so
//     they read claude.exe's Windows-encoded projects store, not the MSYS-encoded phantom) + MSYS_NO_PATHCONV.
//     NOTE: the scripts' JSON transforms were ported off python3 to Node (wsl/*-tool.js, byte-parity proven
//     by test/port-parity.sh) — so Git-for-Windows needs no python3 FOR THE SCRIPTS. Node is already present
//     (it runs the app + the hooks). The old "installer must provide Python for the scripts" gate is RESOLVED.
//     (The optional voice/TTS stack — Kokoro — is a separate Python use, provisioned only if you want voice.)
//     App-dir -> MSYS via cygpath.
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
// MIXED form (C:/Users/…) — NOT the unix form (/c/Users/…). A chosen folder becomes a workspace path that is
// (a) handed to git.exe/gh.exe by clone/upgrade and (b) used as the Claude pty's cwd. git.exe + node-pty are
// WINDOWS programs: under MSYS_NO_PATHCONV they read `/c/Games/X` LITERALLY as C:\c\Games\X (a stray top-level
// `c` folder — the reported bug). The mixed `C:/Games/X` is a real Windows path that ALSO works inside git-bash
// (forward slashes), so it's correct in every consumer. (toHostPath stays -w for the few Windows-native call sites.)
function toGuestPath(p) {
  const bash = gitBash(); if (!bash) return '';
  try { return cp.execFileSync(bash, ['-lc', `cygpath -m '${String(p).replace(/'/g, "'\\''")}'`], { encoding: 'utf8' }).trim(); } catch { return ''; }
}
function toHostPath(p) {
  const bash = gitBash(); if (!bash) return '';
  try { return cp.execFileSync(bash, ['-lc', `cygpath -w '${String(p).replace(/'/g, "'\\''")}'`], { encoding: 'utf8' }).trim(); } catch { return ''; }
}
function runtimeDir() { return process.env.CLAUDIBLE_RUNTIME || path.join(APP_ROOT, 'runtime'); }

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
  const rt = path.join(runtimeDir(), 'tabs', String(tabRuntimeId || 'default'));   // writable runtime root (CLAUDIBLE_RUNTIME when packaged), matches what main.js's pollers read
  const statusPath = path.join(rt, 'status.json');
  const hooksPath = path.join(rt, 'hooks.ndjson');
  fs.mkdirSync(cdir, { recursive: true }); fs.mkdirSync(rt, { recursive: true });
  try { fs.writeFileSync(hooksPath, ''); fs.writeFileSync(statusPath, '{}'); } catch {}   // fresh per launch
  fs.copyFileSync(path.join(APP_ROOT, 'hooks', 'statusline.js'), path.win32.join(cdir, 'statusline.js'));
  fs.copyFileSync(path.join(APP_ROOT, 'hooks', 'hook.js'), path.win32.join(cdir, 'hook.js'));
  // MUST be a real node.exe, NOT process.execPath (= electron.exe under Electron, which won't run a .js
  // without ELECTRON_RUN_AS_NODE). Claudible's installer guarantees Windows Node 22.12+ on PATH.
  const nodeBin = whichNode();
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
// Choose a Windows-RUNNABLE claude among `where claude` hits (pure → unit-tested). npm installs BOTH an
// extensionless shell shim ('…\claude') and a Windows shim ('…\claude.cmd'/'.exe'); spawning the bare script
// fails with CreateProcess 193 ("not a valid Win32 application"), so prefer a .cmd/.exe/.bat form. The .cmd
// path is routed through cmd.exe by spawnClaude; a real .exe is spawned directly.
function pickClaudeBin(hits) {
  const list = (hits || []).map((s) => String(s).trim()).filter(Boolean);
  return list.find((h) => /\.(cmd|exe|bat)$/i.test(h)) || list[0] || 'claude';
}
function whichClaude() {
  if (process.env.CLAUDIBLE_CLAUDE) return process.env.CLAUDIBLE_CLAUDE;
  try { return pickClaudeBin(cp.execFileSync('where', ['claude'], { encoding: 'utf8' }).split(/\r?\n/)); } catch { return 'claude'; }
}
// A real Windows node.exe for the hook commands (NEVER process.execPath = electron.exe).
function whichNode() {
  if (process.env.CLAUDIBLE_NODE) return process.env.CLAUDIBLE_NODE;
  try { const w = cp.execFileSync('where', ['node'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim(); if (w) return w; } catch {}
  return 'node';   // installer guarantees Windows Node on PATH; bare 'node' resolves in claude's hook shell
}

// Drop the memoized git-bash / app-dir resolutions so a later runtime Git install can be picked up without a
// process restart (the lazy-getter upgrade path; main.js currently relauches after a Git install instead).
function resetCaches() { _bash = undefined; _appdirMsys = undefined; }

// ---- dependency detection (pure-Node; NO git-bash) ----------------------------------------------
// The self-bootstrapping provisioner needs to know, on a possibly-bare Windows box, which deps are present.
// Detection MUST NOT route through runScript/git-bash (that very dependency — Git — may be missing; the
// chicken-and-egg). node/git/claude/uv/gh/cloudflared are all Windows-PATH executables resolvable with
// `where`; Claude/gh sign-in are an fs read + a `gh auth status` exit code. The pure report builder
// (buildDepReport) takes injected IO so test/win-runner.test.js can exercise it on Linux with fakes.
const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)/;
function parseSemver(s) { const m = SEMVER_RE.exec(String(s || '')); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; }
function semverGte(have, min) {
  const a = parseSemver(have), b = parseSemver(min); if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] > b[i]) return true; if (a[i] < b[i]) return false; }
  return true;
}
// Choose a runnable hit from `where <cmd>` output (prefer .exe/.cmd/.bat over an extensionless shim — same
// CreateProcess-193 reasoning as pickClaudeBin), '' when none. Used by resolveTool for detection only.
function pickRunnable(hits) {
  const list = (hits || []).map((s) => String(s).trim()).filter(Boolean);
  return list.find((h) => /\.(exe|cmd|bat)$/i.test(h)) || list[0] || '';
}
function which(cmd) {
  try { return pickRunnable(cp.execFileSync('where', [cmd], { encoding: 'utf8' }).split(/\r?\n/)); } catch { return ''; }
}
// Detection-grade resolver: returns the binary path or '' (DISTINCT from whichNode/whichClaude, which fall
// back to a bare name so a spawn can still try). Honors the same env overrides the portable fallback writes.
function resolveTool(id) {
  if (id === 'node' && process.env.CLAUDIBLE_NODE) return process.env.CLAUDIBLE_NODE;
  if (id === 'claude' && process.env.CLAUDIBLE_CLAUDE) return process.env.CLAUDIBLE_CLAUDE;
  if (id === 'git') {
    const w = which('git'); if (w) return w;
    const b = gitBash();                         // portable git-bash (CLAUDIBLE_GIT_BASH) implies Git is present
    if (b) {
      const root = path.win32.dirname(path.win32.dirname(b));   // …\bin\bash.exe → install root
      for (const g of [path.win32.join(root, 'cmd', 'git.exe'), path.win32.join(root, 'bin', 'git.exe')]) {
        try { if (fs.existsSync(g)) return g; } catch {}
      }
      return b;                                  // installed=true even if we can't pinpoint git.exe (version may read empty)
    }
    return '';
  }
  return which(id);
}
// Run `<bin> --version`, first line. A .cmd/.bat shim (npm/winget) throws CreateProcess 193 under execFile,
// so route those through cmd /c (mirrors spawnClaude's isCmd handling); a real .exe runs directly.
function toolVersion(bin) {
  if (!bin) return '';
  try {
    const out = /\.(cmd|bat)$/i.test(bin)
      ? cp.execFileSync(process.env.COMSPEC || 'cmd.exe', ['/c', bin, '--version'], { encoding: 'utf8' })
      : cp.execFileSync(bin, ['--version'], { encoding: 'utf8' });
    return String(out).trim().split(/\r?\n/)[0] || '';
  } catch { return ''; }
}
// claude signed-in: ~/.claude/.credentials.json has a non-empty claudeAiOauth.accessToken (the canonical OAuth
// token — same precise check as wsl/check-onboard.sh:19, ported to Node). Absent → false here; main.js/deps.js
// treat "installed but not signed-in" as a SOFT gate (the Windows token can also live in Credential Manager).
function claudeSignedIn() {
  try {
    const c = JSON.parse(fs.readFileSync(path.win32.join(HOME(), '.claude', '.credentials.json'), 'utf8'));
    return !!(c && c.claudeAiOauth && c.claudeAiOauth.accessToken);
  } catch { return false; }
}
// gh sign-in + account: `gh auth status` exit 0 = signed in; `gh api user --jq .login` = handle.
function ghAuth(bin) {
  if (!bin) return { signedIn: false, account: '' };
  const isCmd = /\.(cmd|bat)$/i.test(bin);
  const run = (args) => isCmd
    ? cp.execFileSync(process.env.COMSPEC || 'cmd.exe', ['/c', bin, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    : cp.execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    run(['auth', 'status']);                     // throws (non-zero) when not signed in
    let account = '';
    try { account = String(run(['api', 'user', '--jq', '.login'])).trim().split(/\r?\n/)[0] || ''; } catch {}
    return { signedIn: true, account };
  } catch { return { signedIn: false, account: '' }; }
}
const DETECT_TOOLS = ['node', 'git', 'claude', 'uv', 'gh', 'cloudflared'];
// PURE: given injected IO, build the raw per-dep status map. deps.js merges this with the install manifest.
function buildDepReport(io) {
  const out = { gitBash: !!io.gitBashPresent() };
  for (const id of DETECT_TOOLS) {
    const bin = io.resolveTool(id);
    const installed = !!bin;
    const rec = { installed, version: installed ? io.toolVersion(id, bin) : '' };
    if (id === 'node') rec.ok = installed && semverGte(rec.version, '22.12.0');
    if (id === 'claude') rec.signedIn = installed ? io.claudeSignedIn() : false;
    if (id === 'gh') { const a = installed ? io.ghAuth(bin) : { signedIn: false, account: '' }; rec.signedIn = a.signedIn; rec.account = a.account; }
    out[id] = rec;
  }
  return out;
}
// The runner-contract method: raw dep status for the deps.js orchestrator. Pure-Node — safe with no git-bash.
function detectDeps() {
  return buildDepReport({
    resolveTool,
    toolVersion: (_id, bin) => toolVersion(bin),
    claudeSignedIn,
    ghAuth,
    gitBashPresent: () => gitBash() != null,
  });
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
    // Two env bridges for git-bash (no script rewrite, WSL/Posix unaffected since they don't set these):
    //  CLAUDIBLE_PROJ — the scripts otherwise encode the MSYS-form SDIR (/c/..) into the projects-dir key,
    //   which MISMATCHES the Windows form claude.exe used; pass the Windows-form key so they read the real store.
    //  MSYS_NO_PATHCONV — stop git-bash rewriting a leading-slash arg (e.g. `gh api '/user/repos?...'`).
    const env = Object.assign({}, process.env, {
      MSYS_NO_PATHCONV: '1',
      CLAUDIBLE_PROJ: String(sessionDir(opts.ws, HOME())).replace(/[^A-Za-z0-9]/g, '-'),
    });
    const o = { encoding: 'utf8', env };
    if (opts.timeout !== undefined) o.timeout = opts.timeout;
    if (opts.maxBuffer !== undefined) o.maxBuffer = opts.maxBuffer;
    try { cp.execFile(bash, ['-lc', cmd], o, (err, stdout) => resolve({ err: err || null, stdout: stdout || '' })); }
    catch (e) { resolve({ err: e, stdout: '' }); }
  });
}

// 🟡 voice — A0 proved whisper-server.exe runs on Windows. This runs the SAME services.sh fleet via
// git-bash (like posix/wsl run it via bash/wsl.exe), which resolves the prebuilt whisper-server.exe +
// starts kokoro. Provisioned by install.ps1 -Native (A5). Binds 127.0.0.1: unlike WSL (where the app must
// reach across the WSL netns, forcing 0.0.0.0), native Windows has no boundary, so loopback avoids the
// Firewall prompt + LAN exposure. CLAUDIBLE_BIND_HOST is honored by services.sh (defaults to 0.0.0.0).
function startVoiceServices() {
  const bash = gitBash(); const appdir = appDirGuest();
  if (!bash || !appdir) { console.error('[claudible] voice not started: git-bash unavailable (Windows)'); return; }
  const env = Object.assign({}, process.env, { MSYS_NO_PATHCONV: '1', CLAUDIBLE_BIND_HOST: '127.0.0.1' });
  try {
    cp.execFile(bash, ['-lc', `bash '${appdir}/wsl/services.sh'`], { encoding: 'utf8', env },
      (err, _stdout, stderr) => { if (err) console.error('[claudible] services.sh (win):', err.message, stderr || ''); });
  } catch (e) { console.error('[claudible] services.sh (win):', e.message); }
}
async function voiceHealth() {
  const probe = async (url) => { try { const r = await fetch(url, { method: 'GET' }); return r.status < 500; } catch { return false; } };
  const [w, k] = await Promise.all([probe(process.env.CLAUDIBLE_WHISPER || 'http://localhost:2022'), probe(process.env.CLAUDIBLE_KOKORO || 'http://localhost:8880')]);
  return { whisper: w, kokoro: k };
}
function detect() { return process.platform === 'win32' && whichClaude() !== 'claude'; }   // native claude present
function setup(_opts) { return Promise.resolve({ ok: true, note: 'Windows-native setup is install.ps1 -Native (A5)' }); }

module.exports = {
  id: 'win',
  detect, detectDeps, resetCaches,
  appDirGuest, toGuestPath, toHostPath, runtimeDir,
  ptyInfo, spawnClaude, runScript,
  startVoiceServices, voiceHealth,
  installHooks, setup,
  // pure core, exported for the unit test:
  _internals: { sessionDir, claudeProjectsDir, pickResumeTarget, claudeArgv, settingsJson, gitBash, whichClaude, pickClaudeBin, buildDepReport, semverGte, parseSemver, pickRunnable, APP_ROOT },
};
