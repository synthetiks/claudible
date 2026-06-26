// Claudible — Electron main process.
//  • embeds the live Claude session (node-pty -> wsl session.sh -> claude, run directly, no tmux),
//    spawned at the renderer's fitted size so the TUI never reflows/garbles
//  • auto-confirms the WSL "trust this folder" prompt
//  • reads runtime/status.json (session tracker) + runtime/hooks.ndjson (Claude hook events)
//    from the WINDOWS FS natively (no flaky 9P watch)
//  • STT/TTS fetches run here (no renderer CORS)
const { app, BrowserWindow, ipcMain, session, dialog, clipboard, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { createShareServer } = require('./share/server');
const { renderReplayHtml } = require('./share/replay');
const { startCloudflared } = require('./share/cloudflared');
// A packaged (installed) build runs from a READ-ONLY app dir, so writable runtime state can't live there. On
// packaged WINDOWS we set two env signals BEFORE the runner is selected/queried below:
//  • CLAUDIBLE_RUNTIME — relocate runtime/ (settings.json, workspaces.json, per-tab status/hooks) under the user's
//    ~/.claudible so it survives reinstall/upgrade and never EPERMs. Every runner's runtimeDir() reads this.
//  • CLAUDIBLE_RUNNER=win — use the native runner (no WSL); it bakes hook paths from runtimeDir() and never shells
//    bash session.sh, so writers (hooks) and readers (pollers) resolve to the SAME relocated dir — fully coherent.
// Scoped to win32 ON PURPOSE: a packaged Linux/macOS build uses the Posix runner whose bash session.sh still
// derives runtime/ from $APPDIR, so relocating only the JS side would desync it. Thread the runtime root into
// session.sh BEFORE shipping those installers; until then the Posix packaged path is left exactly as-is.
// Dev (electron .) and the git-clone/script install leave both env vars unset → WSL/Posix runner + ./runtime.
if (app.isPackaged && process.platform === 'win32') {
  if (!process.env.CLAUDIBLE_RUNTIME) process.env.CLAUDIBLE_RUNTIME = path.join(app.getPath('home'), '.claudible', 'runtime');
  if (!process.env.CLAUDIBLE_RUNNER) process.env.CLAUDIBLE_RUNNER = 'win';
}
const runner = require('./runners/runner').select();
const deps = require('./runners/deps');   // self-bootstrapping dependency provisioner (detect + install + manifest)

let win;
// Multi-tab: each Claudible tab is its own live session/pty. `ptys` maps a renderer-issued tabId to a
// per-tab record { proc, cols, rows, trustDone, ws, session, runtimeId, busy, busyTimer }. `fgTabId` is
// the FOREGROUND tab — the only one mirrored to guests; the global activeWorkspace/registry.activeId are
// kept in lockstep with it (via setForegroundTab) so all existing active-workspace logic (sessions list,
// sync, share grant) keeps working unchanged.
const ptys = new Map();
let fgTabId = null;
const tabIntent = new Map();   // tabId -> { ws, session } recorded by tab:open, consumed by the next pty:start
function fgRec() { return ptys.get(fgTabId) || null; }
// Native live-join: a JOINED peer session is NOT a local pty — it's a CLIENT WebSocket (held in main because the
// renderer's CSP forbids a wss:// socket) that mirrors a peer's terminal into a cockpit tab. Kept entirely
// separate from `ptys`/`fgTabId` so watching/co-driving a peer NEVER touches the user's own outgoing share.
const { WebSocket: LiveSocket } = require('ws');
const liveTabs = new Map();    // tabId -> { ws, url, token, name, hostCols, hostRows, pid, readOnly, resume, retry, closed, peer }
// Live terminal sharing: server runs locally (loopback); cloudflared carries the last hop. See share/.
let cloudflaredProc = null, shareBaseUrl = null;
const share = createShareServer({
  onInput: (d) => { const t = ptys.get(fgTabId); try { t && t.proc.write(d); } catch {} },   // a guest typed → into the FOREGROUND pty
  onGuests: (n) => { try { win && win.webContents.send('share:guests', n); } catch {} },
  onRoster: (roster) => { try { win && win.webContents.send('share:roster', roster); } catch {} },   // presence lights
  onApprovalRequest: (info) => { try { win && win.webContents.send('share:approval', info); } catch {} },
  onApprovalCancel: (id) => { try { win && win.webContents.send('share:approval-cancel', id); } catch {} },
  onChat: (m) => { try { win && win.webContents.send('share:chat', m); } catch {} },   // guest → host chat
  // A guest clicked a (granted) workspace in their viewer → switch the shared terminal to it, and tell the host UI.
  onSwitchWorkspace: (id) => {
    const ws = registry.workspaces.find((w) => w.id === id && w.shared);
    if (!ws) return;                                                   // only granted workspaces are switchable
    openGen++;                                                         // supersede any in-flight workspace:open clone
    const rec = fgRec(); if (rec) rec.ws = ws;                         // re-point the shared (foreground) tab at that ws
    activeWorkspace = ws; registry.activeId = id; saveRegistry();
    respawnPty(fgTabId, '');                                           // resume the most-recent conversation in that cwd
    try { win && win.webContents.send('workspace:active-changed', id); } catch {}
  },
  // A guest browses a SHARED workspace's saved sessions, read-only — independent of the live terminal. Lists
  // that workspace's conversations and (separately) reads one transcript for display. Only SHARED workspaces
  // are reachable (the server already gates wsId to the granted list; we re-check w.shared as defense in depth).
  onBrowseSessions: (wsId, reply) => {
    const ws = registry.workspaces.find((w) => w.id === wsId && w.shared);
    if (!ws || !APPDIR_WSL) return reply({ type: 'ws-sessions', wsId, list: [] });
    runner.runScript('sessions.sh', '', { ws, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }).then(({ err, stdout }) => {
        let list = []; try { list = JSON.parse(String(stdout).trim() || '[]'); } catch {}
        reply({ type: 'ws-sessions', wsId, label: ws.label, list: Array.isArray(list) ? list : [] });
      });
  },
  onBrowseTranscript: (wsId, sessionId, reply) => {
    const ws = registry.workspaces.find((w) => w.id === wsId && w.shared);
    const sid = String(sessionId || '').replace(/[^A-Za-z0-9-]/g, '');   // strict id (also the bash-interp invariant)
    if (!ws || !sid || !APPDIR_WSL) return reply({ type: 'ws-transcript', wsId, sessionId: sid, msgs: [] });
    runner.runScript('transcript.sh', `'${sid}'`, { ws, timeout: 30000, maxBuffer: 16 * 1024 * 1024 }).then(({ err, stdout }) => {
        let msgs = []; try { msgs = JSON.parse(String(stdout).trim() || '[]'); } catch {}
        reply({ type: 'ws-transcript', wsId, sessionId: sid, msgs: Array.isArray(msgs) ? msgs : [] });
      });
  },
  // Voice room (WebRTC) — the server is signaling-only; audio is peer-to-peer. Bridge the host cockpit's
  // voice membership + audio frames go back to the cockpit renderer (over IPC).
  onVoiceMembers: (members) => { try { win && win.webContents.send('share:voice-members', members); } catch {} },
  onAudio: (frame) => { try { win && win.webContents.send('share:audio', frame); } catch {} },   // a guest's voice frame → cockpit
});
ipcMain.on('share:voice', (e, { join } = {}) => { try { share.hostVoiceSet(!!join); } catch {} });
ipcMain.on('share:audio-send', (e, p) => { try { share.audioFromHost(p && p.data, p && p.sr); } catch {} });   // cockpit's voice frame → guests
const WHISPER = process.env.CLAUDIBLE_WHISPER || 'http://localhost:2022';
const KOKORO  = process.env.CLAUDIBLE_KOKORO  || 'http://localhost:8880';
const RT = runner.runtimeDir();   // per-tab status/hooks live under RT/tabs/<tabId>/ (see pollers)
// Durable settings (Claudible username + every renderer pref). Lives in gitignored runtime/ so it survives
// restarts, force-kills (written synchronously) and `git reset --hard`, and never leaks into the public repo.
// The sandboxed preload can't use fs, so MAIN owns the file; these handlers are registered at top level here
// (before any window loads) because the preload reads it via a blocking sendSync.
const SETTINGS_FILE = path.join(RT, 'settings.json');
function readSettings() { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {}; } catch { return {}; } }
ipcMain.on('settings:get', (e) => { e.returnValue = readSettings(); });
ipcMain.on('settings:set', (e, obj) => { try { fs.mkdirSync(RT, { recursive: true }); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj && typeof obj === 'object' ? obj : {}, null, 2)); e.returnValue = true; } catch (err) { console.error('[claudible] settings.json:', err.message); e.returnValue = false; } });   // sendSync: the renderer blocks until the file is written, so a force-kill right after savePrefs can't lose it (A2)
// Self-bootstrap (provisioner): re-apply any dependency env the provisioner persisted — a portable Node/Git
// the no-UAC fallback dropped under ~/.claudible (CLAUDIBLE_NODE / CLAUDIBLE_GIT_BASH), plus captured bin dirs.
// MUST run BEFORE APPDIR_WSL + the win runner's git-bash resolve below, so a relaunch right after a Git install
// finds bash and workspaces/sync/diff come alive. No-op when nothing was persisted; never overrides a live env.
(function applyPersistedDepEnv() {
  try {
    const s = readSettings();
    const e = s && s.depEnv;
    if (e && typeof e === 'object') for (const [k, v] of Object.entries(e)) {
      if (/^CLAUDIBLE_[A-Z_]+$/.test(k) && typeof v === 'string' && v && !process.env[k]) process.env[k] = v;
    }
    if (s && typeof s.depPath === 'string' && s.depPath) for (const bin of s.depPath.split(path.delimiter)) {
      if (bin && !String(process.env.PATH || '').split(path.delimiter).includes(bin)) process.env.PATH = bin + path.delimiter + (process.env.PATH || '');
    }
  } catch {}
})();
// Resolve THIS app's own folder as a WSL path (C:\Users\X\claudible -> /mnt/c/Users/X/claudible) so the
// bootstrap script + runtime files work for ANY user/location — no hardcoded home. wslpath does it robustly.
const APPDIR_WSL = runner.appDirGuest();   // guest-side app dir (runner-owned; was wslpath of __dirname)
// Guest-side runtime root (host RT translated for the execution space: wslpath on WSL, cygpath on win, identity on
// Posix). diff-apply hands bash a temp path UNDER runtime/, so it must track RT wherever RT now lives (not assume
// it sits beside the app dir). Empty if translation is unavailable — diff then fails safe via diffAction's guard
// (and diff-apply.sh's own [ -f "$tmp" ] check), rather than pointing at a stale/wrong path.
const RT_GUEST = runner.toGuestPath(RT) || '';
// session.sh receives the app dir as $1 so it writes runtime/ to the SAME Windows folder this process reads.
// A session choice ('new' | a <session-id> | '') is passed via CLAUDIBLE_SESSION on the command line
// (env vars don't cross the Windows→WSL boundary without WSLENV, so we inline it). The id is sanitised
// to [A-Za-z0-9-] so it can't break out of the quoted command.
// Inline the active workspace as env (kind + strict-allowlisted slug) so the wsl scripts run in THAT
// workspace's own cwd. slug is re-sanitised here too (defense in depth) since it's interpolated into bash.
function tabRuntimeId(tabId) { return String(tabId || '').replace(/[^A-Za-z0-9-]/g, '') || 'default'; }
try { fs.mkdirSync(RT, { recursive: true }); } catch {}
// Sweep orphaned diff-action temp files from a previous run (a crash/kill between write and unlink) — M1.
try { for (const f of fs.readdirSync(RT)) if (/^diffaction-.*\.tmp$/.test(f)) { try { fs.unlinkSync(path.join(RT, f)); } catch {} } } catch {}

// ---- workspaces registry (each workspace = a directory the sessions live in) ----
// App-maintained source of truth (we NEVER blanket-scan ~/.claude/projects). A 'legacy' entry points at
// the original single session dir so existing history keeps showing. Persisted on the Windows FS (native read).
const WORKSPACES = path.join(RT, 'workspaces.json');
function loadRegistry() {
  let reg = { activeId: 'legacy', workspaces: [] };
  try { const r = JSON.parse(fs.readFileSync(WORKSPACES, 'utf8')); if (r && typeof r === 'object') reg = r; } catch {}
  if (!Array.isArray(reg.workspaces)) reg.workspaces = [];
  reg.workspaces = reg.workspaces.filter((w) => w && typeof w === 'object' && w.id);   // drop malformed entries (no launch crash)
  if (!reg.workspaces.some((w) => w && w.id === 'legacy'))
    reg.workspaces.unshift({ id: 'legacy', label: 'My sessions', kind: 'legacy', slug: '', createdAt: 0 });
  if (!reg.activeId || !reg.workspaces.some((w) => w.id === reg.activeId)) reg.activeId = 'legacy';
  return reg;
}
function saveRegistry() { try { fs.writeFileSync(WORKSPACES, JSON.stringify(registry, null, 2)); } catch (e) { console.error('[claudible] workspaces.json:', e.message); } }
let registry = loadRegistry();
let activeWorkspace = registry.workspaces.find((w) => w.id === registry.activeId) || registry.workspaces[0];

// Bring up the local voice services (Whisper/Kokoro) on launch. services.sh is idempotent (it checks
// the ports first), so this is safe whether the user runs `npm start` directly or via the .ps1 launcher
// (which also calls it). Async execFile so the ~5s port-wait never blocks window creation.
function startVoiceServices() { runner.startVoiceServices(); }

// First-run voice provisioning — packaged native Windows only. The installer ships the app, NOT the multi-GB
// Kokoro/torch + Whisper model stack (it can't be bundled). So on first launch, if the voice assets aren't here
// yet, run the PROVEN setup-win.ps1 (the same script install.ps1 -Native uses) to fetch/build them, then start
// the services. Reuses the script wholesale (no duplicated logic), is idempotent (re-runs safely if interrupted),
// and NEVER blocks the terminal — a failure just leaves voice unavailable with retry-on-reopen.
// winget/npm write the registry PATH, not THIS process's env — so a tool installed at runtime is invisible
// until refreshed. Reload PATH from the machine+user registry and fold in the dirs winget/npm/uv drop bins
// into, so a freshly-installed dep resolves WITHOUT a restart (the non-Git provisioner path). Windows-only.
function refreshWindowsPath() {
  if (process.platform !== 'win32') return;
  try {
    const out = require('child_process').execFileSync('powershell.exe',
      ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"],
      { encoding: 'utf8', windowsHide: true });
    const merged = String(out).trim();
    if (merged) process.env.PATH = merged + path.delimiter + (process.env.PATH || '');
  } catch {}
  const home = app.getPath('home');
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  for (const bin of [path.join(roaming, 'npm'), path.join(local, 'Microsoft', 'WinGet', 'Links'), path.join(home, '.local', 'bin')]) {
    if (!String(process.env.PATH || '').split(path.delimiter).includes(bin)) process.env.PATH = bin + path.delimiter + (process.env.PATH || '');
  }
}

function voiceProvisioned() {
  const v = process.env.CLAUDIBLE_VOICE || path.join(app.getPath('home'), '.claudible', 'voice');   // same root setup-win.ps1 writes to (else re-provisions forever)
  try {
    return fs.existsSync(path.join(v, 'whisper', 'Release', 'whisper-server.exe'))
        && fs.existsSync(path.join(v, 'whisper', 'models', 'ggml-base.bin'))
        && fs.existsSync(path.join(v, 'kokoro', 'api', 'src', 'models', 'v1_0', 'kokoro-v1_0.pth'));
  } catch { return false; }
}
let provisioning = false;
function ensureVoiceProvisioned() {
  // Only the packaged native-Windows path self-provisions; dev / WSL / the script install already set voice up.
  if (provisioning || !app.isPackaged || process.platform !== 'win32' || process.env.CLAUDIBLE_RUNNER !== 'win') return false;
  // Voice setup (setup-win.ps1) git-clones Kokoro + runs through git-bash, so it REQUIRES Git. On a freshly-set-up
  // machine Git isn't here yet — the System-check step installs it (then restarts). Until git-bash resolves
  // (APPDIR_WSL non-null), skip: otherwise the Kokoro clone fails on first launch and shows a spurious
  // "voice setup didn't finish" chip that has nothing to do with the dependency provisioner. Voice provisions
  // cleanly on the next launch, once Git is present. No behavior change on an already-set-up machine.
  if (!APPDIR_WSL) return false;
  if (voiceProvisioned()) return false;
  provisioning = true;
  const home = app.getPath('home');
  const send = (phase, msg) => { try { win && win.webContents.send('provision', { dep: 'voice', phase, msg }); } catch {} };   // dep tag: the renderer routes voice events to the chip, per-dep events to the System-check rows
  let out = 'ignore'; try { fs.mkdirSync(path.join(home, '.claudible', 'logs'), { recursive: true }); out = fs.openSync(path.join(home, '.claudible', 'logs', 'provision.out'), 'a'); } catch {}
  const closeOut = () => { try { if (typeof out === 'number') fs.closeSync(out); } catch {} };   // release the log fd when the child ends
  const script = path.join(__dirname, 'setup', 'setup-win.ps1');   // shipped in the bundle (asar:false, setup/** included)
  send('start', 'Setting up voice for the first time — downloading models (a few hundred MB, can take several minutes)…');
  let child;
  try {
    child = require('child_process').spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, stdio: ['ignore', out, out] });
  } catch (e) { provisioning = false; closeOut(); send('error', 'Voice setup could not start: ' + e.message); startVoiceServices(); return true; }
  child.on('error', (e) => { provisioning = false; closeOut(); send('error', 'Voice setup could not start: ' + e.message); startVoiceServices(); });
  child.on('exit', (code) => {
    provisioning = false; closeOut();
    if (code === 0) {
      // setup-win.ps1 just installed uv — to %USERPROFILE%\.local\bin (astral script) OR winget's Links dir. This
      // process's PATH is stale, so surface both before starting the services that shell out to uv; if neither
      // resolves (rare), the 'done' note tells the user to reopen (a fresh process inherits the registry PATH).
      const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
      for (const bin of [path.join(home, '.local', 'bin'), path.join(local, 'Microsoft', 'WinGet', 'Links')]) {
        if (!String(process.env.PATH || '').split(path.delimiter).includes(bin)) process.env.PATH = bin + path.delimiter + (process.env.PATH || '');
      }
      send('done', 'Voice ready. (If you don’t hear replies, reopen Claudible.)');
      startVoiceServices();
    } else {
      send('error', 'Voice setup didn’t finish (code ' + code + '). See %USERPROFILE%\\.claudible\\logs\\provision.out; reopen Claudible to retry.');
    }
  });
  return true;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 860, backgroundColor: '#070809',
    icon: path.join(__dirname, 'assets', 'claudible.ico'),   // window + taskbar branding (the headphones/mic guy)
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  Menu.setApplicationMenu(null);   // no default menu → no View>Reload/Force-Reload that would re-init pollers & corrupt the hook stream
  // Grant ONLY the microphone (needed for push-to-talk); deny every other permission request.
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'media'));
  // Lock the window down: it only ever loads our local renderer. Block navigation away and any
  // attempt to open new windows — defense-in-depth for distributed Electron software.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // Optional diagnostics (opt-in): launch with CLAUDIBLE_DEBUG=1 to capture the renderer console + crashes
  // to .claudible-debug.log and auto-open DevTools. OFF by default, so nothing pops up in normal use.
  const DEBUG = !!process.env.CLAUDIBLE_DEBUG;
  if (DEBUG) {
    const dbgLog = app.isPackaged ? path.join(RT, 'debug.log') : path.join(__dirname, '.claudible-debug.log');   // writable root when installed; dev path unchanged
    const dbg = (s) => { try { fs.appendFileSync(dbgLog, new Date().toISOString() + ' ' + s + '\n'); } catch {} };
    try { fs.writeFileSync(dbgLog, new Date().toISOString() + ' [start] Claudible launched\n'); } catch {}
    win.webContents.on('console-message', (...a) => {
      let lvl, msg = '', src = '';
      const M = { debug: 0, verbose: 0, info: 1, log: 1, warning: 2, warn: 2, error: 3 };
      if (typeof a[1] === 'number') { lvl = a[1]; msg = a[2]; src = (a[4] || '') + ':' + a[3]; }
      else { const o = a[0] || {}; lvl = (M[o.level] != null) ? M[o.level] : 1; msg = (o.message != null) ? o.message : ''; src = (o.sourceId || '') + ':' + (o.lineNumber || ''); }
      dbg('[console L' + lvl + '] ' + msg + '  (' + src + ')');
    });
    win.webContents.on('render-process-gone', (e, d) => dbg('[render-process-gone] ' + JSON.stringify(d)));
    win.webContents.on('preload-error', (e, p, err) => dbg('[preload-error] ' + p + ' ' + (err && err.message)));
    win.webContents.on('unresponsive', () => dbg('[unresponsive]'));
  }
  win.loadFile('renderer/index.html');
  win.webContents.once('did-finish-load', () => {   // one-shot, scoped to this contents: a reload won't stack a 2nd set of pollers/timers
    if (DEBUG) { try { win.webContents.openDevTools({ mode: 'detach' }); } catch {} }   // only with CLAUDIBLE_DEBUG=1
    if (!ensureVoiceProvisioned()) startVoiceServices();   // packaged win: provision voice on first run, else just start (idempotent)
    pollStatus(); pollHooks(); pollAgentTokens();
    // spawn-on-size fallback: if the renderer never reports a size, seed the first tab ('main') at a default
    setTimeout(() => { if (ptys.size === 0) spawnPty('main', 120, 32, activeWorkspace, ''); }, 1800);
    startPoll();            // adaptive background session sync for the active repo workspace
    startWorkflowPoll();    // live workflow/swarm agents for the foreground tab's Agents pane
    // Discover repos we've been invited to, then sync everything already enabled (background, post-launch).
    setTimeout(() => { discoverWorkspaces().then(syncAllEnabled); }, 3000);
  });
}

// ---- embedded live Claude TUI (one pty per tab) ----
// Ultracode effort isn't a CLI flag — after claude has rendered and its output has SETTLED (it's idle waiting for
// input, past any trust prompt and not mid-stream), type `/effort ultracode` once to switch the session into
// ultracode mode (xhigh reasoning + workflow orchestration). Best-effort: a missed inject just leaves xhigh.
function armUltracode(tabId, proc) {
  const startedAt = Date.now();
  const t = setInterval(() => {
    const r = ptys.get(tabId);
    if (!r || r.proc !== proc || r.ultraDone) { clearInterval(t); return; }
    // Only inject once claude has ACTUALLY rendered (sawData) and then gone quiet — never on a slow blank start.
    if (r.sawData && Date.now() - startedAt > 1500 && Date.now() - r.lastData > 1000) {
      r.ultraDone = true; clearInterval(t);
      try { proc.write('/effort ultracode\r'); } catch {}
    }
  }, 400);
  if (t.unref) t.unref();
  const r0 = ptys.get(tabId); if (r0) r0.ultraTimer = t;
}
// Guarded send: the window can be destroyed mid-flight (a ConPTY may emit a final chunk during shutdown), so pty
// sends must tolerate a gone webContents instead of throwing into the uncaughtException net.
function winSend(channel, payload) { try { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); } catch {} }
function spawnPty(tabId, cols, rows, ws, session) {
  if (!tabId) return;
  const pty = runner.ptyInfo();
  if (ptys.has(tabId) || !pty.mod) {
    if (!pty.mod) winSend('pty:data', { tabId, data: `\r\n[claudible] node-pty unavailable (${pty.err})\r\n` });
    return;
  }
  ws = ws || activeWorkspace;
  try {
    const runtimeId = tabRuntimeId(tabId);
    const proc = runner.spawnClaude(tabId, { cols, rows, session, ws, effort: registry.effort, runtimeId });
    if (!proc) { winSend('pty:data', { tabId, data: `\r\n[claudible] node-pty unavailable (${pty.err})\r\n` }); return; }
    const rec = { proc, cols: cols || 120, rows: rows || 32, trustDone: false, ws, session: session || '',
      runtimeId, busy: false, busyTimer: null, lastData: Date.now(), sawData: false, ultraDone: false, ultraTimer: null };
    ptys.set(tabId, rec);
    if (registry.effort === 'ultracode') armUltracode(tabId, proc);   // switch the new session into ultracode mode once it settles
    if (!fgTabId) fgTabId = tabId;                         // first tab becomes the foreground/mirrored one
    if (tabId === fgTabId) { share.resetRing(); share.resetStatus(); share.setSize(rec.cols, rec.rows); }   // only the foreground tab drives the guest mirror
    // Handlers are guarded by `ptys.get(tabId)?.proc === proc` so a soon-to-die OLD pty (during a session
    // switch on this tab) can't stomp the NEW one's stream — the map entry is replaced/deleted before kill.
    proc.onData(d => {
      if (ptys.get(tabId)?.proc !== proc) return;
      winSend('pty:data', { tabId, data: d });
      if (tabId === fgTabId) share.broadcast(d);           // tee ONLY the foreground stream to guests
      const r = ptys.get(tabId);
      if (r) { r.lastData = Date.now(); r.sawData = true; }   // feed the ultracode settle-detector (and prove claude rendered)
      if (r && !r.trustDone && /trust this folder/i.test(d)) { r.trustDone = true; setTimeout(() => { try { proc.write('\r'); } catch {} }, 250); }
    });
    proc.onExit(() => {
      if (ptys.get(tabId)?.proc !== proc) return;          // an intentional switch already replaced us
      const r = ptys.get(tabId); const rws = r && r.ws;
      if (r && r.ultraTimer) { try { clearInterval(r.ultraTimer); } catch {} }
      const msg = '\r\n[claudible] session ended\r\n';
      winSend('pty:data', { tabId, data: msg });
      if (tabId === fgTabId) { share.broadcast(msg); share.resetRing(); }
      setGenBusy(tabId, false); ptys.delete(tabId); hookState.delete(tabId); lastStatusByTab.delete(tabId);
      schedulePush(rws);                                   // session ended → flush its workspace's transcripts to collaborators
    });
  } catch (e) { winSend('pty:data', { tabId, data: `\r\n[claudible] pty spawn failed: ${e.message}\r\n` }); }
}
// The live terminal STREAMS for a workspace that's either explicitly screen-shared OR session-synced (so a
// Claudible collaborator can watch the synced session live). The browsable LIBRARY below stays shared-only, so
// turning on Sync never exposes your other synced workspaces to a web guest you handed a link to.
function isShareable(ws) { return !!(ws && (ws.shared || ws.syncSessions)); }
// The granted workspace library a guest is allowed to see (paths/urls stripped); marks which is live.
function grantedList() {
  return registry.workspaces.filter((w) => w.shared)
    .map((w) => ({ id: w.id, label: w.label, kind: w.kind, live: w.id === registry.activeId }));
}
// Push the current grant state to guests: pause the mirror when the live workspace isn't streamable,
// and refresh the visible library. No-op when not sharing.
function syncShare() {
  if (!share.status().running) return;
  try { share.setPaused(!isShareable(activeWorkspace)); } catch {}
  try { share.setWorkspaces(grantedList()); } catch {}
}
// Switch a tab's terminal to a chosen session ('new' | <session-id> | '' = resume latest). Kills that
// tab's current pty (its guarded handlers go quiet, since the map entry is deleted BEFORE the kill) and
// respawns it with the selection. Only foreground-tab switches touch the guest mirror.
function respawnPty(tabId, session) {
  const rec = ptys.get(tabId);
  setGenBusy(tabId, false);                                 // a switch ends any in-flight turn for sync gating
  const cols = (rec && rec.cols) || 120, rows = (rec && rec.rows) || 32, ws = (rec && rec.ws) || activeWorkspace;
  if (tabId === fgTabId) {
    // Set paused BEFORE the new pty can emit a byte, so a private workspace's output never reaches a guest.
    try { if (share.status().running) share.setPaused(!isShareable(ws)); } catch {}
  }
  const old = rec && rec.proc;
  ptys.delete(tabId);                                       // drop the entry first → the old handlers' guard goes quiet
  // NB: do NOT clear hookState/lastStatusByTab here. The retained per-tab offset + pollHooks' truncation detection
  // (st.size < offset → reset, once session.sh actually truncates hooks.ndjson) is what PREVENTS replay; clearing it
  // would make pollHooks re-read the OLD session's still-on-disk hooks from offset 0 and replay them to TTS.
  if (old) { try { old.kill(); } catch {} }
  spawnPty(tabId, cols, rows, ws, session);
  if (tabId === fgTabId) syncShare();                       // refresh the granted library (live flag) for guests
}
// Make a tab the foreground/mirrored one WITHOUT killing it (the no-kill analogue of respawnPty). Points
// the single guest mirror at this tab and keeps the global active-workspace notion in lockstep with it.
function setForegroundTab(tabId) {
  if (liveTabs.has(tabId)) return;   // a joined live tab is a remote mirror, not a local pty — it must NEVER become the foreground/shared tab (would pause + wipe + black-hole the user's own outgoing share)
  fgTabId = tabId;   // record intent even if the pty hasn't spawned yet — spawnPty wires the mirror once it has
  const rec = ptys.get(tabId);
  const intent = tabIntent.get(tabId);
  const ws = (rec && rec.ws) || (intent && intent.ws) || null;   // resolve THIS tab's workspace even before its pty spawns, so activeWorkspace never desyncs from fgTabId (H1)
  if (ws && registry.activeId !== ws.id) { activeWorkspace = ws; registry.activeId = ws.id; saveRegistry(); }
  else if (ws) activeWorkspace = ws;
  try { share.resetRing(); share.resetStatus(); } catch {}                        // drop the previous tab's replay/tracker
  // Only (re)evaluate the mirror pause when we actually KNOW this tab's workspace — pausing on an unknown ws would
  // wrongly treat it as private and wipe the ring. If the pty hasn't spawned yet, spawnPty wires the mirror on spawn.
  if (ws) { try { if (share.status().running) share.setPaused(!isShareable(ws)); } catch {} }
  if (rec) { try { share.setSize(rec.cols, rec.rows); } catch {} }
  syncShare();
}
ipcMain.on('pty:start', (e, { tabId, cols, rows }) => {
  const intent = tabIntent.get(tabId); tabIntent.delete(tabId);
  const rec = ptys.get(tabId);
  spawnPty(tabId, cols, rows, (rec && rec.ws) || (intent && intent.ws) || activeWorkspace, (rec && rec.session) || (intent && intent.session) || '');
});
ipcMain.on('pty:input', (e, { tabId, data }) => { const t = ptys.get(tabId); if (t) { try { t.proc.write(data); } catch {} } });
ipcMain.on('pty:resize', (e, { tabId, cols, rows }) => {
  const t = ptys.get(tabId); if (!t) return;
  t.cols = cols || t.cols; t.rows = rows || t.rows;
  try { t.proc.resize(t.cols, t.rows); } catch {}
  if (tabId === fgTabId) share.setSize(t.cols, t.rows);    // keep guests' xterm matched to the FOREGROUND pty size
});
ipcMain.on('pty:foreground', (e, { tabId }) => setForegroundTab(tabId));
// Record a new tab's intended workspace + session BEFORE its pty:start, so spawnPty binds it correctly.
ipcMain.handle('tab:open', (e, { tabId, wsId, session }) => {
  const ws = registry.workspaces.find((w) => w.id === wsId) || activeWorkspace;
  tabIntent.set(tabId, { ws, session: session || '' });
  return { ok: true };
});
// Close a tab: kill its pty (handlers go quiet via the deleted-entry guard) and drop its state.
ipcMain.handle('tab:close', (e, { tabId }) => {
  const rec = ptys.get(tabId);
  setGenBusy(tabId, false);
  ptys.delete(tabId); hookState.delete(tabId); lastStatusByTab.delete(tabId); tabIntent.delete(tabId);
  if (rec) { try { rec.proc.kill(); } catch {} }
  liveDisconnect(tabId);                                               // also drop a joined live socket if this was a live tab
  if (fgTabId === tabId) fgTabId = ptys.keys().next().value || null;   // renderer will foreground the next tab explicitly
  return { ok: true };
});

// ---- native live-join: client WebSocket(s) to peers' share servers (one per joined tab) ----------
// The cockpit speaks the EXACT guest protocol (share/server.js): binary frames = terminal bytes, JSON = control
// (hello/status/size/paused/chat/roster/voice-members/audio/pending/denied). Each frame is relayed to the
// renderer over IPC tagged by tabId; the renderer draws a normal xterm tab and sends input/chat/audio back.
// Terminal bytes are forwarded RAW (never base64); the remote stream is treated as untrusted (parsed defensively).
function liveSend(tabId, channel, payload) { try { win && win.webContents.send(channel, Object.assign({ tabId }, payload || {})); } catch {} }
function liveForward(tabId, type, obj) {
  const r = liveTabs.get(tabId);
  if (r && r.ws && r.ws.readyState === LiveSocket.OPEN) { try { r.ws.send(JSON.stringify(Object.assign({ type }, obj))); } catch {} }
}
function openLiveSocket(tabId) {
  const r = liveTabs.get(tabId); if (!r || r.closed) return;
  const cred = r.resume ? ('r=' + encodeURIComponent(r.resume)) : ('t=' + encodeURIComponent(r.token));
  const wsUrl = r.url.replace(/^http/i, 'ws') + '/?' + cred + (r.name ? '&n=' + encodeURIComponent(r.name) : '');
  let sock; try { sock = new LiveSocket(wsUrl); } catch (err) { return liveSend(tabId, 'live:state', { state: 'offline' }); }
  r.ws = sock; sock.binaryType = 'nodebuffer';
  let gotHello = false;
  sock.on('open', () => { r.retry = 0; liveSend(tabId, 'live:state', { state: 'connecting' }); });
  sock.on('message', (data, isBinary) => {
    if (isBinary) { try { win && win.webContents.send('live:data', { tabId, data }); } catch {} return; }   // raw terminal bytes
    let m = null; try { m = JSON.parse(data.toString()); } catch {} if (!m) return;
    switch (m.type) {
      case 'hello':
        gotHello = true; r.pid = m.pid || null; r.readOnly = !!m.readOnly;
        r.hostCols = m.cols || r.hostCols || 120; r.hostRows = m.rows || r.hostRows || 32;
        if (m.resume) r.resume = m.resume;
        liveSend(tabId, 'live:hello', { readOnly: r.readOnly, cols: r.hostCols, rows: r.hostRows, host: m.host, you: m.you, pid: r.pid, paused: !!m.paused, voice: Array.isArray(m.voice) ? m.voice : [] });
        break;
      case 'status': liveSend(tabId, 'live:status', { status: m.status || {} }); break;
      case 'size': r.hostCols = m.cols || r.hostCols; r.hostRows = m.rows || r.hostRows; liveSend(tabId, 'live:size', { cols: r.hostCols, rows: r.hostRows }); break;
      case 'paused': liveSend(tabId, 'live:paused', { paused: !!m.paused }); break;
      case 'chat': liveSend(tabId, 'live:chat', { role: m.role, name: m.name, text: m.text }); break;
      case 'roster': liveSend(tabId, 'live:roster', { list: Array.isArray(m.list) ? m.list : [] }); break;
      case 'voice-members': liveSend(tabId, 'live:voice-members', { members: Array.isArray(m.members) ? m.members : [] }); break;
      case 'audio': liveSend(tabId, 'live:audio', { from: m.from, data: m.data, sr: m.sr }); break;
      case 'pending': liveSend(tabId, 'live:state', { state: 'pending' }); break;
      case 'denied': r.closed = true; liveSend(tabId, 'live:state', { state: 'denied', reason: m.reason || '' }); break;
      default: break;   // workspaces / ws-sessions / ws-transcript / rtc: unused by the native joined tab
    }
  });
  sock.on('close', () => {
    r.ws = null; if (r.closed) return;
    const warm = gotHello || r.resume;                     // we were admitted (resume token proves it) → reconnect indefinitely
    if (!warm) { r.coldTries = (r.coldTries || 0) + 1; if (r.coldTries > 5) { liveSend(tabId, 'live:state', { state: 'offline' }); return; } }   // cold: host tunnel may just be slow to come up — try a few times, then give up
    r.retry = Math.min(r.retry + 1, 6);
    liveSend(tabId, 'live:state', { state: warm ? 'reconnecting' : 'offline' });
    r.retryTimer = setTimeout(() => openLiveSocket(tabId), (warm ? 500 : 3000) * r.retry);
    if (r.retryTimer.unref) r.retryTimer.unref();
  });
  sock.on('error', () => { try { sock.close(); } catch {} });
}
// Peer handles come from a collaborator-WRITABLE shared branch, so a malicious presence entry could point at any
// origin. Only ever connect to / open a cloudflare quick-tunnel host (what startCloudflared produces) or localhost
// for dev — never an arbitrary HTTPS host. This is the single allowlist used by both liveConnect and live:join.
function isTunnelUrl(url) {
  return /^https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com$/i.test(url) || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url);
}
function liveConnect(tabId, peer, name) {
  const url = String((peer && peer.url) || '');
  const tok = String((peer && peer.token) || '').replace(/[^A-Za-z0-9._~-]/g, '');
  const okUrl = isTunnelUrl(url);
  if (!okUrl || !tok) return { ok: false, error: 'bad handle' };
  liveDisconnect(tabId);                                  // replace any prior socket bound to this tab
  liveTabs.set(tabId, { ws: null, url, token: tok, name: String(name || '').slice(0, 40), hostCols: 120, hostRows: 32, pid: null, readOnly: false, resume: null, retry: 0, closed: false, peer });
  openLiveSocket(tabId);
  return { ok: true };
}
function liveDisconnect(tabId) {
  const r = liveTabs.get(tabId); if (!r) return;
  r.closed = true; try { r.retryTimer && clearTimeout(r.retryTimer); } catch {} try { r.ws && r.ws.close(); } catch {}   // stop any in-flight reconnect too
  liveTabs.delete(tabId);
}
ipcMain.handle('live:connect', (e, { tabId, peer, name } = {}) => liveConnect(tabId, peer, name));
ipcMain.handle('live:disconnect', (e, { tabId } = {}) => { liveDisconnect(tabId); return { ok: true }; });
ipcMain.on('live:input', (e, { tabId, data } = {}) => liveForward(tabId, 'input', { data: String(data == null ? '' : data) }));   // a keystroke → the peer's foreground pty
ipcMain.on('live:chat-send', (e, { tabId, text } = {}) => liveForward(tabId, 'chat', { text: String(text == null ? '' : text).slice(0, 2000) }));
ipcMain.on('live:voice', (e, { tabId, join } = {}) => liveForward(tabId, join ? 'voice-join' : 'voice-leave', {}));
ipcMain.on('live:audio-send', (e, { tabId, data, sr } = {}) => liveForward(tabId, 'audio', { data, sr }));

// ---- live terminal sharing (local server + cloudflared tunnel) ----
let shareStartInFlight = null;                            // single-flight lock: a 2nd concurrent start must NOT spawn a 2nd tunnel
ipcMain.handle('share:start', (e, opts) => {
  // Concurrent re-entry (double-click, or collab auto-share racing the manual web-share button) → reuse the SAME
  // in-flight start. Without this both calls pass the "already up" check (shareBaseUrl still null) and each spawns
  // a cloudflared, orphaning the first tunnel forever (live public URL, no handle to kill).
  if (shareStartInFlight) return shareStartInFlight;
  if (share.status().running && shareBaseUrl) {           // already fully up → return the existing handle
    const st0 = share.status();
    return { ok: true, url: `${shareBaseUrl}/?t=${st0.token}`, localUrl: `${shareBaseUrl}/?t=${st0.token}`, remote: !!cloudflaredProc, note: null, readOnly: st0.readOnly };
  }
  shareStartInFlight = (async () => {
    try {
      const { port, token } = await share.start({ readOnly: !!(opts && opts.readOnly), name: opts && opts.name });
      const fr0 = fgRec(); share.setSize(fr0 ? fr0.cols : 120, fr0 ? fr0.rows : 32);
      syncShare();                                        // tell guests the granted library + pause if the live ws is private
      let base = `http://127.0.0.1:${port}`, remote = false, note = null;
      try {
        try { cloudflaredProc && cloudflaredProc.kill(); } catch {}   // defensive: never leave a prior tunnel orphaned
        cloudflaredProc = null;
        const { proc, url } = await startCloudflared(port);
        if (!share.status().running) { try { proc.kill(); } catch {} return { ok: false, error: 'stopped during start' }; }   // a share:stop landed while we were spawning → reap the tunnel, don't orphan a live public URL
        cloudflaredProc = proc;
        cloudflaredProc.on('exit', () => { cloudflaredProc = null; shareBaseUrl = null; });   // tunnel died (self-exit/network) → drop the now-dead public URL so the next start re-establishes a tunnel
        base = url; remote = true;                       // public link
      } catch (tunErr) { note = String(tunErr.message || tunErr); }   // tunnel down → fall back to localhost/LAN
      shareBaseUrl = base;
      const st = share.status();
      return { ok: true, url: `${base}/?t=${token}`, localUrl: `http://127.0.0.1:${port}/?t=${token}`, remote, note, readOnly: st.readOnly };
    } catch (err) { return { ok: false, error: String(err.message || err) }; }
  })();
  shareStartInFlight.finally(() => { shareStartInFlight = null; });   // release the lock once this start settles
  return shareStartInFlight;
});
ipcMain.handle('share:stop', async () => {
  try { cloudflaredProc && cloudflaredProc.kill(); } catch {}
  cloudflaredProc = null; shareBaseUrl = null;
  stopAdvertiseHeartbeat();                              // no longer hosting → stop re-stamping presence
  share.stop();
  return { ok: true };
});
ipcMain.handle('share:newlink', () => {                 // mint a fresh one-time link (re-invite)
  if (!share.status().running || !shareBaseUrl) return { ok: false, error: 'not sharing' };
  const t = share.regenerateLink();
  return { ok: true, url: `${shareBaseUrl}/?t=${t}` };
});
ipcMain.handle('share:approve', (e, arg) => share.decideApproval(arg && arg.id, !!(arg && arg.ok)));   // host's verdict

// ---- Live sessions: advertise the session I'm hosting (presence on the shared branch) so a collaborator in
// the same workspace can JOIN it natively — no link to paste. Join opens the proven guest page in a Claudible
// window (reuses the whole mirror/chat/voice stack), so it's "through Claudible", not an external browser. ----
const liveWindows = new Set();
function runPresence(args, cb) {
  if (!APPDIR_WSL) return cb && cb(null);
  runner.runScript('sessions-sync.sh', `${args}`, { ws: activeWorkspace, timeout: 45000 }).then(({ err, stdout }) => {
      if (err) return cb && cb(null);
      let r = null; try { r = JSON.parse((stdout || '').trim() || '{}'); } catch {}
      cb && cb(r);
    });
}
// Keep my presence fresh while I'm hosting. Peers ignore advertisements older than a few minutes (so a crashed
// host stops showing as "live"), so a still-live host must re-stamp its ts periodically. The timer lives in MAIN
// on purpose — renderer timers get throttled when the window is backgrounded, which is exactly when we must NOT
// silently go stale. Each beat is one tiny presence-set commit; a ~2 min cadence keeps the git noise low.
let advertiseTimer = null, advertisedSid = null, advertisedNameB64 = '';
function stopAdvertiseHeartbeat() { if (advertiseTimer) { clearInterval(advertiseTimer); advertiseTimer = null; } advertisedSid = null; }
function startAdvertiseHeartbeat(sid) {
  advertisedSid = sid;                                   // a session switch just re-points which sid we re-stamp
  if (advertiseTimer) return;
  advertiseTimer = setInterval(() => {
    const st = share.status();
    if (!advertisedSid || !st.running || !shareBaseUrl || !st.token) return;   // not hosting this beat — unadvertise/stop tear the timer down
    runPresence(`presence-set '${advertisedSid}' '${shareBaseUrl}' '${st.token}' '${advertisedNameB64}'`, () => {});
  }, 120000);
  if (advertiseTimer.unref) advertiseTimer.unref();
}
ipcMain.handle('live:advertise', (e, payload) => new Promise((resolve) => {
  const sid = String((payload && payload.sessionId) || '').replace(/[^A-Za-z0-9-]/g, '');
  const st = share.status();
  if (!sid || !st.running || !shareBaseUrl || !st.token) return resolve({ ok: false, error: 'not live' });
  advertisedNameB64 = Buffer.from(String((payload && payload.name) || '')).toString('base64');   // chosen display name → presence (badge/roster)
  // Start the re-stamp heartbeat even if THIS push failed: we ARE hosting (guarded above), and the 120s beat
  // retries the push, so a transient blip at advertise time still self-heals — while presence-set now honestly
  // reports ok:false for this attempt.
  runPresence(`presence-set '${sid}' '${shareBaseUrl}' '${st.token}' '${advertisedNameB64}'`, (r) => { startAdvertiseHeartbeat(sid); resolve(r || { ok: false }); });
}));
ipcMain.handle('live:unadvertise', () => new Promise((resolve) => { stopAdvertiseHeartbeat(); runPresence('presence-clear', (r) => resolve(r || { ok: true })); }));
ipcMain.handle('live:peers', () => new Promise((resolve) => { runPresence('presence-list', (r) => resolve((r && Array.isArray(r.peers)) ? r.peers : [])); }));
// Shared session names: publish my rename to meta/<login>.json on the branch; read the merged (last-writer-wins)
// map back. The name goes out-of-band as base64 so arbitrary text can never break the shell command.
ipcMain.handle('title:set', (e, { id, name }) => new Promise((resolve) => {
  const sid = String(id || '').replace(/[^A-Za-z0-9-]/g, '');
  if (!sid) return resolve({ ok: false });
  const b64 = Buffer.from(String(name == null ? '' : name)).toString('base64');
  runPresence(`title-set '${sid}' '${b64}'`, (r) => resolve(r || { ok: false }));
}));
ipcMain.handle('title:list', () => new Promise((resolve) => { runPresence('title-list', (r) => resolve((r && r.titles) || {})); }));
ipcMain.handle('live:join', (e, payload) => {
  try {
    const peer = (payload && payload.peer) || {};
    const url = String(peer.url || '');
    const tok = String(peer.token || '').replace(/[^A-Za-z0-9._~-]/g, '');
    const okUrl = isTunnelUrl(url);
    if (!okUrl || !tok) return { ok: false, error: 'bad handle' };
    const who = String(peer.name || peer.login || '').replace(/[^A-Za-z0-9 _.-]/g, '');
    const myName = String((payload && payload.name) || '').slice(0, 40);   // how I appear to the host I'm joining
    const w = new BrowserWindow({
      width: 1200, height: 800, backgroundColor: '#070809',
      title: 'Claudible — live session' + (who ? ' · ' + who : ''),
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    try { w.removeMenu(); } catch {}
    // Lock the join window to the (host-pinned) tunnel origin: deny popups and block navigation anywhere else, so
    // even a compromised guest page can't redirect this window — carrying the share token in its URL — to an
    // attacker origin.
    try { w.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); } catch {}
    w.webContents.on('will-navigate', (ev, navUrl) => { try { if (!String(navUrl).startsWith(url + '/')) ev.preventDefault(); } catch { try { ev.preventDefault(); } catch {} } });
    w.webContents.on('will-redirect', (ev, navUrl) => { try { if (!String(navUrl).startsWith(url + '/')) ev.preventDefault(); } catch { try { ev.preventDefault(); } catch {} } });   // 3xx redirects don't re-fire will-navigate — guard them too
    w.loadURL(`${url}/?t=${tok}` + (myName ? `&n=${encodeURIComponent(myName)}` : ''));
    liveWindows.add(w); w.on('closed', () => liveWindows.delete(w));
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});

// ---- sessions (list / switch) ----
function listSessions() {
  return new Promise((resolve) => {
    if (!APPDIR_WSL) return resolve([]);
    runner.runScript('sessions.sh', '', { ws: activeWorkspace, maxBuffer: 8 * 1024 * 1024, timeout: 12000 }).then(({ err, stdout }) => {
        if (err) { console.error('[claudible] sessions.sh:', err.message); return resolve([]); }
        try { resolve(JSON.parse(String(stdout).trim() || '[]')); } catch { resolve([]); }
      });
  });
}
ipcMain.handle('session:list', () => listSessions());
ipcMain.handle('session:open', (e, { tabId, id }) => { respawnPty(tabId, id); return { ok: true }; });   // re-point an existing tab at 'new' | <session-id>
// Soft-delete a saved session: move its transcript to ~/.claudible/trash/ (recoverable). The renderer
// switches the pty off this session BEFORE calling, so the file isn't held open by a live claude --resume.
ipcMain.handle('session:delete', (e, arg) => new Promise((resolve) => {
  const id = (typeof arg === 'string') ? arg : (arg && arg.id);
  const scope = (arg && arg.scope) || 'local';                              // 'local' (trash here) | 'everywhere' (also off GitHub)
  const sid = String(id || '').replace(/[^A-Za-z0-9-]/g, '');               // mirror the script's allowlist
  if (!sid || !APPDIR_WSL) return resolve({ ok: false, error: 'bad id' });
  runner.runScript('delete-session.sh', `'${sid}'`, { ws: activeWorkspace }).then(({ err, stdout }) => {
      if (err) { console.error('[claudible] delete-session:', err.message); return resolve({ ok: false, error: 'exec' }); }
      let local = {}; try { local = JSON.parse((stdout || '').trim() || '{}'); } catch {}
      if (scope !== 'everywhere') return resolve(local.ok ? local : { ok: true });
      // also tombstone it on the shared sessions branch so a sync can never bring it back (for anyone)
      runner.runScript('sessions-sync.sh', `delete '${sid}'`, { ws: activeWorkspace, timeout: 45000 }).then(({ err: err2, stdout: out2 }) => {
          if (err2) { console.error('[claudible] delete-session everywhere:', err2.message); return resolve({ ok: false, error: 'sync-exec', localDone: true }); }
          let r = {}; try { r = JSON.parse((out2 || '').trim() || '{}'); } catch {}
          resolve(r.ok ? { ok: true, everywhere: true } : { ok: false, error: (r.error || 'sync failed'), localDone: true });
        });
    });
}));
// "Keep locally" a session a collaborator deleted on GitHub: record the id (.claudible-kept) so the red "!"
// badge clears. The transcript stays on disk; it's tombstoned on the branch so it can never be re-shared.
ipcMain.handle('session:keep', (e, arg) => new Promise((resolve) => {
  const id = (typeof arg === 'string') ? arg : (arg && arg.id);
  const sid = String(id || '').replace(/[^A-Za-z0-9-]/g, '');
  if (!sid || !APPDIR_WSL) return resolve({ ok: false, error: 'bad id' });
  runner.runScript('session-keep.sh', `'${sid}'`, { ws: activeWorkspace }).then(({ err, stdout }) => {
      if (err) { console.error('[claudible] session-keep:', err.message); return resolve({ ok: false, error: 'exec' }); }
      let r = {}; try { r = JSON.parse((stdout || '').trim() || '{}'); } catch {}
      resolve(r.ok ? r : { ok: false, error: (r.error || 'keep failed') });
    });
}));

// ---- shared-session sync (repo workspaces) -----------------------------------------------------
// Copy this workspace's Claude transcripts to/from collaborators over an ISOLATED orphan branch
// (wsl/sessions-sync.sh, run in a SEPARATE git worktree) so a background pull/push never touches the
// code working tree or main's history. Opt-in per workspace (committing transcripts is a deliberate
// privacy choice); once on it runs automatically: a debounced push after each turn + an adaptive
// background pull. We never sync while a workspace has a busy tab (per-tab turn state) so a transcript is
const syncLock = new Set();                   // ws ids with an in-flight git sync (serialize per workspace)
const cloneInFlight = new Map();              // ws id -> in-flight clone promise (dedupe concurrent ensureClone)
let pollDelay = 30000, openGen = 0; const SYNC_MIN = 30000, SYNC_MAX = 300000;
const pushTimers = new Map();                 // per-workspace debounced push timers (independent across ws)
// Turn busy/idle is tracked PER TAB (rec.busy) so concurrent sessions never cross-gate each other's sync:
// one tab mid-turn must neither block nor prematurely release auto-sync for another tab's workspace. A
// watchdog per tab self-heals a missed Stop (interrupted turn) so it can't wedge that tab busy forever.
function setGenBusy(tabId, v) {
  const rec = ptys.get(tabId); if (!rec) return;
  rec.busy = v;
  if (rec.busyTimer) { clearTimeout(rec.busyTimer); rec.busyTimer = null; }
  if (v) rec.busyTimer = setTimeout(() => { rec.busy = false; rec.busyTimer = null; schedulePush(rec.ws); }, 1800000); // self-heal a missed Stop after 30min; the export <2s age skip still guards torn writes
}
// Is any tab bound to this workspace mid-turn? Auto-sync waits until a ws is fully quiesced before pushing.
function wsHasBusyTab(wsId) { for (const r of ptys.values()) if (r.ws && r.ws.id === wsId && r.busy) return true; return false; }

// op ∈ {init,pull,push,sync,status}. Resolves to the script's parsed JSON (or {ok:false,...}).
function runSync(ws, op, opts) {
  return new Promise((resolve) => {
    const o = ['init', 'pull', 'push', 'sync', 'status'].includes(op) ? op : 'status';
    if (!APPDIR_WSL || !ws || ws.kind !== 'repo') return resolve({ ok: false, error: 'not a repo workspace' });
    const live = (opts && opts.live && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(opts.live)) ? `CLAUDIBLE_LIVE_SESSION='${opts.live}' ` : '';
    runner.runScript('sessions-sync.sh', `'${o}'`, { ws, extraEnv: live, timeout: 120000, maxBuffer: 8 * 1024 * 1024 }).then(({ err, stdout }) => {
        if (err) { console.error('[claudible] sessions-sync', o, err.message); return resolve({ ok: false, error: 'sync could not run: ' + ((err && err.message) || err) }); }
        const raw = String(stdout).trim();
        try { resolve(JSON.parse(raw || '{}')); } catch { resolve({ ok: false, error: raw ? 'sync: ' + raw.slice(0, 300) : 'sync returned no output' }); }
      });
  });
}
// Locked, state-broadcasting sync: tells the renderer 'syncing'→'idle'/'error' (status button) and asks it
// to refresh the switcher when the active workspace gained/changed sessions. Requires sync ON + cloned.
async function doSync(ws, op, opts) {
  if (!ws || ws.kind !== 'repo' || !ws.syncSessions || ws.needsClone) return { ok: false, error: 'sync off' };
  if (syncLock.has(ws.id)) return { ok: false, error: 'busy' };
  syncLock.add(ws.id);
  try { win && win.webContents.send('sync:state', { id: ws.id, status: 'syncing' }); } catch {}
  const r = await runSync(ws, op, opts);
  syncLock.delete(ws.id);
  const changed = !!(r && (r.imported || r.updated || r.pushed));
  try { win && win.webContents.send('sync:state', { id: ws.id, status: r && r.ok ? 'idle' : 'error', synced: r && r.synced, diverged: r && r.diverged }); } catch {}
  if (changed) { try { win && win.webContents.send('sync:changed', { id: ws.id }); } catch {} }   // renderer refreshes only if it's the shown workspace
  return r;
}
// Only needed to SKIP the live session during a MANUAL sync mid-turn; auto-syncs already wait out a busy
// workspace entirely (wsHasBusyTab), so they never push a mid-write transcript and need no live skip.
async function liveIdNow() {
  if (!activeWorkspace || !wsHasBusyTab(activeWorkspace.id)) return '';
  try { const a = await listSessions(); return (Array.isArray(a) && a[0] && a[0].id) || ''; } catch { return ''; }
}
// After a turn ends (Stop) push that turn's WORKSPACE — but only once NO tab bound to it is still mid-turn,
// so two concurrent sessions in one workspace are pushed together, quiesced, never torn. Debounced per ws.
function schedulePush(ws) {
  if (!ws || ws.kind !== 'repo' || !ws.syncSessions || ws.needsClone) return;
  const id = ws.id, prev = pushTimers.get(id); if (prev) clearTimeout(prev);
  pushTimers.set(id, setTimeout(() => {
    pushTimers.delete(id);
    if (!wsHasBusyTab(id)) doSync(ws, 'push', {});       // all of ws's sessions are idle → safe to push
    else schedulePush(ws);                               // a tab is still busy → re-arm and wait it out
  }, 5000));
}
// Adaptive background pull(+push) of EVERY repo workspace that has a live tab, when that ws is idle; backs
// off globally when nothing changed anywhere. (Tabs span workspaces, so more than one can be live at once.)
function startPoll() {
  const tick = async () => {
    const seen = new Set(); let changed = false;
    for (const rec of ptys.values()) {
      const ws = rec.ws;
      if (!ws || ws.kind !== 'repo' || !ws.syncSessions || ws.needsClone) continue;
      if (seen.has(ws.id)) continue; seen.add(ws.id);
      if (wsHasBusyTab(ws.id) || syncLock.has(ws.id)) continue;
      const r = await doSync(ws, 'sync', {});
      if (r && (r.imported || r.updated || r.pushed)) changed = true;
    }
    pollDelay = changed ? SYNC_MIN : Math.min(SYNC_MAX, Math.round(pollDelay * 1.5));
    setTimeout(tick, pollDelay);
  };
  setTimeout(tick, pollDelay);
}
// Hook events are also forwarded raw to the renderer; here we track per-tab turn busy/idle + push the tab's
// workspace after each turn. tabId comes from which per-tab hooks file the line was read from.
function handleHook(tabId, line) {
  let ev = ''; try { ev = JSON.parse(line).hook_event_name || ''; } catch {}
  if (ev === 'UserPromptSubmit') setGenBusy(tabId, true);
  else if (ev === 'Stop') { setGenBusy(tabId, false); const r = ptys.get(tabId); schedulePush(r && r.ws); }
}
// Clone an existing (invited) repo workspace into ~/.claudible/repos/<slug> if it isn't local yet.
function ensureClone(ws) {
  if (cloneInFlight.has(ws.id)) return cloneInFlight.get(ws.id);   // a clone for this ws is already running → share it (no double gh clone into the same dir)
  const p = new Promise((resolve) => {
    if (!APPDIR_WSL) return resolve({ ok: false, error: 'WSL unavailable' });
    const slug = String(ws.slug || '').replace(/[^A-Za-z0-9-]/g, '');
    const owner = String(ws.owner || '').replace(/[^A-Za-z0-9-]/g, '');
    if (!slug || !owner) return resolve({ ok: false, error: 'bad workspace' });
    const wsp = (ws.path && typeof ws.path === 'string' && !/['"]/.test(ws.path)) ? ws.path : '';   // the invitee's chosen clone dir (else the script's default)
    const dirArg = wsp ? ` '${wsp}'` : '';
    runner.runScript('clone-workspace.sh', `'${owner}' '${slug}'${dirArg}`, { timeout: 300000 }).then(({ err, stdout }) => {
        // Surface the REAL reason so a Windows-specific failure isn't swallowed as a silent re-prompt.
        if (err) return resolve({ ok: false, error: 'clone could not run: ' + ((err && err.message) || err) });
        let r = {}; try { r = JSON.parse(String(stdout).trim() || '{}'); } catch { return resolve({ ok: false, error: 'clone returned no result' + (String(stdout).trim() ? ' — ' + String(stdout).trim().slice(0, 200) : '') }); }
        if (r.ok) { if (wsp && r.path) ws.path = r.path; delete ws.needsClone; saveRegistry(); }
        resolve(r.ok ? { ok: true } : { ok: false, error: r.error || 'clone failed' });
      });
  });
  cloneInFlight.set(ws.id, p);
  p.finally(() => cloneInFlight.delete(ws.id));
  return p;
}
// Find repo workspaces the user was invited to and register any new ones (sync OFF + needing clone until opened).
function discoverWorkspaces() {
  return new Promise((resolve) => {
    if (!APPDIR_WSL) return resolve({ ok: false, added: [] });
    runner.runScript('sessions-discover.sh', '', { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }).then(({ err, stdout }) => {
        if (err) { console.error('[claudible] discover:', err.message); return resolve({ ok: false, added: [] }); }
        let list = []; try { list = JSON.parse(String(stdout).trim() || '[]'); } catch {}
        const added = [];
        for (const item of (Array.isArray(list) ? list : [])) {
          const slug = String(item && item.slug || '').replace(/[^A-Za-z0-9-]/g, '');
          const owner = String(item && item.owner || '').replace(/[^A-Za-z0-9-]/g, '');
          if (!slug || !owner) continue;
          const wid = `repo-${slug}`;
          if (registry.workspaces.some((w) => w.id === wid || (w.kind === 'repo' && w.slug === slug && w.owner === owner))) continue;   // already known (incl. an upgraded-in-place ws: it's kind 'repo' with owner set, so this catches it without hiding a different owner's same-slug invite)
          const ws = { id: wid, label: slug, kind: 'repo', slug, owner, repoUrl: (item && item.repoUrl) || undefined, createdAt: Date.now(), needsClone: true };
          registry.workspaces.push(ws); added.push(ws);
        }
        if (added.length) { saveRegistry(); try { win && win.webContents.send('workspace:added', added.map((w) => ({ id: w.id, label: w.label }))); } catch {} }
        resolve({ ok: true, added });
      });
  });
}
// On launch, sync every already-enabled repo workspace once so collaborators' latest sessions land.
function syncAllEnabled() {
  for (const ws of registry.workspaces) if (ws.kind === 'repo' && ws.syncSessions && !ws.needsClone) doSync(ws, 'sync', {});
}
ipcMain.handle('session:syncStatus', (e, id) => {
  const ws = registry.workspaces.find((w) => w.id === (id || registry.activeId)) || activeWorkspace;
  if (!ws || ws.kind !== 'repo') return { ok: true, kind: ws ? ws.kind : '', enabled: false, ready: false };
  if (ws.needsClone) return { ok: true, kind: 'repo', enabled: false, ready: false, needsClone: true };
  return runSync(ws, 'status', {}).then((r) => ({ ok: true, kind: 'repo', enabled: !!ws.syncSessions, ready: !!(r && r.ready), synced: (r && r.synced) || 0 }));
});
// Turn sync on/off for a workspace. Enabling = one-time consent to publish this workspace's transcripts;
// it clones if needed, sets up the branch, and kicks a first sync. Disabling leaves all files in place.
ipcMain.handle('session:syncSetEnabled', async (e, payload) => {
  const ws = registry.workspaces.find((w) => w.id === (payload && payload.id));
  if (!ws || ws.kind !== 'repo') return { ok: false, error: 'not a repo workspace' };
  const enabled = !!(payload && payload.enabled);
  ws.syncSessions = enabled; saveRegistry();
  if (!enabled) return { ok: true, enabled: false };
  if (ws.needsClone) { const c = await ensureClone(ws); if (!c.ok) { ws.syncSessions = false; saveRegistry(); return { ok: false, error: c.error }; } }
  if (syncLock.has(ws.id)) return { ok: false, error: 'busy' };
  syncLock.add(ws.id);                          // hold the lock across init so the poll can't race the worktree setup
  let r;
  try { r = await runSync(ws, 'init', {}); } finally { syncLock.delete(ws.id); }
  if (!r || !r.ok) { ws.syncSessions = false; saveRegistry(); return { ok: false, error: (r && r.error) || 'could not set up sync' }; }
  doSync(ws, 'sync', {});                        // first real sync in the background
  return { ok: true, enabled: true };
});
ipcMain.handle('session:syncNow', async (e, id) => {   // the manual "sync now" button
  const ws = registry.workspaces.find((w) => w.id === (id || registry.activeId)) || activeWorkspace;
  if (!ws || ws.kind !== 'repo') return { ok: false, error: 'not a repo workspace' };
  if (!ws.syncSessions || ws.needsClone) return { ok: false, error: 'sync is off for this workspace' };
  // only the ACTIVE workspace has a live transcript to skip; for any other, there's nothing to exclude
  const live = (activeWorkspace && ws.id === activeWorkspace.id) ? await liveIdNow() : '';
  return doSync(ws, 'sync', { live });
});
ipcMain.handle('workspace:discover', () => discoverWorkspaces());

// Make a LOCAL workspace SYNCED across devices: turn its folder into a private GitHub repo IN PLACE (so its
// existing sessions stay linked — they're keyed by the unchanged path), then enable session sync. Powers the
// "sync across my devices" button and auto-upgrade-on-invite. Keeps the registry id/label so the active tab
// and chips don't jump; discovery dedupes by slug (below) so the upgraded ws is never re-added as a duplicate.
ipcMain.handle('workspace:upgrade', async (e, id) => {
  const ws = registry.workspaces.find((w) => w.id === id);
  if (!ws) return { ok: false, error: 'no such workspace' };
  if (ws.kind === 'repo') return { ok: true, already: true };
  if (ws.kind !== 'local') return { ok: false, error: 'only a local workspace can be made synced' };
  if (!APPDIR_WSL) return { ok: false, error: 'WSL/GitHub backend is not available' };
  const slug = String(ws.slug || '').replace(/[^A-Za-z0-9-]/g, '');
  if (!slug) return { ok: false, error: 'bad workspace' };
  const wsp = (ws.path && typeof ws.path === 'string' && !/['"]/.test(ws.path)) ? runner.toGuestPath(ws.path) : '';
  const dirArg = wsp ? ` '${wsp}'` : '';
  const { err, stdout } = await runner.runScript('upgrade-workspace.sh', `'${slug}'${dirArg}`, { timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
  if (err) return { ok: false, error: 'upgrade failed to run' };
  let r = {}; try { r = JSON.parse(String(stdout).trim() || '{}'); } catch {}
  if (!r.ok) return { ok: false, error: r.error || 'could not create the repo' };
  ws.kind = 'repo'; ws.owner = r.owner; ws.repoUrl = r.repoUrl; if (r.path) ws.path = r.path; ws.syncSessions = true; saveRegistry();
  // set up the sessions-sync branch + first push in the background (don't block the click); failure leaves the
  // repo created with sync flagged — the next sync/relaunch retries (mirrors syncSetEnabled).
  (async () => {
    if (syncLock.has(ws.id)) return; syncLock.add(ws.id);
    let ir; try { ir = await runSync(ws, 'init', {}); } finally { syncLock.delete(ws.id); }   // release BEFORE doSync, else its lock-guard makes the first push a no-op
    if (ir && ir.ok) doSync(ws, 'sync', {});   // push this workspace's existing sessions now, so they reach your other devices immediately
  })();
  return { ok: true, workspace: { id: ws.id, label: ws.label, kind: ws.kind, owner: ws.owner, repoUrl: ws.repoUrl } };
});

// ---- workspaces (the library a session belongs to: legacy / local folder / private repo) ----
ipcMain.handle('workspace:list', () => ({ activeId: registry.activeId, workspaces: registry.workspaces }));
// Switch the active workspace: subsequent session list/open/delete scope to its cwd; resume its latest convo.
ipcMain.handle('workspace:open', async (e, id) => {
  const ws = registry.workspaces.find((w) => w.id === id);
  if (!ws) return { ok: false, error: 'unknown workspace' };
  const myGen = ++openGen;                                         // a later open must win over a slow clone
  if (ws.kind === 'repo' && ws.needsClone) {                       // invited workspace, not cloned yet → fetch it first
    const c = await ensureClone(ws);
    if (!c.ok) return { ok: false, error: c.error || 'clone failed' };
  }
  if (myGen !== openGen) return { ok: false, error: 'superseded' };   // a newer open started during our clone → stand down
  activeWorkspace = ws; registry.activeId = id; saveRegistry();
  const fr = fgRec(); if (fr) fr.ws = ws;                          // re-point the foreground tab at the new workspace (other tabs keep running)
  respawnPty(fgTabId, '');                                         // '' = resume most-recent conversation in that cwd
  pollDelay = SYNC_MIN;                                            // a freshly-opened workspace: poll promptly
  if (ws.kind === 'repo' && ws.syncSessions) doSync(ws, 'sync', {});   // pull collaborators' sessions in the background
  return { ok: true };
});
// Accept an invited repo workspace, letting the user choose WHERE it clones. useDefault → the script's
// ~/.claudible/repos/<slug>; otherwise a native folder picker, cloning into <chosen>/<slug>. Stamps ws.path so
// every downstream script (sessions, sync, claude) runs in that dir via CLAUDIBLE_WS_DIR.
ipcMain.handle('workspace:acceptInvite', async (e, payload) => {
  const ws = registry.workspaces.find((w) => w.id === (payload && payload.id));
  if (!ws) return { ok: false, error: 'unknown workspace' };
  if (ws.kind !== 'repo') return { ok: false, error: 'not a repo workspace' };
  const slug = String(ws.slug || '').replace(/[^A-Za-z0-9-]/g, '');
  if (!slug) return { ok: false, error: 'bad workspace' };
  if (payload && payload.useDefault) {
    if (ws.path) { delete ws.path; saveRegistry(); }                 // default location → drop any prior custom path
  } else {
    let res; try { res = await dialog.showOpenDialog(win, { title: 'Choose where to save this shared workspace', properties: ['openDirectory', 'createDirectory'] }); } catch { res = { canceled: true }; }
    if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, error: 'cancelled' };
    let wslp = '';
    wslp = runner.toGuestPath(res.filePaths[0]);
    if (!wslp || /['"]/.test(wslp)) return { ok: false, error: 'could not use that folder' };
    ws.path = `${wslp.replace(/\/+$/, '')}/${slug}`;                 // clone into <chosen>/<slug> (mirrors create-workspace's <parent>/<slug>)
    saveRegistry();
  }
  const c = await ensureClone(ws);                                  // honors ws.path; clears needsClone on success
  if (!c.ok && !(payload && payload.useDefault) && ws.path) { delete ws.path; saveRegistry(); }   // failed custom clone → don't leave a dangling path
  return c.ok ? { ok: true, path: ws.path || null } : { ok: false, error: c.error || 'clone failed' };
});
// Provision a new workspace (local mkdir or a private GitHub repo), register it, switch to it, start fresh.
ipcMain.handle('workspace:create', (e, payload) => new Promise((resolve) => {
  const kind = (payload && payload.kind === 'repo') ? 'repo' : 'local';
  const name = String((payload && payload.name) || '').trim();
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  if (!slug) return resolve({ ok: false, error: 'enter a name (letters, numbers, dashes)' });
  if (registry.workspaces.some((w) => w.id === `${kind}-${slug}`)) return resolve({ ok: false, error: 'a workspace with that name already exists' });
  if (!APPDIR_WSL) return resolve({ ok: false, error: 'WSL is not available' });
  const exec = (pdirWsl) => {
    const arg3 = pdirWsl ? ` '${pdirWsl}'` : '';                       // optional custom parent dir (local only)
    runner.runScript('create-workspace.sh', `'${kind}' '${slug}'${arg3}`, { timeout: kind === 'repo' ? 300000 : 30000 }).then(({ err, stdout }) => {   // repo = network-bound (clone+push)
        if (err) { console.error('[claudible] create-workspace:', err.message); return resolve({ ok: false, error: 'creation timed out or failed' }); }
        let r = {}; try { r = JSON.parse(String(stdout).trim() || '{}'); } catch {}
        // Register + switch to a workspace, then resolve. fresh=true for a brand-new one (start a fresh
        // conversation); fresh=false when re-attaching an orphan (resume whatever's in that cwd).
        const attach = (repoUrl, owner, fresh, wsPath) => {
          openGen++;                                                     // supersede any in-flight workspace:open clone
          const ws = { id: `${kind}-${slug}`, label: name.slice(0, 80) || slug, kind, slug,
            repoUrl: repoUrl || undefined, owner: owner || undefined, path: wsPath || undefined, createdAt: Date.now() };
          registry.workspaces.push(ws); registry.activeId = ws.id; activeWorkspace = ws; saveRegistry();
          const fr = fgRec(); if (fr) fr.ws = ws;                       // re-point the foreground tab at the new workspace
          respawnPty(fgTabId, fresh ? 'new' : '');
          resolve({ ok: true, workspace: ws });
        };
        if (r.ok) return attach(r.repoUrl, r.owner, true, r.path);
        // The dir already exists on disk but isn't in our registry (registry wiped, or a prior create
        // timed out AFTER provisioning): re-attach it instead of dead-ending the name.
        if (/already exists/i.test(String(r.error || ''))) return attach(undefined, undefined, false, r.path);
        resolve({ ok: false, error: r.error || 'creation failed' });
      });
  };
  // Custom save-location (local only): pick a parent folder, convert Windows→WSL path, create <folder>/<slug> there.
  if (kind === 'local' && payload && payload.pick) {
    dialog.showOpenDialog(win, { title: 'Choose where to create this workspace', properties: ['openDirectory', 'createDirectory'] })
      .then((res) => {
        if (res.canceled || !res.filePaths || !res.filePaths.length) return resolve({ ok: false, error: 'cancelled' });
        let wslp = '';
        wslp = runner.toGuestPath(res.filePaths[0]);
        if (!wslp || wslp.includes("'")) return resolve({ ok: false, error: 'could not use that folder' });
        exec(wslp);
      }).catch(() => resolve({ ok: false, error: 'folder pick failed' }));
  } else {
    exec('');
  }
}));
// Grant / revoke a workspace to guests (default-deny). Updates the live share immediately.
ipcMain.handle('workspace:setShared', (e, payload) => {
  const ws = registry.workspaces.find((w) => w.id === (payload && payload.id));
  if (!ws) return { ok: false, error: 'unknown workspace' };
  ws.shared = !!(payload && payload.shared); saveRegistry();
  syncShare();
  return { ok: true, shared: ws.shared };
});
// Rename a workspace (registry is the source of truth; mirror the new label to guests' granted library).
ipcMain.handle('workspace:rename', (e, payload) => {
  const ws = registry.workspaces.find((w) => w.id === (payload && payload.id));
  if (!ws) return { ok: false, error: 'unknown workspace' };
  const label = String((payload && payload.label) || '').trim().slice(0, 80);
  if (!label) return { ok: false, error: 'empty name' };
  ws.label = label; saveRegistry();
  syncShare();
  return { ok: true, label };
});
// Delete a workspace: soft-delete its folder (recoverable) + drop it from the registry. Never 'legacy'.
ipcMain.handle('workspace:delete', (e, id) => new Promise((resolve) => {
  const ws = registry.workspaces.find((w) => w.id === id);
  if (!ws || ws.id === 'legacy') return resolve({ ok: false, error: 'cannot delete this workspace' });
  const fallback = registry.workspaces.find((w) => w.id === 'legacy') || registry.workspaces.find((w) => w.id !== id);
  openGen++;   // supersede any in-flight workspace:open clone for the workspace being deleted (mirrors create/switch)
  const fgWasHere = !!(fgRec() && fgRec().ws && fgRec().ws.id === id);
  for (const rec of ptys.values()) { if (rec.ws && rec.ws.id === id) rec.ws = fallback; }   // repoint any tab inside it
  if (activeWorkspace && activeWorkspace.id === id) { activeWorkspace = fallback; registry.activeId = fallback.id; }
  registry.workspaces = registry.workspaces.filter((w) => w.id !== id);
  saveRegistry(); syncShare();
  if (fgWasHere) { try { respawnPty(fgTabId, ''); } catch {} try { win && win.webContents.send('workspace:active-changed', registry.activeId); } catch {} }
  const finish = () => resolve({ ok: true, activeId: registry.activeId });
  const slug = String(ws.slug || '').replace(/[^A-Za-z0-9-]/g, '');
  if (APPDIR_WSL && slug && (ws.kind === 'local' || ws.kind === 'repo')) {
    runner.runScript('delete-workspace.sh', `'${ws.kind}' '${slug}'`, { ws, timeout: 20000 }).then(() => finish());
  } else finish();
}));
// Reorder the workspace chips (drag). Accepts the new id order; any ids not listed keep their place at the end.
ipcMain.handle('workspace:reorder', (e, ids) => {
  if (!Array.isArray(ids)) return { ok: false };
  const byId = new Map(registry.workspaces.map((w) => [w.id, w]));
  const next = [];
  ids.forEach((id) => { const w = byId.get(id); if (w) { next.push(w); byId.delete(id); } });
  for (const w of byId.values()) next.push(w);
  registry.workspaces = next; saveRegistry();
  return { ok: true };
});
// Default reasoning effort — persisted in the registry, applied to every new session via buildBoot (CLAUDIBLE_EFFORT).
ipcMain.handle('effort:get', () => registry.effort || '');
ipcMain.handle('effort:set', (e, level) => {
  registry.effort = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'].includes(level) ? level : '';
  saveRegistry();
  return { ok: true, effort: registry.effort };
});
// Invite a GitHub user as a push collaborator on a repo workspace's repo (Stage 2 — durable git collab).
ipcMain.handle('repo:invite', (e, payload) => new Promise((resolve) => {
  const ws = registry.workspaces.find((w) => w.id === (payload && payload.id));
  if (!ws || ws.kind !== 'repo') return resolve({ ok: false, error: 'not a repo workspace' });
  const login = String((payload && payload.username) || '').trim().replace(/[^A-Za-z0-9-]/g, '');   // GitHub logins are [A-Za-z0-9-]
  if (!login) return resolve({ ok: false, error: 'enter a GitHub username' });
  const slug = String(ws.slug || '').replace(/[^A-Za-z0-9-]/g, '');          // honor the bash-interpolation invariant (re-sanitise)
  if (!slug) return resolve({ ok: false, error: 'bad workspace' });
  if (!APPDIR_WSL) return resolve({ ok: false, error: 'WSL is not available' });
  runner.runScript('repo-invite.sh', `'${slug}' '${login}'`, { timeout: 60000 }).then(({ err, stdout }) => {
      if (err) { console.error('[claudible] repo-invite:', err.message); return resolve({ ok: false, error: 'invite failed' }); }
      let r = {}; try { r = JSON.parse(String(stdout).trim() || '{}'); } catch {}
      resolve(r.ok ? { ok: true, status: r.status || 'invited' } : { ok: false, error: r.error || 'invite failed' });
    });
}));
// ---- skills + plugins (manage Claude Code extensions from the cockpit) ----
ipcMain.handle('skills:list', () => new Promise((resolve) => {
  if (!APPDIR_WSL) return resolve([]);
  runner.runScript('skills.sh', `list`, { ws: activeWorkspace, maxBuffer: 8 * 1024 * 1024, timeout: 12000 }).then(({ err, stdout }) => {
      if (err) { console.error('[claudible] skills:list', err.message); return resolve([]); }
      try { resolve(JSON.parse(String(stdout).trim() || '[]')); } catch { resolve([]); }
    });
}));
ipcMain.handle('skills:set', (e, payload) => new Promise((resolve) => {
  const name = String((payload && payload.name) || '').replace(/[^A-Za-z0-9:/_.-]/g, '');
  const state = ['on', 'off', 'name-only', 'user-invocable-only'].includes(payload && payload.state) ? payload.state : '';
  if (!name || !state) return resolve({ ok: false, error: 'bad args' });
  if (!APPDIR_WSL) return resolve({ ok: false, error: 'WSL unavailable' });
  runner.runScript('skills.sh', `set '${name}' '${state}'`, { ws: activeWorkspace }).then(({ err, stdout }) => {
      if (err) { console.error('[claudible] skills:set', err.message); return resolve({ ok: false, error: 'failed' }); }
      try { resolve(JSON.parse(String(stdout).trim() || '{}')); } catch { resolve({ ok: false }); }
    });
}));
ipcMain.handle('plugins:list', () => new Promise((resolve) => {
  if (!APPDIR_WSL) return resolve([]);
  runner.runScript('plugins.sh', `list`, { maxBuffer: 8 * 1024 * 1024, timeout: 12000 }).then(({ err, stdout }) => {
      if (err) { console.error('[claudible] plugins:list', err.message); return resolve([]); }
      try { resolve(JSON.parse(String(stdout).trim() || '[]')); } catch { resolve([]); }
    });
}));
ipcMain.handle('plugins:available', () => new Promise((resolve) => {
  if (!APPDIR_WSL) return resolve([]);
  runner.runScript('plugins.sh', `available`, { maxBuffer: 16 * 1024 * 1024, timeout: 15000 }).then(({ err, stdout }) => {
      if (err) { console.error('[claudible] plugins:available', err.message); return resolve([]); }
      try { resolve(JSON.parse(String(stdout).trim() || '[]')); } catch { resolve([]); }
    });
}));
ipcMain.handle('plugins:toggle', (e, payload) => new Promise((resolve) => {
  const key = String((payload && payload.key) || '').replace(/[^A-Za-z0-9@._/-]/g, '');
  const act = (payload && payload.enable) ? 'enable' : 'disable';
  if (!key) return resolve({ ok: false, error: 'bad key' });
  if (!APPDIR_WSL) return resolve({ ok: false, error: 'WSL unavailable' });
  runner.runScript('plugins.sh', `toggle '${key}' '${act}'`, { timeout: 60000 }).then(({ err, stdout }) => {
      if (err) { console.error('[claudible] plugins:toggle', err.message); return resolve({ ok: false, error: 'failed' }); }
      try { resolve(JSON.parse(String(stdout).trim() || '{}')); } catch { resolve({ ok: false }); }
    });
}));
ipcMain.on('share:tracker', (e, s) => { try { share.broadcastStatus(s); } catch {} });   // mirror tracker to guests
ipcMain.on('share:chat-send', (e, text) => { try { share.broadcastChat(text); } catch {} });   // host → guests chat
ipcMain.handle('share:status', () => share.status());

// ---- session tracker: poll EACH live tab's runtime/tabs/<tab>/status.json (Windows FS, native read) ----
// Per-tab files (written by session.sh via the inherited CLAUDIBLE_STATUS env) so concurrent sessions
// never clobber one meter; every 'status' IPC carries its tabId so the renderer routes it to the right tab.
const lastStatusByTab = new Map();   // tabId -> last raw status json (dedupe)
const appIntervals = [];   // long-lived poller intervals — cleared on window-all-closed so none leak or fire against a dead window (H3)
function pollStatus() {
  appIntervals.push(setInterval(() => {
    for (const [tabId, rec] of ptys) {
      try {
        const raw = fs.readFileSync(path.join(RT, 'tabs', rec.runtimeId, 'status.json'), 'utf8');
        if (raw === lastStatusByTab.get(tabId)) continue; lastStatusByTab.set(tabId, raw);
        const d = JSON.parse(raw); const c = d.context_window || {}; const cost = d.cost || {};
        if (d.session_id) rec.sessionId = d.session_id;   // the live session id — used to locate this tab's workflow/swarm agents
        const cu = c.current_usage || null;   // last turn's usage (input/output here are NEW, non-cache)
        win && win.webContents.send('status', {
          tabId,
          sessionId: d.session_id || null,   // lets the renderer reconcile a freshly-started "new" tab into its saved session row
          ctxPct: c.used_percentage, costUsd: cost.total_cost_usd,
          newTok: cu ? ((cu.input_tokens || 0) + (cu.output_tokens || 0)) : null,  // genuinely-new tokens, excl. cache
          usageKey: cu ? `${cu.input_tokens}:${cu.output_tokens}:${cu.cache_read_input_tokens}:${cu.cache_creation_input_tokens}` : null,
          model: d.model && d.model.display_name, fast: d.fast_mode,
        });
      } catch {}
    }
  }, 1200));
}

// ---- agent-token meter: the statusLine usage excludes subagents/swarms, so scan each live tab's
// subagents dir for the tokens they consumed and forward it. Slow cadence (a cheap python scan). ----
function pollAgentTokens() {
  if (!APPDIR_WSL) return;
  appIntervals.push(setInterval(() => {
    for (const [tabId, rec] of ptys) {
      const sid = String(rec.sessionId || '').replace(/[^A-Za-z0-9-]/g, '');
      if (!sid) continue;
      // The all-time agent total only grows during a turn, so don't spawn the scan for an idle tab. Poll while
      // busy + exactly ONCE more after it goes idle (agentTokSettled) so the final swarm increment still lands;
      // a new turn flips busy → settled re-arms below. (On error/non-numeric we leave settled unset → retry.)
      if (!rec.busy && rec.agentTokSettled) continue;
      runner.runScript('agent-tokens.sh', `'${sid}'`, { ws: rec.ws, timeout: 10000 }).then(({ err, stdout }) => {
          if (err) return;
          const n = parseInt(String(stdout).trim(), 10);
          if (!Number.isFinite(n)) return;
          // agent-tokens.sh returns an ABSOLUTE all-time total for the session id. Baseline it the first time we
          // see each session (and re-baseline when the tab's session changes — e.g. a resume into a different
          // conversation) so the meter shows only THIS app-session's new agent work, mirroring the cost/sessTok
          // delta-since-launch baselines. Without this, resuming a session that ever ran a swarm would show its
          // entire historical agent total (tens of millions of tokens) the instant it loads.
          if (rec.agentTokSid !== sid) { rec.agentTokSid = sid; rec.agentTokBase = n; }
          const delta = Math.max(0, n - (rec.agentTokBase || 0));
          try { win && win.webContents.send('agent-tokens', { tabId, agentTok: delta }); } catch {}
          rec.agentTokSettled = !rec.busy;   // once we've polled while idle, skip until the next turn flips busy
        });
    }
  }, 8000));
}
// ---- hook events: poll EACH live tab's runtime/tabs/<tab>/hooks.ndjson for appended lines ----
const hookState = new Map();   // tabId -> { offset, buf } (independent tail cursor per tab)
let hookTick = 0;
function pollHooks() {
  appIntervals.push(setInterval(() => {
    hookTick++;
    for (const [tabId, rec] of ptys) {
      let s = hookState.get(tabId); if (!s) { s = { offset: 0, buf: '', lastData: 0 }; hookState.set(tabId, s); }
      // Cadence: a tab mid-turn (rec.busy) or that just emitted hook lines stays on the fast 80ms tick, so a
      // finished reply still reaches the renderer + TTS with minimal lag (the TTS-critical Stop event always
      // arrives while busy). A fully-idle tab is only sampled every ~6th tick (~480ms), cutting baseline FS load.
      const hot = rec.busy || (Date.now() - (s.lastData || 0) < 2500);
      if (!hot && (hookTick % 6 !== 0)) continue;
      try {
        const p = path.join(RT, 'tabs', rec.runtimeId, 'hooks.ndjson');
        const st = fs.statSync(p);
        if (st.size < s.offset) { s.offset = 0; s.buf = ''; }     // truncated (this tab's pty respawned)
        if (st.size === s.offset) continue;
        const fd = fs.openSync(p, 'r'); const buf = Buffer.alloc(st.size - s.offset);
        try { fs.readSync(fd, buf, 0, buf.length, s.offset); } finally { fs.closeSync(fd); }   // close the FD even if the read throws
        s.offset = st.size; s.buf += buf.toString('utf8'); s.lastData = Date.now();
        let i; while ((i = s.buf.indexOf('\n')) >= 0) { const l = s.buf.slice(0, i).trim(); s.buf = s.buf.slice(i + 1); if (l) { handleHook(tabId, l); win && win.webContents.send('hook:line', { tabId, line: l }); } }
      } catch {}
    }
  }, 80));   // base tick; idle tabs are sampled at ~480ms via the hot/cold gate above
}
ipcMain.handle('hook:test', async () => {
  const ts = Date.now();
  const rec = fgRec();
  try { if (rec) fs.appendFileSync(path.join(RT, 'tabs', rec.runtimeId, 'hooks.ndjson'), JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'hook link OK', sent_ms: ts }) + '\n'); } catch {}
  return ts;
});

// ---- workflow / swarm agents: the Workflow tool spawns agents OUTSIDE the Task-hook path, so the Agents
// tab can't see them via hooks. They DO write per-agent files under the session's subagents dir (in WSL's
// ~/.claude, off the Windows FS), so we read them WSL-side (wsl/workflows.sh) and push live state to the
// renderer. We poll only the FOREGROUND tab (the one whose Agents pane is visible), adaptively. ----
function runWorkflows(ws, sid) {
  return new Promise((resolve) => {
    const s = String(sid || '').replace(/[^A-Za-z0-9-]/g, '');
    if (!APPDIR_WSL || !s) return resolve([]);
    runner.runScript('workflows.sh', `'${s}'`, { ws, timeout: 12000, maxBuffer: 16 * 1024 * 1024 }).then(({ err, stdout }) => {
        if (err) return resolve([]);
        try { resolve(JSON.parse(String(stdout).trim() || '[]')); } catch { resolve([]); }
      });
  });
}
function startWorkflowPoll() {
  let delay = 2500;
  const tick = async () => {
    const rec = ptys.get(fgTabId);
    if (rec && rec.sessionId) {
      const wfs = await runWorkflows(rec.ws, rec.sessionId);
      try { win && win.webContents.send('workflow:agents', { tabId: fgTabId, workflows: wfs }); } catch {}
      const running = Array.isArray(wfs) && wfs.some((w) => w.running > 0);
      delay = running ? 1200 : (Array.isArray(wfs) && wfs.length ? 2500 : 5000);   // fast while a swarm runs, lazy when idle
    } else { delay = 4000; }
    setTimeout(tick, delay);
  };
  setTimeout(tick, 2500);
}

// ---- audio (in main: no renderer CORS) ----
ipcMain.handle('stt', async (e, arrayBuf) => {
  try {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from(arrayBuf)], { type: 'audio/webm' }), 'audio.webm');
    fd.append('response_format', 'json');
    const r = await fetch(`${WHISPER}/v1/audio/transcriptions`, { method: 'POST', body: fd });
    if (!r.ok) { const j = await r.json().catch(() => ({})); return { error: (j.detail && (j.detail.message || j.detail)) || j.error || ('HTTP ' + r.status) }; }
    return await r.json();
  } catch (err) { return { error: String(err) }; }
});
ipcMain.handle('tts', async (e, text, voice) => {
  try {
    const r = await fetch(`${KOKORO}/v1/audio/speech`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'kokoro', input: text, voice: voice || 'af_bella', response_format: 'mp3', speed: 1.05 }),
    });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || ct.includes('application/json')) {
      const j = await r.json().catch(() => ({}));
      return { error: (j.detail && (j.detail.message || j.detail)) || j.error || ('HTTP ' + r.status) };
    }
    return { audio: await r.arrayBuffer() };
  } catch (err) { return { error: String(err) }; }
});
ipcMain.handle('endpoints', () => ({ whisper: WHISPER, kokoro: KOKORO, pty: !!runner.ptyInfo().mod, ptyErr: runner.ptyInfo().err }));

// clipboard for the right-click menu (works regardless of renderer clipboard permissions)
ipcMain.handle('clip:write', (e, text) => { try { clipboard.writeText(String(text ?? '')); } catch {} });
ipcMain.handle('clip:read', () => { try { return clipboard.readText(); } catch { return ''; } });

// save the current session transcript -> a .txt the user picks (defaults to Desktop)
ipcMain.handle('save-session', async (e, text) => {
  try {
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    const defaultPath = path.join(app.getPath('desktop'), `claudible-session-${stamp}.txt`);
    const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath, filters: [{ name: 'Text', extensions: ['txt'] }] });
    if (canceled || !filePath) return { canceled: true };
    fs.writeFileSync(filePath, text, 'utf8');
    return { saved: filePath };
  } catch (err) { return { error: String(err) }; }
});

// Export a saved session as a SELF-CONTAINED, shareable HTML replay (no server, works offline). Reads the
// transcript for the active workspace's session via transcript.sh, renders it, and lets the user pick where
// to save. Text is embedded as JSON and rendered client-side via textContent → no injection from transcript.
ipcMain.handle('session:export', async (e, sessionId) => {
  try {
    const ws = activeWorkspace;
    const sid = String(sessionId || '').replace(/[^A-Za-z0-9-]/g, '');
    if (!sid || !APPDIR_WSL) return { error: 'no session' };
    const messages = await new Promise((resolve) => {
      runner.runScript('transcript.sh', `'${sid}'`, { ws, timeout: 30000, maxBuffer: 16 * 1024 * 1024 }).then(({ err, stdout }) => {
          let m = []; try { m = JSON.parse(String(stdout).trim() || '[]'); } catch {}
          resolve(Array.isArray(m) ? m : []);
        });
    });
    if (!messages.length) return { error: 'empty' };
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const first = (messages.find((m) => m.role === 'you') || messages[0] || {}).text || 'Claude session';
    const html = renderReplayHtml({ title: String(first).replace(/\s+/g, ' ').slice(0, 90), workspace: (ws && ws.label) || '', date: d.toLocaleString(), messages });
    const defaultPath = path.join(app.getPath('desktop'), `claudible-replay-${stamp}.html`);
    const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath, filters: [{ name: 'HTML', extensions: ['html'] }] });
    if (canceled || !filePath) return { canceled: true };
    fs.writeFileSync(filePath, html, 'utf8');
    return { saved: filePath, count: messages.length };
  } catch (err) { return { error: String(err) }; }
});

// Save a session's transcript as a plain Markdown (.md/.txt) document — same transcript source as the HTML
// replay (transcript.sh), rendered as readable markdown. No server, no HTML; just the conversation.
ipcMain.handle('session:export-text', async (e, sessionId) => {
  try {
    const ws = activeWorkspace;
    const sid = String(sessionId || '').replace(/[^A-Za-z0-9-]/g, '');
    if (!sid || !APPDIR_WSL) return { error: 'no session' };
    const messages = await new Promise((resolve) => {
      runner.runScript('transcript.sh', `'${sid}'`, { ws, timeout: 30000, maxBuffer: 16 * 1024 * 1024 }).then(({ err, stdout }) => {
          let m = []; try { m = JSON.parse(String(stdout).trim() || '[]'); } catch {}
          resolve(Array.isArray(m) ? m : []);
        });
    });
    if (!messages.length) return { error: 'empty' };
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const first = (messages.find((m) => m.role === 'you') || messages[0] || {}).text || 'Claude session';
    const title = String(first).replace(/\s+/g, ' ').slice(0, 80);
    const body = messages.map((m) => {
      const who = m.role === 'you' ? 'You' : (m.role === 'claude' || m.role === 'assistant') ? 'Claude' : (m.role || 'note');
      return `\n## ${who}\n\n${String(m.text == null ? '' : m.text)}\n`;
    }).join('');
    const text = `# ${title}\n\n_${(ws && ws.label) || 'session'} · ${d.toLocaleString()}_\n${body}`;
    const defaultPath = path.join(app.getPath('desktop'), `claudible-session-${stamp}.md`);
    const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath, filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Text', extensions: ['txt'] }] });
    if (canceled || !filePath) return { canceled: true };
    fs.writeFileSync(filePath, text, 'utf8');
    return { saved: filePath, count: messages.length };
  } catch (err) { return { error: String(err) }; }
});

// The embedded Claude Code CLI version, for the status bar. Resolved once via a tiny cross-backend script and
// cached (it's stable for the app's lifetime); returns '' if claude isn't resolvable so the bar just hides it.
let _claudeVer;   // undefined = not fetched yet
ipcMain.handle('claude:version', () => {
  if (_claudeVer !== undefined) return _claudeVer;
  return new Promise((resolve) => {
    runner.runScript('claude-version.sh', '', { timeout: 8000 }).then(({ stdout }) => {
      _claudeVer = (String(stdout || '').match(/\d+\.\d+(?:\.\d+)?/) || [''])[0];   // pull the semver out of any format
      resolve(_claudeVer);
    }).catch(() => { _claudeVer = ''; resolve(''); });
  });
});

// ---- first-run onboarding (the Get-Started wizard) -------------------------------------------------
// Aggregate status the wizard polls — Claude Code + gh installed/signed-in + voice state. Derived from the
// SAME dependency probe the System-check step uses (deps.detect → runner.detectDeps), so there's one source
// of truth and one probe. On win-native that probe is pure-Node (no git-bash), which also fixes the old
// false-negative where check-onboard.sh silently reported everything-not-installed when Git was missing.
function voiceState() { return { voiceReady: voiceProvisioned(), voiceProvisioning: provisioning }; }
ipcMain.handle('onboard:status', async () => {
  let s = { claudeInstalled: false, claudeSignedIn: false, claudeVersion: '', ghInstalled: false, ghSignedIn: false, ghAccount: '' };
  try { s = Object.assign(s, deps.toOnboardStatus(await deps.detect(runner, voiceState()))); } catch {}
  return Object.assign(s, voiceState());
});
// Install Claude Code (npm -g) — called when claudeInstalled is false. Blocks until done (a few min).
ipcMain.handle('onboard:install-claude', async () => {
  try { const { stdout } = await runner.runScript('install-claude.sh', '', { timeout: 300000, maxBuffer: 8 * 1024 * 1024 }); return JSON.parse(String(stdout).trim() || '{"ok":false,"error":"no output"}'); }
  catch (e) { return { ok: false, error: (e && e.message) || 'install failed' }; }
});
// Sign-in is browser-OAuth (no headless path): ensure the foreground tab is running Claude so its login surfaces.
// The renderer hides the wizard to reveal the terminal, then polls onboard:status until signedIn flips true.
ipcMain.handle('onboard:claude-login', async () => {
  try {
    if (fgTabId && ptys.has(fgTabId)) respawnPty(fgTabId, '');     // restart Claude in the live tab → login surfaces
    else spawnPty('main', 120, 32, activeWorkspace, '');           // no tab yet → spawn one
    return { ok: true };
  } catch (e) { return { ok: false, error: (e && e.message) || 'could not start Claude' }; }
});

// ---- self-bootstrapping dependency provisioner (the System-check wizard step) ----------------------
// Detect every dependency Claudible needs and install the missing ones. The renderer renders deps.detect's
// rows, fires preflight:install per missing dep (progress streams over the shared 'provision' channel,
// tagged with {dep}), and offers a restart when a Git install needs one.
ipcMain.handle('preflight:status', async () => {
  try { return await deps.detect(runner, voiceState()); }
  catch (e) { return { runner: runner.id, gitBash: true, deps: [], error: (e && e.message) || 'detect failed' }; }
});
// Install one dependency. Voice keeps its proven path (ensureVoiceProvisioned); everything else goes through
// deps.install. On success we persist any portable-fallback env, apply it + refresh PATH live, and report
// whether a restart is needed (Git on win, whose app-dir resolves at require-time).
ipcMain.handle('preflight:install', async (_e, depId) => {
  const id = String(depId || '').replace(/[^a-z]/g, '');
  if (id === 'voice') { const started = ensureVoiceProvisioned(); return { ok: started || voiceProvisioned(), restartRequired: false }; }
  const send = (m) => { try { win && win.webContents.send('provision', m); } catch {} };
  let res;
  try { res = await deps.install(runner, id, send); } catch (e) { return { ok: false, error: (e && e.message) || 'install failed', restartRequired: false }; }
  if (res.ok) {
    if (res.env && Object.keys(res.env).length) {
      try {
        const s = readSettings();
        s.depEnv = Object.assign({}, s.depEnv, res.env);   // survive a relaunch (re-applied at boot, before APPDIR_WSL)
        fs.mkdirSync(RT, { recursive: true }); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
      } catch {}
      for (const [k, v] of Object.entries(res.env)) if (typeof v === 'string' && v) process.env[k] = v;
    }
    refreshWindowsPath();
    if (runner.id === 'win' && typeof runner.resetCaches === 'function') runner.resetCaches();   // re-resolve git-bash/app-dir next call
  }
  return { ok: res.ok, error: res.error || '', restartRequired: !!res.restartRequired };
});
// Relaunch — the cleanest way to pick up a freshly-installed Git (main.js resolves the app-dir at require-time).
ipcMain.handle('preflight:restart', () => { try { app.relaunch(); app.exit(0); } catch {} return { ok: true }; });

// The active session's LATEST assistant reply, so the manual Speak button can re-read it even after a relaunch
// (when the in-memory lastReply is empty) or for a session opened from history. Reads the transcript and returns
// the last 'claude' message's text, or '' if there's genuinely nothing to read.
ipcMain.handle('session:latest-reply', async (e, sessionId) => {
  try {
    const ws = activeWorkspace;
    const sid = String(sessionId || '').replace(/[^A-Za-z0-9-]/g, '');
    if (!sid || !APPDIR_WSL) return { text: '' };
    const messages = await new Promise((resolve) => {
      runner.runScript('transcript.sh', `'${sid}'`, { ws, timeout: 30000, maxBuffer: 16 * 1024 * 1024 }).then(({ stdout }) => {
          let m = []; try { m = JSON.parse(String(stdout).trim() || '[]'); } catch {}
          resolve(Array.isArray(m) ? m : []);
        });
    });
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === 'claude' && m.text && String(m.text).trim()) return { text: String(m.text) };
    }
    return { text: '' };
  } catch (err) { return { text: '', error: String(err) }; }
});

// ---- Diff Review: see what Claude changed in the active workspace's git repo, revert per hunk/file ----
ipcMain.handle('diff:list', () => new Promise((resolve) => {
  if (!APPDIR_WSL) return resolve({ ok: false, repo: false, files: [], untracked: [] });
  runner.runScript('diff.sh', '', { ws: activeWorkspace, timeout: 30000, maxBuffer: 32 * 1024 * 1024 }).then(({ err, stdout }) => {
      let r = { ok: false, repo: false, files: [], untracked: [] };
      try { r = JSON.parse(String(stdout).trim() || '{}'); } catch {}
      resolve(r);
    });
}));
// Reverse-apply a hunk/file patch, or discard an untracked file. The patch text / target path is written to
// an APP-controlled temp file and only its path is passed to bash (never the repo data) — no injection.
let diffActionSeq = 0;
function diffAction(mode, payload) {
  return new Promise((resolve) => {
    try {
      if (!APPDIR_WSL || typeof payload !== 'string' || !payload) return resolve({ ok: false, error: 'bad args' });
      const name = `diffaction-${process.pid}-${++diffActionSeq}.tmp`;   // unique per action → concurrent revert/discard never read each other's payload (M1)
      const tmp = path.join(RT, name);
      fs.writeFileSync(tmp, payload, 'utf8');
      runner.runScript('diff-apply.sh', `${mode} '${RT_GUEST}/${name}'`, { ws: activeWorkspace, timeout: 20000 }).then(({ err, stdout }) => {
          try { fs.unlinkSync(tmp); } catch {}   // clean up the temp patch file
          let r = { ok: false }; try { r = JSON.parse(String(stdout).trim() || '{}'); } catch {}
          resolve(r);
        });
    } catch (err) { console.error('[claudible] diffAction:', err && err.message); resolve({ ok: false, error: 'apply' }); }
  });
}
ipcMain.handle('diff:revert', (e, patch) => diffAction('apply-reverse', patch));
ipcMain.handle('diff:discard', (e, relPath) => diffAction('discard', relPath));

// Safety net: never let a stray error from a pty/agent take the whole cockpit down.
process.on('uncaughtException', (e) => console.error('[claudible] uncaughtException:', e && e.message));
process.on('unhandledRejection', (e) => console.error('[claudible] unhandledRejection:', e && (e.message || e)));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  try { for (const t of appIntervals) clearInterval(t); appIntervals.length = 0; } catch {}   // tear down pollers so none fire against a destroyed window (H3)
  try { stopAdvertiseHeartbeat(); } catch {}
  try { for (const { proc } of ptys.values()) { try { proc.kill(); } catch {} } ptys.clear(); } catch {}
  try { for (const id of [...liveTabs.keys()]) liveDisconnect(id); } catch {}   // close any joined peer sockets
  try { cloudflaredProc && cloudflaredProc.kill(); } catch {}
  try { share.stop(); } catch {}
  app.quit();
});
