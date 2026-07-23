// Claudible — Electron main process.
//  • embeds the live Claude session (node-pty -> wsl session.sh -> claude, run directly, no tmux),
//    spawned at the renderer's fitted size so the TUI never reflows/garbles
//  • auto-confirms the WSL "trust this folder" prompt
//  • reads runtime/status.json (session tracker) + runtime/hooks.ndjson (Claude hook events)
//    from the WINDOWS FS natively (no flaky 9P watch)
//  • STT/TTS fetches run here (no renderer CORS)
const { app, BrowserWindow, ipcMain, session, dialog, clipboard, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { atomicWriteJson } = require('./lib/atomicWrite');          // every JSON file this process owns is written tmp+rename; every reader of one treats a parse error as "empty"
const { safePath, PATH_UNSAFE_MSG } = require('./lib/pathSafe');   // ONE charset for every path that crosses into a bash arg and back through JSON
const { makeKeyedQueue } = require('./lib/keyedQueue');             // serializes the three code paths that mutate a workspace's git worktree
const { findExistingWorkspace, reconcileWorkspace } = require('./lib/discovery');   // rename-safe discovery dedup (unit-tested in test/discovery.test.js)
const { createShareServer, sanitizePaste } = require('./share/server');
const { shq } = require('./runners/_shared');   // single-quote-safe interpolation for values that ride into a bash -lc arg string (defense-in-depth on the presence stamps below)
const { readGitSha } = require('./lib/buildIdentity');
const { makePresenceRelay, mergePeerFrame, reconcilePeerLists } = require('./lib/presenceRelay');
const selfUpdate = require('./lib/selfUpdate');
// The running build's git identity, captured AT BOOT — the process keeps executing this even after a
// `git pull` moves the files under it, which is precisely the drift checkBuildDrift() surfaces.
const BUILD = readGitSha(__dirname) || { sha: '', short: '', at: 0 };
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
// While a live session runs, the mirror is PINNED to the tab that was foreground when the share started.
// fgTabId keeps tracking the host's focus for host-local concerns (sidebar clicks, agents view, prompt
// attribution) — but everything guests can see or drive gates on the PIN, so the host can open and work in
// any other session without a byte of it reaching a guest, while the shared session keeps streaming.
let sharedTabId = null;
const _typUi = { name: '', ts: 0 };   // throttle for the host cockpit's "guest is typing" chip (share:typist)
let _typHostTs = 0;                   // throttle for telling guests "the host is typing" (share.broadcastTypist)
function mirrorTabId() { return sharedTabId || fgTabId; }   // pinned while sharing; follows focus otherwise (keeps the replay ring warm pre-share)
function mirrorWs() {
  if (!sharedTabId) return activeWorkspace;                 // not pinned → the mirror follows the foreground, whose ws IS activeWorkspace
  const r = ptys.get(sharedTabId); if (r && r.ws) return r.ws;
  const it = tabIntent.get(sharedTabId); return (it && it.ws) || null;   // respawn gap; unknown reads as private → mirror pauses (privacy-first)
}
// Native live-join: a JOINED peer session is NOT a local pty — it's a CLIENT WebSocket (held in main because the
// renderer's CSP forbids a wss:// socket) that mirrors a peer's terminal into a cockpit tab. Kept entirely
// separate from `ptys`/`fgTabId` so watching/co-driving a peer NEVER touches the user's own outgoing share.
const { WebSocket: LiveSocket } = require('ws');
const liveTabs = new Map();    // tabId -> { ws, url, token, name, hostCols, hostRows, pid, readOnly, resume, retry, closed, peer }
// Live terminal sharing: server runs locally (loopback); cloudflared carries the last hop. See share/.
let cloudflaredProc = null, shareBaseUrl = null;
// A hard crash / force-kill orphans cloudflared (a live tunnel with no handle). Record its pid while running and,
// on the NEXT launch, kill the orphan — but ONLY if that pid is still a cloudflared (guards against a recycled pid).
const _cfPidFile = () => path.join(RT, 'cloudflared.pid');
function _writeCfPid(pid) { try { fs.writeFileSync(_cfPidFile(), String(pid || '')); } catch {} }
function _clearCfPid() { try { fs.unlinkSync(_cfPidFile()); } catch {} }
// Match the process's EXECUTABLE NAME, not a substring of its full command line: a recycled pid running e.g.
// `tail cloudflared.log` or an editor with "cloudflared" in a path would substring-match and get killed. We only
// ever spawn a binary named cloudflared[.exe], so an exact basename match identifies our orphan without false hits.
function _isCloudflaredPid(pid) {
  try {
    if (process.platform === 'linux') {
      const argv0 = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0')[0] || '';   // argv[0] = the executable (NUL-delimited cmdline)
      return path.basename(argv0) === 'cloudflared';
    }
    if (process.platform === 'win32') {
      const out = require('child_process').execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
      return /^"cloudflared\.exe"/i.test(String(out).trim());   // the image name is the FIRST CSV field
    }
    const out = require('child_process').execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });   // comm = executable name only (no args) — mac/other posix
    return path.basename(String(out).trim()) === 'cloudflared';
  } catch { return false; }
}
function reapOrphanCloudflared() {
  let pid = 0; try { pid = parseInt(fs.readFileSync(_cfPidFile(), 'utf8').trim(), 10); } catch { return; }
  if (Number.isInteger(pid) && pid > 0 && _isCloudflaredPid(pid)) { try { process.kill(pid); } catch {} console.log('[claudible] reaped orphaned cloudflared pid', pid); }
  _clearCfPid();
}
// Tag who typed (keystroke OR paste) so history AND the context hook can attribute it. The context write
// happens BEFORE proc.write: it's synchronous, so the Enter that submits a prompt always lands with
// typedBy already on disk when Claude fires UserPromptSubmit. Throttled — rewrite only when the typist
// CHANGES or every 5s during a burst (keeps typedBy.ts fresh for the hook's 20s window without a
// per-keystroke fs write); any HOST keystroke clears it (pty:input below), so "fresh typedBy" ⇒ guest-driven.
function _noteGuestTypist(t, who) {
  if (!who || !who.name) return;
  const prev = t.lastInputBy;
  t.lastInputBy = { name: who.name, ts: Date.now() };
  if (!prev || prev.name !== who.name || (t.lastInputBy.ts - (t.typistWrittenTs || 0)) > 5000) {
    t.typistWrittenTs = t.lastInputBy.ts;
    try { _writeContext(mirrorTabId()); } catch {}
  }
  // typist chip for the HOST's own cockpit (guests get theirs from the server's typistPing) — 1/s throttle,
  // immediate on typist change; the renderer decays the chip so no stop event is needed.
  if (who.name !== _typUi.name || (t.lastInputBy.ts - _typUi.ts) > 1000) {
    _typUi.name = who.name; _typUi.ts = t.lastInputBy.ts;
    try { winSend('share:typist', { name: who.name }); } catch {}
  }
}
const share = createShareServer({
  // A guest typed → into the FOREGROUND pty (see _noteGuestTypist above for the attribution contract).
  onInput: (d, who) => {
    const t = ptys.get(mirrorTabId());                       // guests ALWAYS drive the SHARED tab — never whatever the host happens to be focused on
    if (!t) return;
    _noteGuestTypist(t, who);
    try { t.proc.write(d); } catch {}
  },
  // A guest PASTED — their own clipboard text as one typed frame (the guest client never sends a raw ^V;
  // the server strips one anyway). Wrapped in bracketed-paste marks HERE, exactly like the host's own
  // Ctrl+V path (renderer sendInput('\x1b[200~'+t+'\x1b[201~')), after sanitizing: an embedded end-mark
  // would break out of the paste block and run as live keystrokes. Attribution matches keystrokes so
  // history and the typist chip credit the paster.
  onPaste: (text, who) => {
    const t = ptys.get(mirrorTabId());
    if (!t) return;
    const safe = sanitizePaste(text);
    if (!safe) return;
    _noteGuestTypist(t, who);
    try { t.proc.write('\x1b[200~' + safe + '\x1b[201~'); } catch {}
  },
  onGuests: (n) => { try { win && win.webContents.send('share:guests', n); } catch {} },
  onRoster: (roster) => { try { win && win.webContents.send('share:roster', roster); } catch {} _lastRoster = Array.isArray(roster) ? roster : []; try { _writeContext(mirrorTabId()); } catch {} },   // presence lights; refresh the HOSTING tab's injected context so the model sees who's here
  onApprovalRequest: (info) => { try { win && win.webContents.send('share:approval', info); } catch {} },
  onApprovalCancel: (id) => { try { win && win.webContents.send('share:approval-cancel', id); } catch {} },
  onChat: (m) => { try { win && win.webContents.send('share:chat', m); } catch {} },   // guest → host chat
  // A guest clicked a (granted) workspace in their viewer → switch the shared terminal to it, and tell the host UI.
  onSwitchWorkspace: (id) => {
    const ws = registry.workspaces.find((w) => w.id === id && w.shared);
    if (!ws) return;                                                   // only granted workspaces are switchable
    openGen++;                                                         // supersede any in-flight workspace:open clone
    const target = mirrorTabId();
    const rec = ptys.get(target);
    const prevWs = rec && rec.ws;
    if (rec) rec.ws = ws;                                              // re-point the SHARED tab at that ws (the guest is switching the live session, not the host's focus) — respawnPty reads rec.ws, so set before; reverted below on refusal
    const hostIsHere = target === fgTabId;
    // guardBusy: a GUEST's library click must never kill a mid-turn Claude — this was the one respawn path
    // left without the busy guard every host-driven path already has. On refusal: revert the optimistic
    // re-point (the pty never moved), touch no globals, and re-broadcast the true share state so the guest's
    // library selection snaps back instead of showing a switch that never happened.
    if (!respawnPty(target, '', { trustedReroute: true, guardBusy: true })) {
      if (rec) rec.ws = prevWs;
      try { syncShare(); } catch {}
      return;
    }
    // Touch the GLOBAL active workspace only when the shared tab IS the host's foreground tab. When the host is
    // working in a private tab, a guest's click used to clobber activeWorkspace/registry.activeId anyway —
    // silently re-scoping the host's sidebar session list (and everything else keyed to the active ws) to a
    // workspace the host never switched to. setForegroundTab reconciles the globals whenever the host actually
    // returns to the shared tab.
    if (hostIsHere) { activeWorkspace = ws; registry.activeId = id; saveRegistry(); }
    try { win && win.webContents.send('workspace:active-changed', { id, tabId: target, global: hostIsHere }); } catch {}   // tabId = the tab whose pty was ACTUALLY re-pointed (the pinned shared tab); global:false = reset that tab's record but leave the host's sidebar scope alone
  },
  // (The read-only session/transcript browser was removed — a live link shares one running session, not the
  // saved history of the granted projects. The server no longer accepts ws-sessions/ws-transcript at all.)
  // Voice room — audio is RELAYED through the share server as base64 PCM (the original peer-to-peer WebRTC path
  // was replaced by c4b9c4f). The server tracks membership and forwards every voice frame. Bridge the host
  // cockpit's voice membership + audio frames back to the cockpit renderer (over IPC).
  onVoiceMembers: (members) => { try { win && win.webContents.send('share:voice-members', members); } catch {} },
  onAudio: (frame) => { try { win && win.webContents.send('share:audio', frame); } catch {} },   // a guest's voice frame → cockpit
});
ipcMain.on('share:voice', (e, { join } = {}) => { try { share.hostVoiceSet(!!join); } catch {} });
ipcMain.on('share:audio-send', (e, p) => { try { share.audioFromHost(p && p.data, p && p.sr); } catch {} });   // cockpit's voice frame → guests
const WHISPER = process.env.CLAUDIBLE_WHISPER || 'http://localhost:2022';
const KOKORO  = process.env.CLAUDIBLE_KOKORO  || 'http://localhost:8880';
const RT = runner.runtimeDir();   // per-tab status/hooks live under RT/tabs/<tabId>/ (see pollers)
// Durable state — settings (username + every renderer pref), the workspace registry, session history — lives
// under ~/.claudible/app, NOT inside the app folder (R4). runtime/ sits in the clone, so "delete the folder and
// re-clone" (the documented uninstall, an update-by-reclone, an antivirus quarantine of the folder) silently
// wiped every project registration, every sync consent, and every title: the 2026-07-18 reinstall data-loss,
// root-caused. ~/.claudible already survives reinstalls (it holds the repos + sessions); the app's own state now
// enjoys the same guarantee. CLAUDIBLE_PERSIST overrides for sandboxed tests. Per-tab runtime (status/hooks/
// context.json) STAYS under RT on purpose: it's ephemeral, and wsl/session.sh derives the same path from
// $APPDIR — relocating it would split the bash writer from main's pollers (the documented runner constraint).
const PERSIST = process.env.CLAUDIBLE_PERSIST || path.join(app.getPath('home'), '.claudible', 'app');
try { fs.mkdirSync(PERSIST, { recursive: true }); } catch {}
// One-time migration from the old in-clone location: an EXISTING install keeps its data on the first boot after
// this change (the new location wins once populated; old copies stay behind as inert backups, never re-read).
try {
  // Copy through a temp sibling + rename so a crash mid-copy can't leave a TORN destination (a half-written
  // settings.json reads as {} — a silent wipe). Atomic + idempotent (skip-if-present) = safe to retry.
  const copyAtomic = (src, dst) => { const tmp = dst + '.mig-' + process.pid; fs.copyFileSync(src, tmp); fs.renameSync(tmp, dst); };
  for (const f of ['settings.json', 'workspaces.json']) {
    const oldP = path.join(RT, f), newP = path.join(PERSIST, f);
    if (!fs.existsSync(newP) && fs.existsSync(oldP)) copyAtomic(oldP, newP);
  }
  // History was gated on the DESTINATION DIR existing — but mkdirSync created it BEFORE any file was copied, so an
  // interrupted migration (or one swallowed copyFileSync error) left the dir present and the whole block was
  // skipped forever, stranding the un-migrated per-workspace history. Gate on a completion MARKER instead, copy
  // each file atomically and only if absent (resumable), and write the marker only after a fully clean pass. The
  // marker lives beside the dir (not inside it) so it never shows up to the history reader.
  const oldH = path.join(RT, 'history'), newH = path.join(PERSIST, 'history'), histDone = path.join(PERSIST, '.history-migrated');
  if (!fs.existsSync(histDone) && fs.existsSync(oldH)) {
    fs.mkdirSync(newH, { recursive: true });
    let allOk = true;
    for (const f of fs.readdirSync(oldH)) {
      const dst = path.join(newH, f);
      if (fs.existsSync(dst)) continue;
      try { copyAtomic(path.join(oldH, f), dst); } catch { allOk = false; }   // a failed file → leave the marker unwritten so the next boot retries it
    }
    if (allOk) { try { fs.writeFileSync(histDone, String(Date.now())); } catch {} }
  }
} catch (e) { console.error('[claudible] persist migration:', e && e.message); }   // never fatal — a failed copy just means first-run defaults
// The sandboxed preload can't use fs, so MAIN owns the settings file; these handlers are registered at top level
// here (before any window loads) because the preload reads it via a blocking sendSync.
const SETTINGS_FILE = path.join(PERSIST, 'settings.json');
// A parse error here is INDISTINGUISHABLE from "no settings yet" — both mean {}. That's the right default for a
// missing file and a silent wipe for a torn one (every session title, the collab name, the permission mode), so
// writeSettings goes through tmp+rename: the file this returns is always one whole write or another.
function readSettings() { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {}; } catch { return {}; } }
function writeSettings(obj) { fs.mkdirSync(PERSIST, { recursive: true }); atomicWriteJson(fs, SETTINGS_FILE, obj); }
ipcMain.on('settings:get', (e) => { e.returnValue = readSettings(); });
ipcMain.on('settings:set', (e, obj) => { try { const prev = readSettings(); const prevHist = prev.sessionHistory !== false; const nextHist = !(obj && obj.sessionHistory === false); writeSettings(obj && typeof obj === 'object' ? obj : {}); if (prevHist !== nextHist) { try { _pendingCkpt.clear(); } catch {} if (nextHist) { try { _seedCkpt(activeWorkspace); } catch {} } try { _pushHistoryToShare(); } catch {} } if ((prev.collabName || '') !== ((obj && obj.collabName) || '')) { try { _writeAllContexts(); } catch {} } e.returnValue = true; } catch (err) { console.error('[claudible] settings.json:', err.message); e.returnValue = false; } });   // sendSync: the renderer blocks until the file is written, so a force-kill right after savePrefs can't lose it (A2). Toggling sessionHistory clears any carried-over checkpoint ref so a post-toggle revert can't jump across the off period. A collabName rename refreshes every open tab's context.json so the injected "User" line doesn't go stale until the next respawn.
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
  } catch {}
})();
// (settings.depPath was read here but never written by any code path — vestigial forward-compat; removed. The
// live mechanism is settings.depEnv above, which the no-UAC provisioner fallback actually populates.)
// Resolve THIS app's own folder as a WSL path (C:\Users\X\claudible -> /mnt/c/Users/X/claudible) so the
// bootstrap script + runtime files work for ANY user/location — no hardcoded home. wslpath does it robustly.
const APPDIR_WSL = runner.appDirGuest();   // guest-side app dir (runner-owned; was wslpath of __dirname)
// The ONE sentence for "the script backend cannot run here" (`!APPDIR_WSL`). This identical condition used to
// reach the user as three different strings — 'WSL unavailable', 'WSL is not available', and 'WSL/GitHub backend
// is not available' — because humanError() passes any sentence through verbatim, so whichever code path you hit
// decided what you read. Names the real backend, matching detectDeps()'s `unavailable: 'wsl' | 'shell'`.
const ERR_NO_BACKEND = runner.id === 'wsl' ? 'WSL is not available' : 'the shell backend is not available';
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
// Per-SPAWN generation id: each pty generation gets its OWN runtime/tabs/<tab>-g<N>/ dir. A zombie writer from
// a killed generation (WSL-side processes survive ConPTY kills — see killtree.sh) can then never bleed its
// status.json/hooks.ndjson into the generation currently on screen; the old dir simply stops being read.
let _spawnGen = 0;
const _bootNonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);   // gen ids must be unique ACROSS runs too — a leftover main-g1 from the last launch must never collide with this launch's first gen (the startup sweep's delayed rm would hit the live dir). Full timestamp + 4 random chars: the old `.slice(-5)` wrapped every ~16.8h, so two launches COULD mint the same nonce
function nextRuntimeId(tabId) { return tabRuntimeId(tabId) + '-g' + _bootNonce + '-' + (++_spawnGen); }
// Reap a killed generation's WSL/posix-side process tree (bash session.sh + claude + children), then drop its
// runtime dir. The win runner spawns claude.exe directly under ConPTY — its kill already reaches everything.
function _killSessionTree(runtimeId) {
  if (!runtimeId || runner.id === 'win') return;   // win-native reaps its tree inside the pty facade's kill() (taskkill /T — R22); this WSL-side script has nothing to reach there
  try {
    // detach: this also runs on the quit path, where the reap must survive app.quit() (enforced now, not assumed)
    runner.runScript('killtree.sh', `'${String(runtimeId)}'`, { timeout: 8000, detach: true }).then(() => {
      setTimeout(() => { try { fs.rmSync(path.join(RT, 'tabs', String(runtimeId)), { recursive: true, force: true }); } catch {} }, 250);
    });
  } catch {}
}
try { fs.mkdirSync(RT, { recursive: true }); } catch {}
// Sweep orphaned diff-action temp files from a previous run (a crash/kill between write and unlink) — M1.
try { for (const f of fs.readdirSync(RT)) if (/^diffaction-.*\.tmp$/.test(f)) { try { fs.unlinkSync(path.join(RT, f)); } catch {} } } catch {}

// ---- workspaces registry (each workspace = a directory the sessions live in) ----
// App-maintained source of truth (we NEVER blanket-scan ~/.claude/projects). The home library ALWAYS has >=1
// LOCAL workspace as the guaranteed place to open. We no longer inject the old hardcoded, undeletable 'legacy'
// "My Sessions" bucket; instead, when no local workspace exists, a REAL default Local workspace is materialized
// (renameable, relocatable, and deletable once another local exists). Persisted on the Windows FS (native read).
const WORKSPACES = path.join(PERSIST, 'workspaces.json');   // R4: survives delete-and-reclone (see PERSIST above)
const DEFAULT_LOCAL = { id: 'local-local', label: 'Local', kind: 'local', slug: 'local', createdAt: 0 };
// Guarantee a default Local workspace. Synchronous mkdir so startup always has a valid cwd; sets firstRun so the
// renderer can offer a one-time "name + locate your workspace" setup prompt. Never throws (caller wraps too).
function ensureDefaultLocal(reg) {
  if (reg.workspaces.some((w) => w.kind === 'local')) return;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  try { if (home) fs.mkdirSync(path.join(home, '.claudible', 'workspaces', 'local'), { recursive: true }); } catch {}
  reg.workspaces.unshift(Object.assign({}, DEFAULT_LOCAL));
  reg.firstRun = true;
}
function loadRegistry() {
  let reg = { activeId: '', workspaces: [] };
  try { const r = JSON.parse(fs.readFileSync(WORKSPACES, 'utf8')); if (r && typeof r === 'object') reg = r; } catch {}
  if (!Array.isArray(reg.workspaces)) reg.workspaces = [];
  // drop malformed entries AND the retired 'legacy' "My Sessions" bucket (replaced by a real default Local workspace)
  reg.workspaces = reg.workspaces.filter((w) => w && typeof w === 'object' && w.id && w.kind !== 'legacy' && w.id !== 'legacy');
  try { ensureDefaultLocal(reg); } catch (e) { console.error('[claudible] ensureDefaultLocal:', e && e.message); }
  if (!reg.workspaces.length) reg.workspaces.push(Object.assign({}, DEFAULT_LOCAL));   // belt-and-suspenders: the library is never empty
  if (!reg.activeId || !reg.workspaces.some((w) => w.id === reg.activeId))
    reg.activeId = (reg.workspaces.find((w) => w.kind === 'local') || reg.workspaces[0]).id;
  return reg;
}
// Atomic (tmp+rename) so a crash mid-write can't leave a TORN workspaces.json — a corrupt file made
// loadRegistry silently rebuild from scratch, losing permissionMode/effort/the whole library. Returns
// whether the write actually landed so settings-like callers (permissionMode:set) can tell the user
// instead of reporting success for a change that will vanish on relaunch.
function saveRegistry() {
  try { atomicWriteJson(fs, WORKSPACES, registry); return true; }
  catch (e) { console.error('[claudible] workspaces.json:', e.message); return false; }
}
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
// ASYNC on purpose. This used to be execFileSync('powershell.exe', …) on the Electron MAIN process: starting
// PowerShell and reading two registry values takes hundreds of ms (more on a loaded machine), and for that entire
// time every IPC call, every pty's I/O, and all five pollers are frozen. It ran right after the System-check
// wizard's "Install" button — precisely when several Claude sessions are usually mid-turn. Its one caller is
// already an async handler, so awaiting costs nothing.
function refreshWindowsPath() {
  if (process.platform !== 'win32') return Promise.resolve();
  const addLocalBins = () => {
    const home = app.getPath('home');
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    for (const bin of [path.join(roaming, 'npm'), path.join(local, 'Microsoft', 'WinGet', 'Links'), path.join(home, '.local', 'bin')]) {
      if (!String(process.env.PATH || '').split(path.delimiter).includes(bin)) process.env.PATH = bin + path.delimiter + (process.env.PATH || '');
    }
  };
  return new Promise((resolve) => {
    require('child_process').execFile('powershell.exe',
      ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 },
      (err, out) => {
        if (err) console.error('[claudible] refreshWindowsPath:', err.message);   // a stale PATH is survivable; a silent one is not debuggable
        else { const merged = String(out).trim(); if (merged) process.env.PATH = merged + path.delimiter + (process.env.PATH || ''); }
        addLocalBins();   // never needed PowerShell — apply it whether or not the registry read worked
        resolve();
      });
  });
}

function voiceProvisioned() {
  const v = process.env.CLAUDIBLE_VOICE || path.join(app.getPath('home'), '.claudible', 'voice');   // same root setup-win.ps1 writes to (else re-provisions forever)
  // Models are size-checked, not merely present: an interrupted download leaves a truncated file that a bare
  // existsSync reports 'provisioned' FOREVER — voice silently broken with no retry and no signal. 100MB floor
  // clears both real models (whisper ~140MB, kokoro ~327MB) with margin; setup-win.ps1 wipes+retries the rest.
  const bigEnough = (p) => { try { return fs.statSync(p).size > 100 * 1024 * 1024; } catch { return false; } };
  try {
    return fs.existsSync(path.join(v, 'whisper', 'Release', 'whisper-server.exe'))
        && bigEnough(path.join(v, 'whisper', 'models', 'ggml-base.bin'))
        && bigEnough(path.join(v, 'kokoro', 'api', 'src', 'models', 'v1_0', 'kokoro-v1_0.pth'));
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
  const home = app.getPath('home');
  // ON-DISK lock, not just the in-memory flag: an app crash/force-kill orphans a still-running setup-win.ps1
  // (Windows children outlive their parent), and the relaunch's fresh `provisioning=false` used to spawn a
  // SECOND instance racing the survivor's Remove-Item -Recurse resets over the same voice tree. The lock file
  // carries the child PID; a live PID defers to the survivor, a dead one is a stale lock we take over.
  const lockFile = path.join(home, '.claudible', 'voice-provision.lock');
  try {
    const pid = parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10);
    if (Number.isFinite(pid) && pid > 0) {
      try { process.kill(pid, 0); return false; }   // signal 0 = liveness probe — an orphaned installer is still working; let it finish
      catch {}                                       // dead PID → stale lock from a crash → fall through and take it
    }
  } catch {}
  provisioning = true;
  const send = (phase, msg) => { try { win && win.webContents.send('provision', { dep: 'voice', phase, msg }); } catch {} };   // dep tag: the renderer routes voice events to the chip, per-dep events to the System-check rows
  let out = 'ignore'; try { fs.mkdirSync(path.join(home, '.claudible', 'logs'), { recursive: true }); out = fs.openSync(path.join(home, '.claudible', 'logs', 'provision.out'), 'a'); } catch {}
  const closeOut = () => { try { if (typeof out === 'number') fs.closeSync(out); } catch {} };   // release the log fd when the child ends
  const dropLock = () => { try { fs.rmSync(lockFile, { force: true }); } catch {} };
  const script = path.join(__dirname, 'setup', 'setup-win.ps1');   // shipped in the bundle (asar:false, setup/** included)
  send('start', 'Setting up voice for the first time — downloading models (a few hundred MB, can take several minutes)…');
  let child;
  try {
    child = require('child_process').spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, stdio: ['ignore', out, out] });
  } catch (e) { provisioning = false; closeOut(); send('error', 'Voice setup could not start: ' + e.message); startVoiceServices(); return true; }
  try { fs.writeFileSync(lockFile, String(child.pid || '')); } catch {}
  child.on('error', (e) => { provisioning = false; closeOut(); dropLock(); send('error', 'Voice setup could not start: ' + e.message); startVoiceServices(); });
  child.on('exit', (code) => {
    provisioning = false; closeOut(); dropLock();
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
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'claudible.ico' : 'icon.png'),   // window + taskbar branding (the headphones/mic guy); .ico decodes only on Windows
    // backgroundThrottling:false — the renderer runs real pollers (live presence, shared titles) whose freshness
    // collaborators depend on; Chromium's default background-timer clamp froze them the moment the window was
    // minimized, so a peer going live was invisible until the host alt-tabbed back. Main-process timers were
    // already immune (the advertise heartbeat lives in main for exactly this reason — see runPresence).
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  Menu.setApplicationMenu(null);   // no default menu → no View>Reload/Force-Reload that would re-init pollers & corrupt the hook stream
  // Removing the menu also removed the stock Ctrl+Shift+I DevTools accelerator — leaving NO way to self-diagnose
  // a "clicking X does nothing" report without being told to set CLAUDIBLE_DEBUG=1 and relaunch (nobody is).
  // Re-provide exactly that one chord (the dangerous Reload accelerators stay gone).
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && String(input.key).toUpperCase() === 'I') {
      e.preventDefault();
      try { win.webContents.isDevToolsOpened() ? win.webContents.closeDevTools() : win.webContents.openDevTools({ mode: 'detach' }); } catch {}
    }
  });
  // Grant ONLY the microphone (needed for push-to-talk); deny every other permission request.
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'media'));
  // Lock the window down: it only ever loads our local renderer. Block navigation away and any
  // attempt to open new windows — defense-in-depth for distributed Electron software.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // Discovery was a one-shot boot event, so a repo you accept an invite to AFTER launch never appeared until a
  // restart (the "I accepted on GitHub but it's not in my projects" report). Re-run it when the window regains
  // focus — throttled, since focus fires constantly, and DECOUPLED from syncAllEnabled (a discovery pass must not
  // drag a full re-sync of every workspace with it; the adaptive poll already handles syncing).
  win.on('focus', maybeDiscoverOnFocus);
  win.on('focus', checkBuildDrift);   // cheap event-driven catch — same idiom as discovery above (drift most often lands while you were away)
  // Optional diagnostics (opt-in): launch with CLAUDIBLE_DEBUG=1 to capture the renderer console + crashes
  // to .claudible-debug.log and auto-open DevTools. OFF by default, so nothing pops up in normal use.
  const DEBUG = !!process.env.CLAUDIBLE_DEBUG;
  if (DEBUG) {
    const dbgLog = app.isPackaged ? path.join(RT, 'debug.log') : path.join(__dirname, '.claudible-debug.log');   // writable root when installed; dev path unchanged
    const dbg = (s) => { try { fs.appendFileSync(dbgLog, new Date().toISOString() + ' ' + s + '\n'); } catch {} };
    try { fs.writeFileSync(dbgLog, new Date().toISOString() + ' [start] Claudible launched\n'); } catch {}
    win.webContents.on('console-message', (o) => {   // Electron 36+ passes ONE event object {level,message,lineNumber,sourceId}; the pre-35 positional (event,level,message,line,source) signature was removed in 36, and package.json pins electron 42 — so the old positional branch was dead.
      const M = { debug: 0, verbose: 0, info: 1, log: 1, warning: 2, warn: 2, error: 3 };
      const e = o || {};
      const lvl = (M[e.level] != null) ? M[e.level] : 1;
      const msg = (e.message != null) ? e.message : '';
      const src = (e.sourceId || '') + ':' + (e.lineNumber || '');
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
    pollStatus(); pollHooks(); pollAgentTokens(); pollContextHeartbeat();
    // spawn-on-size fallback: if the renderer never reports a size, seed the first tab ('main') at a default
    setTimeout(() => { if (ptys.size === 0) spawnPty('main', 120, 32, activeWorkspace, ''); }, 1800);
    startPoll();            // adaptive background session sync for the active repo workspace
    startBeacon();          // remote-head fast poll — near-instant "peer went live"/"new session" visibility
    appTimers.buildDrift = setInterval(checkBuildDrift, 5 * 60 * 1000);   // install-vs-running drift chip (git-clone installs have no other update signal)
    if (appTimers.buildDrift.unref) appTimers.buildDrift.unref();
    _liveTiming('boot: sha=' + (BUILD.short || 'unknown') + ' pid=' + process.pid);   // every future journal report identifies its own build
    startWorkflowPoll();    // live workflow/swarm agents for the foreground tab's Agents pane
    // Discover repos we've been invited to, then sync everything already enabled (background, post-launch).
    setTimeout(() => { _lastDiscover = Date.now(); discoverWorkspaces().then(syncAllEnabled); }, 3000);
    // Bound ~/.claudible/trash. Deleting a session moves a transcript there; deleting a PROJECT moves the whole
    // folder there (an adopted repo, node_modules and all). Nothing ever emptied it, so it grew without limit.
    // Well after boot, off the critical path, and failure is logged rather than swallowed.
    appTimers.trash = setTimeout(() => pruneTrash(), 12000);   // tracked so window-all-closed's sweep cancels it — a quit inside the first 12s must not spawn trash-prune.sh post-shutdown
  });
}
// Age- + size-bounded sweep of the soft-delete trash. Fire-and-forget: a failure must never block the app, but it
// must not be invisible either (a silently-failing prune is how the directory grew to gigabytes in the first place).
function pruneTrash() {
  if (!APPDIR_WSL) return;
  runner.runScript('trash-prune.sh', '', { timeout: 120000 }).then(({ err, stdout }) => {
    if (err) return console.error('[claudible] trash-prune:', err.message);
    let r = {}; try { r = JSON.parse(String(stdout).trim() || '{}'); } catch {}
    if (r.ok === false) return console.error('[claudible] trash-prune refused:', r.error);
    if (r.removed) console.log(`[claudible] trash: pruned ${r.removed} item(s), freed ${Math.round((r.freedKb || 0) / 1024)}MB, ${Math.round((r.remainingKb || 0) / 1024)}MB left`);
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
  if (liveTabs.has(tabId)) return;   // never bind a local pty to a joined live tab's id (invariant: a tabId is EITHER in ptys OR in liveTabs, never both)
  const pty = runner.ptyInfo();
  if (ptys.has(tabId) || !pty.mod) {
    if (!pty.mod) winSend('pty:data', { tabId, data: `\r\n[claudible] node-pty unavailable (${pty.err})\r\n` });
    return;
  }
  // Claude not installed/on PATH? Spawning it just crashes to "session ended" (cmd: 'claude' is not recognized).
  // Don't spawn a doomed pty — show a friendly line and pop the Connect Claude flow. (win runner only; wsl/posix
  // claude lives in the guest and their setups are already provisioned, so claudePresent is undefined there.)
  if (typeof runner.claudePresent === 'function' && runner.claudePresent() === false) {
    winSend('pty:data', { tabId, data: '\r\n[claudible] Claude Code isn’t connected yet — click the Claude button (top bar) to install it and sign in.\r\n' });
    try { win && win.webContents.send('claude:needed'); } catch {}
    return;
  }
  ws = ws || activeWorkspace;
  try {
    const runtimeId = nextRuntimeId(tabId);
    // One honest line per spawn: the mode this session was ASKED to run with and where it came from — the
    // first thing to check when "bypass is on in settings but the session prompts". (A foreign session is
    // still sandboxed downstream regardless; session.sh / win.js print that override into the terminal.)
    console.log('[claudible] spawn tab=' + tabId + ' ws=' + ((ws && (ws.slug || ws.id)) || 'default')
      + ' permission-mode=' + (registry.permissionMode || 'default') + ' (from workspaces.json registry)');
    const proc = runner.spawnClaude(tabId, { cols, rows, session, ws, effort: registry.effort, permMode: registry.permissionMode, runtimeId, modelStrategy: modelStrategyNow() });
    if (!proc) {   // node-pty failed to load/build — on Linux this is almost always a missing C toolchain. Tell the user how to fix it instead of a bare error.
      const hint = process.platform === 'linux' ? '\r\n  On Linux node-pty builds from source — install: sudo apt install build-essential python3   (then: npm rebuild)\r\n' : '';
      winSend('pty:data', { tabId, data: `\r\n[claudible] terminal backend (node-pty) unavailable: ${pty.err}\r\n${hint}` }); return;
    }
    // Win-runner parity with session.sh's foreign notice: the wsl/posix bootstrap echoes "opening a
    // collaborator's session…" into the terminal itself; claude.exe is spawned directly (no wrapping shell),
    // so the runner flags the decision and main injects the same line — the sandbox override must never be silent.
    if (proc.claudibleForeign) winSend('pty:data', { tabId, data: "[claudible] opening a collaborator's session — Claude will ask before running tools.\r\n" });
    const rec = { proc, cols: cols || 120, rows: rows || 32, trustDone: false, ws, session: session || '',
      runtimeId, busy: false, busyTimer: null, lastData: Date.now(), sawData: false, ultraDone: false, ultraTimer: null };
    ptys.set(tabId, rec);
    _writeContext(tabId);                                 // seed this tab's identity/live-state file before Claude's first prompt fires the context hook
    _seedCkpt(ws);                                        // repo ws + history on → snapshot now so even the FIRST prompt gets a Revert target
    if (registry.effort === 'ultracode') armUltracode(tabId, proc);   // switch the new session into ultracode mode once it settles
    if (!fgTabId) fgTabId = tabId;                         // first tab becomes the foreground/mirrored one
    if (share.status().running && !sharedTabId) { sharedTabId = tabId; try { winSend('share:pinned', { tabId }); } catch {} }   // share started before any pty existed → the first tab becomes the shared one
    if (tabId === mirrorTabId()) { share.resetRing(); share.resetStatus(); share.setSize(rec.cols, rec.rows); }   // only the mirrored (shared-or-foreground) tab drives the guest mirror
    // Handlers are guarded by `ptys.get(tabId)?.proc === proc` so a soon-to-die OLD pty (during a session
    // switch on this tab) can't stomp the NEW one's stream — the map entry is replaced/deleted before kill.
    proc.onData(d => {
      if (ptys.get(tabId)?.proc !== proc) return;
      winSend('pty:data', { tabId, data: d });
      if (tabId === mirrorTabId()) share.broadcast(d);     // tee ONLY the mirrored tab's stream to guests — pinned while sharing, so the host's other tabs never leak
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
      // If claude vanished (uninstalled, or a first-launch spawn that beat detection), point at the fix instead
      // of leaving a dead pane. Cheap sync check; win runner only.
      if (typeof runner.claudePresent === 'function' && runner.claudePresent() === false) {
        winSend('pty:data', { tabId, data: '[claudible] Claude Code isn’t connected — click the Claude button to set it up.\r\n' });
        try { win && win.webContents.send('claude:needed'); } catch {}
      }
      if (tabId === mirrorTabId()) { share.broadcast(msg); share.resetRing(); }
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
  const lw = mirrorWs();                                   // "live" = the SHARED tab's workspace while pinned, not wherever the host is browsing
  return registry.workspaces.filter((w) => w.shared)
    .map((w) => ({ id: w.id, label: w.label, kind: w.kind, live: !!lw && w.id === lw.id }));
}
// Push the current grant state to guests: pause the mirror when the live workspace isn't streamable,
// and refresh the visible library. No-op when not sharing.
function syncShare() {
  if (!share.status().running) return;
  try { share.setPaused(!isShareable(mirrorWs())); } catch {}   // pause tracks the SHARED tab's workspace, so the host focusing a private tab can't pause (or unpause) the mirror
  try { share.setWorkspaces(grantedList()); } catch {}
  try { _pushHistoryToShare(); } catch {}                  // guests' Session-History feed follows the live workspace (share start / foreground / ws switches all route through here)
}
// History over the live channel (SESSION-HISTORY.md chose live-channel over git): push the ACTIVE workspace's
// log to guests — a full snapshot on syncShare transitions, per-entry increments on append/stat-stamp. Gated
// exactly like the terminal mirror: only a shareable workspace's history leaves the machine, and the server
// clears its cache while paused (same privacy rule as scrollback/status).
function _pushHistoryToShare() {
  if (!share.status().running) return;
  const ws = mirrorWs();                                   // guests' history feed follows the SHARED tab's workspace, not the host's browsing
  if (ws && ws.id && isShareable(ws) && _histEnabled()) share.pushHistory(_histStore.load(fs, _histFile(ws.id)));
  else share.pushHistory([]);
}
function _pushHistoryEntryToShare(wsId, entry) {
  try {
    if (!share.status().running || !entry) return;
    const ws = mirrorWs();
    if (ws && ws.id === wsId && isShareable(ws) && _histEnabled()) share.pushHistoryEntry(entry);
  } catch {}
}
// Switch a tab's terminal to a chosen session ('new' | <session-id> | '' = resume latest). Kills that
// tab's current pty (its guarded handlers go quiet, since the map entry is deleted BEFORE the kill) and
// respawns it with the selection. Only foreground-tab switches touch the guest mirror.
function respawnPty(tabId, session, opts) {
  if (liveTabs.has(tabId)) return false;                    // a joined live tab is a client WebSocket, never a local pty — never spawn/kill a pty on its id (the hijack defense, mirrors setForegroundTab's guard)
  const rec = ptys.get(tabId);
  // BUSY GUARD (opt-in): main's rec.busy is authoritative (set by the hook poller), so a user session-switch
  // never kills a mid-turn Claude even when the renderer's own busy flag is still stale from the poll latency.
  // The caller opens the target session in a NEW background tab instead, leaving this one running.
  if (opts && opts.guardBusy && rec && rec.busy) return false;
  // THE LIVE SESSION IS NOT COLLATERAL. The pinned tab (sharedTabId) IS the conversation guests are watching.
  // Re-pointing it at a different session respawns its pty — `old.kill()` below — so the shared conversation
  // simply ENDS. The previous guard paused the mirror first (no foreign bytes leaked, which was its job) and
  // then killed the session anyway: guests kept a socket to a frozen, dead terminal. Indistinguishable from
  // "the host ended the live session", which is exactly what the host did not do.
  //
  // So: REFUSE. A live session ends when the host ends it — never as a side effect of the host navigating.
  // Callers open the destination somewhere else (the renderer opens a new tab; workspace:open leaves the tab
  // where it is). Every caller already treats `false` as "the tab kept its session".
  //
  // opts.trustedReroute: the caller IS the share's own machinery (a guest switching to another GRANTED
  // workspace, or Claude restarting on the SAME conversation for a re-login). Those legitimately pass
  // session:'' and must not be mistaken for the host re-pointing the mirror at a private conversation.
  // opts.endShare: the shared tab's own workspace is being deleted. The share genuinely cannot survive that,
  // so the reroute proceeds — with the mirror paused and its ring wiped first, and the renderer told to end
  // the share for real (workspace:delete sends share:force-end).
  const trusted = !!(opts && opts.trustedReroute);
  const endShare = !!(opts && opts.endShare);
  const sharing = (() => { try { return !!share.status().running; } catch { return false; } })();
  const onPinned = sharing && !!sharedTabId && tabId === sharedTabId;
  // A post-sync reload respawns the SAME session, so it is never a "move" and never blocked.
  const movesShared = !trusted && onPinned && !!rec && rec.session !== (session || '');
  // Refuse BEFORE setGenBusy: this tab keeps running its turn, so its sync gate must stay closed. (Same reason
  // the busy guard above returns before it.)
  if (movesShared && !endShare) {
    try { winSend('share:reroute-refused', { tabId, from: rec.session || '', to: session || '' }); } catch {}
    console.log('[claudible] refused to re-point the live-shared tab off its session — the share stays alive');
    return false;
  }
  setGenBusy(tabId, false);                                 // a switch ends any in-flight turn for sync gating
  const cols = (rec && rec.cols) || 120, rows = (rec && rec.rows) || 32, ws = (rec && rec.ws) || activeWorkspace;
  // The share is being torn down along with its workspace (the only reroute of the pinned tab we allow). Freeze the
  // mirror before the new pty can emit a byte, and keep it frozen: both the workspace-granular pause below and
  // syncShare() re-derive from the FALLBACK workspace, which would happily UN-pause and stream a project the guests
  // were never granted. Keyed on the PINNED tab, not on movesShared — a manual web-share pins whatever tab was in
  // the foreground, and that tab's session can be '' (resume-latest), which makes movesShared false.
  const freezeMirror = onPinned && endShare;
  if (freezeMirror) { try { share.setPaused(true); share.resetRing(); share.resetStatus(); } catch {} }
  if (tabId === mirrorTabId()) {
    // Set paused BEFORE the new pty can emit a byte, so a private workspace's output never reaches a guest.
    // (The freeze above is authoritative — never un-pause it here on the way back in.)
    try { if (share.status().running && !freezeMirror) share.setPaused(!isShareable(ws)); } catch {}
  }
  const old = rec && rec.proc;
  if (rec && rec.reloadTimer) { try { clearTimeout(rec.reloadTimer); } catch {} rec.reloadTimer = null; }   // a pending post-sync reload for the OLD generation dies with it (the new pty re-reads the transcript anyway)
  ptys.delete(tabId);                                       // drop the entry first → the old handlers' guard goes quiet
  if (old) { try { old.kill(); } catch {} }
  if (rec) _killSessionTree(rec.runtimeId);                 // the ConPTY kill never reaches the WSL side — reap the old generation's bash/claude tree
  // Each generation writes to its OWN runtime dir now (nextRuntimeId), so clearing the poller cursors is both
  // safe (the new file starts empty — nothing to replay) and required (stale offsets belong to the old gen's file).
  hookState.delete(tabId); lastStatusByTab.delete(tabId);
  spawnPty(tabId, cols, rows, ws, session);
  // syncShare re-derives pause from isShareable(mirrorWs()) — which would UNPAUSE the freeze above. Skip it there:
  // the mirror stays frozen until the renderer's share:force-end drops the tunnel for real.
  if (tabId === mirrorTabId() && !freezeMirror) syncShare();   // refresh the granted library (live flag) for guests
  return true;
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
  // While a live session is PINNED, the host switching focus is a purely local act: the mirror, its ring, its
  // pause state, its size, and guest input routing all stay welded to sharedTabId. Touching any of it here is
  // exactly the "guests watch me everywhere" leak. Un-pinned (share off), the plumbing follows focus so the
  // replay ring is warm for whichever tab a future share starts on.
  if (!sharedTabId) {
    try { share.resetRing(); share.resetStatus(); } catch {}                        // drop the previous tab's replay/tracker
    // Only (re)evaluate the mirror pause when we actually KNOW this tab's workspace — pausing on an unknown ws would
    // wrongly treat it as private and wipe the ring. If the pty hasn't spawned yet, spawnPty wires the mirror on spawn.
    if (ws) { try { if (share.status().running) share.setPaused(!isShareable(ws)); } catch {} }
    if (rec) { try { share.setSize(rec.cols, rec.rows); } catch {} }
    syncShare();
    // Foreground changed → guest input now targets a different pty; any pending typist tag belonged to the
    // OLD foreground's in-flight typing and must not attribute a prompt submitted after the switch.
    try { for (const r of ptys.values()) { r.lastInputBy = null; r.typistWrittenTs = 0; } } catch {}
  }
  _writeAllContexts();                                    // foreground (and maybe active workspace) changed → refresh every tab's context
}
// The session the renderer recorded as genuinely active for a workspace (settings.lastSession[wsId], written
// from onStatus when the pty itself reports the id). Used ONLY as the last resort below.
function rememberedSessionFor(ws) {
  if (!ws || !ws.id) return '';
  const m = readSettings().lastSession;
  const id = (m && typeof m === 'object') ? m[ws.id] : null;
  return (typeof id === 'string' && /^[A-Za-z0-9-]+$/.test(id)) ? id : '';
}
ipcMain.on('pty:start', (e, { tabId, cols, rows }) => {
  const intent = tabIntent.get(tabId); tabIntent.delete(tabId);
  const rec = ptys.get(tabId);
  const ws = (rec && rec.ws) || (intent && intent.ws) || activeWorkspace;
  // Falling through to '' let wsl/session.sh guess, and every signal available to it is polluted: the
  // transcript's mtime moves when a sessions-sync pull rewrites a conversation nobody opened, and the
  // .claudible-used stamp is written by the auto-open ITSELF — so whatever it picked once kept re-picking
  // itself at every boot (measured: two stamps 3s apart, both written during one boot). Only the renderer
  // knows which session was actually being worked in, so prefer its record and leave the script's heuristics
  // as the fallback for a first run.
  spawnPty(tabId, cols, rows, ws, (rec && rec.session) || (intent && intent.session) || rememberedSessionFor(ws) || '');
});
ipcMain.on('pty:input', (e, { tabId, data }) => {
  const t = ptys.get(tabId);
  if (!t) return;
  t.lastKeyTs = Date.now();   // "user is typing here" signal — a pending post-sync reload defers rather than destroying their composer draft
  // A HOST keystroke ends any pending guest attribution: last typist wins. One context write per
  // guest→host transition (t.lastInputBy is only ever set while a guest was typing), so this stays cold.
  if (t.lastInputBy) { t.lastInputBy = null; t.typistWrittenTs = 0; try { _writeContext(tabId); } catch {} }
  // The host typing into the SHARED session → label those keystrokes for guests (their typist chip).
  // Only the mirrored tab — typing in a private tab emits nothing (matches the byte-mirror privacy rule).
  if (tabId === mirrorTabId()) {
    const now = Date.now();
    if (now - _typHostTs > 1000) {
      _typHostTs = now;
      try { const st = share.status(); if (st.running) share.broadcastTypist(st.hostName); } catch {}
    }
  }
  try { t.proc.write(data); } catch {}
});
ipcMain.on('pty:resize', (e, { tabId, cols, rows }) => {
  const t = ptys.get(tabId); if (!t) return;
  t.cols = cols || t.cols; t.rows = rows || t.rows;
  try { t.proc.resize(t.cols, t.rows); } catch {}
  if (tabId === mirrorTabId()) share.setSize(t.cols, t.rows);   // keep guests' xterm matched to the MIRRORED pty size
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
  if (rec && rec.reloadTimer) { try { clearTimeout(rec.reloadTimer); } catch {} rec.reloadTimer = null; }   // parity with the other per-tab timers — no orphaned post-sync reload timer
  ptys.delete(tabId); hookState.delete(tabId); lastStatusByTab.delete(tabId); tabIntent.delete(tabId);
  if (rec) { try { rec.proc.kill(); } catch {} }
  if (rec) _killSessionTree(rec.runtimeId);                            // reap the WSL-side tree too (ConPTY kill stops at the Windows boundary)
  liveDisconnect(tabId);                                               // also drop a joined live socket if this was a live tab
  // The SHARED tab closed mid-share. This is the OTHER way a live pty dies — respawnPty's refusal can't see it,
  // because closing a tab doesn't respawn anything. Pausing alone left a zombie: the tunnel up, the host's UI still
  // claiming "live", and guests staring at a frozen mirror of a process that no longer exists. Keep the pin on the
  // dead id (never fall back to the host's private foreground) and tell the renderer to end the share for real.
  if (sharedTabId === tabId) {
    _liveTiming('share: FORCE-END — the pinned tab (' + tabId + ') was closed; the live link dies with it');
    try { share.setPaused(true); share.resetRing(); share.resetStatus(); } catch {}
    stopAdvertising();                                                 // stop re-stamping + clear presence NOW, not after the renderer round-trip (else the heartbeat keeps advertising an ended session for seconds)
    try { winSend('share:force-end', { reason: 'tab-closed' }); } catch {}
  }
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
  let sock; try { sock = new LiveSocket(wsUrl, { maxPayload: 512 * 1024 }); } catch (err) { return liveSend(tabId, 'live:state', { state: 'offline' }); }   // cap incoming frames: a hostile advertised session could otherwise flood ~100MB frames (ws default) and freeze the joiner's whole app
  r.ws = sock; sock.binaryType = 'nodebuffer';
  let gotHello = false;
  sock.on('open', () => { r.retry = 0; liveSend(tabId, 'live:state', { state: 'connecting' }); });
  sock.on('message', (data, isBinary) => {
    if (isBinary) { try { win && win.webContents.send('live:data', { tabId, data }); } catch {} return; }   // raw terminal bytes
    let m = null; try { m = JSON.parse(data.toString()); } catch {} if (!m) return;
    switch (m.type) {
      case 'hello': {
        gotHello = true; r.pid = m.pid || null; r.readOnly = !!m.readOnly;
        r.retry = 0; r.coldTries = 0; r.resumeFails = 0;   // R14: a successful admit resets EVERY reconnect counter — they used to accumulate for the tab's lifetime, so enough brief blips across an evening permanently killed the mirror
        r.hostCols = m.cols || r.hostCols || 120; r.hostRows = m.rows || r.hostRows || 32;
        if (m.resume) r.resume = m.resume;
        if (m.you) r.name = String(m.you).slice(0, 40);   // adopt the name the host assigned (may be disambiguated); so if a later IP-roam reconnect falls back to the link (no grace record to restore), our ?n= re-sends the unique name instead of the stale original
        // Surface host/guest BUILD SKEW instead of letting a protocol drift fail as an undiagnosable generic
        // connect error (the known cross-machine join failure mode is exactly "both sides must be on the same
        // build"). Untrusted remote string → sanitized + length-capped before it can reach the renderer.
        const hv = String(m.appVersion || '').replace(/[^0-9A-Za-z.\-]/g, '').slice(0, 20);
        const skew = (hv && hv !== app.getVersion()) ? { host: hv, mine: app.getVersion() } : null;
        liveSend(tabId, 'live:hello', { readOnly: r.readOnly, cols: r.hostCols, rows: r.hostRows, host: m.host, you: m.you, pid: r.pid, paused: !!m.paused, voice: Array.isArray(m.voice) ? m.voice : [], skew });
        break;
      }
      case 'status': liveSend(tabId, 'live:status', { status: m.status || {} }); break;
      case 'size': r.hostCols = m.cols || r.hostCols; r.hostRows = m.rows || r.hostRows; liveSend(tabId, 'live:size', { cols: r.hostCols, rows: r.hostRows }); break;
      case 'paused': liveSend(tabId, 'live:paused', { paused: !!m.paused }); break;
      case 'chat': liveSend(tabId, 'live:chat', { role: m.role, name: m.name, text: m.text }); break;
      case 'roster': liveSend(tabId, 'live:roster', { list: Array.isArray(m.list) ? m.list : [] }); break;
      case 'typist': liveSend(tabId, 'live:typist', { name: String(m.name || '').slice(0, 40) }); break;   // someone (host or another guest) is typing in the session we joined
      case 'voice-members': liveSend(tabId, 'live:voice-members', { members: Array.isArray(m.members) ? m.members : [] }); break;
      case 'audio': liveSend(tabId, 'live:audio', { from: m.from, data: m.data, sr: m.sr }); break;
      case 'pending': liveSend(tabId, 'live:state', { state: 'pending' }); break;
      case 'denied': r.closed = true; liveSend(tabId, 'live:state', { state: 'denied', reason: m.reason || '' }); break;
      // Session-History over the live channel: the host pushes its active workspace's log (full snapshot on
      // join/transition, per-entry increments after). Held in-memory on the liveTab (a joined tab is an
      // ephemeral mirror — nothing durable) and normalized through makeEntry so a skewed/hostile host can't
      // hand the renderer an unexpected shape. View-only: entries from a peer are NEVER revert targets here.
      case 'history': {
        const list = Array.isArray(m.entries) ? m.entries.slice(-200) : [];
        r.history = list.map((x) => _hist.makeEntry(Object.assign({}, x, { prompt: String((x && x.prompt) || '').slice(0, 8000) })));
        liveSend(tabId, 'live:history', { entries: r.history });
        break;
      }
      case 'history-entry': {
        if (m.entry && typeof m.entry === 'object' && m.entry.id) {
          const en = _hist.makeEntry(Object.assign({}, m.entry, { prompt: String(m.entry.prompt || '').slice(0, 8000) }));
          r.history = _hist.mergeLogs(r.history || [], [en]);   // by-id union — an updated entry (Stop-time file stats) replaces itself
          liveSend(tabId, 'live:history', { entries: r.history });
        }
        break;
      }
      default: break;   // workspaces / ws-sessions / ws-transcript / rtc: unused by the native joined tab
    }
  });
  sock.on('close', (code) => {
    r.ws = null; if (r.closed) return;
    if (code === 4001) {   // superseded: this tab's resume token reconnected on a NEWER socket (another join of the same session) — that one owns the identity now; retrying would evict it back and flap between the two
      r.closed = true; liveTabs.delete(tabId);
      liveSend(tabId, 'live:state', { state: 'offline' });
      return;
    }
    // A close with NO hello this attempt = we were not admitted. If we were presenting a resume token (?r=), it's
    // probably stale (host restarted / revoked it) — after 2 such failures, DROP it so the next dial uses the link
    // token (?t=) and re-requests approval, instead of looping forever on a dead resume token.
    if (!gotHello && r.resume) { r.resumeFails = (r.resumeFails || 0) + 1; if (r.resumeFails >= 2) { r.resume = null; r.resumeFails = 0; } }
    else if (gotHello) { r.resumeFails = 0; }
    const warm = gotHello || r.resume;                     // admitted this attempt, or still holding a not-yet-exhausted resume token
    if (!warm) {
      r.coldTries = (r.coldTries || 0) + 1;
      if (r.coldTries > 8) {
        // R14: this was a PERMANENT give-up (bare return, no timer) — and with the counters never resetting,
        // the 9th cold dial EVER ended the mirror with no rejoin affordance anywhere. Now: go quiet (offline
        // row) but keep a slow 30s lifeline dialing the handle — the moment the host's tunnel answers again
        // (same url+token), hello resets every counter above and the mirror comes back on its own. A dead
        // handle costs one fast failed dial per 30s; a RE-shared session (new handle) re-arms via the
        // renderer's Join/↻ path instead.
        liveSend(tabId, 'live:state', { state: 'offline' });
        r.retryTimer = setTimeout(() => openLiveSocket(tabId), 30000);
        if (r.retryTimer.unref) r.retryTimer.unref();
        return;
      }
    }   // cold: host tunnel slow to come up OR we just fell back resume→link — try a few times before the lifeline
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
  if (/^https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com$/i.test(url)) return true;
  // Loopback is valid ONLY for an explicit same-machine dev test. A 127.0.0.1/localhost handle is never reachable
  // by a REMOTE peer — accepting it in production is exactly what let a tunnel-less host advertise a URL that guests
  // then dialed against their OWN loopback (connect-to-nothing → "unavailable", no host prompt). Gate it.
  if (process.env.CLAUDIBLE_DEV_LOCAL && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) return true;
  return false;
}
function liveConnect(tabId, peer, name) {
  const url = String((peer && peer.url) || '');
  const tok = String((peer && peer.token) || '').replace(/[^A-Za-z0-9._~-]/g, '');
  const okUrl = isTunnelUrl(url);
  try { console.log('[live] connect', JSON.stringify({ url, hasToken: !!tok, okUrl })); } catch {}   // DIAGNOSTIC: a join that fails here (okUrl=false or empty token) means the advertised handle was unusable — usually a stale/dead tunnel or a host↔guest build skew. Logs the exact URL the guest received so the trigger is visible at runtime.
  if (!okUrl || !tok) return { ok: false, error: 'bad handle' };
  liveDisconnect(tabId);                                  // replace any prior socket bound to this tab
  liveTabs.set(tabId, { ws: null, url, token: tok, name: String(name || '').slice(0, 40), hostCols: 120, hostRows: 32, pid: null, readOnly: false, resume: null, retry: 0, closed: false, peer });
  openLiveSocket(tabId);
  return { ok: true };   // a joined tab has no local Claude to inject into — nothing to write here (see _liveStateFor)
}
function liveDisconnect(tabId) {
  const r = liveTabs.get(tabId); if (!r) return;
  r.closed = true; try { r.retryTimer && clearTimeout(r.retryTimer); } catch {} try { r.ws && r.ws.close(); } catch {}   // stop any in-flight reconnect too
  liveTabs.delete(tabId);
}
ipcMain.handle('live:connect', (e, { tabId, peer, name } = {}) => liveConnect(tabId, peer, name));
ipcMain.handle('live:disconnect', (e, { tabId } = {}) => { liveDisconnect(tabId); return { ok: true }; });
ipcMain.on('live:input', (e, { tabId, data } = {}) => liveForward(tabId, 'input', { data: String(data == null ? '' : data) }));   // a keystroke → the peer's foreground pty
ipcMain.on('live:paste', (e, { tabId, data } = {}) => liveForward(tabId, 'paste', { data: String(data == null ? '' : data) }));   // native-guest paste rides the SAME typed frame as browser-guest paste — the host's onPaste sanitizes + bracket-wraps it (raw text on the keystroke channel would dodge sanitizePaste)
ipcMain.on('live:chat-send', (e, { tabId, text } = {}) => liveForward(tabId, 'chat', { text: String(text == null ? '' : text).slice(0, 2000) }));
ipcMain.on('live:voice', (e, { tabId, join } = {}) => liveForward(tabId, join ? 'voice-join' : 'voice-leave', {}));
ipcMain.on('live:audio-send', (e, { tabId, data, sr } = {}) => liveForward(tabId, 'audio', { data, sr }));

// ---- live terminal sharing (local server + cloudflared tunnel) ----
let shareStartInFlight = null;                            // single-flight lock: a 2nd concurrent start must NOT spawn a 2nd tunnel

// A tunnel can die mid-share (network blip, killed process) or never come up at share-start (no binary → the
// loopback fallback below). Both used to stay silently degraded forever — the old exit-handler comment even
// promised a self-heal helper that was never written. This is it, named armTunnelRetry/adoptTunnel on purpose:
// the RENDERER has an unrelated tunnel function of its own, and a shared name is how a dangling promise goes
// unnoticed. Presence needs no help here — the advertise heartbeat already skips beats until isTunnelUrl()
// passes, so it re-publishes the moment a retry lands (plus one immediate beat from adoptTunnel).
function armTunnelRetry(delayMs) {
  if (appTimers.tunnelRetry || cloudflaredProc) return;    // already waiting / already up — never double or reset a pending retry
  const ms = delayMs == null ? 45000 : delayMs;
  const t = setTimeout(attemptTunnelRetry, ms);
  if (t.unref) t.unref();
  appTimers.tunnelRetry = t;
  _liveTiming('share: tunnel retry armed +' + ms + 'ms');
}
function disarmTunnelRetry() { if (appTimers.tunnelRetry) { clearTimeout(appTimers.tunnelRetry); appTimers.tunnelRetry = null; } }
// Right-now variant for the one moment waiting would be silly: a cloudflared install just finished and its env
// is already applied (preflight:install), so the very next candidates() read can see it — skip the 45s cadence.
function kickTunnelRetryNow() { disarmTunnelRetry(); attemptTunnelRetry(); }
async function attemptTunnelRetry() {
  appTimers.tunnelRetry = null;                            // this firing consumed its arm (or was kicked)
  const st0 = share.status();
  if (!st0.running || shareStartInFlight || cloudflaredProc) {   // not hosting, or a manual (re)start owns the spawn
    _liveTiming('share: tunnel retry skipped (running=' + !!st0.running + ' startInFlight=' + !!shareStartInFlight + ' haveProc=' + !!cloudflaredProc + ')');
    return;
  }
  _liveTiming('share: tunnel retry firing on port ' + st0.port);
  let r;
  try { r = await startCloudflared(st0.port); }
  catch (e) { _liveTiming('share: tunnel retry FAILED — ' + ((e && e.message) || e)); console.error('[claudible] tunnel retry:', (e && e.message) || e); armTunnelRetry(); return; }   // still down → next beat
  // The await was multi-second — re-validate against a world that may have moved. `running` alone is NOT enough:
  // a stop + fresh start can BOTH land inside that window, leaving running=true but on a NEW port — this tunnel
  // would point at a dead origin. The retry deliberately does not hold shareStartInFlight (a manual restart must
  // never queue behind a background attempt), which is exactly what opens that gap; the port check closes it.
  const st1 = share.status();
  if (!st1.running || st1.port !== st0.port || shareStartInFlight || cloudflaredProc) { _liveTiming('share: tunnel retry landed but the world moved — discarding'); try { r.proc.kill(); } catch {} return; }
  adoptTunnel(r.proc, r.url, r.verify);
}
// ONE adopt path for a share:start launch and a background retry — pid file, exit handler, context refresh and
// the tunnel-up signal live here exactly once, so the two paths can never drift apart.
function adoptTunnel(proc, url, verify) {
  disarmTunnelRetry();                                     // a live tunnel invalidates any pending retry
  cloudflaredProc = proc; shareBaseUrl = url;
  _writeCfPid(proc.pid);                                   // record the tunnel pid so a crash-orphan can be reaped on next launch
  _liveTiming('share: tunnel UP pid=' + proc.pid + ' ' + url
    + (verify ? (verify.skipped ? ' [verify skipped by env]'
        : ' verified in ' + verify.ms + 'ms (dns +' + verify.dnsMs + 'ms, ' + verify.tries + ' probe(s))'
          + (verify.localDns === false ? ' — LOCAL DNS STALE: ' + verify.why : ', HTTP ' + verify.status))
      : ' [unverified — no verify result]'));
  cloudflaredProc.on('exit', (code, signal) => {
    const unexpected = share.status().running;             // still "sharing" at exit ⇒ the tunnel dropped on its own (network/crash), not a clean host-stop
    // The one line whose absence cost four wrong diagnoses. `unexpected` reads false for a HOST-driven stop only
    // because stopLiveSharing() flips running=false synchronously before this event fires — so "expected" here
    // means "something in this process asked for it", and the trigger is named by whichever of the callers below
    // logged just before us. An UNEXPECTED exit is cloudflared itself dying; the code/signal says how.
    _liveTiming('share: cloudflared EXIT code=' + code + ' signal=' + signal + ' — '
      + (unexpected ? 'UNEXPECTED (tunnel dropped on its own; self-heal arming)' : 'expected (this process stopped the share)'));
    cloudflaredProc = null; shareBaseUrl = null; _clearCfPid();
    if (unexpected) {
      // The advertised live/<author>.json still points at the now-dead tunnel URL; pull it off the branch
      // immediately so guests don't dial a dead handle (→ synchronous 'bad handle', no host prompt). Do NOT
      // stopAdvertiseHeartbeat — its guard skips dead-URL beats and re-publishes automatically once the retry
      // armed below lands a fresh URL.
      if (advertisedSid) runPresence('presence-clear', () => {}, advertisedWs);   // clear on the advertised ws (not the current active one)
      winSend('share:tunnel-down', {});                    // tell the host their public link is dead so guests aren't met with a silent refusal
      armTunnelRetry();                                    // the self-heal the old comment only promised
    }
  });
  presenceBeatOnce();                                      // advertising? publish the fresh handle NOW — recovery is bounded by the tunnel, not tunnel + next heartbeat
  _writeAllContexts();
  try { winSend('share:tunnel-up', { url: url + '/?t=' + share.status().token, localDns: !(verify && verify.localDns === false) }); } catch {}   // renderer: refresh the link, drop the "local only" warning
}

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
      sharedTabId = fgTabId;                              // PIN: the tab being viewed at start IS the live session; the host is free to roam afterwards
      try { winSend('share:pinned', { tabId: sharedTabId }); } catch {}   // renderer mirrors THIS tab's tracker to guests from now on
      const fr0 = ptys.get(sharedTabId) || fgRec(); share.setSize(fr0 ? fr0.cols : 120, fr0 ? fr0.rows : 32);
      syncShare();                                        // tell guests the granted library + pause if the live ws is private
      let base = `http://127.0.0.1:${port}`, remote = false, note = null, localDns = true;
      try {
        try { cloudflaredProc && cloudflaredProc.kill(); } catch {}   // defensive: never leave a prior tunnel orphaned
        cloudflaredProc = null;
        const { proc, url, verify } = await startCloudflared(port);
        if (!share.status().running) { _liveTiming('share: start — stopped mid-spawn, reaping the tunnel'); try { proc.kill(); } catch {} return { ok: false, error: 'stopped during start' }; }   // a share:stop landed while we were spawning → reap the tunnel, don't orphan a live public URL
        adoptTunnel(proc, url, verify);                   // pid file + exit handler + tunnel-up signal — single adopt path, shared with the background retry
        base = url; remote = true;                       // public link
        localDns = !(verify && verify.localDns === false);   // verified good for guests, but THIS machine can't resolve it (stale negative cache) — the host must be told, or they'll believe the link is broken and stop sharing
      } catch (tunErr) {   // tunnel down (or unprovable) → fall back to localhost/LAN, and keep trying in the background
        note = String(tunErr.message || tunErr);
        _liveTiming('share: tunnel FAILED — ' + note + ' → local-only link');
        armTunnelRetry(10000);                            // a failed VERIFY often just means a young edge route; re-dial soon, then fall back to the 45s cadence
      }
      shareBaseUrl = base;
      const st = share.status();
      _writeAllContexts();                                // now hosting → tell the model (the fg tab's context flips to "hosting")
      return { ok: true, url: `${base}/?t=${token}`, localUrl: `http://127.0.0.1:${port}/?t=${token}`, remote, note, localDns, readOnly: st.readOnly };
    } catch (err) { return { ok: false, error: String(err.message || err) }; }
  })();
  shareStartInFlight.finally(() => { shareStartInFlight = null; });   // release the lock once this start settles
  return shareStartInFlight;
});
ipcMain.handle('share:stop', async () => {
  _liveTiming('share: STOP via share:stop IPC (renderer asked to end the share)');   // the only in-process path that kills BOTH the origin server and the tunnel — name it, or a post-mortem can't tell it from a crash
  try { cloudflaredProc && cloudflaredProc.kill(); } catch {}
  cloudflaredProc = null; shareBaseUrl = null;
  // Presence must be cleared on the workspace we ACTUALLY advertised on, captured before the heartbeat teardown
  // nulls it — that ordering (and the whole teardown) lives in stopLiveSharing(), shared with the quit path.
  stopLiveSharing();
  sharedTabId = null;                                    // UN-PIN: no live session → the idle mirror plumbing follows focus again
  try { winSend('share:pinned', { tabId: null }); } catch {}
  _lastRoster = [];
  _writeAllContexts();                                   // sharing ended → the hosting tab's context drops the "hosting" block (back to solo)
  return { ok: true };
});
ipcMain.handle('share:newlink', () => {                 // mint a fresh one-time link (re-invite)
  if (!share.status().running || !shareBaseUrl) return { ok: false, error: 'not sharing' };
  const t = share.regenerateLink();
  return { ok: true, url: `${shareBaseUrl}/?t=${t}` };
});
ipcMain.handle('share:kick', (e, arg) => { try { return { ok: !!share.kickGuest(arg && arg.name) }; } catch { return { ok: false }; } });   // host removes one guest by name
// Host's verdict on a pending guest. `ok:false` means the request was already gone (the guest gave up, timed out,
// or a second click raced the first) — not that the verdict was refused. Shaped like every other channel.
ipcMain.handle('share:approve', (e, arg) => ({ ok: share.decideApproval(arg && arg.id, !!(arg && arg.ok)) }));

// ---- Live sessions: advertise the session I'm hosting (presence on the shared branch) so a collaborator in
// the same workspace can JOIN it natively — no link to paste. Joins run through liveConnect (a client
// WebSocket mirrored into a cockpit tab), so it's "through Claudible", not an external browser. ----
// R10: ONE serialization chain per workspace for every sessions-branch operation. syncLock only ever guarded
// doSync against itself — presence beats (every 45s while hosting), delete-everywhere, resolveDiverged and
// title-set all ran the same script CONCURRENTLY against the same branch, and pull_branch's fetch+reset
// --hard could discard another op's just-committed work while both reported ok (how a delete-everywhere
// tombstone could silently vanish). Reads ride the same chain too (presence-list/title-list also pull).
// Keyed by ws.id — different projects stay fully parallel.
const _syncQ = makeKeyedQueue();
// Presence-only lane: presence ops are worktree-FREE plumbing commits (~1-1.5s, see sessions-sync.sh) that
// take no index lock and merge nothing — safe to run beside any transcript sync, but they must stay strictly
// ordered among THEMSELVES (a clear must never overtake the set it follows, or a "stopped sharing" resurrects
// as a zombie advertisement). A separate keyed queue gives exactly that: FIFO per workspace, zero contention
// with _syncQ — the queue-wait behind multi-second syncs was the observed 2.5-3.9s go-live stamp variance.
const _presQ = makeKeyedQueue();
const _beatArgs = new Map();   // ws.id -> the args of a queued-but-not-started presence beat (coalescing)
function runPresence(args, cb, ws, opts) {
  if (!APPDIR_WSL) return cb && cb(null);
  const w = ws || activeWorkspace;   // presence lifecycle pins to the advertised ws (else a workspace switch clears/stamps the WRONG repo's branch)
  const exec = () => runner.runScript('sessions-sync.sh', `${args}`, { ws: w, timeout: 45000, detach: !!(opts && opts.detach), onSpawn: opts && opts.onSpawn, extraEnv: (opts && opts.extraEnv) || '' }).then(({ err, stdout }) => {
      if (err) return cb && cb(null);
      let r = null; try { r = JSON.parse((stdout || '').trim() || '{}'); } catch {}
      cb && cb(r);
    });
  // QUIT path (R7): the detached one-shot must never sit behind a queue that dies with the process.
  // DIRECT path: the beacon's skip-fetch presence read — a lock-free object-store read (no worktree, no
  // fetch, no merge; see presence-list's skip-fetch branch) that must never wait behind a RUNNING sync;
  // front-of-queue only helps against WAITING work, so a queue slot is not enough for it.
  if (opts && (opts.detach || opts.direct)) { exec(); return; }
  const key = (w && w.id) || 'ws';
  // Presence ops ride their own lane (_presQ): worktree-free plumbing that never waits behind a transcript
  // sync yet stays strictly ordered among itself. Title ops still touch the worktree — they stay on _syncQ.
  const lane = /^presence-/.test(args) ? _presQ : _syncQ;
  // Heartbeat COALESCING: a queued-but-not-started beat stamps its ts at RUN time, so it is exactly as fresh
  // as this one — piling beats up would only burn presence commits. Coalesce ONLY on byte-identical args: a
  // re-share mints a new url/token, and dropping THAT beat would advertise a stale handle.
  if (/^presence-set /.test(args)) {
    if (_beatArgs.get(key) === args) return;
    _beatArgs.set(key, args);
    lane.run(key, () => { if (_beatArgs.get(key) === args) _beatArgs.delete(key); return exec(); });
    return;
  }
  lane.run(key, exec);
}
// Keep my presence fresh while I'm hosting. Peers age out an advertisement after LIVE_TTL (120s), so a still-live
// host must re-stamp its ts well within that. The timer lives in MAIN on purpose — renderer timers get throttled
// when the window is backgrounded, which is exactly when we must NOT silently go stale. Each beat is one tiny
// presence-set commit; a 45s cadence (vs the old 120s) means a CRASHED host — the only case a clean presence-clear
// can't cover — stops showing as "live" within ~120s instead of ~5 min, at the cost of a bit more git presence
// traffic. A clean End/quit clears instantly regardless (stopAdvertising, with retry), so the TTL only governs crashes.
// advertisedWs = the workspace we advertised ON (its live/<login>.json lives on THAT repo's sessions branch). Pinned
// here so a later presence-set/clear targets it even after the user switches the cockpit to another workspace — else
// the clear runs against the new active ws (nothing there) and the OLD ws stays "live" until its ~2-min TTL expires.
let _quitClearAck = null;   // resolves once the quit-path presence-clear has actually reached the OS
let advertiseTimer = null, advertisedSid = null, advertisedNameB64 = '', advertisedWs = null;
function stopAdvertiseHeartbeat() {
  if (advertiseTimer) { clearInterval(advertiseTimer); advertiseTimer = null; }
  advertisedSid = null; advertisedWs = null;
  if (_presFailStreak) { _presFailStreak = 0; try { winSend('live:presence-health', { ok: true }); } catch {} }   // no longer hosting → any standing "presence failing" chip is stale
}
// Pull our live/<login>.json off the branch, RETRYING until it lands. presence-clear's own script already retries
// its git push 3x internally, but if a transient outage spans all three (a network blip exactly at End-live), it
// returns {ok:false} and — before this — nothing re-attempted, because the heartbeat that might have is already
// stopped. The stale entry then sat on the branch and peers saw us "live" until the TTL: the exact reported bug.
// Bounded (a genuinely-offline host can't push at all — the peer TTL is the final backstop for that case).
function clearPresenceWithRetry(ws, attempt) {
  if (!ws) return;
  attempt = attempt || 0;
  const t0 = Date.now();
  runPresence('presence-clear', (r) => {
    _liveTiming(`end: presence-clear ${r && r.ok ? 'landed' : 'FAILED(' + ((r && r.error) || 'no result') + ')'} attempt ${attempt + 1} +${Date.now() - t0}ms`);
    if (r && r.ok) return;                                         // landed on the branch → done
    if (attempt >= 5) { console.error('[live] presence-clear did not land after retries — peers fall back to the', 120, 's TTL'); return; }
    const t = setTimeout(() => clearPresenceWithRetry(ws, attempt + 1), 2000 * (attempt + 1));   // 2s,4s,6s,8s,10s
    if (t.unref) t.unref();
  }, ws);
}
// Stop re-stamping presence AND pull our live/<login>.json off the branch. The load-bearing part is the ordering:
// capture advertisedWs/advertisedSid BEFORE stopAdvertiseHeartbeat() nulls them, or the clear runs with ws=null —
// clearing the wrong (or no) repo and leaving us "live" on the branch (the "MK still sees me after I quit" bug).
// test/live-teardown.test.js executes THIS function and fails if the capture is reordered. Extracted so every end
// path (the End button, quit, closing the shared tab, deleting the shared workspace) tears presence down the SAME
// way instead of the copies drifting. Idempotent: a second call after advertisedSid is null does nothing.
function stopAdvertising(opts) {
  const advWs = advertisedWs, advSid = advertisedSid, wasAdvertising = !!advertisedSid;   // capture BEFORE stopAdvertiseHeartbeat nulls them
  if (wasAdvertising) _relayPub(advWs, { type: 'end', session: advSid });   // realtime "ended" — peers drop the row in <1s; the git clear below remains the record
  stopAdvertiseHeartbeat();                                       // no longer hosting → stop re-stamping presence
  if (!wasAdvertising) return;
  // QUITTING: the retry loop is a mirage on this path — its backoff timers are unref'd (a dying process never
  // fires them) and a non-detached child can be killed WITH the app before its push lands, so the clear silently
  // never happened and peers saw us "live" until the 120s TTL (the exact bug the quit-path comment claimed was
  // fixed). A detached one-shot survives app exit — the same guarantee the pty reaper relies on — and the
  // script's own 3 internal push retries absorb transient blips.
  if (opts && opts.quitting) {
    // Return a promise the caller can await: resolved once the OS confirms the detached child exists, or after
    // a hard 2s cap so a wedged spawn can never block shutdown. update:run MUST await this — it follows
    // teardownForExit() with app.exit(0), a hard kill, so before this the clear was fired into a process that
    // died microseconds later and the entry stayed on the branch. window-all-closed was fine only because
    // app.quit() happens to yield to the event loop first; that was luck, not design.
    _quitClearAck = new Promise((res) => {
      let done = false;
      const fin = (how) => { if (done) return; done = true; _liveTiming('end: quitting — presence-clear ' + how); res(); };
      const t = setTimeout(() => fin('spawn NOT confirmed within 2s (entry may survive on the branch)'), 2000);
      if (t.unref) t.unref();
      runPresence('presence-clear', null, advWs, { detach: true, onSpawn: () => { clearTimeout(t); fin('spawned'); } });
    });
  }
  else clearPresenceWithRetry(advWs);                             // app alive → observable, retrying clear (2s..10s backoff)
}
// THE full live-hosting teardown: presence down (above) + share server down. Called from share:stop (the button)
// and window-all-closed (quit). The two OTHER end paths — closing the shared tab, deleting the shared workspace —
// call stopAdvertising() directly too (they used to only freeze the local mirror and lean on an async renderer
// round-trip to eventually reach here, during which share.status().running stayed true and the heartbeat kept
// RE-STAMPING presence — so an "ended" session could keep advertising itself for seconds).
// (presence-clear's spawned wsl.exe outlives app exit — the same guarantee the pty reaper relies on.)
function stopLiveSharing(opts) {
  disarmTunnelRetry();                                   // an explicit stop ends the self-heal too — a post-stop retry firing would spawn an orphan tunnel
  stopAdvertising(opts);                                 // opts.quitting → detached presence-clear (see above)
  share.stop();
}
// One presence beat, callable outside the interval too: adoptTunnel() fires it the instant a recovered tunnel
// is adopted, so peers see the fresh handle in tunnel-time — not tunnel-time + up to a full 45s cadence.
// PRESENCE HEALTH. A presence push that fails while the UI says "Sharing live" used to be completely silent:
// the beat only ever branched on 'already-live', so a dead network / revoked gh token / rate limit left the host
// believing they were joinable while no peer ever saw them — the same user-visible shape as the long-running
// "MK can't see my live session" saga. One failure is a blip (the beat retries it once, below); a SECOND
// consecutive failure is a condition the host needs to know about, so it raises a standing chip in the share
// dock. Recovery lowers it. Threshold 2 keeps a single transient push from flapping a warning on screen.
let _presFailStreak = 0;
function _notePresenceHealth(ok, err) {
  if (ok) {
    if (_presFailStreak) { _presFailStreak = 0; try { winSend('live:presence-health', { ok: true }); } catch {} }
    return;
  }
  _presFailStreak++;
  if (_presFailStreak >= 2) { try { winSend('live:presence-health', { ok: false, error: String(err || 'push failed'), streak: _presFailStreak }); } catch {} }
}
function presenceBeatOnce(isRetry) {
  const st = share.status();
  if (!advertisedSid || !st.running || !st.token || !isTunnelUrl(shareBaseUrl)) return;   // not hosting OR no real tunnel yet → skip the beat (never publish a loopback/dead handle); the next beat self-heals once the tunnel URL is up
  const sid = advertisedSid, ws = advertisedWs;   // pin: a session switch mid-flight must not retry against the NEW sid
  _relayPub(advertisedWs, { type: 'live', session: advertisedSid, url: shareBaseUrl, token: st.token, name: _advNamePlain(), sha: BUILD.short });   // keeps late relay joiners current
  runPresence(`presence-set '${shq(advertisedSid)}' '${shq(shareBaseUrl)}' '${shq(st.token)}' '${shq(advertisedNameB64)}' '${shq(BUILD.short)}'`, (r) => {
    _liveTiming(`heartbeat: stamp ${r && r.ok ? 'landed' : 'FAILED(' + ((r && r.error) || 'no result') + ')'}${isRetry ? ' [retry]' : ''}`);
    // The beat lost the claim: someone else went live on this session while our presence was stale (laptop
    // sleep past the 2-min TTL, network outage). ONE host per session — stand down instead of stamping a
    // duplicate, and tell the renderer so the UI stops saying "sharing" (it clears sharedSessionId + toasts).
    if (r && r.error === 'already-live') {
      stopAdvertiseHeartbeat();
      try { winSend('live:advertise-lost', { by: String(r.by || '') }); } catch {}
      return;                                    // a verdict, not a failure — never retried, never a health warning
    }
    if (r && r.ok) { _notePresenceHealth(true); return; }
    _notePresenceHealth(false, r && r.error);
    // ONE short retry, mirroring the phase-1 presence-starting path. Without it the next attempt was a full
    // 45s away, so a blip meant peers were blind for the better part of a minute with nothing on screen.
    if (!isRetry && advertisedSid === sid) {
      const t = setTimeout(() => { if (advertisedSid === sid && advertisedWs === ws) presenceBeatOnce(true); }, 5000);
      if (t.unref) t.unref();
    }
  }, advertisedWs);
}
function startAdvertiseHeartbeat(sid, ws) {
  advertisedSid = sid;                                   // a session switch just re-points which sid we re-stamp
  advertisedWs = ws || advertisedWs || activeWorkspace;  // remember the ws this presence belongs to (for the heartbeat + clear)
  if (advertiseTimer) return;
  advertiseTimer = setInterval(presenceBeatOnce, 45000);   // re-stamp cadence — must stay well under LIVE_TTL (120s) so a live host never ages out between beats
  if (advertiseTimer.unref) advertiseTimer.unref();
}
ipcMain.handle('live:advertise', (e, payload) => new Promise((resolve) => {
  const sid = String((payload && payload.sessionId) || '').replace(/[^A-Za-z0-9-]/g, '');
  const st = share.status();
  if (!sid || !st.running || !st.token) return resolve({ ok: false, error: 'not live' });
  advertisedNameB64 = Buffer.from(String((payload && payload.name) || '')).toString('base64');   // chosen display name → presence (badge/roster)
  // The SHARED session's project, named by the renderer — NOT main's ambient activeWorkspace, which follows
  // the foreground tab and can legitimately be a different (or non-repo) project while the share streams on.
  // Guessing here silently refused every presence write when the host was focused on a local project.
  const ws = _wsById(payload && payload.wsId) || activeWorkspace;   // pinned so a later switch can't misdirect the clear
  // NEVER publish a non-tunnel (loopback/dead) URL to remote peers — they'd dial their own machine. If the tunnel
  // isn't up yet, arm the heartbeat anyway so presence is pushed the instant a real *.trycloudflare.com URL appears,
  // and tell the caller so the host can be warned their share isn't remotely reachable.
  const tAdv = Date.now();
  _liveTiming(`advertise: received sid=${sid} tunnel=${isTunnelUrl(shareBaseUrl) ? 'up' : 'down'}`);
  if (!isTunnelUrl(shareBaseUrl)) {
    startAdvertiseHeartbeat(sid, ws);
    _relayPub(ws, { type: 'live', session: sid, starting: true, name: _advNamePlain(), sha: BUILD.short });   // realtime doorbell — the git stamp below stays the record
    // Phase-1 presence: peers should see "going live…" the moment the host clicks Share — not after the
    // tunnel's multi-second spawn. presence-starting stamps a url-less claim (same one-host arbiter as the
    // full advertisement); presenceBeatOnce replaces it with the real handle the instant adoptTunnel lands.
    // A rival already holding the claim surfaces exactly like a beat-time loss (renderer un-shares + toasts).
    runPresence(`presence-starting '${shq(sid)}' '${shq(advertisedNameB64)}' '${shq(BUILD.short)}'`, (r) => {
      _liveTiming(`advertise: starting stamp ${r && r.ok ? 'landed' : 'FAILED(' + ((r && r.error) || 'no result') + ')'} +${Date.now() - tAdv}ms`);
      // ONE outer retry on a transient failure: the stamp is one-shot (the heartbeat only re-sends the FULL
      // handle once the tunnel lands), so a blip here used to leave peers blind until tunnel-time. A refusal
      // (already-live) is a verdict, never retried.
      if (!(r && r.ok) && !(r && r.error === 'already-live') && advertisedSid === sid) {
        const t = setTimeout(() => { if (advertisedSid === sid && !isTunnelUrl(shareBaseUrl)) runPresence(`presence-starting '${shq(sid)}' '${shq(advertisedNameB64)}' '${shq(BUILD.short)}'`, (r2) => _liveTiming(`advertise: starting stamp retry ${r2 && r2.ok ? 'landed' : 'failed'}`), ws); }, 2500);
        if (t.unref) t.unref();
      }
      if (r && r.error === 'already-live') {
        stopAdvertiseHeartbeat();
        try { winSend('live:advertise-lost', { by: String(r.by || '') }); } catch {}
        return resolve(r);
      }
      // stampError distinguishes "the tunnel is merely still spawning" from "the presence push itself failed".
      // Without it the renderer showed a cloudflared/internet message for a GitHub auth or rate-limit failure,
      // sending the user to fix the wrong thing entirely.
      resolve({ ok: false, error: 'tunnel-down', starting: !!(r && r.ok), stampError: (r && r.ok) ? null : String((r && r.error) || 'push failed') });   // starting:true → the renderer skips the "can't join yet" toast (peers already see the row)
    }, ws);
    return;
  }
  _relayPub(ws, { type: 'live', session: sid, url: shareBaseUrl, token: st.token, name: _advNamePlain(), sha: BUILD.short });
  runPresence(`presence-set '${shq(sid)}' '${shq(shareBaseUrl)}' '${shq(st.token)}' '${shq(advertisedNameB64)}' '${shq(BUILD.short)}'`, (r) => {
    _liveTiming(`advertise: full stamp ${r && r.ok ? 'landed' : 'FAILED(' + ((r && r.error) || 'no result') + ')'} +${Date.now() - tAdv}ms`);
    if (r && r.error === 'already-live') return resolve(r);   // a collaborator already hosts this session — do NOT arm the heartbeat (it would keep re-contesting the claim every 2 min); the renderer un-shares + points the user at Join
    // A failed FIRST full stamp is the same silent hole as a failed beat: the heartbeat still arms and the UI
    // still says "Sharing live". Seed the health tracker so the standing chip can appear if it keeps failing.
    _notePresenceHealth(!!(r && r.ok), r && r.error);
    startAdvertiseHeartbeat(sid, ws);
    resolve(r || { ok: false });
  }, ws);
}));
// ONE presence-teardown implementation: this is the renderer's primary "End Session"/"Stop sharing" path
// (endLiveNow → updateAdvertise), and it used to do its own SINGLE presence-clear attempt with no retry — so a
// transient outage at exactly End-live left the stale entry on the branch and peers saw "live" until the 120s
// TTL (the reported bug, fixed for share:stop by clearPresenceWithRetry but never for THIS handler). Route it
// through stopAdvertising(): same capture-before-null ordering, same bounded retry, idempotent. The renderer
// fire-and-forgets this call, so the immediate ok is honest ("teardown initiated, retrying until it lands").
ipcMain.handle('live:unadvertise', () => { stopAdvertising(); return { ok: true }; });
// Peers for the workspace the SIDEBAR shows, not whatever main is on — the same retrofit title:list already
// carries. main's activeWorkspace follows tabForeground, which a joined LIVE tab deliberately skips, so the two
// genuinely diverge. Reading ambient state here polled the wrong repo's presence branch, and one project's live
// peers got painted into another project's sidebar (the phantom "Live session" row).
// REJECTS on a failed read (script error / exec timeout): resolving [] there made a transient blip
// indistinguishable from an authoritative "nobody is live" — the renderer then ERASED known-good rows.
// Its catch branch (keep the last-known bucket) existed for exactly this and was dead code until now.
ipcMain.handle('live:peers', (e, wsId) => new Promise((resolve, reject) => { runPresence('presence-list', (r) => {
  if (!r || r.ok === false || !Array.isArray(r.peers)) return reject(new Error('presence read failed'));
  resolve(r.peers);
}, _wsById(wsId) || activeWorkspace); }));
// Shared session names: publish my rename to meta/<login>.json on the branch; read the merged (last-writer-wins)
// map back. The name goes out-of-band as base64 so arbitrary text can never break the shell command.
ipcMain.handle('title:set', (e, { id, name, wsId }) => new Promise((resolve) => {
  const sid = String(id || '').replace(/[^A-Za-z0-9-]/g, '');
  if (!sid) return resolve({ ok: false });
  const b64 = Buffer.from(String(name == null ? '' : name)).toString('base64');
  runPresence(`title-set '${sid}' '${b64}'`, (r) => resolve(r || { ok: false }), _wsById(wsId) || activeWorkspace);   // the RENAMED row's workspace — while a joined live tab is on screen, activeWorkspace is a different ws and the title would publish to the wrong repo's branch
}));
ipcMain.handle('title:list', (e, wsId) => new Promise((resolve) => { runPresence('title-list', (r) => resolve((r && r.titles) || {}), _wsById(wsId) || activeWorkspace); }));   // titles for the workspace the SIDEBAR shows, not whatever main is on

// ---- sessions (list / switch) ----
// There is deliberately NO ambient "list the active workspace" handler: the renderer's active workspace and
// main's can differ (a joined live tab moves the sidebar's scope but never main's), so every list names its
// workspace. sessions.sh is workspace-parameterized (runScript's { ws } sets that workspace's env for this
// call only; activeWorkspace is untouched).
ipcMain.handle('session:list-ws', (e, wsId) => new Promise((resolve) => {
  const ws = registry.workspaces.find((w) => w.id === wsId);
  if (!APPDIR_WSL || !ws) return resolve([]);
  runner.runScript('sessions.sh', '', { ws, maxBuffer: 8 * 1024 * 1024, timeout: 12000 }).then(({ err, stdout }) => {
    // A fetch FAILURE must never masquerade as an empty list: the renderer painted `[]` over a populated
    // sidebar with zero trace anywhere ("where are all my sessions"). Resolve a typed error instead — the
    // renderer keeps the last good list on screen. sessions.sh itself emits {"error":...} when its node tool
    // dies (its old `|| printf "[]"` fallback had the same masquerade baked in), which parses into the same shape.
    const fail = (why) => { console.error('[sessions] list failed for ws', wsId, String(why).slice(0, 300)); resolve({ error: String(why).slice(0, 300) }); };
    if (err) return fail((err && err.message) || 'exec');
    let parsed;
    try { parsed = JSON.parse(String(stdout).trim() || '[]'); } catch { return fail('unparseable output'); }
    if (parsed && !Array.isArray(parsed) && parsed.error) return fail(parsed.error);
    resolve(Array.isArray(parsed) ? parsed : []);
  });
}));
// Re-point an existing tab at 'new' | <session-id>. guardBusy: main refuses to kill a mid-turn Claude (ok:false → the
// renderer opens the target in a new tab, leaving this one running). openGen++ supersedes any in-flight workspace:open
// clone so its continuation can't respawn the tab AFTER this click. endShare: deleteSession is moving the pinned tab
// off the very session it's about to trash — the one session-level reroute the share cannot survive (the tunnel is
// already being torn down renderer-side). Without it, the refusal below would abort the delete with a misleading
// "that session is still running".
ipcMain.handle('session:open', (e, { tabId, id, endShare }) => { openGen++; const ok = respawnPty(tabId, id, { guardBusy: true, endShare: !!endShare }); return { ok }; });
// Soft-delete a saved session: move its transcript to ~/.claudible/trash/ (recoverable). The renderer
// switches the pty off this session BEFORE calling, so the file isn't held open by a live claude --resume.
ipcMain.handle('session:delete', (e, arg) => new Promise((resolve) => {
  const id = (typeof arg === 'string') ? arg : (arg && arg.id);
  const scope = (arg && arg.scope) || 'local';                              // 'local' (trash here) | 'everywhere' (also off GitHub)
  const ws = _wsById(arg && arg.wsId) || activeWorkspace;                   // the ROW's workspace (sidebar scope), not main's — they differ while a joined live tab is on screen
  const sid = String(id || '').replace(/[^A-Za-z0-9-]/g, '');               // mirror the script's allowlist
  if (!sid || !APPDIR_WSL) return resolve({ ok: false, error: 'bad id' });
  // timeout: execFile has NO default. Without one a hung script never resolves this IPC call — and the renderer's
  // deleteSession holds its `deletingIds` entry across the await, so that row could never be deleted or retried
  // again for the life of the app, with no error shown. (Same for session-keep.sh and `skills.sh set` below.)
  runner.runScript('delete-session.sh', `'${sid}'`, { ws, timeout: 30000 }).then(({ err, stdout }) => {
      if (err) { console.error('[claudible] delete-session:', err.message); return resolve({ ok: false, error: 'exec' }); }
      let local = {}; try { local = JSON.parse((stdout || '').trim() || '{}'); } catch {}
      if (scope !== 'everywhere') return resolve(local.ok ? local : { ok: true });
      // also tombstone it on the shared sessions branch so a sync can never bring it back (for anyone)
      // R10: through the per-ws chain — racing a background sync could reset --hard the tombstone commit away
      _syncQ.run((ws && ws.id) || 'ws', () => runner.runScript('sessions-sync.sh', `delete '${sid}'`, { ws, timeout: 45000 })).then(({ err: err2, stdout: out2 }) => {
          if (err2) { console.error('[claudible] delete-session everywhere:', err2.message); return resolve({ ok: false, error: 'exec', localDone: true }); }
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
  runner.runScript('session-keep.sh', `'${sid}'`, { ws: _wsById(arg && arg.wsId) || activeWorkspace, timeout: 30000 }).then(({ err, stdout }) => {
      if (err) { console.error('[claudible] session-keep:', err.message); return resolve({ ok: false, error: 'exec' }); }
      let r = {}; try { r = JSON.parse((stdout || '').trim() || '{}'); } catch {}
      resolve(r.ok ? r : { ok: false, error: (r.error || 'keep failed') });
    });
}));
// Resolve an "out of sync" (forked) session — 'remote' = take the shared copy (collaborator's, via the safe
// import_file path), 'local' = keep mine (clears the flag + acks it so a background sync stops re-nagging).
// The session the live mirror is welded to — the conversation guests are actually watching. Derived from the
// PINNED tab (not the advertised id alone), so a manual web-share with no `sharedSessionId` is covered too.
function liveSessionId() {
  if (!sharedTabId) return '';
  try { if (!share.status().running) return ''; } catch { return ''; }
  const r = ptys.get(sharedTabId);
  return (r && r.session) || '';
}
ipcMain.handle('session:resolveDiverged', (e, arg) => new Promise((resolve) => {
  const id = (typeof arg === 'string') ? arg : (arg && arg.id);
  const strategy = (arg && arg.strategy === 'local') ? 'local' : 'remote';
  const sid = String(id || '').replace(/[^A-Za-z0-9-]/g, '');               // mirror the script's allowlist
  if (!sid || !APPDIR_WSL) return resolve({ ok: false, error: 'bad id' });
  // `resolve remote` REPLACES the transcript on disk (sessions-sync.sh reuses import_file). Two states make that
  // destructive rather than helpful, and the UI hiding a button is not a guard — refuse at the call site:
  //   * the session is LIVE — its Claude is appending to that very file, and guests are watching it stream
  //   * a tab on it is MID-TURN — same file, same problem (mirrors session-delete's busy contract)
  // 'local' only clears a flag, so it stays allowed throughout.
  if (strategy === 'remote') {
    if (sid === liveSessionId()) return resolve({ ok: false, error: 'live' });
    for (const rec of ptys.values()) if (rec.session === sid && rec.busy) return resolve({ ok: false, error: 'busy' });
  }
  const rws = _wsById(arg && arg.wsId) || activeWorkspace;
  // R10: through the per-ws chain — a resolve replacing the transcript must never interleave with a sync pass
  _syncQ.run((rws && rws.id) || 'ws', () => runner.runScript('sessions-sync.sh', `resolve '${sid}' ${strategy}`, { ws: rws, timeout: 45000 })).then(({ err, stdout }) => {
      if (err) { console.error('[claudible] session:resolveDiverged:', err.message); return resolve({ ok: false, error: 'exec' }); }
      let r = {}; try { r = JSON.parse((stdout || '').trim() || '{}'); } catch {}
      // 'remote' replaced the transcript on disk — an open tab on this session must respawn to show it
      // (deferred safely if that tab is mid-turn or the user is typing). 'local' changed nothing.
      if (r.ok && strategy === 'remote') reloadChangedTabs(rws, [sid]);
      resolve(r.ok ? r : { ok: false, error: (r.error || 'resolve failed') });
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
// THE one writer of per-tab turn-busy. The renderer used to keep its OWN copy, armed by the UserPromptSubmit hook
// and disarmed ONLY by the Stop hook — so any turn that ended without a clean Stop (the pty died, the user hit esc,
// Claude Code crashed) left the sidebar row wearing a "working" flair FOREVER. That is the flair bug we chased for
// ten rounds: the flair was a faithful mirror of a tab record that was lying. Meanwhile THIS flag already had every
// clear the renderer lacked — pty exit, session switch, tab close, and the quiet-pty self-heal below — because the
// rest of the app (delete/switch/auto-sync gating) depends on it being true. So there is exactly one fix: the
// renderer stops deriving busy and MIRRORS this. Every path that clears it now tells the renderer, including heal.
function setGenBusy(tabId, v) {
  const rec = ptys.get(tabId); if (!rec) return;
  rec.busy = v;
  try { winSend('tab:busy', { tabId, busy: !!v }); } catch {}
  if (rec.busyTimer) { clearTimeout(rec.busyTimer); rec.busyTimer = null; }
  if (!v) return;
  // Self-heal a missed Stop — but only once the pty has actually gone QUIET. The old blind 30-minute timer
  // cleared rec.busy mid-turn on any legitimately long run (a big agent swarm, a slow migration), silently
  // disarming every busy-guard (delete/switch/sync) exactly when it mattered most. Now: first check at 30min,
  // and while output is still flowing (rec.lastData, fed by proc.onData) re-check every 5min instead of
  // clearing — a wedged tab with a dead Claude clears within ~30–35min, a live 3-hour turn stays protected.
  const heal = () => {
    rec.busyTimer = null;
    if (ptys.get(tabId) !== rec || !rec.busy) return;                     // tab respawned/closed or the turn ended properly
    if (Date.now() - (rec.lastData || 0) < 180000) { rec.busyTimer = setTimeout(heal, 300000); return; }   // pty spoke within 3min → still a real turn
    rec.busy = false; try { winSend('tab:busy', { tabId, busy: false }); } catch {}   // the heal must reach the sidebar too, or the flair outlives the flag it mirrors
    schedulePush(rec.ws);
  };
  rec.busyTimer = setTimeout(heal, 1800000);
}
// Is any tab bound to this workspace mid-turn? Auto-sync waits until a ws is fully quiesced before pushing.
function wsHasBusyTab(wsId) { for (const r of ptys.values()) if (r.ws && r.ws.id === wsId && r.busy) return true; return false; }

// ---- reload an OPEN tab whose transcript a sync/resolve just replaced on disk -------------------
// A tab's `claude --resume <id>` reads the .jsonl ONCE at spawn; when import_sessions/resolve overwrites
// that file, the open terminal keeps showing the stale conversation until the pty respawns (this was the
// "clicked out-of-sync but the session doesn't update until I bounce to another session and back" bug).
// So: after any sync that changed ids, respawn every affected tab in place. Two safety deferrals — never
// kill a mid-turn Claude (rec.busy), and never yank the pty while the user is actively typing a prompt
// (rec.lastKeyTs, would destroy their composer draft); both re-check every 10s until the tab quiesces.
function tryPendingReload(tabId) {
  const rec = ptys.get(tabId);
  if (!rec || !rec.pendingReload) return;
  if (rec.reloadTimer) { clearTimeout(rec.reloadTimer); rec.reloadTimer = null; }
  const typing = Date.now() - (rec.lastKeyTs || 0) < 15000;
  if (rec.busy || typing) { rec.reloadTimer = setTimeout(() => tryPendingReload(tabId), 10000); return; }
  rec.pendingReload = false;
  // Deliberately NO openGen++ here: that global counter arbitrates USER-intent opens (session:open,
  // workspace:open) — a ~30s background reload bumping it would silently abort an in-flight multi-minute
  // workspace clone ("superseded") while the renderer already flipped its state (wrong-workspace desync).
  // If an open continuation respawns this tab after us, its respawn simply wins — last writer is the user.
  respawnPty(tabId, rec.session, { guardBusy: true });
  try { win && win.webContents.send('session:reloaded', { tabId, id: rec.session }); } catch {}
}
function reloadChangedTabs(ws, ids) {
  if (!ws || !Array.isArray(ids) || !ids.length) return;
  const want = new Set(ids.filter((x) => typeof x === 'string' && x));
  for (const [tabId, rec] of ptys) {
    if (!rec.ws || rec.ws.id !== ws.id || !rec.session || !want.has(rec.session)) continue;
    rec.pendingReload = true;
    tryPendingReload(tabId);
  }
}

// op ∈ {init,pull,push,sync,status}. Resolves to the script's parsed JSON (or {ok:false,...}).
function runSync(ws, op, opts) {
  return new Promise((resolve) => {
    const o = ['init', 'pull', 'push', 'sync', 'status'].includes(op) ? op : 'status';
    if (!APPDIR_WSL || !ws || ws.kind !== 'repo') return resolve({ ok: false, error: 'not a repo workspace' });
    // The HOSTED (advertised) session is always excluded, no matter which caller got us here: the background
    // poll and every boot/toggle sync pass no `live` at all, so a hosted-but-idle-between-turns session could
    // be exported mid-share — and import could compare our own earlier snapshot against its still-changing
    // local file (falsely foreign/diverged-marking the session being live-hosted RIGHT NOW). main knows exactly
    // which session it hosts (advertisedSid); thread it centrally instead of trusting each caller to remember.
    // R13: the UNION of live writers, never a collapse. opts.live (the newest BUSY session, via liveIdNow) used
    // to SUPPRESS the advertised-session fallback through `||` — so with a second tab mid-turn in the same
    // project, a manual "Sync now" excluded that tab's session but exported the actually-HOSTED one while the
    // host's Claude was appending to it. Both ids are live writers; both are excluded (the script takes a
    // space-separated list now, each id charset-checked here before it can touch the shell line).
    const _cands = [];
    if (opts && opts.live) _cands.push(String(opts.live));
    if (advertisedSid && advertisedWs && ws.id === advertisedWs.id) _cands.push(String(advertisedSid));
    const liveRaw = [...new Set(_cands)].filter((x) => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(x)).join(' ');
    const live = liveRaw ? `CLAUDIBLE_LIVE_SESSION='${liveRaw}' ` : '';
    // R10: full syncs join the same per-ws chain as presence/delete/resolve/title — syncLock (above doSync)
    // still pre-empts a SECOND sync with an honest 'sync-busy'; this queue is the correctness net under it.
    _syncQ.run((ws && ws.id) || 'ws', () => runner.runScript('sessions-sync.sh', `'${o}'`, { ws, extraEnv: live, timeout: 120000, maxBuffer: 8 * 1024 * 1024 })).then(({ err, stdout }) => {
        if (err) { console.error('[claudible] sessions-sync', o, err.message); return resolve({ ok: false, error: 'sync could not run: ' + ((err && err.message) || err) }); }
        const raw = String(stdout).trim();
        try { resolve(JSON.parse(raw || '{}')); } catch { resolve({ ok: false, error: raw ? 'sync: ' + raw.slice(0, 300) : 'sync returned no output' }); }
      });
  });
}
// Locked, state-broadcasting sync: tells the renderer 'syncing'→'idle'/'error' (status button) and asks it
// to refresh the switcher when the active workspace gained/changed sessions. Requires sync ON + cloned.
const _syncDivSeen = new Map();   // ws.id -> last-seen diverged count, so a divergence-only sync notifies the renderer only on a real change (not every poll tick)
async function doSync(ws, op, opts) {
  if (!ws || ws.kind !== 'repo' || !ws.syncSessions || ws.needsClone) return { ok: false, error: 'sync off' };
  if (syncLock.has(ws.id)) return { ok: false, error: 'sync-busy' };   // a sync already holds this ws's lock — NOT the same 'busy' as a mid-turn Claude (see ERR note above humanError)
  syncLock.add(ws.id);
  try { win && win.webContents.send('sync:state', { id: ws.id, status: 'syncing' }); } catch {}
  const r = await runSync(ws, op, opts);
  syncLock.delete(ws.id);
  // Only pull/sync report a `diverged` count; a plain 'push' has no such field. Treating its absence as 0 wiped
  // the real baseline (push runs constantly via schedulePush), so the NEXT sync saw 0→N and fired a spurious
  // "changed" every time. Only update the baseline when this op actually measured divergence.
  const reportsDiv = r && typeof r.diverged === 'number';
  const divPrev = _syncDivSeen.get(ws.id) || 0;
  const divNow = reportsDiv ? r.diverged : divPrev;
  if (reportsDiv) _syncDivSeen.set(ws.id, divNow);
  const changed = !!(r && (r.imported || r.updated || r.pushed)) || (divNow !== divPrev);   // a divergence-only sync must notify too — but only when the fork set CHANGES (divNow is recomputed every tick, so a raw OR would refresh forever)
  // A clone that no longer exists on disk can never sync again and used to error forever behind a
  // color-only dot. Reroute it into the UI's existing "invited — click to clone" state (needsClone), which
  // also ends its beacon chain (_beaconQualifies excludes needsClone). ensureClone clears the flag on
  // success, exactly like a fresh invite.
  if (r && r.error === 'repo workspace not found' && !ws.needsClone) { ws.needsClone = true; saveRegistry(); try { win && win.webContents.send('workspace:list-changed', {}); } catch {} }
  try { win && win.webContents.send('sync:state', { id: ws.id, status: r && r.ok ? 'idle' : 'error', synced: r && r.synced, diverged: r && r.diverged }); } catch {}
  if (changed) { try { win && win.webContents.send('sync:changed', { id: ws.id, ids: (r && r.ids) || [] }); } catch {} }   // renderer refreshes only if it's the shown workspace
  reloadChangedTabs(ws, r && r.ids);   // an OPEN tab on an imported/updated session shows stale turns until its pty respawns — do it now, not on the next manual session bounce
  return r;
}
// Only needed to SKIP the live session during a MANUAL sync mid-turn; auto-syncs already wait out a busy
// workspace entirely (wsHasBusyTab), so they never push a mid-write transcript and need no live skip.
function liveIdNow() {
  if (!activeWorkspace || !wsHasBusyTab(activeWorkspace.id)) return Promise.resolve('');
  // sessions.sh lists the active workspace's conversations newest-first, so [0] is the one being written right now.
  // (This used to call a `listSessions()` that doesn't exist — every call threw and returned '', silently disabling
  // the "skip the live session during a manual mid-turn sync" guard, so a half-written transcript could be pushed.)
  if (!APPDIR_WSL) return Promise.resolve('');
  return new Promise((resolve) => {
    runner.runScript('sessions.sh', '', { ws: activeWorkspace, maxBuffer: 8 * 1024 * 1024, timeout: 12000 }).then(({ err, stdout }) => {
      // FAIL CLOSED: '' means "nothing to skip", so resolving it on a script failure silently disabled the
      // whole mid-turn guard — a half-written transcript could be pushed. null = "could not determine";
      // the caller defers the manual sync instead of guessing.
      if (err) return resolve(null);
      let a = []; try { a = JSON.parse(String(stdout).trim() || '[]'); } catch { return resolve(null); }
      if (!Array.isArray(a)) return resolve(null);            // sessions.sh's typed {"error":...} shape — the tool died
      resolve((a[0] && a[0].id) || '');
    });
  });
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
    appTimers.sync = setTimeout(tick, pollDelay);
  };
  appTimers.sync = setTimeout(tick, pollDelay);
}
// ---- remote-head beacon: near-instant peer visibility -------------------------------------------
// The adaptive poll above is the safety net; THIS is the fast path. Everything collaborators share —
// session transcripts, live presence, shared titles — rides ONE branch (claudible/sessions), so "did
// anything change anywhere?" is a single head-sha probe: sessions-sync.sh remote-head — a narrow
// fetch of just that branch (so on a change the blobs are ALREADY local for the skip-fetch presence
// read below), no worktree, no merge, no lock (safe OUTSIDE _syncQ, even mid-sync), and no GitHub API
// budget (the script answers it before its per-invocation gh-auth block). Probe every ~2.5s per
// synced repo workspace — EVERY one, not just those with an open tab, closing the "a shared project
// with no tab never syncs" hole — and only when the sha actually moves fire the pipeline: presence is
// read locally and PUSHED to the sidebar (live:peers-push), then doSync imports the new sessions
// (sync:changed repaints). Peer-visible latency for "X went live" / "new session appeared" drops from
// 10s–5min (or never) to a few seconds; a quiet branch costs one cheap negotiation per tick.
// ---- realtime presence relay (lib/presenceRelay.js + relay/worker.js) ---------------------------
// The <1s push layer over the authoritative git branch: one WS per shared repo, "went live"/"ended"
// frames fan out instantly; the polling beacon below stays the truth-carrier and fallback. Inert until
// a relay is deployed (RELAY_URL unset -> every call is a no-op).
const _relayRooms = new Map();   // 'owner/repo' -> Set(wsId): which local workspaces a room's frames paint
const _lastPeers = new Map();    // wsId -> last AUTHORITATIVE peers list pushed to the renderer (relay frames merge into this as a preview; the next beacon read overwrites wholesale)
let _relayCred = { v: null, ts: 0 };
async function _relayGetCred() {
  if (_relayCred.v && Date.now() - _relayCred.ts < 10 * 60 * 1000) return _relayCred.v;
  const ws = registry.workspaces.find((x) => x && x.kind === 'repo' && x.syncSessions && !x.needsClone);
  if (!ws) return null;
  const { err, stdout } = await runner.runScript('sessions-sync.sh', 'relay-cred', { ws, timeout: 15000 });
  if (err) return null;
  let r = null; try { r = JSON.parse(String(stdout).trim() || '{}'); } catch {}
  if (!r || !r.ok || !r.token) return null;
  _relayCred = { v: { login: String(r.login || ''), token: String(r.token) }, ts: Date.now() };
  return _relayCred.v;
}
const _relay = makePresenceRelay({
  getCred: _relayGetCred,
  log: (m) => _liveTiming(m),
  onFrame: (repoStr, frame) => {
    const me = (_relayCred.v && _relayCred.v.login) || '';
    if (me && frame.login === me) return;             // my own presence (possibly another of my machines) — the git path's self-skip, mirrored
    const ids = _relayRooms.get(repoStr);
    if (!ids || !ids.size) return;
    for (const wsId of ids) {
      const merged = mergePeerFrame(_lastPeers.get(wsId), frame);
      _lastPeers.set(wsId, merged);
      try { winSend('live:peers-push', { id: wsId, peers: merged }); } catch {}
      _liveTiming('relay: ' + frame.type + ' ' + frame.login + ' -> ' + wsId);
    }
  },
});
function _relayRepoOf(x) { return (x && x.owner) ? (x.owner + '/' + (x.repoName || x.slug)) : ''; }
// Publish alongside the git stamps — fire-and-forget, never gates them.
function _relayPub(x, frame) {
  const repo = _relayRepoOf(x);
  if (!repo) return;
  const parts = repo.split('/');
  try { _relay.publish(parts[0], parts[1], frame); } catch {}
}
function _advNamePlain() { try { return Buffer.from(advertisedNameB64 || '', 'base64').toString('utf8'); } catch { return ''; } }
const _beaconHeads = new Map();   // ws.id -> last branch head this beacon has ANNOUNCED (presence pushed) ('' = branch absent)
const _beaconDirty = new Map();   // ws.id -> head sha whose session-import (doSync) hasn't succeeded yet
const _beaconTimers = new Map();  // ws.id -> the armed setTimeout of that workspace's OWN probe chain
const _beaconLive = new Set();    // ws.ids with a probe in flight (roster scan must not double-arm them)
const _beaconErr = new Map();     // ws.id -> consecutive probe failures -> exponential backoff (a DEAD remote must not burn a spawn every tick)
// BEACON_HIDDEN_MS must stay UNDER the renderer's 10s fallback poll: the fast path losing to its own
// fallback is worse than a few extra probes from a minimized window (audited: a chain armed with a 15s wait
// while minimized kept that wait after restore — nothing re-arms mid-wait — so the poll painted first).
const BEACON_MS = 1500, BEACON_HIDDEN_MS = 8000;
// Rolling latency journal for the live-collab fast path (runtime/live-timing.log): one timestamped line per
// stage — advertise received, stamp landed, head-move detected, peers painted — so a "going live felt slow"
// report is answered with numbers instead of guesses. Size-capped; never throws.
function _liveTiming(msg) {
  try {
    const f = path.join(RT, 'live-timing.log');
    try { if (fs.statSync(f).size > 256 * 1024) fs.truncateSync(f, 0); } catch {}
    fs.appendFileSync(f, new Date().toISOString() + ' ' + msg + '\n');
  } catch {}
}
// PER-WORKSPACE probe chains, deliberately NOT one shared tick: a single slow probe — a huge fetch, a stalled
// network, above all a workspace whose remote was DELETED — must only ever slow ITS OWN workspace. The shared
// Promise.all tick this replaces made every workspace's cadence equal to the SLOWEST probe (a dead remote's
// 8s timeout stretched a healthy project's detection to ~10s — the exact field report). The probe itself is a
// bare ls-remote head check (~0.5-0.9s, no objects); the bounded fetch happens only when the head actually
// moved, on the announce path, where the data is needed.
function _beaconQualifies(id) {
  const w = registry.workspaces.find((x) => x && x.id === id);
  return (w && w.kind === 'repo' && w.syncSessions && !w.needsClone) ? w : null;
}
function _beaconArm(wsId, delay) {
  if (_quitting) return;   // teardown already swept the chains — a finally-re-arm must not resurrect one
  if (_beaconTimers.has(wsId) || _beaconLive.has(wsId)) return;
  const t = setTimeout(() => { _beaconTimers.delete(wsId); _beaconProbe(wsId); }, delay);
  if (t.unref) t.unref();
  _beaconTimers.set(wsId, t);
}
function _beaconDelay(wsId) {
  let hidden = false; try { hidden = !(win && !win.isDestroyed() && win.isVisible()); } catch {}
  const base = hidden ? BEACON_HIDDEN_MS : BEACON_MS;
  const errs = Math.min(5, _beaconErr.get(wsId) || 0);
  return Math.min(60000, base * Math.pow(2, errs));   // healthy: base cadence; failing: 2x per miss, capped at 60s; one success resets
}
async function _beaconProbe(wsId) {
  let gone = true; try { gone = !win || win.isDestroyed(); } catch {}
  if (gone) return;                                        // shutting down — a per-ws timer must not spawn against a dead window (H3)
  const ws = _beaconQualifies(wsId);
  if (!ws) { _beaconHeads.delete(wsId); _beaconDirty.delete(wsId); _beaconErr.delete(wsId); _lastPeers.delete(wsId); return; }   // sync toggled off / deleted -> chain ends; the roster scan re-arms if it comes back
  _beaconLive.add(wsId);
  try {
    const t0 = Date.now();
    const { err, stdout } = await runner.runScript('sessions-sync.sh', 'remote-head', { ws, timeout: 12000 });
    let r = null; if (!err) { try { r = JSON.parse(String(stdout).trim() || '{}'); } catch {} }
    if (!r || !r.ok || typeof r.head !== 'string') { _beaconErr.set(wsId, (_beaconErr.get(wsId) || 0) + 1); return; }
    _beaconErr.delete(wsId);
    const prev = _beaconHeads.get(wsId);
    if (prev === undefined) {
      // First sighting seeds the baseline — but the CURRENT branch state may already hold a live session
      // that went up before this app looked (fresh boot, sync just enabled). Announce that state once too:
      // the renderer's sig dedupe makes a redundant push a no-op, and without this the "already live before
      // I looked" case waited for the 10s fallback poll.
      _beaconHeads.set(wsId, r.head);
      runPresence('presence-list', (pr) => {
        if (!pr || pr.ok === false || !Array.isArray(pr.peers)) return;   // failed read ≠ empty (see the head-move site)
        const peers = reconcilePeerLists(pr.peers, _lastPeers.get(wsId));
        _lastPeers.set(wsId, peers);
        try { winSend('live:peers-push', { id: wsId, peers }); } catch {}
      }, ws, { direct: true, extraEnv: 'CLAUDIBLE_DIRECT_READ=1 ' });
      return;
    }
    if (prev !== r.head) {
      // ANNOUNCE EXACTLY ONCE per head move, baseline advances NOW (not after the sync — a busy workspace
      // used to re-fire this branch every tick). The presence read fetches JUST this branch into the code
      // clone (bounded) and reads it lock-free OUTSIDE the queue (opts.direct) — it can never wait behind a
      // running transcript sync.
      _beaconHeads.set(wsId, r.head);
      _beaconDirty.set(wsId, r.head);
      _liveTiming(`beacon: head moved ${wsId} (probe ${Date.now() - t0}ms)`);
      runPresence('presence-list', (pr) => {
        // A FAILED read must never masquerade as "nobody is live" — pushing [] here erased good rows on
        // every peer over a local blip. Skip; _beaconDirty stays owed, the next probe retries.
        if (!pr || pr.ok === false || !Array.isArray(pr.peers)) { _liveTiming(`beacon: presence read FAILED ${wsId} — push skipped`); return; }
        // Git is authoritative, but a relay frame that arrived DURING this read is newer than what git has
        // propagated yet — prefer per-login entries with a strictly newer ts (kills the 45s "flicker to
        // gone" when an unrelated branch change races a fresh relay announce).
        const peers = reconcilePeerLists(pr.peers, _lastPeers.get(wsId));
        _lastPeers.set(wsId, peers);
        try { winSend('live:peers-push', { id: wsId, peers }); } catch {}
        _liveTiming(`beacon: peers pushed ${wsId} (+${Date.now() - t0}ms)`);
      }, ws, { direct: true, extraEnv: 'CLAUDIBLE_DIRECT_READ=1 ' });
    }
    // Session import owed for the newest announced head — retried every probe until it lands, WITHOUT
    // re-announcing presence. Skipped while this ws is mid-turn/mid-sync.
    if (!_beaconDirty.has(wsId)) return;
    if (wsHasBusyTab(wsId) || syncLock.has(wsId)) return;
    const want = _beaconDirty.get(wsId);
    const res = await doSync(ws, 'sync', {});
    if (res && res.ok && _beaconDirty.get(wsId) === want) _beaconDirty.delete(wsId);   // a NEWER head may have arrived mid-sync — keep it owed
  } finally {
    _beaconLive.delete(wsId);
    _beaconArm(wsId, _beaconDelay(wsId));
  }
}
function startBeacon() {
  if (appTimers.beacon) return;
  // Light roster scan: arm a chain for every qualifying workspace that doesn't have one (new project, sync
  // toggled on, app boot). Chains end themselves when a workspace stops qualifying; this brings them back.
  const scan = () => {
    let i = 0;
    const seen = new Set();
    const want = new Map();                          // 'owner/repo' -> Set(wsId): relay rooms this roster needs
    for (const w of registry.workspaces) {
      if (!w || seen.has(w.id) || !_beaconQualifies(w.id)) continue;
      seen.add(w.id);
      _beaconArm(w.id, 300 * i++);   // small stagger so a cold boot doesn't fire every probe in the same instant
      const repo = _relayRepoOf(w);
      if (repo) { if (!want.has(repo)) want.set(repo, new Set()); want.get(repo).add(w.id); }
    }
    // Reconcile relay rooms to the roster (a no-op entirely while no relay is configured).
    for (const [repo, ids] of want) {
      if (!_relayRooms.has(repo)) { const pr = repo.split('/'); try { _relay.ensure(pr[0], pr[1]); } catch {} }
      _relayRooms.set(repo, ids);
    }
    for (const repo of [..._relayRooms.keys()]) {
      if (!want.has(repo)) { const pr = repo.split('/'); try { _relay.release(pr[0], pr[1]); } catch {} _relayRooms.delete(repo); }
    }
  };
  scan();
  appTimers.beacon = setInterval(scan, 5000);
  if (appTimers.beacon.unref) appTimers.beacon.unref();
}
// Hook events are also forwarded raw to the renderer; here we track per-tab turn busy/idle + push the tab's
// workspace after each turn. tabId comes from which per-tab hooks file the line was read from.
function handleHook(tabId, line) {
  let ev = ''; try { ev = JSON.parse(line).hook_event_name || ''; } catch {}
  if (ev === 'UserPromptSubmit') {
    setGenBusy(tabId, true);
    // Re-arm the agent-token settle latch off the ACTUAL busy edge: a turn faster than pollAgentTokens' 8s
    // cadence used to fall entirely between two ticks — no tick ever saw busy=true, agentTokSettled stayed
    // true from before the turn, and the "one more poll after idle" never ran → that turn's subagent tokens
    // were silently dropped from the meter forever.
    const r = ptys.get(tabId); if (r) r.agentTokSettled = false;
  } else if (ev === 'Stop') { setGenBusy(tabId, false); const r = ptys.get(tabId); schedulePush(r && r.ws); _snapshotOnStop(tabId); }
}
// Clone an existing (invited) repo workspace into ~/.claudible/repos/<slug> if it isn't local yet.
function ensureClone(ws) {
  if (cloneInFlight.has(ws.id)) return cloneInFlight.get(ws.id);   // a clone for this ws is already running → share it (no double gh clone into the same dir)
  const p = new Promise((resolve) => {
    if (!APPDIR_WSL) return resolve({ ok: false, error: ERR_NO_BACKEND });
    const slug = String(ws.slug || '').replace(/[^A-Za-z0-9-]/g, '');
    const owner = String(ws.owner || '').replace(/[^A-Za-z0-9-]/g, '');
    if (!slug || !owner) return resolve({ ok: false, error: 'bad workspace' });
    const wsp = safePath(ws.path);   // the invitee's chosen clone dir (else the script's default). A path that can't round-trip was never storable — but workspaces.json is hand-editable
    const dirArg = wsp ? ` '${wsp}'` : '';
    runner.runScript('clone-workspace.sh', `'${owner}' '${slug}'${dirArg}`, { timeout: 300000 }).then(({ err, stdout }) => {
        // Surface the REAL reason so a Windows-specific failure isn't swallowed as a silent re-prompt — but log the
        // full stderr and show the user only a trimmed line (raw multi-KB git stderr shouldn't flood a toast).
        if (err) { console.error('[claudible] clone-workspace failed:', (err && err.message) || err); return resolve({ ok: false, error: 'clone could not run: ' + String((err && err.message) || err).slice(0, 200) }); }
        let r = {}; try { r = JSON.parse(String(stdout).trim() || '{}'); } catch { return resolve({ ok: false, error: 'clone returned no result' + (String(stdout).trim() ? ' — ' + String(stdout).trim().slice(0, 200) : '') }); }
        if (r.ok) { if (wsp && r.path) ws.path = r.path; delete ws.needsClone; saveRegistry(); }
        resolve(r.ok ? { ok: true } : { ok: false, error: r.error || 'clone failed' });
      });
  });
  cloneInFlight.set(ws.id, p);
  p.finally(() => cloneInFlight.delete(ws.id));
  return p;
}
// Resolve ONE workspace's stable GitHub identity (numeric id + current name) and record it. GitHub's GET follows a
// rename redirect, so this works even when the name we hold is stale. Resolves true only if the registry changed.
function backfillRepoIdentity(ws) {
  return new Promise((resolve) => {
    const owner = String(ws.owner || '').replace(/[^A-Za-z0-9-]/g, '');
    const name = String(ws.repoName || ws.slug || '').replace(/[^A-Za-z0-9-]/g, '');
    if (!owner || !name) return resolve(false);
    runner.runScript('repo-identity.sh', `'${owner}' '${name}'`, { timeout: 30000 }).then(({ err, stdout }) => {
      if (err) return resolve(false);                                    // offline / gh missing → try again next pass
      let r = {}; try { r = JSON.parse(String(stdout).trim() || '{}'); } catch {}
      if (!r.ok || !Number.isFinite(r.ghId)) return resolve(false);
      ws.ghId = r.ghId;
      if (r.repoName) { ws.repoName = r.repoName; ws.repoUrl = 'https://github.com/' + owner + '/' + r.repoName; }   // slug stays FROZEN (it names the folder + every transcript)
      resolve(true);
    });
  });
}
// The keys a deleted repo workspace is tombstoned under, so discovery can never resurrect it.
//
// This used to be the single string `owner + '/' + ws.slug` — and that quietly could not work for a renamed repo.
// The in-app rename DELIBERATELY freezes ws.slug (it names ~/.claudible/repos/<slug> and, through it, every Claude
// transcript for the project) and records the new GitHub name in ws.repoName. Discovery, meanwhile, lists the repo
// under its CURRENT name. So delete wrote `owner/old-name`, discovery asked about `owner/new-name`, the strings
// never met, and the workspace the user had just deleted reappeared as a fresh "clone me" invite on the next
// launch. Deterministic — rename, then delete — not a race.
//
// So key on identity, not on a name that is allowed to change: ghId is GitHub's stable repo id and survives a
// rename. Keep the name-form key too (under the CURRENT name, which is what discovery reports) so a workspace
// whose ghId backfill never landed is still tombstoned. Deliberately NOT the stale slug: a different repo could
// later take that freed-up name, and suppressing THAT would be a fresh bug — lib/discovery.js guards the same
// hijack for the same reason.
function repoTombstoneKeys(ws) {
  const keys = [];
  if (ws && Number.isFinite(ws.ghId)) keys.push('gh:' + ws.ghId);
  const name = ws && (ws.repoName || ws.slug);
  if (ws && ws.owner && name) keys.push(ws.owner + '/' + name);
  return keys;
}
// Is a repo discovery just surfaced one the user deleted here? Matches EITHER key form.
function isRepoDismissed(registry_, owner, slug, ghId) {
  const dis = (registry_ && registry_.dismissedRepos) || [];
  if (!dis.length) return false;
  if (Number.isFinite(ghId) && dis.includes('gh:' + ghId)) return true;
  return dis.includes(owner + '/' + slug);
}

// ONE-TIME identity backfill for repo workspaces that predate stable-id storage. Without it, a repo renamed on
// GitHub OUTSIDE Claudible can never be matched by discovery (its slug, its `repo-<slug>` id and its owner+name
// are all stale) and is re-added as a phantom "clone me" duplicate on every launch — a bug that predates the
// in-app rename feature. It also self-heals a rename whose id fetch failed. Sequential + bounded by the number of
// repo workspaces, and it runs at most once each: after ghId is set, `w.ghId == null` is false forever.
// Adopted workspaces are skipped — they point at an external folder whose repo name need not match their slug.
async function backfillRepoIdentities() {
  const need = registry.workspaces.filter((w) => w.kind === 'repo' && !w.adopted && w.owner && (w.repoName || w.slug) && w.ghId == null);
  if (!need.length) return;
  let changed = false;
  for (const ws of need) { if (await backfillRepoIdentity(ws)) changed = true; }
  if (changed) saveRegistry();
}
// Find repo workspaces the user was invited to and register any new ones (sync OFF + needing clone until opened).
async function discoverWorkspaces() {
  if (!APPDIR_WSL) return { ok: false, added: [] };
  await backfillRepoIdentities();          // teach the registry who it already owns BEFORE we decide what's new
  return new Promise((resolve) => {
    runner.runScript('sessions-discover.sh', '', { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }).then(({ err, stdout }) => {
        if (err) { console.error('[claudible] discover:', err.message); return resolve({ ok: false, added: [] }); }
        let list = []; try { list = JSON.parse(String(stdout).trim() || '[]'); } catch {}
        // R31: the script now distinguishes "can't look" from "found nothing" — thread the reason through so
        // the manual Check-for-invites can tell the user WHY instead of "you're all caught up".
        if (list && !Array.isArray(list) && list.error) return resolve({ ok: false, reason: String(list.error).slice(0, 20), added: [] });
        const added = [];
        let changed = false;   // registry mutated by a backfill/reconcile even when nothing new was added
        for (const item of (Array.isArray(list) ? list : [])) {
          const slug = String(item && item.slug || '').replace(/[^A-Za-z0-9-]/g, '');   // the repo's CURRENT name
          const owner = String(item && item.owner || '').replace(/[^A-Za-z0-9-]/g, '');
          if (!slug || !owner) continue;
          const ghId = (item && Number.isFinite(item.id)) ? item.id : (/^\d+$/.test(String(item && item.id || '')) ? Number(item.id) : null);   // stable GitHub repo id (survives a rename)
          const wid = `repo-${slug}`;
          const repoUrl = (item && item.repoUrl) || ('https://github.com/' + owner + '/' + slug);
          // Find the workspace this repo already IS (rename-safe: renamed repos match ONLY by stable ghId — see
          // lib/discovery.js). Also skips a repo the user ADOPTED a working copy of (re-offering "clone me" is noise).
          const existing = findExistingWorkspace(registry.workspaces, { slug, owner, ghId, wid });
          if (existing) {
            // Backfill the stable id (so the NEXT rename is dedupe-safe) and FOLLOW a GitHub rename — never touching
            // slug (it names the local folder + every transcript). Sync keeps working via GitHub's redirect until the
            // folder's origin is next rewritten.
            const { changed: c, patch } = reconcileWorkspace(existing, { slug, owner, ghId, repoUrl });
            if (c) { Object.assign(existing, patch); changed = true; }
            continue;
          }
          if (isRepoDismissed(registry, owner, slug, ghId)) continue;   // the user DELETED this repo workspace here — discovery must not resurrect it as a fresh invite every launch. Matched by stable ghId as well as by name, so a RENAMED repo stays deleted too (deliberately re-adding it clears the tombstone).
          const ws = { id: wid, label: slug, kind: 'repo', slug, owner, repoName: slug, repoUrl, ghId: ghId != null ? ghId : undefined, createdAt: Date.now(), needsClone: true };
          registry.workspaces.push(ws); added.push(ws);
        }
        if (added.length || changed) { saveRegistry(); try { win && win.webContents.send('workspace:added', added.map((w) => ({ id: w.id, label: w.label }))); } catch {} }
        resolve({ ok: true, added });
      });
  });
}
// On launch, sync every already-enabled repo workspace once so collaborators' latest sessions land.
function syncAllEnabled() {
  for (const ws of registry.workspaces) if (ws.kind === 'repo' && ws.syncSessions && !ws.needsClone) doSync(ws, 'sync', {});
}
// Throttled focus-driven re-discovery (see win.on('focus')). One paginated GitHub call per run, so cap the rate.
let _lastDiscover = 0;
const DISCOVER_MIN_MS = 45000;
function maybeDiscoverOnFocus() {
  const now = Date.now();
  if (now - _lastDiscover < DISCOVER_MIN_MS) return;
  _lastDiscover = now;
  discoverWorkspaces().catch(() => {});   // NOT syncAllEnabled — discovery only; newly-added invites are needsClone anyway
}
// Manual "check for invites" (the New-project modal). Bypasses the focus throttle — an explicit ask always runs —
// and reports how many NEW workspaces it added so the renderer can toast a result either way.
ipcMain.handle('workspace:discover', async () => {
  _lastDiscover = Date.now();
  const r = await discoverWorkspaces();
  return { ok: !!(r && r.ok), added: (r && r.added ? r.added.length : 0), reason: (r && r.reason) || '' };
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
  if (syncLock.has(ws.id)) return { ok: false, error: 'sync-busy' };
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
  if (live === null) return { ok: false, error: 'busy' };   // couldn't determine which transcript is mid-write → defer rather than risk pushing a torn file (fail closed; retry lands a moment later)
  return doSync(ws, 'sync', { live });
});

// Make a LOCAL workspace SYNCED across devices: turn its folder into a private GitHub repo IN PLACE (so its
// existing sessions stay linked — they're keyed by the unchanged path), then enable session sync. Powers the
// "sync across my devices" button and auto-upgrade-on-invite. Keeps the registry id/label so the active tab
// and chips don't jump; discovery dedupes by slug (below) so the upgraded ws is never re-added as a duplicate.
ipcMain.handle('workspace:upgrade', async (e, id) => {
  const ws = registry.workspaces.find((w) => w.id === id);
  if (!ws) return { ok: false, error: 'no such workspace' };
  if (ws.kind === 'repo') return { ok: true, already: true };
  if (ws.kind !== 'local') return { ok: false, error: 'only a local workspace can be made synced' };
  // An ADOPTED folder is the user's own working tree, very often already a git repo with a real `origin`.
  // upgrade-workspace.sh runs `git remote remove origin` + `git add -A` + `gh repo create --source=. --push`:
  // on an adopted repo that DROPS their remote and republishes their whole tree to a new private repo. Refuse.
  if (ws.adopted) return { ok: false, error: 'This project points at a folder you already own — Claudible won’t re-publish it to a new GitHub repo. Create a “shared repo project” instead.' };
  if (!APPDIR_WSL) return { ok: false, error: ERR_NO_BACKEND };
  const slug = String(ws.slug || '').replace(/[^A-Za-z0-9-]/g, '');
  if (!slug) return { ok: false, error: 'bad workspace' };
  // A stored path we can't round-trip must REFUSE, not silently become ''. Upgrade operates on an EXISTING
  // folder in place; an empty dirArg makes upgrade-workspace.sh fall back to its default ~/.claudible/workspaces
  // /<slug> — the WRONG folder — where it would either error confusingly or (if that folder exists) publish a
  // repo from it and rewrite ws.path to point there, orphaning the user's real project. (ws.path can only be
  // unsafe on a pre-existing/hand-edited registry; every creation path runs safePath up front.)
  let wsp = '';
  if (ws.path) { wsp = safePath(runner.toGuestPath(ws.path)); if (!wsp) return { ok: false, error: PATH_UNSAFE_MSG }; }
  const dirArg = wsp ? ` '${wsp}'` : '';
  const { err, stdout } = await runner.runScript('upgrade-workspace.sh', `'${slug}'${dirArg}`, { timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
  if (err) return { ok: false, error: 'upgrade failed to run' };
  let r = {}; try { r = JSON.parse(String(stdout).trim() || '{}'); } catch {}
  if (!r.ok) return { ok: false, error: r.error || 'could not create the repo', authIssue: !!r.authIssue };   // authIssue → the renderer shows the "connect GitHub first" hint (only for genuine gh-not-installed/-authenticated failures, not every message that mentions GitHub)
  // The script can run for MINUTES — re-check the workspace survived (a concurrent workspace:delete removes it
  // from the registry; mutating the stale `ws` object then "succeeds" into a saveRegistry that resurrects
  // nothing, leaving an orphaned private GitHub repo + a phantom invite discovery would re-offer). If it's
  // gone, say so honestly — the repo WAS created and only the user can decide to delete it on GitHub.
  if (!registry.workspaces.includes(ws)) {
    return { ok: false, error: `the project was deleted while the upgrade ran — the GitHub repo ${r.owner ? r.owner + '/' : ''}${slug} was already created; delete it on GitHub if you don’t want it` };
  }
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
ipcMain.handle('workspace:list', () => ({ activeId: registry.activeId, workspaces: registry.workspaces, firstRun: !!registry.firstRun }));
// One-time first-run flag (set when the default Local workspace was materialized) → cleared once the renderer has shown its setup prompt.
ipcMain.handle('workspace:firstRunDone', () => { if (registry.firstRun) { delete registry.firstRun; saveRegistry(); } return { ok: true }; });
// Switch the active workspace: subsequent session list/open/delete scope to its cwd; resume its latest convo.
ipcMain.handle('workspace:open', async (e, id, session) => {
  const ws = registry.workspaces.find((w) => w.id === id);
  if (!ws) return { ok: false, error: 'unknown workspace' };
  const myGen = ++openGen;                                         // a later open must win over a slow clone
  const targetTab = fgTabId;                                       // the tab this open was FOR — resolved NOW, not after a minutes-long clone
  if (ws.kind === 'repo' && ws.needsClone) {                       // invited workspace, not cloned yet → fetch it first
    const c = await ensureClone(ws);
    if (!c.ok) return { ok: false, error: c.error || 'clone failed' };
  }
  if (myGen !== openGen) return { ok: false, error: 'superseded' };   // a newer open started during our clone → stand down
  // A plain tab-focus change doesn't bump openGen, so check it explicitly: if the user foregrounded a DIFFERENT
  // tab while the clone ran, this stale continuation must not kill that tab and rebind it (audit finding).
  if (fgTabId !== targetTab) return { ok: false, error: 'superseded' };
  activeWorkspace = ws; registry.activeId = id; saveRegistry();
  const fr = ptys.get(targetTab); const prevWs = fr && fr.ws;
  if (fr) fr.ws = ws;                                              // re-point the target tab at the new workspace (other tabs keep running)
  // guardBusy: the user may have submitted a prompt on this tab DURING the clone — never kill a mid-turn
  // Claude. On refusal the workspace still switches (sidebar follows); the running session keeps its ws truthful.
  const respawned = respawnPty(targetTab, session || '', { guardBusy: true });   // a session id → open it DIRECTLY (one respawn); '' = resume most-recent in that cwd
  if (!respawned && fr) fr.ws = prevWs;
  pollDelay = SYNC_MIN;                                            // a freshly-opened workspace: poll promptly
  if (ws.kind === 'repo' && ws.syncSessions) doSync(ws, 'sync', {});   // pull collaborators' sessions in the background
  // keptTab: main declined to re-point this tab — it's mid-turn, or it's the live-shared one. The workspace still
  // switches (the sidebar follows), but the tab keeps running what it was running. The renderer says so out loud
  // rather than painting a tab that claims to be somewhere its pty isn't.
  return { ok: true, keptTab: !respawned };
});
// Accept an invited repo workspace, letting the user choose WHERE it clones. useDefault → the script's
// ~/.claudible/repos/<slug>; otherwise a native folder picker, cloning into <chosen>/<slug>. Stamps ws.path so
// every downstream script (sessions, sync, claude) runs in that dir via CLAUDIBLE_WS_DIR.
// STALE-CONTINUATION GUARD. This handler awaits a USER-PACED folder dialog — it can sit open for minutes — and then
// awaits a network clone. A `workspace:delete` for the same id can land in either window. Its three sibling
// workspace-mutating handlers all defend against this (workspace:open re-checks openGen AND fgTabId, "audit
// finding"); this one held a live `ws` object across the awaits and defended against nothing. The object would be
// detached from `registry.workspaces`, so `ws.path = …` + saveRegistry() silently discarded the change — and
// ensureClone() still cloned the repo onto disk, owned by no registry entry, with no cleanup path.
// So: never hold `ws` across an await. Re-resolve it by id, every time.
ipcMain.handle('workspace:acceptInvite', async (e, payload) => {
  const wsId = payload && payload.id;
  const live = () => registry.workspaces.find((w) => w.id === wsId);   // the CURRENT object, or undefined if deleted
  let ws = live();
  if (!ws) return { ok: false, error: 'unknown workspace' };
  if (ws.kind !== 'repo') return { ok: false, error: 'not a repo workspace' };
  const slug = String(ws.slug || '').replace(/[^A-Za-z0-9-]/g, '');
  if (!slug) return { ok: false, error: 'bad workspace' };
  if (payload && payload.useDefault) {
    if (ws.path) { delete ws.path; saveRegistry(); }                 // default location → drop any prior custom path
  } else {
    let res; try { res = await dialog.showOpenDialog(win, { title: 'Choose where to save this shared workspace', properties: ['openDirectory', 'createDirectory'] }); } catch { res = { canceled: true }; }
    if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, error: 'cancelled' };
    ws = live();                                                     // the project may have been deleted while the picker was open
    if (!ws) return { ok: false, error: 'unknown workspace' };
    const wslp = safePath(runner.toGuestPath(res.filePaths[0]));
    if (!wslp) return { ok: false, error: PATH_UNSAFE_MSG };
    ws.path = `${wslp.replace(/\/+$/, '')}/${slug}`;                 // clone into <chosen>/<slug> (mirrors create-workspace's <parent>/<slug>)
    saveRegistry();
  }
  ws = live();                                                       // …and again, immediately before we touch the disk
  if (!ws) return { ok: false, error: 'unknown workspace' };
  const c = await ensureClone(ws);                                   // honors ws.path; clears needsClone on success. Minutes, over the network.
  const after = live();
  if (!after) return { ok: false, error: 'unknown workspace' };      // deleted mid-clone: the registry is already right; don't resurrect it
  if (!c.ok && !(payload && payload.useDefault) && after.path) { delete after.path; saveRegistry(); }   // failed custom clone → don't leave a dangling path
  if (c.ok && !after.syncSessions) {
    // R3: the accept modal promises "sessions still sync with the team" — but nothing ever enabled it, so the
    // invited collaborator landed in a normal-looking project that could neither see the team's sessions nor
    // publish its own until they found a second consent menu item nothing pointed at. Clicking "Add shared
    // project" on a modal that states sessions sync IS the consent — honor it, and kick the first sync so the
    // team's sessions appear now, not at the next poll tick (mirrors workspace:upgrade's post-enable kick).
    after.syncSessions = true; saveRegistry();
    (async () => {
      if (syncLock.has(after.id)) return; syncLock.add(after.id);
      let ir; try { ir = await runSync(after, 'init', {}); } finally { syncLock.delete(after.id); }
      if (ir && ir.ok) doSync(after, 'sync', {});
    })();
  }
  return c.ok ? { ok: true, path: after.path || null } : { ok: false, error: c.error || 'clone failed' };
});
// Provision a new workspace (local mkdir or a private GitHub repo), register it, switch to it, start fresh.
ipcMain.handle('workspace:create', (e, payload) => new Promise((resolve) => {
  const targetTab = fgTabId;                                       // the tab this create was FOR (see attach() below)
  const kind = (payload && payload.kind === 'repo') ? 'repo' : 'local';
  const name = String((payload && payload.name) || '').trim();
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  if (!slug) return resolve({ ok: false, error: 'enter a name (letters, numbers, dashes)' });
  if (registry.workspaces.some((w) => w.id === `${kind}-${slug}`)) return resolve({ ok: false, error: 'a workspace with that name already exists' });
  if (!APPDIR_WSL) return resolve({ ok: false, error: ERR_NO_BACKEND });
  const exec = (pdirWsl) => {
    const arg3 = pdirWsl ? ` '${pdirWsl}'` : '';                       // optional custom parent dir (local only)
    runner.runScript('create-workspace.sh', `'${kind}' '${slug}'${arg3}`, { timeout: kind === 'repo' ? 300000 : 30000 }).then(({ err, stdout }) => {   // repo = network-bound (clone+push)
        if (err) { console.error('[claudible] create-workspace:', err.message); return resolve({ ok: false, error: 'creation timed out or failed' }); }
        let r = {}; try { r = JSON.parse(String(stdout).trim() || '{}'); } catch {}
        // Register + switch to a workspace, then resolve. fresh=true for a brand-new one (start a fresh
        // conversation); fresh=false when re-attaching an orphan (resume whatever's in that cwd).
        const attach = (repoUrl, owner, fresh, wsPath) => {
          openGen++;                                                     // supersede any in-flight workspace:open clone
          // The create script can run for minutes (repo = network create+clone+push). If a workspace with this
          // exact id materialized meanwhile (discovery / an accepted invite / a concurrent create of the same
          // name), REUSE it instead of pushing a duplicate id into the registry — the same stale-continuation
          // class workspace:upgrade/rename already guard (4b0dd24), creation edition.
          const dup = registry.workspaces.find((w) => w.id === `${kind}-${slug}`);
          const ws = dup || { id: `${kind}-${slug}`, label: name.slice(0, 80) || slug, kind, slug,
            repoUrl: repoUrl || undefined, owner: owner || undefined, path: wsPath || undefined, createdAt: Date.now() };
          if (dup) { if (repoUrl && !ws.repoUrl) ws.repoUrl = repoUrl; if (owner && !ws.owner) ws.owner = owner; if (wsPath && !ws.path) ws.path = wsPath; }
          if (kind === 'repo' && owner && Array.isArray(registry.dismissedRepos)) {   // deliberately (re-)adding a repo clears its delete-tombstone so discovery works normally again
            // Only the name-form key can be cleared here: this fresh workspace does not know its ghId yet (the
            // backfill sets it later), so there is no `gh:<id>` to match on. That is fine, and not a leak: a
            // re-added workspace IS in the registry, so discovery matches it as `existing` and `continue`s well
            // BEFORE it reaches the tombstone check (see discoverWorkspaces). A leftover `gh:<id>` key can only
            // ever suppress a repo that has no workspace — which is exactly what a tombstone is for.
            registry.dismissedRepos = registry.dismissedRepos.filter((k) => k !== owner + '/' + slug);
          }
          // A SHARED project created from the modal must behave exactly like an upgraded one: sync on from
          // birth, sessions-branch initialized, first push kicked. Without this the "Shared repo project" tile
          // minted a repo whose creator couldn't see collaborators' sessions (or Join live) until they manually
          // clicked "Collaborate in Claudible…" — the invited side got sync enabled on accept, the creator
          // didn't. Mirrors workspace:upgrade + workspace:acceptInvite line-for-line.
          if (kind === 'repo' && owner) {
            ws.syncSessions = true;
            (async () => {
              if (syncLock.has(ws.id)) return; syncLock.add(ws.id);
              let ir; try { ir = await runSync(ws, 'init', {}); } finally { syncLock.delete(ws.id); }   // release BEFORE doSync, else its lock-guard makes the first push a no-op
              if (ir && ir.ok) doSync(ws, 'sync', {});
            })();
          }
          if (!dup) registry.workspaces.push(ws);
          registry.activeId = ws.id; activeWorkspace = ws; saveRegistry();
          // The create script can run for minutes (repo = network clone+push). Only re-point/respawn the tab
          // this create was FOR, and only if the user hasn't foregrounded another tab since — and never kill
          // a turn they started while waiting (same stale-continuation class as workspace:open, audit finding).
          // superseded: the user foregrounded a DIFFERENT tab while this create ran (a repo clone can take minutes).
          // Distinct from keptTab: nothing was refused and nothing moved, so the renderer must not repaint whatever
          // tab happens to be active now. Conflating the two let a slow create seize an unrelated running tab.
          let keptTab = false, superseded = fgTabId !== targetTab;
          if (!superseded) {
            const fr = ptys.get(targetTab); const prevWs = fr && fr.ws;
            if (fr) fr.ws = ws;
            const respawned = respawnPty(targetTab, fresh ? 'new' : '', { guardBusy: true });
            if (!respawned && fr) fr.ws = prevWs;
            keptTab = !respawned;   // mid-turn, or the live-shared tab → the renderer opens the new project beside it
          }
          resolve({ ok: true, workspace: ws, keptTab, superseded });
        };
        if (r.ok) return attach(r.repoUrl, r.owner, true, r.path);
        // The dir already exists on disk but isn't in our registry (registry wiped, or a prior create
        // timed out AFTER provisioning): re-attach it instead of dead-ending the name.
        if (/already exists/i.test(String(r.error || ''))) return attach(r.repoUrl, r.owner, false, r.path);   // reattach with the owner recovered from the existing clone's remote (create-workspace.sh) so it isn't left owner-less (L-2)
        resolve({ ok: false, error: r.error || 'creation failed', authIssue: !!r.authIssue });   // authIssue → the renderer shows the "connect GitHub first" hint (only genuine gh-not-installed/-authenticated failures — mirrors workspace:upgrade)
      });
  };
  // Custom save-location (local only): pick a parent folder, convert Windows→WSL path, create <folder>/<slug> there.
  if (kind === 'local' && payload && payload.pick) {
    dialog.showOpenDialog(win, { title: 'Choose where to create this workspace', properties: ['openDirectory', 'createDirectory'] })
      .then((res) => {
        if (res.canceled || !res.filePaths || !res.filePaths.length) return resolve({ ok: false, error: 'cancelled' });
        // Was `.includes("'")` — the shell hazard only. A `"` or `\` sailed through into create-workspace.sh's
        // `printf '…"path":"%s"…'`, and by the time JSON.parse threw, the folder was on disk owned by nothing.
        const wslp = safePath(runner.toGuestPath(res.filePaths[0]));
        if (!wslp) return resolve({ ok: false, error: PATH_UNSAFE_MSG });
        exec(wslp);
      }).catch(() => resolve({ ok: false, error: 'folder pick failed' }));
  } else {
    exec('');
  }
}));
// ADOPT a folder the user already works in as a project. Unlike workspace:create, nothing is provisioned: the
// folder exists, may be a git repo with its own remote, and Claudible must never move, republish, or delete it.
// It registers as kind:'local' (so the existing local/repo/legacy allowlists in the runners keep working —
// an unknown kind silently degrades to 'legacy' and would point Claude at ~/.claudible/session) plus the
// `adopted:true` marker that gates the two destructive paths: workspace:delete's folder-trashing script, and
// workspace:upgrade's `git remote remove origin` + republish.
const GITHUB_REMOTE = /^(?:https?:\/\/(?:[^@/]*@)?(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i;
ipcMain.handle('workspace:adopt', (e, payload) => new Promise((resolve) => {
  const targetTab = fgTabId;                                       // the tab this adopt was FOR (mirrors workspace:create)
  if (!APPDIR_WSL) return resolve({ ok: false, error: ERR_NO_BACKEND });
  dialog.showOpenDialog(win, { title: 'Choose a folder you already work in', properties: ['openDirectory'] })
    .then((res) => {
      if (res.canceled || !res.filePaths || !res.filePaths.length) return resolve({ ok: false, error: 'cancelled' });
      // This site had the strongest charset of the four; lib/pathSafe.js is its union with the control bytes.
      const guest = safePath(runner.toGuestPath(res.filePaths[0]));
      if (!guest) return resolve({ ok: false, error: PATH_UNSAFE_MSG });
      runner.runScript('adopt-workspace.sh', `'${guest}'`, { timeout: 30000 }).then(({ err, stdout }) => {
        if (err) { console.error('[claudible] adopt-workspace:', err.message); return resolve({ ok: false, error: 'could not read that folder' }); }
        let r = {}; try { r = JSON.parse(String(stdout).trim() || '{}'); } catch {}
        if (!r.ok || !r.path) return resolve({ ok: false, error: r.error || 'could not add that folder' });
        // The SCRIPT's canonical path is the identity (it resolved `..`, symlinks and the Windows spelling), so
        // "same folder twice" is one string compare. Adding it again just re-opens the project already tracking it.
        const same = registry.workspaces.find((w) => w.path === r.path);
        if (same) {
          registry.activeId = same.id; activeWorkspace = same; saveRegistry();
          return resolve(Object.assign({ ok: true, workspace: same, already: true }, openWorkspaceInTab(same, targetTab)));
        }
        const base = String(payload && payload.name || r.name || '').trim().toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';
        // Two different folders can share a basename (`~/work/api` and `~/oss/api`). Uniquify rather than
        // dead-end: the slug only names the registry id — an adopted workspace always resolves via ws.path.
        let slug = base, n = 1;
        while (registry.workspaces.some((w) => w.id === `local-${slug}`)) slug = `${base}-${++n}`;
        const m = GITHUB_REMOTE.exec(String(r.origin || ''));
        const ws = { id: `local-${slug}`, label: String(payload && payload.name || r.name || slug).slice(0, 80),
          kind: 'local', slug, adopted: true, path: r.path,
          repoId: m ? `${m[1]}/${m[2]}` : undefined, createdAt: Date.now() };
        registry.workspaces.push(ws); registry.activeId = ws.id; activeWorkspace = ws; saveRegistry();
        resolve(Object.assign({ ok: true, workspace: ws, repo: !!r.repo, claudeTracked: !!r.claudeTracked, excluded: !!r.excluded },
          openWorkspaceInTab(ws, targetTab)));
      });
    }).catch(() => resolve({ ok: false, error: 'folder pick failed' }));
}));
// Point the tab this action was FOR at `ws` and start a fresh conversation there — but only if the user hasn't
// foregrounded a different tab meanwhile, and never over a mid-turn Claude OR the live-shared tab (same contract
// as workspace:create).
//   keptTab    — the tab is still running what it was; the renderer opens the new project in a tab of its own.
//   superseded — the user is looking at a different tab now; the renderer must repaint NOTHING (the folder picker
//                and adopt script can take a while, and `AT()` is no longer the tab this action was for).
function openWorkspaceInTab(ws, targetTab) {
  openGen++;                                                       // supersede any in-flight workspace:open clone
  if (fgTabId !== targetTab) return { keptTab: false, superseded: true };
  const fr = ptys.get(targetTab); const prevWs = fr && fr.ws;
  if (fr) fr.ws = ws;
  const respawned = respawnPty(targetTab, 'new', { guardBusy: true });
  if (!respawned && fr) fr.ws = prevWs;
  return { keptTab: !respawned, superseded: false };
}
// Grant / revoke a workspace to guests (default-deny). Updates the live share immediately.
ipcMain.handle('workspace:setShared', (e, payload) => {
  const ws = registry.workspaces.find((w) => w.id === (payload && payload.id));
  if (!ws) return { ok: false, error: 'unknown workspace' };
  ws.shared = !!(payload && payload.shared); saveRegistry();
  syncShare();
  return { ok: true, shared: ws.shared };
});
// Rename a workspace. The display label is always updated (registry is the source of truth; mirrored to guests'
// granted library via syncShare). For a repo workspace the user OWNS, this ALSO renames the GitHub repo — the
// requested behavior — while deliberately leaving ws.slug (and thus the local folder + every Claude transcript)
// frozen. A repo you don't own (a collaborator's invite) can't be renamed on GitHub, so it degrades to label-only
// with a notice; a local project has no repo to rename.
ipcMain.handle('workspace:rename', async (e, payload) => {
  const ws = registry.workspaces.find((w) => w.id === (payload && payload.id));
  if (!ws) return { ok: false, error: 'unknown workspace' };
  const label = String((payload && payload.label) || '').trim().slice(0, 80);
  if (!label) return { ok: false, error: 'empty name' };

  let repoRenamed = false, repoUrl, notice = '';
  // Only a Claudible-managed repo workspace (created/cloned here, not merely ADOPTED — an adopted repo points at
  // the user's own external folder whose remote we must not touch) has a GitHub repo we should rename.
  if (ws.kind === 'repo' && !ws.needsClone && !ws.adopted && ws.owner && APPDIR_WSL) {
    const curName = String(ws.repoName || ws.slug || '').replace(/[^A-Za-z0-9-]/g, '');
    const newName = label.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);   // GitHub-safe name from the label (Claudible slug charset: letters/digits/dashes)
    const owner = String(ws.owner).replace(/[^A-Za-z0-9-]/g, '');
    if (newName && owner && curName && newName !== curName) {
      const rr = await new Promise((res) => {
        runner.runScript('rename-repo.sh', `'${owner}' '${curName}' '${newName}'`, { ws, timeout: 60000 }).then(({ err, stdout }) => {
          if (err) { console.error('[claudible] rename-repo:', err.message); return res({ ok: false, error: 'exec' }); }
          let r = {}; try { r = JSON.parse(String(stdout).trim() || '{}'); } catch {}
          res(r);
        });
      });
      // Same stale-continuation guard as workspace:upgrade: the script await gave a concurrent
      // workspace:delete time to remove this ws — mutating the dead object would silently no-op while the
      // GitHub repo really did get renamed. Report that honestly instead.
      if (!registry.workspaces.includes(ws)) {
        return { ok: false, error: (rr && rr.ok) ? `the project was deleted while renaming — the GitHub repo is now ${owner}/${(rr.repoName || newName)}` : 'the project was deleted while renaming' };
      }
      if (rr && rr.ok) {
        ws.repoName = rr.repoName || newName;
        ws.repoUrl = rr.repoUrl || ('https://github.com/' + owner + '/' + (rr.repoName || newName));
        if (Number.isFinite(rr.ghId)) ws.ghId = rr.ghId;
        repoRenamed = true; repoUrl = ws.repoUrl;
      } else if (rr && rr.error === 'not-owner') {
        notice = 'Renamed here only — you don’t own the GitHub repo, so its name is unchanged.';
      } else {
        notice = 'Renamed here — but the GitHub repo couldn’t be renamed' + (rr && rr.error && rr.error !== 'exec' ? ' (' + rr.error + ')' : '') + '.';
      }
    }
  }

  ws.label = label; saveRegistry();
  syncShare();
  return { ok: true, label, repoRenamed, repoUrl, notice };
});
// Delete a workspace: soft-delete its folder (recoverable) + drop it from the registry. Invariant: never the
// last local workspace (the guaranteed home to open) — the renderer also hides delete in that case.
ipcMain.handle('workspace:delete', (e, id) => new Promise((resolve) => {
  const ws = registry.workspaces.find((w) => w.id === id);
  if (!ws) return resolve({ ok: false, error: 'unknown workspace' });
  // Mirrors the renderer's isLastLocal(). An ADOPTED entry only POINTS at a folder the user already owned —
  // removing it moves nothing — so the "keep a guaranteed home" rule must not make it permanently un-removable
  // (which it did: adopt on first run, the placeholder gets cleaned up, and it becomes the only kind:'local').
  // It can go whenever another OPENABLE project remains — `fallback` below must resolve to a real directory.
  if (ws.adopted) {
    if (!registry.workspaces.some((w) => w.id !== id && (w.kind === 'local' || (w.kind === 'repo' && !w.needsClone))))
      return resolve({ ok: false, error: 'This is your only project — add another first.' });
  } else if (ws.kind === 'local' && registry.workspaces.filter((w) => w.kind === 'local').length <= 1) {
    return resolve({ ok: false, error: 'You need at least one local workspace — create another first.' });
  }
  // BUSY GUARD: main's rec.busy is authoritative (hook poller). Deleting a workspace respawns every tab bound
  // to it — doing that under a mid-turn Claude kills the turn and trashes the directory it's writing into.
  // Same contract as session delete: refuse, let the renderer toast, user stops the turn first.
  for (const rec of ptys.values()) { if (rec.ws && rec.ws.id === id && rec.busy) return resolve({ ok: false, error: 'busy' }); }
  const fallback = registry.workspaces.find((w) => w.kind === 'local' && w.id !== id) || registry.workspaces.find((w) => w.id !== id) || registry.workspaces[0];
  openGen++;   // supersede any in-flight workspace:open clone for the workspace being deleted (mirrors create/switch)
  const moved = [];   // EVERY tab that lived here gets repointed AND respawned — not just the foreground one. A background tab left un-respawned kept its Claude silently running inside the trashed directory while sync/checkpoint bookkeeping targeted the fallback ws.
  for (const [tid, rec] of ptys) { if (rec.ws && rec.ws.id === id) { rec.ws = fallback; moved.push(tid); } }
  const pt = pushTimers.get(id); if (pt) { clearTimeout(pt); pushTimers.delete(id); }   // cancel any debounced push armed for this ws — else it fires against the just-deleted (still kind:'repo', syncSessions:true) object
  _pendingCkpt.delete(id); _syncDivSeen.delete(id); syncLock.delete(id); _lastPeers.delete(id);   // drop the deleted ws's leftover per-workspace state (incl. its last-pushed peers)
  _lastFetch.delete(id); fetchLock.delete(id);                                         // …incl. the background-fetch throttle (a re-added project must fetch immediately, not wait out a stale 90s window)
  // NOT the worktree-write chain: a checkpoint snapshot from the just-ended turn may still be in flight, and this
  // id can recur (it's `${kind}-${slug}`) — so force-dropping the key would let a re-created same-name workspace's
  // writes race the orphaned chain. The queue self-drains and self-bounds; letting it finish is the safe path.
  if (activeWorkspace && activeWorkspace.id === id) { activeWorkspace = fallback; registry.activeId = fallback.id; }
  registry.workspaces = registry.workspaces.filter((w) => w.id !== id);
  // TOMBSTONE a deleted GitHub-identified workspace (per-machine, in the registry): discoverWorkspaces would
  // otherwise re-register it as a fresh invite on the very next launch — 'deleted workspaces come back' —
  // because the GitHub repo (intentionally) still exists. Deliberately re-adding it clears it.
  // R15, two gaps closed: (a) KIND-AGNOSTIC — an ADOPTED project is kind:'local' but its Claudible-tagged repo
  // is re-surfaced by discovery all the same; the old kind==='repo' gate meant deleting it never tombstoned
  // (repoTombstoneKeys is empty-safe, so a plain local project without GitHub identity still skips cleanly).
  // (b) A delete BEFORE the ghId backfill ran tombstoned by name only, so a repo renamed outside Claudible
  // resurrected as a phantom — the stable gh: key is now resolved in the BACKGROUND on a snapshot (ws leaves
  // the registry below) and appended when it lands. Residual: a discovery pass racing that window can briefly
  // re-add the phantom once; the appended key stops every pass after.
  {
    const keys = repoTombstoneKeys(ws);
    if (keys.length) registry.dismissedRepos = Array.from(new Set([...(registry.dismissedRepos || []), ...keys]));
    if (!Number.isFinite(ws.ghId) && ws.owner && (ws.repoName || ws.slug)) {
      const snap = { owner: ws.owner, repoName: ws.repoName, slug: ws.slug, ghId: ws.ghId };
      backfillRepoIdentity(snap).then((got) => {
        if (!got || !Number.isFinite(snap.ghId)) return;
        registry.dismissedRepos = Array.from(new Set([...(registry.dismissedRepos || []), 'gh:' + snap.ghId]));
        saveRegistry();
      }).catch(() => {});
    }
  }
  saveRegistry();
  // Deleting the workspace the LIVE session runs in is the one navigation a share cannot survive: its folder is
  // about to be trashed, so its pty must be re-pointed. Say so honestly instead of leaving guests on a frozen
  // mirror — endShare lets respawnPty through (pausing + wiping the ring first) and the renderer tears the
  // tunnel down for real. Every other caller is refused outright. (deleteSession does the same for a session.)
  const sharedHere = sharedTabId != null && moved.includes(sharedTabId);
  if (sharedHere) {
    // Pause HERE, not only inside respawnPty's movesShared branch: a manual web-share pins whatever tab was in
    // the foreground, and that tab's session may be '' (resume-latest, never resolved) — which makes movesShared
    // false. And syncShare() must NOT run: every tab bound to this workspace already points at `fallback`, so it
    // would re-derive the pause from a project the guests were never granted and cheerfully un-freeze the mirror.
    // (Nothing can interleave before the freeze today — JS is single-threaded and there's no await — but the
    // ordering must not depend on that.) The renderer's force-end drops the tunnel a beat later.
    _liveTiming('share: FORCE-END — the project owning the pinned tab (' + sharedTabId + ') was deleted; the live link dies with it');
    try { share.setPaused(true); share.resetRing(); share.resetStatus(); } catch {}
    stopAdvertising();                                                 // stop re-stamping + clear presence NOW (parity with tab-close) rather than waiting on the renderer's force-end round-trip
    try { winSend('share:force-end', { reason: 'workspace-deleted' }); } catch {}
  } else {
    syncShare();   // refresh the granted library for guests (the deleted ws drops out of grantedList)
  }
  for (const tid of moved) { try { respawnPty(tid, '', { guardBusy: true, endShare: tid === sharedTabId }); } catch {} }   // guardBusy = belt for a turn that started in the ms since the check above
  // `folderError` is honest reporting, not a failure: the registry entry IS gone (saveRegistry already ran), so the
  // delete succeeded from the user's point of view. But the FOLDER move can still fail — permission denied, a file
  // locked by another process, disk full — and this used to be `.then(() => finish())`, discarding the result
  // entirely and resolving `{ok:true}` regardless. The folder would sit orphaned on disk, unreferenced by any
  // workspace, and the user was never told.
  const finish = (folderError) => resolve({ ok: true, activeId: registry.activeId, folderError: folderError || undefined, moved: moved.map((tid) => ({ tabId: tid, wsId: fallback.id })) });
  const slug = String(ws.slug || '').replace(/[^A-Za-z0-9-]/g, '');
  // ADOPTED workspaces point at a folder the USER already owned — Claudible never created it, so removing the
  // project must never remove the folder. delete-workspace.sh prefers CLAUDIBLE_WS_DIR (wsEnv emits ws.path), so
  // shelling out here would `mv -f` their real source tree into ~/.claudible/trash. Unregister only.
  if (APPDIR_WSL && slug && !ws.adopted && (ws.kind === 'local' || ws.kind === 'repo')) {
    runner.runScript('delete-workspace.sh', `'${ws.kind}' '${slug}'`, { ws, timeout: 20000 }).then(({ err, stdout }) => {
      if (err) { console.error('[claudible] delete-workspace:', err.message); return finish('the project was removed, but its folder could not be moved to trash'); }
      let r = {}; try { r = JSON.parse(String(stdout).trim() || '{}'); } catch {}
      if (r.ok === false) { console.error('[claudible] delete-workspace refused:', r.error); return finish('the project was removed, but its folder is still on disk' + (r.error && /\s/.test(r.error) ? ': ' + r.error : '')); }   // R41: only append the script's reason when it's a sentence — a bare code stapled to a good message reads as gibberish (the console keeps the raw one)
      finish();
    });
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
// "Plan big, execute small" (Anthropic cookbook pattern) — the main session plans/synthesizes on the user's
// chosen model while SUBAGENTS (the token-heavy leg: bulk reading, sweeps, workflows) run on Sonnet 5 via
// CLAUDE_CODE_SUBAGENT_MODEL. DEFAULT ON: absent/unknown registry value means enabled; only an explicit
// 'off' disables. On a Fable 5 / Opus main model this is the cookbook's measured 2.5×-cheaper split; on a
// Sonnet main model it's a harmless no-op. Applies to the NEXT session each tab launches.
function modelStrategyNow() { return registry.modelStrategy === 'off' ? 'off' : 'planBigExecSmall'; }
ipcMain.handle('modelStrategy:get', () => modelStrategyNow());
ipcMain.handle('modelStrategy:set', (e, v) => {
  registry.modelStrategy = v === 'off' ? 'off' : 'planBigExecSmall';
  const persisted = saveRegistry();
  if (!persisted) return { ok: false, error: 'could not write workspaces.json — applies to THIS run only', modelStrategy: modelStrategyNow() };
  return { ok: true, modelStrategy: modelStrategyNow() };
});
// Default PERMISSION mode for the user's own sessions — ships as 'default' (Claude prompts); 'bypass' & 'acceptEdits'
// are opt-in and remembered. A FOREIGN (collaborator-synced) session is ALWAYS sandboxed regardless (session.sh /
// win.js enforce that). Applies to the NEXT session each tab launches.
ipcMain.handle('permissionMode:get', () => registry.permissionMode || 'default');
ipcMain.handle('permissionMode:set', (e, mode) => {
  registry.permissionMode = ['default', 'acceptEdits', 'bypass'].includes(mode) ? mode : 'default';
  // A persist failure must be LOUD: the in-memory mode applies to this run, but it will silently revert on
  // relaunch ("bypass is on in my settings but off when I launch" — the exact bug this closes).
  const persisted = saveRegistry();
  if (!persisted) return { ok: false, error: 'could not write workspaces.json — the mode applies to THIS run only and will reset on relaunch', permissionMode: registry.permissionMode };
  return { ok: true, permissionMode: registry.permissionMode };
});
// Invite a GitHub user as a push collaborator on a repo workspace's repo (Stage 2 — durable git collab).
ipcMain.handle('repo:invite', (e, payload) => new Promise((resolve) => {
  const ws = registry.workspaces.find((w) => w.id === (payload && payload.id));
  if (!ws || ws.kind !== 'repo') return resolve({ ok: false, error: 'not a repo workspace' });
  const login = String((payload && payload.username) || '').trim().replace(/[^A-Za-z0-9-]/g, '');   // GitHub logins are [A-Za-z0-9-]
  if (!login) return resolve({ ok: false, error: 'enter a GitHub username' });
  // The repo's CURRENT GitHub name (repoName), NOT the frozen slug: after a rename the two diverge, and the
  // collaborators API path must target the live name. repoName falls back to slug for never-renamed workspaces.
  const repo = String(ws.repoName || ws.slug || '').replace(/[^A-Za-z0-9-]/g, '');   // honor the bash-interpolation invariant (re-sanitise)
  if (!repo) return resolve({ ok: false, error: 'bad workspace' });
  // R12: the OWNER is the workspace's recorded owner, passed explicitly — the script used to resolve `gh api
  // user` (whoever clicked), so a collaborator's invite targeted their OWN namespace: a same-named repo of
  // theirs, or a 404 the UI reported as success. The script refuses politely when the signed-in user isn't
  // this owner (GitHub wouldn't honor it anyway).
  const owner = String(ws.owner || '').replace(/[^A-Za-z0-9-]/g, '');
  if (!owner) return resolve({ ok: false, error: 'this project has no recorded GitHub owner — re-sync it first' });
  if (!APPDIR_WSL) return resolve({ ok: false, error: ERR_NO_BACKEND });
  runner.runScript('repo-invite.sh', `'${repo}' '${login}' '${owner}'`, { timeout: 60000 }).then(({ err, stdout }) => {
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
  if (!APPDIR_WSL) return resolve({ ok: false, error: ERR_NO_BACKEND });
  runner.runScript('skills.sh', `set '${name}' '${state}'`, { ws: activeWorkspace, timeout: 20000 }).then(({ err, stdout }) => {
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
  if (!APPDIR_WSL) return resolve({ ok: false, error: ERR_NO_BACKEND });
  runner.runScript('plugins.sh', `toggle '${key}' '${act}'`, { timeout: 60000 }).then(({ err, stdout }) => {
      if (err) { console.error('[claudible] plugins:toggle', err.message); return resolve({ ok: false, error: 'failed' }); }
      try { resolve(JSON.parse(String(stdout).trim() || '{}')); } catch { resolve({ ok: false }); }
    });
}));
ipcMain.on('share:tracker', (e, s) => {   // mirror tracker to guests — but ONLY the mirrored tab's (drop pushes for tabs the host is merely browsing)
  try {
    if (s && s.tabId != null && String(s.tabId) !== String(mirrorTabId())) return;
    share.broadcastStatus(s);
  } catch {}
});
ipcMain.on('share:chat-send', (e, text) => { try { share.broadcastChat(text); } catch {} });   // host → guests chat

// ---- session tracker: poll EACH live tab's runtime/tabs/<tab>/status.json (Windows FS, native read) ----
// Per-tab files (written by session.sh via the inherited CLAUDIBLE_STATUS env) so concurrent sessions
// never clobber one meter; every 'status' IPC carries its tabId so the renderer routes it to the right tab.
const lastStatusByTab = new Map();   // tabId -> last raw status json (dedupe)
const appIntervals = [];   // long-lived poller intervals — cleared on window-all-closed so none leak or fire against a dead window (H3)
// Two pollers RESCHEDULE THEMSELVES with setTimeout instead of running on a fixed interval (their cadence is
// adaptive), so they never landed in appIntervals and nothing ever cleared them — the only two of six outside the
// quit sweep. Both spawn a WSL subprocess per tick (sessions-sync.sh / workflows.sh). Today `app.quit()` masks it;
// the day this process outlives its window (a tray icon, a background mode) they'd tick forever against nothing.
// A `git pull` under a running app changes NOTHING about the running process — surface that drift instead
// of letting two machines argue about "which build are you on" (package.json's version doesn't move between
// releases, so semver is structurally blind to it). Compares the boot-time sha against the tree's current one.
// "Update & restart" for clone installs — the action half of the drift chip. Policy: fires ONLY on the
// user's click (build:drift stays notice-only), refuses dirty trees with the evidence, never auto-stashes,
// and classifies failures into actionable messages. Success is never observed by the caller: the process
// tears down (the SAME teardownForExit the quit path runs — app.exit bypasses window-all-closed) and relaunches.
let updateInFlight = null;
ipcMain.handle('update:run', () => {
  if (process.env.CLAUDIBLE_NO_UPDATE) return { ok: false, error: 'updates were disabled at install time (-NoUpdate)' };
  if (!BUILD.sha) return { ok: false, error: 'not a clone install' };
  if (updateInFlight) return updateInFlight;
  const prog = (phase, msg) => { try { winSend('update:progress', { phase, msg }); } catch {} };
  updateInFlight = (async () => {
    try {
      prog('checking', 'Checking…');
      if (!(await selfUpdate.gitOk(__dirname))) return { ok: false, error: 'git is not available on this machine — install it, then retry' };
      const d = await selfUpdate.isDirty(__dirname);
      if (d.err) return { ok: false, error: 'git status failed: ' + d.err };
      if (d.dirty) return { ok: false, error: 'this checkout has local changes — commit, stash, or discard them first:\n' + d.detail };
      const before = await selfUpdate.currentSha(__dirname);
      prog('pulling', 'Pulling update…');
      const pr = await selfUpdate.pull(__dirname);
      if (!pr.ok && pr.kind === 'non-ff') {
        // Upstream history was rewritten (a force-push), so ff-only can never succeed again and `git pull`
        // is a permanent dead end — the state that forced collaborators to run git by hand. The tree is
        // already proven clean above and an app checkout holds nothing of the user's, so snap to the
        // upstream tip instead of handing them a manual chore.
        prog('pulling', 'History diverged — resetting to the latest…');
        _liveTiming('update: non-ff — resetting clean checkout to upstream');
        const rr = await selfUpdate.resetToUpstream(__dirname);
        if (!rr.ok) return { ok: false, error: 'this checkout has diverged and could not be reset automatically: ' + String(rr.detail || '') };
      } else if (!pr.ok) {
        const msg = pr.kind === 'offline' ? 'could not reach GitHub — check your connection and retry'
          : pr.kind === 'no-branch' ? 'not on a tracked branch — checkout main (or re-clone) to update'
          : 'git pull failed: ' + String(pr.detail || '').slice(-300);
        return { ok: false, error: msg };
      }
      const after = await selfUpdate.currentSha(__dirname);
      if (after === before) { prog('restarting', 'Already up to date — restarting…'); }
      else if (await selfUpdate.electronVersionChanged(__dirname, before, after)) {
        // The one thing npm cannot replace under a running process: our own runtime binary.
        return { ok: false, error: 'this update changes the Electron runtime — close Claudible completely and re-run install.ps1 to finish' };
      } else if (await selfUpdate.depsChanged(__dirname, before, after)) {
        prog('npm-install', 'Installing dependencies…');
        const ni = await selfUpdate.npmInstall(__dirname, (ln) => prog('npm-install', ln.slice(0, 60)));
        if (!ni.ok) return { ok: false, error: 'npm install failed (the code is already pulled; fix npm and restart manually):\n' + String(ni.detail || '').slice(-400) };
      }
      prog('restarting', 'Restarting…');
      _liveTiming('update: pulled ' + (before || '?').slice(0, 12) + ' -> ' + (after || '?').slice(0, 12) + ', restarting');
      teardownForExit();
      app.relaunch();
      // app.exit() is a HARD kill — it waits for nothing. teardownForExit fires a DETACHED presence-clear, and
      // on Windows spawning wsl.exe takes hundreds of ms, so exiting on the next line meant the clear never
      // reached the OS and the host stayed advertised on the branch after every self-update. Bounded by the
      // ack's own 2s cap, so a broken spawn still cannot wedge the restart.
      try { await _quitClearAck; } catch {}
      app.exit(0);
      return { ok: true };   // unreachable in practice — the process is gone
    } catch (e) { return { ok: false, error: (e && e.message) || 'update failed' }; }
  })();
  updateInFlight.finally(() => { updateInFlight = null; });
  return updateInFlight;
});
function checkBuildDrift() {
  if (!BUILD.sha) return;
  const fresh = readGitSha(__dirname);
  if (fresh && fresh.sha !== BUILD.sha) { try { winSend('build:drift', { running: BUILD.short, disk: fresh.short }); } catch {} }
}
const appTimers = { sync: null, workflow: null, trash: null, tunnelRetry: null, beacon: null, buildDrift: null };   // tunnelRetry: the live-share self-heal (armTunnelRetry); beacon: the remote-head fast poll — same contract, must die with the window
// Heartbeat for the app→Claude context channel: the hook drops live/typedBy from a context.json whose ts is
// >10 min old (crashed-writer guard), so refresh the foreground tab's file every 5 min — a quiet hosting
// session (no roster/typing/foreground events for a while) must keep its "YOU ARE HOSTING" line alive.
function pollContextHeartbeat() {
  appIntervals.push(setInterval(() => { try { if (ptys.has(mirrorTabId())) _writeContext(mirrorTabId()); } catch {} }, 5 * 60 * 1000));   // keep the HOSTING tab's "YOU ARE HOSTING" line alive, wherever the host is focused
}
function pollStatus() {
  appIntervals.push(setInterval(() => {
    for (const [tabId, rec] of ptys) {
      try {
        const raw = fs.readFileSync(path.join(RT, 'tabs', rec.runtimeId, 'status.json'), 'utf8');
        if (raw === lastStatusByTab.get(tabId)) continue; lastStatusByTab.set(tabId, raw);
        const d = JSON.parse(raw); const c = d.context_window || {}; const cost = d.cost || {};
        if (d.session_id) {
          rec.sessionId = d.session_id;   // the live session id — used to locate this tab's workflow/swarm agents
          // Reconcile rec.session too (write-once at spawn — stuck at ''/new for a born-new tab's whole life,
          // while the RENDERER's copy reconciles every status event and stamps history entries with the real
          // id). _snapshotOnStop matches entries by rec.session, so without this a new-session tab NEVER
          // matched its own entry and its turn stats landed on whichever entry was newest (cross-tab
          // misattribution). Also makes respawnPty's moves-shared compare truthful.
          if (rec.session !== d.session_id) rec.session = d.session_id;
        }
        const cu = c.current_usage || null;   // last turn's usage (input/output here are NEW, non-cache)
        win && win.webContents.send('status', {
          tabId,
          sessionId: d.session_id || null,   // lets the renderer reconcile a freshly-started "new" tab into its saved session row
          ctxPct: c.used_percentage, costUsd: cost.total_cost_usd,
          newTok: cu ? ((cu.input_tokens || 0) + (cu.output_tokens || 0)) : null,  // genuinely-new tokens, excl. cache
          usageKey: cu ? `${cu.input_tokens}:${cu.output_tokens}:${cu.cache_read_input_tokens}:${cu.cache_creation_input_tokens}` : null,
          model: d.model && d.model.display_name, fast: d.fast_mode,
          // Claude.ai subscription limits, straight from the statusLine payload we already persist verbatim.
          // ACCOUNT-scoped, not per-tab: the renderer keeps one copy for this machine and never mirrors it to
          // guests (a guest's own limits are their own). Optional upstream — absent for API-key/Bedrock/Vertex
          // users and until the first API response of a session — so `null` means UNKNOWN, never zero.
          rate: d.rate_limits || null,
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
    appTimers.workflow = setTimeout(tick, delay);
  };
  appTimers.workflow = setTimeout(tick, 2500);
}

// ---- audio (in main: no renderer CORS) ----
// R19: `String(err)` handed the renderer raw undici internals ("TypeError: fetch failed") — the single most
// common failure (services not running) read as a code crash with no next step. Classify the transport-level
// failures; a service's OWN error body (the !r.ok branches) already reads fine and stays untouched.
function voiceErrText(err, what) {
  const s = String((err && err.message) || err || '');
  if (/abort|timeout/i.test(s)) return what + ' timed out — the voice service may still be warming up; try again in a moment';
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket|network/i.test(s)) return 'the voice services aren’t running — use Install/Repair on the Voice row in the System check, or restart Claudible';
  return what + ' failed — ' + s.replace(/[\u0000-\u001f"]/g, ' ').slice(0, 120);
}
ipcMain.handle('stt', async (e, arrayBuf) => {
  try {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from(arrayBuf)], { type: 'audio/webm' }), 'audio.webm');
    fd.append('response_format', 'json');
    const r = await fetch(`${WHISPER}/v1/audio/transcriptions`, { method: 'POST', body: fd, signal: AbortSignal.timeout(70000) });   // fail cleanly if Whisper hangs, instead of undici's ~300s default (70s is generous for a long clip on CPU)
    if (!r.ok) { const j = await r.json().catch(() => ({})); return { error: (j.detail && (j.detail.message || j.detail)) || j.error || ('HTTP ' + r.status) }; }
    return await r.json();
  } catch (err) { return { error: voiceErrText(err, 'transcription') }; }   // R19: never the raw exception
});
ipcMain.handle('tts', async (e, text, voice) => {
  try {
    const r = await fetch(`${KOKORO}/v1/audio/speech`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'kokoro', input: text, voice: voice || 'af_bella', response_format: 'mp3', speed: 1.05 }),
      signal: AbortSignal.timeout(70000),   // fail cleanly if Kokoro hangs, instead of undici's ~300s default
    });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || ct.includes('application/json')) {
      const j = await r.json().catch(() => ({}));
      return { error: (j.detail && (j.detail.message || j.detail)) || j.error || ('HTTP ' + r.status) };
    }
    return { audio: await r.arrayBuffer() };
  } catch (err) { return { error: voiceErrText(err, 'speech') }; }   // R19: never the raw exception
});
ipcMain.handle('endpoints', () => ({ whisper: WHISPER, kokoro: KOKORO, pty: !!runner.ptyInfo().mod, ptyErr: runner.ptyInfo().err }));
// Open a URL in the user's real browser (e.g. the "visit repo on GitHub" button). Validated: http(s) only — never
// file://, custom protocols, or shell args — so a workspace's repoUrl can't be weaponized into a local-exec.
ipcMain.handle('open-external', (e, url) => {
  try { const u = new URL(String(url || '')); if (u.protocol === 'https:' || u.protocol === 'http:') { shell.openExternal(u.href); return { ok: true }; } } catch {}
  return { ok: false };
});

// clipboard for the right-click menu (works regardless of renderer clipboard permissions)
// Returns whether the write landed. Callers that announce success ("Prompt copied") must not announce it on a
// clipboard the OS refused — every other channel reports; this one used to resolve `undefined` and swallow.
ipcMain.handle('clip:write', (e, text) => { try { clipboard.writeText(String(text ?? '')); return { ok: true }; } catch (err) { console.error('[claudible] clipboard:', err.message); return { ok: false, error: 'clipboard' }; } });
ipcMain.handle('clip:read', () => { try { return clipboard.readText(); } catch { return ''; } });

// Export a saved session as a SELF-CONTAINED, shareable HTML replay (no server, works offline). Reads the
// transcript for the active workspace's session via transcript.sh, renders it, and lets the user pick where
// Read a session's transcript as a message array. This was written out VERBATIM in three handlers (session:export,
// session:export-text, session:latest-reply) and all three DROPPED `err`: a crashed or timed-out transcript.sh
// resolved `[]`, which is indistinguishable from "this session is empty" — and empty is exactly what each of them
// then told the user ("Nothing to export in this session yet", "No text detected to read"). One copy now, and it
// returns `null` for "the read FAILED" vs `[]` for "the session is genuinely empty". Callers must tell them apart.
function _readTranscript(ws, sid) {
  return new Promise((resolve) => {
    runner.runScript('transcript.sh', `'${sid}'`, { ws, timeout: 30000, maxBuffer: 16 * 1024 * 1024 })
      .then(({ err, stdout }) => {
        if (err) { console.error('[claudible] transcript.sh:', err.message); return resolve(null); }
        let m = null;
        try { m = JSON.parse(String(stdout).trim() || '[]'); } catch { console.error('[claudible] transcript.sh: unparseable output'); }
        resolve(Array.isArray(m) ? m : null);
      });
  });
}
// to save. Text is embedded as JSON and rendered client-side via textContent → no injection from transcript.
ipcMain.handle('session:export', async (e, arg) => {
  try {
    const sessionId = (arg && typeof arg === 'object') ? arg.id : arg;   // legacy bare-id calls still work
    const ws = _wsById(arg && arg.wsId) || activeWorkspace;              // the ROW's workspace — main's active ws differs while a joined live tab is on screen
    const sid = String(sessionId || '').replace(/[^A-Za-z0-9-]/g, '');
    if (!sid || !APPDIR_WSL) return { error: 'no session' };
    const messages = await _readTranscript(ws, sid);
    if (!messages) return { error: 'exec' };        // the READ failed — do not report it as an empty session
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
  } catch (err) { return { error: 'could not save the export: ' + String((err && err.message) || err).slice(0, 160) }; }   // err.message (no class-name prefix) — fs errors carry the path+cause
});

// Save a session's transcript as a plain Markdown (.md/.txt) document — same transcript source as the HTML
// replay (transcript.sh), rendered as readable markdown. No server, no HTML; just the conversation.
ipcMain.handle('session:export-text', async (e, arg) => {
  try {
    const sessionId = (arg && typeof arg === 'object') ? arg.id : arg;   // legacy bare-id calls still work
    const ws = _wsById(arg && arg.wsId) || activeWorkspace;              // the ROW's workspace — main's active ws differs while a joined live tab is on screen
    const sid = String(sessionId || '').replace(/[^A-Za-z0-9-]/g, '');
    if (!sid || !APPDIR_WSL) return { error: 'no session' };
    const messages = await _readTranscript(ws, sid);
    if (!messages) return { error: 'exec' };        // the READ failed — do not report it as an empty session
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
  } catch (err) { return { error: 'could not save the export: ' + String((err && err.message) || err).slice(0, 160) }; }   // err.message (no class-name prefix) — fs errors carry the path+cause
});

// The embedded Claude Code CLI version, for the status bar. Resolved once via a tiny cross-backend script and
// cached (it's stable for the app's lifetime); returns '' if claude isn't resolvable so the bar just hides it.
let _claudeVer;   // undefined = not fetched yet
ipcMain.handle('app:version', () => app.getVersion());   // the real Claudible version (package.json) for the status-bar badge — was hardcoded in the HTML
ipcMain.handle('app:buildSha', () => BUILD.short || '');   // the running build's git sha — semver doesn't move between releases, this does
ipcMain.handle('claude:version', () => {
  if (_claudeVer !== undefined) return _claudeVer;
  return new Promise((resolve) => {
    runner.runScript('claude-version.sh', '', { timeout: 8000 }).then(({ err, stdout }) => {
      if (err) console.error('[claudible] claude-version:', err.message);   // cosmetic (the version chip), but never silent
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
    if (fgTabId && ptys.has(fgTabId)) {
      // guardBusy: the sign-in button must not kill a mid-turn Claude on the foreground tab (usually the tab
      // needing re-auth is already dead, but "usually" isn't a guard). Refusal → tell the user instead.
      if (!respawnPty(fgTabId, '', { trustedReroute: true, guardBusy: true })) return { ok: false, error: 'that tab is mid-turn — let it finish (or open a new session), then sign in' };
    } else spawnPty('main', 120, 32, activeWorkspace, '');           // no tab yet → spawn one
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
// Install one dependency. Voice on WIN keeps its proven path (ensureVoiceProvisioned, the native-Windows
// build); on wsl/posix it now goes through deps.install like every other dep (provision.sh's `voice` case,
// which wraps setup.sh) — ensureVoiceProvisioned is a no-op there (guarded on CLAUDIBLE_RUNNER==='win'), so
// routing wsl/posix through it used to silently do nothing: a wizard button that reported success without
// installing anything. On success we persist any portable-fallback env, apply it + refresh PATH live, and
// report whether a restart is needed (Git on win, whose app-dir resolves at require-time).
ipcMain.handle('preflight:install', async (_e, depId) => {
  const id = String(depId || '').replace(/[^a-z]/g, '');
  if (id === 'voice' && runner.id === 'win') { const started = ensureVoiceProvisioned(); return { ok: started || voiceProvisioned(), restartRequired: false }; }
  const send = (m) => { try { win && win.webContents.send('provision', m); } catch {} };
  let res;
  try { res = await deps.install(runner, id, send); } catch (e) { return { ok: false, error: (e && e.message) || 'install failed', restartRequired: false }; }
  if (res.ok) {
    if (res.env && Object.keys(res.env).length) {
      try {
        const s = readSettings();
        s.depEnv = Object.assign({}, s.depEnv, res.env);   // survive a relaunch (re-applied at boot, before APPDIR_WSL)
        writeSettings(s);
      } catch {}
      for (const [k, v] of Object.entries(res.env)) if (typeof v === 'string' && v) process.env[k] = v;
    }
    await refreshWindowsPath();   // async: never block the main process (pty I/O + every poller) on a PowerShell spawn
    if (runner.id === 'win' && typeof runner.resetCaches === 'function') runner.resetCaches();   // re-resolve git-bash/app-dir next call
    // A cloudflared installed MID-SHARE must not wait out the 45s retry cadence: its env/path is applied just
    // above, so the very next candidates() read can see it — bring the tunnel (and with it, presence) up now.
    if (id === 'cloudflared' && share.status().running && !cloudflaredProc) kickTunnelRetryNow();
    // R8: a wsl/posix voice install downloads+builds via setup.sh but starts NOTHING — the wizard row and the
    // topbar chip then say "ready" while Whisper/Kokoro aren't running, and the first Talk/PTT fails with a raw
    // fetch error until the next full relaunch (whose boot path is the only other startVoiceServices caller).
    // Start them here, exactly like the win branch does via ensureVoiceProvisioned's exit handler. Idempotent:
    // services.sh port-checks before spawning, so a re-install with services already up is a no-op.
    if (id === 'voice') startVoiceServices();
  }
  return { ok: res.ok, error: res.error || '', restartRequired: !!res.restartRequired };
});
// Relaunch — the cleanest way to pick up a freshly-installed Git (main.js resolves the app-dir at require-time).
ipcMain.handle('preflight:restart', () => { try { app.relaunch(); app.exit(0); } catch {} return { ok: true }; });
// After the Connect-Claude flow succeeds: if the spawn-gate suppressed the terminal (or it died on a missing
// claude), bring it up now that claude resolves. No-op if a foreground pty is already live (don't disturb it).
// Bring the terminal up once onboarding says Claude is ready. spawnPty NEVER throws for the case that actually
// happens (no node-pty backend) — it writes the reason into the terminal and returns. So `ok` is decided by
// whether a pty is really there afterwards, not by whether the try block completed. It used to return ok:true
// unconditionally, including from inside a swallowed catch.
ipcMain.handle('claude:connected', () => {
  const id = fgTabId || 'main';
  if (ptys.has(id)) { if (!fgTabId) fgTabId = id; return { ok: true }; }   // already running — leave it
  try { spawnPty(id, 120, 32, activeWorkspace, ''); }
  catch (e) { console.error('[claudible] claude:connected:', e.message); return { ok: false, error: 'spawn' }; }
  if (!ptys.has(id)) return { ok: false, error: 'spawn' };
  if (!fgTabId) fgTabId = id;
  return { ok: true };
});
// Focused claude-only status for the Connect-Claude dot + popup. The win runner answers cheaply (no gh network,
// no 6-tool probe — those must not run on every launch / 3s poll); wsl/posix derive it from the full probe.
ipcMain.handle('claude:state', async () => {
  try {
    if (typeof runner.claudeState === 'function') return runner.claudeState();
    const d = await deps.detect(runner, voiceState());
    const c = (d.deps || []).find((x) => x.id === 'claude') || {};
    return { installed: c.state !== 'missing', signedIn: c.state === 'ready' };
  } catch { return { installed: false, signedIn: false }; }
});

// The active session's LATEST assistant reply, so the manual Speak button can re-read it even after a relaunch
// (when the in-memory lastReply is empty) or for a session opened from history. Reads the transcript and returns
// the last 'claude' message's text, or '' if there's genuinely nothing to read.
ipcMain.handle('session:latest-reply', async (e, sessionId) => {
  try {
    const ws = activeWorkspace;
    const sid = String(sessionId || '').replace(/[^A-Za-z0-9-]/g, '');
    if (!sid || !APPDIR_WSL) return { text: '' };
    const messages = (await _readTranscript(ws, sid)) || [];   // a failed read is logged inside; treat as no text
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === 'claude' && m.text && String(m.text).trim()) return { text: String(m.text) };
    }
    return { text: '' };
  } catch (err) { return { text: '', error: String((err && err.message) || err).slice(0, 160) }; }
});

// ---- Diff Review: see what Claude changed in the active workspace's git repo, revert per hunk/file ----
// Refresh a project's `origin/<branch>` ref in the BACKGROUND, so diff.sh can say which commits GitHub already
// has. Deliberately NOT inside diff.sh: that read has a 30s budget the panel waits on, and it must never be
// spent on a network round-trip. This fires alongside the read; the next 4s repaint shows the fresher state.
const _lastFetch = new Map();       // wsId -> ms of the last ATTEMPT (success or failure — a dead remote must throttle too)
const fetchLock = new Set();        // wsId with a fetch in flight
const FETCH_EVERY_MS = 90 * 1000;   // the panel repaints every 4s; the network doesn't need to
function maybeFetch(ws) {
  if (!APPDIR_WSL || !ws || !ws.id || ws.needsClone) return;
  if (fetchLock.has(ws.id)) return;
  if (Date.now() - (_lastFetch.get(ws.id) || 0) < FETCH_EVERY_MS) return;
  _lastFetch.set(ws.id, Date.now());   // stamp + lock BEFORE the await (mirrors syncLock): a 10s fetch must not let the 4s poller stack a queue of them
  fetchLock.add(ws.id);
  runner.runScript('git-fetch.sh', '', { ws, timeout: 15000 })
    .catch(() => {})                   // offline / no upstream / no creds are all normal — the script says so in JSON and never throws
    .then(() => { fetchLock.delete(ws.id); });
}
ipcMain.handle('diff:list', (e, { wsId } = {}) => new Promise((resolve) => {
  if (!APPDIR_WSL) return resolve({ ok: false, repo: false, files: [], untracked: [] });
  const ws = (wsId && _wsById(wsId)) || activeWorkspace;   // Project History can review any project, not just the active one
  maybeFetch(ws);                                          // fire-and-forget; this read uses whatever ref is on disk right now
  runner.runScript('diff.sh', '', { ws, timeout: 30000, maxBuffer: 32 * 1024 * 1024 }).then(({ err, stdout }) => {
      // `err` used to be destructured and dropped: a timeout / crashed script produced no stdout, JSON.parse('{}')
      // succeeded, and the panel showed "no changes" for a repo that was never actually read. Log it and fail loudly.
      if (err) { console.error('[claudible] diff.sh:', err.message); return resolve({ ok: false, repo: true, error: 'diff failed: ' + (err.message || 'exec error'), files: [], untracked: [], committed: [], commits: [] }); }
      let r = null; try { r = JSON.parse(String(stdout).trim() || 'null'); } catch {}
      if (!r || typeof r !== 'object') { console.error('[claudible] diff.sh: unparseable output'); return resolve({ ok: false, repo: true, error: 'diff returned no output', files: [], untracked: [], committed: [], commits: [] }); }
      // An adopted project's ws.repoId (its card's "owner/name ↗" link) was parsed from `origin` at adopt time.
      // It's the USER's repo — they can repoint or remove the remote whenever they like — so re-derive it from
      // what the folder says RIGHT NOW rather than serving a link to a repo they've moved on from.
      if (ws && ws.adopted && typeof r.origin === 'string') {
        const m = GITHUB_REMOTE.exec(r.origin);
        const next = m ? `${m[1]}/${m[2]}` : undefined;
        if (next !== ws.repoId) { if (next) ws.repoId = next; else delete ws.repoId; saveRegistry(); }
      }
      resolve(r);
    });
}));
// Reverse-apply a hunk/file patch, or discard an untracked file. The patch text / target path is written to
// an APP-controlled temp file and only its path is passed to bash (never the repo data) — no injection.
let diffActionSeq = 0;
// ---- one worktree writer at a time, per workspace (lib/keyedQueue.js explains why) -------------------------
// Both queued scripts carry a hard timeout (checkpoint.sh 30s, diff-apply.sh 20s), so a hung script drains the
// queue rather than wedging it. Reads (`diff:list`'s 4s poll, `numstat`) are deliberately NOT queued.
const _repoWrite = makeKeyedQueue();
const withRepoWriteLock = (ws, fn) => _repoWrite.run(ws && ws.id, fn);

// Both modes rewrite the worktree, so they queue behind (and ahead of) checkpoint snapshot/restore for this
// workspace — see withRepoWriteLock. The ws must be resolved BEFORE the lock, or every action would queue on '_none'.
function diffAction(mode, payload, wsId) {
  const lockWs = (wsId && _wsById(wsId)) || activeWorkspace;
  return withRepoWriteLock(lockWs, () => _diffActionNow(mode, payload, lockWs));
}
function _diffActionNow(mode, payload, ws) {
  return new Promise((resolve) => {
    try {
      if (!APPDIR_WSL || typeof payload !== 'string' || !payload) return resolve({ ok: false, error: 'bad args' });
      const name = `diffaction-${process.pid}-${++diffActionSeq}.tmp`;   // unique per action → concurrent revert/discard never read each other's payload (M1)
      const tmp = path.join(RT, name);
      fs.writeFileSync(tmp, payload, 'utf8');
      runner.runScript('diff-apply.sh', `${mode} '${RT_GUEST}/${name}'`, { ws, timeout: 20000 }).then(({ err, stdout }) => {
          try { fs.unlinkSync(tmp); } catch {}   // clean up the temp patch file
          // The pre-initialized `{ok:false}` means the caller still sees a failure — but the REASON was never
          // logged, unlike every sibling handler. A revert that silently stops working leaves no trace to chase.
          if (err) { console.error(`[claudible] diff-apply (${mode}):`, err.message); return resolve({ ok: false, error: 'exec' }); }
          let r = { ok: false }; try { r = JSON.parse(String(stdout).trim() || '{}'); } catch { console.error('[claudible] diff-apply: unparseable output'); }
          resolve(r);
        });
    } catch (err) { console.error('[claudible] diffAction:', err && err.message); resolve({ ok: false, error: 'apply' }); }
  });
}
// Payload is {patch|relPath, wsId}; tolerate a bare string (a not-yet-reloaded renderer) → falls back to active ws.
ipcMain.handle('diff:revert', (e, a) => diffAction('apply-reverse', typeof a === 'string' ? a : (a && a.patch), a && a.wsId));
ipcMain.handle('diff:discard', (e, a) => diffAction('discard', typeof a === 'string' ? a : (a && a.relPath), a && a.wsId));

// ---- Session history: the append-only activity log behind the Repo Review feed + revert ----
// Gated on the sessionHistory setting (default ON since 61edcf1). The MAIN process stamps id/seq/author/machine
// server-side (renderer supplies only the raw prompt) and persists per-workspace under
// RT/history/<wsId>.json (main-owned, always writable, survives upgrades). Pure logic lives in lib/.
const _hist = require('./lib/history.js');
const _identity = require('./lib/identity.js');
const _histStore = require('./lib/historyStore.js');
const _os = require('os');
function _histEnabled() { return readSettings().sessionHistory !== false; }   // default ON (shipped after the multiplayer sync + smoke pass); explicit false = off. Must mirror the renderer's toggle-init read.
function _machineId() {
  try {
    const f = path.join(app.getPath('home'), '.claudible', 'machine-id');
    try { const v = fs.readFileSync(f, 'utf8').trim(); if (v) return v; } catch {}
    const id = require('crypto').randomUUID();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, id); fs.renameSync(tmp, f);   // atomic: this file has TWO writers (here + wsl/sessions-sync.sh) that can race on first boot; a plain writeFileSync could tear
    try { const v = fs.readFileSync(f, 'utf8').trim(); if (v) return v; } catch {}             // re-read so concurrent creators converge on whoever won the rename
    return id;
  } catch { return ''; }
}
function _histFile(wsId) {
  const dir = path.join(PERSIST, 'history'); try { fs.mkdirSync(dir, { recursive: true }); } catch {}   // R4: user history survives a reinstall
  return path.join(dir, String(wsId || 'default').replace(/[^A-Za-z0-9_-]/g, '-') + '.json');
}

// ---- app→Claude identity/live-state channel: per-tab context.json read by the context hook, so the model
// ALWAYS knows which machine/user it's on and the live-session state — even after a transcript synced from a
// collaborator's machine (the hook also resolves ground-truth host/user itself; this adds what the shell can't
// know: the collab display name + live-session role). Written on spawn + every live-state transition.
let _lastRoster = [];                                     // cache the host roster main forwards, so context.json can name who's here
// The live-state main can meaningfully inject is HOSTING: the foreground tab, while sharing, runs the LOCAL Claude
// that guests drive — so telling that Claude "you're hosting, N guests (names)" is real and reachable. A JOINED tab
// is only a mirror of a PEER's session: there's no local Claude to inform (the model you talk to there is the
// host's, which already gets the hosting context on THEIR machine), so we don't fabricate a local 'joined' block.
// When hosting stops, this returns null → the model correctly reads "solo" from the absence of a live line.
function _liveStateFor(tabId) {
  try {
    if (tabId === mirrorTabId() && share.status && share.status().running) {   // the SHARED (pinned) tab while sharing → I'm HOSTING; the host's other tabs stay solo
      const st = share.status();
      const names = _lastRoster.filter((g) => g && g.state !== 'gone' && !g.host).map((g) => g.name).filter(Boolean);
      return { role: 'hosting', session: advertisedSid || '', guests: st.guests || names.length || 0, names };
    }
  } catch {}
  return null;                                            // solo/local (or a joined mirror tab) → no live block
}
function _writeContext(tabId) {
  try {
    const rec = ptys.get(tabId); if (!rec) return;
    const s = readSettings();
    const ctx = {
      collabName: (s.collabName || '').toString().slice(0, 60),
      workspace: rec.ws ? ((rec.ws.label || rec.ws.slug || '') + (rec.ws.kind && rec.ws.kind !== 'legacy' ? ' (' + rec.ws.kind + ')' : '')) : '',
      machineId: _machineId(), host: _os.hostname(), os: process.platform,
      runner: runner.id,   // flavor (wsl | win | posix) — ONLY main knows this; the hook can't sniff it from env
      live: _liveStateFor(tabId),
      // Who typed the in-flight prompt: a co-driving guest (set on their keystrokes, cleared by any host
      // keystroke / foreground switch). The hook treats it as guest-authored only while fresh (<20s) AND hosting.
      typedBy: (rec.lastInputBy && rec.lastInputBy.name) ? { name: String(rec.lastInputBy.name).slice(0, 60), ts: rec.lastInputBy.ts } : null,
      ts: Date.now(),
    };
    const dir = path.join(RT, 'tabs', rec.runtimeId); try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const file = path.join(dir, 'context.json');
    try { atomicWriteJson(fs, file, ctx, 0); } catch {}   // atomic: the hook never reads a half-written file
  } catch {}
}
function _writeAllContexts() { try { for (const id of ptys.keys()) _writeContext(id); } catch {} }   // a global live-state change (share start/stop, roster) touches every tab's file
// ---- per-prompt code checkpoints: the snapshot layer behind the Session-History "Revert" (pure lib/checkpoint.js,
// run in the workspace repo via wsl/checkpoint.sh). We snapshot the repo when a turn ENDS (Stop → the tree has
// settled, so no edit races the snapshot) and carry that ref as the NEXT prompt's checkpointRef — so "revert
// prompt N" restores the code as it was going INTO N. Gated on the SAME sessionHistory setting → zero cost when off.
const _pendingCkpt = new Map();          // wsId -> latest settled checkpoint id (attached to the next prompt's entry)
const _ckptIdRe = /^[A-Za-z0-9_-]{1,64}$/;
// Every checkpoint operation funnels through here: snapshot-on-stop, seed, revert, undo, prune. It used to drop
// `err` on the floor and resolve(null) — so a checkpoint.sh that started failing (corrupt .git, disk full, no
// permission) produced NOTHING: `_snapshotOnStop` and `_seedCkpt` run automatically after every turn and silently
// `return` on a null result. The whole session-history Revert feature could go dark for an entire session with
// zero trace anywhere — no console line, nothing surfaced. Log the reason; the callers still see null.
const _CKPT_WRITES = /^(snapshot|restore)\b/;        // `prune` only touches refs; `numstat`/`list` are reads

function _ckptRun(ws, argStr) {
  if (_CKPT_WRITES.test(String(argStr))) return withRepoWriteLock(ws, () => _ckptRunNow(ws, argStr));
  return _ckptRunNow(ws, argStr);
}
function _ckptRunNow(ws, argStr) {
  return new Promise((resolve) => {
    if (!APPDIR_WSL || !ws) return resolve(null);
    runner.runScript('checkpoint.sh', argStr, { ws, timeout: 30000, maxBuffer: 8 * 1024 * 1024 })
      .then(({ err, stdout }) => {
        if (err) { console.error(`[claudible] checkpoint.sh (${String(argStr).split(' ')[0]}):`, err.message); return resolve(null); }
        let r = null; try { r = JSON.parse(String(stdout).trim() || 'null'); } catch {
          console.error(`[claudible] checkpoint.sh (${String(argStr).split(' ')[0]}): unparseable output`);
        }
        resolve(r);
      })
      .catch((e) => { console.error('[claudible] checkpoint.sh threw:', e && e.message); resolve(null); });
  });
}
function _wsById(wsId) { try { return registry.workspaces.find((w) => w && w.id === wsId) || null; } catch { return null; } }
// Turn ended → snapshot the settled worktree; on success it becomes the next prompt's checkpointRef, then prune any
// snapshot the newest-10 ring no longer references (bounds .git growth on a busy repo).
function _snapshotOnStop(tabId) {
  try {
    if (!_histEnabled()) return;                                     // feature off → never touch the repo
    const rec = ptys.get(tabId); const ws = rec && rec.ws;
    if (!ws || !ws.id || (ws.kind && ws.kind !== 'repo')) return;    // only repo workspaces have git to snapshot
    // The entry this turn belongs to, captured SYNCHRONOUSLY at Stop-fire time. Match on THIS tab's session,
    // newest-first — two tabs in one repo workspace share the ws's single history log, so blindly taking the
    // last row would stamp tab A's "N files (+x/-y)" onto tab B's just-appended entry (audit finding). A
    // brand-new session (no id yet) has no match → fall back to the newest row (single-session case, unchanged).
    let turnEntry = null;
    try {
      const log = _histStore.load(fs, _histFile(ws.id));
      const sess = rec && rec.session ? String(rec.session) : '';
      if (sess) { for (let i = log.length - 1; i >= 0; i--) { if (String(log[i].session || '') === sess) { turnEntry = log[i]; break; } } }
      if (!turnEntry) turnEntry = log.length ? log[log.length - 1] : null;
    } catch {}
    // Invalidate the pending ref SYNCHRONOUSLY, before the async snapshot runs. history:append reads _pendingCkpt at
    // the NEXT UserPromptSubmit; if the user fires that before this snapshot resolves, they now get NO checkpoint
    // (null → no Revert button) instead of the PREVIOUS turn's ref — which would silently over-revert past a whole
    // turn's edits. Fail-safe to null; the ref is filled in once the snapshot lands.
    _pendingCkpt.set(ws.id, null);
    const id = require('crypto').randomUUID();
    _ckptRun(ws, 'snapshot ' + id).then((r) => {
      if (!r || !r.ok || !r.sha) return;
      _pendingCkpt.set(ws.id, id);
      // Stamp the turn's entry with its file stats: diff(state going INTO the prompt → the settled state now).
      // Best-effort — a null/pruned 'from' ref just means no stats (files stays []), never an error.
      if (turnEntry && turnEntry.checkpointRef && _ckptIdRe.test(turnEntry.checkpointRef) && turnEntry.checkpointRef !== id) {
        _ckptRun(ws, 'numstat ' + turnEntry.checkpointRef + ' ' + id).then((n) => {
          try {
            if (!n || !n.ok || !Array.isArray(n.files)) return;
            const log = _histStore.load(fs, _histFile(ws.id));
            const en = log.find((x) => x.id === turnEntry.id);
            if (!en) return;
            en.files = n.files.slice(0, 500);   // bound a pathological turn (mass rename) — the feed only sums these
            _histStore.save(fs, _histFile(ws.id), log);
            _pushHistoryEntryToShare(ws.id, en);   // guests' feeds pick up the "3 files (+42/-10)" line live
          } catch {}
        });
      }
      try {
        const keep = _histStore.load(fs, _histFile(ws.id)).slice(-10).map((en) => en.checkpointRef).filter((x) => x && _ckptIdRe.test(x));
        keep.push(id);
        _ckptRun(ws, 'prune ' + keep.join(' '));
      } catch {}
    });
  } catch {}
}
// First-prompt revertability: _pendingCkpt is in-memory only, so the first prompt after an app start, a
// session (re)spawn, or turning the setting on carried checkpointRef=null (no Revert button) until one full
// turn completed. Seed a settled snapshot when a repo workspace's session comes up and no ref is pending.
// Guarded fill: a Stop-cycle snapshot landing mid-seed wins — never stomp a newer ref with the seed.
function _seedCkpt(ws) {
  try {
    if (!_histEnabled() || !ws || !ws.id || (ws.kind && ws.kind !== 'repo')) return;
    if (_pendingCkpt.get(ws.id)) return;                             // a live ref already covers the next prompt
    const id = require('crypto').randomUUID();
    _ckptRun(ws, 'snapshot ' + id).then((r) => {
      if (!r || !r.ok || !r.sha) return;
      if (!_pendingCkpt.get(ws.id)) _pendingCkpt.set(ws.id, id);
    });
  } catch {}
}
ipcMain.handle('history:load', (e, arg) => {
  try {
    if (!_histEnabled()) return { ok: true, enabled: false, entries: [] };   // off = off for reads too: don't surface entries from a previously-enabled period
    const reqWs = arg && arg.wsId ? _wsById(arg.wsId) : null;   // Project History loads a chosen project's feed; default = active
    const wsId = (reqWs && reqWs.id) || (activeWorkspace && activeWorkspace.id) || 'default';
    return { ok: true, enabled: true, wsId, machineId: _machineId(), entries: _histStore.load(fs, _histFile(wsId)) };   // wsId = the workspace these entries belong to, so the renderer reverts against IT; machineId lets the feed hide Revert on entries authored elsewhere (their snapshot refs don't travel)
  } catch (e) { return { ok: false, enabled: false, entries: [], error: String(e) }; }
});
// Revert the entry's workspace repo to the code state captured at that prompt (its checkpointRef). checkpoint.sh
// snapshots the CURRENT tree to an 'undo' ref FIRST, so the revert is reversible. Worktree-only — it does NOT
// rewind commits (the renderer's confirm dialog says so). 'undo' is not a valid revert target here (use checkpoint:undo).
// `restore` OVERWRITES worktree files and deletes anything added since the checkpoint. Both handlers below are
// unreachable for a non-repo workspace today — only _snapshotOnStop/_seedCkpt mint a checkpointRef, and both bail
// on `kind !== 'repo'`, so restore() finds no ref and returns {ok:false}. But that's a guard living in a *different
// function*: the day someone snapshots an adopted folder, the destructive call here would silently start firing on
// the user's real source tree. Every other destructive path in this app checks at the call site. So does this one.
const _ckptAllowed = (ws) => !!ws && (!ws.kind || ws.kind === 'repo');   // matches _snapshotOnStop / _seedCkpt exactly (legacy ws has no kind)
ipcMain.handle('checkpoint:revert', (e, { id, wsId } = {}) => new Promise((resolve) => {
  if (!_histEnabled()) return resolve({ ok: false, error: 'disabled' });
  const cid = String(id || '');
  if (!_ckptIdRe.test(cid) || cid === 'undo') return resolve({ ok: false, error: 'bad id' });
  const ws = _wsById(wsId) || activeWorkspace;
  if (!_ckptAllowed(ws)) return resolve({ ok: false, error: 'checkpoints are only kept for repo projects' });
  _ckptRun(ws, 'restore ' + cid).then((r) => resolve(r || { ok: false, error: 'revert failed' }));
}));
ipcMain.handle('checkpoint:undo', (e, { wsId } = {}) => new Promise((resolve) => {
  if (!_histEnabled()) return resolve({ ok: false, error: 'disabled' });
  const ws = _wsById(wsId) || activeWorkspace;
  if (!_ckptAllowed(ws)) return resolve({ ok: false, error: 'checkpoints are only kept for repo projects' });
  _ckptRun(ws, 'restore undo').then((r) => resolve(r || { ok: false, error: 'undo failed' }));
}));
ipcMain.handle('history:append', (e, payload) => {
  try {
    if (!_histEnabled()) return { ok: false, disabled: true };
    const prompt = (payload && typeof payload.prompt === 'string' ? payload.prompt : '').slice(0, 8000);   // cap stored prompt: ring caps count (10) but not bytes; bounds a huge paste
    if (!prompt.trim()) return { ok: false, error: 'empty' };
    const wsId = (payload && payload.wsId) ? String(payload.wsId) : ((activeWorkspace && activeWorkspace.id) || 'default');   // the SUBMITTING tab's workspace, not global active — avoids a workspace-switch race writing to the wrong file (_histFile sanitizes the key)
    const file = _histFile(wsId);
    const log = _histStore.load(fs, file);
    const seq = log.reduce((m, x) => Math.max(m, x.seq | 0), 0) + 1;
    const s = readSettings();
    // Attribution: a guest co-driving types into the FOREGROUND pty; if that just happened for THIS
    // session, credit them, else the host. Recency + one-shot consume so the host's next prompt reverts,
    // and the session guard keeps a background tab's prompt from being credited to a foreground guest.
    let author = _identity.resolveAuthor({ username: s.collabName, fallback: 'host' });
    try {
      // Credit a co-driving guest from the SUBMITTING tab's OWN record. lastInputBy can only ever exist on a
      // tab guests actually typed into (onInput writes it exclusively to the mirrored tab, and any host
      // keystroke on that same tab clears it), so the record itself is the evidence — no comparison against
      // the CURRENT mirror needed. The old mirrorTabId() gate flipped to the host's foreground the instant
      // share:stop un-pinned, silently mis-crediting the HOST for a guest prompt still in flight at
      // end-of-session (audit finding). Recency + one-shot consume unchanged.
      let fr = (payload && payload.tabId != null) ? ptys.get(payload.tabId) : null;
      if (!fr && payload && payload.tabId != null) { for (const [k, v] of ptys) { if (String(k) === String(payload.tabId)) { fr = v; break; } } }   // type-safe fallback (IPC ids are same-typed today; keep the delete-path parity)
      if (fr && fr.lastInputBy && (Date.now() - fr.lastInputBy.ts) < 15000) {
        author = _identity.resolveAuthor({ username: fr.lastInputBy.name, fallback: author });
        fr.lastInputBy = null;
      }
    } catch {}
    const entry = _hist.makeEntry({
      id: require('crypto').randomUUID(),
      seq, ts: Date.now(),
      author,
      machine: _identity.machineRecord({ savedId: _machineId(), host: _os.hostname(), os: process.platform }),
      session: payload && payload.session ? String(payload.session) : '',
      prompt,
      checkpointRef: _pendingCkpt.get(wsId) || null,   // the settled snapshot from the previous turn = the code state going INTO this prompt (null until the first turn ends → that prompt gets no revert target)
    });
    _histStore.append(fs, file, entry);
    _pushHistoryEntryToShare(wsId, entry);   // live guests see the new prompt in their feed immediately
    return { ok: true, entry };
  } catch (err) { console.error('[claudible] history:append:', err && err.message); return { ok: false, error: 'append' }; }
});

// Safety net: never let a stray error from a pty/agent take the whole cockpit down.
process.on('uncaughtException', (e) => console.error('[claudible] uncaughtException:', e && e.message));
process.on('unhandledRejection', (e) => console.error('[claudible] unhandledRejection:', e && (e.message || e)));

// Startup sweep: every dir under runtime/tabs/ is a DEAD generation at this point (no tabs exist yet) —
// left by the previous run or a crash. Reap each one's possibly-still-alive WSL-side tree (boot.pid +
// killtree's recycled-pid guard make this safe), then drop the dir. This is what finally retires zombies
// that survived a force-kill of the whole app.
function reapDeadGenerations() {
  try {
    const dir = path.join(RT, 'tabs');
    for (const name of fs.readdirSync(dir)) {
      if (!/^[A-Za-z0-9-]+$/.test(name)) continue;
      _killSessionTree(name);
      setTimeout(() => { try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); } catch {} }, 3000);
    }
  } catch {}
}
// Update check — the smallest honest fix for "an installed build can NEVER receive a fix today" (no
// auto-update exists; a distributed Setup exe sits stale until the user happens to re-download). Packaged
// builds ask GitHub for the latest release ONCE per launch, off the critical path, and merely TELL the user;
// nothing downloads or installs itself. Fails silent by design: offline, rate-limited, or a private repo
// (pre-public beta) all just skip the notice.
function checkForUpdate() {
  if (!app.isPackaged) return;
  try {
    const https = require('https');
    const req = https.get({
      host: 'api.github.com', path: '/repos/thecrazydev1/claudible/releases/latest',
      headers: { 'User-Agent': 'claudible-update-check', Accept: 'application/vnd.github+json' }, timeout: 8000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return; }
      let body = '';
      res.on('data', (d) => { body += d; if (body.length > 262144) req.destroy(); });
      res.on('end', () => {
        try {
          const latest = String((JSON.parse(body).tag_name || '')).replace(/^v/, '');
          const mine = app.getVersion();
          if (!/^\d+\.\d+\.\d+$/.test(latest) || latest === mine) return;
          // Numeric semver compare — notify only when latest is genuinely NEWER (a dev build ahead of the tag must not nag).
          const nl = latest.split('.').map(Number), nm = mine.split('.').map(Number);
          const newer = nl[0] !== nm[0] ? nl[0] > nm[0] : nl[1] !== nm[1] ? nl[1] > nm[1] : nl[2] > nm[2];
          if (newer) winSend('update:available', { latest, mine });
        } catch {}
      });
    });
    req.on('error', () => {});
    req.on('timeout', () => { try { req.destroy(); } catch {} });
  } catch {}
}
// R32: ONE instance. A second launch (double-clicked shortcut, a launcher retry) used to boot a full second
// app: two voice-service owners racing the ports (the exact double-spawn 59c407d's single-owner rule closed —
// resurrected between processes), two pollers over one runtime dir, two sync engines over one branch. The
// second instance now defers to the first, which just re-surfaces its window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { try { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } } catch {} });
  app.whenReady().then(() => { reapOrphanCloudflared(); reapDeadGenerations(); createWindow(); setTimeout(checkForUpdate, 15000); });
}
// THE full exit teardown, shared by the normal quit path and the self-update restart. Every block is
// independently idempotent; app.exit()/app.relaunch() bypass window-all-closed entirely (Electron emits no
// before-quit/will-quit for app.exit), so any exit path that isn't the ordinary window close MUST call this
// itself or ptys leak, presence stays advertised for the full TTL, and cloudflared is orphaned.
let _quitting = false;   // set by teardownForExit — a probe mid-await when the window closed must not re-arm or spawn
function teardownForExit() {
  _quitting = true;
  try { for (const t of _beaconTimers.values()) clearTimeout(t); _beaconTimers.clear(); _beaconLive.clear(); } catch {}
  try { for (const t of appIntervals) clearInterval(t); appIntervals.length = 0; } catch {}   // tear down pollers so none fire against a destroyed window (H3)
  try { for (const k of Object.keys(appTimers)) { if (appTimers[k]) clearTimeout(appTimers[k]); appTimers[k] = null; } } catch {}   // …and the self-rescheduling ones (sync/workflow/trash + the tunnel-retry)
  // The FULL live teardown — including presence-clear, which this path used to skip entirely: quitting while
  // hosting left live/<login>.json on the branch, so collaborators saw "live · Join" for up to 5 minutes after
  // the app was gone. quitting:true makes the clear a DETACHED one-shot — a non-detached child (the old default
  // here) could die with the app before its push landed, silently reverting this exact bug to the 2-min TTL.
  // A live link dies with the process: cloudflared is killed below and a trycloudflare URL is single-use, so
  // the link the host already pasted to a collaborator is dead the moment we exit. That was invisible — the
  // host handed out a URL and both ends just saw a connection failure. Record it so the next boot can say so.
  try { if (share.status().running) writeSettings(Object.assign(readSettings(), { shareEndedByExit: Date.now() })); } catch {}
  try { stopLiveSharing({ quitting: true }); } catch {}
  // Kill Windows-side ptys AND reap each WSL-side tree — the execFile'd wsl.exe survives our exit, so the
  // reap completes even though the app is quitting (this is how zombies stopped accumulating across restarts).
  try { for (const rec of ptys.values()) { try { rec.proc.kill(); } catch {} _killSessionTree(rec.runtimeId); } ptys.clear(); } catch {}
  try { for (const id of [...liveTabs.keys()]) liveDisconnect(id); } catch {}   // close any joined peer sockets
  try { cloudflaredProc && cloudflaredProc.kill(); } catch {}
}
app.on('window-all-closed', () => {
  teardownForExit();
  app.quit();
});
