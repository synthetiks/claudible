// Claudible — Electron main process.
//  • embeds the live Claude session (node-pty -> wsl session.sh -> claude, run directly, no tmux),
//    spawned at the renderer's fitted size so the TUI never reflows/garbles
//  • auto-confirms the WSL "trust this folder" prompt
//  • reads runtime/status.json (session tracker) + runtime/hooks.ndjson (Claude hook events)
//    from the WINDOWS FS natively (no flaky 9P watch)
//  • STT/TTS fetches run here (no renderer CORS)
const { app, BrowserWindow, ipcMain, session, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

let win, ptyProc, trustDone = false;
const WHISPER = process.env.CLAUDIBLE_WHISPER || 'http://localhost:2022';
const KOKORO  = process.env.CLAUDIBLE_KOKORO  || 'http://localhost:8880';
const RT = path.join(__dirname, 'runtime');
const STATUS = path.join(RT, 'status.json');
const HOOKS  = path.join(RT, 'hooks.ndjson');
// Resolve THIS app's own folder as a WSL path (C:\Users\X\claudible -> /mnt/c/Users/X/claudible) so the
// bootstrap script + runtime files work for ANY user/location — no hardcoded home. wslpath does it robustly.
let APPDIR_WSL = null;
// NB: pass forward slashes — single backslashes get stripped crossing the Windows->WSL arg boundary, so
// a raw `C:\Users\...` reaches wslpath as `C:Users...`. wslpath accepts forward slashes natively.
try { APPDIR_WSL = cp.execFileSync('wsl.exe', ['wslpath', '-u', __dirname.replace(/\\/g, '/')], { encoding: 'utf8' }).trim(); }
catch (e) { console.error('[claudible] wslpath failed:', e.message); }
// session.sh receives the app dir as $1 so it writes runtime/ to the SAME Windows folder this process reads.
const BOOT = APPDIR_WSL
  ? `bash '${APPDIR_WSL}/wsl/session.sh' '${APPDIR_WSL}'`
  : 'echo "[claudible] could not resolve the app path via wslpath — is WSL installed?"; sleep 8';
try { fs.mkdirSync(RT, { recursive: true }); } catch {}

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
  // Grant ONLY the microphone (needed for push-to-talk); deny every other permission request.
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'media'));
  // Lock the window down: it only ever loads our local renderer. Block navigation away and any
  // attempt to open new windows — defense-in-depth for distributed Electron software.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile('renderer/index.html');
  win.webContents.on('did-finish-load', () => {
    startVoiceServices();   // idempotent; ensures STT/TTS are up even when launched via `npm start`
    pollStatus(); pollHooks();
    // spawn-on-size fallback: if the renderer never reports a size, start at a default
    setTimeout(() => { if (!ptyProc) spawnPty(120, 32); }, 1800);
  });
}

// ---- embedded live Claude TUI ----
function spawnPty(cols, rows) {
  if (ptyProc || !nodePty) {
    if (!nodePty && win) win.webContents.send('pty:data', `\r\n[claudible] node-pty unavailable (${ptyErr})\r\n`);
    return;
  }
  try {
    ptyProc = nodePty.spawn('wsl.exe', ['-e', 'bash', '-lc', BOOT], {
      name: 'xterm-256color', cols: cols || 120, rows: rows || 32, cwd: process.env.USERPROFILE, env: process.env,
      // ConPTY (default on Win11) — preserves full ANSI incl. the dim attribute (winpty strips it).
      // Its console-list agent crash ("AttachConsole failed") is neutralized by the guard patch in
      // node_modules/node-pty/lib/conpty_console_list_agent.js + the uncaughtException net below.
    });
    ptyProc.onData(d => {
      win.webContents.send('pty:data', d);
      if (!trustDone && /trust this folder/i.test(d)) { trustDone = true; setTimeout(() => { try { ptyProc.write('\r'); } catch {} }, 250); }
    });
    ptyProc.onExit(() => { win.webContents.send('pty:data', '\r\n[claudible] session ended\r\n'); ptyProc = null; });
  } catch (e) { win.webContents.send('pty:data', `\r\n[claudible] pty spawn failed: ${e.message}\r\n`); }
}
ipcMain.on('pty:start', (e, { cols, rows }) => spawnPty(cols, rows));
ipcMain.on('pty:input', (e, d) => { if (ptyProc) ptyProc.write(d); });
ipcMain.on('pty:resize', (e, { cols, rows }) => { try { ptyProc && ptyProc.resize(cols, rows); } catch {} });

// ---- session tracker: poll runtime/status.json (Windows FS, native read) ----
let lastStatus = '';
function pollStatus() {
  setInterval(() => {
    try {
      const raw = fs.readFileSync(STATUS, 'utf8'); if (raw === lastStatus) return; lastStatus = raw;
      const d = JSON.parse(raw); const c = d.context_window || {}; const cost = d.cost || {};
      const cu = c.current_usage || null;   // last turn's usage (input/output here are NEW, non-cache)
      win.webContents.send('status', {
        ctxPct: c.used_percentage, costUsd: cost.total_cost_usd,
        newTok: cu ? ((cu.input_tokens || 0) + (cu.output_tokens || 0)) : null,  // genuinely-new tokens, excl. cache
        usageKey: cu ? `${cu.input_tokens}:${cu.output_tokens}:${cu.cache_read_input_tokens}:${cu.cache_creation_input_tokens}` : null,
        model: d.model && d.model.display_name, fast: d.fast_mode,
      });
    } catch {}
  }, 1200);
}

// ---- hook events: poll runtime/hooks.ndjson for appended lines ----
let hookOffset = 0, hookBuf = '';
function pollHooks() {
  setInterval(() => {
    try {
      const st = fs.statSync(HOOKS);
      if (st.size < hookOffset) { hookOffset = 0; hookBuf = ''; }     // truncated (new session)
      if (st.size === hookOffset) return;
      const fd = fs.openSync(HOOKS, 'r'); const buf = Buffer.alloc(st.size - hookOffset);
      fs.readSync(fd, buf, 0, buf.length, hookOffset); fs.closeSync(fd);
      hookOffset = st.size; hookBuf += buf.toString('utf8');
      let i; while ((i = hookBuf.indexOf('\n')) >= 0) { const l = hookBuf.slice(0, i).trim(); hookBuf = hookBuf.slice(i + 1); if (l) win.webContents.send('hook:line', l); }
    } catch {}
  }, 80);   // poll often so a finished reply reaches the renderer (and TTS) with minimal lag
}
ipcMain.handle('hook:test', async () => {
  const ts = Date.now();
  try { fs.appendFileSync(HOOKS, JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'hook link OK', sent_ms: ts }) + '\n'); } catch {}
  return ts;
});

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

// Safety net: never let a stray error from a pty/agent take the whole cockpit down.
process.on('uncaughtException', (e) => console.error('[claudible] uncaughtException:', e && e.message));
process.on('unhandledRejection', (e) => console.error('[claudible] unhandledRejection:', e && (e.message || e)));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { try { ptyProc && ptyProc.kill(); } catch {} app.quit(); });
