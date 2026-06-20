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
const cp = require('child_process');
const { createShareServer } = require('./share/server');
const { renderReplayHtml } = require('./share/replay');
const { startCloudflared } = require('./share/cloudflared');

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
    cp.execFile('wsl.exe', ['-e', 'bash', '-lc', `${wsEnv(ws)} bash '${APPDIR_WSL}/wsl/sessions.sh'`],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        let list = []; try { list = JSON.parse(String(stdout).trim() || '[]'); } catch {}
        reply({ type: 'ws-sessions', wsId, label: ws.label, list: Array.isArray(list) ? list : [] });
      });
  },
  onBrowseTranscript: (wsId, sessionId, reply) => {
    const ws = registry.workspaces.find((w) => w.id === wsId && w.shared);
    const sid = String(sessionId || '').replace(/[^A-Za-z0-9-]/g, '');   // strict id (also the bash-interp invariant)
    if (!ws || !sid || !APPDIR_WSL) return reply({ type: 'ws-transcript', wsId, sessionId: sid, msgs: [] });
    cp.execFile('wsl.exe', ['-e', 'bash', '-lc', `${wsEnv(ws)} bash '${APPDIR_WSL}/wsl/transcript.sh' '${sid}'`],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        let msgs = []; try { msgs = JSON.parse(String(stdout).trim() || '[]'); } catch {}
        reply({ type: 'ws-transcript', wsId, sessionId: sid, msgs: Array.isArray(msgs) ? msgs : [] });
      });
  },
  // Voice room (WebRTC) — the server is signaling-only; audio is peer-to-peer. Bridge the host cockpit's
  // signaling (over IPC) to/from guests (over the share WS): a guest's signal addressed to 'host' arrives
  // here, and the host's outgoing signals + voice membership go back to the cockpit renderer.
  onRtc: (payload) => { try { win && win.webContents.send('share:rtc', payload); } catch {} },
  onVoiceMembers: (members) => { try { win && win.webContents.send('share:voice-members', members); } catch {} },
  onAudio: (frame) => { try { win && win.webContents.send('share:audio', frame); } catch {} },   // a guest's voice frame → cockpit
});
ipcMain.on('share:rtc-send', (e, { to, kind, data } = {}) => { try { share.rtcFromHost(to, kind, data); } catch {} });
ipcMain.on('share:voice', (e, { join } = {}) => { try { share.hostVoiceSet(!!join); } catch {} });
ipcMain.on('share:audio-send', (e, data) => { try { share.audioFromHost(data); } catch {} });   // cockpit's voice frame → guests
const WHISPER = process.env.CLAUDIBLE_WHISPER || 'http://localhost:2022';
const KOKORO  = process.env.CLAUDIBLE_KOKORO  || 'http://localhost:8880';
const RT = path.join(__dirname, 'runtime');   // per-tab status/hooks live under RT/tabs/<tabId>/ (see pollers)
// Resolve THIS app's own folder as a WSL path (C:\Users\X\claudible -> /mnt/c/Users/X/claudible) so the
// bootstrap script + runtime files work for ANY user/location — no hardcoded home. wslpath does it robustly.
let APPDIR_WSL = null;
// NB: pass forward slashes — single backslashes get stripped crossing the Windows->WSL arg boundary, so
// a raw `C:\Users\...` reaches wslpath as `C:Users...`. wslpath accepts forward slashes natively.
try { APPDIR_WSL = cp.execFileSync('wsl.exe', ['wslpath', '-u', __dirname.replace(/\\/g, '/')], { encoding: 'utf8' }).trim(); }
catch (e) { console.error('[claudible] wslpath failed:', e.message); }
// session.sh receives the app dir as $1 so it writes runtime/ to the SAME Windows folder this process reads.
// A session choice ('new' | a <session-id> | '') is passed via CLAUDIBLE_SESSION on the command line
// (env vars don't cross the Windows→WSL boundary without WSLENV, so we inline it). The id is sanitised
// to [A-Za-z0-9-] so it can't break out of the quoted command.
// Inline the active workspace as env (kind + strict-allowlisted slug) so the wsl scripts run in THAT
// workspace's own cwd. slug is re-sanitised here too (defense in depth) since it's interpolated into bash.
function wsEnv(ws) {
  const kind = ws && ['local', 'repo', 'legacy'].includes(ws.kind) ? ws.kind : 'legacy';
  const slug = String((ws && ws.slug) || '').replace(/[^A-Za-z0-9-]/g, '');
  let s = `CLAUDIBLE_WS_KIND='${kind}'` + (slug ? ` CLAUDIBLE_WS_SLUG='${slug}'` : '');
  const p = ws && ws.path;   // custom save-location (absolute WSL path); single-quote-free for safe inlining
  if (p && typeof p === 'string' && !p.includes("'")) s += ` CLAUDIBLE_WS_DIR='${p}'`;
  return s;
}
function tabRuntimeId(tabId) { return String(tabId || '').replace(/[^A-Za-z0-9-]/g, '') || 'default'; }
function buildBoot(session, ws, tabId) {
  if (!APPDIR_WSL) return 'echo "[claudible] could not resolve the app path via wslpath — is WSL installed?"; sleep 8';
  const sel = String(session || '').replace(/[^A-Za-z0-9-]/g, '').replace(/^-+/, '');   // strip leading dashes (no flag-lookalike ids)
  const tab = tabRuntimeId(tabId);                                                       // per-tab runtime path key (matches session.sh)
  const eff = ['low', 'medium', 'high', 'xhigh', 'max'].includes(registry.effort) ? ` CLAUDIBLE_EFFORT='${registry.effort}'` : '';
  const prefix = (sel ? `CLAUDIBLE_SESSION='${sel}' ` : '') + `CLAUDIBLE_TAB='${tab}'` + eff + ' ' + wsEnv(ws) + ' ';
  return `${prefix}bash '${APPDIR_WSL}/wsl/session.sh' '${APPDIR_WSL}'`;
}
try { fs.mkdirSync(RT, { recursive: true }); } catch {}

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
function startVoiceServices() {
  if (!APPDIR_WSL) return;
  try {
    cp.execFile('wsl.exe', ['-e', 'bash', '-lc', `bash '${APPDIR_WSL}/wsl/services.sh'`],
      (err, _stdout, stderr) => { if (err) console.error('[claudible] services.sh:', err.message, stderr || ''); });
  } catch (e) { console.error('[claudible] failed to start voice services:', e.message); }
}

let nodePty = null, ptyErr = null;
for (const mod of ['node-pty', 'node-pty-prebuilt-multiarch']) {
  try { nodePty = require(mod); ptyErr = null; console.log('[claudible] pty loaded via', mod); break; }
  catch (e) { console.error(`[claudible] require('${mod}') failed:`, e.message); ptyErr = `${mod}: ${e.message}`; }
}
if (!nodePty) console.error('[claudible] no pty backend available');

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
  win.loadFile('renderer/index.html');
  win.webContents.once('did-finish-load', () => {   // one-shot, scoped to this contents: a reload won't stack a 2nd set of pollers/timers
    startVoiceServices();   // idempotent; ensures STT/TTS are up even when launched via `npm start`
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
function spawnPty(tabId, cols, rows, ws, session) {
  if (!tabId) return;
  if (ptys.has(tabId) || !nodePty) {
    if (!nodePty && win) win.webContents.send('pty:data', { tabId, data: `\r\n[claudible] node-pty unavailable (${ptyErr})\r\n` });
    return;
  }
  ws = ws || activeWorkspace;
  try {
    const proc = nodePty.spawn('wsl.exe', ['-e', 'bash', '-lc', buildBoot(session, ws, tabId)], {
      name: 'xterm-256color', cols: cols || 120, rows: rows || 32, cwd: process.env.USERPROFILE, env: process.env,
      // ConPTY (default on Win11) — preserves full ANSI incl. the dim attribute (winpty strips it).
      // Its console-list agent crash ("AttachConsole failed") is neutralized by the guard patch in
      // node_modules/node-pty/lib/conpty_console_list_agent.js + the uncaughtException net below.
    });
    const rec = { proc, cols: cols || 120, rows: rows || 32, trustDone: false, ws, session: session || '',
      runtimeId: tabRuntimeId(tabId), busy: false, busyTimer: null };
    ptys.set(tabId, rec);
    if (!fgTabId) fgTabId = tabId;                         // first tab becomes the foreground/mirrored one
    if (tabId === fgTabId) { share.resetRing(); share.resetStatus(); share.setSize(rec.cols, rec.rows); }   // only the foreground tab drives the guest mirror
    // Handlers are guarded by `ptys.get(tabId)?.proc === proc` so a soon-to-die OLD pty (during a session
    // switch on this tab) can't stomp the NEW one's stream — the map entry is replaced/deleted before kill.
    proc.onData(d => {
      if (ptys.get(tabId)?.proc !== proc) return;
      win.webContents.send('pty:data', { tabId, data: d });
      if (tabId === fgTabId) share.broadcast(d);           // tee ONLY the foreground stream to guests
      const r = ptys.get(tabId);
      if (r && !r.trustDone && /trust this folder/i.test(d)) { r.trustDone = true; setTimeout(() => { try { proc.write('\r'); } catch {} }, 250); }
    });
    proc.onExit(() => {
      if (ptys.get(tabId)?.proc !== proc) return;          // an intentional switch already replaced us
      const r = ptys.get(tabId); const rws = r && r.ws;
      const msg = '\r\n[claudible] session ended\r\n';
      win.webContents.send('pty:data', { tabId, data: msg });
      if (tabId === fgTabId) { share.broadcast(msg); share.resetRing(); }
      setGenBusy(tabId, false); ptys.delete(tabId); hookState.delete(tabId); lastStatusByTab.delete(tabId);
      schedulePush(rws);                                   // session ended → flush its workspace's transcripts to collaborators
    });
  } catch (e) { win.webContents.send('pty:data', { tabId, data: `\r\n[claudible] pty spawn failed: ${e.message}\r\n` }); }
}
// The granted workspace library a guest is allowed to see (paths/urls stripped); marks which is live.
function grantedList() {
  return registry.workspaces.filter((w) => w.shared)
    .map((w) => ({ id: w.id, label: w.label, kind: w.kind, live: w.id === registry.activeId }));
}
// Push the current grant state to guests: pause the mirror when the live workspace isn't granted,
// and refresh the visible library. No-op when not sharing.
function syncShare() {
  if (!share.status().running) return;
  try { share.setPaused(!(activeWorkspace && activeWorkspace.shared)); } catch {}
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
    try { if (share.status().running) share.setPaused(!(ws && ws.shared)); } catch {}
  }
  const old = rec && rec.proc;
  ptys.delete(tabId);                                       // drop the entry first → the old handlers' guard goes quiet
  if (old) { try { old.kill(); } catch {} }
  spawnPty(tabId, cols, rows, ws, session);
  if (tabId === fgTabId) syncShare();                       // refresh the granted library (live flag) for guests
}
// Make a tab the foreground/mirrored one WITHOUT killing it (the no-kill analogue of respawnPty). Points
// the single guest mirror at this tab and keeps the global active-workspace notion in lockstep with it.
function setForegroundTab(tabId) {
  fgTabId = tabId;   // record intent even if the pty hasn't spawned yet — spawnPty wires the mirror once it has
  const rec = ptys.get(tabId);
  if (rec && rec.ws && registry.activeId !== rec.ws.id) { activeWorkspace = rec.ws; registry.activeId = rec.ws.id; saveRegistry(); }
  else if (rec && rec.ws) activeWorkspace = rec.ws;
  try { share.resetRing(); share.resetStatus(); } catch {}                        // drop the previous tab's replay/tracker
  try { if (share.status().running) share.setPaused(!(rec && rec.ws && rec.ws.shared)); } catch {}
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
  if (fgTabId === tabId) fgTabId = ptys.keys().next().value || null;   // renderer will foreground the next tab explicitly
  return { ok: true };
});

// ---- live terminal sharing (local server + cloudflared tunnel) ----
ipcMain.handle('share:start', async (e, opts) => {
  try {
    const { port, token } = await share.start({ readOnly: !!(opts && opts.readOnly), name: opts && opts.name });
    const fr0 = fgRec(); share.setSize(fr0 ? fr0.cols : 120, fr0 ? fr0.rows : 32);
    syncShare();                                          // tell guests the granted library + pause if the live ws is private
    let base = `http://127.0.0.1:${port}`, remote = false, note = null;
    try {
      const { proc, url } = await startCloudflared(port);
      cloudflaredProc = proc;
      cloudflaredProc.on('exit', () => { cloudflaredProc = null; });
      base = url; remote = true;                       // public link
    } catch (tunErr) { note = String(tunErr.message || tunErr); }   // tunnel down → fall back to localhost/LAN
    shareBaseUrl = base;
    const st = share.status();
    return { ok: true, url: `${base}/?t=${token}`, localUrl: `http://127.0.0.1:${port}/?t=${token}`, remote, note, readOnly: st.readOnly };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle('share:stop', async () => {
  try { cloudflaredProc && cloudflaredProc.kill(); } catch {}
  cloudflaredProc = null; shareBaseUrl = null;
  share.stop();
  return { ok: true };
});
ipcMain.handle('share:newlink', () => {                 // mint a fresh one-time link (re-invite)
  if (!share.status().running || !shareBaseUrl) return { ok: false, error: 'not sharing' };
  const t = share.regenerateLink();
  return { ok: true, url: `${shareBaseUrl}/?t=${t}` };
});
ipcMain.handle('share:approve', (e, arg) => share.decideApproval(arg && arg.id, !!(arg && arg.ok)));   // host's verdict

// ---- sessions (list / switch) ----
function listSessions() {
  return new Promise((resolve) => {
    if (!APPDIR_WSL) return resolve([]);
    cp.execFile('wsl.exe', ['-e', 'bash', '-lc', `${wsEnv(activeWorkspace)} bash '${APPDIR_WSL}/wsl/sessions.sh'`],
      { maxBuffer: 8 * 1024 * 1024, timeout: 12000 }, (err, stdout) => {
        if (err) { console.error('[claudible] sessions.sh:', err.message); return resolve([]); }
        try { resolve(JSON.parse(String(stdout).trim() || '[]')); } catch { resolve([]); }
      });
  });
}
ipcMain.handle('session:list', () => listSessions());
ipcMain.handle('session:open', (e, { tabId, id }) => { respawnPty(tabId, id); return { ok: true }; });   // re-point an existing tab at 'new' | <session-id>
// Soft-delete a saved session: move its transcript to ~/.claudible/trash/ (recoverable). The renderer
// switches the pty off this session BEFORE calling, so the file isn't held open by a live claude --resume.
ipcMain.handle('session:delete', (e, id) => new Promise((resolve) => {
  const sid = String(id || '').replace(/[^A-Za-z0-9-]/g, '');               // mirror the script's allowlist
  if (!sid || !APPDIR_WSL) return resolve({ ok: false, error: 'bad id' });
  cp.execFile('wsl.exe', ['-e', 'bash', '-lc', `${wsEnv(activeWorkspace)} bash '${APPDIR_WSL}/wsl/delete-session.sh' '${sid}'`],
    { encoding: 'utf8' }, (err, stdout) => {
      if (err) { console.error('[claudible] delete-session:', err.message); return resolve({ ok: false, error: 'exec' }); }
      try { resolve(JSON.parse((stdout || '').trim() || '{}')); } catch { resolve({ ok: true }); }
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
    cp.execFile('wsl.exe', ['-e', 'bash', '-lc', `${live}${wsEnv(ws)} bash '${APPDIR_WSL}/wsl/sessions-sync.sh' '${o}'`],
      { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err) { console.error('[claudible] sessions-sync', o, err.message); return resolve({ ok: false, error: 'exec' }); }
        try { resolve(JSON.parse(String(stdout).trim() || '{}')); } catch { resolve({ ok: false, error: 'parse' }); }
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
    cp.execFile('wsl.exe', ['-e', 'bash', '-lc', `bash '${APPDIR_WSL}/wsl/clone-workspace.sh' '${owner}' '${slug}'`],
      { encoding: 'utf8', timeout: 300000 }, (err, stdout) => {
        if (err) return resolve({ ok: false, error: 'clone exec' });
        let r = {}; try { r = JSON.parse(String(stdout).trim() || '{}'); } catch {}
        if (r.ok) { delete ws.needsClone; saveRegistry(); }
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
    cp.execFile('wsl.exe', ['-e', 'bash', '-lc', `bash '${APPDIR_WSL}/wsl/sessions-discover.sh'`],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err) { console.error('[claudible] discover:', err.message); return resolve({ ok: false, added: [] }); }
        let list = []; try { list = JSON.parse(String(stdout).trim() || '[]'); } catch {}
        const added = [];
        for (const item of (Array.isArray(list) ? list : [])) {
          const slug = String(item && item.slug || '').replace(/[^A-Za-z0-9-]/g, '');
          const owner = String(item && item.owner || '').replace(/[^A-Za-z0-9-]/g, '');
          if (!slug || !owner) continue;
          const wid = `repo-${slug}`;
          if (registry.workspaces.some((w) => w.id === wid)) continue;       // already known locally
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
    cp.execFile('wsl.exe', ['-e', 'bash', '-lc', `bash '${APPDIR_WSL}/wsl/create-workspace.sh' '${kind}' '${slug}'${arg3}`],
      { encoding: 'utf8', timeout: kind === 'repo' ? 300000 : 30000 }, (err, stdout) => {   // repo = network-bound (clone+push)
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
        try { wslp = cp.execFileSync('wsl.exe', ['wslpath', '-u', res.filePaths[0].replace(/\\/g, '/')], { encoding: 'utf8' }).trim(); } catch {}
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
    cp.execFile('wsl.exe', ['-e', 'bash', '-lc', `${wsEnv(ws)} bash '${APPDIR_WSL}/wsl/delete-workspace.sh' '${ws.kind}' '${slug}'`],
      { encoding: 'utf8', timeout: 20000 }, finish);
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
  registry.effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(level) ? level : '';
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
  cp.execFile('wsl.exe', ['-e', 'bash', '-lc', `bash '${APPDIR_WSL}/wsl/repo-invite.sh' '${slug}' '${login}'`],
    { encoding: 'utf8', timeout: 60000 }, (err, stdout) => {
      if (err) { console.error('[claudible] repo-invite:', err.message); return resolve({ ok: false, error: 'invite failed' }); }
      let r = {}; try { r = JSON.parse(String(stdout).trim() || '{}'); } catch {}
      resolve(r.ok ? { ok: true, status: r.status || 'invited' } : { ok: false, error: r.error || 'invite failed' });
    });
}));
// ---- skills + plugins (manage Claude Code extensions from the cockpit) ----
ipcMain.handle('skills:list', () => new Promise((resolve) => {
  if (!APPDIR_WSL) return resolve([]);
  cp.execFile('wsl.exe', ['-e', 'bash', '-lc', `${wsEnv(activeWorkspace)} bash '${APPDIR_WSL}/wsl/skills.sh' list`],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 12000 }, (err, stdout) => {
      if (err) { console.error('[claudible] skills:list', err.message); return resolve([]); }
      try { resolve(JSON.parse(String(stdout).trim() || '[]')); } catch { resolve([]); }
    });
}));
ipcMain.handle('skills:set', (e, payload) => new Promise((resolve) => {
  const name = String((payload && payload.name) || '').replace(/[^A-Za-z0-9:/_.-]/g, '');
  const state = ['on', 'off', 'name-only', 'user-invocable-only'].includes(payload && payload.state) ? payload.state : '';
  if (!name || !state) return resolve({ ok: false, error: 'bad args' });
  if (!APPDIR_WSL) return resolve({ ok: false, error: 'WSL unavailable' });
  cp.execFile('wsl.exe', ['-e', 'bash', '-lc', `${wsEnv(activeWorkspace)} bash '${APPDIR_WSL}/wsl/skills.sh' set '${name}' '${state}'`],
    { encoding: 'utf8' }, (err, stdout) => {
      if (err) { console.error('[claudible] skills:set', err.message); return resolve({ ok: false, error: 'failed' }); }
      try { resolve(JSON.parse(String(stdout).trim() || '{}')); } catch { resolve({ ok: false }); }
    });
}));
ipcMain.handle('plugins:list', () => new Promise((resolve) => {
  if (!APPDIR_WSL) return resolve([]);
  cp.execFile('wsl.exe', ['-e', 'bash', '-lc', `bash '${APPDIR_WSL}/wsl/plugins.sh' list`],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 12000 }, (err, stdout) => {
      if (err) { console.error('[claudible] plugins:list', err.message); return resolve([]); }
      try { resolve(JSON.parse(String(stdout).trim() || '[]')); } catch { resolve([]); }
    });
}));
ipcMain.handle('plugins:available', () => new Promise((resolve) => {
  if (!APPDIR_WSL) return resolve([]);
  cp.execFile('wsl.exe', ['-e', 'bash', '-lc', `bash '${APPDIR_WSL}/wsl/plugins.sh' available`],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 15000 }, (err, stdout) => {
      if (err) { console.error('[claudible] plugins:available', err.message); return resolve([]); }
      try { resolve(JSON.parse(String(stdout).trim() || '[]')); } catch { resolve([]); }
    });
}));
ipcMain.handle('plugins:toggle', (e, payload) => new Promise((resolve) => {
  const key = String((payload && payload.key) || '').replace(/[^A-Za-z0-9@._/-]/g, '');
  const act = (payload && payload.enable) ? 'enable' : 'disable';
  if (!key) return resolve({ ok: false, error: 'bad key' });
  if (!APPDIR_WSL) return resolve({ ok: false, error: 'WSL unavailable' });
  cp.execFile('wsl.exe', ['-e', 'bash', '-lc', `bash '${APPDIR_WSL}/wsl/plugins.sh' toggle '${key}' '${act}'`],
    { encoding: 'utf8', timeout: 60000 }, (err, stdout) => {
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
function pollStatus() {
  setInterval(() => {
    for (const [tabId, rec] of ptys) {
      try {
        const raw = fs.readFileSync(path.join(RT, 'tabs', rec.runtimeId, 'status.json'), 'utf8');
        if (raw === lastStatusByTab.get(tabId)) continue; lastStatusByTab.set(tabId, raw);
        const d = JSON.parse(raw); const c = d.context_window || {}; const cost = d.cost || {};
        if (d.session_id) rec.sessionId = d.session_id;   // the live session id — used to locate this tab's workflow/swarm agents
        const cu = c.current_usage || null;   // last turn's usage (input/output here are NEW, non-cache)
        win.webContents.send('status', {
          tabId,
          sessionId: d.session_id || null,   // lets the renderer reconcile a freshly-started "new" tab into its saved session row
          ctxPct: c.used_percentage, costUsd: cost.total_cost_usd,
          newTok: cu ? ((cu.input_tokens || 0) + (cu.output_tokens || 0)) : null,  // genuinely-new tokens, excl. cache
          usageKey: cu ? `${cu.input_tokens}:${cu.output_tokens}:${cu.cache_read_input_tokens}:${cu.cache_creation_input_tokens}` : null,
          model: d.model && d.model.display_name, fast: d.fast_mode,
        });
      } catch {}
    }
  }, 1200);
}

// ---- agent-token meter: the statusLine usage excludes subagents/swarms, so scan each live tab's
// subagents dir for the tokens they consumed and forward it. Slow cadence (a cheap python scan). ----
function pollAgentTokens() {
  if (!APPDIR_WSL) return;
  setInterval(() => {
    for (const [tabId, rec] of ptys) {
      const sid = String(rec.sessionId || '').replace(/[^A-Za-z0-9-]/g, '');
      if (!sid) continue;
      cp.execFile('wsl.exe', ['-e', 'bash', '-lc', `${wsEnv(rec.ws)} bash '${APPDIR_WSL}/wsl/agent-tokens.sh' '${sid}'`],
        { encoding: 'utf8', timeout: 10000 }, (err, stdout) => {
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
        });
    }
  }, 8000);
}
// ---- hook events: poll EACH live tab's runtime/tabs/<tab>/hooks.ndjson for appended lines ----
const hookState = new Map();   // tabId -> { offset, buf } (independent tail cursor per tab)
function pollHooks() {
  setInterval(() => {
    for (const [tabId, rec] of ptys) {
      let s = hookState.get(tabId); if (!s) { s = { offset: 0, buf: '' }; hookState.set(tabId, s); }
      try {
        const p = path.join(RT, 'tabs', rec.runtimeId, 'hooks.ndjson');
        const st = fs.statSync(p);
        if (st.size < s.offset) { s.offset = 0; s.buf = ''; }     // truncated (this tab's pty respawned)
        if (st.size === s.offset) continue;
        const fd = fs.openSync(p, 'r'); const buf = Buffer.alloc(st.size - s.offset);
        fs.readSync(fd, buf, 0, buf.length, s.offset); fs.closeSync(fd);
        s.offset = st.size; s.buf += buf.toString('utf8');
        let i; while ((i = s.buf.indexOf('\n')) >= 0) { const l = s.buf.slice(0, i).trim(); s.buf = s.buf.slice(i + 1); if (l) { handleHook(tabId, l); win.webContents.send('hook:line', { tabId, line: l }); } }
      } catch {}
    }
  }, 80);   // poll often so a finished reply reaches the renderer (and TTS) with minimal lag
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
    cp.execFile('wsl.exe', ['-e', 'bash', '-lc', `${wsEnv(ws)} bash '${APPDIR_WSL}/wsl/workflows.sh' '${s}'`],
      { encoding: 'utf8', timeout: 12000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
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
ipcMain.handle('endpoints', () => ({ whisper: WHISPER, kokoro: KOKORO, pty: !!nodePty, ptyErr }));

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
      cp.execFile('wsl.exe', ['-e', 'bash', '-lc', `${wsEnv(ws)} bash '${APPDIR_WSL}/wsl/transcript.sh' '${sid}'`],
        { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
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

// ---- Diff Review: see what Claude changed in the active workspace's git repo, revert per hunk/file ----
ipcMain.handle('diff:list', () => new Promise((resolve) => {
  if (!APPDIR_WSL) return resolve({ ok: false, repo: false, files: [], untracked: [] });
  cp.execFile('wsl.exe', ['-e', 'bash', '-lc', `${wsEnv(activeWorkspace)} bash '${APPDIR_WSL}/wsl/diff.sh'`],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      let r = { ok: false, repo: false, files: [], untracked: [] };
      try { r = JSON.parse(String(stdout).trim() || '{}'); } catch {}
      resolve(r);
    });
}));
// Reverse-apply a hunk/file patch, or discard an untracked file. The patch text / target path is written to
// an APP-controlled temp file and only its path is passed to bash (never the repo data) — no injection.
function diffAction(mode, payload) {
  return new Promise((resolve) => {
    try {
      if (!APPDIR_WSL || typeof payload !== 'string' || !payload) return resolve({ ok: false, error: 'bad args' });
      const tmp = path.join(RT, 'diffaction.tmp');
      fs.writeFileSync(tmp, payload, 'utf8');
      cp.execFile('wsl.exe', ['-e', 'bash', '-lc', `${wsEnv(activeWorkspace)} bash '${APPDIR_WSL}/wsl/diff-apply.sh' ${mode} '${APPDIR_WSL}/runtime/diffaction.tmp'`],
        { encoding: 'utf8', timeout: 20000 }, (err, stdout) => {
          let r = { ok: false }; try { r = JSON.parse(String(stdout).trim() || '{}'); } catch {}
          resolve(r);
        });
    } catch (err) { resolve({ ok: false, error: String(err) }); }
  });
}
ipcMain.handle('diff:revert', (e, patch) => diffAction('apply-reverse', patch));
ipcMain.handle('diff:discard', (e, relPath) => diffAction('discard', relPath));

// Safety net: never let a stray error from a pty/agent take the whole cockpit down.
process.on('uncaughtException', (e) => console.error('[claudible] uncaughtException:', e && e.message));
process.on('unhandledRejection', (e) => console.error('[claudible] unhandledRejection:', e && (e.message || e)));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  try { for (const { proc } of ptys.values()) { try { proc.kill(); } catch {} } ptys.clear(); } catch {}
  try { cloudflaredProc && cloudflaredProc.kill(); } catch {}
  try { share.stop(); } catch {}
  app.quit();
});
