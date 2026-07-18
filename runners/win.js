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
function claudeArgv(launch, home, effort, permMode) {
  const lvl = effort === 'ultracode' ? 'xhigh' : effort;   // 'ultracode' is injected post-settle by main.js
  const eff = ['low', 'medium', 'high', 'xhigh', 'max'].includes(lvl) ? ['--effort', lvl] : [];
  // Trusted/fresh permission flags from the user's remembered setting. 'default' (or unset) → Claude prompts.
  const perm = permMode === 'bypass' ? ['--dangerously-skip-permissions', '--add-dir', home]
    : permMode === 'acceptEdits' ? ['--permission-mode', 'acceptEdits'] : [];
  if (launch.foreign) return ['--resume', launch.id, ...eff];                                  // sandboxed — NEVER perm (RCE guard)
  if (launch.mode === 'fresh') return [...perm, ...eff];
  return [...perm, '--resume', launch.id, ...eff];
}
// settings.json content (Node hooks invoked via the Windows node path, per-tab paths baked as argv).
function settingsJson(claudeDir, nodeBin, statusPath, hooksPath, contextPath) {
  const sl = `"${nodeBin}" "${path.win32.join(claudeDir, 'statusline.js')}" "${statusPath}"`;
  const hk = `"${nodeBin}" "${path.win32.join(claudeDir, 'hook.js')}" "${hooksPath}"`;
  const oneHook = [{ hooks: [{ type: 'command', command: hk }] }];
  const tagHook = [{ matcher: 'Task|Agent', hooks: [{ type: 'command', command: hk }] }];
  // Identity/live-state context hook (same as the wsl backend): tells the model which machine/user/live-session
  // it's on — the fix for a transcript synced from another machine. Runs on SessionStart + alongside telemetry on
  // UserPromptSubmit (so it survives compaction). contextPath falsy → omitted (parity with session.sh's CX guard).
  const hooks = { Stop: oneHook, UserPromptSubmit: oneHook, PreToolUse: tagHook, PostToolUse: tagHook };
  if (contextPath) {
    const cx = `"${nodeBin}" "${path.win32.join(claudeDir, 'context-hook.js')}" "${contextPath}"`;
    hooks.SessionStart = [{ hooks: [{ type: 'command', command: cx }] }];
    hooks.UserPromptSubmit = [{ hooks: [{ type: 'command', command: hk }, { type: 'command', command: cx }] }];
  }
  return {
    autoCompactEnabled: false,                                       // OFF by default: Claude Code's built-in auto-compact auto-ran /compact when resuming near-full sessions (user request)
    env: { DISABLE_AUTO_COMPACT: '1' },                              // env-var form of the same toggle (belt-and-suspenders across Claude Code versions)
    statusLine: { type: 'command', command: sl },
    hooks,
  };
}
// Stage the shared Node hooks + write settings.json into <sdir>\.claude. Returns the runtime paths.
function installHooks(sdir, tabRuntimeId) {
  const cdir = path.win32.join(sdir, '.claude');
  const rt = path.join(runtimeDir(), 'tabs', String(tabRuntimeId || 'default'));   // writable runtime root (CLAUDIBLE_RUNTIME when packaged), matches what main.js's pollers read
  const statusPath = path.join(rt, 'status.json');
  const hooksPath = path.join(rt, 'hooks.ndjson');
  const contextPath = path.join(rt, 'context.json');   // identity/live-state main writes; the context hook reads it (matches main.js's per-tab path)
  fs.mkdirSync(cdir, { recursive: true }); fs.mkdirSync(rt, { recursive: true });
  try { fs.writeFileSync(hooksPath, ''); fs.writeFileSync(statusPath, '{}'); } catch {}   // fresh per launch
  // Take ownership of <sdir>\.claude the same way wsl/session.sh does, and BEFORE the first overwrite below.
  // Claudible created the folder for its own workspaces, but an ADOPTED folder is the user's project: their
  // statusline.js / hook.js / settings.json (permissions, MCP servers) live under these exact names. Snapshot
  // each one once. The sidecar records it — Claude Code warns on unknown keys inside settings.json, so no marker
  // goes in the JSON. Keep this list in sync with wsl/session.sh's.
  const owned = path.win32.join(cdir, '.claudible-owned');
  if (!fs.existsSync(owned)) {
    // A .claude that predates the sidecar but is already OURS must not be "backed up" — that would litter every
    // existing workspace with a copy of Claudible's own settings. Two markers together, neither plausible in a
    // hand-written config: the DISABLE_AUTO_COMPACT env we set, and a statusLine command inside this .claude.
    let mine = false;
    try {
      const s = fs.readFileSync(path.win32.join(cdir, 'settings.json'), 'utf8');
      mine = s.includes('DISABLE_AUTO_COMPACT') && /\.claude[\\/]+statusline/.test(s);
    } catch { mine = false; }   // no settings.json → nothing of theirs to lose either way
    if (!mine) {
      for (const f of ['settings.json', 'statusline.js', 'hook.js', 'context-hook.js']) {
        const p = path.win32.join(cdir, f);
        try { if (fs.existsSync(p)) fs.copyFileSync(p, p + '.pre-claudible'); } catch {}
      }
    }
    try { fs.writeFileSync(owned, ''); } catch {}
  }
  // ATOMIC + skip-if-identical staging (mirrors wsl/session.sh's stage_hook): .claude is WORKSPACE-shared and
  // every tab on this project respawns through here concurrently. A plain copy/write truncates-then-fills, so
  // a sibling's Claude parsing a half-written hook/settings silently loses telemetry for its whole session.
  const stage = (src, dest) => {
    try { const a = fs.readFileSync(src), b = fs.readFileSync(dest); if (a.equals(b)) return true; } catch {}
    const tmp = dest + '.cltmp.' + process.pid;
    fs.copyFileSync(src, tmp); fs.renameSync(tmp, dest);
    return true;
  };
  stage(path.join(APP_ROOT, 'hooks', 'statusline.js'), path.win32.join(cdir, 'statusline.js'));
  stage(path.join(APP_ROOT, 'hooks', 'hook.js'), path.win32.join(cdir, 'hook.js'));
  // Stage the context hook too (additive; its absence in an older bundle just omits the identity injection).
  let hasContext = false;
  try { stage(path.join(APP_ROOT, 'hooks', 'context-hook.js'), path.win32.join(cdir, 'context-hook.js')); hasContext = true; } catch {}
  // MUST be a real node.exe, NOT process.execPath (= electron.exe under Electron, which won't run a .js
  // without ELECTRON_RUN_AS_NODE). Claudible's installer guarantees Windows Node 22.12+ on PATH.
  const nodeBin = whichNode();
  // settings.json was snapshotted by the ownership block above, alongside the hook scripts. Safe to overwrite —
  // atomically (tmp+rename), same concurrent-tabs reasoning as the hook staging above.
  const settingsTxt = JSON.stringify(settingsJson(cdir, nodeBin, statusPath, hooksPath, hasContext ? contextPath : ''), null, 2);
  const sPath = path.win32.join(cdir, 'settings.json');
  let same = false; try { same = fs.readFileSync(sPath, 'utf8') === settingsTxt; } catch {}
  if (!same) { const tmp = sPath + '.cltmp.' + process.pid; fs.writeFileSync(tmp, settingsTxt); fs.renameSync(tmp, sPath); }
  return { cdir, statusPath, hooksPath, contextPath };
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
function resetCaches() { _bash = undefined; _appdirMsys = undefined; _claudePresent = undefined; }

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
// Cheap "is claude on PATH?" — lets main.js gate the terminal spawn so a missing claude shows a friendly
// "connect Claude" prompt instead of crashing to "session ended". Pure-Node, no git-bash. wsl/posix don't
// expose this (their claude lives in the guest). The POSITIVE result is memoized (claude doesn't vanish
// mid-session) so the per-spawn/per-exit gate isn't a repeated subprocess; a FALSE re-checks every call (so a
// freshly-installed claude is picked up) and resetCaches() clears it after an install. A `where` that THROWS a
// spawn error (vs exit 1 = genuinely not found) is treated as PRESENT, so a transient hiccup never false-nags.
let _claudePresent;
function claudePresent() {
  if (_claudePresent === true) return true;
  if (process.env.CLAUDIBLE_CLAUDE) return (_claudePresent = true);
  try {
    const out = cp.execFileSync('where', ['claude'], { encoding: 'utf8' });
    return (_claudePresent = pickRunnable(out.split(/\r?\n/)) !== '');
  } catch (e) {
    if (e && e.status === 1) return (_claudePresent = false);   // `where` ran, found nothing → genuinely absent
    return true;                                                 // spawn glitch (not exit 1) → assume present, don't false-nag
  }
}
// Focused, claude-only state for the Connect-Claude dot + popup — avoids detectDeps's full 6-tool + gh-network
// probe (which must NOT run on every launch / 3s poll tick). installed via claudePresent, signed-in via the
// credentials read; no `claude --version` subprocess (the dot doesn't need it).
function claudeState() { const installed = claudePresent(); return { installed, signedIn: installed ? claudeSignedIn() : false }; }

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

// The env for a spawned claude.exe — a PURE function (exported) so the spacebar guard can never be silently
// dropped by a refactor. SPACEBAR / "can't type into a resumed session" fix (parity with wsl/session.sh):
// Claude Code 2.1.x shows a BLOCKING "resume from summary?" 1/2/3 modal when resuming a session past
// CLAUDE_CODE_RESUME_THRESHOLD_MINUTES (default 70) AND CLAUDE_CODE_RESUME_TOKEN_THRESHOLD (default 100k).
// That modal swallows every ordinary keystroke — space included — so a big/old resumed session looks like
// "typing does nothing", while a new one works. Claudible already keeps full context (autoCompactEnabled:false),
// so push both thresholds out of reach → resumed sessions open straight into the composer. Layering: our
// defaults first, then base (real env) OVERRIDES them so an explicit user setting wins, then CLAUDIBLE_TAB is
// always this tab's runtime id.
function spawnEnv(runtimeId, base, modelStrategy) {
  const defaults = {
    CLAUDE_CODE_RESUME_THRESHOLD_MINUTES: '2000000000',
    CLAUDE_CODE_RESUME_TOKEN_THRESHOLD: '2000000000',
  };
  // "Plan big, execute small" (Anthropic cookbook pattern, parity with wsl/session.sh): the main session
  // plans/synthesizes on the user's chosen model; SUBAGENTS — the token-heavy leg — run on Sonnet 5.
  // Defaults-first layering means an explicit user env override of either var still wins.
  if (modelStrategy === 'planBigExecSmall') {
    defaults.CLAUDE_CODE_SUBAGENT_MODEL = 'claude-sonnet-5';
    defaults.CLAUDIBLE_MODEL_STRATEGY = 'planBigExecSmall';   // read by the context hook for the delegation nudge
  }
  return Object.assign(defaults, base || process.env, { CLAUDIBLE_TAB: String(runtimeId || 'default') });
}

// Resume-refusal fallback — mirror of wsl/session.sh's timing guard (lines 288-318): some claude builds
// REFUSE to resume a given session (e.g. one that ended mid-tool-call) and exit almost immediately instead
// of opening the TUI, while a real resumed session blocks until quit. session.sh detects that by timing the
// attempt (< 4s = suspicious) and by RC>=128 (POSIX "died to a signal" — i.e. OUR OWN kill on a tab
// switch/close, which must NOT trigger a phantom fresh session). node-pty hands both `signal` AND (via the
// wrapping facade below) a direct `wasKilled` flag, so this is stricter than the RC>=128 heuristic — either
// one blocks the fallback. PURE (no Date.now() inside) so it's unit-testable: test/win-runner.test.js drives
// the full matrix. Exported via _internals.
function shouldFallbackToFresh(spawnedAtMs, exitedAtMs, code, signal, wasKilled, wasResume) {
  if (!wasResume) return false;                       // only a RESUME attempt can be "refused" — nothing to fall back from for a fresh launch
  if (wasKilled) return false;                         // we killed it ourselves (tab switch/close) — a fresh respawn here would be an orphaned phantom
  if (signal) return false;                            // died to a signal, not a plain exit — same "not a refusal" case
  const elapsed = (exitedAtMs || 0) - (spawnedAtMs || 0);
  return elapsed < 4000;                               // real interactive sessions run far longer than 4s; a near-instant return is a refusal
}

// 🟡 spawnClaude — the live glue (needs a Windows smoke). Runs the pure bootstrap, then ConPTY-spawns
// the Windows claude with WINDOWS-path args. ConPTY hosts a native console app fine (it hosts cmd/pwsh).
//
// Returns a STABLE facade object (not the raw node-pty handle): a refused `--resume` (shouldFallbackToFresh
// above) transparently respawns ONCE with fresh-session argv on the same pty dimensions, swapping the facade's
// inner process while main.js's onData/onExit/write/resize/kill callers keep the same reference throughout
// (the `ptys.get(tabId)?.proc !== proc` guard in main.js's spawnPty depends on that object identity never
// changing across a fallback). Contract-checked against main.js's spawnPty/respawnPty consumers: onData(cb),
// onExit(cb), write(data), resize(cols,rows), kill(signal), .pid, .claudibleForeign — all present here.
function spawnClaude(tabId, { cols, rows, session, ws, effort, runtimeId, permMode, modelStrategy } = {}) {
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
  const claude = whichClaude();
  const env = spawnEnv(runtimeId, undefined, modelStrategy);
  const dims = { cols: cols || 120, rows: rows || 32 };
  // node-pty + a .cmd shim: spawn via cmd /c so the shim resolves (the known ConPTY .cmd quirk). Same for
  // both the initial launch and a fallback respawn (the claude binary/shim shape never changes mid-tab).
  const isCmd = /\.cmd$|\.bat$/i.test(claude) || claude === 'claude';
  const file = isCmd ? (process.env.COMSPEC || 'cmd.exe') : claude;
  function spawnInner(l) {
    const argv = claudeArgv(l, home, effort, permMode);
    const args = isCmd ? ['/c', claude, ...argv] : argv;
    return pty.mod.spawn(file, args, { name: 'xterm-256color', cols: dims.cols, rows: dims.rows, cwd: sdir, env });
  }

  let inner = spawnInner(launch);
  const spawnedAtMs = Date.now();
  const wasResume = launch.mode === 'resume';
  let killedByUs = false;      // set by facade.kill() — distinguishes "we ended this pty" from a genuine refusal
  let fallbackUsed = false;    // at most ONE fallback per spawn (loop guard)
  let dataCb = null, exitCb = null, innerDataSub = null, innerExitSub = null;

  function wireInner() {
    innerDataSub = inner.onData((d) => { if (dataCb) dataCb(d); });
    innerExitSub = inner.onExit((e) => onInnerExit(e || {}));
  }
  function onInnerExit(e) {
    const exitedAtMs = Date.now();
    if (!fallbackUsed && shouldFallbackToFresh(spawnedAtMs, exitedAtMs, e.exitCode, e.signal, killedByUs, wasResume)) {
      fallbackUsed = true;
      console.log('[claudible] win: resume refused (fast exit, not a kill) — falling back to a fresh session');
      try { innerDataSub && innerDataSub.dispose(); } catch {}
      try { innerExitSub && innerExitSub.dispose(); } catch {}
      inner = spawnInner({ mode: 'fresh' });
      wireInner();
      return;
    }
    if (exitCb) exitCb(e);
  }
  wireInner();

  const facade = {
    get pid() { return inner.pid; },
    onData(cb) { dataCb = cb; return { dispose() { if (dataCb === cb) dataCb = null; } }; },
    onExit(cb) { exitCb = cb; return { dispose() { if (exitCb === cb) exitCb = null; } }; },
    write(d) { try { inner.write(d); } catch {} },
    resize(c, r) { dims.cols = c; dims.rows = r; try { inner.resize(c, r); } catch {} },
    pause() { try { inner.pause(); } catch {} },
    resume() { try { inner.resume(); } catch {} },
    kill(signal) {
      killedByUs = true;
      // R22: ConPTY's kill can be single-process under the known Electron/node-pty failure — the
      // claude.exe → node child tree survived every close path and piled up across restarts (the
      // win-native twin of what killtree.sh exists for on WSL; that script never runs here). taskkill /T
      // walks ParentProcessId at the OS level; /F because the survivors have no console for a soft close.
      // Detached + unref'd so the quit sweep's reap outlives app.quit() — the same guarantee the WSL
      // reaper relies on. Captured BEFORE kill: inner.pid may be unreadable after the process dies.
      const pid = inner && inner.pid;
      try { inner.kill(signal); } catch {}
      if (pid) { try { const c = cp.spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, detached: true, stdio: 'ignore' }); c.unref(); } catch {} }
    },
  };
  // Surface the RCE-guard override instead of sandboxing silently (parity with session.sh's echoed notice —
  // main injects the same line into the terminal when it sees this flag). Never weakens the guard: argv above
  // already excluded the perm flags for a foreign resume. Reflects the INITIAL decision only — a fallback
  // (fresh) is never foreign, but by the time one could happen main.js has already read this synchronously.
  if (launch.foreign) { facade.claudibleForeign = true; console.log('[claudible] win: foreign (collaborator-synced) session — sandboxed regardless of permission-mode setting'); }
  return facade;
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
    if (opts.detach) { o.detached = true; o.windowsHide = true; }   // quit-path scripts (presence-clear) must survive app.quit() — see wsl.js runScript
    try {
      const child = cp.execFile(bash, ['-lc', cmd], o, (err, stdout) => resolve({ err: err || null, stdout: stdout || '' }));
      if (opts.detach && child && child.unref) child.unref();
    } catch (e) { resolve({ err: e, stdout: '' }); }
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
    // via scriptCmd, not a hand-rolled string: it is the ONE builder that escapes the app dir (see _shared.js shq).
    cp.execFile(bash, ['-lc', shared.scriptCmd(appdir, 'services.sh')], { encoding: 'utf8', env },
      (err, _stdout, stderr) => { if (err) console.error('[claudible] services.sh (win):', err.message, stderr || ''); });
  } catch (e) { console.error('[claudible] services.sh (win):', e.message); }
}
function detect() { return process.platform === 'win32' && whichClaude() !== 'claude'; }   // native claude present

module.exports = {
  id: 'win',
  detect, detectDeps, resetCaches, claudePresent, claudeState,
  appDirGuest, toGuestPath, toHostPath, runtimeDir,
  ptyInfo, spawnClaude, runScript,
  startVoiceServices,
  // pure core, exported for the unit test:
  _internals: { sessionDir, claudeProjectsDir, pickResumeTarget, claudeArgv, settingsJson, spawnEnv, gitBash, whichClaude, pickClaudeBin, buildDepReport, semverGte, parseSemver, pickRunnable, APP_ROOT, shouldFallbackToFresh },
};
