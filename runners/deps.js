// runners/deps.js — the self-bootstrapping dependency provisioner (single source of truth).
//
// Claudible is a front-end for the Claude Code CLI; a fresh machine needs a real stack (Node, Git, a
// signed-in Claude CLI, and the optional voice/share tools). This module is the ONE declarative place that
// knows what each dependency is and how to install it — it drives detection, the install dispatch, and the
// renderer's "System check" wizard step. It lives under runners/ ON PURPOSE: package.json `build.files`
// ships only root main.js/preload.js + directory globs (runners/**, wsl/**, setup/**). A root deps.js would
// be excluded from the packaged app and crash on require; runners/** ships it.
//
// Detection NEVER routes through git-bash (the win runner's runScript needs Git, which may be the very thing
// that's missing — the chicken-and-egg). The win runner detects in pure Node (runners/win.js detectDeps);
// wsl/posix delegate to wsl/preflight.sh. Install on Windows shells a direct PowerShell script
// (setup/provision-win.ps1) — same pattern as main.js's voice provisioner — so Node/Git can be installed
// even with no git-bash present. The only thing it can't automate is the interactive Claude/GitHub login.

const path = require('path');
const cp = require('child_process');
const APP_ROOT = path.resolve(__dirname, '..');

// The manifest. `requires` orders installs (node→claude, uv→voice) — and the array order below already
// respects it, so "install all missing" can just walk the list. `restartOnInstall` is true ONLY for Git on
// Windows: main.js resolves the app-dir / git-bash as require-time consts, so a fresh Git needs a relaunch.
// `auth` = has an interactive sign-in we can't automate; `authSoft` (claude) = sign-in detection is
// unreliable on Windows (token may live in Credential Manager) so it must never hard-block.
const MANIFEST = [
  { id: 'node',        label: 'Node.js',         hint: 'Runs Claude Code’s hooks',          category: 'core',     required: true,  auth: false, requires: [],        restartOnInstall: false, win: { winget: 'OpenJS.NodeJS.LTS' },     posix: true },
  { id: 'git',         label: 'Git', winLabel: 'Git for Windows', hint: 'Drives projects, sync & checkpoints', winHint: 'Provides the bash the scripts run on', category: 'core', required: true, auth: false, requires: [], restartOnInstall: true, win: { winget: 'Git.Git' },               posix: true },
  { id: 'claude',      label: 'Claude Code CLI', hint: 'The engine Claudible embeds',            category: 'core',     required: true,  auth: true,  authSoft: true, requires: ['node'], restartOnInstall: false, win: { npm: '@anthropic-ai/claude-code' }, posix: 'install-claude.sh' },
  { id: 'uv',          label: 'uv (Python)',     hint: 'Builds the local voice stack',           category: 'voice',    required: false, auth: false, requires: [],        restartOnInstall: false, win: { winget: 'astral-sh.uv' },          posix: true },
  // WSL/posix: a real install, routed through provision.sh's `voice` case (which wraps setup.sh) like every
  // other posix dep — no `win` entry, so `installable()` still correctly reports false on the win runner,
  // which keeps its own proven path (main.js's ensureVoiceProvisioned, silent on first boot).
  { id: 'voice',       label: 'Voice models',    hint: 'Whisper + Kokoro — talk & hear',    category: 'voice',    required: false, auth: false, requires: ['uv'],    restartOnInstall: false, posix: true },
  { id: 'cloudflared', label: 'cloudflared',     hint: 'Public share links (optional)',          category: 'optional', required: false, auth: false, requires: [],        restartOnInstall: false, win: { winget: 'Cloudflare.cloudflared' }, posix: true },
  { id: 'gh',          label: 'GitHub CLI',      hint: 'Private-repo sync (optional)',           category: 'optional', required: false, auth: true,  requires: [],        restartOnInstall: false, win: { winget: 'GitHub.cli' },            posix: true },
];

// Can this runner auto-install this dep? (display-only voice is provisioned by main.js's voice path.)
function installable(m, runnerId) {
  if (m.displayOnly) return false;
  if (m.id === 'voice' && runnerId === 'win') return true;   // R34: win routes to main's ensureVoiceProvisioned — every other runner had an Install button for voice, the packaged native app had none
  if (runnerId === 'win') return !!(m.win && (m.win.winget || m.win.npm));
  return !!m.posix;   // posix/wsl: claude via install-claude.sh, others via provision.sh
}

// Compute the UI state for one dep from the raw probe map (+ main-injected voice state).
// `runnerId` matters ONLY for voice: on win, main.js's own ensureVoiceProvisioned/voiceProvisioned (the
// `extra` param) is the one true state (a native-Windows build, checked on the Windows side); on wsl/posix
// the guest-side preflight.sh probe (raw.voice) is — main.js's check looks for a Windows-only file layout
// that can never exist there, so trusting `extra` on those runners would show "missing" forever.
function rowState(m, raw, extra, runnerId) {
  if (m.id === 'voice') {
    if (runnerId === 'win') {
      if (extra && extra.voiceProvisioning) return 'installing';
      return (extra && extra.voiceReady) ? 'ready' : 'missing';
    }
    return (raw.voice && raw.voice.ready) ? 'ready' : 'missing';
  }
  const r = raw[m.id] || {};
  if (!r.installed) return 'missing';
  if (m.id === 'node' && r.ok === false) return 'outdated';
  if (m.auth) {
    if (r.signedIn) return 'ready';
    return m.authSoft ? 'unconfirmed' : 'signin';   // claude: soft (allow Continue) · gh: needs explicit sign-in
  }
  return 'ready';
}

// detect(runner, extra?) → the serialized payload the renderer consumes. `extra` carries the voice state
// main.js already computes (voiceReady/voiceProvisioning), since voice isn't in the bash probe.
async function detect(runner, extra) {
  let raw = {};
  try { raw = (await runner.detectDeps()) || {}; } catch { raw = {}; }
  const deps = MANIFEST.map((m) => {
    const r = raw[m.id] || {};
    return {
      id: m.id,
      // The win runner's git really is "Git for Windows" (git-bash runs the scripts); everywhere else —
      // including WSL-on-Windows, whose probed git is Linux git — it's plain Git.
      label: (runner.id === 'win' && m.winLabel) || m.label,
      hint: (runner.id === 'win' && m.winHint) || m.hint,
      category: m.category,
      required: !!m.required, auth: !!m.auth, authSoft: !!m.authSoft,
      requires: m.requires || [], restartOnInstall: !!m.restartOnInstall,
      installable: installable(m, runner.id),
      state: rowState(m, raw, extra, runner.id),
      version: r.version || '', account: r.account || '',
    };
  });
  // `unavailable` = the probe itself couldn't run (WSL absent, no bash). Every row below will read "missing", which
  // is technically true and completely useless — pass the real cause up so the wizard can name it once.
  return { runner: runner.id, gitBash: raw.gitBash !== false, unavailable: raw.unavailable || '', deps };
}

// Map the rich detect() result back onto the legacy onboard:status shape, so main.js can derive onboard:status
// from ONE probe (no second check-onboard.sh run) and the old wizard keeps working unchanged.
function toOnboardStatus(detectResult) {
  const by = {}; for (const d of (detectResult.deps || [])) by[d.id] = d;
  const c = by.claude || {}, g = by.gh || {};
  return {
    claudeInstalled: c.state !== 'missing',
    claudeSignedIn: c.state === 'ready',
    claudeVersion: c.version || '',
    ghInstalled: g.state !== 'missing',
    ghSignedIn: g.state === 'ready',
    ghAccount: g.account || '',
  };
}

// install(runner, depId, onProgress) → { ok, error, env, restartRequired }. `env` is any CLAUDIBLE_* the
// portable fallback emitted (main.js persists + applies them); `restartRequired` is the Git-on-win case.
async function install(runner, depId, onProgress) {
  const m = MANIFEST.find((x) => x.id === depId);
  if (!m) return { ok: false, error: 'unknown dependency', env: {}, restartRequired: false };
  if (!installable(m, runner.id)) return { ok: false, error: m.label + ' can’t be auto-installed here', env: {}, restartRequired: false };
  if (runner.id === 'win') return installWin(m, onProgress);
  return installPosix(runner, m, onProgress);
}

// Windows: spawn the per-dep PowerShell installer and stream its line-buffered `PHASE|message` output. It
// also prints `env|CLAUDIBLE_NODE=…` lines when a portable (no-winget / no-UAC) fallback is used.
function installWin(m, onProgress) {
  return new Promise((resolve) => {
    const script = path.join(APP_ROOT, 'setup', 'provision-win.ps1');
    const env = {};
    let child;
    try {
      child = cp.spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Dep', m.id], { windowsHide: true });
    } catch (e) { return resolve({ ok: false, error: 'could not start installer: ' + e.message, env, restartRequired: false }); }
    let stderr = '';
    try {
      const rl = require('readline').createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        const s = String(line); const i = s.indexOf('|'); if (i < 0) return;
        const tag = s.slice(0, i), rest = s.slice(i + 1);
        if (tag === 'env') { const j = rest.indexOf('='); if (j > 0) env[rest.slice(0, j).trim()] = rest.slice(j + 1).trim(); return; }
        if (tag === 'start' || tag === 'progress' || tag === 'done' || tag === 'error') { try { onProgress && onProgress({ dep: m.id, phase: tag, msg: rest }); } catch {} }
      });
    } catch {}
    try { child.stderr.on('data', (d) => { stderr += String(d); }); } catch {}
    child.on('error', (e) => resolve({ ok: false, error: 'installer failed to start: ' + e.message, env, restartRequired: false }));
    child.on('exit', (code) => {
      const ok = code === 0;
      resolve({ ok, error: ok ? '' : (stderr.trim().split(/\r?\n/).slice(-2).join(' ') || ('installer exited ' + code)), env, restartRequired: ok && !!m.restartOnInstall });
    });
  });
}

// WSL/Posix: reuse install-claude.sh for claude; everything else through wsl/provision.sh (apt/brew/curl).
// runScript gives no line streaming, so emit a coarse start→done/error.
async function installPosix(runner, m, onProgress) {
  try { onProgress && onProgress({ dep: m.id, phase: 'start', msg: 'Installing ' + m.label + '…' }); } catch {}
  const script = (m.posix === 'install-claude.sh') ? 'install-claude.sh' : 'provision.sh';
  const arg = (script === 'provision.sh') ? `'${m.id}'` : '';
  const { err, stdout } = await runner.runScript(script, arg, { timeout: 600000, maxBuffer: 8 * 1024 * 1024 });
  let r = {}; try { r = JSON.parse(String(stdout).trim() || '{}'); } catch {}
  const ok = !err && r.ok !== false;
  const error = ok ? '' : (r.error || (err && err.message) || 'install failed');
  try { onProgress && onProgress({ dep: m.id, phase: ok ? 'done' : 'error', msg: ok ? (m.label + ' ready') : error }); } catch {}
  return { ok, error, env: {}, restartRequired: false };
}

module.exports = { MANIFEST, detect, install, toOnboardStatus };
