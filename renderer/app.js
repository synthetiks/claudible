// Claudible — renderer controller.
'use strict';
const $ = (id) => document.getElementById(id);
const setDot = (id, cls) => { const e = $(id); if (e) e.className = 'dot' + (cls ? ' ' + cls : ''); };
const setActive = (id, on) => { const e = $(id); if (e) e.classList.toggle('active', on); };
// transient toast (button feedback / coming-soon placeholders)
function toast(msg) {
  let t = $('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}
// Map internal error CODES (from main.js / the wsl scripts) to plain-English sentences so a toast never shows a
// raw code like 'bad handle' or a raw JS exception. Already-human messages (a space, sane length, no JSON/stack
// junk) pass through unchanged; anything else becomes a generic line.
function humanError(code) {
  const map = {
    exec: 'the backend command could not run', parse: 'could not read the response',   // "WSL" was wrong on macOS/Linux, where there is no WSL
    'bad handle': 'that live link looks invalid', 'bad url': 'that live link looks invalid',
    'bad token': 'that live link looks invalid', 'bad id': 'that item could not be found',
    'not live': "you're not sharing a live session right now", 'bad workspace': 'that project is not available',
    'bad ws': 'that project is not available', 'bad args': 'invalid request', 'bad slug': 'that name is not allowed',
    // the workspace scripts' refusals — 'bad dir' is the one a user can actually trigger, by picking a folder
    // whose path holds a quote, a backslash or a control byte (see lib/pathSafe.js)
    'bad dir': 'that folder’s path contains a quote, a backslash or a line break — Claudible can’t use it',
    'bad owner': 'that GitHub owner name is not valid', 'bad kind': 'invalid request',
    apply: 'could not apply that change', 'stopped during start': 'sharing was stopped while it was starting',
    'push failed': 'could not reach the server — check your connection', 'pull failed': 'could not reach the server — check your connection',
    full: 'the session is full', 'not found': 'not found', unknown: 'something went wrong',
    // session:resolveDiverged refuses to overwrite a transcript that's being written right now
    live: 'that session is live — end the live session first',
    // TWO different locks, so two different codes. `busy` = a Claude turn is mid-flight in some tab (main's
    // authoritative rec.busy). `sync-busy` = a git sync already holds this workspace's lock. They used to share
    // the string 'busy', so a contended sync told the user to "wait for the turn to finish" — on a session that
    // wasn't running. Whichever sentence you got depended on which guard fired first.
    busy: 'that session is still running — wait for the turn to finish',
    'sync-busy': 'a sync is already running for this project',
    spawn: 'Claude could not be started', clipboard: 'could not write to the clipboard',
  };
  const c = String(code == null ? '' : code).trim();
  if (map[c]) return map[c];
  if (/\s/.test(c) && c.length <= 120 && !/[{}<>]|Error:|\bat .*:\d|\bE[A-Z]{3,}\b|Cannot read prop/.test(c)) return c;   // already a human sentence → keep it (but never a raw node/JS exception)
  return 'something went wrong';
}
// Installer/provisioner error text for the UI (R18). A script's OWN error is a curated, actionable sentence —
// often a full copy-paste command — so it shows in FULL, however long: the opposite of humanError's job. The ONE
// thing to intercept is the raw Node exec-crash string ("Command failed: <cmd> <args…>"): pure internals, emitted
// only when the child died before producing its JSON (network timeout, killed wrapper). This filter used to guard
// one of the three surfaces that show install errors; it is the single shared helper for all of them now.
function installErrText(raw) {
  const s = String(raw == null ? '' : raw);
  if (/^Command failed:/.test(s)) return 'Could not reach the installer — check your network connection and try again.';
  return s || 'Install failed — retry, or Skip for now.';
}
// Log uncaught renderer errors to the console (mirrored to .claudible-debug.log in DEBUG builds). No user-facing
// error toast — end users should never see raw JS error text.
window.addEventListener('error', (e) => { try { console.error('[uncaught]', (e && e.message) || e, (e && e.filename || '') + ':' + (e && e.lineno)); } catch (x) {} });
window.addEventListener('unhandledrejection', (e) => { try { const r = e && e.reason; console.error('[unhandledrejection]', (r && (r.stack || r.message)) || r); } catch (x) {} });

// ---------- embedded live TUI (one xterm per tab; only the foreground tab's container is visible) ----------
const BASE_LH = 1.15;   // terminal line-height
const TERM_OPTS = {
  fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Mono", Consolas, monospace',
  fontSize: 13, lineHeight: BASE_LH, cursorBlink: true, scrollback: 5000,
  theme: { background: '#0b0c10', foreground: '#dce1e8', cursor: '#cbd2dc',
           selectionBackground: '#272c35', selectionInactiveBackground: 'rgba(0,0,0,0)', black: '#070809', brightBlack: '#565c66' },
};
const tabs = new Map();           // tabId -> per-tab record (own xterm/fit/container + tracker/agents)
let activeTabId = null;

// ---------- themes: re-tint the UI (CSS :root vars via html[data-theme]) + the xterm terminal palette ----------
// Dark = default (no data-theme attr). The UI palettes live in index.html (html[data-theme="…"]); these are the
// matching TERMINAL palettes. applyTheme also updates TERM_OPTS so newly-spawned tabs adopt the chosen palette.
const TERM_THEMES = {
  // selectionInactiveBackground = TRANSPARENT on purpose: when the terminal is UNFOCUSED (you scrolled up via the
  // gutter, or clicked away), a lingering text selection must show NO highlight — otherwise it rendered as a band
  // at the top of the scrollback (xterm's default is a ~#3a3d41 grey; even a themed color still read as a "weird
  // highlighted line"). The ACTIVE selection (selectionBackground) still shows while you're actually selecting.
  dark:      { background: '#0b0c10', foreground: '#dce1e8', cursor: '#cbd2dc', selectionBackground: '#272c35', selectionInactiveBackground: 'rgba(0,0,0,0)', black: '#070809', brightBlack: '#565c66' },
  graphite:  { background: '#13161d', foreground: '#e9edf4', cursor: '#cfd8e4', selectionBackground: '#313846', selectionInactiveBackground: 'rgba(0,0,0,0)', black: '#0e1116', brightBlack: '#6b7482' },
  starlight: { background: '#1c212a', foreground: '#f4f7fc', cursor: '#dde4ee', selectionBackground: '#3e4756', selectionInactiveBackground: 'rgba(0,0,0,0)', black: '#171b22', brightBlack: '#808a99' },
  midnight:  { background: '#0a1426', foreground: '#d6e4f6', cursor: '#a9c6ee', selectionBackground: '#214264', selectionInactiveBackground: 'rgba(0,0,0,0)', black: '#060d1c', brightBlack: '#566a90' },
  aurora:    { background: '#0f0a22', foreground: '#e6dff6', cursor: '#c3aef0', selectionBackground: '#2f2358', selectionInactiveBackground: 'rgba(0,0,0,0)', black: '#0b0818', brightBlack: '#6b5e8c' },
  evergreen: { background: '#081610', foreground: '#d8efe1', cursor: '#a6dcbb', selectionBackground: '#1b4129', selectionInactiveBackground: 'rgba(0,0,0,0)', black: '#050d09', brightBlack: '#517d64' },
};
function applyTheme(name) {
  const t = TERM_THEMES[name] ? name : 'dark';
  if (t === 'dark') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  try { TERM_OPTS.theme = TERM_THEMES[t]; } catch {}                              // new tabs spawn with this palette
  for (const r of tabs.values()) { try { r.term.options.theme = TERM_THEMES[t]; } catch {} }   // retint live terminals
}
let term;                         // ALWAYS points at the ACTIVE tab, so the 40+ foreground term.* sites need no change (fitting is per-tab via rec.fit / sync(), not a global)
let tabSeq = 0;
const newTabId = () => 'tab-' + (++tabSeq);
// Declared here (not in the sessions section) so the tab-strip boot below can reference them safely:
let activeSession = null;                       // the ACTIVE tab's session id (mirrors AT().session) — drives sidebar row highlight
// Collaborators' live sessions, cached PER WORKSPACE: wsId -> peers[]. Keyed by project so (a) a peer can never be
// read for a project it wasn't discovered in — the phantom "Live session in a LOCAL project" bug — and (b) we can
// hold presence for SEVERAL projects at once: the active one AND every expanded one. Polling only the active
// project was why a collaborator going live/offline in a project you were merely looking at (not active in) froze
// on screen until you clicked into it. pollLivePeers is the ONE writer; peersForWs the ONE reader; contract check
// 12 enforces both. The per-peer wsId stamp is kept as belt-and-suspenders so a mis-bucketed entry is still inert.
let livePeersByWs = new Map(), livePeersSig = '', advertisedSession = null;
const LIVE_TTL_S = 120;   // a stamp older than this is aged out (host re-stamps every ~45s); MUST match wsl/sessions-sync-tool.js LIVE_TTL
// Sessions a JOINED tab's OWN socket already proved offline (the host ended). Suppressed from the badge instantly,
// ahead of the ~10s git poll / TTL — see setLiveState. Value = when it was marked (ms): the suppression self-clears
// once git presence ALSO shows the session gone, and — as a guaranteed exit — after DEAD_SUPPRESS_MS regardless,
// so a session that is genuinely re-hosted with the same handle (git never drops it) can never stay hidden forever.
const deadPeerSessions = new Map();
const DEAD_SUPPRESS_MS = 30000;   // ≥ the host's clear-retry window (~30s), so the git-absence path normally wins first
// The peers that legitimately speak for `wsId` — bucketed by project AND filtered by the per-peer stamp; a session
// our own socket proved dead is hidden even if lagging git presence still lists it. Unstamped/foreign = inert.
function peersForWs(wsId) { return wsId ? (livePeersByWs.get(wsId) || []).filter((p) => p && p.wsId === wsId && !deadPeerSessions.has(p.session)) : []; }
let remoteTitles = {}, titlesSig = '', lastTitlePoll = 0;   // session names shared across the project (id -> {n,ts} since the newest-wins upgrade; legacy caches may still hold bare strings), polled from the branch
// The shared-title maps carry {n,ts} (new) or a bare string (legacy cache) — read through these everywhere.
const titleVal = (v) => (v && typeof v === 'object') ? (v.n || '') : (v || '');
// Branch entries stamp SECONDS (python int(time.time()) parity); local renames stamp Date.now() ms.
// Normalize everything to ms here so newest-wins comparisons are unit-safe.
const titleTs = (v) => { const t = (v && typeof v === 'object') ? Number(v.ts) : 0; return t > 0 ? (t < 1e12 ? t * 1000 : t) : 0; };
let workspaces = [], activeWsId = 'legacy';     // the sidebar library = the active tab's workspace
let sidebarReady = false;                        // set true once the sessions/workspace section has initialized (TDZ guard for the boot tab)
function AT() { return tabs.get(activeTabId) || null; }
const termHost = $('terminal');   // wrapper; each tab's xterm mounts in its own .term-host child of this
// Create a tab's xterm + fit + mount div (hidden until activated). wsId/session bind its pty.
function makeTab(tabId, wsId, session, opts) {
  opts = opts || {};
  const kind = opts.kind || 'local';                           // 'local' = own pty · 'live' = mirror of a peer's session
  const container = document.createElement('div');
  container.className = 'term-host'; container.dataset.tab = tabId;
  termHost.appendChild(container);
  const t = new Terminal(TERM_OPTS);
  const f = new FitAddon.FitAddon();
  t.loadAddon(f); t.open(container);
  // SHARED SCROLL (deliberate, chosen over per-viewer isolation): a live session's screen is ONE view — the
  // full-screen TUI keeps its scroll state in the host's pty, so anyone scrolling repaints it for everyone,
  // exactly like typing. Stock xterm wheel everywhere: in the TUI (alt buffer + mouse reports) the wheel
  // becomes scroll bytes that page the SHARED view; in a normal-buffer shell it moves this viewer's own local
  // scrollback (emits nothing). A read-only viewer's wheel bytes are refused at the input chokepoints below,
  // same as their keystrokes — look, don't drive.
  // The handler always returns true (stock processing) — it only keeps the gutter's position ESTIMATE
  // (rec.altFrac) tracking this viewer's own wheel in a full-screen app, where xterm has no scrollback for the
  // thumb to map (a wheel report scrolls a few lines ≈ a third of a Page key's nudge). Skipped for a read-only
  // viewer, whose wheel bytes are refused — their estimate must not move for scrolls that never happen.
  t.attachCustomWheelEventHandler((ev) => {
    if (ev && t.buffer.active && t.buffer.active.type === 'alternate') {
      const r = tabs.get(tabId);
      if (r && canPageShared(r)) {
        r.altFrac = Math.max(0, Math.min(1, (r.altFrac || 0) + (ev.deltaY < 0 ? 1 : -1) * (ALT_PAGE / 3)));
        if (tabId === activeTabId) updateScrollbar();
      }
    }
    return true;
  });
  if (kind === 'live') {
    t.onData((d) => {
      const r = tabs.get(tabId); if (!r || r.liveReadOnly) return;
      if (d) claudible.liveInput(tabId, d);             // co-drive: keystrokes AND scroll bytes → the peer's terminal (shared view, shared scroll)
    });
  } else t.onData((d) => claudible.ptyInput(tabId, d));          // keystrokes → THIS tab's pty
  t.onScroll(() => { if (tabId === activeTabId) updateScrollbar(); });
  const rec = { tabId, term: t, fit: f, container, started: false, kind, peer: opts.peer || null, wsId: wsId || null, session: session || '', altFrac: 0,
    baseCost: null, lastCostUsd: null, sessTok: 0, lastUsageKey: null, curCtxPct: null, curSessionLabel: '',
    agents: new Map(), workflows: [], agentTok: 0,
    liveReadOnly: false, hostCols: 120, hostRows: 32, liveState: '', liveCost: null, liveTokens: null, hostName: '' };
  tabs.set(tabId, rec);
  return rec;
}
// Input always to the active tab — its own pty, or (for a joined live tab) the peer's terminal over the WS.
// This single chokepoint is why every shortcut pill, paste, and the context menu co-drive a live session for free.
function sendInput(d) {
  if (!activeTabId) return;
  const t = tabs.get(activeTabId);
  if (t && t.kind === 'live') { if (!t.liveReadOnly) claudible.liveInput(activeTabId, d); return; }
  claudible.ptyInput(activeTabId, d);
}
function sync() {
  const t = AT(); if (!t) return;                              // never fit a hidden tab — only the active one
  if (t.kind === 'live') { fitLiveTab(t); return; }            // a live tab is a fixed-grid remote mirror — never start/resize a local pty
  // While THIS tab is live-shared its grid is PINNED (set at share start): a host window resize used to re-fit
  // the pty, re-wrapping Claude's whole layout for every guest ("I fullscreen and his terminal goes tiny").
  // Scale-to-fit like a mirror instead — the host zooms their own view, the shared video never changes.
  if (t.started && t.tabId === sharedTabIdR) { scaleTermToGrid(t, t.term.cols, t.term.rows); updateScrollbar(); return; }
  try {
    // Compute the fitted size ONCE. The old path called fit() (which resized the term to R rows) and then
    // resized AGAIN to R-1 — two alt-buffer reflows on EVERY sync, i.e. the flicker on every tab switch.
    // proposeDimensions measures without resizing, so we resize exactly once, and only when it actually changed.
    const d = t.fit.proposeDimensions();
    if (!d || !(d.cols >= 2) || !(d.rows >= 2)) return;        // not laid out yet → don't start/resize at 0×0
    const cols = d.cols;
    // Leave ~1 row of breathing room at the bottom: Claude's TUI anchors its input box, the
    // bypass-permissions banner and the status/“working… esc to interrupt” line to the last rows —
    // running them flush to the pane edge clips them. One reserved row keeps those always visible.
    const rows = d.rows > 6 ? d.rows - 1 : d.rows;
    const changed = (t.term.cols !== cols || t.term.rows !== rows);
    if (changed) t.term.resize(cols, rows);
    if (!t.started) { t.started = true; claudible.tabOpen(t.tabId, t.wsId, t.session); claudible.ptyStart(t.tabId, cols, rows); } // spawn at the EXACT fitted size
    else if (changed) claudible.ptyResize(t.tabId, cols, rows);   // a pure tab-switch (no size change) is now a no-op resize → one clean repaint, no redundant pty:resize IPC
    updateScrollbar();
  } catch {}
}
// Route incoming bytes to the ADDRESSED tab's xterm — background tabs keep accumulating while hidden.
// Auto-scroll only the active tab, and only when it was already at the bottom (don't yank the reader down).
claudible.onPtyData((tabId, d) => {
  const t = tabs.get(tabId); if (!t) return;
  if (t.kind === 'live') return;   // invariant: a joined mirror renders ONLY live:data; local-pty bytes here mean the hijack guard failed upstream — drop them so two streams can't interleave into one xterm
  const b = t.term.buffer.active;
  const wasAtBottom = b.viewportY >= b.baseY - 1;
  t.term.write(d, () => { if (tabId === activeTabId) { if (wasAtBottom) t.term.scrollToBottom(); updateScrollbar(); } });
});

// ---------- custom scroll gutter (lives in the UI, never covers terminal text) ----------
const sc = $('scroll'), thumb = $('scroll-thumb');
// Claude Code runs full-screen (alt buffer) → no xterm scrollback for the bar to map. But it scrolls its OWN view
// on PageUp/PageDown (proven), and unlike mouse sequences those keystrokes always survive the ConPTY/wsl bridge
// that carries Claude's input — which is why a mouse-based jog could silently do nothing here. So for a full-screen
// app the bar drives Claude with Page keys (through sendInput, the keyboard's own channel) and keeps a position
// ESTIMATE (altFrac) so the thumb moves as you scroll and rests at the bottom, where Claude shows the newest
// output. A normal-buffer shell still gets real xterm scrollback below.
function isAlt() { return !!(term && term.buffer.active && term.buffer.active.type === 'alternate'); }
// altFrac (the scroll-position estimate) is now PER-TAB (rec.altFrac) — it used to be one module-global that
// bled between tabs (switching left the thumb where another tab's scroll had put it, firing spurious pages).
const ALT_PAGE = 0.14;                 // estimate nudge per PageUp/PageDown
// SHARED SCROLL: a live session's screen is one view for everyone — gutter paging on a shared or joined tab
// drives the SAME TUI every viewer is watching, exactly like typing does. (This replaced the earlier
// isolation/inert guards by explicit choice: simple model, no special cases.) sendPage routes through
// sendInput, so on a joined mirror the Page keys ride live:input to the host. The ONE viewer who can't
// drive it is a READ-ONLY guest — their bytes are refused at sendInput, so their gutter must stay inert
// too (adversarial-review find: a moving thumb over refused pages is false feedback, and the altFrac
// estimate would drift with no way back).
function canPageShared(r) { return !(r && r.kind === 'live' && r.liveReadOnly); }
function sendPage(dir) {   // PageUp (older) / PageDown (newer)
  sendInput(dir < 0 ? '\x1b[5~' : '\x1b[6~');
}
function jogPages(dir) {                // wheel / gutter-click: fire pages + advance the estimate
  const at = tabs.get(activeTabId);
  if (!at || !dir || !canPageShared(at)) return;
  const n = Math.min(6, Math.abs(dir));
  for (let i = 0; i < n; i++) sendPage(dir < 0 ? -1 : 1);
  at.altFrac = Math.max(0, Math.min(1, (at.altFrac || 0) + (dir < 0 ? 1 : -1) * ALT_PAGE * n));   // per-tab estimate — no longer a shared global that bleeds between tabs
  updateScrollbar();
}
function updateScrollbar() {
  if (!term) return;                                 // no active tab yet (pre-boot)
  const at = tabs.get(activeTabId);
  if (isAlt() && at && !canPageShared(at)) { if (thumb) thumb.style.display = 'none'; return; }   // read-only viewer + full-screen TUI: there is NOTHING the thumb could honestly do (paging is refused) → hide it. Normal-buffer scrollback below stays draggable — that's local.
  if (thumb && thumb.style.display === 'none') thumb.style.display = '';
  const trackH = sc.clientHeight;
  if (trackH <= 0) { thumb.style.opacity = '0'; return; }
  if (isAlt()) {                                      // full-screen app → a draggable thumb that pages Claude's view
    const thumbH = Math.max(40, trackH * 0.20);
    thumb.style.opacity = '1'; thumb.style.height = thumbH + 'px';
    if (!dragging) thumb.style.transform = 'translateY(' + ((trackH - thumbH) * (1 - (at.altFrac || 0))) + 'px)';   // 0=bottom · per-tab estimate
    return;
  }
  const b = term.buffer.active, rows = term.rows, baseY = b.baseY, total = b.length;
  if (baseY <= 0 || total <= rows) { thumb.style.opacity = '0'; return; }
  const thumbH = Math.max(26, trackH * (rows / total));
  const top = (trackH - thumbH) * (b.viewportY / baseY);
  thumb.style.opacity = '1'; thumb.style.height = thumbH + 'px'; thumb.style.transform = 'translateY(' + top + 'px)';
}
setInterval(updateScrollbar, 80);   // poll so the thumb tracks the live scroll position even when onScroll is sparse (snappier fallback; live scroll is event-driven via onScroll)

let dragging = false, grabDY = 0, jogLastY = 0;
function thumbTop() { return thumb.getBoundingClientRect().top - sc.getBoundingClientRect().top; }
function scrollToFrac(frac) {
  const baseY = term.buffer.active.baseY;
  term.scrollToLine(Math.round(Math.max(0, Math.min(1, frac)) * baseY));
}
thumb.addEventListener('pointerdown', (e) => {
  dragging = true; grabDY = e.clientY - thumbTop(); jogLastY = e.clientY; thumb.classList.add('drag');
  thumb.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation();
});
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const trackH = sc.clientHeight, thumbH = thumb.offsetHeight;
  const top = Math.max(0, Math.min(trackH - thumbH, e.clientY - sc.getBoundingClientRect().top - grabDY));
  if (isAlt()) {                                      // full-screen: thumb follows the cursor; fire a Page key per ~24px
    const _at = tabs.get(activeTabId);
    if (!canPageShared(_at)) return;                  // read-only viewer: the page would be refused — don't move the thumb/estimate either (no false feedback)
    thumb.style.transform = 'translateY(' + top + 'px)';
    if (_at) _at.altFrac = (trackH - thumbH) > 0 ? 1 - (top / (trackH - thumbH)) : 0;   // per-tab estimate = where the thumb now sits
    const dy = e.clientY - jogLastY;
    if (Math.abs(dy) >= 24) { sendPage(dy < 0 ? -1 : 1); jogLastY = e.clientY; }
    return;
  }
  scrollToFrac((trackH - thumbH) > 0 ? top / (trackH - thumbH) : 0);
});
window.addEventListener('pointerup', () => { if (dragging) { dragging = false; thumb.classList.remove('drag'); } });
sc.addEventListener('pointerdown', (e) => {           // click the gutter: page (full-screen) / jump (scrollback)
  if (e.target === thumb) return;
  if (isAlt()) { const mid = sc.getBoundingClientRect().top + sc.clientHeight / 2; jogPages(e.clientY < mid ? -2 : 2); return; }
  scrollToFrac((e.clientY - sc.getBoundingClientRect().top) / sc.clientHeight);
});
sc.addEventListener('wheel', (e) => { if (isAlt()) { jogPages(e.deltaY < 0 ? -1 : 1); e.preventDefault(); } }, { passive: false });
// ---------- concurrent sessions ----------
// Each tab is still one live session/pty running in the background; the active tab is the visible terminal.
// There is NO top tab strip — every live session is shown as a row in the LEFT SIDEBAR instead (saved
// ones as their normal session row, brand-new unsaved ones as a synthetic "live" row).
const MAX_TABS = 8;
function tabLabel(rec) {
  if (rec.label) return rec.label;
  return (rec.session === 'new' || !rec.session) ? 'New session' : 'Session';
}
// Show one tab, hide the rest. Point the global term at it, fit it (NEVER fit a hidden tab), and
// project its meter/agents/scroll into the shared UI. Tells main this is the foreground (guest-mirrored) tab.
function setActiveTab(tabId) {
  const rec = tabs.get(tabId); if (!rec) return;
  const prev = tabs.get(activeTabId);   // the tab being LEFT — captured before activeTabId moves (R6 below)
  rec.lastActive = Date.now();   // "least recently VIEWED" — the only ordering reclaimTabSlot() may evict by
  if (dragging) { dragging = false; thumb.classList.remove('drag'); }   // a scroll-thumb drag must not straddle a tab switch (its window-level pointermove would page the newly-active tab)
  activeTabId = tabId;
  for (const r of tabs.values()) r.container.classList.toggle('active', r.tabId === tabId);
  term = rec.term;
  if (rec.kind !== 'live') { try { claudible.tabForeground(tabId); } catch {} }   // guests + main's active-workspace follow the foreground tab — a live tab must NOT (it would hijack your own outgoing mirror)
  sync();                                          // fit the now-visible tab + (re)start/resize its pty (or fit the live mirror)
  scheduleFit();                                    // …and re-fit once layout settles (the container just became visible)
  try { rec.term.refresh(0, rec.term.rows - 1); } catch {}   // force a repaint of the freshly-shown (was-hidden) buffer
  if (rec.kind === 'live') repaintLiveTracker(rec); else repaintTracker(rec);    // project this tab's tracker into #trk-*
  _agentsSig = '';                                 // force an agents rebuild for THIS tab (the sig guard is module-global)
  renderAgents();                                  // …and its agents into the agents pane
  updateScrollbar();
  refreshCollabSurfaces();                          // chat/roster/live-bar/voice follow the active tab's context (host-share vs joined)
  if ($('tts-in')) $('tts-in').value = rec.lastReply || '';   // the Speak box shows THIS tab's latest reply (per-tab, never another tab's — the lastReply bleed fix)
  try { updateVoiceOutBtn(); } catch {}
  activeSession = (rec.session && rec.session !== 'new') ? rec.session : null;
  rec.attention = false;                              // you're looking at it now — drop any "finished while away" pulse
  if (sidebarReady) {   // guard: the sessions/workspace section's consts aren't initialized during the boot tab
    // The sidebar follows the tab's project — and for a JOINED tab that is its HOME project (peerWsId). A live
    // tab has no local wsId, so the scope never moved and the pinned joined row landed under whatever project
    // happened to be active ("the live session jumped from MK-Crazy to my local project", Crazy's 07-19 report —
    // the third sighting of this wart; the pin-in-active-list design stays, the SCOPE now moves with the join).
    // main's activeWorkspace is deliberately NOT re-pointed (live tabs skip tabForeground — host-side privacy).
    const sideWs = rec.wsId || (rec.kind === 'live' && rec.peerWsId) || null;
    if (sideWs && sideWs !== activeWsId) { activeWsId = sideWs; primeSessionListForWs(sideWs); renderWsChips(); }   // prime the new ws's rows BEFORE reconcileWsChips re-nests the list, so it can't nest the OLD project's rows under the NEW project's label for a frame (the cross-project-click "wrong content" flash)
    refreshSessions();                                                                     // re-highlight rows for this tab's ws/session
  }
  clearTabAttention(tabId);                           // and un-pulse the row if it's already painted
  // R6 (register): switching OFF (or onto) a joined live tab changes what the expanded trees must show — the
  // joined session's dedup (joinedTabSessionIds) and its home tree's paint depend on which tab is active, but
  // reconcileWsChips only ever refills an EMPTY tree. Without this, navigating to another project made the
  // joined session's row vanish sidebar-wide (its home tree kept the stale join-time paint) until a manual
  // collapse/expand. Guarded to live-tab transitions so ordinary switches don't repaint every tree.
  if (sidebarReady && prev && prev !== rec && (prev.kind === 'live' || rec.kind === 'live')) refreshExpandedTrees();
  setTimeout(() => { if (term) term.focus(); }, 0);
}
// Open a brand-new session in a NEW tab (the current tab keeps running in the background).
// → true if a tab was made. At the cap, reclaim a background tab first (reclaimTabSlot) rather than dead-ending:
// the callers below reach here exactly when the CURRENT tab cannot be reused (it's mid-turn, or live-shared, or
// main kept it) — i.e. the one case where "just recycle this tab" is unavailable, which is precisely how the cap
// became a wall. Deliberately does NOT toast: every caller has a more specific message than "Tab limit reached",
// and toasting here too would double up. Below the cap this is byte-identical to before.
function newBlankTab(wsId, session, name) {
  if (tabs.size >= MAX_TABS && !reclaimTabSlot()) return false;
  const id = newTabId();
  const rec = makeTab(id, wsId || activeWsId, session || 'new');
  if (name && rec) { rec.label = name; rec.curSessionLabel = name; rec.pendingTitle = name; }   // named up front → show it now + persist once the session gets its real id (onStatus reconcile)
  setActiveTab(id);                                // activating fits + starts its pty
  return true;
}
function closeTab(tabId) {
  const rec = tabs.get(tabId); if (!rec || tabs.size <= 1) return;   // never close the last tab
  // Closing the live-shared tab destroys the conversation guests are watching — the one thing every other
  // navigation path now refuses to do. It's a legitimate choice, but never an accidental one: the Command Center's
  // "✕ End this session" and the draft row's "Close session" both reach here with no idea a share is running.
  // Confirm, then let main's tab:close send share:force-end so the tunnel actually closes (it used to just pause,
  // leaving guests frozen on a dead pty while the host's UI still said "live").
  if (tabId === sharedTabIdR && !confirm('This tab is live-shared.\nClosing it ends the live session — everyone watching will be disconnected.')) return;
  // The last unguarded kill path (register R1): every OTHER mutating route (switch/delete/sync/project ops) is
  // busy-guarded by main's authoritative flag, but closeTab — reachable from the Command Center's always-visible
  // "End this session" ✕ — killed a mid-turn Claude silently. Closing a busy session is a legitimate choice,
  // never an accidental one: confirm, mirroring the shared-tab gate above. rec.busy is main's flag mirrored via
  // tab:busy (never renderer-derived), so an esc'd/crashed turn can't false-positive this.
  if (rec.busy && !confirm('Claude is mid-turn in this session.\nClosing it kills the running turn — whatever it was doing stops unfinished.\n\nClose anyway?')) return;
  if (tabId === liveVoiceTabId) { try { liveVoice.leave(); } catch {} liveVoiceTabId = null; }   // leaving a joined session drops its voice
  if (rec.kind === 'live') { try { claudible.liveDisconnect(tabId); } catch {} }   // leaving a JOINED peer session: tear down the client WebSocket too (was leaking)
  try { claudible.tabClose(tabId); } catch {}
  try { rec.term.dispose(); } catch {}
  try { rec.container.remove(); } catch {}
  tabs.delete(tabId);
  if (activeTabId === tabId) {   // ✕ on the tab you're viewing → land on a REAL local session when one exists, not whatever
    // happens to be first in Map order (which could be another joined mirror or a still-resolving tab — landing
    // there leaves the sidebar with no truthful highlight). setActiveTab → refreshSessions either way.
    const vals = Array.from(tabs.values());
    const next = vals.find((r) => r.kind !== 'live' && r.session && r.session !== 'new') || vals.find((r) => r.kind !== 'live') || vals[0];
    setActiveTab(next.tabId);
  }
  else if (sidebarReady) refreshSessions();      // ✕ on a BACKGROUND tab (e.g. a joined live row you're not viewing) must still refresh the sidebar: drop its row + bring back any saved row it was deduping
  if (rec.kind === 'live') refreshExpandedTrees();   // leaving a joined mirror: its saved row was deduped out of its HOME project's tree too (joinedTabSessionIds) — bring that copy back everywhere, not just in the active list
}

new ResizeObserver(sync).observe(termHost);
window.addEventListener('resize', sync);
// Re-fit after layout/fonts actually settle. A fit during boot, or right after a display:none→block tab
// swap, can measure a stale/short size and under-count rows — leaving dead space below the terminal. Extra
// fits are harmless (sync no-ops at <2×2 and only resizes the active tab), so schedule a couple of catch-ups.
function scheduleFit() { requestAnimationFrame(() => requestAnimationFrame(sync)); }
if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleFit);
window.addEventListener('load', scheduleFit);
// NOTE: the first tab is seeded at the very END of this file (bootFirstTab), AFTER every const/helper it
// transitively touches (fmtK, SWARM_SVG, …) is initialized — seeding it here would hit those in the TDZ.
// These timers/observer are safe before then: sync()/updateScrollbar() no-op until a tab is active.
setTimeout(sync, 180);
setTimeout(() => { if (term) term.focus(); }, 350);   // keyboard ready in the terminal on launch

// After ANY panel button click, hand keyboard focus back to the terminal so the next
// keystroke (e.g. choosing an effort level after /effort) lands in Claude — not the button.
document.querySelectorAll('.panel button').forEach((b) =>
  b.addEventListener('click', () => setTimeout(() => term.focus(), 0)));

// ---------- meta / health ----------
(async () => {
  const ep = await claudible.endpoints();
  $('meta').textContent = ep.whisper.replace('http://', '') + ' · ' + ep.kokoro.replace('http://', '');
  setDot('d-pty', ep.pty ? 'ok' : 'bad');
  $('sb-whisper').textContent = 'whisper ' + ep.whisper.split(':').pop();
  $('sb-kokoro').textContent = 'kokoro ' + ep.kokoro.split(':').pop();
  // the embedded Claude Code CLI version, left of whisper/kokoro — hidden gracefully if it can't be resolved
  try { const cv = await claudible.claudeVersion(); const el = $('sb-claude'); if (el) { if (cv) { el.textContent = 'claude code ' + cv; el.style.display = ''; } else { el.style.display = 'none'; } } } catch {}
  try { const av = await claudible.appVersion(); const ve = $('app-ver'); if (ve && av) ve.textContent = 'claudible v' + av; } catch {}   // real version, not the hardcoded 'v0.2'
})();

// ---------- session tracker ----------
// Claude Code's statusLine reports CUMULATIVE cost/tokens for the (persisted, --continue'd)
// conversation. We want THIS session's usage, so we subtract a baseline captured at launch and
// re-baseline on /clear or any upstream reset. Baseline resets every app launch (fresh process).
const fmtK = (n) => n >= 1e6 ? ((+(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)) + 'M') : (n >= 1000 ? ((+(n / 1000).toFixed(n >= 100000 ? 0 : 1)) + 'k') : String(n));

// Token-count easter egg: tint the tokens readout from white toward subtle orange -> red as the
// session's RAW token count climbs into the millions. Deliberately faint — a quiet power-user signal,
// not a warning (most sessions sit <2M and stay ~white). Piecewise-linear RGB across the control points.
const TOK_HUE = [
  [1e6,  [246, 248, 252]],   // 1M  — white (warming begins only above here)
  [2e6,  [246, 244, 238]],   // 2M  — barely warm; most users won't notice
  [5e6,  [242, 231, 212]],   // 5M  — light orange a power user starts to catch
  [10e6, [236, 216, 184]],   // 10M — mid orange
  [20e6, [228, 190, 148]],   // 20M — deeper orange
  [25e6, [223, 172, 130]],   // 25M — edging toward red
  [35e6, [214, 132, 100]],   // 35M+ — subtle orange-red (cap)
];
function tokenHue(n) {
  if (!(n > 1e6)) return '#f6f8fc';                          // <=1M: plain white
  const s = TOK_HUE;
  for (let i = 1; i < s.length; i++) {
    if (n <= s[i][0]) {
      const a = s[i - 1], b = s[i], f = (n - a[0]) / (b[0] - a[0]);
      const c = [0, 1, 2].map(k => Math.round(a[1][k] + (b[1][k] - a[1][k]) * f));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  const c = s[s.length - 1][1];
  return `rgb(${c[0]},${c[1]},${c[2]})`;                     // past the last point: hold the cap
}
// Parse a fmtK-style string ("2.4k","1.5M") back to an approximate count — the live/host readout
// arrives pre-formatted, so this recovers a number to drive the same tint.
function parseTokCount(str) {
  if (str == null) return 0;
  const m = String(str).trim().match(/^([\d.]+)\s*([kKmM]?)/);
  if (!m) return 0;
  let v = parseFloat(m[1]) || 0;
  const u = m[2].toLowerCase();
  if (u === 'k') v *= 1e3; else if (u === 'm') v *= 1e6;
  return v;
}
// Tracker accumulators are PER TAB (on each tab's record): the #trk-* DOM always projects the ACTIVE tab,
// but what guests see is the MIRRORED tab's tracker — while hosting, main pins the mirror to the shared tab
// (share:pinned) and that session keeps running (guests may be co-driving it) while the host works elsewhere.
// So the payload is built from the tab RECORD, never the DOM (the DOM shows whatever the host is browsing),
// and main drops any push whose tabId isn't the mirrored tab — a stray push can never leak another session.
let sharedTabIdR = null;   // the tab main has pinned the live mirror to (null = not hosting)
if (claudible.onSharePinned) claudible.onSharePinned((p) => {
  const was = sharedTabIdR;
  sharedTabIdR = (p && p.tabId != null) ? p.tabId : null;
  if (was != null && sharedTabIdR == null) {
    // share ended → the tab leaves fixed-grid mode: restore the stock font and re-fit to the window
    const t = tabs.get(was); if (t) { try { t.term.options.fontSize = TERM_OPTS.fontSize; } catch {} }
  }
  try { sync(); } catch {}
  pushTracker();
});
// (share:session-moved is gone: main no longer moves the pinned tab off its session for ANY navigation, so the
// "your guests are frozen, re-share from its session" toast had nothing left to report. Deleting the live
// session's workspace is the one remaining teardown, and it sends share:force-end instead — a real ending.)
// Main protected the live session: something tried to re-point the pinned tab and was refused. The UI paths below
// all avoid this (they open a new tab instead), so reaching here means a path we haven't guarded — say it plainly
// rather than leaving the user staring at a tab that didn't move.
if (claudible.onShareRerouteRefused) claudible.onShareRerouteRefused(() => { toast('That tab is live-shared — it stays on the session your guests are watching. End the live session to move it.'); });
function mirrorTabR() { return (sharedTabIdR != null && tabs.get(sharedTabIdR)) || AT(); }
function pushTracker(t) {
  t = t || mirrorTabR(); if (!t) return;
  if (t.kind === 'live') return;   // viewing a peer's session — never mirror THEIR tracker to YOUR guests
  const cost = '$' + ((t.baseCost === null || t.lastCostUsd == null) ? 0 : Math.max(0, t.lastCostUsd - t.baseCost)).toFixed(2);
  try { claudible.shareTracker({ tabId: t.tabId, ctxPct: t.curCtxPct, cost, tokens: fmtK((t.sessTok || 0) + (t.agentTok || 0)), session: t.curSessionLabel, sessionId: (t.session && t.session !== 'new') ? t.session : '' }); } catch {}   // sessionId lets a guest detect "host moved to a different session than I joined"
}
// "who's typing" chip — a small pill floating over a live-shared terminal naming whoever's keystrokes are
// landing in it right now. Purely visual (never injects bytes into the pty — a click-to-sign design would
// misfire into menus/permission dialogs): the host sees co-driving guests, a joined viewer sees the host and
// other guests. Senders throttle to 1/s, so the chip decays locally ~3s after the last ping.
function showTypist(rec, name) {
  if (!rec || !name) return;
  let chip = rec._typChip;
  if (!chip || !chip.isConnected) { chip = document.createElement('div'); chip.className = 'typist-chip'; rec.container.appendChild(chip); rec._typChip = chip; }
  chip.textContent = '✎ ' + name;                            // textContent — names are collaborator-supplied
  chip.classList.add('show');
  clearTimeout(rec._typT);
  rec._typT = setTimeout(() => { try { chip.classList.remove('show'); } catch {} }, 3000);
}
if (claudible.onShareTypist) claudible.onShareTypist((p) => {   // a guest typing into MY hosted session → chip on the SHARED (pinned) tab
  const r = (sharedTabIdR != null) ? tabs.get(sharedTabIdR) : null;
  if (r && p && p.name) showTypist(r, String(p.name).slice(0, 40));
});
if (claudible.onLiveTypist) claudible.onLiveTypist((p) => {     // someone typing in a session I JOINED → chip on that live tab (my own keys never echo back — the server excludes the sender)
  const r = tabs.get(p && p.tabId); if (!r) return;
  const nm = String((p && p.name) || '').slice(0, 40);
  if (nm) showTypist(r, nm);
});
// Light the first N of the context gauge's segments to mirror pct (N proportional, min 1 once > 0).
function paintCtxSegs(pct) {
  const wrap = $('trk-ctxsegs'); if (!wrap) return;
  const segs = wrap.children, n = segs.length;
  const lit = (typeof pct === 'number' && pct > 0) ? Math.max(1, Math.min(n, Math.round(pct / 100 * n))) : 0;
  for (let i = 0; i < n; i++) segs[i].classList.toggle('lit', i < lit);
}

// Paint the #trk-* gauges from a tab record (called for the active tab on update and on every tab switch).
function repaintTracker(t) {
  if (!t) return;
  const pct = t.curCtxPct, bar = $('trk-ctxbar');
  if (typeof pct === 'number') {
    $('trk-ctx').textContent = pct + '%';
    paintCtxSegs(pct);
    bar.classList.toggle('warn', pct >= 70 && pct < 85);
    bar.classList.toggle('crit', pct >= 85);
    bar.title = pct >= 70 ? `context ${pct}% — click to /compact` : 'context window used';
  } else {
    $('trk-ctx').textContent = '—'; paintCtxSegs(null);
    bar.classList.remove('warn', 'crit'); bar.title = 'context window used';
  }
  $('trk-cost').textContent = '$' + ((t.baseCost === null || t.lastCostUsd == null) ? 0 : Math.max(0, t.lastCostUsd - t.baseCost)).toFixed(2);
  if (bar) bar.title = bar.title + ' · ' + $('trk-cost').textContent + ' this session';   // append cost to the (warn-aware) context tooltip — cost lives here now
  const at = t.agentTok || 0;                                    // subagent/swarm tokens (the main meter misses these)
  const tokN = (t.sessTok || 0) + at, tokEl = $('trk-tokens');
  tokEl.textContent = fmtK(tokN);
  tokEl.style.color = tokenHue(tokN);                            // faint warm tint past 1M (easter egg)
  tokEl.title = at ? (fmtK(t.sessTok || 0) + ' main + ' + fmtK(at) + ' agents') : '';
}
function resetStats(t) {
  t = t || AT(); if (!t) return;
  t.baseCost = null; t.sessTok = 0; t.agentTok = 0; t.lastUsageKey = null; t.lastCostUsd = null; t.curCtxPct = null;
  if (t.tabId === activeTabId) repaintTracker(t);
  if (t.tabId === activeTabId || t.tabId === sharedTabIdR) pushTracker(t);   // the shared tab mirrors even while backgrounded
}
// First-run voice setup (packaged native Windows only) → a quiet, persistent status-bar CHIP (#sb-voice), not a
// toast: a multi-minute model download must not auto-vanish or read as a freeze. Phases: start/done/error.
if (claudible.onProvision) claudible.onProvision((m) => {
  try {
    if (m && m.dep && m.dep !== 'voice') return;   // per-dep installs (System-check) own their own rows; the chip is voice-only
    const sp = $('sb-voice'), note = $('voice-note'); if (!sp || !note) return;
    sp.style.display = ''; sp.title = (m && m.msg) || '';
    if (!m || m.phase === 'start') { setDot('d-voice', 'work'); note.textContent = 'voice · setting up…'; }
    else if (m.phase === 'done') { setDot('d-voice', 'ok'); note.textContent = 'voice ready'; setTimeout(() => { const s = $('sb-voice'); if (s) s.style.display = 'none'; }, 8000); }
    else if (m.phase === 'error') { setDot('d-voice', 'bad'); note.textContent = 'voice setup failed'; }
  } catch {}
});
claudible.onStatus((s) => {
  const t = tabs.get(s.tabId); if (!t) return;   // route the status to the tab it belongs to
  if (s.model) t.model = s.model;   // the tab's CURRENT model (statusline display name) — inherited by hook agents spawned without an explicit model override
  // Reconcile the tab's UI session with the REAL session id Claude's pty reports — the pty is the source of truth.
  // Covers a freshly-started 'new' tab AND the case where an explicitly-opened session was unresumable (e.g. a
  // collaborator deleted it) and the runner fell back to a different one — without this the highlight sticks wrong.
  if (s.sessionId && t.session !== s.sessionId) {
    const wasNew = (t.session === 'new');   // adopting a real id FROM an explicit 'new' = a genuine user-created session (keep its live·unsaved row until it saves). Adopting one from ''/another id = a switch/resume → NOT born-new, so it can never flash a phantom row.
    t.session = s.sessionId;
    t.bornNew = wasNew;
    if (t.tabId === activeTabId) activeSession = s.sessionId;
    if (t.pendingTitle) {                                       // a name chosen at "+ New Session" → make it stick now that the session has a real id (mirrors the rename flow)
      const nm = t.pendingTitle; t.pendingTitle = null;
      const _pp = loadPrefs();
      const titles = Object.assign({}, _pp.sessionTitles || {}); titles[s.sessionId] = nm;
      const tstamps = Object.assign({}, _pp.sessionTitleTs || {}); tstamps[s.sessionId] = Date.now();   // stamp the rename so global newest-wins can compare it against collaborators'
      saveSessionTitles(titles, tstamps);   // copy → mutable (cached map may be a frozen contextBridge object); bounded + evictable
      const _aw = workspaces.find((w) => w.id === t.wsId);   // the TAB's workspace, not the sidebar's — a background tab resolving while you view another ws must gate + publish against ITS OWN repo
      if (_aw && _aw.kind === 'repo') { remoteTitles[s.sessionId] = { n: nm, ts: tstamps[s.sessionId] }; try { claudible.titleSet(s.sessionId, nm, t.wsId).then((r) => { if (r && r.ok === false) toast('Named here — sharing the name failed, will keep retrying'); pollTitles(true); }).catch(() => {}); } catch (e) {} }   // repo project → share the name with collaborators. R38: a failed publish was silent (the rename path already toasts this same line); the inverse reconciler keeps retrying either way
    }
    if (sidebarReady && t.wsId === activeWsId) refreshSessions();
  }
  // context % — live current-fill gauge + guardrail (amber ≥70%, red ≥85%; becomes a /compact shortcut)
  if (typeof s.ctxPct === 'number') t.curCtxPct = s.ctxPct;
  // session cost — statusLine cost is cumulative for the continued conversation; show delta since launch
  if (typeof s.costUsd === 'number' && s.costUsd >= 0) {
    if (t.baseCost === null && s.costUsd > 0) t.baseCost = s.costUsd;        // baseline at launch
    if (t.baseCost !== null && s.costUsd < t.baseCost) t.baseCost = s.costUsd; // upstream reset (e.g. /clear)
    t.lastCostUsd = s.costUsd;
  }
  // session tokens — accumulate genuinely-NEW (non-cache) tokens per turn (current_usage changes each turn).
  // Skip the FIRST key seen this launch: on a --continue session it's the PRE-launch turn's usage, which must
  // not be counted (mirrors the cost baseline above so tokens and cost both start at 0 for the app session).
  if (s.usageKey != null && s.usageKey !== t.lastUsageKey) {
    if (t.lastUsageKey !== null) t.sessTok += (s.newTok || 0);
    t.lastUsageKey = s.usageKey;
  }
  if (t.tabId === activeTabId) repaintTracker(t);                      // only the foreground tab paints the DOM gauges
  if (t.tabId === activeTabId || t.tabId === sharedTabIdR) pushTracker(t);   // ...but the SHARED tab keeps mirroring to guests even while backgrounded (main drops non-mirrored pushes)
});

// ---------- (b) mic -> Whisper STT  (shared by the Talk button + the Left-Ctrl push-to-talk hold) ----------
let mediaRecorder = null, chunks = [], recording = false, micStream = null, discardClip = false, micIdleTimer = null, micPending = null;
function micLive() { return !!(micStream && micStream.getTracks().some((t) => t.readyState === 'live')); }
function getMic() {                                          // reuse a WARM mic stream (deduped) so recording starts INSTANTLY — the per-record getUserMedia gap is what swallowed the first/long clip
  if (micLive()) return Promise.resolve(micStream);
  if (micPending) return micPending;                        // dedupe a pre-warm + a record racing the same cold grant
  micPending = navigator.mediaDevices.getUserMedia({ audio: true })
    .then((s) => { micStream = s; micPending = null; return s; })
    .catch((e) => { micPending = null; throw e; });
  return micPending;
}
function releaseMicSoon() {                                  // keep the mic warm for quick retries, then release when idle (privacy — the OS mic indicator turns off)
  if (micIdleTimer) clearTimeout(micIdleTimer);
  micIdleTimer = setTimeout(() => { try { if (micStream) micStream.getTracks().forEach((t) => t.stop()); } catch {} micStream = null; micIdleTimer = null; }, 45000);
}
function warmMic() { getMic().then(() => { if (!recording && !micIdleTimer) releaseMicSoon(); }).catch(() => {}); }   // pre-grab on press; idle out if no recording follows
function talkUI(on) {
  $('talk').textContent = on ? '■ Stop' : 'Talk'; $('talk').className = on ? 'primary live' : 'primary'; setActive('lbl-in', on);
  // Top-bar Voice In box — always visible (even with the drawer closed) so you can see you're talking.
  const vi = $('voice-in'); if (vi) { vi.classList.toggle('live', on); const s = $('vin-stat'); if (s) s.textContent = on ? 'Listening' : 'Talk'; }
}

async function startRecording() {
  if (recording) return;
  recording = true; discardClip = false;   // claim synchronously — blocks double-trigger re-entry
  stopSpeech();                            // barge-in: stop any TTS the instant the user starts talking
  if (micIdleTimer) { clearTimeout(micIdleTimer); micIdleTimer = null; }   // cancel a pending mic release — we're recording again
  const warm = micLive();                  // warm stream → instant capture; cold → a grant gap during which nothing records
  talkUI(true); setDot('d-stt', 'work');
  $('stt-out').textContent = warm ? 'listening…' : 'starting mic…'; $('stt-out').className = 'out';
  if (!warm) { const s = $('vin-stat'); if (s) s.textContent = 'Starting…'; }   // honest cue: DON'T speak yet — the mic isn't capturing during the cold getUserMedia gap (this is what swallowed the first/long clip)
  let stream;
  try { stream = await getMic(); }
  catch (e) {
    recording = false; talkUI(false);
    setDot('d-stt', 'bad'); $('stt-out').textContent = 'mic blocked: ' + e.message + ' — enable Windows mic for desktop apps'; $('stt-out').className = 'out';
    return;
  }
  if (!recording) { releaseMicSoon(); return; }   // stopped during the grant gap → keep the stream WARM so the retry is instant (was: thrown away → next clip cold again)
  const mt = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
  mediaRecorder = new MediaRecorder(stream, { mimeType: mt, audioBitsPerSecond: 32000 }); chunks = [];   // 32 kbps → small blobs (whisper is excellent at low bitrate), reliable IPC + upload even for long clips
  mediaRecorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  mediaRecorder.onerror = (ev) => { try { console.error('[voice] MediaRecorder error', (ev && ev.error) || ev); } catch {} setDot('d-stt', 'bad'); $('stt-out').textContent = 'recording error — try again'; $('stt-out').className = 'out'; recording = false; talkUI(false); };
  mediaRecorder.onstop = async () => {
    releaseMicSoon();                      // keep the mic warm for a quick retry; released after idle (privacy) — NOT stopped immediately
    if (discardClip) { setDot('d-stt', 'ok'); $('stt-out').textContent = ''; $('stt-out').className = 'out'; return; }  // false-start: combo key or too short to be speech
    const blob = new Blob(chunks, { type: 'audio/webm' });
    setDot('d-stt', 'work'); $('stt-out').textContent = 'transcribing…'; $('stt-out').className = 'out';
    const j = await claudible.stt(await blob.arrayBuffer());
    if (j.error) { setDot('d-stt', 'bad'); $('stt-out').textContent = 'STT error: ' + j.error; return; }
    // drop non-speech markers Whisper emits for silence/noise/music: [BLANK_AUDIO], (chiming), (music)…
    const text = (j.text || '').replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) { setDot('d-stt', 'bad'); $('stt-out').textContent = 'no speech detected — try again'; $('stt-out').className = 'out'; return; }
    setDot('d-stt', 'ok'); $('stt-out').textContent = 'sent to Claude'; $('stt-out').className = 'out live';
    $('stt-transcript').textContent = text;        // temp: last message only, replaced each time, never written to disk
    // Insert the transcript via BRACKETED PASTE, then submit with a separate Enter. Sending raw text +\r
    // let Claude Code's TUI treat a long burst as a paste and swallow the \r as a newline, so long
    // dictations stuck in the input box. Wrapping in ESC[200~ … ESC[201~ makes Claude finalize the paste
    // deterministically on the end-marker (no timing guess); the standalone Enter then always submits.
    sendInput('\x1b[200~' + text + '\x1b[201~');   // paste the transcript into the live TUI
    setTimeout(() => sendInput('\r'), 120);        // …then submit it
  };
  mediaRecorder.start();                   // ONE complete, well-formed webm on stop (proper headers + duration).
                                           // The old 1s-timeslice produced a FRAGMENTED webm (Duration: N/A) that
                                           // ffmpeg/whisper decoded only a few seconds of for LONG recordings — the
                                           // real cause of "spoke 5 min, it didn't record". Verified: a proper webm
                                           // transcribes the full 5 min in ~10s; the fragmented one truncated to <7s.
  $('stt-out').textContent = 'listening…'; $('stt-out').className = 'out';   // NOW actually capturing → the honest cue to speak
  { const s = $('vin-stat'); if (s && recording) s.textContent = 'Listening'; }
}
function stopRecording(opts) {
  if (!recording) return;
  discardClip = !!(opts && opts.discard);
  recording = false; talkUI(false);
  try { if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop(); } catch {}
}
$('talk').addEventListener('click', () => { recording ? stopRecording() : startRecording(); });
['talk', 'voice-in'].forEach((id) => { const b = $(id); if (b) b.addEventListener('pointerdown', () => { if (!recording) warmMic(); }); });   // pre-warm the mic on press → recording starts instantly, hiding the cold getUserMedia gap
// Top-bar Voice In box doubles as a Talk button (so you can talk without opening the drawer).
$('voice-in').addEventListener('click', () => { recording ? stopRecording() : startRecording(); });

// ---------- Push-to-talk: HOLD Left Ctrl ----------
// Left Ctrl is also the terminal's busiest modifier (Ctrl+C/R/D/…), so we DON'T fire the mic on a
// quick press. A ~150ms hold-debounce means only a deliberate hold (with no other key) starts
// recording; a quick Ctrl+<key> shortcut cancels the timer and never touches the mic — and still
// works, because we only swallow the lone Ctrl keydown while the other key's event still carries
// ctrlKey=true. Capture phase so xterm never sees the lone Ctrl. Trade-off: speech onset begins
// ~150ms after you press (press, then speak — natural for push-to-talk).
const PTT_HOLD_MS = 150;
let pttHeld = false, pttStart = 0, pttCombo = false, pttTimer = null;
let pttKey = 'AltLeft', pttCapturing = false;   // default push-to-talk key (configurable); Alt frees Ctrl for copy/paste
// PTT is a HOLD key → it MUST be a modifier (or a safe non-typing key), NEVER a terminal key like Space/Enter/Tab,
// or the handler below would swallow it from the terminal (a stray rebind to Space literally kills the spacebar).
// This guards both the saved pref (self-heal on load) and the rebind capture.
const PTT_SAFE = /^(ControlLeft|ControlRight|AltLeft|AltRight|ShiftLeft|ShiftRight|MetaLeft|MetaRight|CapsLock|F\d{1,2})$/;
const isSafePttKey = (code) => PTT_SAFE.test(code || '');
function pttCancelTimer() { if (pttTimer) { clearTimeout(pttTimer); pttTimer = null; } }
window.addEventListener('keydown', (e) => {
  if (pttCapturing) {                      // rebinding: the next key becomes the new push-to-talk key
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { stopCapture(); return; }                 // Escape cancels without changing it
    if (!isSafePttKey(e.code)) { try { toast('Push-to-talk must be a hold key — Ctrl, Alt, Shift or Win'); } catch (_) {} return; }   // reject typing keys (Space/Enter/…) so a rebind can never kill the terminal; keep listening for a valid one
    setPttKey(e.code); stopCapture();
    return;
  }
  if (e.code === pttKey && isSafePttKey(pttKey)) {   // defense in depth: even a corrupt pttKey can't swallow a terminal key
    e.preventDefault(); e.stopPropagation();
    if (pttHeld) return;                   // ignore auto-repeat while held
    pttHeld = true; pttCombo = false; pttStart = Date.now(); warmMic();   // warm the mic the instant you press, so capture is live before the hold-debounce fires startRecording
    pttTimer = setTimeout(() => {          // held long enough alone => it's a deliberate talk, start the mic
      pttTimer = null;
      if (pttHeld && !pttCombo) startRecording();   // startRecording → talkUI(true) lights the real .vin.live cue
    }, PTT_HOLD_MS);
    return;
  }
  if (pttHeld) { pttCombo = true; pttCancelTimer(); }   // another key while held => a shortcut, never start the mic
}, true);
window.addEventListener('keyup', (e) => {
  if (e.code === pttKey && pttHeld) {
    e.preventDefault(); e.stopPropagation();
    pttHeld = false; pttCancelTimer();
    // Discard ONLY a too-short clip. We don't discard on pttCombo here: the debounce already stops quick
    // Ctrl+<key> shortcuts from ever starting the mic, so once recording is underway a later stray
    // keypress must NOT nuke a long dictation.
    if (recording) stopRecording({ discard: (Date.now() - pttStart) < (PTT_HOLD_MS + 250) });
  }
}, true);
// if focus is lost mid-hold (alt-tab), the keyup never arrives — end the recording and keep the speech
window.addEventListener('blur', () => {
  if (!pttHeld) return;
  pttHeld = false; pttCancelTimer();
  if (recording) stopRecording({ discard: (Date.now() - pttStart) < (PTT_HOLD_MS + 200) });
});
// push-to-talk key: friendly label + click-to-rebind (persisted with the other prefs)
function keyLabel(code) {
  const map = { ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl', AltLeft: 'Left Alt', AltRight: 'Right Alt',
    ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', Space: 'Space', Tab: 'Tab', CapsLock: 'Caps Lock',
    Enter: 'Enter', Backquote: '`', MetaLeft: 'Left Win', MetaRight: 'Right Win' };
  if (map[code]) return map[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code;
  return code || '—';
}
function applyPttKey() {
  const btn = $('ptt-key-btn'); if (btn && !pttCapturing) btn.textContent = keyLabel(pttKey);
}
function setPttKey(code) { pttKey = code; savePrefs({ pttKey: code }); applyPttKey(); }
function startCapture() { pttCapturing = true; const b = $('ptt-key-btn'); if (b) { b.textContent = 'press a key…'; b.classList.add('capturing'); } }
function stopCapture() { pttCapturing = false; const b = $('ptt-key-btn'); if (b) b.classList.remove('capturing'); applyPttKey(); }
if ($('ptt-key-btn')) $('ptt-key-btn').addEventListener('click', () => { pttCapturing ? stopCapture() : startCapture(); });

// ---------- (out) Kokoro TTS — Speak <-> Stop Speech ----------
let ttsAudio = null, ttsBusy = false, selectedVoice = 'af_bella', alwaysSpeak = true, ttsUrl = null, speakGen = 0, fullReadout = true;
// Claude's latest reply (stripped) lives ON THE TAB RECORD (rec.lastReply), never in a module global — a
// global bled between tabs (the altFrac class): once any tab had spoken, "▶ Speak" read tab A's reply while
// tab B was on screen. lastReplyNow() is the one accessor; setActiveTab repopulates the Speak box from it.
function lastReplyNow() { const t = AT(); return (t && t.lastReply) || ''; }
let ttsSpeed = 0;                                    // % faster over baseline (0–25), applied via audio.playbackRate
let announceOn = true, chimeOn = true;               // factory-on: spoken "task complete" cue + soft chat chime
// Voice Out button is dual: ▶ Speak (idle, reads lastReply) ↔ ■ Stop (while speaking). Disabled when nothing to speak.
function updateVoiceOutBtn() {
  const b = $('vout-stop'); if (!b) return;
  const speaking = ttsBusy || !!ttsAudio;
  const lbl = $('vout-label'); if (lbl) lbl.textContent = speaking ? 'Stop' : 'Speak';   // update only the label span (keep the dot intact)
  b.disabled = false;   // ALWAYS clickable — on click it reads lastReply, else fetches the open session's latest reply, else toasts "no text detected to read"
  b.title = speaking ? 'Stop speaking' : 'Read the latest reply aloud';
}
function stripForSpeech(t) {
  return t.replace(/```[\s\S]*?```/g, ' … code block … ').replace(/`([^`]+)`/g, '$1')
          .replace(/[#*_>]/g, '').replace(/\n{2,}/g, '. ').replace(/\s+/g, ' ').trim().slice(0, fullReadout ? Infinity : 1500);
}
function setSpeakBtn(on) { const b = $('speak'); b.textContent = on ? '■' : '▶'; b.title = on ? 'Stop' : 'Test the selected voice'; b.classList.toggle('live', on); const vo = $('vout-stop'); if (vo) vo.classList.toggle('speaking', on); updateVoiceOutBtn(); }
function stopSpeech() {
  speakGen++;                                         // invalidate any in-flight speak()
  ttsBusy = false;
  if (ttsAudio) { ttsAudio.pause(); ttsAudio = null; }
  if (ttsUrl) { URL.revokeObjectURL(ttsUrl); ttsUrl = null; }   // no object-URL leak on barge-in/stop
  setSpeakBtn(false); setActive('lbl-out', false);
}
// Split a reply into sentence-ish chunks (grouped up to ~160 chars) so synthesis of the FIRST chunk
// is quick and audio can start almost immediately, instead of waiting for the whole reply to render.
function chunkForSpeech(text) {
  const sentences = text.match(/[^.!?…]+[.!?…]+\s*|[^.!?…]+$/g) || [text];
  const out = []; let buf = '';
  const cap = () => (out.length === 0 ? 40 : 180);     // keep the FIRST chunk tiny so audio starts fast
  for (const s of sentences) {
    if (buf && (buf + s).length > cap()) { out.push(buf.trim()); buf = ''; }
    buf += s;
    while (buf.length > cap()) {                        // a single oversized sentence: break at a space
      let cut = buf.lastIndexOf(' ', cap());
      if (cut <= 0) cut = cap();
      out.push(buf.slice(0, cut).trim()); buf = buf.slice(cut);
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}
// Play one synthesized chunk; resolves when it finishes OR is stopped (pause), so the pipeline never hangs.
function playBlob(arrayBuf, myGen) {
  return new Promise((resolve) => {
    if (myGen !== speakGen) return resolve();
    const url = URL.createObjectURL(new Blob([new Uint8Array(arrayBuf)], { type: 'audio/mpeg' }));
    ttsUrl = url; const a = new Audio(url); ttsAudio = a;
    a.preservesPitch = true; if ('webkitPreservesPitch' in a) a.webkitPreservesPitch = true;   // speed up without chipmunk pitch
    a.playbackRate = 1 + (ttsSpeed || 0) / 100;       // voice-speed slider: % over baseline
    let done = false;
    const fin = () => { if (done) return; done = true; URL.revokeObjectURL(url); if (ttsUrl === url) ttsUrl = null; resolve(); };
    a.onended = fin; a.onerror = fin; a.onpause = fin;   // onpause catches stopSpeech()'s pause
    a.play().catch(fin);
  });
}
async function speak(text) {
  if (!text) return;
  stopSpeech();                                       // cancel anything currently playing
  const myGen = ++speakGen;                           // claim this generation (latest speak wins)
  ttsBusy = true; setSpeakBtn(true); setActive('lbl-out', true);
  setDot('d-tts', 'work'); $('tts-out').textContent = 'synthesizing…'; $('tts-out').className = 'out';
  const chunks = chunkForSpeech(text);
  // Pipeline: kick off synthesis of the next chunk while the current one plays, so time-to-first-audio
  // is just the first sentence — not the entire reply.
  let nextP = claudible.tts(chunks[0], selectedVoice);
  for (let i = 0; i < chunks.length; i++) {
    const r = await nextP;
    if (myGen !== speakGen) return;                   // superseded by a newer speak()/stop
    if (i + 1 < chunks.length) nextP = claudible.tts(chunks[i + 1], selectedVoice);
    if (r.error) { setDot('d-tts', 'bad'); $('tts-out').textContent = 'TTS error: ' + JSON.stringify(r.error); stopSpeech(); return; }
    if (i === 0) { setDot('d-tts', 'ok'); $('tts-out').textContent = 'speaking…'; $('tts-out').className = 'out live'; }
    await playBlob(r.audio, myGen);
    if (myGen !== speakGen) return;
  }
  ttsAudio = null;                                    // playback finished — reset so Speak isn't stuck in "stop" mode
  ttsBusy = false; setSpeakBtn(false); setActive('lbl-out', false); setDot('d-tts', 'ok'); $('tts-out').textContent = 'ready';
}
$('speak').addEventListener('click', () => { if (ttsBusy || ttsAudio) stopSpeech(); else speak($('tts-in').value.trim()); });

// ---- voice selection + Voice Out top-bar controls, kept in sync with the drawer ----
function syncVoiceUI() {
  document.querySelectorAll('.vpill').forEach((x) => x.classList.toggle('on', x.dataset.voice === selectedVoice));
  const a = $('vout-auto'); if (a) { a.classList.toggle('on', alwaysSpeak); a.setAttribute('aria-pressed', String(alwaysSpeak)); }
  const t = $('always-toggle'); if (t) t.classList.toggle('on', alwaysSpeak);
  const cb = $('always-speak'); if (cb) cb.checked = alwaysSpeak;
}
function setVoice(v) { selectedVoice = v; savePrefs({ voice: v }); syncVoiceUI(); }
function setAlways(on) { alwaysSpeak = !!on; savePrefs({ alwaysSpeak: alwaysSpeak }); syncVoiceUI(); }
// drawer voice pills
document.querySelectorAll('.vpill').forEach((p) => p.addEventListener('mousedown', (e) => { e.preventDefault(); setVoice(p.dataset.voice); }));
// top-bar Voice Out: ■ stops Claude speaking, auto = always-speak toggle (voice SELECTION is the drawer .vpill pills)
if ($('vout-stop')) {
  $('vout-stop').addEventListener('click', async () => {
    if (ttsBusy || ttsAudio) { stopSpeech(); return; }
    if (lastReplyNow()) { speak(lastReplyNow()); return; }
    // Nothing captured for THIS tab — fetch the OPEN session's latest reply from its transcript so you can
    // re-listen (after a relaunch, or for a session opened from history). Empty → tell the user there's nothing.
    const sid = activeSession;
    if (sid) {
      try {
        const r = await claudible.latestReply(sid);
        if (r && r.text && r.text.trim()) {
          const t = AT(), reply = stripForSpeech(r.text);
          if (t) t.lastReply = reply;
          if ($('tts-in')) $('tts-in').value = reply;
          speak(reply); return;
        }
      } catch {}
    }
    toast('No text detected to read');
  });
  updateVoiceOutBtn();
}
if ($('vout-auto')) $('vout-auto').addEventListener('click', () => setAlways(!alwaysSpeak));

// ---- Voice-out speed slider (0–25% over baseline) ----
const speedRange = $('tts-speed'), speedVal = $('tts-speed-val');
function applyTtsSpeed(pct, save) {
  ttsSpeed = Math.max(0, Math.min(25, pct | 0));
  if (speedRange) speedRange.value = String(ttsSpeed);
  if (speedVal) speedVal.textContent = '+' + ttsSpeed + '%';
  if (ttsAudio) { try { ttsAudio.preservesPitch = true; ttsAudio.playbackRate = 1 + ttsSpeed / 100; } catch (e) {} }   // live, mid-playback
  if (save) savePrefs({ ttsSpeed: ttsSpeed });
}
if (speedRange) {
  speedRange.addEventListener('input', () => applyTtsSpeed(parseInt(speedRange.value, 10) || 0, false));
  speedRange.addEventListener('change', () => savePrefs({ ttsSpeed: ttsSpeed }));
}
// ---- Alerts: announce-when-done + chat chime ----
if ($('announce-done')) $('announce-done').addEventListener('change', (e) => { announceOn = e.target.checked; $('announce-toggle').classList.toggle('on', announceOn); savePrefs({ announce: announceOn }); });
if ($('chat-chime')) $('chat-chime').addEventListener('change', (e) => { chimeOn = e.target.checked; $('chime-toggle').classList.toggle('on', chimeOn); savePrefs({ chime: chimeOn }); });
if ($('full-readout')) $('full-readout').addEventListener('change', (e) => { fullReadout = e.target.checked; $('fullreadout-toggle').classList.toggle('on', fullReadout); savePrefs({ fullReadout: fullReadout }); });
if ($('sess-history')) $('sess-history').addEventListener('change', (e) => { $('sesshist-toggle').classList.toggle('on', e.target.checked); savePrefs({ sessionHistory: e.target.checked }); if (typeof refreshHistoryFeed === 'function') refreshHistoryFeed(); });   // writes through savePrefs → enters the prefs cache → never clobbered; main gate reads settings.json fresh
// soft, relaxing two-tone chime (Web Audio — no asset). Lazy ctx + resume (autoplay parks it until a gesture).
let _chimeCtx = null;
function playChime() {
  try {
    _chimeCtx = _chimeCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (_chimeCtx.state === 'suspended') _chimeCtx.resume();
    const ctx = _chimeCtx, now = ctx.currentTime, g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.12, now + 0.02);     // gentle attack
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);    // soft decay
    g.connect(ctx.destination);
    [880, 1320].forEach((f, i) => {                            // a soft perfect fifth — calm, not jarring
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const og = ctx.createGain(); og.gain.value = i ? 0.5 : 1;
      o.connect(og); og.connect(g); o.start(now); o.stop(now + 0.95);
    });
  } catch (e) {}
}
// quick rising two-note "blip" — distinct from the chat chime; played when someone joins your live session
let _joinCtx = null;
function playJoin() {
  try {
    _joinCtx = _joinCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (_joinCtx.state === 'suspended') _joinCtx.resume();
    const ctx = _joinCtx, t0 = ctx.currentTime;
    const note = (f, start, dur) => {
      const o = ctx.createOscillator(), og = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      og.gain.setValueAtTime(0.0001, start);
      og.gain.exponentialRampToValueAtTime(0.13, start + 0.015);
      og.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      o.connect(og); og.connect(ctx.destination); o.start(start); o.stop(start + dur + 0.02);
    };
    note(660, t0, 0.16);
    note(990, t0 + 0.12, 0.22);
  } catch (e) {}
}
// gentle descending "ding-dong" — distinct from playJoin's rising blip; played to the HOST the moment someone is
// ASKING to join (the approval prompt), so a join request is audible even when you're not looking at the screen.
let _reqCtx = null;
function playJoinRequest() {
  try {
    _reqCtx = _reqCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (_reqCtx.state === 'suspended') _reqCtx.resume();
    const ctx = _reqCtx, t0 = ctx.currentTime;
    const note = (f, start, dur) => {
      const o = ctx.createOscillator(), og = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      og.gain.setValueAtTime(0.0001, start);
      og.gain.exponentialRampToValueAtTime(0.11, start + 0.02);
      og.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      o.connect(og); og.connect(ctx.destination); o.start(start); o.stop(start + dur + 0.02);
    };
    note(784, t0, 0.20);            // ding…
    note(588, t0 + 0.17, 0.30);     // …dong — a soft fall, "someone's at the door"
  } catch (e) {}
}
// collapse / expand the voice-out text box
$('tts-collapse').addEventListener('click', () => {
  $('tts-wrap').classList.toggle('min');
  $('tts-collapse').classList.toggle('min');
});
// collapse / expand the voice-in last-transcript
$('stt-collapse').addEventListener('click', () => {
  $('stt-wrap').classList.toggle('min');
  $('stt-collapse').classList.toggle('min');
});
// Always Speak: auto-voice every Claude reply in the selected voice
$('always-speak').addEventListener('change', (e) => {
  setAlways(e.target.checked);
  setTimeout(() => term.focus(), 0);
});

// ---------- commands ----------
// Robust even when switching between commands: ESC closes any open menu (e.g. the /effort
// selector) / clears partial input, then type the command + Enter, then refocus the terminal.
// mousedown + preventDefault => the FIRST press registers even while the terminal holds focus
// (avoids the focus-war "click twice" problem).
const send = (cmd) => {
  sendInput('\x1b');                                   // close prior menu / clear input
  setTimeout(() => sendInput(cmd + '\r'), 120);        // then run the command
  setTimeout(() => term.focus(), 150);                    // keyboard back in the terminal
};
// Command bar: 5 pills visible, the rest reached by horizontal scroll/drag in the same width.
// Fire on pointer-UP (so a drag scrolls instead of triggering); preventDefault on pointer-DOWN
// holds focus in the terminal (keeps the click-twice focus-war fix above).
const cmdscroll = $('cmdscroll'), cmdwrap = cmdscroll.parentElement;
let cdrag = null;
function cmdEdges() {                                          // fade + arrow the side(s) that have more off-screen
  const max = cmdscroll.scrollWidth - cmdscroll.clientWidth;
  cmdwrap.classList.toggle('more-l', cmdscroll.scrollLeft > 2);
  cmdwrap.classList.toggle('more-r', cmdscroll.scrollLeft < max - 2);
}
{ const cl = $('cmd-left'), cr = $('cmd-right');             // arrow buttons (the existing scroll listener below keeps arrows/fades synced)
  if (cl) cl.addEventListener('click', () => cmdscroll.scrollBy({ left: -cmdscroll.clientWidth * 0.8, behavior: 'smooth' }));
  if (cr) cr.addEventListener('click', () => cmdscroll.scrollBy({ left: cmdscroll.clientWidth * 0.8, behavior: 'smooth' })); }
cmdscroll.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  cdrag = { x: e.clientX, sl: cmdscroll.scrollLeft, moved: false, pill: e.target.closest('.cmdpill'), pid: e.pointerId };
  try { cmdscroll.setPointerCapture(e.pointerId); } catch {}
});
cmdscroll.addEventListener('pointermove', (e) => {
  if (!cdrag) return;
  const dx = e.clientX - cdrag.x;
  if (Math.abs(dx) > 4) cdrag.moved = true;
  cmdscroll.scrollLeft = cdrag.sl - dx; cmdEdges();
});
const cmdUp = () => {
  if (!cdrag) return;
  const { moved, pill, pid } = cdrag; cdrag = null;
  try { cmdscroll.releasePointerCapture(pid); } catch {}
  if (!moved && pill && pill.dataset.cmd) { send(pill.dataset.cmd); if (pill.dataset.cmd === '/clear' && !(AT() && AT().kind === 'live')) resetStats(); }   // R39: a joined mirror's tracker is the HOST's (re-broadcast) — resetting the local copy painted zeros until the next status frame
};
cmdscroll.addEventListener('pointerup', cmdUp);
cmdscroll.addEventListener('pointercancel', cmdUp);
cmdscroll.addEventListener('wheel', (e) => {                   // vertical wheel → horizontal scroll over the bar
  if (!e.deltaY) return;
  cmdscroll.scrollLeft += e.deltaY; e.preventDefault(); cmdEdges();
}, { passive: false });
cmdscroll.addEventListener('scroll', cmdEdges);
new ResizeObserver(cmdEdges).observe(cmdscroll);              // recompute on width changes (sharing/sessions toggles)

// Context guardrail: the ctx bar becomes a one-tap /compact shortcut only once it's in the warn/crit zone.
// The context meter is display-only — clicking it must NOT auto-compact (removed by request).

// ---------- Claude's reply -> VOICE OUT + Agents (fed by the PER-TAB hook stream) ----------
// TURN-BUSY, MIRRORED FROM MAIN — never derived here. main.js's setGenBusy is the one writer: it arms on
// UserPromptSubmit and disarms on Stop, on pty exit, on a session switch, on tab close, and on a self-heal once a
// wedged pty has gone quiet. The renderer used to keep its own copy that ONLY a Stop hook could clear — so a turn
// killed by esc, a dead pty, or a crashed Claude left the row "working" forever, and every sidebar rebuild
// faithfully repainted that lie. syncRowFlairs was never the bug; the record it mirrors was.
claudible.onTabBusy((tabId, busy) => {
  const t = tabs.get(tabId); if (!t) return;
  if (t.busy === busy) return;                          // idempotent: main re-sends on every hook; don't repaint for a no-op
  t.busy = busy;
  // markTabBusy → syncRowFlairs(), which recomputes EVERY .sess row in the sidebar from truth — including the rows
  // inside an expanded non-active workspace's subtree. Deliberately NOT refreshExpandedTrees(): that re-RENDERS the
  // subtrees, and doing that on every turn start/stop is exactly the repaint-churn the anti-flicker work removed.
  markTabBusy(tabId, busy);
});

claudible.onHookLine((tabId, line) => {
  const t = tabs.get(tabId); if (!t) return;            // route every hook to the tab it came from
  let o; try { o = JSON.parse(line); } catch { return; }
  if (o.hook_event_name === 'UserPromptSubmit') {
    // NOT `t.busy = true` — main owns that flag and has already sent tab:busy for this very hook line (handleHook
    // runs before the raw line is forwarded), so t.busy is correct by the time we get here. See onTabBusy below.
    if (o.prompt) {
      try { claudible.historyAppend(String(o.prompt), (t.session && t.session !== 'new') ? t.session : '', t.wsId || '', t.tabId); } catch {}   // session-history: no-op unless the setting is on (main gates + stamps + persists). Pass the SUBMITTING tab's workspace + tabId so main can write to the right file AND attribute a co-drive prompt to the foreground guest.
      if (typeof refreshHistoryFeed === 'function' && $('diffpanel') && $('diffpanel').classList.contains('open')) setTimeout(refreshHistoryFeed, 120);   // live-update the feed ONLY when its drawer is actually open (else it's a wasted historyLoad + off-screen DOM rebuild every prompt)
    }
  } else if (o.hook_event_name === 'Stop') {
    // Likewise: main already cleared busy for this Stop. What's OURS is the attention flag below.
    // DONE-WHILE-YOU-WERE-AWAY: a BACKGROUND tab finished its turn. Flag it so its sidebar row pulses — with
    // several sessions running at once the only other cue was the row's busy dot silently going out. The flag
    // lives on the tab record (so a sidebar rebuild can't lose it) and clears when you activate that tab.
    if (tabId !== activeTabId) { t.attention = true; markTabAttention(t.tabId, true); }
    // A turn just finished: if this tab is still showing a "draft · unsaved" row, its transcript now exists on
    // disk, so refresh the sidebar to collapse that draft row into its proper saved session row.
    if (sidebarReady && t.wsId === activeWsId && sessListEl && sessListEl.querySelector('.sess.sess-draft[data-tab="' + t.tabId + '"]')) refreshSessions();
    if (o.last_assistant_message) {
      const reply = stripForSpeech(o.last_assistant_message);
      t.lastReply = reply;                  // remember it on ITS tab — Speak on that tab reads the right reply even if this turn finished in the background
      if (tabId === activeTabId) {   // only the FOREGROUND tab speaks / fills the Speak box, so background turns never talk over it
        $('tts-in').value = reply;          // populate the (collapsible) box for manual Speak
        updateVoiceOutBtn();                // enable ▶ Speak now that there's a reply
        if (alwaysSpeak) speak(reply);      // auto-speak the reply in the selected voice
        else { setDot('d-tts', 'ok'); if (announceOn && String(o.last_assistant_message).length > 700) speak('The task is complete.'); }   // long-task done cue (raw length — stripForSpeech: full reply, or 1500 when 'Read full replies' is off)
      }
    }
  } else if (o.hook_event_name === 'PreToolUse' && (o.tool_name === 'Task' || o.tool_name === 'Agent')) {
    onAgentStart(t, o);   // newer Claude Code spawns subagents via the 'Agent' tool, older via 'Task' — accept both
  } else if (o.hook_event_name === 'PostToolUse' && (o.tool_name === 'Task' || o.tool_name === 'Agent')) {
    onAgentDone(t, o);
  }
});
// Subagent/swarm token usage for THIS app-session (main baselines it per session; the statusLine meter only
// sees the main thread) — fold into the token counter.
claudible.onAgentTokens((tabId, agentTok) => {
  const t = tabs.get(tabId); if (!t) return;
  t.agentTok = agentTok || 0;
  if (t.tabId === activeTabId) repaintTracker(t);
});
// Workflow/swarm agents (read WSL-side from the session's subagents dir, since they emit no Task hooks).
claudible.onWorkflowAgents((tabId, workflows) => {
  const t = tabs.get(tabId); if (!t) return;
  t.workflows = Array.isArray(workflows) ? workflows : [];
  if (t.tabId === activeTabId) {
    renderAgents();
    if (!agentsView && t.workflows.some((w) => w.running > 0)) { const s = $('seg-agents'); if (s) s.classList.add('has-badge'); }   // a swarm is live while you're on the terminal
  }
});

// ---------- Agents tab: live view of Task subagents (PER TAB; paired by tool_use_id) ----------
let agentsView = false;
function onAgentStart(t, o) {
  const id = o.tool_use_id || ('a' + t.agents.size + '-' + Date.now());
  const ti = o.tool_input || {};
  t.agents.set(id, { id: id, desc: String(ti.description || ti.subagent_type || 'subagent'), type: String(ti.subagent_type || ''),
    prompt: String(ti.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 600),   // the agent's task → shown in the expanded card
    model: String(ti.model || '') || (t.model || ''),   // explicit override wins; else the agent inherits the tab's model AT SPAWN TIME (a later /model switch mustn't relabel old agents)
    status: 'running', startedAt: Date.now(), durationMs: null, ok: true });
  if (t.tabId === activeTabId) { renderAgents(); if (!agentsView) { const s = $('seg-agents'); if (s) s.classList.add('has-badge'); } }   // badge while you're on the terminal
}
function onAgentDone(t, o) {
  const a = o.tool_use_id && t.agents.get(o.tool_use_id); if (!a) return;
  a.status = 'done';
  a.durationMs = (o.duration_ms != null) ? o.duration_ms : (Date.now() - a.startedAt);
  const tr = o.tool_response;
  try { a.ok = !/"is_error"\s*:\s*true|"error"\s*:/i.test(JSON.stringify(tr || '').slice(0, 500)); } catch { a.ok = true; }
  // The Agent/Task PostToolUse payload is RICH — tokens, tool stats, duration, result — so a subagent row becomes a
  // full cockpit card straight from the hook (no transcript needed).
  if (tr && typeof tr === 'object' && !Array.isArray(tr)) {
    if (tr.status === 'error' || tr.status === 'failed') a.ok = false;
    if (typeof tr.totalDurationMs === 'number') a.durationMs = tr.totalDurationMs;
    if (typeof tr.totalTokens === 'number') a.tokens = tr.totalTokens;
    if (typeof tr.totalToolUseCount === 'number') a.toolCount = tr.totalToolUseCount;
    const ts = tr.toolStats || {};
    const NAMES = { readCount: 'Read', searchCount: 'Search', bashCount: 'Bash', editFileCount: 'Edit', otherToolCount: 'Other' };
    a.tools = Object.keys(NAMES).filter((k) => (ts[k] || 0) > 0).map((k) => ({ name: NAMES[k], target: '×' + ts[k] }));
    if ((ts.linesAdded || 0) + (ts.linesRemoved || 0) > 0) a.tools.push({ name: 'diff', target: '+' + (ts.linesAdded || 0) + ' −' + (ts.linesRemoved || 0) });
  }
  try {   // final result text (content blocks → text, or a plain string)
    const c = (tr && typeof tr === 'object' && 'content' in tr) ? tr.content : tr;
    const res = (typeof c === 'string') ? c : Array.isArray(c) ? c.map((x) => (x && x.text) || '').join(' ') : '';
    a.result = String(res || '').replace(/\s+/g, ' ').trim().slice(0, 280);
  } catch {}
  if (t.tabId === activeTabId) renderAgents();
}
function fmtDur(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return '';
  sec = Math.floor(sec);
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + 'm' + (s ? ' ' + s + 's' : '');
}
const SWARM_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2.2"/><circle cx="5" cy="16" r="2.2"/><circle cx="19" cy="16" r="2.2"/><path d="M12 7.2v3.2M10.3 12.1 6.7 14.3M13.7 12.1l3.6 2.2"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/></svg>';
const expandedAgents = new Set();   // agent ids the user has drilled into — re-applied across rebuilds so live updates don't collapse them
// Categorize a tool name → a color-coded badge class (forward-compatible: unknown tools fall to 'misc' + their name).
function toolCat(name) {
  const n = String(name || '');
  if (/^Bash/i.test(n)) return 'sh';
  if (/^(Read|Glob|Ls|NotebookRead)/i.test(n)) return 'read';
  if (/^(Grep|Search|Find)/i.test(n)) return 'find';
  if (/(Edit|Write|diff)/i.test(n)) return 'edit';
  if (/^(Web|Fetch)/i.test(n)) return 'web';
  if (/^(Task|Agent)/i.test(n)) return 'agent';
  return 'misc';
}
function typeHue(type) {   // the agent-type → left-rail hue (gives the swarm visual identity)
  const t = String(type || '').toLowerCase();
  if (t.includes('explore')) return '#5fb487';
  if (t.includes('plan')) return '#e0a93b';
  if (t.includes('review')) return '#cf625a';
  if (t.includes('code')) return '#b48ce0';
  if (t.includes('research') || t.includes('general')) return '#6aa6e0';
  return '#8493a6';
}
function toolBadge(t) { const b = document.createElement('span'); b.className = 'tb tb-' + toolCat(t.name); b.textContent = t.name; if (t.target) b.title = t.name + ' ' + t.target; return b; }
// One TILE per agent — a living cell in the swarm grid. Face: status dot · task name · type pill · a live "now" line
// (the tool it's running right now) · metrics (elapsed · tokens · tools). Click a rich tile to drill into the full
// task, tool-call feed, and result. Works for BOTH workflow-swarm agents (live tool feed) and Task subagents.
// Normalize any model spelling to a short human label: raw api ids ('claude-opus-4-8',
// 'claude-haiku-4-5-20251001'), statusline display names ('Fable 5'), or Agent-tool overrides ('sonnet').
function fmtModel(s) {
  s = String(s || '').trim();
  if (!s) return '';
  if (/\s/.test(s) && !/^claude-/i.test(s)) return s.toLowerCase();          // already a display name
  s = s.toLowerCase().replace(/^claude-/, '').replace(/-\d{8}$/, '');        // strip vendor prefix + date stamp
  return s.replace(/-(\d)/g, ' $1').replace(/(\d) (\d)/g, '$1.$2').replace(/-/g, ' ');   // opus-4-8 → opus 4.8
}
function agentTile(a, nowSec) {
  const running = a.status === 'running';
  const tools = Array.isArray(a.tools) ? a.tools : [];
  const rich = tools.length > 0 || !!(a.result && a.result.length) || (a.tokens || 0) > 0 || !!(a.prompt && a.prompt.trim());
  const tile = document.createElement('div');
  tile.className = 'agent-tile ' + (running ? 'running' : (a.ok === false ? 'err' : 'done')) + (rich ? ' rich' : '') + (expandedAgents.has(a.id) ? ' expanded' : '');
  if (a.type) tile.style.setProperty('--rail', typeHue(a.type));
  const label = a.desc || a.label || 'agent';
  // top row: status dot · task name · type pill
  const top = document.createElement('div'); top.className = 'tile-top';
  const dot = document.createElement('span'); dot.className = 'tile-dot'; top.appendChild(dot);
  const name = document.createElement('div'); name.className = 'tile-name'; name.textContent = label; name.title = label; top.appendChild(name);
  if (a.type) { const tp = document.createElement('span'); tp.className = 'tile-type'; tp.textContent = a.type; top.appendChild(tp); }
  // model chip — WHICH brain is running this agent (raw id from a workflow transcript, display name or the
  // Agent-tool override for hook agents). Users deliberately mix tiers (cheap sweeps on sonnet, judges on
  // opus); the cockpit must show the mix.
  const mdl = fmtModel(a.model);
  if (mdl) { const mp = document.createElement('span'); mp.className = 'tile-model'; mp.textContent = mdl; mp.title = 'model: ' + a.model; top.appendChild(mp); }
  tile.appendChild(top);
  // "now" line: the current action — pulses while running (the watch-it-think magic)
  const now = document.createElement('div'); now.className = 'tile-now';
  const ind = document.createElement('span'); ind.className = 'tile-now-ind'; now.appendChild(ind);
  if (running) {
    const lt = tools.length ? tools[tools.length - 1] : null;   // workflow agents carry a live tool feed; latest = what it's doing now
    if (lt) { const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = lt.name; now.appendChild(nm);
      const tg = document.createElement('span'); tg.className = 'tg'; tg.textContent = lt.target || ''; now.appendChild(tg); }
    else { const tg = document.createElement('span'); tg.className = 'tg'; tg.textContent = 'working…'; now.appendChild(tg); }   // Task subagents report tools only at the end → show a live "working…"
  } else {
    const tg = document.createElement('span'); tg.className = 'tg';
    tg.textContent = (a.result && a.result.trim()) ? a.result.trim() : ((a.toolCount || 0) ? (a.toolCount + ' tool calls') : 'done');
    now.appendChild(tg);
  }
  tile.appendChild(now);
  // metrics foot: elapsed · tokens · tools (+ a chevron on rich tiles)
  const foot = document.createElement('div'); foot.className = 'tile-foot';
  const fm = (cls, html, ds) => { const e = document.createElement('span'); e.className = 'fm ' + cls; e.innerHTML = html; if (ds != null) e.dataset.start = ds; foot.appendChild(e); };
  const startSec = a.start || (a.startedAt ? a.startedAt / 1000 : null);
  if (running) fm('dur', '<b>' + (startSec ? fmtDur(nowSec - startSec) : '0s') + '</b>', startSec || '');
  else { const d = (a.durationMs != null) ? fmtDur(a.durationMs / 1000) : ((a.start && a.last) ? fmtDur(a.last - a.start) : ''); if (d) fm('dur', '<b>' + d + '</b>'); }
  if ((a.tokens || 0) > 0) fm('tok', '<b>' + fmtK(a.tokens) + '</b> tok');
  const tc = a.toolCount || tools.length; if (tc > 0) fm('tool', '<b>' + tc + '</b> ' + (tc === 1 ? 'tool' : 'tools'));
  if (a.ok === false) fm('err', 'failed');
  if (rich) { const chev = document.createElement('span'); chev.className = 'agent-chev'; chev.textContent = '⌄'; foot.appendChild(chev); }
  tile.appendChild(foot);
  // drill-down detail: task · full tool feed · result
  if (rich) {
    const det = document.createElement('div'); det.className = 'tile-detail';
    const taskText = (a.prompt && a.prompt.trim()) || (label !== 'agent' ? label : '');
    if (taskText) { const task = document.createElement('div'); task.className = 'agent-task'; task.textContent = taskText; det.appendChild(task); }
    if (tools.length) {
      const feed = document.createElement('div'); feed.className = 'agent-feed';
      tools.forEach((t) => { const r = document.createElement('span'); r.className = 'agent-tool';
        r.appendChild(toolBadge(t)); if (t.target) { const s = document.createElement('span'); s.className = 'agent-tt'; s.textContent = t.target; r.appendChild(s); } feed.appendChild(r); });
      det.appendChild(feed);
    }
    if (!running && a.result) { const res = document.createElement('div'); res.className = 'agent-result'; res.textContent = a.result; det.appendChild(res); }
    tile.appendChild(det);
    tile.addEventListener('click', () => {
      if (expandedAgents.has(a.id)) { expandedAgents.delete(a.id); tile.classList.remove('expanded'); }
      else { expandedAgents.add(a.id); tile.classList.add('expanded'); }
    });
  }
  return tile;
}
let _agentsSig = '';
function renderAgents() {
  const el = $('agents-list'); if (!el) return;
  const at = AT();
  const wfs = (at && at.workflows) || [];                                     // ALL recent swarms (script prunes to 15 min) so DONE agents linger too
  const taskAgents = at ? Array.from(at.agents.values()).reverse() : [];      // hook-fed Task subagents (newest first)
  const nowSec = Date.now() / 1000;
  // Unify BOTH kinds (workflow-swarm agents + hook-fed Task subagents) into one list and group by STATUS —
  // Running then Done — so the pane reads like "your agents, at a glance" instead of mixing per-swarm sections.
  const all = [];
  wfs.forEach((wf) => (wf.agents || []).forEach((a) => all.push(a)));
  taskAgents.forEach((a) => all.push(a));
  { const liveIds = new Set(all.map((a) => a.id)); for (const id of expandedAgents) if (!liveIds.has(id)) expandedAgents.delete(id); }   // prune expand state for swarms that dropped out — no leak, no stale pre-expand
  const running = all.filter((a) => a.status === 'running');
  const doneAll = all.filter((a) => a.status !== 'running');
  const endSec = (a) => a.last || (a.startedAt ? (a.startedAt + (a.durationMs || 0)) / 1000 : (a.start || 0));
  doneAll.sort((x, y) => endSec(y) - endSec(x));                              // most-recently-finished first across BOTH sources, so the cap drops the oldest
  const done = doneAll.slice(0, 20);                                          // cap the recent-history list
  // Rebuild the DOM only when membership/status actually changes — NOT on every 1s tick (avoids re-flashing the
  // CSS entry animations). When unchanged, just advance the running timers in place.
  // toolCount + tokens in the sig → the cockpit rebuilds as a running agent does work (new tool calls / tokens),
  // not just on membership changes. Expanded rows survive it (expandedAgents set); entry animation removed so no flash.
  const totalTok = all.reduce((s, a) => s + (a.tokens || 0), 0);
  const totalTools = all.reduce((s, a) => s + (a.toolCount || (Array.isArray(a.tools) ? a.tools.length : 0)), 0);
  // Rebuild only when membership/status/work changes — NOT every 1s tick. The latest tool per RUNNING agent is in the
  // sig so the "now" line updates live as it works; totalTok too so the hero re-reads. Between rebuilds, only the
  // running elapsed timers tick in place (below). Expanded tiles survive (expandedAgents set).
  const latestTool = (a) => (a.tools && a.tools.length) ? (a.tools[a.tools.length - 1].name + (a.tools[a.tools.length - 1].target || '')) : '';
  const sig = JSON.stringify([running.map((a) => (a.desc || a.label || '') + (a.id || '') + (a.toolCount || 0) + (a.tokens || 0) + latestTool(a)), done.map((a) => (a.desc || a.label || '') + a.status + (a.toolCount || 0)), doneAll.length, totalTok]);
  if (sig === _agentsSig) {
    el.querySelectorAll('[data-start]').forEach((m) => { const b = m.querySelector('b') || m; b.textContent = fmtDur(nowSec - parseFloat(m.dataset.start)); });   // tick the running elapsed timers in place
    return;
  }
  _agentsSig = sig;
  if (!all.length) {
    el.innerHTML = '<div class="agents-empty"><span class="agents-empty-ico">' + SWARM_SVG + '</span>'
      + 'No agents running.<br>When Claude spawns subagents or a workflow swarm, they light up here — live.</div>';
    return;
  }
  el.innerHTML = '';
  // ── hero telemetry: the swarm as ONE living system ──
  const live = running.length > 0;
  const hero = document.createElement('div'); hero.className = 'agents-hero' + (live ? ' live' : '');
  hero.innerHTML = '<span class="hero-glyph">' + SWARM_SVG + '</span>';
  const hm = document.createElement('div'); hm.className = 'hero-main';
  const ht = document.createElement('div'); ht.className = 'hero-title'; ht.appendChild(document.createTextNode('Agent Swarm'));
  if (live) { const pill = document.createElement('span'); pill.className = 'hero-live-pill'; pill.innerHTML = '<span class="ld"></span>' + running.length + ' live'; ht.appendChild(pill); }
  const hs = document.createElement('div'); hs.className = 'hero-sub';
  hs.textContent = all.length + (all.length === 1 ? ' agent' : ' agents') + ' · ' + doneAll.length + ' done' + (totalTools ? ' · ' + totalTools + ' tool calls' : '');
  hm.appendChild(ht); hm.appendChild(hs); hero.appendChild(hm);
  const stats = document.createElement('div'); stats.className = 'hero-stats';
  const hstat = (cls, n, l) => { const s = document.createElement('div'); s.className = 'hstat ' + cls; s.innerHTML = '<div class="hstat-n">' + n + '</div><div class="hstat-l">' + l + '</div>'; stats.appendChild(s); };
  hstat('run', running.length, 'running');
  hstat('done', doneAll.length, 'done');
  if (totalTok > 0) hstat('tok', fmtK(totalTok), 'tokens');
  hero.appendChild(stats);
  const prog = document.createElement('div'); prog.className = 'hero-prog';
  const pf = document.createElement('div'); pf.className = 'hero-prog-fill'; pf.style.width = (all.length ? Math.round((doneAll.length / all.length) * 100) : 0) + '%'; prog.appendChild(pf); hero.appendChild(prog);
  el.appendChild(hero);
  // ── groups: Running (the live action) then Done, each a responsive grid so parallelism is visible ──
  const group = (title, list) => {
    if (!list.length) return;
    const g = document.createElement('div'); g.className = 'agents-group';
    const hd = document.createElement('div'); hd.className = 'agents-group-hd'; hd.textContent = title; g.appendChild(hd);
    const grid = document.createElement('div'); grid.className = 'agents-grid'; list.forEach((a) => grid.appendChild(agentTile(a, nowSec))); g.appendChild(grid);
    el.appendChild(g);
  };
  group('Running · ' + running.length, running);
  group('Done · ' + doneAll.length + (doneAll.length > done.length ? ' (showing ' + done.length + ')' : ''), done);
}
function setAgentsView(on) {
  agentsView = on;
  const pane = $('agents-pane'); if (pane) pane.classList.toggle('show', on);
  const tr = document.querySelector('.termrow'); if (tr) tr.classList.toggle('agents-on', on);   // hide save/git tabs behind the pane
  const st = $('seg-term'), sa = $('seg-agents');
  if (st) st.classList.toggle('on', !on);
  if (sa) { sa.classList.toggle('on', on); if (on) sa.classList.remove('has-badge'); }
  if (on) renderAgents(); else setTimeout(() => term.focus(), 30);
}
if ($('seg-term')) {
  $('seg-term').addEventListener('click', () => setAgentsView(false));
  $('seg-agents').addEventListener('click', () => setAgentsView(true));
  setInterval(() => {
    const at = AT(); if (!agentsView || !at) return;
    const taskRunning = Array.from(at.agents.values()).some((a) => a.status === 'running');
    const wfRunning = (at.workflows || []).some((w) => w.running > 0);
    if (taskRunning || wfRunning) renderAgents();   // live-tick the elapsed timers while anything runs
  }, 1000);
}

// (Save Session pop-out removed — sessions auto-save; the git button sits bottom-right. buildTranscript() dropped as dead code.)

// ---------- right-click menu: Copy / Paste / Select All (terminal + selectable UI text) ----------
// Electron ships no default context menu and xterm copies nothing on its own, so wire one up. Copy uses
// the xterm selection inside the terminal and the DOM selection elsewhere; the clipboard is handled in
// the main process so it works regardless of renderer clipboard permissions.
const ctxmenu = $('ctxmenu');
const hideCtx = () => { ctxmenu.style.display = 'none'; };
window.addEventListener('mousedown', (e) => { if (!ctxmenu.contains(e.target)) hideCtx(); }, true);
window.addEventListener('blur', hideCtx);
window.addEventListener('scroll', hideCtx, true);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtx(); });

function insertIntoField(el, text) {
  el.focus();
  const s = el.selectionStart ?? el.value.length, end = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, s) + text + el.value.slice(end);
  const pos = s + text.length; try { el.setSelectionRange(pos, pos); } catch {}
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function selectNodeText(node) {                                // select a whole DOM node's text (for Copy on non-input regions)
  const r = document.createRange(); r.selectNodeContents(node);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
}
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const inTerm = !!e.target.closest('#terminal');
  const chatLog = e.target.closest('#chat-log');                // right-clicked inside the viewer chat log
  const field = e.target.closest('input, textarea');
  const fS = field ? (field.selectionStart || 0) : 0, fE = field ? (field.selectionEnd || 0) : 0;
  // the actual selected text wherever was clicked: terminal, an editable field, or document text (chat log)
  const sel = inTerm ? term.getSelection() : (field ? String(field.value || '').substring(fS, fE) : String(window.getSelection() || ''));
  const items = [];
  if (sel && sel.trim()) items.push({ label: 'Copy', act: () => claudible.clipWrite(sel) });
  if (sel && sel.trim() && (inTerm || field)) items.push({ label: 'Cut', act: () => {
    claudible.clipWrite(sel);
    if (field) {                                                // splice the selection out of the field
      field.value = field.value.slice(0, fS) + field.value.slice(fE);
      try { field.selectionStart = field.selectionEnd = fS; } catch {}
      field.dispatchEvent(new Event('input', { bubbles: true })); field.focus();
    } else { sendInput('\x7f'.repeat(sel.length)); term.clearSelection(); }   // terminal: delete the marked text
  } });
  if (inTerm || field) items.push({ label: 'Paste', act: async () => {
    const t = await claudible.clipRead(); if (!t) return;
    if (inTerm) { sendInput('\x1b[200~' + t + '\x1b[201~'); term.focus(); }   // bracketed paste, no auto-submit
    else insertIntoField(field, t);
  } });
  if (inTerm || field) items.push({ label: 'Select All', act: () => { if (inTerm) term.selectAll(); else field.select(); } });
  else if (chatLog) items.push({ label: 'Select All', act: () => selectNodeText(chatLog) });   // then right-click → Copy
  if (!items.length) return;                                  // nothing actionable here

  ctxmenu.innerHTML = '';
  for (const it of items) {
    const d = document.createElement('div');
    d.className = 'ctxitem'; d.textContent = it.label;
    d.addEventListener('mousedown', (ev) => { ev.preventDefault(); Promise.resolve(it.act()).catch(() => {}); hideCtx(); });
    ctxmenu.appendChild(d);
  }
  ctxmenu.style.display = 'block';                            // measure, then clamp into the viewport
  const r = ctxmenu.getBoundingClientRect();
  ctxmenu.style.left = Math.min(e.clientX, window.innerWidth - r.width - 6) + 'px';
  ctxmenu.style.top = Math.min(e.clientY, window.innerHeight - r.height - 6) + 'px';
});

// ---------- live terminal sharing ----------
// Start/stop a local share server (+ cloudflared tunnel) that streams THIS terminal to a remote
// colleague over a ONE-TIME link. The server runs in the main process; here we drive the lifecycle,
// the link, and the approve-guest prompt. Two controls protect access: (1) you approve each new guest
// before any data flows, (2) the link is consumed once that guest is approved.
// Two independent reasons the share tunnel runs: COLLAB (a synced session — Crazy can Join live, invisible in
// the bottom-left) and WEB (you pressed "Share a live link" — shows the active indicator). Tunnel is up iff either.
let webShare = false;        // manual web link active → drives the bottom-left "sharing" indicator ONLY
let collabLive = false;      // active workspace is a synced repo session → wants the tunnel for native peer-join
let tunnelUp = false, tunnelBusy = false;          // is the share server actually running / a start-stop in flight
let guestCount = 0, chatPanelShown = false;
let lastShareUrl = '', lastShareRemote = true, lastShareNote = null, lastShareReadOnly = false;
const shareBtn = $('share-btn'), shareLink = $('share-link'), shareOut = $('share-out');
// The bottom-left indicator reflects ONLY a manual web link (never collab) — collaboration stays invisible here.
function webShareUI(on) {
  shareBtn.textContent = on ? 'Stop sharing' : 'Share a live link';
  shareBtn.classList.toggle('live', on);
  setActive('lbl-share', on);
  setDot('d-share', on ? 'ok' : '');
  const sr = $('share-reset'); if (sr) sr.style.display = on ? '' : 'none';   // "reset access" only while web-sharing
  if (!on) { shareLink.style.display = 'none'; shareLink.value = ''; }
}
// "Reset access": disconnect every current guest + revoke the old link (server regenerateLink), then surface the fresh one.
{ const sr = $('share-reset'); if (sr) sr.addEventListener('click', async () => {
    let r = null; try { r = await claudible.shareNewLink(); } catch {}
    if (r && r.ok) { if (r.url) { shareLink.value = r.url; shareLink.style.display = ''; } toast('Access reset — guests disconnected, old link revoked'); }
    else { toast('Could not reset access' + (r && r.error ? ': ' + humanError(r.error) : '')); }
  }); }
// The collaboration chat/voice column appears when you're web-sharing OR a viewer/peer has actually joined — so
// an idle synced session stays clean, but the panel is there the moment someone's watching.
function refreshChatPanel() {
  const t = AT(), liveActive = !!(t && t.kind === 'live');
  const show = webShare || guestCount > 0 || liveActive;     // also show the panel while viewing a joined session
  document.querySelector('.body').classList.toggle('sharing', show);
  const becameShown = show && !chatPanelShown;
  chatPanelShown = show;
  if (becameShown) { renderChatLog(); renderRoster(); }      // first reveal → paint the current context (don't yank scroll on every refresh)
}
// Re-point all collab UI (chat panel + roster + live-bar + voice) at the active tab's context. Called on tab switch.
function refreshCollabSurfaces() {
  refreshChatPanel();
  if (chatPanelShown) { renderChatLog(); renderRoster(); }   // context changed → repaint chat + roster for the new tab
  renderLiveBar(); repaintVoiceForActive(); updateSessionCtrlBtn();
}
// presence roster in the chat header: you + each viewer with a green(here)/amber(AFK)/red(closed-tab) light
// Your collab display name (settings) — what teammates see when you're in a synced session. Falls back to the
// web-share name then a generic label. Used for the live bar, your roster chip, advertising, and joining.
function collabName() { return (loadPrefs().collabName || '').trim(); }
function youName() {
  const t = AT();
  if (t && t.kind === 'live') return t.liveYou || collabName() || 'You';   // on a joined session you appear by the name the host registered (disambiguated if it collided), falling back to your collab name
  return collabLive ? (collabName() || 'You') : (hostDisplayName || collabName() || 'You');
}
// The "who's here" members for the ACTIVE context: your guests (host-share), or — on a joined tab — the host plus
// every other participant from that session's roster (you're rendered separately as the "you" chip).
const nameEqCI = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();   // the server dedups names case-INSENSITIVELY (its nameTaken/eqCI) — every renderer-side name comparison must match, or "crazydev" vs "CrazyDev" renders twice
function activeRosterMembers() {
  const t = AT();
  if (t && t.kind === 'live') {
    const me = t.liveYou || collabName() || 'Guest', out = [];   // dedup against the name the host's server actually registered us under (its hello.you — disambiguated if our name collided) so we never list ourselves twice
    if (t.hostName) out.push({ name: t.hostName, state: 'active', host: true });
    (t.roster || []).forEach((g) => { if (!nameEqCI(g.name, me)) out.push(g); });
    return out;
  }
  return lastRoster;
}
// I'm the HOST of a live session (so I may terminate it / kick guests) when I'm NOT viewing someone else's joined
// tab AND I'm sharing one of my own sessions (or a manual web link). A guest must never see these controls.
function amHostingLive() { const t = AT(); return !(t && t.kind === 'live') && (!!sharedSessionId || webShare); }
// The single session-control button in the chat head: the HOST sees "End Session" (terminate for everyone); a
// JOINER (viewing a peer's live tab) sees "Leave Session" (disconnect + fall back to their own view). Mutually
// exclusive — neither ever sees the other's button.
function updateSessionCtrlBtn() {
  const btn = $('chat-terminate'); if (!btn) return;
  const t = AT();
  if (t && t.kind === 'live') { btn.style.display = ''; btn.textContent = 'Leave Session'; btn.title = 'Leave this live session and return to your own'; }
  else if (amHostingLive()) { btn.style.display = ''; btn.textContent = 'End Session'; btn.title = 'End the live session for everyone'; }
  else { btn.style.display = 'none'; }
}
function renderRoster(roster) {
  const el = $('chat-roster'); if (!el) return;
  el.innerHTML = '';
  const hosting = amHostingLive();
  updateSessionCtrlBtn();                                            // host: "End Session" · joiner: "Leave Session" (mutually exclusive)
  const you = document.createElement('span'); you.className = 'rmember you';
  you.dataset.name = youName();                                       // voice-state projection matches pills by this (textContent also holds the ✕ kick glyph)
  const yd = document.createElement('span'); yd.className = 'rdot ok'; you.appendChild(yd);
  you.appendChild(document.createTextNode(youName()));
  el.appendChild(you);
  activeRosterMembers().forEach((g) => {
    const cls = g.state === 'active' ? 'ok' : (g.state === 'idle' ? 'idle' : 'gone');
    const m = document.createElement('span'); m.className = 'rmember' + (g.state === 'gone' ? ' gone' : '');
    m.dataset.name = g.name;
    m.title = g.host ? 'host' : (g.state === 'active' ? 'here' : (g.state === 'idle' ? 'away / AFK' : 'closed the tab'));
    const d = document.createElement('span'); d.className = 'rdot ' + cls;
    m.appendChild(d); m.appendChild(document.createTextNode(g.name));
    if (hosting && !g.host && g.state !== 'gone') {                  // host can remove a guest who's present
      const k = document.createElement('button'); k.className = 'rkick'; k.type = 'button';
      k.title = 'Remove ' + g.name; k.setAttribute('aria-label', 'Remove ' + g.name); k.textContent = '✕';
      k.addEventListener('click', (e) => { e.stopPropagation(); claudible.shareKick(g.name).then((r) => { toast((r && r.ok) ? ('Removed ' + g.name) : ('Could not remove ' + g.name + ' — they may have already left')); }).catch(() => toast('Could not remove ' + g.name)); });   // R36: failure was completely silent — the row just sat there
      m.appendChild(k);
    }
    el.appendChild(m);
  });
  applyVoiceMarks();                                                  // project in-call state onto these fresh pills (one pill per person — never a second row for voice)
  computeRosterOverflow();                                            // fold members past the strip's width into a "+N" pop-down
}
// Measure the roster strip and MOVE any chips that overflow its width into the "+N" pop-down (move, not clone, so
// the kick buttons keep working). "You" (the first chip) always stays visible.
function computeRosterOverflow() {
  const el = $('chat-roster'), more = $('roster-more'), pop = $('roster-pop'); if (!el || !more || !pop) return;
  requestAnimationFrame(() => {
    if (!document.body.contains(el)) return;
    const avail = el.clientWidth, overflow = [];
    if (avail <= 0) { more.style.display = 'none'; return; }          // chat panel hidden / not laid out yet — don't fold everyone into "+N"
    Array.prototype.forEach.call(el.children, (c, i) => {
      if (i >= 1 && (c.offsetLeft + c.offsetWidth) > avail - 40) overflow.push(c);   // reserve ~40px for the +N pill
    });
    pop.innerHTML = '';
    if (overflow.length) {
      overflow.forEach((c) => pop.appendChild(c));
      more.textContent = '+' + overflow.length + ' ▾'; more.style.display = '';
    } else { more.style.display = 'none'; pop.classList.remove('show'); }
  });
}
// the "+N" pill toggles the pop-down; a click anywhere else closes it
{ const rm = $('roster-more'); if (rm) rm.addEventListener('click', (e) => { e.stopPropagation(); const p = $('roster-pop'); if (p) p.classList.toggle('show'); }); }
document.addEventListener('click', (e) => { const p = $('roster-pop'); if (p && p.classList.contains('show') && !e.target.closest('#roster-pop') && !e.target.closest('#roster-more')) p.classList.remove('show'); });
// End the live session entirely: disconnect everyone + drop the tunnel/advertisement (mirrors "Stop sharing").
async function terminateLive() {
  const go = await modalChoice({
    title: 'End the live session?',
    body: 'Everyone viewing will be disconnected and the share link stops working. Your session keeps running here.',
    choices: [{ key: 'end', label: 'End live session', danger: true }, { key: 'cancel', label: 'Cancel' }],
  });
  if (go !== 'end') return;
  endLiveNow('Live session ended');
}
// The one place the live session actually ends. Its only callers: `terminateLive` (the host's explicit "End
// Session") and share:force-end — which main sends when the thing being shared is DESTROYED (its workspace deleted,
// or its tab closed). deleteSession clears the same state inline once the delete is guaranteed. Navigation never is.
function endLiveNow(msg) {
  if (sharedSessionId) { sharedSessionId = null; sharedWsId = null; }
  if (webShare) { webShare = false; webShareUI(false); }
  try { if (hostVoice && hostVoice.isJoined && hostVoice.isJoined()) hostVoice.leave(); } catch {}   // R20: the host's own voice-room membership outlived the share — mic stayed hot and the next share inherited a ghost member; every guest path already drops voice on leave, the HOST's end paths never did
  guestCount = 0; lastRoster = []; hostChat.length = 0;            // drop viewers + WIPE the chat buffer so the panel/roster/live-bar clear AND a future share never revives this ended session's chat
  updateCollab(); updateAdvertise(); refreshCollabSurfaces(); refreshSessions(); refreshExpandedTrees();   // updateCollab→ensureTunnel drops the tunnel (closes guests). refreshSessions is ACTIVE-LIST-ONLY — without refreshExpandedTrees the ended session keeps its green rail + Live badge in any other project's open tree
  toast(msg);
}
// The shared thing was destroyed — its project deleted, or its tab closed. Main has already frozen the mirror.
// Finish the job here rather than leaving a tunnel pinned to a pty that no longer exists (the old code just paused,
// so guests kept a socket to a dead terminal while the host's UI still said "live").
if (claudible.onShareForceEnd) claudible.onShareForceEnd((p) => endLiveNow((p && p.reason === 'tab-closed')
  ? 'That tab was live-shared — the live session ended with it'
  : 'That project was deleted — the live session ended with it'));
// The cockpit LIVE bar: visible whenever this session is live (synced collab) — shows you + everyone who's joined.
let lastRoster = [];
function renderLiveBar() {
  const bar = $('livebar'); if (!bar) return;
  const t = AT(), liveTab = !!(t && t.kind === 'live');
  // collabLive now means "a session of mine is shared", independent of what I'm looking at (that's what keeps the
  // tunnel up while I work elsewhere). The BAR, though, describes the session ON SCREEN — so the full "who's here"
  // bar paints only on the shared tab, else it would claim an unrelated conversation is live. (Before main's pin
  // lands, match by session.)
  const onSharedTab = !!(t && t.kind !== 'live' && ((sharedTabIdR != null && t.tabId === sharedTabIdR) || (sharedSessionId && t.session === sharedSessionId)));
  bar.classList.remove('elsewhere');
  // …but a host browsing another session must still SEE that their live session is running. Hiding the bar
  // outright is what made "I clicked away" look like "it ended". Show a compact, unmistakable reminder that
  // jumps back to it. (Only for a session share — a manual web link has no session tab to return to.)
  if (!liveTab && collabLive && !onSharedTab && sharedSessionId) {
    bar.style.display = 'flex'; bar.classList.add('elsewhere');
    const mem0 = $('live-members'); if (!mem0) return;
    mem0.innerHTML = '';
    const n = activeRosterMembers().filter((g) => g.state !== 'gone').length;
    const jump = document.createElement('button');
    jump.className = 'live-jump';
    jump.textContent = 'in “' + (sharedSessionLabel() || 'another session') + '”' + (n ? ' · ' + n + ' watching' : '') + ' — open it';
    jump.title = 'Your live session is still running. Click to go back to it.';
    jump.addEventListener('click', () => { const r = sharedTabIdR != null ? tabs.get(sharedTabIdR) : null; if (r) setActiveTab(r.tabId); });
    mem0.appendChild(jump);
    return;
  }
  if (!(collabLive && onSharedTab) && !liveTab) { bar.style.display = 'none'; return; }   // show while viewing the session I host, OR a joined one
  bar.style.display = 'flex';
  const mem = $('live-members'); if (!mem) return;
  mem.innerHTML = '';
  const you = document.createElement('span'); you.className = 'live-member you';
  const yd = document.createElement('span'); yd.className = 'md ok'; you.appendChild(yd);
  you.appendChild(document.createTextNode(youName())); mem.appendChild(you);
  activeRosterMembers().forEach((g) => {            // just you until someone joins — no "waiting…" filler
    const cls = g.state === 'active' ? 'ok' : (g.state === 'idle' ? 'idle' : 'gone');
    const m = document.createElement('span'); m.className = 'live-member' + (g.state === 'gone' ? ' gone' : '');
    m.title = g.host ? 'host' : (g.state === 'active' ? 'here' : (g.state === 'idle' ? 'away / AFK' : 'left'));
    const d = document.createElement('span'); d.className = 'md ' + cls;
    m.appendChild(d); m.appendChild(document.createTextNode(g.name)); mem.appendChild(m);
  });
}
claudible.onShareRoster((roster) => { lastRoster = roster || []; renderRoster(roster); renderLiveBar(); });
claudible.onShareTunnelDown(() => {   // the public cloudflared tunnel dropped mid-share → reflect it so guests aren't met with a silent refusal
  tunnelUp = false; lastShareUrl = ''; lastShareRemote = false;
  toast('Live link dropped — the tunnel went down. Toggle Share Live off then on for a fresh link.');
  renderLiveBar(); refreshChatPanel();
});
if (claudible.onUpdateAvailable) claudible.onUpdateAvailable((p) => {   // notice-only: installed builds otherwise NEVER learn a fix shipped
  toast('Claudible ' + p.latest + ' is out (you run ' + p.mine + ') — grab the new installer from the GitHub releases page.');
});
if (claudible.onAdvertiseLost) claudible.onAdvertiseLost((p) => {   // the presence heartbeat lost the one-host-per-session claim (our presence went stale — sleep/outage — and a collaborator went live on the same session) → stop claiming to share
  sharedSessionId = null; sharedWsId = null; advertisedSession = null;
  updateCollab(); updateAdvertise(); refreshSessions(); refreshExpandedTrees();
  toast(((p && p.by) || 'A collaborator') + ' went live on this session while you were away — you’re no longer sharing it. Use Join to hop into theirs.');
});

// floating per-person VOLUME control — right-click a voice member to set how loud YOU hear them (listener-side,
// 0–200%). Local only; never changes what anyone else hears. Persists across rejoin via the voice room's volume map.
let volPop = null;
function closeVolumePopover() {
  if (!volPop) return;
  volPop.remove(); volPop = null;
  document.removeEventListener('mousedown', onVolOutside, true);
  document.removeEventListener('keydown', onVolKey, true);
}
function onVolOutside(e) { if (volPop && !volPop.contains(e.target)) closeVolumePopover(); }
function onVolKey(e) { if (e.key === 'Escape') closeVolumePopover(); }
function openVolumePopover(anchor, id, name, room) {
  closeVolumePopover();
  const cur = Math.round((room.getVolume ? room.getVolume(id) : 1) * 100);
  const pop = document.createElement('div');
  pop.style.cssText = 'position:fixed;z-index:9999;display:flex;flex-direction:column;gap:8px;min-width:190px;padding:11px 13px;border:1px solid var(--hairline);border-radius:11px;background:linear-gradient(180deg,#14171c,#0e1013);box-shadow:0 16px 44px rgba(0,0,0,.6);font-family:inherit;color:#e7eaef';
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;font-size:11px;color:#9097a1;gap:10px';
  const hn = document.createElement('span'); hn.textContent = '🔊 ' + name;
  hn.style.cssText = 'font-weight:600;color:#cfd6df;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  const pct = document.createElement('span'); pct.textContent = cur + '%'; pct.style.cssText = 'font-variant-numeric:tabular-nums';
  head.appendChild(hn); head.appendChild(pct);
  const slider = document.createElement('input');
  slider.type = 'range'; slider.min = '0'; slider.max = '200'; slider.step = '5'; slider.value = String(cur);
  slider.style.cssText = 'width:100%;accent-color:#5fb487;cursor:pointer';
  const apply = (v) => { pct.textContent = v + '%'; try { room.setVolume(id, v / 100); } catch (e) {} };
  slider.addEventListener('input', () => apply(+slider.value));
  const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:6px';
  const mk = (txt, val) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = txt;
    b.style.cssText = 'flex:1;font:inherit;font-size:10.5px;color:#9097a1;background:#191c22;border:1px solid var(--hairline);border-radius:7px;padding:5px 0;cursor:pointer';
    b.addEventListener('click', () => { slider.value = String(val); apply(val); }); return b; };
  row.appendChild(mk('Mute', 0)); row.appendChild(mk('100%', 100)); row.appendChild(mk('Max', 200));
  pop.appendChild(head); pop.appendChild(slider); pop.appendChild(row);
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  let left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 8);
  let top = r.top - pop.offsetHeight - 8; if (top < 8) top = r.bottom + 8;
  pop.style.left = Math.max(8, left) + 'px'; pop.style.top = top + 'px';
  volPop = pop;
  setTimeout(() => { document.addEventListener('mousedown', onVolOutside, true); document.addEventListener('keydown', onVolKey, true); }, 0);
}

// ---- voice room: relayed audio with participants. TWO instances share ONE UI (#hv-*): `hostVoice` for your own
// share, `liveVoice` for a session you've JOINED. The UI follows the active tab; each room caches its last state so
// a tab switch repaints the right one. ----
function paintVoiceUi(st, room) {
  const btn = $('hv-btn'), mute = $('hv-mute'), box = $('hv-members'); if (!btn) return;
  if (st && st.error === 'mic-denied') { btn.textContent = '🎙 Mic blocked'; btn.classList.remove('on'); return; }
  const joined = !!(st && st.joined);
  { const vr = $('voicerow'); if (vr) vr.style.display = joined ? '' : 'none'; }   // voice-members row shows only while in a call (the button now lives in the head)
  btn.innerHTML = '<span class="hv-ic">🎙</span> ' + (joined ? 'Leave voice' : 'Join voice');   // static strings only — the icon span keeps the mic ~10% larger than the label (.hv-ic)
  btn.classList.toggle('on', joined);
  if (mute) { mute.style.display = joined ? '' : 'none'; mute.textContent = (st && st.muted) ? 'Unmute' : 'Mute'; mute.classList.toggle('muted', !!(st && st.muted)); }
  if (box) {
    box.innerHTML = '';
    // ONE pill per person in the chat panel: a voice member whose name already has a roster pill above gets
    // their in-call state PROJECTED onto that pill (mic mark + speaking pulse, via applyVoiceMarks) instead of
    // a second, identical-looking name row — the "I see two CrazyDevs" bug was the roster strip + this voice
    // strip both rendering the same person. Only voice members with NO roster pill (edge: a caller the roster
    // doesn't know) still get their own .hvm pill here.
    _voiceMembers = joined ? (((st && st.members) || []).map((m) => ({ id: m.id, name: m.name, self: !!m.self, speaking: !!m.speaking, conn: m.conn }))) : [];
    _voiceRoom = room;
    const pilled = new Set([...document.querySelectorAll('#chat-roster .rmember, #roster-pop .rmember')].map((n) => String(n.dataset.name || '').toLowerCase()).filter(Boolean));
    _voiceMembers.forEach((m) => {
      if (pilled.has(String(m.name || '').toLowerCase())) return;      // already a roster pill → decorated there, no duplicate row
      const el = document.createElement('div'); el.className = 'hvm' + (m.speaking ? ' speaking' : '') + (m.self ? ' self' : '') + (m.conn ? ' c-' + m.conn : '');
      const d = document.createElement('span'); d.className = 'd';
      let label = m.name;
      if (!m.self && m.conn && m.conn !== 'connected') label += ' · ' + m.conn;   // surface connecting/failed for diagnosis
      const nm = document.createElement('span'); nm.textContent = label;
      if (m.self) { el.title = 'you'; }
      else {                                                            // right-click → set how loud you hear this person
        el.title = 'Right-click to adjust ' + m.name + "'s volume";
        el.style.cursor = 'context-menu';
        el.addEventListener('contextmenu', (ev) => { ev.preventDefault(); openVolumePopover(el, m.id, m.name, room); });
      }
      el.appendChild(d); el.appendChild(nm); box.appendChild(el);
    });
    { const vr = $('voicerow'); if (vr) vr.style.display = (joined && box.childElementCount) ? '' : 'none'; }   // everyone deduped into the roster → no empty second strip
    applyVoiceMarks();
  }
}
// Project voice-call state onto the roster pills: mic mark while in the call, pulse while speaking, and the
// same right-click volume control the .hvm pill offered. Re-applied by renderRoster (fresh pills) and by every
// paintVoiceUi (fresh state) — whichever painted last, the marks land.
let _voiceMembers = [], _voiceRoom = null;
function applyVoiceMarks() {
  const pills = document.querySelectorAll('#chat-roster .rmember, #roster-pop .rmember');
  pills.forEach((pill) => {
    const m = _voiceMembers.find((v) => nameEqCI(v.name, pill.dataset.name));
    pill.classList.toggle('invoice', !!m);
    pill.classList.toggle('speaking', !!(m && m.speaking));
    if (m && !m.self && !pill._voiceVolBound) {                       // volume affordance parity with the old .hvm pill
      pill._voiceVolBound = true;
      pill.style.cursor = 'context-menu';
      pill.addEventListener('contextmenu', (ev) => {
        const cur = _voiceMembers.find((v) => nameEqCI(v.name, pill.dataset.name));
        if (!cur || cur.self) return;                                  // left the call (or is me) → stock context menu
        ev.preventDefault(); openVolumePopover(pill, cur.id, cur.name, _voiceRoom);
      });
    }
  });
}
function voiceRoom() { const t = AT(); return (t && t.kind === 'live') ? liveVoice : hostVoice; }   // which room the UI is bound to now
let hostVoiceState = null, liveVoiceState = null;
function renderHostVoiceUi(st) { hostVoiceState = st; if (voiceRoom() === hostVoice) paintVoiceUi(st, hostVoice); }
function renderLiveVoiceUi(st) { liveVoiceState = st; if (voiceRoom() === liveVoice) paintVoiceUi(st, liveVoice); }
function repaintVoiceForActive() {
  const t = AT();
  if (t && t.kind === 'live') {
    if (t.tabId === liveVoiceTabId) paintVoiceUi(liveVoiceState, liveVoice);   // this is the session you're voicing
    else paintVoiceUi({ joined: false, members: [] }, liveVoice);              // a different live tab → offer "Join voice"
  } else paintVoiceUi(hostVoiceState, hostVoice);
}
// Guarded so a missing/failed voice module can NEVER break the cockpit (which would also kill screen-share).
// Both rooms are always valid objects (no-op stub fallback).
const VOICE_STUB = { isJoined: () => false, join: () => Promise.resolve(), leave: () => {}, toggleMute: () => {}, setMembers: () => {}, pushAudio: () => {} };
let hostVoice = VOICE_STUB, liveVoice = VOICE_STUB;
let liveVoiceTabId = null;                                  // the live tab whose voice you've joined — audio binds to IT, independent of the active tab
try {
  if (typeof makeVoiceRoom === 'function') {
    hostVoice = makeVoiceRoom({
      myId: () => 'host',
      sendAudio: (b64, sr) => { try { claudible.voiceAudio(b64, sr); } catch {} },
      setJoined: (j) => { try { claudible.voiceJoin(j); } catch {} },
      onUi: renderHostVoiceUi,
    });
    liveVoice = makeVoiceRoom({                              // a SECOND room for the session you joined (same relayed-audio protocol)
      myId: () => { const r = tabs.get(liveVoiceTabId); return r ? (r.livePid || null) : null; },
      sendAudio: (b64, sr) => { if (liveVoiceTabId) { try { claudible.liveAudioSend(liveVoiceTabId, b64, sr); } catch {} } },
      setJoined: (j) => { if (liveVoiceTabId) { try { claudible.liveVoice(liveVoiceTabId, j); } catch {} } },
      onUi: renderLiveVoiceUi,
    });
    try { claudible.onShareAudio((p) => hostVoice.pushAudio(p.from, p.data, p.sr)); } catch {}
    try { claudible.onVoiceMembers((m) => hostVoice.setMembers(m)); } catch {}
    try { claudible.onLiveAudio((p) => { if (p && p.tabId === liveVoiceTabId) liveVoice.pushAudio(p.from, p.data, p.sr); }); } catch {}
    try { claudible.onLiveVoiceMembers((p) => { if (p && p.tabId === liveVoiceTabId) liveVoice.setMembers(p.members || []); }); } catch {}
    if ($('hv-btn')) $('hv-btn').addEventListener('click', () => {
      const t = AT();
      if (t && t.kind === 'live') {                                  // joined-session voice (bound to ONE tab at a time)
        if (liveVoice.isJoined() && liveVoiceTabId === t.tabId) { liveVoice.leave(); liveVoiceTabId = null; }
        else { if (liveVoice.isJoined()) { try { liveVoice.leave(); } catch {} } liveVoiceTabId = t.tabId; liveVoice.join().catch(() => {}); }   // switch the single live-voice to this tab
      } else { if (hostVoice.isJoined()) hostVoice.leave(); else hostVoice.join().catch(() => {}); }
    });
    if ($('hv-mute')) $('hv-mute').addEventListener('click', () => voiceRoom().toggleMute());
  } else { ['voicerow','hv-btn','hv-mute'].forEach((id) => { const e2 = $(id); if (e2) e2.style.display = 'none'; }); }
} catch (e) { try { ['voicerow','hv-btn','hv-mute'].forEach((id) => { const e2 = $(id); if (e2) e2.style.display = 'none'; }); } catch (x) {} }

function showLink(url) {
  shareLink.value = url; shareLink.style.display = 'block'; shareLink.style.opacity = '1';
  shareLink.title = 'Click to copy';
}
let hostDisplayName = 'Host';
shareBtn.addEventListener('click', async () => {
  if (webShare) {                                   // stop the WEB link only — collab keeps the tunnel if it still needs it
    shareBtn.disabled = true;
    webShare = false; webShareUI(false);
    await ensureTunnel();
    shareOut.textContent = 'web link stopped'; shareOut.className = 'out';
    shareBtn.disabled = false;
    return;
  }
  // ask the host for a display name before sharing (prefilled from your one Claudible username)
  $('host-name-in').value = collabName() || loadPrefs().hostName || '';
  $('namemodal').classList.add('show');
  setTimeout(() => $('host-name-in').focus(), 30);
});
async function doStartSharing() {
  const typed = ($('host-name-in').value || '').trim().slice(0, 40);
  hostDisplayName = typed || collabName() || 'Host';
  if (typed) savePrefs({ collabName: typed });   // one identity: editing the share name updates your Claudible username
  $('namemodal').classList.remove('show');
  shareBtn.disabled = true;
  shareOut.textContent = 'starting tunnel…'; shareOut.className = 'out';
  setDot('d-share', 'work');
  webShare = true;
  await ensureTunnel();                             // starts the tunnel (or reuses the one collab already has up)
  shareBtn.disabled = false;
  if (!tunnelUp) {
    webShare = false; webShareUI(false); await ensureTunnel();
    setDot('d-share', 'bad'); shareOut.textContent = 'share failed — could not start the tunnel'; shareOut.className = 'out';
    return;
  }
  webShareUI(true);
  showLink(lastShareUrl);
  const mode = lastShareReadOnly ? ' · view-only' : '';   // the ACTUAL server mode (collab co-drive may override the checkbox)
  shareOut.textContent = (lastShareRemote === false)
    ? 'local link only (tunnel off)' + mode + ' — ' + (lastShareNote || '')
    : 'invite link — share with your team' + mode;
  shareOut.className = 'out live';
}
$('name-start').addEventListener('click', doStartSharing);
$('host-name-in').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doStartSharing(); } else if (e.key === 'Escape') { e.preventDefault(); $('namemodal').classList.remove('show'); } });   // Esc cancels, matching ws-modal/invite-modal
$('name-cancel').addEventListener('click', () => $('namemodal').classList.remove('show'));
// click the link to copy it (clipboard handled in main, so it works regardless of web perms)
shareLink.addEventListener('click', async () => {
  if (!shareLink.value) return;
  shareLink.select();
  let r = null; try { r = await claudible.clipWrite(shareLink.value); } catch {}
  const prev = shareOut.textContent;
  shareOut.textContent = (r && r.ok) ? 'link copied ✓' : 'press Ctrl+C to copy';   // the text is selected either way — never claim a copy the OS refused
  setTimeout(() => { if (webShare) shareOut.textContent = prev; }, 1200);
});
// (the "New link" button was removed — the same link works for everyone you invite; nothing to rotate)
// reflect connected viewers; a join (collab or web) reveals the chat panel, web-share also updates its status line
claudible.onShareGuests((n) => {
  const joined = n > guestCount;                   // someone new connected to the live session
  guestCount = n; refreshChatPanel();
  if (joined && chimeOn) playJoin();               // little sound on a join (respects the chat-chime mute)
  if (webShare) {
    shareOut.textContent = n > 0 ? (n + ' viewer' + (n === 1 ? '' : 's') + ' connected') : 'waiting for people to join';
    shareOut.className = 'out live';
  }
  if (n > 0) pushTracker();   // make sure a just-joined guest sees the current tracker
});

// ---------- approve-guest prompt ----------
// No one attaches to the terminal until you approve here. Requests are queued (one prompt at a time).
const approveEl = $('approve'), approveMsg = $('approve-msg'), approveTitle = $('approve-title');
let approveQueue = [], approveCur = null;
function showNextApproval() {
  if (approveCur || !approveQueue.length) return;
  approveCur = approveQueue.shift();
  // Put the viewer's chosen name in the HEADER so you can see exactly who you're approving at a glance
  // (the body text just carries the security reminder). Falls back to "Someone" if no name was sent.
  approveTitle.textContent = (approveCur.name ? '“' + approveCur.name + '”' : 'Someone') + ' wants to join';
  approveMsg.textContent = 'They opened your link and are asking to join your terminal. Approve only if you recognise ' +
    (approveCur.name ? approveCur.name : 'them') + ' — they’ll see your session (and can type, unless view-only).';
  approveEl.classList.add('show');
}
function decideApproval(ok) {
  if (!approveCur) return;
  claudible.shareApprove(approveCur.id, ok);
  approveCur = null; approveEl.classList.remove('show');
  setTimeout(showNextApproval, 60);
}
claudible.onShareApproval((info) => { approveQueue.push(info); if (chimeOn) playJoinRequest(); showNextApproval(); });   // audible "ding-dong" so the host notices a join request
claudible.onShareApprovalCancel((id) => {     // guest gave up before you decided
  approveQueue = approveQueue.filter((x) => x.id !== id);
  if (approveCur && approveCur.id === id) { approveCur = null; approveEl.classList.remove('show'); setTimeout(showNextApproval, 60); }
});
$('approve-yes').addEventListener('click', () => decideApproval(true));
$('approve-no').addEventListener('click', () => decideApproval(false));

// ---------- settings drawer ----------
// The voice + command + share controls now live in a slide-in drawer to free the main area.
const drawer = $('drawer'), drawerScrim = $('drawer-scrim');
function openDrawer(open) {
  drawer.classList.toggle('open', open);
  drawerScrim.classList.toggle('open', open);
  drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
  if (open) { loadSkills(); loadPlugins(); }       // refresh extension inventory each time the drawer opens
  if (!open) setTimeout(() => term.focus(), 0);
}
// ---------- Skills + Plugins managers (drawer sections; opened from the top-bar icons too) ----------
async function loadSkills() {
  const el = $('skills-list'); if (!el) return;
  let list = []; try { list = await claudible.skillsList(); } catch {}
  if (!Array.isArray(list) || !list.length) {
    el.innerHTML = '<div class="ext-empty">No user/project skills found. Add one at <b>~/.claude/skills/&lt;name&gt;/SKILL.md</b> or this project’s <b>.claude/skills/</b>. (Bundled &amp; plugin skills aren’t listed here.)</div>';
    return;
  }
  el.innerHTML = '';
  list.forEach((s) => {
    const row = document.createElement('div'); row.className = 'ext-row';
    const main = document.createElement('div'); main.className = 'ext-main';
    const nm = document.createElement('div'); nm.className = 'ext-name'; nm.textContent = '/' + s.name; main.appendChild(nm);
    if (s.description) { const d = document.createElement('div'); d.className = 'ext-desc'; d.textContent = s.description; main.appendChild(d); }
    const meta = document.createElement('div'); meta.className = 'ext-meta'; meta.textContent = s.scope || ''; main.appendChild(meta);
    row.appendChild(main);
    const on = s.state !== 'off';
    const tog = document.createElement('button'); tog.className = 'ext-tog' + (on ? ' on' : ''); tog.textContent = on ? 'on' : 'off';
    // A refusal used to be a silent no-op (the toggle just didn't move). It has a real cause now — an adopted
    // project whose own .claude/settings.local.json doesn't parse, which we refuse to overwrite — so say it.
    tog.addEventListener('click', async () => {
      let r = null; try { r = await claudible.skillsSet(s.name, on ? 'off' : 'on'); } catch {}
      if (r && r.ok) loadSkills();
      else toast('Could not switch that skill — ' + humanError((r && r.error) || 'exec'));   // R35: a null result was SILENT and a raw code rendered verbatim; real sentences (the adopted-settings refusal) pass through humanError unchanged
    });
    row.appendChild(tog); el.appendChild(row);
  });
}
async function loadPlugins() {
  const el = $('plugins-list'); if (!el) return;
  let list = []; try { list = await claudible.pluginsList(); } catch {}
  if (!Array.isArray(list) || !list.length) {
    el.innerHTML = '<div class="ext-empty">No plugins installed. Add them with <b>/plugin</b> in the terminal.</div>';
    return;
  }
  el.innerHTML = '';
  list.forEach((p) => {
    const row = document.createElement('div'); row.className = 'ext-row';
    const main = document.createElement('div'); main.className = 'ext-main';
    const nm = document.createElement('div'); nm.className = 'ext-name'; nm.textContent = p.name; main.appendChild(nm);
    const meta = document.createElement('div'); meta.className = 'ext-meta';
    meta.textContent = [p.marketplace, p.version, p.scope].filter(Boolean).join(' · '); main.appendChild(meta);
    row.appendChild(main);
    const tog = document.createElement('button'); tog.className = 'ext-tog' + (p.enabled ? ' on' : ''); tog.textContent = p.enabled ? 'on' : 'off';
    tog.addEventListener('click', async () => {
      tog.textContent = '…';
      let r = null; try { r = await claudible.pluginsToggle(p.key, !p.enabled); } catch {}
      if (r && r.ok) loadPlugins(); else { tog.textContent = p.enabled ? 'on' : 'off'; toast('Plugin toggle failed — try /plugin in the terminal'); }
    });
    row.appendChild(tog); el.appendChild(row);
  });
}
if ($('skills-refresh')) $('skills-refresh').addEventListener('click', loadSkills);
if ($('plugins-refresh')) $('plugins-refresh').addEventListener('click', loadPlugins);

// ---- official marketplace browser (the "+" beside Skills/Plugins) — search + install ----
function termRun(cmd) { sendInput('\x1b'); setTimeout(() => sendInput(cmd + '\r'), 120); setTimeout(() => term.focus(), 170); }
let mktCache = null;
async function openMkt() {
  $('mkt-modal').classList.add('show');
  $('mkt-search').value = '';
  $('mkt-list').innerHTML = '<div class="ext-empty">loading…</div>';
  setTimeout(() => $('mkt-search').focus(), 60);
  if (!mktCache) { try { mktCache = await claudible.pluginsAvailable(); } catch { mktCache = []; } }
  renderMkt('');
}
function closeMkt() { $('mkt-modal').classList.remove('show'); }
function renderMkt(q) {
  const el = $('mkt-list'); if (!el) return;
  q = (q || '').toLowerCase().trim();
  const all = mktCache || [];
  const items = (q ? all.filter((p) => p.name.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q)) : all).slice(0, 80);
  if (!items.length) { el.innerHTML = '<div class="ext-empty">' + (all.length ? 'no matches' : 'no marketplace catalog found — add one with /plugin in the terminal') + '</div>'; return; }
  el.innerHTML = '';
  items.forEach((p) => {
    const row = document.createElement('div'); row.className = 'ext-row';
    const main = document.createElement('div'); main.className = 'ext-main';
    const nm = document.createElement('div'); nm.className = 'ext-name'; nm.textContent = p.name; main.appendChild(nm);
    if (p.description) { const d = document.createElement('div'); d.className = 'ext-desc'; d.textContent = p.description; main.appendChild(d); }
    row.appendChild(main);
    const btn = document.createElement('button');
    if (p.installed) { btn.className = 'ext-tog'; btn.textContent = 'installed'; btn.disabled = true; }
    else { btn.className = 'ext-tog on'; btn.textContent = 'install'; btn.addEventListener('click', () => installMkt(p)); }
    row.appendChild(btn); el.appendChild(row);
  });
}
function installMkt(p) {
  closeMkt();
  termRun('/plugin install ' + p.name + '@' + p.marketplace);   // runs in the terminal so the trust prompt is visible
  toast('Installing ' + p.name + ' — approve it in the terminal');
}
if ($('skills-add')) $('skills-add').addEventListener('click', openMkt);
if ($('plugins-add')) $('plugins-add').addEventListener('click', openMkt);
if ($('mkt-search')) {
  $('mkt-search').addEventListener('input', (e) => renderMkt(e.target.value));
  $('mkt-search').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeMkt(); } });
}
if ($('mkt-close')) $('mkt-close').addEventListener('click', closeMkt);
// default-effort selector — load the remembered value, highlight it, persist on click (applies to new sessions)
(async () => {
  const row = $('effort-row'); if (!row) return;
  const paint = (v) => row.querySelectorAll('.eff-pill').forEach((b) => b.classList.toggle('on', (b.dataset.eff || '') === (v || '')));
  let cur = ''; try { cur = await claudible.effortGet(); } catch {}
  paint(cur || '');
  row.querySelectorAll('.eff-pill').forEach((b) => b.addEventListener('click', async () => {
    const v = b.dataset.eff || '';
    let r = null; try { r = await claudible.effortSet(v); } catch {}
    const set = (r && r.ok) ? r.effort : v; paint(set);
    toast(set ? ('Default effort: ' + set + ' — applies to new sessions') : 'Default effort cleared');
  }));
})();
// default permission-mode selector — ships as 'default' (Claude asks); 'accept edits' / 'bypass' are opt-in + remembered
(async () => {
  const row = $('perm-row'); if (!row) return;
  const paint = (v) => row.querySelectorAll('.eff-pill').forEach((b) => b.classList.toggle('on', (b.dataset.perm || 'default') === (v || 'default')));
  const LBL = { default: 'ask first', acceptEdits: 'auto-accept edits', bypass: 'bypass permissions' };
  // Status-bar chip: the mode the app will launch NEW sessions with, always visible — so "settings say
  // bypass but the session asks" is diagnosable at a glance (either this chip disagrees with what you set →
  // the setting didn't persist, or the terminal shows the collaborator-session sandbox notice → the RCE guard).
  const chip = $('sb-perm');
  const paintChip = (v) => { if (chip) chip.textContent = 'perms: ' + (LBL[v || 'default'] || v); };
  let cur = 'default'; try { cur = await claudible.permissionModeGet(); } catch {}
  paint(cur || 'default'); paintChip(cur || 'default');
  row.querySelectorAll('.eff-pill').forEach((b) => b.addEventListener('click', async () => {
    const v = b.dataset.perm || 'default';
    let r = null; try { r = await claudible.permissionModeSet(v); } catch {}
    const set = (r && r.permissionMode) ? r.permissionMode : v; paint(set); paintChip(set);
    // A failed persist must NOT toast like a success — the mode holds for THIS run but resets on relaunch.
    if (r && r.ok === false) toast('Permission: ' + (LBL[set] || set) + ' — set for THIS run, but SAVING FAILED (' + (r.error || 'disk error') + ')');
    else toast('Permission: ' + (LBL[set] || set) + ' — applies to new sessions');
  }));
})();
// model-strategy selector — "plan big, execute small" (Anthropic cookbook): main session on the user's chosen
// model, subagents on Sonnet 5. Ships ON (absent registry value = on); 'off' is the explicit opt-out.
(async () => {
  const row = $('strategy-row'); if (!row) return;
  const paint = (v) => row.querySelectorAll('.eff-pill').forEach((b) => b.classList.toggle('on', (b.dataset.strategy || 'planBigExecSmall') === (v || 'planBigExecSmall')));
  let cur = 'planBigExecSmall'; try { cur = await claudible.modelStrategyGet(); } catch {}
  paint(cur || 'planBigExecSmall');
  row.querySelectorAll('.eff-pill').forEach((b) => b.addEventListener('click', async () => {
    const v = b.dataset.strategy || 'planBigExecSmall';
    let r = null; try { r = await claudible.modelStrategySet(v); } catch {}
    const set = (r && r.modelStrategy) ? r.modelStrategy : v; paint(set);
    const lbl = set === 'off' ? 'off — subagents inherit your main model' : 'plan big, execute small — subagents run on Sonnet 5';
    if (r && r.ok === false) toast('Model strategy: ' + lbl + ' — set for THIS run, but SAVING FAILED (' + (r.error || 'disk error') + ')');
    else toast('Model strategy: ' + lbl + ' — applies to new sessions');
  }));
})();
// theme selector — load the saved theme, highlight it, persist + apply (UI + terminal) instantly on click
(function () {
  const row = $('theme-row'); if (!row) return;
  const saved = loadPrefs().theme; const cur = TERM_THEMES[saved] ? saved : 'dark';
  const paint = (v) => row.querySelectorAll('.eff-pill').forEach((b) => b.classList.toggle('on', (b.dataset.theme || 'dark') === v));
  paint(cur);
  row.querySelectorAll('.eff-pill').forEach((b) => b.addEventListener('click', () => {
    const v = b.dataset.theme || 'dark';
    savePrefs({ theme: v }); applyTheme(v); paint(v);
    toast('Theme · ' + b.textContent);
  }));
})();
// collab display name — what teammates see when you're in a synced session. Persist on edit, update your own
// roster/bar instantly, and (debounced) re-publish the live presence so the "Join live" badge shows the new name.
(function () {
  const inp = $('collab-name-in'), btn = $('collab-name-save');
  const view = $('username-view'), textEl = $('username-text'), editBtn = $('username-edit'), editRow = $('username-edit-row');
  if (!inp) return;
  let saved = (loadPrefs().collabName || loadPrefs().hostName || '').trim();   // hostName = lazy migration from the old split identity
  function showView() {   // a saved name shows as text + a hover ✎; no name yet → stay in the input
    if (textEl) textEl.textContent = saved;
    if (view) view.style.display = saved ? 'flex' : 'none';
    if (editRow) editRow.style.display = saved ? 'none' : 'flex';
  }
  function showEdit() {
    if (view) view.style.display = 'none';
    if (editRow) editRow.style.display = 'flex';
    inp.value = saved; inp.focus(); inp.select();
  }
  const save = () => {
    const v = inp.value.trim().slice(0, 40);
    if (!v) { showView(); return; }                       // empty → just go back to whatever was saved
    const had = !!saved, changed = v !== saved;
    saved = v; savePrefs({ collabName: v });
    renderRoster(lastRoster); renderLiveBar();
    if (advertisedSession) { try { claudible.liveAdvertise(advertisedSession, v); } catch (e) {} }
    showView();
    if (changed) { try { toast(had ? 'Username changed' : 'Username saved'); } catch (e) {} }
  };
  inp.value = saved;
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } else if (e.key === 'Escape') { showView(); } });
  if (btn) btn.addEventListener('click', save);
  if (editBtn) editBtn.addEventListener('click', showEdit);
  showView();
})();
$('settings-btn').addEventListener('click', () => openDrawer(!drawer.classList.contains('open')));
$('drawer-close').addEventListener('click', () => openDrawer(false));
drawerScrim.addEventListener('click', () => openDrawer(false));
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawer.classList.contains('open')) openDrawer(false); });

// ---------- Diff Review: what Claude changed in the active workspace's git repo, revert per hunk/file ----------
let _diffTimer = null;
function openDiff(open) {
  const p = $('diffpanel'), s = $('diff-scrim'); if (!p) return;
  p.classList.toggle('open', open); if (s) s.classList.toggle('open', open);
  p.setAttribute('aria-hidden', open ? 'false' : 'true');
  if (_diffTimer) { clearInterval(_diffTimer); _diffTimer = null; }
  if (open) { _histShown = 10; _histExpanded.clear(); _phExpanded.clear(); _revertUndoWs = null; renderProjectHistory(); _diffTimer = setInterval(() => refreshExpandedProjects({ quiet: true }), 4000); }   // build the project accordion; keep expanded cards live while open
}
// The Repo Review header: which repo you're looking at (name + GitHub identity / local) + a live change summary.
// Resolve a repo project's GitHub identity: {idText, url}. Used by the Project History card header.
function repoIdOf(aw) {
  let idText = '', url = '';
  if (aw && aw.kind === 'repo') {
    if (aw.owner && aw.slug) { idText = aw.owner + '/' + aw.slug; url = 'https://github.com/' + aw.owner + '/' + aw.slug; }
    else {
      const ru = String(aw.repoUrl || '');
      idText = ru.replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/^git@github\.com:/i, '').replace(/\.git$/, '') || 'shared GitHub repo';
      if (/^https?:\/\//i.test(ru)) url = ru.replace(/\.git$/, '');
      else if (/^git@github\.com:/i.test(ru)) url = 'https://github.com/' + ru.replace(/^git@github\.com:/i, '').replace(/\.git$/, '');
    }
  } else if (aw && aw.adopted && aw.repoId) {
    // An adopted folder's own `origin`, parsed to 'owner/name' by main.js at adopt time (github.com only, so
    // this can only ever build an https://github.com/… link — openExternal rejects anything else regardless).
    idText = aw.repoId; url = 'https://github.com/' + aw.repoId;
  }
  return { idText, url };
}
// ---- Session-history activity feed (top of the Repo Review drawer) ----
// Renders the last N prompts (who · when · what) from the main-owned log. Shows only when the
// sessionHistory setting is on and there are entries — otherwise stays hidden (zero footprint).
function renderHistoryEntry(en, revertable) {
  const row = document.createElement('div'); row.className = 'hf-row';
  const meta = document.createElement('div'); meta.className = 'hf-meta';
  // "3 files (+42/-10)" — mirrors lib/history.js summarizeFiles (the sandboxed renderer can't require lib/);
  // stamped by main at Stop-time from the checkpoint numstat, so it appears once the turn settles.
  const filesLine = (en.files && en.files.length)
    ? en.files.length + ' file' + (en.files.length === 1 ? '' : 's')
      + ' (+' + en.files.reduce((n, f) => n + (f.add | 0), 0) + '/-' + en.files.reduce((n, f) => n + (f.del | 0), 0) + ')'
    : '';
  [['Name', histSessionName(en.session)],
   ['Time', histStamp(en.ts || 0)],
   ['User', en.author || 'unknown']].concat(filesLine ? [['Changes', filesLine, en.files.slice(0, 30).map((f) => '+' + (f.add | 0) + '/-' + (f.del | 0) + '  ' + f.path).join('\n')]] : []).forEach(([k, v, tip]) => {
    const pair = document.createElement('span'); pair.className = 'hf-pair';
    const ks = document.createElement('span'); ks.className = 'hf-k'; ks.textContent = k + ': ';
    const vs = document.createElement('span'); vs.className = 'hf-v'; vs.textContent = v; vs.title = tip || v;   // Changes hovers the per-file breakdown
    pair.appendChild(ks); pair.appendChild(vs); meta.appendChild(pair);
  });
  row.appendChild(meta);
  const pr = document.createElement('div'); pr.className = 'hf-content'; pr.textContent = en.prompt || '';   // clamped to 3 lines by CSS; expand reveals the rest
  if (_histExpanded.has(en.id)) pr.classList.add('expanded');
  row.appendChild(pr);
  // expand/collapse chevron — sits to the LEFT of copy; only revealed when the prompt overflows 3 lines
  const more = document.createElement('button'); more.className = 'hf-more'; more.title = 'Expand'; more.setAttribute('aria-label', 'Expand prompt'); more.style.display = 'none';
  if (_histExpanded.has(en.id)) more.classList.add('open');
  more.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  more.onclick = (e) => { e.stopPropagation(); const open = pr.classList.toggle('expanded'); more.classList.toggle('open', open); more.title = open ? 'Collapse' : 'Expand'; more.setAttribute('aria-label', open ? 'Collapse prompt' : 'Expand prompt'); if (open) _histExpanded.add(en.id); else _histExpanded.delete(en.id); };
  row.appendChild(more);
  // Revert: only when this entry captured a code snapshot (checkpointRef) AND it's still within the kept window —
  // checkpoints are pruned to the newest 10, so an older ("show more") entry's snapshot no longer exists and its
  // button would only ever say "aged out". `revertable` is passed for the newest-10 rows. Entries stamped on a
  // DIFFERENT machine (live-synced from a collaborator) are never revertable here: their snapshot refs live in
  // that machine's repo clone, not this one. An empty machine id (pre-stamp era) is treated as local.
  const localSnap = !en.machine || !en.machine.id || !_histMachineId || en.machine.id === _histMachineId;
  if (en.checkpointRef && revertable && localSnap) {
    const rev = document.createElement('button'); rev.className = 'hf-revert'; rev.title = 'Revert code to this prompt'; rev.setAttribute('aria-label', 'Revert code to this prompt');
    rev.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M3.5 13a9 9 0 1 0 2-9.3"/></svg>';   // rewind-arrow
    rev.onclick = (e) => { e.stopPropagation(); revertToCheckpoint(en); };
    row.appendChild(rev);
  }
  const copy = document.createElement('button'); copy.className = 'hf-copy'; copy.title = 'Copy prompt'; copy.setAttribute('aria-label', 'Copy prompt');
  copy.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
  copy.onclick = async (e) => {
    e.stopPropagation();
    let r = null; try { r = await claudible.clipWrite(en.prompt || ''); } catch {}
    if (!r || !r.ok) return toast('Could not copy — ' + humanError('clipboard'));
    copy.classList.add('done'); toast('Prompt copied'); setTimeout(() => copy.classList.remove('done'), 900);
  };
  row.appendChild(copy);
  requestAnimationFrame(() => { if (_histExpanded.has(en.id) || pr.scrollHeight > pr.clientHeight + 2) more.style.display = ''; });   // show expand only when there's more than 3 lines to read
  return row;
}
// Is any local tab bound to this workspace mid-turn (Claude actively editing its files)? A revert then races those
// writes — checkout-index -a -f overwrites the tree and untracked files are deleted while Claude creates/edits them,
// leaving a half-written tree that the next Stop snapshots as "settled". So we warn before reverting a busy ws.
function wsBusy(wsId) { if (!wsId) return false; for (const t of tabs.values()) if (t && t.wsId === wsId && t.busy) return true; return false; }
// Roll the working tree back to the code snapshot captured at this prompt. Destructive (working-tree ONLY — it does
// not rewind commits), so we confirm first; checkpoint.sh captures an 'undo' snapshot before restoring, which we
// then offer so the revert is reversible.
async function revertToCheckpoint(en) {
  if (!en || !en.checkpointRef) return;
  const targetWs = _histFeedWsId || activeWsId;   // the ws this feed was loaded for — NOT activeWsId, which can lag main after a guest-driven or auto-close switch
  const name = histSessionName(en.session);
  const busy = wsBusy(targetWs);
  const choice = await modalChoice({
    title: 'Revert code to this prompt?',
    body: (busy ? '⚠ Claude is still working in this project — reverting now can clobber its in-flight edits and leave a half-written tree. It’s safest to wait for the turn to finish.\n\n' : '')
      + 'Rolls your working files back to how they were going into this prompt' + (name && name !== '—' ? ' (“' + name + '”)' : '') + '. Working tree only — it does NOT undo any commits made since, and files added after this point are removed. You can undo it right after.',
    choices: [
      { key: 'revert', label: busy ? 'Revert anyway' : 'Revert working files', sub: 'Roll the code back to this point. An "Undo last revert" appears after.', danger: true },
      { key: 'cancel', label: 'Cancel' },
    ],
  });
  if (choice !== 'revert') return;
  let r = null;
  try { r = await claudible.checkpointRevert(en.checkpointRef, targetWs); } catch {}
  if (!r || !r.ok) {
    const why = (r && r.error === 'no such checkpoint') ? 'that snapshot has aged out (only the latest 10 are kept)'
      : (r && r.error === 'undo snapshot failed') ? 'couldn’t capture a safety snapshot first, so nothing was changed'
      : (r && r.error === 'disabled') ? 'session history is off' : (r && r.error) ? humanError(r.error) : 'unknown error';   // R37: an unmapped code rendered as a bare internal label
    toast('Could not revert — ' + why);
    return;
  }
  const nrem = (r.removed && r.removed.length) || 0;
  toast('Reverted' + (nrem ? ' · removed ' + nrem + ' newer file' + (nrem === 1 ? '' : 's') : ''));
  _revertUndoWs = targetWs;                 // surface a persistent "Undo last revert" pill atop the feed (reachable even if you look away) — tied to the ws we actually reverted
  if (typeof refreshHistoryFeed === 'function') refreshHistoryFeed();
  if (typeof refreshDiff === 'function') refreshDiff();
}
async function undoLastRevert() {
  let ur = null; try { ur = await claudible.checkpointUndo(_revertUndoWs || _histFeedWsId || activeWsId); } catch {}
  toast((ur && ur.ok) ? 'Undid the revert — working tree restored' : 'Could not undo the revert');
  _revertUndoWs = null;
  if (typeof refreshHistoryFeed === 'function') refreshHistoryFeed();
  if (typeof refreshDiff === 'function') refreshDiff();
}
// Resolve a session id to its human title (local rename → shared-title cache → short id fallback).
function histSessionName(id) {
  if (!id) return '—';
  try {
    const p = loadPrefs();
    if (p.sessionTitles && p.sessionTitles[id]) return p.sessionTitles[id];
    const rc = p.remoteTitlesCache || {};
    for (const k in rc) { if (rc[k] && rc[k][id]) { const v = titleVal(rc[k][id]); if (v) return v; } }
  } catch {}
  return String(id).slice(0, 8);
}
function histStamp(ts) {   // compact: M/D/YY H:MM (no seconds), e.g. 7/1/26 22:05
  try { const d = new Date(ts), p2 = (n) => String(n).padStart(2, '0');
    return (d.getMonth() + 1) + '/' + d.getDate() + '/' + String(d.getFullYear()).slice(2) + ' ' + d.getHours() + ':' + p2(d.getMinutes());
  } catch { return String(ts); }
}
let _histShown = 10;   // pagination: how many of the newest entries the feed currently reveals (grows by 10 per "show more")
let _revertUndoWs = null;   // after a revert, the ws whose last revert is still undoable → shows the "Undo last revert" pill (cleared on undo / drawer reopen)
let _histFeedWsId = null;   // the workspace the feed currently reflects (main-reported at load) → revert/undo act on THIS, not a possibly-stale activeWsId (guest-driven or auto-close switch can desync them)
let _histMachineId = '';    // THIS machine's stable id (main-reported at load) — entries stamped on another machine hide their Revert button (their snapshot refs don't travel)
const _histExpanded = new Set();   // entry ids the user expanded past 3 lines — persists across live re-renders, cleared on each drawer open
// Load ONE project's session-history feed into `wrap`. targetWsId picks the project (main defaults to active
// when null). `liveEntries` (a joined tab's host-pushed log) short-circuits the IPC and renders view-only.
async function loadHistoryInto(targetWsId, wrap, liveEntries) {
  if (!wrap) return;
  if (liveEntries) {   // joined live tab → the HOST's feed; nothing revertable here (snapshots live on the host)
    const lall = (liveEntries || []).slice().reverse();
    if (!lall.length) { wrap.innerHTML = '<div class="ph-empty">No session history yet.</div>'; return; }
    wrap.innerHTML = '';
    const lshown = Math.min(_histShown, lall.length);
    lall.slice(0, lshown).forEach((en) => wrap.appendChild(renderHistoryEntry(en, false)));
    if (lall.length > lshown) { const lmore = document.createElement('button'); lmore.className = 'hf-expand'; lmore.textContent = 'Show ' + Math.min(10, lall.length - lshown) + ' more'; lmore.onclick = () => { _histShown += 10; loadHistoryInto(targetWsId, wrap, liveEntries); }; wrap.appendChild(lmore); }
    return;
  }
  let r = null; try { r = await claudible.historyLoad(targetWsId); } catch {}
  if (r && r.ok) { _histFeedWsId = r.wsId || null; _histMachineId = r.machineId || ''; }
  if (!r || !r.ok || !r.enabled || !r.entries || !r.entries.length) { wrap.innerHTML = '<div class="ph-empty">No session history in this project yet.</div>'; return; }
  wrap.innerHTML = '';
  if (_revertUndoWs && _revertUndoWs === (r.wsId || targetWsId)) {   // a revert just happened on THIS project → offer a reachable undo
    const u = document.createElement('button'); u.className = 'hf-undo';
    u.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/></svg><span>Undo last revert</span>';
    u.title = 'Restore the working tree to how it was just before the revert';
    u.onclick = () => { _revertUndoWs = r.wsId || targetWsId; undoLastRevert(); };
    wrap.appendChild(u);
  }
  const all = r.entries.slice().reverse();                             // newest first
  const shown = Math.min(_histShown, all.length);
  all.slice(0, shown).forEach((en, i) => wrap.appendChild(renderHistoryEntry(en, i < 10)));   // only the newest 10 keep a live checkpoint → only they get a Revert button
  if (all.length > shown) {
    const more = document.createElement('button'); more.className = 'hf-expand';
    more.textContent = 'Show ' + Math.min(10, all.length - shown) + ' more';
    more.onclick = () => { _histShown += 10; loadHistoryInto(targetWsId, wrap); };
    wrap.appendChild(more);
  }
}
// ---- Project History drawer: ONE list of your projects; expand a project → its session history + diff review
// under it. Replaces the single-active-workspace "Repo Review" with a browse-any-project view. ----
const _phExpanded = new Set();   // project ids currently expanded in the drawer (default: the active one)
function _phProjects() {
  // EVERY project, in the order the chips are in: new, old, local, adopted, shared repo. This used to be
  // `kind === 'repo' || id === activeWsId`, which hid every non-active local project — including an adopted
  // folder, the only kind whose commit history the user actually recognizes. A project with no git in it renders
  // an honest "isn't a git repo" line, and an invited repo that isn't cloned yet says so; neither is a reason to
  // omit the card. Cards load lazily (only the expanded one reads git), so listing them all costs nothing.
  const list = (typeof workspaces !== 'undefined' ? workspaces : []).filter(Boolean);
  list.sort((a, b) => (a.id === activeWsId ? -1 : b.id === activeWsId ? 1 : 0));   // active project first, rest keep chip order
  return list;
}
function renderProjectHistory() {
  const host = $('diff-body'); if (!host) return;
  host.innerHTML = '';
  // A joined live tab is not a local project — show the host's pushed feed as its own top card.
  const at = AT();
  if (at && at.kind === 'live') {
    const card = _phCard('live-' + at.tabId, (at.hostName ? at.hostName + '’s session' : 'Live session') + ' · from the host', 'live', true);
    host.appendChild(card.el);
    if (card.expanded) loadHistoryInto(null, card.feed, at.liveHistory || []);
  }
  const projects = _phProjects();
  if (!projects.length && !(at && at.kind === 'live')) { host.innerHTML = '<div class="diff-empty">No projects yet — create one from the sidebar to see its history here.</div>'; return; }
  // Default open: the active project — or, if nothing's expanded and the active id doesn't match a listed
  // project (e.g. drawer opened before activeWsId settled), the first project, so a card is always open.
  if (!projects.some((w) => _phExpanded.has(w.id))) { _phExpanded.add((projects.find((w) => w.id === activeWsId) || projects[0]).id); }
  projects.forEach((w) => {
    const card = _phCard(w.id, w.label || w.slug || 'project', w.kind, false, w);
    host.appendChild(card.el);
    if (card.expanded) _phFillBody(w, card);
  });
}
// Build one collapsible project card (header + empty body). Returns {el, feed, diff, expanded}.
function _phCard(id, label, kind, isLive, w) {
  const el = document.createElement('div'); el.className = 'ph-project'; el.dataset.ws = id;
  const expanded = _phExpanded.has(id);
  const head = document.createElement('button'); head.className = 'ph-head' + (expanded ? ' open' : '');
  const car = document.createElement('span'); car.className = 'ph-caret'; car.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
  const ico = document.createElement('span'); ico.className = 'ph-ico'; ico.innerHTML = isLive ? '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/></svg>' : (kind === 'repo' ? WS_REPO_SVG : WS_FOLDER_SVG);
  const nm = document.createElement('span'); nm.className = 'ph-nm'; nm.textContent = label; nm.title = label;
  head.appendChild(car); head.appendChild(ico); head.appendChild(nm);
  // Identity + totals belong on the card's MAIN BAR, not buried under a scrolling feed: owner/slug,
  // a click-to-open GitHub link, and the commit count (filled async once the git read returns).
  const rid = repoIdOf(w);
  if (rid.idText) { const idEl = document.createElement('span'); idEl.className = 'ph-id'; idEl.textContent = rid.idText; idEl.title = rid.idText; head.appendChild(idEl); }
  if (rid.url) {
    const visit = document.createElement('span'); visit.className = 'ph-visit'; visit.title = 'Open ' + rid.idText + ' on GitHub ↗'; visit.setAttribute('role', 'button');
    visit.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
    visit.addEventListener('click', (e) => { e.stopPropagation(); try { claudible.openExternal(rid.url); } catch (_) {} });   // span inside the head <button> (nested buttons are invalid HTML); stopPropagation keeps it from toggling
    head.appendChild(visit);
  }
  const stats = document.createElement('span'); stats.className = 'ph-stats'; stats.textContent = ''; head.appendChild(stats);
  el.appendChild(head);
  const body = document.createElement('div'); body.className = 'ph-body'; if (!expanded) body.style.display = 'none';
  const sec = (txt, svg) => { const s = document.createElement('div'); s.className = 'ph-sec'; s.innerHTML = svg + '<span>' + txt + '</span>'; return s; };
  const feed = document.createElement('div'); feed.className = 'history-feed';
  const diff = document.createElement('div'); diff.className = 'ph-diff';
  body.appendChild(sec('session history', '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l3 2"/></svg>'));
  body.appendChild(feed);
  if (!isLive) {   // a joined live mirror has no local git to review
    body.appendChild(sec('commit history', '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 3v6"/><path d="M12 15v6"/></svg>'));
    body.appendChild(diff);
  }
  el.appendChild(body);
  head.onclick = () => {
    const nowOpen = !_phExpanded.has(id);
    if (nowOpen) _phExpanded.add(id); else _phExpanded.delete(id);
    head.classList.toggle('open', nowOpen); body.style.display = nowOpen ? '' : 'none';
    if (nowOpen) { _histShown = 10; if (isLive) loadHistoryInto(null, feed, (AT() && AT().liveHistory) || []); else { const ww = workspaces.find((x) => x.id === id); if (ww) _phFillBody(ww, { feed, diff, stats }); } }
  };
  return { el, head, feed, diff, stats, expanded };
}
// Load a project's history feed + diff review into its card body; the diff read also fills the
// header's commit-count stat.
function _phFillBody(w, card) {
  loadHistoryInto(w.id, card.feed);
  // An invited repo you haven't accepted yet has NO folder on this machine. Running git in a directory that
  // doesn't exist reports "not a git repo", which reads as "your repo is empty" — say the true thing instead.
  if (w.needsClone) {
    if (card.diff) card.diff.innerHTML = '<div class="diff-empty">Not downloaded yet — click this project in the sidebar to choose where to save it.</div>';
    if (card.stats) card.stats.textContent = '';
    return;
  }
  loadDiffInto(w.id, card.diff, { onMeta: (meta) => { if (card.stats) card.stats.textContent = (typeof meta.total === 'number' && meta.total > 0) ? meta.total.toLocaleString() + ' commit' + (meta.total > 1 ? 's' : '') : 'no commits yet'; } });
}
// Live refresh (4s timer + per-prompt hook line): reload only the EXPANDED cards' bodies in place, so the
// accordion structure + scroll survive. The old refreshHistoryFeed/refreshDiff names delegate here so every
// existing caller keeps working.
function refreshExpandedProjects(opts) {
  const host = $('diff-body'); if (!host || !$('diffpanel') || !$('diffpanel').classList.contains('open')) return;
  const at = AT();
  host.querySelectorAll('.ph-project').forEach((el) => {
    const feed = el.querySelector('.history-feed'), diff = el.querySelector('.ph-diff'), stats = el.querySelector('.ph-stats');
    if (el.querySelector('.ph-body').style.display === 'none') return;   // collapsed → skip
    if (String(el.dataset.ws).startsWith('live-')) { if (at && at.kind === 'live') loadHistoryInto(null, feed, at.liveHistory || []); return; }
    const w = workspaces.find((x) => x.id === el.dataset.ws); if (!w) return;
    loadHistoryInto(w.id, feed);
    if (w.needsClone) return;                          // no local folder → nothing to read (and no WSL spawn every 4s)
    loadDiffInto(w.id, diff, Object.assign({}, opts || {}, { onMeta: (meta) => { if (stats) stats.textContent = (typeof meta.total === 'number' && meta.total > 0) ? meta.total.toLocaleString() + ' commit' + (meta.total > 1 ? 's' : '') : 'no commits yet'; } }));
  });
}
function refreshHistoryFeed() { refreshExpandedProjects(); }        // compat: live feed update after a prompt/revert
function refreshDiff(opts) { refreshExpandedProjects(opts); }      // compat: 4s quiet refresh + workspace-switch repaint
// Load ONE project's diff review (uncommitted + untracked + recent commits) into `body`. Per-container
// busy/sig flags (body._diffBusy / body._diffSig) so several expanded projects never clobber each other.
async function loadDiffInto(targetWsId, body, opts) {
  if (!body) return;
  const quiet = opts && opts.quiet;                                    // auto-refresh: don't flash "reading…" or rebuild if unchanged
  if (quiet && body._diffBusy) return;                                 // a refresh is already in flight — don't stack WSL spawns
  if (!quiet && !body.firstChild) body.innerHTML = '<div class="diff-empty">reading changes…</div>';
  body._diffBusy = true;
  let r = null; try { r = await claudible.diffList(targetWsId); } catch {}
  body._diffBusy = false;
  if (!r || !r.ok) { if (!quiet) body.innerHTML = '<div class="diff-empty">Couldn’t read changes.</div>'; return; }
  if (!r.repo) { body._diffSig = 'norepo'; body.innerHTML = '<div class="diff-empty">This project isn’t a git repo — nothing to review here.</div>'; if (opts && opts.onMeta) try { opts.onMeta({ total: null }); } catch (e) {} return; }
  const files = r.files || [], untracked = r.untracked || [], committed = r.committed || [], commits = r.commits || [];
  const total = (r && typeof r.total === 'number') ? r.total : null;   // lifetime commit tally (card header)
  const week = (r && typeof r.week === 'number') ? r.week : commits.length;   // commits in the last 7 days (list may be capped at 50)
  // What `commits` actually holds: this week's, or — when the week was empty but the repo has history — its
  // latest. An older diff.sh emits neither key, so infer conservatively (it only ever sent a week's worth).
  const win = r.window || (commits.length ? 'week' : 'none');
  const upstream = r.upstream || '';                                   // '' → this branch isn't tracking anything on GitHub
  const ahead = typeof r.ahead === 'number' ? r.ahead : 0;             // local commits GitHub hasn't seen
  const behind = typeof r.behind === 'number' ? r.behind : 0;          // commits on GitHub that aren't here yet
  if (opts && opts.onMeta) try { opts.onMeta({ total }); } catch (e) {}   // identity/totals live on the card's MAIN BAR now — hand the count up
  // change-signature, so a silent auto-refresh leaves the panel (and your scroll) untouched when nothing changed.
  // The GitHub state belongs in it: a background fetch that reveals 3 new upstream commits changes nothing else.
  const sig = JSON.stringify({ ws: targetWsId, t: total, w: week, win, up: upstream, a: ahead, b: behind, f: files.map((f) => [f.path, f.additions, f.deletions]), u: untracked, c: commits.map((c) => [c.hash, c.pushed]), cf: committed.map((f) => [f.path, f.additions, f.deletions]) });
  if (quiet && sig === body._diffSig) return;
  body._diffSig = sig;
  if (!files.length && !untracked.length && !committed.length && !commits.length) {
    // NB: `commits` is checked too. A week of commits can net to an EMPTY diff (commit then revert), and diff.sh
    // deliberately drops a >110KB net diff while keeping the log — both used to render as "no recent commits".
    body.innerHTML = total ? '<div class="diff-empty">No changes this week — nothing in the working tree, and no commits in the last 7 days. ✨</div>'
      : '<div class="diff-empty">No changes yet — nothing in the working tree or recent commits. ✨</div>';
    return;
  }
  body.innerHTML = '';
  // one-line change summary (the identity half of the old header moved to the card bar)
  {
    const adds = files.reduce((s, f) => s + (f.additions || 0), 0), dels = files.reduce((s, f) => s + (f.deletions || 0), 0);
    const parts = [];
    if (files.length) parts.push(files.length + ' file' + (files.length > 1 ? 's' : '') + ' changed');
    if (adds || dels) parts.push('+' + adds + ' −' + dels);
    if (untracked.length) parts.push(untracked.length + ' new');
    if (week) parts.push(week + ' commit' + (week > 1 ? 's' : '') + ' this week');
    if (parts.length) { const sum = document.createElement('div'); sum.className = 'ph-sum'; sum.textContent = parts.join('  ·  '); body.appendChild(sum); }
  }
  // Where this branch stands against GitHub. `origin/<branch>` after a fetch IS what github.com shows, so
  // "3 to push" / "2 to pull" are facts about the remote, not guesses. Silent when there's no upstream to compare.
  if (upstream && (ahead || behind)) {
    const sy = document.createElement('div'); sy.className = 'ph-sync';
    const chip = (txt, cls) => { const s = document.createElement('span'); s.className = 'ph-chip ' + cls; s.textContent = txt; sy.appendChild(s); };
    if (ahead) chip('↑ ' + ahead + ' to push', 'ahead');
    if (behind) chip('↓ ' + behind + ' to pull', 'behind');
    const t = document.createElement('span'); t.className = 'ph-sync-t';
    t.textContent = (r.branch ? r.branch + ' → ' : '') + upstream;
    t.title = ahead && behind ? 'This branch and ' + upstream + ' have both moved on.'
      : ahead ? ahead + ' commit' + (ahead > 1 ? 's' : '') + ' exist only on this machine — GitHub hasn’t seen them.'
      : upstream + ' has ' + behind + ' commit' + (behind > 1 ? 's' : '') + ' you don’t have yet.';
    sy.appendChild(t);
    body.appendChild(sy);
  }
  if (files.length || untracked.length) {
    const lbl = document.createElement('div'); lbl.className = 'diff-sec-lbl'; lbl.textContent = 'uncommitted — in the working tree';
    body.appendChild(lbl);
    files.forEach((f) => body.appendChild(renderDiffFile(f, false, targetWsId)));
    if (untracked.length) {
      const ul = document.createElement('div'); ul.className = 'diff-sec-lbl'; ul.textContent = 'new files (untracked)';
      body.appendChild(ul);
      untracked.forEach((p) => body.appendChild(renderUntracked(p, targetWsId)));
    }
  }
  // Commits and their net diff are INDEPENDENT: the list must show even when the diff is empty (commit+revert)
  // or was dropped for size. Gating the list on `committed.length` is what made this panel look permanently dead.
  if (commits.length || committed.length) {                            // work already committed — visible, review-only
    const shown = commits.length, more = Math.max(0, (week || 0) - shown);
    const lbl = document.createElement('div'); lbl.className = 'diff-sec-lbl';
    // A repo you commit to monthly isn't a repo with "no commits" — when this week is empty, diff.sh sends the
    // latest ones instead and says so, and the label has to stop claiming they happened in the last 7 days.
    lbl.textContent = win === 'latest'
      ? 'latest commits · nothing in the last 7 days · review only'
      : 'recent · last 7 days'
        + (week ? ' · ' + week + ' commit' + (week > 1 ? 's' : '') + (more ? ' (showing ' + shown + ')' : '') : '')
        + ' · review only';
    body.appendChild(lbl);
    if (commits.length) body.appendChild(renderCommitList(commits));
    if (committed.length) committed.forEach((f) => body.appendChild(renderDiffFile(f, true, targetWsId)));
    else if (commits.length) {                                         // commits, but nothing to diff (net-zero, or too big)
      const n = document.createElement('div'); n.className = 'diff-empty'; n.style.cssText = 'padding:6px 0;text-align:left';
      n.textContent = 'These commits have no net file changes to show (they cancel out, or the diff was too large to render).';
      body.appendChild(n);
    }
  }
}
function renderCommitList(commits) {
  const box = document.createElement('div'); box.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin:2px 0 8px';
  commits.forEach((c) => {
    const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:baseline;gap:8px;font-size:11.5px;line-height:1.4';
    const h = document.createElement('code'); h.textContent = c.hash; h.style.cssText = 'color:#7f9cff;flex:none;font-size:11px';
    const s = document.createElement('span'); s.textContent = c.subject; s.title = c.subject; s.style.cssText = 'color:var(--ink,#e7eaef);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0';
    row.appendChild(h); row.appendChild(s);
    // `pushed` is absent (not false) when there's no upstream to compare against — never label a commit
    // "not on GitHub" just because the branch doesn't track anything.
    if (c.pushed === false) {
      const u = document.createElement('span'); u.className = 'ph-chip ahead'; u.textContent = 'not on GitHub';
      u.title = 'This commit exists only on this machine — push the branch to share it.';
      row.appendChild(u);
    }
    const m = document.createElement('span'); m.textContent = [c.author, c.date].filter(Boolean).join(' · '); m.style.cssText = 'color:var(--ink-faint,#565c66);flex:none;font-size:10px';
    row.appendChild(m); box.appendChild(row);
  });
  return box;
}
async function doDiffRevert(patch, btn, label, wsId) {
  if (wsBusy(wsId || activeWsId)) {   // reverting a hunk/file while Claude edits the SAME project's worktree races its writes — confirm first (guard the CARD's project, not whatever's active)
    const go = await modalChoice({
      title: 'Claude is still working',
      body: 'Reverting these changes now can clobber Claude’s in-flight edits in this project. It’s safest to wait for the turn to finish. Revert anyway?',
      choices: [{ key: 'go', label: 'Revert anyway', danger: true }, { key: 'cancel', label: 'Cancel' }],
    });
    if (go !== 'go') return;
  }
  btn.disabled = true;
  let r = null; try { r = await claudible.diffRevert(patch, wsId); } catch {}
  if (r && r.ok) { toast(label || 'Reverted'); refreshDiff(); }
  else { btn.disabled = false; toast('Revert failed' + (r && r.error ? ': ' + humanError(r.error) : '')); }
}
function renderDiffFile(f, readOnly, wsId) {
  const card = document.createElement('div'); card.className = 'diff-file' + (readOnly ? ' committed' : '');
  const head = document.createElement('div'); head.className = 'diff-file-head';
  const nm = document.createElement('span'); nm.className = 'diff-path'; nm.textContent = f.path; nm.title = f.path;
  const cnt = document.createElement('span'); cnt.className = 'diff-counts';
  const add = document.createElement('i'); add.className = 'add'; add.textContent = '+' + (f.additions || 0);
  const del = document.createElement('i'); del.className = 'del'; del.textContent = '-' + (f.deletions || 0);
  cnt.appendChild(add); cnt.appendChild(del);
  head.appendChild(nm); head.appendChild(cnt);
  if (!readOnly && !f.binary && f.filePatch) {
    const rb = document.createElement('button'); rb.className = 'diff-revert-file'; rb.textContent = 'Revert file';
    rb.title = 'Undo all of Claude’s changes to this file';
    rb.addEventListener('click', () => doDiffRevert(f.filePatch, rb, 'Reverted ' + f.path, wsId));
    head.appendChild(rb);
  }
  card.appendChild(head);
  if (f.binary) { const b = document.createElement('div'); b.className = 'diff-binary'; b.textContent = '(binary file — changed)'; card.appendChild(b); return card; }
  (f.hunks || []).forEach((h) => {
    const hk = document.createElement('div'); hk.className = 'diff-hunk';
    const hh = document.createElement('div'); hh.className = 'diff-hunk-head';
    const hl = document.createElement('span'); hl.className = 'diff-hunk-lbl'; hl.textContent = h.header;
    hh.appendChild(hl);
    if (!readOnly) {
      const rv = document.createElement('button'); rv.className = 'diff-revert-hunk'; rv.textContent = 'Revert';
      rv.title = 'Undo just this hunk';
      rv.addEventListener('click', () => doDiffRevert(h.patch, rv, 'Reverted hunk', wsId));
      hh.appendChild(rv);
    }
    hk.appendChild(hh);
    const pre = document.createElement('div'); pre.className = 'diff-lines';
    (h.lines || []).forEach((l) => {
      const ln = document.createElement('div');
      ln.className = 'dl ' + (l.t === '+' ? 'add' : l.t === '-' ? 'del' : l.t === '\\' ? 'meta' : 'ctx');
      ln.textContent = (l.t === ' ' || !l.t ? '  ' : l.t + ' ') + (l.s || '');
      pre.appendChild(ln);
    });
    hk.appendChild(pre); card.appendChild(hk);
  });
  return card;
}
function renderUntracked(p, wsId) {
  const row = document.createElement('div'); row.className = 'diff-file';
  const head = document.createElement('div'); head.className = 'diff-file-head';
  const nm = document.createElement('span'); nm.className = 'diff-path'; nm.textContent = p; nm.title = p;
  const tag = document.createElement('span'); tag.className = 'diff-counts'; const t = document.createElement('i'); t.className = 'add'; t.textContent = 'new'; tag.appendChild(t);
  const db = document.createElement('button'); db.className = 'diff-revert-file'; db.textContent = 'Discard'; db.title = 'Delete this new file';
  db.addEventListener('click', async () => {
    db.disabled = true; let r = null; try { r = await claudible.diffDiscard(p, wsId); } catch {}
    if (r && r.ok) { toast('Discarded ' + p); refreshDiff(); } else { db.disabled = false; toast('Discard failed' + (r && r.error ? ': ' + humanError(r.error) : '')); }
  });
  head.appendChild(nm); head.appendChild(tag); head.appendChild(db); row.appendChild(head); return row;
}
$('diff-btn').addEventListener('click', () => openDiff(!$('diffpanel').classList.contains('open')));
$('diff-close').addEventListener('click', () => openDiff(false));
$('diff-refresh').addEventListener('click', () => renderProjectHistory());
$('diff-scrim').addEventListener('click', () => openDiff(false));
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('diffpanel').classList.contains('open')) openDiff(false); });

// ---------- viewer chat (human↔human side channel; never reaches Claude/terminal) ----------
const chatLog = $('chat-log'), chatIn = $('chat-in');
let hostChat = [];                                   // your host-share chat buffer (you ↔ your guests)
// The single chat panel is mode-aware: on a joined LIVE tab it shows/drives that session's chat; otherwise your
// host-share chat. Each live tab keeps its own buffer on its tab record (rec.chat), so switching tabs never mixes them.
function chatCtx() { const t = AT(); return (t && t.kind === 'live') ? t : null; }   // the live tab in view, or null = host-share
function chatBufFor(ctx) { return ctx ? (ctx.chat || (ctx.chat = [])) : hostChat; }
function chatReset() {
  chatLog.innerHTML = '<div class="chat-empty" id="chat-empty">' +
    (chatCtx() ? 'Chat with everyone in this live session — Claude never sees these messages.'
               : 'Messages here go only between you and your viewer — Claude never sees them.') + '</div>';
}
// Repaint the single #chat-log from the ACTIVE context's buffer (on every new message + on tab switch).
function renderChatLog() {
  const buf = chatBufFor(chatCtx());
  if (!buf.length) { chatReset(); return; }
  chatLog.innerHTML = '';
  buf.forEach((m) => {
    if (m.sys) { const d = document.createElement('div'); d.className = 'chat-sys'; d.textContent = m.text; chatLog.appendChild(d); return; }
    const d = document.createElement('div'); d.className = 'chat-msg ' + (m.mine ? 'me' : 'them');
    const w = document.createElement('span'); w.className = 'who'; w.textContent = m.who;
    const body = document.createElement('div'); body.textContent = m.text;   // textContent → no HTML injection
    const cp = document.createElement('button'); cp.className = 'chat-copy'; cp.title = 'Copy message'; cp.setAttribute('aria-label', 'Copy message');
    cp.dataset.text = m.text;   // copy the raw text → paste straight into Claude
    cp.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1"/></svg>';
    d.appendChild(w); d.appendChild(body); d.appendChild(cp); chatLog.appendChild(d);
  });
  chatLog.scrollTop = chatLog.scrollHeight;
}
// Hover copy on any chat message → clipboard, so a collaborator's prompt can be pasted straight into Claude.
if (chatLog) chatLog.addEventListener('click', async (e) => {
  const cp = e.target.closest('.chat-copy'); if (!cp) return;
  e.stopPropagation();
  let r = null; try { r = await claudible.clipWrite(cp.dataset.text || ''); } catch {}   // main-process clipboard → works regardless of renderer perms (matches the rest of the app)
  toast((r && r.ok) ? 'Message copied' : 'Could not copy — ' + humanError('clipboard'));
});
{ const _term = $('chat-terminate'); if (_term) _term.addEventListener('click', () => { const t = AT(); if (t && t.kind === 'live') closeTab(t.tabId); else terminateLive(); }); }   // host → End Session (terminate for all); joiner → Leave Session (close the joined tab → back to single-person view)
// Append to a SPECIFIC buffer; only repaint if that buffer is the one currently on screen.
function chatAppend(buf, entry, onScreen) { buf.push(entry); if (buf.length > 400) buf.shift(); if (onScreen) renderChatLog(); }
function sendChat() {
  const text = chatIn.value.trim(); if (!text) return;
  const ctx = chatCtx();
  if (ctx) { chatAppend(chatBufFor(ctx), { who: youName(), text, mine: true }, true); claudible.liveChatSend(ctx.tabId, text); }   // → the joined session
  else { chatAppend(hostChat, { who: hostDisplayName, text, mine: true }, true); claudible.shareSendChat(text); }                  // → your guests
  chatIn.value = '';
}
$('chat-send').addEventListener('click', sendChat);
chatIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
// Your host-share guests' chat → the host buffer (shown only when a live tab ISN'T in view).
claudible.onShareChat((m) => {
  if (!m) return;
  const onScreen = chatCtx() === null;
  if (m.role === 'system') chatAppend(hostChat, { sys: true, text: m.text }, onScreen);   // "X joined" / "X left"
  else if (m.text) { chatAppend(hostChat, { who: m.name || 'viewer', text: m.text, mine: false }, onScreen); if (chimeOn) playChime(); }
});
// A JOINED session's chat → that live tab's own buffer.
claudible.onLiveChat((p) => {
  if (!p) return; const rec = tabs.get(p.tabId); if (!rec || rec.kind !== 'live') return;
  const buf = chatBufFor(rec), onScreen = activeTabId === p.tabId;
  if (p.role === 'system') chatAppend(buf, { sys: true, text: p.text }, onScreen);
  else if (p.text) { chatAppend(buf, { who: p.name || rec.hostName || 'host', text: p.text, mine: false }, onScreen); if (chimeOn) playChime(); }   // chime even if the live tab is backgrounded (parity with host chat)
});
// A JOINED session's Session-History feed (the host pushes its log over the live channel) → held on the live
// tab's record; the Repo Review drawer renders it view-only when that tab is active (see refreshHistoryFeed).
claudible.onLiveHistory((p) => {
  if (!p) return; const rec = tabs.get(p.tabId); if (!rec || rec.kind !== 'live') return;
  rec.liveHistory = Array.isArray(p.entries) ? p.entries : [];
  if (activeTabId === p.tabId && $('diffpanel') && $('diffpanel').classList.contains('open')) { try { refreshHistoryFeed(); } catch {} }   // live-update only when the drawer is actually looking at it
});
chatReset();

// ---------- persisted preferences (voice + Always Speak) ----------
// Persisted to a FILE in the local app folder (runtime/settings.json, via the preload) so your username + every
// pref survive restarts and hard process kills — localStorage alone loses unflushed writes on a force-kill. An
// in-memory cache keeps the synchronous get/set API every caller relies on; localStorage stays as a legacy mirror
// + one-time migration source (so an older install's username carries over to the durable file on first run).
const PREFS_KEY = 'claudible_prefs';
function loadPrefs() {
  if (!loadPrefs._cache) {
    let disk = {}, ls = {};
    try { const s = window.claudible && claudible.settingsInitial; if (s && typeof s === 'object') disk = s; } catch {}
    try { ls = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch {}
    loadPrefs._cache = JSON.parse(JSON.stringify(Object.assign({}, ls, disk)));   // DEEP CLONE → fully mutable. settingsInitial crosses contextBridge FROZEN; a shallow merge keeps nested objects (sessionTitles, wsOrder…) read-only, so in-place writes silently vanish (the 2h "rename never saves" bug).
    try { if (window.claudible && claudible.settingsSave && Object.keys(ls).length && !Object.keys(disk).length) claudible.settingsSave(loadPrefs._cache); } catch {}
  }
  return loadPrefs._cache;
}
function savePrefs(patch) {
  const p = loadPrefs(); Object.assign(p, patch);
  try { if (window.claudible && claudible.settingsSave) claudible.settingsSave(p); } catch {}   // durable, synchronous file write
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch {}                            // legacy mirror
}
// ---- bounded, evictable title prefs -------------------------------------------------------------------------
// `sessionTitles` / `sessionTitleTs` are PERSISTED to settings.json and nothing ever removed a key: not on session
// delete, not on workspace delete. Every session ever renamed — locally or by a collaborator's newest-wins
// reconcile — left a permanent entry. Two mechanisms, because either alone is insufficient:
//   * evict explicitly when the session it names is deleted (correctness — the id can never come back), and
//   * cap the map by recency, so an install that renames sessions for years still has a bounded settings.json.
// sessionTitleTs already carries the ms timestamp the cap needs, so "recency" is exact, not a guess.
const MAX_TITLE_PREFS = 500;
function saveSessionTitles(titles, tstamps) {
  const ids = Object.keys(titles);
  if (ids.length > MAX_TITLE_PREFS) {
    ids.sort((a, b) => (Number(tstamps[b]) || 0) - (Number(tstamps[a]) || 0));   // newest first
    for (const id of ids.slice(MAX_TITLE_PREFS)) { delete titles[id]; delete tstamps[id]; }
  }
  savePrefs({ sessionTitles: titles, sessionTitleTs: tstamps });
}
// A deleted session's id can never recur — drop its name so settings.json doesn't carry it forever.
function forgetSessionTitle(id) {
  const p = loadPrefs();
  const lt = Object.assign({}, p.sessionTitles || {}), lts = Object.assign({}, p.sessionTitleTs || {});
  if (!(id in lt) && !(id in lts)) return;
  delete lt[id]; delete lts[id];
  savePrefs({ sessionTitles: lt, sessionTitleTs: lts });
}
// A deleted workspace's warm caches are dead weight — and `_wsSessCache` would even serve STALE rows to a
// workspace later re-created with the same id.
function forgetWorkspaceCaches(wsId) {
  try { _wsSessCache.delete(wsId); } catch {}
  try { delete wsSyncState[wsId]; } catch {}   // the sync badge's per-ws state was the one cache this never dropped — pure growth, and a workspace id CAN recur (ws.id is `<kind>-<slug>`, not a uuid), which would show a re-created workspace the dead one's sync status
  const p = loadPrefs();
  const c = p.remoteTitlesCache || {};
  if (!(wsId in c)) return;
  const next = Object.assign({}, c); delete next[wsId];
  savePrefs({ remoteTitlesCache: next });
}
(function applyPrefs() {
  const p = loadPrefs();
  applyTheme(p.theme);   // re-tint the UI + terminal to the saved theme (Dark when unset)
  if (p.voice && document.querySelector('.vpill[data-voice="' + p.voice + '"]')) {
    selectedVoice = p.voice;
    document.querySelectorAll('.vpill').forEach((x) => x.classList.toggle('on', x.dataset.voice === p.voice));
  }
  if (typeof p.alwaysSpeak === 'boolean') {
    alwaysSpeak = p.alwaysSpeak;
    $('always-speak').checked = p.alwaysSpeak;
    $('always-toggle').classList.toggle('on', p.alwaysSpeak);
  }
  // factory-on (undefined → ON): announce-when-done + chat chime; speed defaults to baseline (0)
  announceOn = p.announce !== false; if ($('announce-done')) { $('announce-done').checked = announceOn; $('announce-toggle').classList.toggle('on', announceOn); }
  chimeOn = p.chime !== false; if ($('chat-chime')) { $('chat-chime').checked = chimeOn; $('chime-toggle').classList.toggle('on', chimeOn); }
  fullReadout = p.fullReadout !== false; if ($('full-readout')) { $('full-readout').checked = fullReadout; $('fullreadout-toggle').classList.toggle('on', fullReadout); }
  { const sh = p.sessionHistory !== false; if ($('sess-history')) { $('sess-history').checked = sh; $('sesshist-toggle').classList.toggle('on', sh); } }   // session history: default ON (absence = on; explicit false = off) — must mirror main's _histEnabled
  applyTtsSpeed(p.ttsSpeed || 0, false);
  if (p.pttKey) { if (isSafePttKey(p.pttKey)) pttKey = p.pttKey; else savePrefs({ pttKey: 'AltLeft' }); }   // self-heal a bad saved key (e.g. an old rebind to Space) so it can't keep eating the spacebar
  applyPttKey();   // render the current push-to-talk key (default or saved)
  syncVoiceUI();   // reflect saved voice + always-speak in the top-bar Voice Out box
})();

// ---------- sessions sidebar (switch between Claude conversations, like Claude Code) ----------
const sessListEl = $('sess-list');
const newSessEl = $('new-session');   // capture ONCE (like sessListEl). getElementById returns null for a DETACHED node, so re-querying after the active workspace is collapsed/detached would lose the "+ New Session" row forever.
const bodyEl = document.querySelector('.body');
// activeSession / workspaces / activeWsId are declared up top (near the tabs Map) so the tab-strip boot can
// reference them. The conversation order is stored PER workspace so switching libraries never reshuffles another's.
function orderKey() { return 'wsOrder2_' + activeWsId; }   // v2: re-seed from the shared `created` order (drops divergent per-machine v1 orders)
function getOrder() { return loadPrefs()[orderKey()] || []; }
function setOrder(order) { savePrefs({ [orderKey()]: order }); }
// The saved order for ANY workspace, not just the active one — the tree view renders other projects' sessions.
function orderForWs(wsId) { return loadPrefs()['wsOrder2_' + wsId] || []; }
// THE one session ordering, for every surface that lists a workspace's sessions: the authoritative active list
// (refreshSessions), the switch-time pre-fill (primeSessionListForWs), and the non-active expanded tree
// (renderWsNonActiveSessions). Three sites used to order independently and drifted — the tree sorted by
// used/mtime while the other two used the saved order, so clicking into a project whose tree was on screen
// visibly REORDERED the same rows in the same tick (the "sessions switch places" glitch; regression in a0c3c59,
// which unified only two of the three). Returns session OBJECTS in render order; does NOT persist anything —
// only refreshSessions (the authoritative pass) calls setOrder.
function orderedSessionsFor(wsId, list) {
  const arr = Array.isArray(list) ? list : [];
  const byId = {}; arr.forEach((s) => { byId[s.id] = s; });
  return mergeSessionOrder(orderForWs(wsId), arr).map((id) => byId[id]).filter(Boolean);
}
function relTime(sec) {
  if (!sec) return '';
  const d = Math.max(0, Date.now() / 1000 - sec);
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  if (d < 86400 * 7) return Math.floor(d / 86400) + 'd ago';
  if (d < 86400 * 30) return Math.floor(d / (86400 * 7)) + 'w ago';
  if (d < 86400 * 365) return Math.floor(d / (86400 * 30)) + 'mo ago';
  return Math.floor(d / (86400 * 365)) + 'y ago';   // no more "968d ago" on ancient sessions
}
// Render order is a STABLE saved list (in prefs), not live mtime — so clicking/resuming a session (which
// bumps its .jsonl mtime) never reshuffles the list. New/unseen sessions are inserted at top, newest-first
// (chronological default); drag rewrites the order; delete removes from it.
function mergeSessionOrder(saved, list) {
  saved = Array.isArray(saved) ? saved : [];
  const ids = new Set(list.map((s) => s.id));
  const savedSet = new Set(saved);
  const kept = saved.filter((id) => ids.has(id));                                   // keep saved order; drop deleted
  const fresh = list.filter((s) => !savedSet.has(s.id))
                    .sort((a, b) => ((b.created || b.mtime || 0) - (a.created || a.mtime || 0)))   // by SHARED created time → same order for every collaborator
                    .map((s) => s.id);
  return [...fresh, ...kept];
}
const TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
const PENCIL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
const SHARE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><polyline points="8 7 12 3 16 7"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
const OPTIONS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/></svg>';   // "settings-2" sliders — the options trigger on session rows + workspace chips. A settings glyph (not a ▾ that wrongly implies a dropdown), distinct from both the ⋯ and the top-bar gear.
let sessIndex = {};                                                                 // id -> session record (labels/preview)
let sessIndexWs = '';                                                               // which workspace sessIndex belongs to — activeWsId flips synchronously on a switch while sessIndex is rebuilt async, so consumers that must not cross workspaces (pollTitles' re-publish) check this tag
// Session title: prefer the workspace-shared name (so everyone in a repo workspace sees the SAME title), then a
// local-only override (legacy/local workspaces, or before the first poll), then the transcript-derived preview.
function sessTitle(s, wsId) {   // wsId: the row's workspace when it ISN'T the active one (the expanded tree) — the shared-name cache is keyed per workspace
  // GLOBAL NEWEST-WINS. Your own rename shows instantly (stamped with a local ts) and sticks while its branch
  // push is in flight — but a collaborator's NEWER rename (branch entries carry the winning ts) replaces it, so
  // two machines can never permanently disagree about a session's name. A local rename with no recorded ts
  // (pre-upgrade) only holds until any timestamped shared name arrives.
  const _p = loadPrefs();
  const local = (_p.sessionTitles || {})[s.id];
  const localTs = Number((_p.sessionTitleTs || {})[s.id]) || 0;
  const sharedV = remoteTitles[s.id];
  const shared = titleVal(sharedV), sharedTs = titleTs(sharedV);
  if (local && (!shared || localTs >= sharedTs)) return local;
  if (shared) return shared;
  if (local) return local;
  // WARM CACHE: pollTitles persists the last-known shared names per workspace. remoteTitles is empty for the first
  // ~2s after open (the branch read is async), so without this a collaborator/cross-machine rename flashes its
  // auto-preview then snaps to the real name. The cache lets that name paint instantly; the live poll reconciles it.
  const cached = titleVal(((loadPrefs().remoteTitlesCache || {})[wsId || activeWsId] || {})[s.id]);
  if (cached) return cached;
  return s.preview;
}
// Does a tab bound to this session have an unseen "turn finished" flag? (drives the sidebar pulse; survives rebuilds)
// wsId defaults to the active workspace; the expanded-tree rows pass THEIR workspace, since a background tab can
// now live in another project (openWsSessionInTab) and its pulse must still show on that project's rows.
function sessionNeedsAttention(id, wsId) { const w = wsId || activeWsId; for (const r of tabs.values()) if (r.wsId === w && r.session === id && r.attention) return true; return false; }
// …and is it mid-turn? Lets a full rebuild restore the busy dot too, instead of waiting for the next hook line.
function sessionBusyInTab(id, wsId) { const w = wsId || activeWsId; for (const r of tabs.values()) if (r.wsId === w && r.session === id && r.busy) return true; return false; }
// A session someone DELIBERATELY NAMED is never stub-noise, even before its first real prompt: the picker's
// promptless-stub filter exists to bury accidental fork artifacts, and hiding a just-created, just-named
// session reads as "my new session didn't sync" to the collaborator. Checks my local rename, the live shared
// map, and the per-workspace warm cache (wsId: the row's workspace when it isn't the active one).
function hasExplicitTitle(id, wsId) {
  if (!id) return false;
  const p = loadPrefs();
  if ((p.sessionTitles || {})[id]) return true;
  if (titleVal(remoteTitles[id])) return true;
  return !!titleVal(((p.remoteTitlesCache || {})[wsId || activeWsId] || {})[id]);
}
// ---- Live sessions: advertise the session I'm hosting; discover + join a collaborator's, natively ----
// Explicit opt-in: I only host (advertise) a session after I pick "Share live" on it — NOT automatically just
// because sync is on. sharedSessionId is the one session I've chosen to share (null = not sharing). It resets on
// reload, so a refresh never silently re-hosts (the bug that made two people both host the same session).
let sharedSessionId = null;
// The workspace the shared session lives in, captured when Share Live is turned on. The host is free to browse
// (or work in) a different workspace afterwards — the share stays welded to THIS one, matching main's mirrorWs().
let sharedWsId = null;
function isSharingSession(id) { return !!id && sharedSessionId === id; }
// The name of the session I'm hosting — for the "your live session is still running over there" bar. Prefer the
// pinned TAB's own label (truthful even when the host is browsing a workspace whose sessIndex doesn't hold it).
function sharedSessionLabel() {
  if (!sharedSessionId) return '';
  const r = (sharedTabIdR != null) ? tabs.get(sharedTabIdR) : null;
  if (r && (r.curSessionLabel || r.label)) return r.curSessionLabel || r.label;
  const s = sessIndex[sharedSessionId];
  return s ? sessTitle(s, sharedWsId) : '';
}
// Is this session LIVE right now — mine and shared, one I've joined, or one a collaborator is hosting? Used to
// suppress the "out of sync" resolve affordance: a live transcript is being appended to by its host's Claude
// this instant, so replacing it on disk (what "use the shared version" does) would destroy the running turn.
const LIVE_DEAD = new Set(['offline', 'denied']);   // a joined tab in these states is a corpse, not a live session
// `wsId` = the project of the ROW asking (an expanded tree passes its own w.id; active-list callers omit it).
// peersForWs is per-project, so checking the ACTIVE project's bucket for a row in a DIFFERENT project's tree
// found nothing — and the "out of sync" chip painted onto a session a collaborator was hosting live on screen.
function sessionIsLive(id, wsId) {
  if (!id) return false;
  if (sharedSessionId === id) return true;                                            // I'm hosting it
  // I've joined it — but only while the mirror is actually alive. A joined tab whose host ended their session can
  // linger indefinitely (reconcileJoinedTabs only auto-closes it while you're viewing ITS project), and keying
  // liveness on the tab merely EXISTING would suppress that session's "out of sync" chip forever.
  for (const r of tabs.values()) if (r.kind === 'live' && r.peer && r.peer.session === id && !LIVE_DEAD.has(r.liveState)) return true;
  return peersForWs(wsId || activeWsId).some((p) => p && p.session === id);           // a collaborator is hosting it, in the row's project
}
// Session ids currently occupied by a JOINED live tab (any state — a dead mirror still owns its row until the
// user closes it, mirroring the active list's dedup rule). The ONE authority both render surfaces consult so a
// joined session can never paint twice: the active list pins the joined row (refreshSessions' `shown` set), and
// an expanded tree's saved copy of the same id stands down (renderWsNonActiveSessions).
function joinedTabSessionIds() {
  const s = new Set();
  for (const r of tabs.values()) if (r.kind === 'live' && r.peer && r.peer.session) s.add(r.peer.session);
  return s;
}
// Advertise only changes when it actually changes (avoids spamming presence pushes).
function updateAdvertise() {
  // Keyed on the SHARED session, never the VIEWED one. Sharing is a property of a pinned tab (main's
  // sharedTabId), not of where the host happens to be looking — so opening another session (new tab or
  // recycled) must not unadvertise. sharedWsId is captured at Share time: the host may be browsing a
  // different (even non-repo) workspace while the shared session keeps streaming.
  const aw = workspaces.find((w) => w.id === (sharedWsId || activeWsId));
  const want = (tunnelUp && aw && aw.kind === 'repo' && sharedSessionId) ? sharedSessionId : null;
  if (want === advertisedSession) return;
  advertisedSession = want;
  if (!want) { try { claudible.liveUnadvertise(); } catch (e) {} return; }
  // advertise + warn the host if the tunnel isn't actually up (so they know WHY a collaborator can't join,
  // instead of silently publishing an unreachable handle). The main-process heartbeat self-heals once it connects.
  try {
    claudible.liveAdvertise(want, collabName())
      .then((r) => {
        if (r && r.error === 'already-live') {
          // The authoritative claim check refused: a collaborator beat us to hosting this exact session (the
          // race the ~10s presence poll can miss). Roll the share back completely — keeping sharedSessionId
          // would leave the UI saying "sharing" while nothing is advertised.
          if (sharedSessionId === want) { sharedSessionId = null; sharedWsId = null; }
          advertisedSession = null;
          updateCollab(); refreshSessions(); refreshExpandedTrees();
          toast((r.by || 'A collaborator') + ' went live on this session first — use Join to hop in instead');
          return;
        }
        if (r && r.error === 'tunnel-down') toast('Sharing started — but the live tunnel isn’t up yet, so collaborators can’t join until it connects. Check your internet / that cloudflared isn’t blocked.');
      })
      .catch(() => {});
  } catch (e) {}
}
// ---- Collaboration tunnel: keep the single share server matching what's actually wanted — a manual web link
// (webShare) OR a synced session a peer can join (collabLive). The bottom-left indicator is driven SEPARATELY
// (webShareUI), so collaboration never lights up as "sharing live". ----
async function ensureTunnel() {
  if (tunnelBusy) return;                                  // an op is in flight; it reconciles at the end
  const want = webShare || collabLive;
  if (want === tunnelUp) { refreshChatPanel(); updateAdvertise(); return; }
  tunnelBusy = true;
  try {
    if (want) {
      const ro = (!collabLive && webShare) ? !!$('share-ro').checked : false;   // collab is always co-drive
      const nm = collabName() || hostDisplayName || 'Host';   // one Claudible username, used hosting + joining
      const r = await claudible.shareStart({ readOnly: ro, name: nm });
      if (r && r.ok) { tunnelUp = true; lastShareUrl = r.url; lastShareRemote = r.remote; lastShareNote = r.note; lastShareReadOnly = !!r.readOnly; }
    } else {
      await claudible.shareStop(); tunnelUp = false; lastShareUrl = ''; guestCount = 0; lastRoster = [];   // no tunnel → no viewers
    }
  } catch (e) {}
  tunnelBusy = false;
  try { $('share-ro').disabled = tunnelUp; } catch (e) {}   // view-only can only be chosen when starting a FRESH tunnel
  refreshChatPanel(); updateAdvertise();
  if ((webShare || collabLive) !== tunnelUp) ensureTunnel();   // desired state changed mid-flight → reconcile
}
// Collaboration follows the per-workspace "Sync sessions" toggle: a synced repo session means a collaborator can
// Join live, automatically — no manual sharing. Recomputed whenever the active workspace/session/sync changes.
function updateCollab() {
  if (AT() && AT().kind === 'live') { renderLiveBar(); return; }   // viewing a peer's session — DON'T recompute your own share off the live tab's (null) session, or you'd drop your own tunnel + guests
  // Keyed on the SHARED session + ITS workspace, not the viewed tab's. This is the whole "work in another
  // session while a guest keeps watching the shared one" guarantee: every tab switch runs refreshSessions →
  // updateCollab, and keying this on activeSession made an ordinary sidebar click tear the tunnel down
  // (shareStop closes every guest socket). Sharing ends only on an explicit user action (toggle off / End
  // Session) or when the one-host arbiter revokes our claim.
  const aw = workspaces.find((w) => w.id === (sharedWsId || activeWsId));
  collabLive = !!(aw && aw.kind === 'repo' && sharedSessionId);   // explicit: tunnel only when I've chosen to Share a session
  ensureTunnel();
  renderLiveBar();                                  // show/hide the in-session "● Live · who's here" bar
}
// Toggle live-sharing of a session from the ▾ menu. Sharing streams the live pty, so the session must be the
// active one — switch to it if needed. Stop sharing drops the tunnel (unless a manual web-share is up).
function toggleShareSession(s) {
  if (!s || !s.id) return;
  if (sharedSessionId === s.id) {
    sharedSessionId = null; sharedWsId = null;
    updateCollab(); updateAdvertise(); refreshSessions(); refreshExpandedTrees();   // …and drop the green rail + badge from every other project's open tree
    toast('Stopped sharing this session');
  } else {
    // ONE live host per session: if a collaborator is already live on this session (their fresh presence is
    // what draws the green Join badge on this very row), a second "Share live" would advertise a rival host —
    // two divergent "live" copies and an ambiguous Join target. Refuse up front; the presence script re-checks
    // authoritatively at claim time for the race this ~10s poll can miss.
    const holder = peersForWs(activeWsId).find((p) => p && p.session === s.id);
    if (holder) { toast((holder.name || holder.login || 'A collaborator') + ' is already live on this session — use Join to hop in instead'); return; }
    sharedSessionId = s.id; sharedWsId = activeWsId;   // weld the share to THIS session + workspace; browsing elsewhere later must not drop it
    // The shared session must be the FOREGROUND tab when the tunnel starts (main pins sharedTabId = fgTabId).
    // openSession focuses its existing tab, or opens one — either way that tab is foregrounded before
    // updateCollab→ensureTunnel→shareStart runs (tabForeground and shareStart are ordered on the same IPC channel).
    if (activeSession !== s.id) openSession(s.id, sessTitle(s));
    updateCollab(); updateAdvertise(); refreshSessions(); refreshExpandedTrees();   // symmetric: a tree must GAIN the marker too, not only lose it
    toast('Sharing live — collaborators can now Join');
  }
}
// Poll the shared branch for collaborators who are live (only in a repo workspace). Re-render on change.
// Auto-recover joined tabs when the HOST's tunnel URL/token ROTATES. trycloudflare hands out a brand-new random
// URL on every cloudflared restart, so a guest that joined the old URL ends up hammering a dead tunnel, gives up,
// and shows "ended" forever — even though the host already re-advertised a fresh handle. On each presence refresh,
// re-arm any offline/reconnecting joined tab whose host handle CHANGED, with the fresh url+token (mirrors the manual
// rearm path in openLiveTab). Only fires on an actual url/token change, so it can't tight-loop on a stable dead URL.
const LIVE_RECONNECTABLE = new Set(['offline', 'reconnecting']);
function reconcileJoinedTabs(pollOk) {
  const ended = [];
  for (const rec of tabs.values()) {
    if (rec.kind !== 'live' || !rec.peer || !rec.peer.session) continue;
    const fresh = peersForWs(rec.peerWsId).find((p) => p.session === rec.peer.session && p.url && p.token);   // only the branch this tab was joined from can speak about its host
    if (!fresh) {
      // The host stopped advertising = they ENDED the session. If our tab has already given up (offline) or is
      // futilely retrying (reconnecting) AND the presence poll genuinely succeeded, auto-leave back to the
      // single-person view instead of sitting on a dead "ended" tab. pollOk guards a transient fetch error;
      // the close is DEFERRED so we never mutate `tabs` mid-iteration.
      //
      // The peerWsId===activeWsId guard stays deliberately conservative: we AUTO-CLOSE a joined tab only for the
      // project you're actively in. (The poll now covers expanded projects too, but a joined tab's own socket is
      // the authoritative "host ended" signal for it — Fix 3 — so we don't need reconcile to reach across projects
      // to close it; doing so risked closing a tab out from under a joiner who'd merely clicked onto another
      // project and whose socket then blipped to `reconnecting`.) pollOk guards a transient active-ws fetch error.
      if (pollOk && rec.peerWsId === activeWsId && LIVE_RECONNECTABLE.has(rec.liveState)) ended.push(rec.tabId);
      continue;
    }
    if (!LIVE_RECONNECTABLE.has(rec.liveState)) continue;
    if (fresh.url === rec.peer.url && fresh.token === rec.peer.token) continue;   // unchanged → nothing new to dial
    console.log('[live] host handle rotated — re-arming joined tab', rec.tabId, '→', fresh.url);
    rec.peer = fresh;
    setLiveState(rec, 'connecting');
    claudible.liveConnect(rec.tabId, fresh, collabName())
      .then((r) => { if (!r || !r.ok) setLiveState(rec, 'offline'); })
      .catch((err) => { console.error('[live] re-arm rejected:', err); setLiveState(rec, 'offline'); });
  }
  if (ended.length) { toast('Host ended the live session'); ended.forEach((id) => { try { closeTab(id); } catch {} }); }
}
let _pollLiveInFlight = false;
async function pollLivePeers() {
  // Refresh presence for every repo project whose live badge is currently VISIBLE — the active one PLUS every
  // expanded one — so a collaborator going live/offline in a project you're looking at (but not active in)
  // repaints on the next tick instead of freezing until you click into it. Each project is fetched with ITS OWN
  // wsId and bucketed under it, so peers can never cross projects. (Cost: one presence fetch per visible repo per
  // 10s; bounded by what the user has open. A clean End clears instantly via the host's retrying clear anyway.)
  if (_pollLiveInFlight) return;                                    // a prior tick's fan-out is still running (slow wsl pipe) — skip rather than pile up overlapping git fetches
  _pollLiveInFlight = true;
  try {
    const targets = workspaces.filter((w) => w && w.kind === 'repo' && (w.id === activeWsId || isWsExpanded(w.id))).map((w) => w.id);
    const now = Date.now() / 1000;
    let activeOk = true;                                            // did the ACTIVE ws fetch succeed? (reconcileJoinedTabs only acts on the active ws, so that's the freshness signal it needs)
    const fetched = new Map();
    await Promise.all(targets.map(async (wsId) => {
      let peers = null;
      try { peers = await claudible.livePeers(wsId); }
      catch (e) { if (wsId === activeWsId) activeOk = false; return; }   // fetch failed → keep this ws's LAST-KNOWN bucket below (a blip must not drop live rows)
      peers = (peers || []).filter((p) => p && p.session && p.url && p.token && (now - (p.ts || 0) < LIVE_TTL_S));
      peers.forEach((p) => { p.wsId = wsId; });                     // STAMP with the ws it was FETCHED for — immune to an active-project switch mid-fetch (we bucket by request, not by ambient active)
      fetched.set(wsId, peers);
    }));
    // Rebuild the cache to exactly the currently-visible repos. A target we failed to fetch this round keeps its
    // previous bucket (don't flap a live row on a transient error); a project no longer visible simply drops out.
    const next = new Map();
    for (const wsId of targets) next.set(wsId, fetched.has(wsId) ? fetched.get(wsId) : (livePeersByWs.get(wsId) || []));
    livePeersByWs = next;
    // Self-clean the socket-proved-dead set: drop a suppression once git presence ALSO no longer lists the session
    // (git caught up — the normal, fast path), OR after DEAD_SUPPRESS_MS as a guaranteed exit so a session re-hosted
    // with the same handle (which git never drops, and whose re-arm skips setLiveState) can't stay hidden forever.
    if (deadPeerSessions.size) {
      const live = new Set(); next.forEach((ps) => ps.forEach((p) => live.add(p.session)));
      const nowMs = Date.now();
      [...deadPeerSessions].forEach(([sid, at]) => { if (!live.has(sid) || nowMs - at > DEAD_SUPPRESS_MS) deadPeerSessions.delete(sid); });
    }
    // The sig deliberately EXCLUDES p.ts: the host's advertise heartbeat re-stamps ts every ~45s with nothing
    // else changing, and a ts-sensitive sig forced a full refreshExpandedTrees() rebuild on every beat —
    // restarting the live/busy-dot keyframe animations in every expanded project (a metronome flicker).
    // url+token ARE included: a host handle rotation must still change the sig so reconcileJoinedTabs re-arms
    // joined tabs (the auto-recover path); membership changes (TTL age-out) change the sig by themselves.
    const sig = JSON.stringify([...next.entries()].sort().map(([ws, ps]) => [ws, ps.map((p) => [p.session, p.login, p.url, p.token, !!sessIndex[p.session], deadPeerSessions.has(p.session)]).sort()]));
    if (sig === livePeersSig) return;
    livePeersSig = sig; refreshSessions(); refreshExpandedTrees(); reconcileJoinedTabs(activeOk);   // repaint the active list AND every expanded tree · re-arm/auto-leave joined tabs
  } finally { _pollLiveInFlight = false; }
}
setInterval(pollLivePeers, 10000);
// Poll the workspace-shared session names (repo workspaces only). Throttled so the list render that calls it
// can't spam branch reads; a forced call (after my own rename's push) bypasses the throttle. Re-render on change.
async function pollTitles(force) {
  const myWs = activeWsId;                                                         // capture: a workspace switch mid-fetch must not write this result under the wrong ws
  const aw = workspaces.find((w) => w.id === myWs);
  if (!(aw && aw.kind === 'repo')) { remoteTitles = {}; titlesSig = ''; return; }
  const now = Date.now();
  if (!force && now - lastTitlePoll < 15000) return;
  lastTitlePoll = now;
  let m = {}; try { m = await claudible.titleList(myWs); } catch (e) {}            // explicit ws: while a joined live tab is on screen main's active ws is a DIFFERENT (often non-repo) ws — the ambient read returned {} and wiped this repo's warm name cache
  if (myWs !== activeWsId) return;                                                 // switched workspaces during the async read → this result is stale
  if (!m || typeof m !== 'object') m = {};
  const sig = JSON.stringify(Object.entries(m).sort());
  if (sig === titlesSig) return;
  titlesSig = sig; remoteTitles = m;
  try { const c = Object.assign({}, loadPrefs().remoteTitlesCache || {}); c[myWs] = m; savePrefs({ remoteTitlesCache: c }); } catch (e) {}   // warm cache → next open shows these shared names instantly (sessTitle reads it before pollTitles lands)
  // GLOBAL newest-wins reconcile: a collaborator's NEWER rename (branch ts beats my local rename's ts)
  // replaces my local override, so every machine converges on the same name — the old behavior kept each
  // machine's own rename forever, letting two machines permanently disagree.
  try {
    const p = loadPrefs();
    const lt = Object.assign({}, p.sessionTitles || {});
    const lts = Object.assign({}, p.sessionTitleTs || {});
    let changed = false;
    for (const id in m) {
      const nv = titleVal(m[id]), nts = titleTs(m[id]);
      if (nv && lt[id] && lt[id] !== nv && (Number(lts[id]) || 0) < nts) { lt[id] = nv; lts[id] = nts; changed = true; }
    }
    if (changed) saveSessionTitles(lt, lts);
    // INVERSE reconcile — self-healing publish. If MY rename is strictly NEWER than what the branch holds
    // (its title-set push failed, or happened offline), re-publish it so collaborators converge on it instead
    // of silently keeping the stale shared name forever. Guards: only ids that belong to THIS workspace's
    // session list (sessionTitles is a global map — never leak another ws's name onto this branch; the
    // sessIndexWs tag closes the switch window where activeWsId already flipped but sessIndex still holds
    // the previous workspace's rows), only renames older than 60s (a just-committed rename's own push is
    // still in flight — don't double-push), and at most one id per poll pass (a permanently-failing push
    // must not spam git every 20s).
    for (const id in lt) {
      if (sessIndexWs !== myWs) break;
      if (!sessIndex[id]) continue;
      const localTs = Number(lts[id]) || 0;
      if (!localTs || now - localTs < 60000) continue;
      if (titleVal(m[id]) === lt[id]) continue;                       // branch already agrees
      if (localTs > titleTs(m[id])) {
        try { claudible.titleSet(id, lt[id], myWs).catch(() => {}); } catch (e) {}
        break;
      }
    }
  } catch (e) {}
  refreshSessions();
}
setInterval(pollTitles, 20000);
function makeLiveBadge(peer, localLabel) {
  const who = peer.name || peer.login || 'host';
  const b = document.createElement('button'); b.className = 'sess-live-ind sess-join';
  const dot = document.createElement('span'); dot.className = 'live-dot';
  const liw = document.createElement('span'); liw.className = 'liw'; liw.textContent = 'live · ' + who;
  const jx = document.createElement('span'); jx.className = 'joinx'; jx.textContent = 'Join →';   // revealed on row hover
  b.appendChild(dot); b.appendChild(liw); b.appendChild(jx);
  b.title = 'Join ' + who + '’s live session — co-drive it right here';
  b.addEventListener('click', (e) => { e.stopPropagation(); openLiveTab(peer, localLabel); });   // native, in this same window — carry the clicked row's label
  return b;
}
// (removed: the ⤢ "open in a separate window" fallback — joining is always native, in this same window)
// a collaborator is live in a session we don't have locally yet → a joinable row of its own
function renderLivePeerRow(peer) {
  const row = document.createElement('div'); row.className = 'sess sess-peer-live';
  const p = document.createElement('div'); p.className = 'sess-prev'; p.textContent = 'Live session';
  const m = document.createElement('div'); m.className = 'sess-meta';
  const mt = document.createElement('span'); mt.className = 'sess-meta-t'; mt.textContent = (peer.name || peer.login || 'a collaborator') + ' is live now';
  m.appendChild(mt); m.appendChild(makeLiveBadge(peer));
  row.appendChild(p); row.appendChild(m);
  row.style.cursor = 'pointer';
  row.addEventListener('click', () => openLiveTab(peer));
  return row;
}
// ---- native joined-session tab: render + drive a peer's live session inside the cockpit -----------------
const LIVE_STATE_LABEL = { '': 'live', live: 'live', connecting: 'connecting…', pending: 'waiting for host…', reconnecting: 'reconnecting…', paused: 'paused', denied: 'declined', offline: 'ended' };
// R30: the server's denial/offline reasons are bare wire codes ('full', 'busy', 'removed', 'revoked') and used
// to paint onto the joined row verbatim (" — full"). Map the known codes; anything else — a host-controlled
// string — goes through humanError so a raw code or junk can never render (textContent already escapes it).
const LIVE_REASON = { full: 'the session is full', busy: 'the host is busy right now', removed: 'the host removed you from this session', revoked: 'the host reset the invite link' };
function liveReasonText(c) { const s = String(c == null ? '' : c).trim(); if (!s) return ''; return LIVE_REASON[s] || humanError(s); }
// Sizing: a guest can't resize the host's pty, so we mirror the host's FIXED grid and scale the font to contain
// it in the pane (never a CSS transform — that breaks xterm's char metrics + text selection).
// ONE scaling rule for every FIXED-GRID view: find the largest font whose whole cols×rows grid fits this
// viewer's container, zoom the VIEW, never touch the grid — "same video, your own zoom". Used by joined
// mirrors (the host's grid) and, while a share runs, by the HOST's own shared tab (the pinned grid).
function scaleTermToGrid(rec, cols, rows) {
  if (!rec || !rec.container) return;
  const cs = getComputedStyle(rec.container);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const pw = rec.container.clientWidth - padX, ph = rec.container.clientHeight - padY;
  if (pw <= 0 || ph <= 0) return;
  const wFont = pw / (cols * 0.6), hFont = ph / (rows * 1.18);       // largest font whose whole grid still fits
  const fs = Math.max(6, Math.min(30, Math.floor(Math.min(wFont, hFont))));
  try { if (rec.term.options.fontSize !== fs) rec.term.options.fontSize = fs; } catch {}
  try { if (rec.term.cols !== cols || rec.term.rows !== rows) rec.term.resize(cols, rows); } catch {}
}
function fitLiveTab(rec) {
  if (!rec || rec.kind !== 'live' || !rec.container) return;
  scaleTermToGrid(rec, rec.hostCols || 120, rec.hostRows || 32);
}
// Per-tab overlay for the non-streaming states (connecting / waiting / reconnecting / paused / declined / offline).
function setLiveState(rec, state, detail) {
  if (state === 'offline' || state === 'reconnecting' || state === 'denied') rec.liveWasLost = true;   // R27: a fresh hello after any loss re-arms the voice room
  if (!rec || rec.kind !== 'live') return;
  rec.liveState = state || '';
  rec.liveReason = detail || rec.liveReason || '';
  // INSTANT SIGNAL (Fix 3): the joined tab's own socket knows the host ended ~1-2s after it happens — long before
  // the ~10s git-presence poll / TTL. When it settles to 'offline', suppress that session from the sidebar badge
  // NOW so a joined guest doesn't keep seeing "● LIVE" on a session they can see is over. Re-joining (connecting/
  // live) lifts the suppression. pollLivePeers self-cleans the set once git presence agrees the host is gone.
  const sid = rec.peer && rec.peer.session;
  if (sid) {
    const was = deadPeerSessions.has(sid);
    if (rec.liveState === 'offline') deadPeerSessions.set(sid, Date.now());
    else if (rec.liveState === 'connecting' || rec.liveState === 'live' || rec.liveState === '') deadPeerSessions.delete(sid);
    if (deadPeerSessions.has(sid) !== was) { try { livePeersSig = ''; refreshSessions(); refreshExpandedTrees(); } catch (e) {} }   // force the badge to recompute through peersForWs on the next paint
  }
  const meta = document.querySelector('[data-livetab="' + rec.tabId + '"] .sess-meta');
  if (meta) {   // build via text nodes — rec.liveReason is a host-controlled ('denied') string; textContent escapes it (CSP is not the only XSS guard)
    meta.textContent = '';
    const dot = document.createElement('span'); dot.className = 'sess-livedot'; meta.appendChild(dot);
    const reason = ((rec.liveState === 'offline' || rec.liveState === 'denied') && rec.liveReason) ? ' — ' + liveReasonText(rec.liveReason) : '';   // R30: wire codes become sentences
    meta.appendChild(document.createTextNode('joined · ' + (LIVE_STATE_LABEL[rec.liveState] || 'live') + reason));
  }
  let ov = rec.container.querySelector('.live-ov');
  if (!(state && state !== 'live')) { if (ov) ov.classList.remove('show'); return; }
  if (!ov) { ov = document.createElement('div'); ov.className = 'live-ov'; rec.container.appendChild(ov); }
  const who = (rec.peer && (rec.peer.name || rec.peer.login)) || rec.hostName || 'the host';
  ov.textContent = ({
    connecting: 'Connecting to ' + who + '’s live session…',
    pending: 'Waiting for ' + who + ' to let you in…',
    reconnecting: 'Reconnecting…',
    paused: who + ' stepped into a private project — the mirror is paused.',
    denied: 'Connection declined' + (detail ? ' (' + detail + ')' : '') + '.',
    offline: 'This live session is unavailable — it may have ended.',
  })[state] || state;
  ov.classList.toggle('bad', state === 'denied' || state === 'offline');
  ov.classList.add('show');
}
// The joined tab's tracker shows the HOST's pre-formatted ctx%/cost/tokens (there's no local pty to compute from).
function repaintLiveTracker(rec) {
  if (!rec) return;
  const pct = rec.curCtxPct, bar = $('trk-ctxbar');
  if (typeof pct === 'number') {
    $('trk-ctx').textContent = pct + '%';
    paintCtxSegs(pct);
    bar.classList.toggle('warn', pct >= 70 && pct < 85);
    bar.classList.toggle('crit', pct >= 85);
    bar.title = 'host context window used';
  } else {
    $('trk-ctx').textContent = '—'; paintCtxSegs(null);
    bar.classList.remove('warn', 'crit'); bar.title = 'host context window used';
  }
  $('trk-cost').textContent = rec.liveCost != null ? rec.liveCost : '$0.00'; $('trk-cost').title = 'host session cost';
  if (bar) bar.title = bar.title + ' · ' + $('trk-cost').textContent + ' host session cost';
  const lt = rec.liveTokens != null ? rec.liveTokens : '0', tokEl = $('trk-tokens');
  tokEl.textContent = lt; tokEl.style.color = tokenHue(parseTokCount(lt)); tokEl.title = 'host session tokens';
}
// Open (or focus) a peer's live session as a native tab in THIS window.
function openLiveTab(peer, localLabel) {
 try {
  if (!peer) return;
  for (const r of tabs.values()) {
    if (r.kind === 'live' && r.peer && r.peer.session === peer.session) {
      setActiveTab(r.tabId);
      if (r.liveState === 'offline' || r.liveState === 'denied') {   // the mirror had dropped → RE-ARM it (refresh the handle + reconnect) instead of focusing a dead tab
        r.peer = peer; setLiveState(r, 'connecting'); refreshSessions();
        claudible.liveConnect(r.tabId, peer, collabName())
          .then((res) => { if (!res || !res.ok) { setLiveState(r, 'offline'); toast('Could not rejoin: ' + humanError(res && res.error)); } })
          .catch((err) => { console.error('[live] reconnect rejected:', err); setLiveState(r, 'offline'); });
      }
      return;   // already joined → focus it (and reconnect above if it had gone offline/denied)
    }
  }
  if (tabs.size >= MAX_TABS) { toast('Tab limit reached (' + MAX_TABS + ')'); return; }
  const id = newTabId();
  const who = peer.name || peer.login || 'collaborator';
  const rec = makeTab(id, null, '', { kind: 'live', peer });
  // The workspace whose presence branch this host was discovered on — the ONLY one whose peer list can speak
  // about them (see reconcileJoinedTabs). Take it from the PEER, not from ambient activeWsId: a peer clicked
  // from a stale row would otherwise be stamped with whatever project happened to be on screen, permanently
  // pinning the joined tab to the wrong project. peersForWs() makes such a row unrenderable; this makes the
  // stamp correct even if one is reached another way (a badge click racing a switch).
  rec.peerWsId = peer.wsId || activeWsId;
  rec.label = 'Live · ' + who; rec.curSessionLabel = 'Live · ' + who; rec.hostName = who;
  rec.joinedAsLabel = localLabel || '';                              // name the joined tab after the row you clicked, until the host broadcasts its own session name
  setActiveTab(id);
  setLiveState(rec, 'connecting');
  refreshSessions();                                                 // surface the joined-tab row immediately
  refreshExpandedTrees();                                            // …and stand its saved copy down in its home project's tree in the same paint (the cross-project duplicate)
  claudible.liveConnect(id, peer, collabName()).then((r) => {
    if (!r || !r.ok) {
      // DON'T closeTab here — a vanishing tab leaves the guest with no ✕ to leave and no idea why (exactly the bug
      // report). Keep the joined row in an offline state (renderJoinedTabRow always gives it a ✕ Leave) and explain.
      // A synchronous 'bad handle' means the advertised URL/token was unusable — almost always a dead/expired tunnel
      // or a host↔guest build skew; the diagnostic '[live] connect' log on the host side pins down which.
      setLiveState(rec, 'offline');
      const why = humanError(r && r.error);
      toast('Could not join ' + who + ' — ' + why + ((r && r.error === 'bad handle') ? '. The link may be expired, or you and the host are on different app versions — make sure both are on the latest build and retry.' : ''));
    }
  }).catch((err) => { console.error('[live] liveConnect rejected:', err); setLiveState(rec, 'offline'); toast('Could not join ' + who + ' — connection failed'); });
 } catch (e) { console.error('[live] openLiveTab THREW:', e && (e.stack || e.message || e)); toast('Join failed: ' + humanError(e && e.message)); }   // R16: the raw JS exception goes to the console; the user gets a sentence
}
// A joined live session as a sidebar row (pinned at the top): click to switch, ✕ to leave.
function renderJoinedTabRow(rec) {
  const row = document.createElement('div');
  row.className = 'sess sess-joined-live' + (rec.tabId === activeTabId ? ' active' : '');
  row.dataset.livetab = rec.tabId; row.setAttribute('role', 'button'); row.tabIndex = 0;
  const who = (rec.peer && (rec.peer.name || rec.peer.login)) || rec.hostName || 'collaborator';
  const sessName = rec.liveSessName || '';                                          // host's real current session name (once reported), else a host-name placeholder
  const p = document.createElement('div'); p.className = 'sess-prev'; p.textContent = '● ' + (sessName || rec.joinedAsLabel || (who + '’s session'));
  const m = document.createElement('div'); m.className = 'sess-meta';   // who (peer name) + rec.liveReason are host-controlled → build via text nodes so they're escaped (CSP is not the only XSS guard)
  const mdot = document.createElement('span'); mdot.className = 'sess-livedot'; m.appendChild(mdot);
  if (rec.sessMismatch) m.appendChild(document.createTextNode('⚠ host moved to another session · ' + who));
  else {
    const reason = ((rec.liveState === 'offline' || rec.liveState === 'denied') && rec.liveReason) ? ' — ' + liveReasonText(rec.liveReason) : '';   // R30: wire codes become sentences
    m.appendChild(document.createTextNode('joined · ' + who + ' · ' + (LIVE_STATE_LABEL[rec.liveState] || 'live') + (rec.liveReadOnly ? ' · view-only' : '') + reason));   // R26
  }
  row.appendChild(p); row.appendChild(m);
  // R14: a dead mirror had NO rejoin affordance — the row offered only focus and ✕ Leave, so a guest whose
  // reconnect budget ran out had to leave and re-find the Join badge (which needs live presence). ↻ re-dials:
  // freshest handle from presence when the host re-shared (new url/token), else the last known one.
  if (rec.liveState === 'offline' || rec.liveState === 'denied') {
    const rb = document.createElement('button');
    rb.className = 'sess-menu-btn'; rb.title = 'Reconnect to this live session'; rb.setAttribute('aria-label', 'Reconnect to live session');
    rb.textContent = '↻';
    rb.addEventListener('click', (e) => {
      e.stopPropagation();
      const fresh = peersForWs(rec.peerWsId).find((p2) => p2.session === (rec.peer && rec.peer.session) && p2.url && p2.token);
      if (fresh) rec.peer = fresh;
      setLiveState(rec, 'connecting'); refreshSessions();
      claudible.liveConnect(rec.tabId, rec.peer, collabName())
        .then((res) => { if (!res || !res.ok) { setLiveState(rec, 'offline'); toast('Could not reconnect: ' + humanError(res && res.error)); } })
        .catch(() => setLiveState(rec, 'offline'));
    });
    row.appendChild(rb);
  }
  const xb = document.createElement('button');
  xb.className = 'sess-menu-btn'; xb.title = 'Leave this live session'; xb.setAttribute('aria-label', 'Leave live session');
  xb.textContent = '✕';
  xb.addEventListener('click', (e) => { e.stopPropagation(); closeTab(rec.tabId); });
  row.appendChild(xb);
  row.addEventListener('click', (e) => { if (e.target.closest('button')) return; setActiveTab(rec.tabId); });
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); setActiveTab(rec.tabId); } });
  return row;
}
// ---- live-session IPC: bytes/control from the peer (relayed by main's client WebSocket) ----------------
claudible.onLiveData((tabId, data) => {
  const rec = tabs.get(tabId); if (!rec || rec.kind !== 'live') return;
  const u8 = (data instanceof Uint8Array) ? data : (data && data.buffer ? new Uint8Array(data.buffer) : new Uint8Array(data || []));
  const b = rec.term.buffer.active, wasBottom = b.viewportY >= b.baseY;
  rec.term.write(u8, () => { if (tabId === activeTabId) { if (wasBottom) rec.term.scrollToBottom(); updateScrollbar(); } });
});
claudible.onLiveHello((p) => {
  const rec = tabs.get(p.tabId); if (!rec || rec.kind !== 'live') return;
  rec.liveReadOnly = !!p.readOnly; rec.hostCols = p.cols || rec.hostCols; rec.hostRows = p.rows || rec.hostRows;
  rec.livePid = p.pid || null; if (p.host) rec.hostName = p.host;
  if (p.skew && p.skew.host) { rec.buildSkew = p.skew; toast('Heads up: the host runs Claudible ' + p.skew.host + ', you run ' + p.skew.mine + ' — if this live session misbehaves, update whichever side is older'); }   // main sanitized both strings
  if (p.you) rec.liveYou = p.you;                                   // the name the host's server registered us under (may be disambiguated, e.g. "MK (2)") — used to dedup ourselves out of the roster below
  // R26: a read-only mirror looked identical to a co-drive one — keys were silently refused with zero cue.
  // Say it once per tab, and the row's meta line carries it permanently (renderJoinedTabRow below).
  if (rec.liveReadOnly && !rec.roToldOnce) { rec.roToldOnce = true; toast('View-only — the host shared a watch link, so typing is off'); refreshSessions(); }
  // R27: a HARD reconnect (main re-dialed the socket) tore down the server side of the voice room while this
  // renderer still believed it was joined — the mic button said joined, no audio flowed. Re-arm on the fresh
  // hello: leave clears the stale local state, join re-registers on the new socket.
  if (liveVoiceTabId === p.tabId && rec.liveWasLost) { try { liveVoice.leave(); liveVoice.join().catch(() => {}); } catch {} }
  rec.liveWasLost = false;
  setLiveState(rec, p.paused ? 'paused' : 'live');
  if (p.tabId === activeTabId) { fitLiveTab(rec); refreshCollabSurfaces(); if (!rec.liveReadOnly) { try { rec.term.focus(); } catch {} } }
});
claudible.onLiveRoster((p) => {
  const rec = tabs.get(p.tabId); if (!rec || rec.kind !== 'live') return;
  rec.roster = Array.isArray(p.list) ? p.list : [];
  if (activeTabId === p.tabId) { renderRoster(); renderLiveBar(); }
});
claudible.onLiveSize((p) => { const rec = tabs.get(p.tabId); if (rec && rec.kind === 'live') { rec.hostCols = p.cols || rec.hostCols; rec.hostRows = p.rows || rec.hostRows; if (p.tabId === activeTabId) fitLiveTab(rec); } });
claudible.onLivePaused((p) => { const rec = tabs.get(p.tabId); if (rec && rec.kind === 'live') setLiveState(rec, p.paused ? 'paused' : 'live'); });
claudible.onLiveState((p) => { const rec = tabs.get(p.tabId); if (rec && rec.kind === 'live') setLiveState(rec, p.state, p.reason); });
claudible.onLiveStatus((p) => {
  const rec = tabs.get(p.tabId); if (!rec || rec.kind !== 'live') return;
  const s = p.status || {};
  if (typeof s.ctxPct === 'number') rec.curCtxPct = s.ctxPct;
  if (s.cost != null) rec.liveCost = String(s.cost).slice(0, 16);          // host-provided (untrusted) — textContent + length-capped
  if (s.tokens != null) rec.liveTokens = String(s.tokens).slice(0, 16);
  const prevName = rec.liveSessName, prevMismatch = rec.sessMismatch;
  if (s.session != null && s.session) { rec.liveSessName = String(s.session).slice(0, 80); rec.curSessionLabel = 'Live · ' + rec.liveSessName; }   // the host's ACTUAL current session name → label the joined tab by it, not by the host's name
  if (s.sessionId) { rec.liveSessId = String(s.sessionId).slice(0, 64); rec.sessMismatch = !!(rec.peer && rec.peer.session && rec.liveSessId !== rec.peer.session); }   // host is streaming a different session than I clicked Join on → flag it instead of silently mirroring the wrong pty
  if (p.tabId === activeTabId) repaintLiveTracker(rec);
  if (rec.liveSessName !== prevName || rec.sessMismatch !== prevMismatch) refreshSessions();   // reflect the real session name / mismatch on the sidebar row
});
// The "out of sync" / "removed" conflict chips, shared by the active-workspace row (renderSessionRow) AND the
// expanded-tree row (renderWsSessionRow) — the latter previously drew NO chip, so divergence was invisible there.
// For a non-active tree row pass its workspace `w` so a click switches there first (else resolve/delete targets
// the wrong workspace's PROJ). Active rows pass w=null and open the modal directly.
function appendConflictChip(m, s, w) {
  // WHO MADE IT — a quiet blue flair (same family as the amber "out of sync") naming the collaborator who
  // created this session. Only foreign (synced-in) sessions carry s.author, so your own rows stay unpilled.
  // textContent for the name: it's collaborator-controlled and must never be parsed as HTML.
  if (s.author) {
    const ab = document.createElement('span');
    ab.className = 'sess-chip author'; ab.title = 'Session created by ' + s.author;
    ab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
    ab.appendChild(document.createTextNode(String(s.author)));
    m.appendChild(ab);
  }
  const act = (open) => async (e) => { e.stopPropagation(); if (w && w.id !== activeWsId) await switchWorkspace(w.id, s.id); open(s); };   // AWAIT the switch so main's activeWorkspace is re-pointed BEFORE resolve/delete runs (else a fast confirm targets the old workspace's repo)
  if (s.deletedRemote) {                                             // a collaborator deleted this on GitHub → soft red "removed" chip
    const db = document.createElement('button');
    db.className = 'sess-chip removed'; db.title = 'Deleted from GitHub by a collaborator';
    db.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>removed';
    db.addEventListener('click', act(openDeletedRemoteModal)); m.appendChild(db);
  } else if (s.diverged && !sessionIsLive(s.id, w && w.id)) {        // same session edited on both machines → soft amber "diverged" chip. Liveness is checked in THIS row's project: the active bucket knows nothing about a non-active tree's peers (the "OUT OF SYNC on a live session" screenshot)
    // NOT shown while the session is LIVE. Both resolutions are wrong there: "use the shared version" replaces the
    // .jsonl that the host's Claude is appending to this instant (main refuses it outright now), and "keep mine"
    // just silences a flag nobody can act on. Nothing about a live session is out of sync anyway — everyone is
    // watching one pty, byte for byte. The chip comes back the moment the live session ends, with the fork intact.
    const vb = document.createElement('button');
    vb.className = 'sess-chip diverged'; vb.title = 'Out of sync — this conversation was continued on both machines; click to resolve';
    vb.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg>out of sync';
    vb.addEventListener('click', act(openDivergedInfo)); m.appendChild(vb);
  }
}
function renderSessionRow(s) {
  const row = document.createElement('div');
  row.className = 'sess' + (s.id === activeSession ? ' active' : '')
    + (sessionBusyInTab(s.id) ? ' busy' : '') + (sessionNeedsAttention(s.id) ? ' sess-done' : '');   // busy dot + done-pulse survive a full rebuild (they live on the tab record)
  row.dataset.id = s.id; row.setAttribute('role', 'button'); row.tabIndex = 0;
  const p = document.createElement('div'); p.className = 'sess-prev'; p.textContent = sessTitle(s);
  const m = document.createElement('div'); m.className = 'sess-meta';
  const mt = document.createElement('span'); mt.className = 'sess-meta-t';
  mt.textContent = relTime(s.used || s.mtime);   // last-USED time (newest content ts / activation stamp) — raw file mtime lies for collaborator imports (security-aged to 2000) and never moves when a session is merely opened to read
  m.appendChild(mt);
  // live indicator — inline at the right of the meta line (normal flow, so it can never overflow the row)
  if (isSharingSession(s.id)) {
    row.classList.add('sess-live-row');                              // green left accent bar — you're sharing this live
    const lv = document.createElement('span'); lv.className = 'sess-live-ind';
    lv.innerHTML = '<span class="live-dot"></span><span class="liw">Live</span>'; lv.title = 'You are sharing this session live';
    m.appendChild(lv);
  } else {
    const _lp = !joinedTabSessionIds().has(s.id) && peersForWs(activeWsId).find((x) => x.session === s.id);
    if (_lp) { row.classList.add('sess-live-row'); m.appendChild(makeLiveBadge(_lp, sessTitle(s))); }   // a collaborator is live here → green bar + calm dot, "Join" on hover (carry this row's name onto the joined tab). R40: never a Join badge for a session you already joined (belt over the shown-set dedup for the switch-in repaint)
  }
  row.appendChild(p); row.appendChild(m);
  appendConflictChip(m, s, null);                                    // active-workspace row: chip opens the resolve modal directly
  // A single ▾ opens the per-session options menu (Rename / Export / Delete) — mirrors the workspace ▾ menu,
  // so the row stays a clean title with nothing crowding it and no inline confirm strip to overflow.
  const mb = document.createElement('button');
  mb.className = 'sess-menu-btn'; mb.title = 'Session options'; mb.setAttribute('aria-label', 'Session options');
  mb.innerHTML = OPTIONS_SVG;
  mb.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = sessMenuFor === ('s:' + s.id); closeSessMenu();
    if (!wasOpen) openSessMenu(mb, row, savedSessMenuItems(row, p, s), 's:' + s.id);
  });
  row.appendChild(mb);
  row.addEventListener('pointerdown', (e) => onSessPointerDown(e, row, s));
  row.addEventListener('pointermove', onSessPointerMove);
  row.addEventListener('pointerup', onSessPointerUp);
  row.addEventListener('pointercancel', onSessPointerUp);
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); openSession(s.id, sessTitle(s)); } });
  return row;
}
// Visible ✓/✗ for an inline rename input. Without it the only ways to finish are Enter/Esc/blur, which leaves the
// row feeling "stuck" (the ▾ is hidden during edit). The buttons bind on `mousedown` + e.preventDefault() — NOT
// `click` — so they fire BEFORE the input's blur→commit(true): otherwise the auto-save-on-blur beats ✗ and cancel
// could never win. Returns the wrapper so commit() can remove it alongside the input.
function addRenameControls(inp, commit) {
  const wrap = document.createElement('span'); wrap.className = 'sess-rename-actions';
  const mk = (txt, save, cls, title) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'sess-rename-btn ' + cls;
    b.textContent = txt; b.title = title; b.tabIndex = -1;
    // Robust delivery: pointerdown fires earliest (before blur), mousedown + click are belt-and-suspenders so a
    // commit lands no matter which event the platform delivers. preventDefault keeps focus on the input so a
    // blur→commit(true) can never beat a ✗; the done-guard makes the duplicate triggers harmless no-ops.
    const fire = (e) => { try { e.preventDefault(); } catch {} e.stopPropagation(); commit(save); };
    b.addEventListener('pointerdown', fire);
    b.addEventListener('mousedown', fire);
    b.addEventListener('click', fire);
    return b;
  };
  wrap.appendChild(mk('✓', true, 'ok', 'Save (Enter)'));
  wrap.appendChild(mk('✗', false, 'no', 'Cancel (Esc)'));
  inp.insertAdjacentElement('afterend', wrap);
  // Re-assert focus next tick: opening the row's ▾ menu (and closing it) can steal focus, and without focus on the
  // input, Enter falls through to the row's keydown (which SWITCHES sessions) instead of committing the rename.
  setTimeout(() => { try { if (document.body.contains(inp) && document.activeElement !== inp) inp.focus(); } catch {} }, 0);
  return wrap;
}
// Inline rename: pencil → editable input in place of the title; Enter/blur saves, Esc cancels. Stored in prefs.
function startSessEdit(row, p, s) {
  if (row.querySelector('.sess-rename')) return;
  row.classList.add('renaming');                                      // hide the ▾ so nothing floats over the input
  const inp = document.createElement('input');
  inp.className = 'sess-rename'; inp.type = 'text'; inp.maxLength = 200; inp.value = sessTitle(s);
  p.style.display = 'none'; row.insertBefore(inp, p);
  inp.focus(); inp.select();
  let done = false; let actions = null;
  const commit = (save) => {
    if (done) return; done = true;
    try {
      if (save) {
        const t = inp.value.trim();
        const _pp = loadPrefs();
        const titles = Object.assign({}, _pp.sessionTitles || {});   // COPY first → mutable (loadPrefs is deep-cloned now, but never mutate the cached map in place)
        const tstamps = Object.assign({}, _pp.sessionTitleTs || {});
        const _now = Date.now();
        if (t && t !== s.preview) { titles[s.id] = t; tstamps[s.id] = _now; } else { delete titles[s.id]; delete tstamps[s.id]; }   // blank or == auto preview → clear override; the ts makes global newest-wins comparable
        saveSessionTitles(titles, tstamps);
        // In a repo project, publish the name so EVERY collaborator sees it (GLOBAL newest-wins by ts on the branch).
        // Optimistically reflect it locally so the row updates instantly; a forced poll reconciles after the push.
        const _aw = workspaces.find((w) => w.id === activeWsId);
        if (_aw && _aw.kind === 'repo') {
          const shared = (t && t !== s.preview) ? t : '';
          if (shared) remoteTitles[s.id] = { n: shared, ts: _now }; else delete remoteTitles[s.id];
          try { claudible.titleSet(s.id, shared, activeWsId).then((r) => { if (r && r.ok === false) toast('Renamed here — sharing the name failed, will keep retrying'); pollTitles(true); }).catch(() => {}); } catch (e) {}   // the renamed row lives under the SIDEBAR's active ws — main's can differ while a joined live tab is on screen. A failed push is no longer silent: the user hears it, and pollTitles' inverse reconcile re-publishes until the branch agrees
        }
        p.textContent = sessTitle(s);
        // keep ANY open tab on this session in sync so the command center + guest tracker also show the new name
        for (const r of tabs.values()) { if (r.session === s.id) { r.label = p.textContent; r.curSessionLabel = p.textContent; } }
        pushTracker();           // mirror the (possibly renamed live-session) title to guests — no-arg targets the mirrored tab, so a backgrounded shared session's rename still lands
      }
    } catch (e) { console.error('[rename] save failed', e); }
    finally {                                                        // cleanup ALWAYS runs — a throw above can never strand the input again
      try { inp.remove(); } catch {} try { actions && actions.remove(); } catch {} p.style.display = ''; row.classList.remove('renaming');
      try { refreshSessions(); } catch {}                            // reconcile any list change deferred while the rename was open
    }
  };
  inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); commit(true); } else if (e.key === 'Escape') { e.preventDefault(); commit(false); } });
  inp.addEventListener('blur', () => commit(true));
  inp.addEventListener('pointerdown', (e) => e.stopPropagation());   // don't start a row drag / open
  inp.addEventListener('click', (e) => e.stopPropagation());
  actions = addRenameControls(inp, commit);                          // visible ✓/✗ confirm/cancel
}
// ---- per-session options (▾) menu: Rename / Export / Delete live here so each row stays a clean title ----
// Mirrors the workspace ▾ menu (same .ws-menu look) and, like the workspace delete, confirms via the native
// dialog — so there's no inline confirm strip to overflow the narrow row.
function doExportSession(s) {
  claudible.exportSession(s.id, activeWsId).then((r) => {   // the row's workspace — main's active ws can differ while a joined live tab is on screen
    if (r && r.saved) toast('Replay saved · ' + r.saved.replace(/^.*[\\/]/, ''));
    else if (r && r.canceled) { /* user dismissed the save dialog */ }
    else toast(r && r.error === 'empty' ? 'Nothing to export in this session yet' : 'Export failed');
  }).catch(() => toast('Export failed'));
}
function doExportSessionText(s) {
  claudible.exportSessionText(s.id, activeWsId).then((r) => {
    if (r && r.saved) toast('Saved · ' + r.saved.replace(/^.*[\\/]/, ''));
    else if (r && r.canceled) { /* user dismissed the save dialog */ }
    else toast(r && r.error === 'empty' ? 'Nothing to export in this session yet' : 'Export failed');
  }).catch(() => toast('Export failed'));
}
function savedSessMenuItems(row, p, s) {
  const aw = workspaces.find((w) => w.id === activeWsId);
  const synced = !!(aw && aw.kind === 'repo');                       // a shared/repo session may also live on GitHub
  const items = [
    { icon: PENCIL_SVG, label: 'Rename', hint: 'Rename this session (local label only).', act: () => startSessEdit(row, p, s) },
  ];
  // Live collaboration (repo workspaces only): explicit Share toggle + Join when a peer is hosting this session.
  if (aw && aw.kind === 'repo') {
    items.push({ icon: SHARE_SVG, label: isSharingSession(s.id) ? 'Stop sharing' : 'Share live',
      hint: isSharingSession(s.id) ? 'End the live session — everyone viewing is disconnected.' : 'Share this session live so a collaborator can Join and co-drive it.',
      act: () => toggleShareSession(s) });
    const peer = peersForWs(activeWsId).find((x) => x.session === s.id);
    if (peer && !isSharingSession(s.id)) items.push({ icon: SHARE_SVG, label: 'Join live · ' + (peer.name || peer.login || 'host'),
      hint: 'Join this collaborator’s live session and co-drive it.', act: () => openLiveTab(peer) });
  }
  items.push(
    { icon: SHARE_SVG, label: 'Export replay…', hint: 'Save this session as a shareable HTML replay.', act: () => doExportSession(s) },
    { icon: SHARE_SVG, label: 'Save as text…', hint: 'Save this session transcript as Markdown (.md/.txt).', act: () => doExportSessionText(s) },
    { sep: true }
  );
  if (synced) {                                                      // a synced session can be removed locally or for everyone
    items.push({ icon: TRASH_SVG, label: 'Delete for me', hint: 'Remove from this machine (may sync back from GitHub).',
      act: () => { if (confirm('Delete “' + sessTitle(s) + '” from this machine?\nIt may sync back if a collaborator still has it. Moves to ~/.claudible/trash, kept 30 days.')) deleteSession(s.id, 'local'); } });
    items.push({ icon: TRASH_SVG, label: 'Delete everywhere', danger: true, hint: 'Also delete from GitHub for everyone — can’t be undone.',
      act: () => { if (confirm('Delete “' + sessTitle(s) + '” everywhere?\nThis removes it from GitHub for everyone and can’t be undone.')) deleteSession(s.id, 'everywhere'); } });
  } else {
    items.push({ icon: TRASH_SVG, label: 'Delete', danger: true, hint: 'Move to trash — kept 30 days, then swept.',
      act: () => { if (confirm('Delete “' + sessTitle(s) + '”?\nMoves to ~/.claudible/trash, kept 30 days.')) deleteSession(s.id, 'local'); } });
  }
  return items;
}
function liveSessMenuItems(row, p, rec) {
  return [
    { icon: PENCIL_SVG, label: 'Rename', hint: 'Name this live session (until it’s saved).', act: () => startLiveRename(row, p, rec) },
    { sep: true },
    { icon: TRASH_SVG, label: 'Close session', danger: true, hint: 'Close this tab — nothing is saved to delete yet.',
      act: () => { if (tabs.size <= 1) { toast('This is your only open session'); return; } if (confirm('Close this live session?\nIt isn’t saved yet, so closing discards it.')) closeTab(rec.tabId); } },
  ];
}
let sessMenuFor = null;     // key ('s:'+id saved | 't:'+tabId live) of the row whose ▾ menu is open (null = closed)
let sessMenuRow = null;     // the row element, so it can be un-highlighted when the menu closes
function openSessMenu(btn, row, items, key) {
  const m = $('sess-menu'); if (!m) return;
  m.innerHTML = '';
  items.forEach((it) => {
    if (it.sep) { const s = document.createElement('div'); s.className = 'ws-menu-sep'; m.appendChild(s); return; }
    const b = document.createElement('button');
    b.className = 'ctxitem ws-mi' + (it.danger ? ' danger' : '');
    if (it.hint) b.title = it.hint;                          // short hover description of what this action does
    b.innerHTML = '<span class="ws-mi-ic">' + it.icon + '</span><span class="ws-mi-lb"></span>';
    b.querySelector('.ws-mi-lb').textContent = it.label;     // textContent → labels can't inject markup
    b.addEventListener('click', (e) => { e.stopPropagation(); closeSessMenu(); it.act(); });
    m.appendChild(b);
  });
  // Drop down from the ▾, right-aligned to it; flip above if it would overflow the viewport bottom; clamp to screen.
  m.style.display = 'block';
  const r = btn.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = Math.round(Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8))) + 'px';
  m.style.top = (r.bottom + 5 + mh > window.innerHeight - 8 ? Math.max(8, r.top - 5 - mh) : r.bottom + 5) + 'px';
  sessMenuFor = key; sessMenuRow = row; row.classList.add('menu-open');
}
function closeSessMenu() {
  const m = $('sess-menu'); if (m) m.style.display = 'none';
  if (sessMenuRow) { sessMenuRow.classList.remove('menu-open'); sessMenuRow = null; }
  sessMenuFor = null;
}
document.addEventListener('click', (e) => {
  if (sessMenuFor && !e.target.closest('#sess-menu') && !e.target.closest('.sess-menu-btn')) closeSessMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sessMenuFor) closeSessMenu(); });
// pointer-drag reorder with a movement threshold: a plain click opens; a drag past 5px reorders the DOM
// live and persists the new order. A press on the ▾ menu or the rename input never starts a drag or open.
let sdrag = null;
function onSessPointerDown(e, row, s) {
  if (e.button !== 0) return;
  if (e.target.closest('.sess-menu-btn') || e.target.closest('.sess-rename') || e.target.closest('.sess-live-ind') || e.target.closest('.sess-chip') || row.classList.contains('renaming')) return;   // never capture a press on the ▾, rename input, Live/Join pill, or a conflict chip — let those get their own click
  sdrag = { id: s.id, label: sessTitle(s), row, startY: e.clientY, moved: false, pid: e.pointerId };
  try { row.setPointerCapture(e.pointerId); } catch {}
}
function onSessPointerMove(e) {
  if (!sdrag) return;
  if (!sdrag.moved) { if (Math.abs(e.clientY - sdrag.startY) < 5) return; sdrag.moved = true; sdrag.row.classList.add('dragging'); }
  const rows = Array.prototype.slice.call(sessListEl.querySelectorAll('.sess:not(.sess-draft):not(.sess-joined-live):not(.sess-peer-live)')).filter((r) => r !== sdrag.row);   // pinned joined/live-peer rows are not drop targets — they carry no dataset.id, and interleaving them briefly corrupted the persisted order with `undefined`
  let before = null;
  for (let i = 0; i < rows.length; i++) { const r = rows[i].getBoundingClientRect(); if (e.clientY < r.top + r.height / 2) { before = rows[i]; break; } }
  if (before) sessListEl.insertBefore(sdrag.row, before); else sessListEl.appendChild(sdrag.row);
  const sc = $('ws-chips') || sessListEl;                                           // gentle auto-scroll near the edges — the tree (#ws-chips) is the scroll container now, not sess-list
  const lr = sc.getBoundingClientRect();
  if (e.clientY < lr.top + 22) sc.scrollTop -= 10;
  else if (e.clientY > lr.bottom - 22) sc.scrollTop += 10;
}
function onSessPointerUp() {
  if (!sdrag) return;
  const d = sdrag; sdrag = null;
  try { d.row.releasePointerCapture(d.pid); } catch {}
  d.row.classList.remove('dragging');
  if (d.moved) {
    const order = Array.prototype.slice.call(sessListEl.querySelectorAll('.sess:not(.sess-draft):not(.sess-joined-live):not(.sess-peer-live)')).map((r) => r.dataset.id);   // same exclusion as the drop-target list — live rows have no dataset.id
    // R28: a session suppressed by the joined-mirror dedup has NO row in this DOM walk — a drag used to DROP
    // its id from the persisted order entirely, resetting its place the moment its saved row returned. Missing
    // previously-ordered ids re-insert at their old (clamped) positions: a drag reorders only what you can see.
    { const prev = (loadPrefs()[orderKey()] || []); const joined = joinedTabSessionIds();
      prev.forEach((id, i) => { if (joined.has(id) && !order.includes(id)) order.splice(Math.min(i, order.length), 0, id); }); }
    setOrder(order);                                                               // manual order persists (per workspace)
    refreshSessions();                                                             // reconcile: refreshes skipped DURING the drag (the sdrag guard) catch up now
  } else {
    openSession(d.id, d.label);                                                    // plain click → open
  }
}
const deletingIds = new Set();                                                     // hide rows mid-delete so they can't flash back as "fresh"
async function deleteSession(id, scope) {
  if (deletingIds.has(id)) return;
  deletingIds.add(id);
  const myWs = activeWsId;   // the deleted row's workspace, captured NOW — the awaits below (and a joined live tab being on screen) can leave main's active ws pointing elsewhere
  // Any tab resuming this session must switch OFF it BEFORE the file is deleted (else it holds the file
  // open). If an owning tab is BUSY, the switch is refused (never kill a mid-turn Claude) — so the delete
  // itself must ABORT: proceeding would trash the transcript out from under the still-running pty (audit
  // finding). The order list is only persisted once every owning tab has actually left the session.
  const abort = () => {
    deletingIds.delete(id);
    toast('That session is still running — stop it before deleting');
    refreshSessions();
  };
  // Deleting the session you're SHARING ends the share — but ONLY if the delete actually happens. This used to
  // clear sharedSessionId and drop the tunnel right here, before the busy check below: deleting a session while
  // Claude was mid-turn on it disconnected every guest, then aborted with "that session is still running" and
  // deleted nothing. (Worse, `toast` reuses one element, so the "the live session ended" message was overwritten
  // and the host never even saw it.) So: prove the delete can succeed first, tear down last.
  const wasSharedTab = (sharedSessionId === id) ? sharedTabIdR : null;
  // Pre-flight the busy check across every owning tab, before anything is mutated.
  const owners = Array.from(tabs.values()).filter((r) => r.kind !== 'live' && r.wsId === activeWsId && r.session === id);   // a joined mirror is never re-pointed by a local delete (it belongs to the peer's session)
  if (owners.some((r) => r.busy)) return abort();
  // Re-point the SHARED tab LAST. Every abort path above it then leaves the live session completely untouched, and
  // once it succeeds nothing can abort. (respawnPty's busy guard returns before it freezes the mirror, so a refused
  // re-point of the shared tab can't strand guests either.)
  const ordered = owners.filter((r) => r.tabId !== wasSharedTab).concat(owners.filter((r) => r.tabId === wasSharedTab));
  const order = getOrder().filter((x) => x !== id);
  // Park the doomed tab on a session NO OTHER TAB already hosts — since sidebar clicks now open their own tabs,
  // order[0] is frequently already open, and re-pointing onto it would put two tabs on one session (breaking the
  // one-row-per-session invariant markTabBusy relies on). Fall back to a fresh 'new' session.
  // Exclude by SESSION, not by tab identity: a tab bound to `id` is about to be re-pointed anyway (and `id` is
  // already filtered out of `order`), while every OTHER tab's session — the ACTIVE tab's included — is occupied.
  // Keying this on `tabId !== activeTabId` let a BACKGROUND tab get parked onto the active tab's session, putting
  // two live Claudes on one transcript (main has no cross-tab uniqueness check).
  const openElsewhere = new Set(Array.from(tabs.values()).filter((r) => r.kind !== 'live' && r.wsId === activeWsId && r.session !== id).map((r) => r.session));
  const next = order.find((x) => !openElsewhere.has(x)) || 'new';
  for (const rec of ordered) {
    if (rec.busy) return abort();        // a turn may have started during an earlier tab's await
    if (rec.tabId === activeTabId) {
      // MUST re-point THIS tab off the doomed session — opening the next one in a new tab would leave this
      // tab holding the transcript open. So drive main's re-point directly (identical to the background-tab
      // branch below), rather than through openSession, whose default is now "open beside, don't recycle".
      await openSession(next, next === 'new' ? '' : (sessIndex[next] ? sessTitle(sessIndex[next]) : ''), { inPlace: true, endShare: rec.tabId === wasSharedTab });
      const still = tabs.get(rec.tabId);
      if (still && still.session === id) return abort();   // busy race: main refused the re-point (openSession left this tab untouched)
    } else {
      let sw = null; try { sw = await claudible.sessionOpen(rec.tabId, next, rec.tabId === wasSharedTab); } catch {}
      if (!sw || sw.ok === false) return abort();           // main's authoritative busy guard said no — the pty is mid-turn on this session
      rec.session = next; rec.label = '';                   // rebind the record only AFTER a confirmed switch
    }
  }
  // Every owning tab is off the doomed session and nothing can abort from here. NOW end the share: the conversation
  // guests were watching is about to be trashed, and its pinned tab has already been frozen (endShare, above).
  if (sharedSessionId === id) {
    sharedSessionId = null; sharedWsId = null;
    updateCollab(); updateAdvertise(); refreshExpandedTrees();   // ensureTunnel → shareStop: guests are told, tunnel closes
    toast('That session was shared — the live session ended with it');
  }
  setOrder(order);
  let r = null; try { r = await claudible.sessionDelete(id, scope || 'local', myWs); } catch {} finally { deletingIds.delete(id); }
  // Forget the title only once the LOCAL transcript is actually gone (r.ok, or r.localDone for an everywhere
  // delete whose GitHub half failed). If the delete threw or the script failed (r null / {ok:false,error:'exec'}),
  // the session is STILL on disk under this id — wiping its custom name would silently drop back to the auto
  // preview. Mirrors deleteWorkspace(), which already gates forgetWorkspaceCaches on success.
  if (r && (r.ok || r.localDone)) forgetSessionTitle(id);
  if (scope === 'everywhere') { try { toast(r && r.ok ? 'Deleted everywhere' : 'Deleted here — GitHub removal failed, try Sync'); } catch {} }
  refreshSessions();
}
// Lightweight centered choice modal (self-contained; labels/subs are static strings we control). Resolves the
// chosen key, or null on Cancel / backdrop / Esc.
function modalChoice({ title, body, choices }) {
  if (pttCapturing) stopCapture();                                   // a modal cancels any in-progress PTT rebind — else the capture-phase keydown eats the modal's Escape/keys
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.style.cssText = 'position:fixed;inset:0;z-index:10002;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)';   /* above toasts (10001) so a toast can't obscure the modal */
    const box = document.createElement('div');
    box.style.cssText = 'min-width:320px;max-width:440px;padding:20px;border:1px solid var(--hairline);border-radius:14px;background:linear-gradient(180deg,#14171c,#0e1013);box-shadow:0 24px 64px rgba(0,0,0,.6);color:#e7eaef;font-family:inherit';
    const h = document.createElement('div'); h.textContent = title; h.style.cssText = 'font-size:15px;font-weight:650;margin-bottom:8px';
    const bd = document.createElement('div'); bd.textContent = body; bd.style.cssText = 'font-size:12.5px;line-height:1.5;color:#aab2bd;margin-bottom:16px';
    const list = document.createElement('div'); list.style.cssText = 'display:flex;flex-direction:column;gap:8px';
    box.appendChild(h); box.appendChild(bd); box.appendChild(list);
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(null); } };
    const close = (k) => { try { back.remove(); } catch {} document.removeEventListener('keydown', onKey, true); resolve(k); };
    (choices || []).forEach((c) => {
      const b = document.createElement('button'); b.type = 'button';
      const lab = document.createElement('span'); lab.textContent = c.label; lab.style.cssText = 'font-weight:600';
      b.appendChild(lab);
      if (c.sub) { const sb = document.createElement('span'); sb.textContent = c.sub; sb.style.cssText = 'display:block;font-size:10.5px;font-weight:400;color:#8a929d;margin-top:2px'; b.appendChild(sb); }
      const danger = c.danger ? 'border-color:#7a3030;color:#ff8e8e;background:rgba(150,40,40,.12)' : 'border-color:var(--hairline);color:#cfd6df;background:#191c22';
      b.style.cssText = `text-align:left;font:inherit;font-size:12.5px;padding:9px 12px;border:1px solid;border-radius:9px;cursor:pointer;${danger}`;
      b.addEventListener('click', () => close(c.key));
      list.appendChild(b);
    });
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(null); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(back); back.appendChild(box);
  });
}
// Single text-input modal (mirrors modalChoice). Resolves the trimmed value (may be ''), or null on Cancel/Esc/backdrop.
function modalPrompt({ title, body, placeholder, value, ok }) {
  if (pttCapturing) stopCapture();                                   // a modal cancels any in-progress PTT rebind — else the capture-phase keydown eats the modal's Escape/keys
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.style.cssText = 'position:fixed;inset:0;z-index:10002;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)';   /* above toasts (10001) so a toast can't obscure the modal */
    const box = document.createElement('div');
    box.style.cssText = 'min-width:330px;max-width:440px;padding:20px;border:1px solid var(--hairline);border-radius:14px;background:linear-gradient(180deg,#14171c,#0e1013);box-shadow:0 24px 64px rgba(0,0,0,.6);color:#e7eaef;font-family:inherit';
    const h = document.createElement('div'); h.textContent = title; h.style.cssText = 'font-size:15px;font-weight:650;margin-bottom:8px'; box.appendChild(h);
    if (body) { const bd = document.createElement('div'); bd.textContent = body; bd.style.cssText = 'font-size:12.5px;line-height:1.5;color:#aab2bd;margin-bottom:14px'; box.appendChild(bd); }
    const inp = document.createElement('input'); inp.type = 'text'; inp.maxLength = 200; inp.placeholder = placeholder || ''; inp.value = value || '';
    inp.style.cssText = 'width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--hairline);border-radius:9px;background:#0a0b0d;color:#e7eaef;font:inherit;font-size:13px;outline:none;margin-bottom:16px';
    box.appendChild(inp);
    const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
    cancel.style.cssText = 'font:inherit;font-size:12.5px;padding:8px 14px;border:1px solid var(--hairline);border-radius:9px;cursor:pointer;color:#cfd6df;background:#191c22';
    const okb = document.createElement('button'); okb.type = 'button'; okb.textContent = ok || 'OK';
    okb.style.cssText = 'font:inherit;font-size:12.5px;font-weight:600;padding:8px 14px;border:1px solid #3a6b52;border-radius:9px;cursor:pointer;color:#dff3e8;background:rgba(95,180,135,.18)';
    row.appendChild(cancel); row.appendChild(okb); box.appendChild(row);
    const close = (v) => { try { back.remove(); } catch {} document.removeEventListener('keydown', onDocKey, true); resolve(v); try { if (term) term.focus(); } catch {} };
    const onDocKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(null); } };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); close(inp.value.trim()); } else if (e.key === 'Escape') { e.preventDefault(); close(null); } });
    okb.addEventListener('click', () => close(inp.value.trim()));
    cancel.addEventListener('click', () => close(null));
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(null); });
    document.addEventListener('keydown', onDocKey, true);
    document.body.appendChild(back); back.appendChild(box);
    setTimeout(() => { try { inp.focus(); } catch {} }, 30);
  });
}
// A collaborator deleted this session on GitHub — let the user fully delete their local copy or keep it.
async function openDeletedRemoteModal(s) {
  const myWs = activeWsId;   // the row's workspace, captured before the modal await (the user could switch mid-modal)
  const name = sessTitle(s);
  const choice = await modalChoice({
    title: 'Session deleted on GitHub',
    body: 'A collaborator deleted “' + name + '” from the shared project. Your local copy is still here — delete it too, or keep it on this machine?',
    choices: [
      { key: 'delete', label: 'Fully delete', sub: 'Remove it from this machine too. It stays deleted for everyone.', danger: true },
      { key: 'keep', label: 'Keep locally', sub: 'Keep your copy here. It won’t be re-shared, and this alert clears.' },
      { key: 'cancel', label: 'Cancel' },
    ],
  });
  if (choice === 'delete') await deleteSession(s.id, 'local');       // already tombstoned on the branch → just trash the local copy
  else if (choice === 'keep') { try { await claudible.sessionKeep(s.id, myWs); } catch (e) {} refreshSessions(); }
}
// Same session continued on both machines (a true fork). Let the user RESOLVE it, not just read an FYI:
// 'remote' takes the shared copy (safe import_file path), 'local' keeps mine + acks so sync stops re-flagging.
async function openDivergedInfo(s) {
  const myWs = activeWsId;   // the row's workspace, captured before the modal await (the user could switch mid-modal)
  const name = sessTitle(s);
  const choice = await modalChoice({
    title: 'This session is out of sync',
    body: '“' + name + '” was continued on both machines, so your copy and the shared copy differ — they can’t auto-merge. Take the shared version to match your collaborator, or keep your own.',
    choices: [
      { key: 'remote', label: 'Use the shared version', sub: 'Replace your copy with the collaborator’s latest. Your local edits to this session are discarded.' },
      { key: 'local', label: 'Keep mine', sub: 'Keep your copy and stop flagging it. It still won’t match the shared one.' },
      { key: 'cancel', label: 'Cancel' },
    ],
  });
  if (choice !== 'remote' && choice !== 'local') return;
  try {
    const r = await claudible.resolveDiverged(s.id, choice, myWs);
    if (r && r.ok) toast(choice === 'remote' ? 'Took the shared version' : 'Keeping your version');
    else toast('Could not resolve' + (r && r.error ? ': ' + humanError(r.error) : ''));
  } catch (e) { toast('Could not resolve'); }
  refreshSessions();
}
let _sessSig = '';
async function refreshSessions() {
  if (sessListEl && sessListEl.querySelector('.sess-rename')) return;              // a rename input is focused → defer the whole refresh so a background poll can't wipe the in-progress edit; commit() re-runs refreshSessions when done
  if (sdrag && sdrag.moved) return;                                                // a row drag is in progress → defer: a mid-drag rebuild would orphan the dragged row's DOM node and reinsert a stale (pre-refresh) element into the fresh list; onSessPointerUp re-runs refreshSessions
  const myWs = activeWsId;                                                          // ignore this refresh if we switch workspaces mid-flight
  closeSessMenu();                                                                  // a re-render replaces the rows the open ▾ menu was anchored to
  if (!sessListEl.querySelector('.sess')) sessListEl.innerHTML = '<div class="sess-empty">loading…</div>';   // only show the spinner on a cold list (no flash on re-render)
  // Fetch by EXPLICIT workspace id — never "whatever main's active workspace is". The two can differ (a joined
  // live tab moves the sidebar's scope here but deliberately never re-points main), and the ambient fetch painted
  // + cached the OTHER workspace's sessions under this header (the "my local project shows the other repo's
  // sessions" bug, and its poisoned-cache flip-flop on every switch).
  let list = []; try { list = await claudible.sessionListWs(myWs); } catch {}
  if (myWs !== activeWsId) return;                                                  // a newer workspace switch already owns the list
  if (sessListEl && sessListEl.querySelector('.sess-rename')) return;               // a rename opened DURING the await — bail so the rebuild below can't wipe the in-flight edit (the top-of-fn guard only covers renames that existed before the await)
  if (!Array.isArray(list)) {
    // Typed FETCH FAILURE (main marks it {error}) — not an empty project. Painting [] over a populated list
    // was the "all my sessions vanished" bug. Fall back to this ws's warm cache and keep whatever's on
    // screen; the next poll retries. Only a truly cold list (no cache, nothing rendered) shows the notice.
    const cached = _wsSessCache.get(myWs);
    if (cached && Array.isArray(cached.list)) list = cached.list.slice();
    else {
      console.error('[sessions] list failed and no cache — leaving the sidebar as-is:', list && list.error);
      if (sessListEl && !sessListEl.querySelector('.sess')) sessListEl.innerHTML = '<div class="sess-empty">Couldn’t read sessions — retrying…</div>';
      return;
    }
  }
  if (deletingIds.size) list = list.filter((s) => !deletingIds.has(s.id));          // hide rows being deleted
  // Hide promptless stubs ('(empty session)' — fork artifacts / killed boots): clicking one can only re-fail
  // resume (nothing to resume) and mint ANOTHER stub. A stub reappears the moment it gains a real user message.
  // A live/draft tab sitting on a just-created promptless session is deliberately NOT carved back in here: doing
  // that landed the stub's id in savedIds, which then DISQUALIFIED the tab from the draft bucket below and demoted
  // its clean "New session" draft row to an ugly saved "(empty session)" row (the "new project shows an
  // (empty session)" bug). Such a tab renders as its own DRAFT · UNSAVED row via `liveTabs` instead.
  list = list.filter((s) => (s.msgs || 0) > 0 || hasExplicitTitle(s.id));   // a NAMED session always shows — naming is deliberate, stub-hiding is for accidental fork artifacts (the "my new session zzz never appeared for him" bug: it synced fine, this filter ate it)
  _wsSessCache.set(myWs, { list, ts: Date.now() });                                 // warm THIS ws's cache so when it later becomes a non-active expanded ws it paints instantly (no "loading…" flash) — keyed by the SAME id the fetch was scoped to, so it can never hold another workspace's rows
  const savedIds = new Set(list.map((s) => s.id));
  // A live tab gets its OWN sidebar row whenever it isn't ALREADY shown as a saved row — but ONLY for a session
  // the USER explicitly created new: either still pending an id ('new') or born-new and not yet saved (bornNew,
  // set in the onStatus reconcile when a 'new' tab adopts its real id). A switch/resume that momentarily adopts a
  // latest-session id NOT yet in savedIds must NOT flash a phantom "New session" row — that's exactly the glitch
  // where clicking a workspace briefly showed an auto-created session that then vanished. (Boot '' is excluded too.)
  const liveTabs = Array.from(tabs.values()).filter((r) => r.wsId === activeWsId && r.session !== '' && !savedIds.has(r.session) && (r.session === 'new' || r.bornNew));
  // A joined peer's session belongs to the workspace I joined it IN (peerWsId, stamped at join). Filtering only by
  // kind:'live' pinned it atop EVERY project's sidebar forever — the "my brand-new project shows our old live
  // session" bug. Scope it to its origin workspace; the active-tab exception keeps its own pinned row visible while
  // I'm actually viewing that live mirror (its wsId is null, so activeWsId doesn't follow it). A dead/offline joined
  // tab in its origin ws still shows here with its ✕ Leave — that recovery affordance is deliberate.
  const joinedLive = Array.from(tabs.values()).filter((r) => r.kind === 'live' && (r.peerWsId === activeWsId || r.tabId === activeTabId));
  // INVARIANT: the tab you are LOOKING AT always has a sidebar row. A tab can land on a promptless session by a
  // path that isn't "user pressed New": an explicitly-opened session becomes unresumable (a collaborator deleted
  // it) and the pty falls back to a fresh id. onStatus only sets `bornNew` when the tab adopted its id FROM 'new',
  // so such a tab is neither in the saved list (0 messages) nor in the draft bucket — and the active tab silently
  // vanished from the sidebar. Detect it here (before the signature) and render it as the draft row it is.
  const orphanTab = (() => {
    const t = AT();
    if (!t || t.kind === 'live' || t.wsId !== activeWsId) return null;
    const sid = t.session;
    if (!sid || sid === 'new') return null;                          // 'new' already qualifies for liveTabs
    if (savedIds.has(sid)) return null;                              // renders as a saved row
    if (liveTabs.some((r) => r.tabId === t.tabId)) return null;      // renders as a draft row
    return t;
  })();
  if (!list.length && !liveTabs.length && !joinedLive.length && !orphanTab) {
    sessListEl.innerHTML = '<div class="sess-empty">No saved sessions yet. Start working and it’ll show up here.</div>';
    return;
  }
  const ordered = orderedSessionsFor(myWs, list);   // THE one ordering (shared with the pre-fill + the tree)
  setOrder(ordered.map((s) => s.id));               // …and only THIS authoritative pass persists it
  sessIndex = {}; list.forEach((s) => { sessIndex[s.id] = s; }); sessIndexWs = myWs;   // tag whose rows these are (guaranteed == activeWsId here by the guard above)
  // Default highlight must match what session.sh `--continue` resumes — the most-recent conversation
  // (max mtime) — not the top of the stable saved order.
  // Pick a default highlight only when the active tab isn't itself on a brand-new session (don't hijack the
  // highlight to a saved row while the user is sitting in a fresh "New session") — and NEVER while a joined
  // live tab is on screen: it has no local session id (permanently ''), so this guess used to paint the orange
  // you-are-here highlight on whatever unrelated old session had the newest file mtime (the "'bro join' shows
  // as selected" bug). A joined tab's own pinned row already carries the active highlight via dataset.tab.
  if (!activeSession && list.length && !(AT() && (AT().session === 'new' || AT().kind === 'live'))) { const mru = list.slice().sort((a, b) => (b.mtime || 0) - (a.mtime || 0))[0]; activeSession = (mru || ordered[0]).id; }
  const act = sessIndex[activeSession];
  const at = AT();
  if (at && act && !at.curSessionLabel) { at.curSessionLabel = sessTitle(act); pushTracker(); }    // tell guests which session is live — by its SHARED name (sessTitle), not the raw first-prompt preview, so a joiner sees the same title the sidebar shows everywhere (preview-seeding was why MK and a joiner could see two different names for one session)
  // SMOOTH SWITCH: if the session SET (ids/order/titles/chips/live/joined/peers/share) is unchanged and only the
  // highlight differs, re-apply the active/busy/done classes IN PLACE instead of wiping + rebuilding the whole
  // list. This kills the "entire sidebar flickers/reloads on every session click" jank.
  const sig = JSON.stringify({
    ws: activeWsId,
    o: ordered.map((s) => [s.id, sessTitle(s), !!s.deletedRemote, !!s.diverged]),
    j: joinedLive.map((r) => [r.tabId, r.liveState, r.liveSessName || '', !!r.sessMismatch, !!r.busy]),
    lt: liveTabs.map((r) => [r.tabId, r.session, !!r.busy, r.label || '']),
    lp: peersForWs(activeWsId).map((p) => [p.session, p.name || p.login || '']),   // scoped: another project's peers must not invalidate this list's signature
    ot: orphanTab ? [orphanTab.tabId, orphanTab.session, !!orphanTab.busy, orphanTab.label || ''] : null,   // in the sig, else the smooth path would return before ever rendering its row
    sh: sharedSessionId || '',
  });
  if (sig === _sessSig && sessListEl.querySelector('.sess')) {                       // structure unchanged → just move the highlight (no flicker)
    Array.prototype.forEach.call(sessListEl.querySelectorAll('.sess'), (row) => {
      const sid = row.dataset.id, tb = row.dataset.tab, lv = row.dataset.livetab;
      if (sid) { row.classList.toggle('active', sid === activeSession); row.classList.toggle('sess-done', sessionNeedsAttention(sid)); row.classList.toggle('busy', sessionBusyInTab(sid)); }
      if (tb || lv) row.classList.toggle('active', (tb || lv) === activeTabId);
    });
    syncRowFlairs();                                                                // …and reconcile the non-active trees' rails, which this early return would otherwise skip
    updateCollab(); pollTitles(); return;
  }
  _sessSig = sig;
  sessListEl.innerHTML = '';
  // ONE dedup authority: every session id gets EXACTLY ONE row, even when it qualifies for several passes at once.
  // With session-sync ON, a peer's live session is BOTH git-synced to me as a saved row AND joinable as a live
  // mirror — joining it used to render the session twice (the "I see it twice" duplicate). Priority order: the live
  // mirror I actively joined wins (keyed by peer.session = the session I JOINED, not liveSessId, so a host who moved
  // sessions still collapses the right row); the synced saved copy and any live-peer row for that same id are then
  // suppressed. The saved copy returns when I LEAVE (close the joined tab → it drops out of joinedLive → next
  // refreshSessions un-suppresses it). If the host goes OFFLINE the joined row flips to "offline" in place
  // (setLiveState), so I close that dead mirror to bring my saved copy back — one row per session throughout.
  const shown = new Set();
  joinedLive.forEach((rec) => { const sid = rec.peer && rec.peer.session; if (sid) shown.add(sid); sessListEl.appendChild(renderJoinedTabRow(rec)); });   // pinned at the top
  ordered.forEach((s) => { if (shown.has(s.id)) return; shown.add(s.id); sessListEl.appendChild(renderSessionRow(s)); });
  liveTabs.forEach((rec) => { if (rec.session) shown.add(rec.session); sessListEl.appendChild(renderLiveTabRow(rec)); });   // live, not-yet-saved local tabs
  if (orphanTab && !shown.has(orphanTab.session)) { shown.add(orphanTab.session); sessListEl.appendChild(renderLiveTabRow(orphanTab)); }   // the invariant above: never leave the active tab rowless
  peersForWs(activeWsId).forEach((p) => { if (shown.has(p.session)) return; shown.add(p.session); sessListEl.appendChild(renderLivePeerRow(p)); });   // a collaborator live in a session not already shown (folds in the old _localIds check). SCOPED — an unscoped read here painted a repo project's live peer into a LOCAL project's sidebar
  const activeLive = sessListEl.querySelector('.sess.sess-draft.active');             // a just-created session sits at the bottom → bring it into view
  if (activeLive) { try { activeLive.scrollIntoView({ block: 'nearest' }); } catch {} }
  syncRowFlairs();                                                                  // the active list is fresh by construction; this reconciles the non-active trees' busy/done rails
  updateCollab();                                                                   // synced repo session → tunnel up so a peer can Join live (no bottom-left indicator)
  pollTitles();                                                                     // refresh workspace-shared names (throttled inside)
}
// A running, not-yet-saved session (a tab with no transcript on disk yet) rendered as a sidebar row: click to
// switch to it; the ▾ menu renames or CLOSES it (nothing to delete on disk). Mirrors a saved row's look.
// Labeled "draft" (amber), NEVER "live" (blue/green) — "live" is the collab-share vocabulary, and a new
// session flashing "live" for its first turn read as a phantom live-share.
function renderLiveTabRow(rec) {
  const row = document.createElement('div');
  row.className = 'sess sess-draft' + (rec.tabId === activeTabId ? ' active' : '') + (rec.busy ? ' busy' : '');
  row.dataset.tab = rec.tabId; row.setAttribute('role', 'button'); row.tabIndex = 0;
  const p = document.createElement('div'); p.className = 'sess-prev'; p.textContent = rec.label || 'New session';
  const m = document.createElement('div'); m.className = 'sess-meta';
  m.innerHTML = '<span class="sess-draftdot"></span>' + (rec.busy ? 'working…' : 'draft · unsaved');
  row.appendChild(p); row.appendChild(m);
  const mb = document.createElement('button');
  mb.className = 'sess-menu-btn'; mb.title = 'Session options'; mb.setAttribute('aria-label', 'Session options');
  mb.innerHTML = OPTIONS_SVG;
  mb.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = sessMenuFor === ('t:' + rec.tabId); closeSessMenu();
    if (!wasOpen) openSessMenu(mb, row, liveSessMenuItems(row, p, rec), 't:' + rec.tabId);
  });
  row.appendChild(mb);
  row.addEventListener('click', (e) => { if (e.target.closest('button') || e.target.closest('.sess-rename') || row.classList.contains('renaming')) return; setActiveTab(rec.tabId); });
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); setActiveTab(rec.tabId); } });
  return row;
}
// Rename a live (unsaved) session: stored on the tab record's label (mirrors the saved-row rename UX).
function startLiveRename(row, p, rec) {
  if (row.querySelector('.sess-rename')) return;
  row.classList.add('renaming');                                      // hide the ▾ so nothing floats over the input
  const inp = document.createElement('input');
  inp.className = 'sess-rename'; inp.type = 'text'; inp.maxLength = 200; inp.value = rec.label || '';
  p.style.display = 'none'; row.insertBefore(inp, p);
  inp.focus(); inp.select();
  let done = false; let actions = null;
  const commit = (save) => {
    if (done) return; done = true;
    try {
      if (save) {
        rec.label = inp.value.trim() || '';
        rec.pendingTitle = rec.label;                                  // keep the to-persist title in sync so a rename BEFORE the session resolves sticks (and isn't clobbered by the creation-time name)
        p.textContent = rec.label || 'New session';
        if (rec.tabId === activeTabId) { rec.curSessionLabel = p.textContent; pushTracker(); }   // mirror to guests
      }
    } catch (e) { console.error('[rename] save threw', e); }
    finally {                                                        // cleanup ALWAYS runs — a throw above can never strand the input again
      try { inp.remove(); } catch {} try { actions && actions.remove(); } catch {} p.style.display = ''; row.classList.remove('renaming');
      try { refreshSessions(); } catch {}                            // reconcile any list change deferred while the rename was open
    }
  };
  inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); commit(true); } else if (e.key === 'Escape') { e.preventDefault(); commit(false); } });
  inp.addEventListener('blur', () => commit(true));
  inp.addEventListener('pointerdown', (e) => e.stopPropagation());
  inp.addEventListener('click', (e) => e.stopPropagation());
  actions = addRenameControls(inp, commit);                          // visible ✓/✗ confirm/cancel
}
// Cheap in-place busy toggle on a tab's sidebar row (no disk re-read): live row by tab id, or saved row by session id.
function markTabBusy(tabId, busy) {
  const rec = tabs.get(tabId);
  if (rec && sessListEl) {
    const row = tabRow(rec);
    if (row && row.classList.contains('sess-draft')) {   // the draft row's meta line is per-tab text, not a flair
      const meta = row.querySelector('.sess-meta');
      if (meta) meta.innerHTML = '<span class="sess-draftdot"></span>' + (busy ? 'working…' : 'draft · unsaved');
    }
  }
  syncRowFlairs();   // authority: recomputes EVERY row, so a rail can't be orphaned by a closed/re-pointed tab
}
// The workspace a rendered row belongs to. The ACTIVE list (#sess-list) is re-parented INSIDE its project's
// .ws-children, so test it FIRST — otherwise an active row would resolve to its own chip and mean the same thing
// by luck, but a draft/live row (no chip ancestor) would not.
function rowWsId(row) {
  if (sessListEl && sessListEl.contains(row)) return activeWsId;
  const kids = row.closest ? row.closest('.ws-children') : null;
  const chip = kids && kids.previousElementSibling;
  return (chip && chip.dataset && chip.dataset.id) || activeWsId;
}
// THE authority on the state flairs (busy rail / done pulse). PULL, not push: it recomputes every row on screen
// from the tabs Map, so a flair can never outlive the state that caused it.
//
// This is the bug that kept coming back. markTabBusy/markTabAttention PUSH a class onto one row, found via the
// tab's CURRENT session id — so the class is orphaned FOREVER whenever that (tab → row) link breaks:
//   * the busy tab is CLOSED           → markTabBusy bails at `tabs.get(tabId)` and the red rail is never removed
//   * the busy tab is RE-POINTED       → onStatus reassigns rec.session with no busy guard, so tabRow now finds
//                                        the NEW session's row and the OLD row keeps the rail forever
//   * the row wasn't painted yet       → the toggle is a silent no-op and nothing ever retries
// A non-active project's tree is painted once and deliberately never repainted (reconcileWsChips), so an orphan
// there is permanent — which is exactly the "random orange flair on a session that isn't running" report. Nine
// previous fixes deleted RAILS; the rails were right, the state behind them was dead.
//
// Cheap enough to run on every state change: class toggles only — no rebuild, no refetch, no flicker.
// NB: deliberately does NOT touch sess-live-row. Live state also owns a DOM CHILD (the Live pill / Join badge),
// so removing the class alone would strand the badge — live changes go through refreshExpandedTrees() instead.
function syncRowFlairs() {
  if (!bodyEl) return;
  try {
    bodyEl.querySelectorAll('.sess[data-id]').forEach((row) => {          // saved rows — keyed by session id
      const sid = row.dataset.id; if (!sid) return;
      const ws = rowWsId(row);
      row.classList.toggle('busy', sessionBusyInTab(sid, ws));
      row.classList.toggle('sess-done', sessionNeedsAttention(sid, ws));
    });
    bodyEl.querySelectorAll('.sess[data-tab]').forEach((row) => {         // draft rows — no session id yet, keyed by tab
      const rec = tabs.get(row.dataset.tab);
      row.classList.toggle('busy', !!(rec && rec.busy));
      row.classList.toggle('sess-done', !!(rec && rec.attention));
    });
  } catch (e) {}
}
// Repaint every EXPANDED, NON-ACTIVE project's tree. reconcileWsChips deliberately leaves a populated non-active
// tree untouched (anti-flicker), and every share-end path (endLiveNow / toggleShareSession / onAdvertiseLost /
// the already-live rollback / deleteSession) calls only refreshSessions(), which touches ONLY the active list. So
// a row painted while its session was live kept its GREEN rail *and its Live/Join badge* forever — the "stale
// green flair on a session that stopped being live" report. Live-state changes are rare, so a real repaint here
// is cheap, and unlike a class toggle it also removes the badge.
function refreshExpandedTrees() {
  try { workspaces.forEach((w) => { if (w.id !== activeWsId && isWsExpanded(w.id)) refreshWsSubtree(w.id); }); } catch (e) {}
}
// Row locator shared by the busy dot + the done-pulse: a draft row is keyed by tab, a saved row by session id.
function tabRow(rec) {
  if (!rec || !sessListEl) return null;
  let row = sessListEl.querySelector('.sess.sess-draft[data-tab="' + rec.tabId + '"]');
  if (!row && rec.session && rec.session !== 'new') {
    row = sessListEl.querySelector('.sess[data-id="' + rec.session + '"]');
    // …and, for a tab living in a NON-active project, the row inside that project's expanded tree.
    if (!row && bodyEl) { try { row = bodyEl.querySelector('.ws-children .sess[data-id="' + rec.session + '"]'); } catch (e) {} }
  }
  return row;
}
// "Something finished here while you were looking elsewhere" — pulse the session's sidebar row until you open it.
// Args intentionally ignored: every caller sets rec.attention/rec.busy FIRST, and the sweep reads that truth — which
// is the whole point. A push-patch aimed at ONE row strands the flair whenever the row isn't painted or the tab is
// gone; a pull recomputes every row on screen and cannot orphan anything.
function markTabAttention() {
  syncRowFlairs();
}
// Clear the pulse when the user actually looks at that session (called from setActiveTab).
function clearTabAttention(tabId) {
  const rec = tabs.get(tabId); if (!rec) return;
  rec.attention = false;
  markTabAttention(tabId, false);   // unconditional: refreshSessions can bail (rename/drag in progress) and leave the pulse stuck on
}
// The sidebar is DOCKED (a left column of .body) — toggling .with-sessions slides the layout, it
// never covers the terminal/chat. The terminal auto-refits via its ResizeObserver when the column changes.
function openSidebar(open) {
  bodyEl.classList.toggle('with-sessions', open);
  if (open) { refreshWorkspaces(); refreshSessions(); }
}
// Open an EXISTING session in its own new tab. Deliberately NOT newBlankTab's `name` param: that also sets
// pendingTitle, which must never be used for a saved session — if Claude can't resume it and falls back to a
// fresh conversation, onStatus would persist THIS session's title onto that fallback. Display labels only.
// Returns false when the tab cap is hit, so callers can degrade instead of silently doing nothing.
// Free ONE tab slot by closing the least valuable background tab, or return false if none is safe to touch.
//
// Why this exists: every session you click opens its OWN tab (sessions behave like browser tabs) and nothing ever
// reclaims an idle one, so the 8-tab cap is easy to reach just by browsing. At the cap there were THREE paths and
// only ONE could recover — openSession recycled *the tab you are on*. That is exactly the tab a JOINED GUEST can
// never recycle: a live mirror is immutable (re-pointing it interleaves two byte streams into one xterm and keeps
// routing your keystrokes to the host), so openSession returns early for it, and openWsSessionInTab (clicking a
// session in another project's tree) never had a recycle path at all. A guest sitting on a live mirror therefore
// hard-stopped at 8 with "close a session tab first" — the reported bug. The code's own comment already promised
// the behavior it lacked: "At the tab cap we degrade to recycling an idle, non-shared tab so the user is never
// stuck."
//
// Every caller of openSessionInNewTab funnels through here, so all three dead-ends are fixed at one choke point.
// This is purely ADDITIVE: when nothing is safe to reclaim we return false and the pre-existing refusals fire
// unchanged, so no path loses a guard.
//
// A tab is untouchable if it is: the one on screen · mid-turn (busy — killing a running Claude is the one thing
// every navigation path refuses) · the live-shared/pinned tab (closing it disconnects every guest) · a joined live
// mirror (closing it silently leaves someone's session). Among what's left, prefer a never-started blank draft
// (zero loss), else the least-recently-viewed. The session itself is never lost — only its tab; it stays on disk
// and one click away in the sidebar, exactly as when the old path re-pointed a tab out from under you.
function reclaimTabSlot() {
  const safe = [];
  for (const rec of tabs.values()) {
    if (rec.tabId === activeTabId) continue;                          // never yank the tab you're looking at
    if (rec.busy) continue;                                           // never kill a running turn
    if (rec.tabId === sharedTabIdR) continue;                         // never end the live session for the guests
    if (rec.kind === 'live') continue;                                // never silently leave a joined session
    safe.push(rec);
  }
  if (!safe.length) return false;
  const blank = safe.filter((r) => !r.started && (!r.session || r.session === 'new'));   // an untouched "New session" tab costs nothing to drop
  const pool = blank.length ? blank : safe;
  pool.sort((a, b) => (a.lastActive || 0) - (b.lastActive || 0));     // least-recently-viewed first
  try { closeTab(pool[0].tabId); } catch { return false; }
  return tabs.size < MAX_TABS;                                        // closeTab refuses on the last tab — report the truth
}
function openSessionInNewTab(wsId, id, label) {
  if (tabs.size >= MAX_TABS && !reclaimTabSlot()) return false;       // at the cap, reclaim before refusing (see above)
  const tabId = newTabId();
  const rec = makeTab(tabId, wsId || activeWsId, id);
  if (rec && label) { rec.label = label; rec.curSessionLabel = label; }   // display only — no pendingTitle (see above)
  setActiveTab(tabId);                                                    // activates + fits + starts its pty
  return true;
}
// Clicking a session row: if a tab already hosts it, focus that tab; otherwise open it in a NEW tab, so the
// session you were on keeps running in the background — sessions behave like browser tabs. `opts.inPlace`
// forces the legacy recycle-this-tab behavior for the flows that structurally need it (toggleShareSession
// pinning the share to THIS tab). At the tab cap we degrade to recycling an idle, non-shared tab so the user
// is never stuck.
async function openSession(id, label, opts) {
  const inPlace = !!(opts && opts.inPlace);
  // inPlace callers need THIS tab moved onto `id`; focusing some other tab that already hosts it would leave
  // this tab where it was (for deleteSession: still holding the doomed transcript open → a false "still
  // running" abort). Callers guarantee `id` isn't already open elsewhere.
  if (id !== 'new' && !inPlace) {
    for (const rec of tabs.values()) {                // focus an existing tab for this (ws, session)
      if (rec.wsId === activeWsId && rec.session === id) { setActiveTab(rec.tabId); return; }
    }
  }
  const t = AT(); if (!t) return;
  // A joined live mirror is IMMUTABLE — re-pointing it hijacks the peer's session: it spawns a local pty on
  // the mirror's id (two byte streams interleave into one xterm) AND keeps routing your keystrokes + scroll to
  // the host. So a session click while viewing a mirror opens that session in its OWN local tab. (An existing
  // local tab for this (ws, session) was already focused + returned by the loop above.)
  if (t.kind === 'live') { if (!openSessionInNewTab(activeWsId, id, label)) toast('Tab limit reached (' + MAX_TABS + ') — close a session tab first'); return; }
  if (id !== 'new' && t.session === id && t.wsId === activeWsId) return;   // already on this one
  // DEFAULT (the "tabs" behavior): open the click in a NEW tab. The tab you were on keeps its Claude running —
  // busy or idle — and stays reachable from the sidebar, so 2-3 sessions can work at once. Only when the cap is
  // reached do we consider recycling, and then never a busy tab and never the live-shared one.
  if (!inPlace && id !== 'new') {
    if (openSessionInNewTab(activeWsId, id, label)) return;
    if (t.busy) { toast('Tab limit reached (' + MAX_TABS + ') — that session is still running; close a tab first'); return; }
    if (t.tabId === sharedTabIdR) { toast('Tab limit reached (' + MAX_TABS + ') — this tab is live-shared; close another tab first'); return; }
    toast('Tab limit reached (' + MAX_TABS + ') — reusing this tab');     // idle + not shared → safe to recycle below
  }
  // Re-pointing the SHARED tab moves the guests' mirror onto another conversation. Main pauses the mirror
  // defensively (respawnPty's sessionMoved guard); the right answer here is simply never to do it.
  if (!inPlace && t.tabId === sharedTabIdR && id !== t.session) {
    if (openSessionInNewTab(activeWsId, id, label)) return;
    toast('That tab is live-shared — close a tab to open this session beside it'); return;
  }
  // NEVER kill a session that's actively running. Re-pointing the current tab respawns its pty (main's old.kill()),
  // so if this tab is BUSY (Claude is working), open the clicked session in a NEW background tab instead — the
  // running one keeps going untouched. (An idle tab is safe to recycle — there's no live process to lose.)
  if (t.busy && t.session !== id) {
    if (newBlankTab(activeWsId, id)) return;                                 // reclaims a background tab at the cap
    toast('That session is still running — finish it or close a tab before switching'); return;
  }
  // Ask main to re-point this tab's pty FIRST — main is authoritative on busy (its rec.busy comes straight
  // from the hook poller, so it catches the race where THIS renderer's t.busy is still stale ~80-480ms after
  // a submit). Only mutate the tab's view AFTER a confirmed open, so a refusal leaves the running session
  // completely intact.
  // opts.endShare: deleteSession moving the live-shared tab off the session it's deleting. Main refuses every other
  // attempt to re-point the pinned tab; this one it allows, freezing the mirror first.
  let r = null; try { r = await claudible.sessionOpen(t.tabId, id, opts && opts.endShare); } catch {}
  if (r && r.ok === false) {   // main refused: this pty is genuinely mid-turn → open the click in a NEW tab, leave this one running + on screen
    if (!newBlankTab(activeWsId, id)) toast('That session is still running — finish it or close a tab before switching');
    return;
  }
  t.session = id; t.wsId = activeWsId; t.pendingTitle = null;   // re-pointing to another session drops any name typed for a not-yet-resolved new session (else it leaks onto THIS one)
  t.label = (id === 'new') ? 'New session' : (label || 'Session');
  t.curSessionLabel = (id === 'new') ? 'New session' : (label || '');      // mirrored to guests
  activeSession = (id === 'new') ? null : id;
  updateAdvertise();                                  // if I'm sharing in a repo workspace, advertise the now-active session
  refreshSessions();                                  // re-highlight without collapsing (stays docked)
  t.term.reset(); t.altFrac = 0;                       // clear this tab's view (the new pty repaints it) + reset its scroll estimate
  resetStats(t);                                      // reset THIS tab's tracker baselines + push label to guests
  setTimeout(() => { if (term) term.focus(); }, 150);
}
// ---------- workspaces (the library a session belongs to: legacy / local folder / private repo) ----------
const WS_FOLDER_SVG = '<svg class="ws-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const WS_REPO_SVG = '<svg class="ws-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';
const EYE_ON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
const PERSON_ADD_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>';
const CLOUD_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>';
const wsSyncState = {};   // ws id -> { status:'syncing'|'idle'|'error', synced, diverged } (live, from main)
let wsMenuFor = null;     // id of the workspace whose ▾ options menu is currently open (null = closed)
// ── Independent, persisted expand/collapse per workspace (a free multi-expand tree). Selection (.active) and
// expansion are ORTHOGONAL: you can collapse even the SELECTED workspace (it stays highlighted, just hides its
// sessions), and expand as many as you like. Each NON-active expanded workspace lists its sessions WITHOUT
// activating it (cheap list-only; the Claude session only loads when a row is clicked). ──
let _expandedWs = null, _expandedInit = false;
function saveExpandedWs() { try { savePrefs({ expandedWs: Array.from(_expandedWs || []) }); } catch {} }
function expandedSet() {
  if (!_expandedWs) { let a = []; try { a = loadPrefs().expandedWs; } catch {} _expandedWs = new Set(Array.isArray(a) ? a : []); }
  if (!_expandedInit) { _expandedInit = true; if (_expandedWs.size === 0 && activeWsId) { _expandedWs.add(activeWsId); saveExpandedWs(); } }   // first run only: show the active workspace's sessions
  return _expandedWs;
}
function isWsExpanded(id) { return expandedSet().has(id); }
function setWsExpanded(id, on) { const s = expandedSet(); if (on) s.add(id); else s.delete(id); saveExpandedWs(); }
const _wsSessCache = new Map();   // wsId -> { list, ts } — avoid refetching a non-active workspace's sessions on every re-render
const _wsSessFetching = new Set();   // wsIds with a fetch in flight — dedupe concurrent fetches across rapid re-renders
// Clicking a session that lives in ANOTHER project: give it its own tab bound to that workspace, so the session
// you're on keeps running. A tab already hosting it just gets focused. An invited-but-never-cloned repo must go
// through the accept/clone flow FIRST — tab:open→pty:start has no clone gate (it would spawn Claude into a
// directory that doesn't exist yet); only workspace:open awaits ensureClone.
function openWsSessionInTab(w, s) {
  if (!w || !s) return;
  for (const rec of tabs.values()) {                       // already open somewhere → just focus it
    if (rec.kind !== 'live' && rec.wsId === w.id && rec.session === s.id) { setActiveTab(rec.tabId); return; }
  }
  if (w.kind === 'repo' && w.needsClone) { openAcceptInviteModal(w); return; }   // clone it before any pty is spawned
  if (!openSessionInNewTab(w.id, s.id, sessTitle(s, w.id))) {
    toast('Tab limit reached (' + MAX_TABS + ') — close a session tab first');
  }
}
function renderWsSessionRow(w, s) {
  const row = document.createElement('div');
  // a background tab in THIS (non-active) project gets the same busy dot / done-pulse as the active list
  row.className = 'sess' + (sessionBusyInTab(s.id, w.id) ? ' busy' : '') + (sessionNeedsAttention(s.id, w.id) ? ' sess-done' : '');
  row.dataset.id = s.id;
  row.setAttribute('role', 'button'); row.tabIndex = 0;
  const p = document.createElement('div'); p.className = 'sess-prev'; p.textContent = sessTitle(s, w.id); p.title = p.textContent;   // shared names from THIS row's workspace cache, not the active one's
  const m = document.createElement('div'); m.className = 'sess-meta'; const mt = document.createElement('span'); mt.className = 'sess-meta-t'; mt.textContent = relTime(s.used || s.mtime); m.appendChild(mt);   // last-USED (see renderSessionRow) — file mtime is security-aged for imports
  // Live indicator — FULL parity with the active list (renderSessionRow), BOTH arms:
  //
  //  1. A session *I* am hosting. This arm was missing entirely, so the instant the host clicked into another
  //     project their own live session lost its marker and read as "it ended" — undoing, at the last render
  //     step, the whole point of welding the share to sharedWsId ("browsing elsewhere later must not drop it").
  //     It CANNOT be driven off livePeers: pollLivePeers WIPES that list whenever the active workspace is not a
  //     repo, so it is empty in exactly the case this arm exists for. sharedSessionId survives the switch, so it
  //     is the only correct source. Deliberately NOT gated on w.id === sharedWsId: session ids are UUIDs
  //     (globally unique — no cross-project false match is possible), while sharedWsId is null for a
  //     web-link-only share, so gating on it would be a false NEGATIVE. Non-clickable, like the active list —
  //     makeLiveBadge is a <button> that opens a JOIN tab, and you cannot join your own session.
  //  2. A session a COLLABORATOR is hosting → the same green bar + "Join →" badge the active list shows, scoped
  //     to THIS row's workspace via peersForWs(w.id). The poll now covers EXPANDED projects (not just the active
  //     one), so an expanded non-active tree gets real Join badges without being clicked into; a COLLAPSED
  //     non-active project simply isn't polled, so it shows none — "we never asked", not "nobody is live". Reading
  //     the cache unscoped (bypassing peersForWs) is how another project's peer used to leak into this tree.
  if (isSharingSession(s.id)) {
    row.classList.add('sess-live-row');                              // green left accent bar — you're sharing this live
    const lv = document.createElement('span'); lv.className = 'sess-live-ind';
    lv.innerHTML = '<span class="live-dot"></span><span class="liw">Live</span>'; lv.title = 'You are sharing this session live';
    m.appendChild(lv);
  } else {
    const _lp = peersForWs(w.id).find((x) => x.session === s.id);
    if (_lp) { row.classList.add('sess-live-row'); m.appendChild(makeLiveBadge(_lp, sessTitle(s, w.id))); }
  }
  row.appendChild(p); row.appendChild(m);
  appendConflictChip(m, s, w);                                       // expanded-tree row: same chips as the active list (bug fix — this path drew none)
  const go = () => { openWsSessionInTab(w, s); };   // open that project's session in its OWN tab (the tab you're on keeps running)
  row.addEventListener('click', go);
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  return row;
}
function renderWsNonActiveSessions(w, kids) {                          // a saved-sessions list for a NON-active expanded workspace
  const fill = (list) => {
    // The active workspace's list has exactly ONE owner: refreshSessions. If w became active while our fetch was
    // in flight, reconcileWsChips has REUSED this same `kids` node to host #sess-list — so the querySelectorAll
    // below would recurse into the nested #sess-list, DELETE every active row, and append stale tree rows next to
    // the emptied list ("sessions disappear for a split second"). document.body.contains(kids) can't see that;
    // only the activeness check can. (Cache is already updated by the caller, so the switch-in reads fresh data.)
    if (w.id === activeWsId) return;
    Array.from(kids.querySelectorAll('.sess,.sess-empty,.newsess-row')).forEach((n) => n.remove());
    // Same stub rule as the active list (promptless fork artifacts hidden, NAMED sessions always shown), and —
    // critically — the SAME ordering. This was the one site still sorting by used/mtime after a0c3c59 moved the
    // other two onto the saved order, so the rows you saw in the tree visibly REORDERED the instant you clicked
    // into the project and the pre-fill repainted them (the "sessions switch places" glitch). One helper now;
    // contract check 11 fails if any render path grows its own sort again.
    // Joined-mirror dedup, tree edition. The active list already suppresses the saved/peer copies of a session
    // you've JOINED (refreshSessions' `shown` set) — but this tree renders independently, so the same session
    // painted TWICE when its home project was expanded while another project was active: the joined row under
    // the active project + this tree's saved row wearing a live badge ("the same live session twice", b9c51fe).
    // Same priority rule as the active list: the joined mirror wins; the tree row returns when the tab closes.
    const joined = joinedTabSessionIds();
    // The suppression above only holds together with a SUBSTITUTE row: a joined tab whose home project (peerWsId)
    // is THIS tree must render its joined row HERE, or the session has no row anywhere once the user switches
    // workspace + tab away (active list: peerWsId≠activeWsId and not the active tab; tree: saved copy suppressed) —
    // the "joined live session vanished from the whole sidebar while still streaming" bug. The active-tab case is
    // excluded because the active list already pins it (tabId===activeTabId) — rendering here too would double it.
    const joinedRows = Array.from(tabs.values()).filter((r) => r.kind === 'live' && r.peerWsId === w.id && r.tabId !== activeTabId);
    joinedRows.forEach((rec) => kids.appendChild(renderJoinedTabRow(rec)));
    const ordered = orderedSessionsFor(w.id, (list || []).filter((s) => !joined.has(s.id) && ((s.msgs || 0) > 0 || hasExplicitTitle(s.id, w.id)))).slice(0, 60);
    if (!ordered.length && !joinedRows.length) { const e = document.createElement('div'); e.className = 'sess-empty'; e.textContent = 'no sessions yet'; kids.appendChild(e); }
    else ordered.forEach((s) => kids.appendChild(renderWsSessionRow(w, s)));
    // R29: a peer live in a session with NO local saved copy (not yet synced here) was invisible in this tree —
    // badges only decorate saved rows, and standalone peer rows existed only in the active list. Same
    // suppressions as there: a joined tab wins; saved rows already wear their badge on the ordered rows above.
    { const seenIds = new Set(ordered.map((s) => s.id));
      peersForWs(w.id).forEach((p2) => { if (seenIds.has(p2.session) || joined.has(p2.session)) return; kids.appendChild(renderLivePeerRow(p2)); }); }
    // NB: no "+ New Session" here. That action belongs only to the SELECTED workspace (its shared #new-session row).
    // A non-active workspace lists its sessions for browsing/opening; to start a new one you select it first.
  };
  const c = _wsSessCache.get(w.id);
  if (c) fill(c.list); else if (!kids.querySelector('.sess')) { const l = document.createElement('div'); l.className = 'sess-empty'; l.textContent = 'loading…'; kids.appendChild(l); }   // no "loading…" flash over rows we're merely refreshing (busted cache but the list is still on screen)
  if ((!c || Date.now() - c.ts > 4000) && !_wsSessFetching.has(w.id)) {   // skip if a fetch for this ws is already in flight
    _wsSessFetching.add(w.id);
    claudible.sessionListWs(w.id)
      .then((list) => {
        if (!Array.isArray(list)) return;               // typed fetch failure — keep the warm cache + whatever's painted (never cache/paint [] over real rows); the next 4s-stale refresh retries
        _wsSessCache.set(w.id, { list, ts: Date.now() });
        if (document.body.contains(kids)) fill(list);
        else if (isWsExpanded(w.id)) renderWsChips();   // the container was replaced by a re-render mid-fetch → repaint from the now-fresh cache (no re-fetch)
      })
      .catch(() => {})
      .finally(() => { _wsSessFetching.delete(w.id); });
  }
}
// Force-refresh a NON-active workspace's expanded session subtree in place — used after a sync pulled changes for
// a project you have open-but-not-selected. reconcileWsChips deliberately leaves a POPULATED non-active list
// untouched (no animation restart), so without this a synced-in session only appeared once you switched into that
// project (part of the "I have to bounce to another tab to see synced changes" report). No-op if it isn't expanded.
function refreshWsSubtree(wsId) {
  const el = $('ws-chips'); if (!el) return;
  let chip = null;
  el.querySelectorAll('.ws-chip').forEach((c) => { if (c.dataset.id === wsId) chip = c; });
  if (!chip) return;
  const kids = chip.nextElementSibling;
  if (!kids || !kids.classList.contains('ws-children')) return;   // not expanded → nothing on screen to refresh
  const w = workspaces.find((x) => x.id === wsId); if (!w) return;
  renderWsNonActiveSessions(w, kids);   // cache was already busted by the caller → this refetches fresh
}
// Structural signature of the chip ROW themselves (everything that shapes a chip's own DOM) — but NOT which chip is
// active/expanded (those are reconciled in place). Unchanged sig on a switch/expand → take the fast path below.
let _wsChipsSig = '';
function wsChipsSig() {
  return JSON.stringify(workspaces.map((w) => [w.id, w.label, w.kind, !!w.shared, !!w.syncSessions, !!w.needsClone, isLastLocal(w), (wsSyncState[w.id] || {}).status || '']));
}
// In-place update: toggle active/expanded/shared, re-nest the live #sess-list under whoever is active now, and
// add/remove the non-active children — WITHOUT recreating any chip (so the busy/syncing dot animations don't restart).
function reconcileWsChips(el) {
  if (sessListEl && sessListEl.parentNode) sessListEl.remove();      // detach the live list so we can re-nest it under the new active chip (newSessEl is the persistent module ref)
  if (newSessEl && newSessEl.parentNode) newSessEl.remove();
  const chipById = {};
  el.querySelectorAll('.ws-chip').forEach((c) => { chipById[c.dataset.id] = c; });
  workspaces.forEach((w) => {
    const chip = chipById[w.id]; if (!chip) return;
    const wantExpanded = isWsExpanded(w.id), wantActive = w.id === activeWsId;
    chip.classList.toggle('active', wantActive);
    chip.classList.toggle('expanded', wantExpanded);
    const cv = chip.querySelector('.ws-caret'); if (cv) cv.title = wantExpanded ? 'Collapse' : 'Expand';
    let kids = chip.nextElementSibling;
    if (kids && !kids.classList.contains('ws-children')) kids = null;
    if (!wantExpanded) { if (kids) kids.remove(); return; }
    if (!kids) { kids = document.createElement('div'); kids.className = 'ws-children'; chip.after(kids); }
    if (wantActive) { kids.innerHTML = ''; kids.appendChild(sessListEl); if (newSessEl) kids.appendChild(newSessEl); }   // active → the live list
    else if (!kids.childElementCount) { renderWsNonActiveSessions(w, kids); }                                            // newly non-active/expanded → its saved list (warm cache → instant). a stable non-active list is left untouched (no restart)
  });
}
function renderWsChips() {
  const el = $('ws-chips'); if (!el) return;
  const _scroll = el.scrollTop;  // preserve the sidebar scroll position across the rebuild (no jump-to-top flicker)
  closeWsMenu();                 // a re-render replaces the chips/caret the open menu was anchored to
  // FAST PATH — a workspace switch / expand toggle leaves the workspace set, labels and sync-state unchanged; only
  // which chip is active/expanded differs. Recreating every chip (innerHTML='') restarts the keyframe animations on
  // busy/syncing dots (a visible stutter). When the structural signature matches, update chips IN PLACE instead.
  const sig = wsChipsSig();
  if (sig === _wsChipsSig && el.querySelector('.ws-chip')) { reconcileWsChips(el); el.scrollTop = _scroll; return; }
  _wsChipsSig = sig;
  // Preserve the live sessions list + its inline "+ New Session" across the wipe — they get moved INTO the active
  // workspace node below. .remove() keeps the JS ref (sessListEl) and the already-rendered rows alive, so a bare
  // renderWsChips() never drops the sessions. Without this, el.innerHTML='' would destroy the relocated nodes.
  if (el.contains(sessListEl)) sessListEl.remove();
  if (newSessEl && el.contains(newSessEl)) newSessEl.remove();      // newSessEl: persistent module ref (survives detachment when the active ws is collapsed)
  el.innerHTML = '';
  workspaces.forEach((w) => {
    const chip = document.createElement('div');
    chip.className = 'ws-chip' + (w.id === activeWsId ? ' active' : '') + (isWsExpanded(w.id) ? ' expanded' : '');   // (the old ' shared' class lost its CSS in the redesign — the .ws-dot.live indicator carries screen-share state now)
    chip.title = w.kind === 'legacy' ? 'Default space — quick chats, not tied to a project folder'
      : w.kind === 'repo' ? ((w.repoUrl || w.label) + ' — synced project; you and your team see its sessions and can Join live')
      : w.adopted ? (w.label + ' — your own folder; Claudible works in it, nothing is moved or published')
      : (w.label + ' — your project (private to this machine; sync or share it from the ▾ menu)');
    const cv = document.createElement('button'); cv.className = 'ws-caret'; cv.title = isWsExpanded(w.id) ? 'Collapse' : 'Expand';   // a real button → toggles THIS workspace's sessions independently, never triggers the chip's switch/drag
    cv.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>';
    cv.addEventListener('click', (e) => { e.stopPropagation(); setWsExpanded(w.id, !isWsExpanded(w.id)); renderWsChips(); });
    chip.insertAdjacentHTML('beforeend', w.kind === 'repo' ? WS_REPO_SVG : WS_FOLDER_SVG);   // workspace logo — now the leftmost element
    const nm = document.createElement('span'); nm.className = 'ws-name'; nm.textContent = w.label; chip.appendChild(nm);
    if (isLastLocal(w)) {                                              // a tiny "default" tag on the sole local workspace (the protected home)
      const tag = document.createElement('span'); tag.textContent = 'default';
      tag.style.cssText = 'flex:none;font-size:8px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-faint);margin-left:4px';
      chip.appendChild(tag);
    } else if (w.kind === 'repo' && w.needsClone) {                    // invited but not cloned yet → click to choose where it saves
      const tag = document.createElement('span'); tag.textContent = 'invited';   // a FILLED green pill (was an 8px whisper nobody noticed) so an accepted invite reads at a glance
      tag.style.cssText = 'flex:none;font-size:9px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ok,#5fb487);background:color-mix(in srgb,var(--ok) 16%,transparent);border:1px solid color-mix(in srgb,var(--ok) 34%,transparent);border-radius:999px;padding:1px 7px;margin-left:6px';
      chip.appendChild(tag);
      chip.title = (w.owner ? w.owner + '/' + (w.slug || w.label) : w.label) + ' — invited shared project · click to choose where to save it';
    }
    // Right edge: a passive status dot (at-a-glance share/sync state) + a single ▾ that opens the options
    // menu. All actions (share, invite, sync, rename, delete) now live in that menu so the chip stays clean
    // and the full workspace name is readable — no row of icons crowding it out.
    const right = document.createElement('div'); right.className = 'ws-right';
    if (w.shared || w.syncSessions) {
      const st0 = wsSyncState[w.id] || {};
      const dot = document.createElement('span');
      dot.className = 'ws-dot' + (w.syncSessions ? ' sync' : ' live')
        + (st0.status === 'syncing' ? ' syncing' : '') + (st0.status === 'error' ? ' err' : '');
      dot.title = [w.shared ? 'screen-share ON' : '', w.syncSessions ? 'session-sync ON' : ''].filter(Boolean).join(' · ');
      right.appendChild(dot);
    }
    const mb = document.createElement('button');
    mb.className = 'ws-menu-btn'; mb.title = 'Manage — rename, share, export, delete';
    mb.innerHTML = OPTIONS_SVG;   // settings sliders — same glyph as the session-row options trigger (visual continuity); sits left of the expand chevron, never confused with it
    mb.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = wsMenuFor === w.id; closeWsMenu();
      if (!wasOpen) openWsMenu(mb, chip, nm, w);
    });
    right.appendChild(mb);
    right.appendChild(cv);                                  // expand chevron — the rightmost element
    chip.appendChild(right);
    chip.dataset.id = w.id;
    chip.addEventListener('pointerdown', (e) => onWsPointerDown(e, chip, w));
    chip.addEventListener('pointermove', onWsPointerMove);
    chip.addEventListener('pointerup', onWsPointerUp);
    chip.addEventListener('pointercancel', onWsPointerUp);
    chip.addEventListener('contextmenu', (e) => {
      if (isLastLocal(w)) { try { toast(w.adopted ? 'This is your only project — add another first' : 'You need at least one local project'); } catch (e) {} return; }   // never delete the last local (the guaranteed home)
      e.preventDefault(); e.stopPropagation();
      if (confirm(deleteWsPrompt(w))) deleteWorkspace(w);   // same wording as the ▾ menu — an adopted folder is never trashed
    });
    el.appendChild(chip);
    if (isWsExpanded(w.id)) {                               // expanded → nest its sessions beneath it
      const kids = document.createElement('div'); kids.className = 'ws-children';
      if (w.id === activeWsId) {                            // the ACTIVE workspace gets the full live list (live/joined rows + the moved #sess-list)
        kids.appendChild(sessListEl);
        if (newSessEl) kids.appendChild(newSessEl);
      } else {                                              // a NON-active expanded workspace → its saved sessions, fetched without activating it
        renderWsNonActiveSessions(w, kids);
      }
      el.appendChild(kids);
    }
  });
  // The active workspace's live #sess-list / #new-session are nested above only while the active ws is EXPANDED.
  // If it's collapsed (or there's no active match), they stay detached (preserved via .remove()) — refreshSessions
  // still fills the ref harmlessly, and they re-nest the moment the active workspace is expanded again.
  el.scrollTop = _scroll;        // restore the scroll position the rebuild reset (synchronous content is in place)
}
// "What's a workspace?" — one click on the ⓘ explains the concept, so the sidebar stays clean (no inline paragraphs).
let wsInfoPop = null;
function closeWsInfo() {
  if (!wsInfoPop) return;
  wsInfoPop.remove(); wsInfoPop = null;
  document.removeEventListener('mousedown', onWsInfoOutside, true);
  document.removeEventListener('keydown', onWsInfoKey, true);
}
function onWsInfoOutside(e) { if (wsInfoPop && !wsInfoPop.contains(e.target) && e.target.id !== 'ws-info') closeWsInfo(); }
function onWsInfoKey(e) { if (e.key === 'Escape') closeWsInfo(); }
function openWsInfo() {
  if (wsInfoPop) { closeWsInfo(); return; }
  const anchor = $('ws-info'); if (!anchor) return;
  const pop = document.createElement('div'); pop.className = 'ws-info-pop';
  pop.innerHTML = '<span class="wt"><b>What’s a project?</b></span>'
    + '<p>A folder Claude works in — it edits those files, and you review changes there.</p>'
    + '<p><b>My Sessions</b> is the default (no project). The <b>+</b> adds one for a specific project — kept on your machine, or backed by a private GitHub repo to build with your team.</p>';
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  let left = r.left; if (left + pop.offsetWidth > window.innerWidth - 8) left = window.innerWidth - pop.offsetWidth - 8;
  pop.style.left = Math.max(8, left) + 'px'; pop.style.top = (r.bottom + 6) + 'px';
  wsInfoPop = pop;
  setTimeout(() => { document.addEventListener('mousedown', onWsInfoOutside, true); document.addEventListener('keydown', onWsInfoKey, true); }, 0);
}
(function () { const b = $('ws-info'); if (b) b.addEventListener('click', (e) => { e.stopPropagation(); openWsInfo(); }); })();
// "Your Claudible username" ⓘ — same click-popover as the workspace one.
let unameInfoPop = null;
function closeUnameInfo() { if (!unameInfoPop) return; unameInfoPop.remove(); unameInfoPop = null; document.removeEventListener('mousedown', onUnameInfoOutside, true); document.removeEventListener('keydown', onUnameInfoKey, true); }
function onUnameInfoOutside(e) { if (unameInfoPop && !unameInfoPop.contains(e.target) && e.target.id !== 'username-info') closeUnameInfo(); }
function onUnameInfoKey(e) { if (e.key === 'Escape') closeUnameInfo(); }
function openUnameInfo() {
  if (unameInfoPop) { closeUnameInfo(); return; }
  const anchor = $('username-info'); if (!anchor) return;
  const pop = document.createElement('div'); pop.className = 'ws-info-pop';
  pop.style.zIndex = '9002';   // this ⓘ lives inside the Settings drawer (z-index 9001) — sit above it, not behind
  pop.innerHTML = '<span class="wt"><b>Your Claudible username</b></span>'
    + '<p>The name you appear as when you join (or host) a session through Claudible.</p>'
    + '<p>Stored <b>locally on this machine</b> and remembered for every session.</p>';
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  let left = r.left; if (left + pop.offsetWidth > window.innerWidth - 8) left = window.innerWidth - pop.offsetWidth - 8;
  pop.style.left = Math.max(8, left) + 'px'; pop.style.top = (r.bottom + 6) + 'px';
  unameInfoPop = pop;
  setTimeout(() => { document.addEventListener('mousedown', onUnameInfoOutside, true); document.addEventListener('keydown', onUnameInfoKey, true); }, 0);
}
(function () { const b = $('username-info'); if (b) b.addEventListener('click', (e) => { e.stopPropagation(); openUnameInfo(); }); })();
// First launch: pop the explainer once so new users learn the concept; afterwards it lives behind the ⓘ.
{ const _wp = loadPrefs(); if (!_wp.wsHintSeen && _wp.onboardingDone) { savePrefs({ wsHintSeen: true }); setTimeout(() => { try { openWsInfo(); } catch (e) {} }, 1000); } }   // only post-onboarding; the first-run wizard owns workspace education (and sets wsHintSeen on finish/skip)
// the bottom-left "share live" ⓘ — same click-popover as the workspace one, but anchored ABOVE the icon (the
// share dock sits at the screen bottom). Explains what the web link is vs. just joining in Claudible.
let shareInfoPop = null;
function closeShareInfo() {
  if (!shareInfoPop) return;
  shareInfoPop.remove(); shareInfoPop = null;
  document.removeEventListener('mousedown', onShareInfoOutside, true);
  document.removeEventListener('keydown', onShareInfoKey, true);
}
function onShareInfoOutside(e) { if (shareInfoPop && !shareInfoPop.contains(e.target) && e.target.id !== 'share-info') closeShareInfo(); }
function onShareInfoKey(e) { if (e.key === 'Escape') closeShareInfo(); }
function openShareInfo() {
  if (shareInfoPop) { closeShareInfo(); return; }
  const anchor = $('share-info'); if (!anchor) return;
  const pop = document.createElement('div'); pop.className = 'ws-info-pop';
  pop.innerHTML = '<span class="wt"><b>Share a live link</b></span>'
    + '<p>Makes a public web link (a secure tunnel) so anyone — even without Claudible — can watch this terminal live in their browser, with chat &amp; voice.</p>'
    + '<p>You approve every viewer before they see anything, and <b>view-only</b> stops them typing.</p>'
    + '<p>Teammates who have Claudible don’t need this — they just <b>Join</b> from the synced project.</p>';
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  let left = r.left; if (left + pop.offsetWidth > window.innerWidth - 8) left = window.innerWidth - pop.offsetWidth - 8;
  let top = r.top - pop.offsetHeight - 6; if (top < 8) top = r.bottom + 6;   // prefer above; fall below only if it'd clip the top
  pop.style.left = Math.max(8, left) + 'px'; pop.style.top = top + 'px';
  shareInfoPop = pop;
  setTimeout(() => { document.addEventListener('mousedown', onShareInfoOutside, true); document.addEventListener('keydown', onShareInfoKey, true); }, 0);
}
(function () { const b = $('share-info'); if (b) b.addEventListener('click', (e) => { e.stopPropagation(); openShareInfo(); }); })();
// workspace drag-reorder (mirrors session rows) + right-click delete
let wsdrag = null;
function onWsPointerDown(e, chip, w) {
  if (e.button !== 0) return;
  if (e.target.closest('button') || chip.querySelector('.ws-rename')) return;   // child controls / mid-rename
  wsdrag = { id: w.id, chip, startY: e.clientY, moved: false, pid: e.pointerId };
  try { chip.setPointerCapture(e.pointerId); } catch {}
}
function onWsPointerMove(e) {
  if (!wsdrag) return;
  if (!wsdrag.moved) { if (Math.abs(e.clientY - wsdrag.startY) < 5) return; wsdrag.moved = true; wsdrag.chip.classList.add('dragging'); }
  const el = $('ws-chips'); if (!el) return;
  const chips = Array.prototype.slice.call(el.querySelectorAll('.ws-chip')).filter((c) => c !== wsdrag.chip);
  let before = null;
  for (let i = 0; i < chips.length; i++) { const r = chips[i].getBoundingClientRect(); if (e.clientY < r.top + r.height / 2) { before = chips[i]; break; } }
  if (before) el.insertBefore(wsdrag.chip, before); else el.appendChild(wsdrag.chip);
}
function onWsPointerUp() {
  if (!wsdrag) return;
  const d = wsdrag; wsdrag = null;
  try { d.chip.releasePointerCapture(d.pid); } catch {}
  d.chip.classList.remove('dragging');
  if (d.moved) {
    const order = Array.prototype.slice.call($('ws-chips').querySelectorAll('.ws-chip')).map((c) => c.dataset.id);
    workspaces.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));   // keep the local array in sync with the DOM order
    claudible.workspaceReorder(order).catch(() => {});
    renderWsChips();                                                        // re-nest the active workspace's sessions under its newly-moved chip
  } else {
    const w = workspaces.find((x) => x.id === d.id);
    if (w && w.kind === 'repo' && w.needsClone) openAcceptInviteModal(w);   // invited workspace → choose where to save it, then clone
    else switchWorkspace(d.id);                                             // plain click → switch workspace
  }
}
// Accept an invited GitHub workspace: choose where it clones (default vs a folder you pick), then open it.
const acceptingWs = new Set();   // workspaces whose clone is in flight → don't re-prompt the folder picker on a re-click
async function openAcceptInviteModal(w) {
  if (acceptingWs.has(w.id)) { toast('Still adding “' + (w.label || w.slug) + '” — give it a sec…'); return; }
  const slug = w.slug || w.label || '';
  const choice = await modalChoice({
    title: 'Add shared project',
    body: (w.owner ? w.owner + '/' + slug : slug) + ' — choose where it lives on your machine. This is your local copy of a shared repo; sessions still sync with the team. (Default is recommended.)',
    choices: [
      { key: 'default', label: 'Default location', sub: '~/.claudible/repos/' + slug },
      { key: 'custom', label: 'Choose folder…', sub: 'Pick any folder — it clones into <folder>/' + slug },
      { key: 'cancel', label: 'Cancel' },
    ],
  });
  if (choice !== 'default' && choice !== 'custom') return;
  acceptingWs.add(w.id);
  toast('Adding ' + slug + '…');
  let r = null; try { r = await claudible.workspaceAcceptInvite(w.id, choice === 'default'); } catch (e) { r = { ok: false, error: e && e.message }; }
  acceptingWs.delete(w.id);
  if (r && r.ok) { await refreshWorkspaces(); switchWorkspace(w.id); }
  else if (!r || r.error !== 'cancelled') toast('Could not add: ' + humanError(r && r.error));
}
async function deleteWorkspace(w) {
  const busyToast = () => toast('A session in this project is still running — stop it before deleting');
  if (wsBusy(w.id)) { busyToast(); return; }               // fast local check; main re-checks against its authoritative rec.busy
  let r = null; try { r = await claudible.workspaceDelete(w.id); } catch {}
  if (r && r.ok) {
    if (r.activeId) activeWsId = r.activeId;
    // main repointed + respawned EVERY tab that lived in the deleted workspace and tells us exactly which
    // (moved) — reset those records so their terminal/session/label state matches their fresh pty, instead of
    // guessing from registry.activeId (which can differ from the fallback main actually used for background tabs).
    for (const m of (r.moved || [])) {
      const rec = tabs.get(m.tabId); if (!rec) continue;
      rec.wsId = m.wsId; rec.session = ''; rec.label = ''; rec.curSessionLabel = '';
      try { rec.term.reset(); } catch {}
      resetStats(rec);
      if (rec.tabId === activeTabId) activeSession = null;
    }
    // Belt: any record main didn't know (e.g. a tab whose pty never started — layout deferred while the window
    // was backgrounded) must not keep naming a dead ws. Full reset like the `moved` branch, not just wsId:
    // rebinding wsId alone left session/label pointing at a session inside the just-trashed workspace.
    for (const rec of tabs.values()) {
      if (rec.wsId !== w.id) continue;
      rec.wsId = r.activeId || activeWsId; rec.session = ''; rec.label = ''; rec.curSessionLabel = '';
      try { rec.term.reset(); } catch {}
      resetStats(rec);
      if (rec.tabId === activeTabId) activeSession = null;
    }
    forgetWorkspaceCaches(w.id);   // its warm caches are dead weight — and _wsSessCache would serve STALE rows to a ws later re-created with this id
    await refreshWorkspaces(); refreshSessions();
    // The registry entry is gone either way — but if the FOLDER couldn't be moved to trash (locked file, no
    // permission, disk full) it's still on disk, owned by nothing. Main used to discard that result entirely and
    // report a clean success. Say it out loud.
    if (r.folderError) toast(r.folderError);
  } else if (r && r.error === 'busy') { busyToast(); }     // a turn started between the local check and main's authoritative one
  else toast('Delete failed' + (r && r.error ? ': ' + humanError(r.error) : ''));
}
// ---- workspace options (▾) menu: every per-workspace action lives here so the chip stays a clean name ----
function wsMenuItems(chip, nm, w) {
  const st = wsSyncState[w.id] || {};
  const items = [];
  // live screen-share (guests watch the terminal) — available on every workspace
  items.push({
    icon: w.shared ? EYE_ON_SVG : EYE_OFF_SVG,
    label: w.shared ? 'Screen-share: ON' : 'Screen-share to guests',
    hint: w.shared ? 'Guests can watch this terminal live. Click to make it private.'
                   : 'Let invited guests watch this terminal live in their browser (nothing is saved).',
    on: w.shared,
    act: () => toggleShared(w),
  });
  if (w.kind === 'repo') {
    items.push({ icon: PERSON_ADD_SVG, label: 'Invite collaborator…',
      hint: 'Add a GitHub user to this repo so they can cloud-sync sessions with you.',
      act: () => openInviteModal(w) });
    if (w.syncSessions) {
      const extra = (st.synced != null ? ' · ' + st.synced + ' synced' : '') + (st.diverged ? ' · ' + st.diverged + ' to review' : '');
      items.push({ icon: CLOUD_SVG, label: (st.status === 'syncing' ? 'Syncing sessions…' : 'Sync sessions now') + extra, on: true,
        hint: 'Collaborating in Claudible: teammates see your sessions and can Join live. Push & pull now.', act: () => triggerSyncNow(w) });
      items.push({ icon: CLOUD_SVG, label: 'Turn off collaboration',
        hint: 'Stop sharing this project’s sessions — no more sync, and teammates can no longer Join live.', act: () => disableSync(w) });
    } else {
      items.push({ icon: CLOUD_SVG, label: 'Collaborate in Claudible…',
        hint: 'Sync this project’s sessions over its GitHub repo so teammates can open, resume, AND Join your sessions live — no link needed.',
        act: () => openSyncModal(w) });
    }
  } else if (w.kind === 'local' && !w.adopted) {
    // ADOPTED folders are excluded: both actions run upgrade-workspace.sh, which drops the folder's existing
    // `origin` and republishes the whole tree to a brand-new private repo. main.js refuses it too (belt + braces).
    items.push({ icon: CLOUD_SVG, label: 'Sync across my devices…',
      hint: 'Back this project with a private GitHub repo so it + its sessions appear on your other devices (needs GitHub connected).',
      act: () => upgradeWorkspace(w) });
    items.push({ icon: PERSON_ADD_SVG, label: 'Invite someone…',
      hint: 'Share this project with a teammate — creates its private GitHub repo first, then adds them.',
      act: () => inviteToLocal(w) });
  }
  items.push({ sep: true });
  items.push({ icon: PENCIL_SVG, label: 'Rename', hint: 'Rename this project (local label only).', act: () => startWsEdit(chip, nm, w) });
  if (!isLastLocal(w)) {                                  // never offer delete on the LAST local workspace (the guaranteed home)
    items.push(Object.assign(w.adopted ? {
      // Claudible never created this folder, so "delete" only forgets it — main.js skips delete-workspace.sh.
      icon: TRASH_SVG, label: 'Remove from Claudible',
      hint: 'Stop tracking this folder as a project. The folder itself is left exactly where it is.',
    } : {
      icon: TRASH_SVG, label: 'Delete project', danger: true,
      hint: 'Move this project’s folder to trash (kept 30 days). A repo keeps its GitHub copy.',
    }, { act: () => { if (confirm(deleteWsPrompt(w))) deleteWorkspace(w); } }));
  }
  return items;
}
function openWsMenu(btn, chip, nm, w) {
  const m = $('ws-menu'); if (!m) return;
  m.innerHTML = '';
  wsMenuItems(chip, nm, w).forEach((it) => {
    if (it.sep) { const s = document.createElement('div'); s.className = 'ws-menu-sep'; m.appendChild(s); return; }
    const b = document.createElement('button');
    b.className = 'ctxitem ws-mi' + (it.danger ? ' danger' : '') + (it.on ? ' on' : '');
    if (it.hint) b.title = it.hint;                          // short hover description of what this action does
    b.innerHTML = '<span class="ws-mi-ic">' + it.icon + '</span><span class="ws-mi-lb"></span>';
    b.querySelector('.ws-mi-lb').textContent = it.label;     // textContent → labels can't inject markup
    b.addEventListener('click', (e) => { e.stopPropagation(); closeWsMenu(); it.act(); });
    m.appendChild(b);
  });
  // Drop straight down as if it were the next workspace chip: EXACT same left edge and EXACT same width as
  // the bar it came off of (the menu is border-box, so width == the bar's full box). Flips above only if it
  // would overflow the viewport bottom.
  const r = (chip || btn).getBoundingClientRect();
  m.style.minWidth = '0';
  m.style.width = Math.round(r.width) + 'px';
  m.style.display = 'block';
  const mh = m.offsetHeight;
  m.style.left = Math.round(r.left) + 'px';
  m.style.top = (r.bottom + 5 + mh > window.innerHeight - 8 ? Math.max(8, r.top - 5 - mh) : r.bottom + 5) + 'px';
  wsMenuFor = w.id;
}
function closeWsMenu() { const m = $('ws-menu'); if (m) m.style.display = 'none'; wsMenuFor = null; }
document.addEventListener('click', (e) => {
  if (wsMenuFor && !e.target.closest('#ws-menu') && !e.target.closest('.ws-menu-btn')) closeWsMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && wsMenuFor) closeWsMenu(); });
// ---- git push / pull: clicking a menu item writes the command into the live terminal (like the cmd bar) ----
function openGitMenu() {
  const b = $('git-btn'), m = $('git-menu'); if (!b || !m) return;
  const r = b.getBoundingClientRect();
  m.style.display = 'block';
  m.style.top = Math.max(8, r.top - m.offsetHeight - 6) + 'px';   // open UPWARD — the git button sits at the terminal's bottom edge, so a downward menu clipped off-screen
  m.style.left = Math.max(8, r.right - m.offsetWidth) + 'px';   // right-align with the button
}
function closeGitMenu() { const m = $('git-menu'); if (m) m.style.display = 'none'; }
function gitCmd(cmd) {
  closeGitMenu();
  sendInput('\x1b');                                   // clear/close any open input first
  setTimeout(() => sendInput(cmd + '\r'), 120);        // …then run it in the terminal
  setTimeout(() => term.focus(), 170);
}
if ($('git-btn')) {
  $('git-btn').addEventListener('click', (e) => { e.stopPropagation(); const m = $('git-menu'); (m && m.style.display === 'block') ? closeGitMenu() : openGitMenu(); });
  $('git-push').addEventListener('click', () => gitCmd('git push'));
  $('git-pull').addEventListener('click', () => gitCmd('git pull'));
  document.addEventListener('click', (e) => { const m = $('git-menu'); if (m && m.style.display === 'block' && !e.target.closest('#git-menu') && !e.target.closest('#git-btn')) closeGitMenu(); });
}
// inline workspace rename (mirrors session rename), persisted through main (registry is source of truth)
function startWsEdit(chip, nm, w) {
  if (chip.querySelector('.ws-rename')) return;
  const inp = document.createElement('input');
  inp.className = 'ws-rename'; inp.type = 'text'; inp.maxLength = 80; inp.value = w.label;
  nm.style.display = 'none'; chip.insertBefore(inp, nm);
  inp.focus(); inp.select();
  let done = false;
  const commit = async (save) => {
    if (done) return; done = true;
    if (save) {
      const t = inp.value.trim();
      if (t && t !== w.label) {
        let r = null; try { r = await claudible.workspaceRename(w.id, t); } catch {}
        if (r && r.ok) {
          w.label = r.label;
          if (r.repoUrl) w.repoUrl = r.repoUrl;                       // GitHub repo was renamed → the chip's title/link follows the new URL
          if (r.repoRenamed) toast('Renamed — GitHub repo updated too');
          else if (r.notice) toast(r.notice);
        }
      }
    }
    try { inp.remove(); } catch {} nm.style.display = '';
    nm.textContent = w.label; chip.title = (w.kind === 'repo' && w.repoUrl) ? w.repoUrl : w.label;
  };
  inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); commit(true); } else if (e.key === 'Escape') { e.preventDefault(); commit(false); } });
  inp.addEventListener('blur', () => commit(true));
  inp.addEventListener('click', (e) => e.stopPropagation());
}
async function toggleShared(w) {
  const next = !w.shared;
  let r = null; try { r = await claudible.workspaceSetShared(w.id, next); } catch {}
  if (r && r.ok) { w.shared = r.shared; renderWsChips(); }
}
// Make a LOCAL workspace synced across devices (and shareable): one click backs it with a private GitHub repo
// in place — its sessions appear on your other devices via discovery. Needs GitHub connected.
async function upgradeWorkspace(w) {
  // R2: this consent used to claim "Your Claude transcripts stay OUT of the repo" — false: upgrade enables
  // session sync, whose whole job is committing transcripts to the private repo (its own sync modal already
  // disclosed this honestly). A consent dialog that lies is worse than none.
  if (!confirm('Sync "' + w.label + '" across your devices?\n\nThis creates a PRIVATE GitHub repo for it (you need GitHub connected). The project + its sessions then appear on your other devices, and you can invite people.\n\nHeads up: session sync commits your Claude transcripts — including anything Claude read during them (file contents, secrets, command output) — into that private repo’s history.')) return;
  toast('Setting up sync — creating a private repo…');
  let r = null; try { r = await claudible.workspaceUpgrade(w.id); } catch (e) { r = { ok: false, error: e && e.message }; }
  if (r && r.ok) { toast('Synced ✓ — this project now appears on your other devices'); try { await refreshWorkspaces(); } catch {} }
  else { const m = (r && r.error) || 'unknown'; toast('Could not sync: ' + humanError(m) + (/(gh|github|auth)/i.test(m) ? ' — connect GitHub first' : '')); }   // humanize for the toast, but sniff the RAW code for the gh hint
}
// Inviting to a local workspace: it must become a synced repo first (collaborators need a GitHub repo), then
// open the normal invite modal on the now-repo workspace.
async function inviteToLocal(w) {
  // R2: this used to create the GitHub repo with NO dialog at all — a click that read like "open the invite
  // form" published a local project (and enabled transcript sync) before any consent appeared. Same gate as
  // upgradeWorkspace, same honest disclosure as the sync modal.
  if (!confirm('Share "' + w.label + '" with someone?\n\nThis creates a PRIVATE GitHub repo for it and turns on session sync, so the person you invite can see, resume, and join this project’s conversations.\n\nHeads up: session sync commits your Claude transcripts — including anything Claude read during them (file contents, secrets, command output) — into that private repo’s history.')) return;
  toast('Preparing to share — creating a private repo…');
  let r = null; try { r = await claudible.workspaceUpgrade(w.id); } catch (e) { r = { ok: false, error: e && e.message }; }
  if (!r || !r.ok) { const m = (r && r.error) || 'unknown'; toast('Could not share: ' + humanError(m) + (/(gh|github|auth)/i.test(m) ? ' — connect GitHub first' : '')); return; }
  try { await refreshWorkspaces(); } catch {}
  const up = (workspaces || []).find((x) => x.id === w.id) || w;   // re-fetch the entry (now kind 'repo')
  openInviteModal(up);
}
// repo collaborator invite modal
let inviteWs = null;
function openInviteModal(w) {
  inviteWs = w;
  $('invite-repo').textContent = w.owner ? (w.owner + '/' + w.slug) : w.slug;
  $('invite-name-in').value = ''; $('invite-busy').textContent = ''; $('invite-busy').classList.remove('err');
  $('invite-modal').classList.add('show');
  setTimeout(() => $('invite-name-in').focus(), 60);
}
function closeInviteModal() { $('invite-modal').classList.remove('show'); inviteWs = null; }
async function doInvite() {
  if (!inviteWs) return;
  if ($('invite-go').disabled) return;
  const u = $('invite-name-in').value.trim();
  const busy = $('invite-busy'); busy.classList.remove('err');
  if (!u) { busy.textContent = 'enter a GitHub username'; busy.classList.add('err'); return; }
  busy.textContent = 'sending invite…'; $('invite-go').disabled = true;
  let r = null; try { r = await claudible.repoInvite(inviteWs.id, u); } catch {}
  $('invite-go').disabled = false;
  if (r && r.ok) busy.textContent = '✓ invited ' + u + ' — they need to accept on GitHub';
  else { busy.textContent = (r && r.error) ? humanError(r.error) : 'invite failed'; busy.classList.add('err'); }
}
// sessions sync: manual "sync now" (when already on); state arrives via the sync:state event from main.
async function triggerSyncNow(w) {
  wsSyncState[w.id] = Object.assign({}, wsSyncState[w.id], { status: 'syncing' }); renderWsChips();
  let r = null; try { r = await claudible.syncNow(w.id); } catch {}
  // 'sync-busy' = the poll already has this workspace's lock; our sync is redundant, not failed. Don't paint red.
  if (r && !r.ok && r.error !== 'sync-busy') { wsSyncState[w.id] = { status: 'error' }; renderWsChips(); }
}
// turn sharing OFF (right-click the cloud) — stops publishing; already-committed history stays in the repo
async function disableSync(w) {
  let r = null; try { r = await claudible.syncSetEnabled(w.id, false); } catch {}
  if (r && r.ok) { w.syncSessions = false; delete wsSyncState[w.id]; renderWsChips(); updateCollab(); }   // sync off → collab off (drops the tunnel if no web link)
}
// one-time consent modal before turning sharing on (it commits transcripts to the repo)
let syncWs = null;
function openSyncModal(w) {
  syncWs = w;
  $('sync-repo').textContent = w.owner ? (w.owner + '/' + w.slug) : w.slug;
  $('sync-busy').textContent = ''; $('sync-busy').classList.remove('err'); $('sync-go').disabled = false;
  $('sync-modal').classList.add('show');
}
function closeSyncModal() { $('sync-modal').classList.remove('show'); syncWs = null; }
async function confirmSync() {
  if (!syncWs || $('sync-go').disabled) return;
  const w = syncWs, busy = $('sync-busy');
  busy.classList.remove('err'); busy.textContent = 'setting up sharing…'; $('sync-go').disabled = true;
  let r = null; try { r = await claudible.syncSetEnabled(w.id, true); } catch {}
  $('sync-go').disabled = false;
  if (r && r.ok) { w.syncSessions = true; wsSyncState[w.id] = { status: 'syncing' }; closeSyncModal(); await refreshWorkspaces(); updateCollab(); }   // sync on → a peer can now Join live
  else { busy.textContent = (r && r.error) ? humanError(r.error) : 'could not turn on sharing'; busy.classList.add('err'); }   // r.error may be a bare code ('sync-busy') — never paint one into the modal
}
let firstRunHandled = false, firstRunActive = false;
// "Never delete the last local project" exists so there is always somewhere to open. An ADOPTED project is only
// a POINTER at a folder the user already owned — removing it deletes nothing — so the rule that guards a real
// folder must not lock it in place. (First-run repro: adopt a folder, the auto-created "Local" placeholder is
// then removed as redundant, and the adopted entry becomes the only kind:'local' one → un-removable forever.)
// It may go whenever some other openable project remains; an un-cloned invite has no folder, so it doesn't count.
function isLastLocal(w) {
  if (!w) return false;
  if (w.adopted) return !workspaces.some((x) => x.id !== w.id && (x.kind === 'local' || (x.kind === 'repo' && !x.needsClone)));
  return w.kind === 'local' && workspaces.filter((x) => x.kind === 'local').length <= 1;
}
// One sentence for both delete affordances (the ▾ menu and the chip's right-click), so they can never disagree
// about whether the folder survives.
function deleteWsPrompt(w) {
  return w.adopted
    ? 'Remove "' + w.label + '" from Claudible?\nThis only stops tracking the folder as a project — nothing on disk is moved or deleted.'
    : 'Delete project "' + w.label + '"?\nIts folder moves to ~/.claudible/trash and is kept for 30 days. A repo project keeps its GitHub repo — only the local copy is removed.';
}
// First launch (no local workspace existed → main materialized a default): once, welcome the user and open the
// workspace setup modal so they name + place their Local workspace. Clearing the flag means it shows only once.
function maybeFirstRun(r) {
  if (firstRunHandled || !r || !r.firstRun) return;
  firstRunHandled = true; firstRunActive = true;
  try { claudible.workspaceFirstRunDone && claudible.workspaceFirstRunDone(); } catch (e) {}
  try { toast('Welcome — name your project and pick where to keep it'); } catch (e) {}
  setTimeout(() => { try { openWsModal(); } catch (e) {} }, 450);
}
async function refreshWorkspaces() {
  let r = null; try { r = await claudible.workspaceList(); } catch {}
  if (r && Array.isArray(r.workspaces)) {
    workspaces = r.workspaces;
    // Adopt main's activeId only when it doesn't fight the tab the user is LOOKING at. The active tab's ws is
    // the richer truth: a joined live tab's ws is invisible to main (it never re-points activeWorkspace), and a
    // just-switched tab is ahead of main's registry for one IPC beat — snapping to registry.activeId in either
    // case silently re-nested the sidebar's session list under the WRONG workspace header (part of the
    // "projects show each other's sessions" bug). Boot (unbound tab) and create/delete (tab already re-pointed
    // to the same id) still adopt as before.
    const tabWs = AT() && AT().wsId;
    if (r.activeId && (!tabWs || tabWs === r.activeId)) activeWsId = r.activeId;
  }
  const at = AT(); if (at && !at.wsId) at.wsId = activeWsId;   // bind the boot tab to the real active workspace
  renderWsChips();
  maybeFirstRun(r);
}
// Paint a workspace's saved session rows from warm cache the instant we switch to it, so the sidebar never
// flashes the OLD workspace's rows or a blank gap while the live fetch is in flight. Two things the old inline
// pre-fill got wrong (the "sidebar glitches / cuts sessions out on switch" report):
//   * it sorted by `used`/mtime while the authoritative render (refreshSessions) sorts by mergeSessionOrder's
//     shared `created` order — so every pre-filled row visibly REORDERED the moment real data landed. Match it.
//   * a cold cache cleared to BLANK, then refreshSessions showed "loading…", then content — two flashes. Show a
//     single clean "loading…" instead.
// activeWsId MUST already be the new id here (orderKey/getOrder key off it). refreshSessions still runs after and
// replaces this with authoritative rows; _sessSig='' forces that real render (the ws — part of the sig — changed).
function primeSessionListForWs(id) {
  if (!sessListEl) return;
  _sessSig = '';
  const pf = _wsSessCache.get(id);
  const raw = pf && Array.isArray(pf.list) ? pf.list.filter((s) => (s.msgs || 0) > 0 || hasExplicitTitle(s.id, id)) : null;   // same stub rule as refreshSessions
  if (raw && raw.length) {
    sessIndex = {}; raw.forEach((s) => { sessIndex[s.id] = s; }); sessIndexWs = id;
    const ordered = orderedSessionsFor(id, raw);   // THE one ordering — same helper as refreshSessions + the tree, keyed by the TARGET ws (not ambient getOrder())
    sessListEl.innerHTML = '';
    ordered.forEach((s) => sessListEl.appendChild(renderSessionRow(s)));
  } else {
    sessListEl.innerHTML = '<div class="sess-empty">loading…</div>';
  }
}
// Switching the workspace re-points the FOREGROUND tab to that ws (main respawns its pty in the new cwd).
// Background tabs in other workspaces keep running. (New session / + opens a fresh tab instead.)
async function switchWorkspace(id, targetSession) {
  if (id === activeWsId) { if (targetSession) openSession(targetSession); return; }   // already here → just open the session (no full switch, no flicker)
  let t = AT();
  if (t && t.kind === 'live') {                     // viewing a peer's session — a workspace switch applies to YOUR own tab, never the live mirror
    const local = [...tabs.values()].find((r) => r.kind !== 'live' && r.wsId === id) || [...tabs.values()].find((r) => r.kind !== 'live');   // prefer a tab ALREADY in the target workspace — grabbing the first non-live tab re-pointed an unrelated tab (stranding ITS workspace expanded-but-inactive, whose sessions then repaint via the thin tree rows = "the old style")
    if (!local) { toast('Open one of your own sessions first'); return; }
    setActiveTab(local.tabId); t = local;
  }
  if (!t) return;
  // Two tabs must never be recycled by a project switch, for the same reason: main's workspace:open respawns the
  // foreground pty, and a respawn KILLS what was running in it.
  //   * BUSY — that would kill a mid-turn Claude.
  //   * LIVE-SHARED — that would kill the conversation guests are watching. This is the path `openSession` has
  //     guarded since sessions became tabs; switchWorkspace never got the same check, so clicking a project chip
  //     (or an "out of sync" chip on another project's row, which switches first) ended the live session.
  // Either way: open the target in a NEW tab and leave this one running. main refuses the reroute regardless.
  if (t.busy || t.tabId === sharedTabIdR) {
    if (targetSession && targetSession !== 'new') {        // dedupe: a tab may already host it (newBlankTab never checks)
      for (const rec of tabs.values()) if (rec.kind !== 'live' && rec.wsId === id && rec.session === targetSession) { setActiveTab(rec.tabId); return; }
    }
    const tws = workspaces.find((w) => w.id === id);
    if (tws && tws.kind === 'repo' && tws.needsClone) { openAcceptInviteModal(tws); return; }   // no clone gate on the tab:open path — clone first
    setWsExpanded(id, true);                                                  // expand it like the normal switch does, so its sessions are right there
    if (!newBlankTab(id, targetSession || 'new')) {
      if (t.busy) toast('That session is still running — finish it or close a tab before switching');
      else toast('This tab is live-shared — close a tab to open that project beside it');
    }
    return;
  }
  const sess = targetSession || '';                 // open this session DIRECTLY in the new workspace (ONE respawn) — not "resume latest, then re-point" (two respawns = the cross-workspace flicker)
  // The sidebar is repainted OPTIMISTICALLY (that's what keeps the switch flicker-free), so remember what this tab
  // actually held: main's rec.busy is authoritative and can refuse the re-point in a race the guards above can't see.
  const prev = { wsId: t.wsId, session: t.session, label: t.label, curSessionLabel: t.curSessionLabel, pendingTitle: t.pendingTitle };
  activeWsId = id; t.wsId = id; t.session = sess; t.pendingTitle = null; t.label = (sess === 'new') ? 'New session' : '';   // switching ws drops a stale pending name (typed for a new session in the OLD ws) so it can't be published onto a session in the NEW ws
  setWsExpanded(id, true);                          // switching to a workspace auto-expands it (you can collapse it again with its chevron)
  activeSession = (sess && sess !== 'new') ? sess : null; t.curSessionLabel = (sess === 'new') ? 'New session' : '';
  lastTitlePoll = 0; titlesSig = '';               // force a fresh shared-names fetch for the new workspace
  primeSessionListForWs(id);                       // paint the new ws's rows from warm cache in the AUTHORITATIVE order (no blank gap, no reorder jump) before the live fetch lands
  renderWsChips();
  let failed = false, kept = false;
  try {
    const r = await claudible.workspaceOpen(id, sess);
    if (r && r.ok === false && r.error !== 'superseded') { failed = true; toast('Could not switch project' + (r.error ? ': ' + humanError(r.error) : '')); }
    else kept = !!(r && r.keptTab);
  } catch (e) { failed = true; toast('Could not switch project'); }
  // Undo the OPTIMISTIC repaint when the switch didn't actually re-point this tab. Restoring only the tab
  // record isn't enough: activeWsId/activeSession and the sidebar still claim the TARGET workspace while the
  // active tab's pty never left the old one — the ws-scope-desync class (every ws-keyed surface, session list
  // included, silently re-scopes to a project the tab never entered). Roll the globals back to the tab's truth.
  const rollBack = () => {
    Object.assign(t, prev);
    activeWsId = prev.wsId;
    activeSession = (prev.session && prev.session !== 'new') ? prev.session : null;
    lastTitlePoll = 0; titlesSig = '';
    primeSessionListForWs(prev.wsId); renderWsChips(); refreshSessions();
  };
  if (kept) {
    // main declined to re-point this tab's pty — a turn started inside the race window, or `share:pinned` hadn't
    // reached us yet. Its pty never moved, so put the RECORD back (a tab claiming a workspace its process isn't in
    // orphans the sidebar highlight forever) and give the project a tab of its own, exactly like the guards above.
    Object.assign(t, prev);                        // restore BEFORE newBlankTab — its setActiveTab repaints synchronously and must not see the optimistic record
    if (newBlankTab(id, sess || 'new')) return;    // new tab in the target ws is now active → globals correctly point there
    toast('That session is still running — close a tab to open that project beside it');
    rollBack();                                    // no new tab either → the ACTIVE tab is still `t`, so the globals must follow it back
    return;
  }
  if (failed) { rollBack(); setTimeout(() => { if (term) term.focus(); }, 150); return; }
  t.term.reset(); resetStats(t);                   // clear the view only for a switch that ACTUALLY re-pointed this tab's pty
  refreshSessions();
  setTimeout(() => { if (term) term.focus(); }, 150);
}
// new-workspace chooser modal
let wsChoiceKind = 'local';
// The New-project radiogroup, in DOM order. 'repo' was deliberately REMOVED as a creation-time choice: every
// project starts plain, and becomes synced/shared later via the ▾ menu (upgradeWorkspace / inviteToLocal /
// openSyncModal — all pre-existing, consented flows). The repo plumbing itself stays fully alive in main.js +
// create-workspace.sh for invites, discovery, and the upgrade path; contract check 13 pins both halves.
const WS_KINDS = ['local', 'adopt'];
function selectWsKind(kind) {
  wsChoiceKind = kind;
  WS_KINDS.forEach((k) => {
    const el = $('ch-' + (k === 'adopt' ? 'adopt' : k)); if (!el) return;
    el.classList.toggle('sel', kind === k);
    el.setAttribute('aria-checked', kind === k ? 'true' : 'false');   // keep the radio state screen-reader-truthful
  });
  const pr = $('ws-pick-row'); if (pr) pr.style.display = (kind === 'local') ? '' : 'none';   // custom folder is local-only
  const nt = $('ws-adopt-note'); if (nt) nt.style.display = (kind === 'adopt') ? 'block' : 'none';
  // Adopting takes its name from the folder you pick, so the name field is optional there.
  const nm = $('ws-name-in');
  if (nm) nm.placeholder = (kind === 'adopt') ? 'Project name (optional — defaults to the folder’s name)' : 'Project name (letters, numbers, dashes)';
  const btn = $('ws-create'); if (btn) btn.textContent = (kind === 'adopt') ? 'Choose folder…' : 'Create';
}
function openWsModal() {
  selectWsKind('local');
  $('ws-name-in').value = ''; $('ws-busy').textContent = ''; $('ws-busy').classList.remove('err');
  if ($('ws-pick')) $('ws-pick').checked = false;
  $('ws-modal').classList.add('show');
  setTimeout(() => $('ws-name-in').focus(), 60);
}
function closeWsModal() { $('ws-modal').classList.remove('show'); firstRunActive = false; }
async function createWorkspace() {
  if ($('ws-create').disabled) return;                      // in-flight guard (the Enter key can bypass the disabled button)
  const name = $('ws-name-in').value.trim();
  const busy = $('ws-busy'); busy.classList.remove('err');
  const adopt = wsChoiceKind === 'adopt';
  if (!name && !adopt) { busy.textContent = 'enter a name first'; busy.classList.add('err'); return; }   // adopt names itself from the folder
  const pick = wsChoiceKind === 'local' && $('ws-pick') && $('ws-pick').checked;   // custom folder (local only)
  busy.textContent = (adopt || pick) ? 'choose a folder…' : 'creating folder…';
  $('ws-create').disabled = true;
  let r = null;
  try { r = adopt ? await claudible.workspaceAdopt(name) : await claudible.workspaceCreate(wsChoiceKind, name, pick); } catch {}
  $('ws-create').disabled = false;
  if (r && !r.ok && r.error === 'cancelled') { busy.textContent = ''; return; }   // they closed the folder picker — not an error
  if (!r || !r.ok) { busy.textContent = (r && r.error) ? humanError(r.error) : (adopt ? 'could not add that folder' : 'creation failed'); busy.classList.add('err'); return; }
  const wasFirstRun = firstRunActive; firstRunActive = false;
  if (r.note) { try { toast(r.note); } catch {} }   // honest partial-success (e.g. repo created but the discovery marker push failed)
  if (adopt) {
    // Say what actually happened to their folder — the one thing a user adopting a real repo needs to know.
    if (r.already) toast('That folder is already a project — opened it.');
    else if (r.claudeTracked) toast('Added. Heads up: .claude/ is tracked by git in that repo, so Claudible’s runtime files will show up as changes.');
    else if (r.repo) toast('Added ' + ((r.workspace && r.workspace.label) || 'project') + ' — nothing was moved, and .claude/ is ignored locally.');
    else toast('Added ' + ((r.workspace && r.workspace.label) || 'project') + ' — nothing was moved.');
  }
  closeWsModal();                                   // main already switched the foreground tab + respawned a fresh conversation
  const newWsId = (r.workspace && r.workspace.id) || activeWsId;
  // superseded: a repo clone runs for minutes, a folder picker for as long as the user stares at it. If they moved
  // to another tab meanwhile, main touched NOTHING — so neither may we. Repainting `AT()` here (which is no longer
  // the tab this create was for) cleared an unrelated running tab's terminal and relabelled it "New session".
  // keptTab: main declined to re-point the foreground tab — it's mid-turn, or it's the live-shared one. Its pty
  // never moved, so calling it "New session" would be a lie. Give the new project a tab of its own instead.
  // (Both skip the first-run placeholder cleanup below on purpose: on first run there is one idle, unshared tab
  // and no time to switch away, so neither flag can be set alongside wasFirstRun.)
  if (r.superseded || r.keptTab) {
    activeWsId = newWsId;
    await refreshWorkspaces();
    if (r.keptTab) {
      if (!newBlankTab(newWsId, 'new')) toast('Project added — close a tab to open it (this one is still running)');
    }
    refreshSessions();
    return;
  }
  { const t = AT(); if (t) { t.wsId = newWsId; t.session = 'new'; t.label = 'New session'; t.curSessionLabel = 'New session'; t.term.reset(); resetStats(t); } }
  activeSession = null;
  await refreshWorkspaces();
  // first-run: the workspace they just made replaces the auto-created "Local" placeholder — remove it now that
  // another local exists (the >=1-local invariant still holds). (Every modal creation is kind 'local' now — blank
  // or adopted — so on first run this always applies; the guard stays because an invited-repo landing can't count.)
  if (wasFirstRun && workspaces.some((w) => w.id === 'local-local') && workspaces.filter((w) => w.kind === 'local').length >= 2) {
    try { await claudible.workspaceDelete('local-local'); await refreshWorkspaces(); } catch (e) {}
  }
  refreshSessions();
  setTimeout(() => { if (term) term.focus(); }, 150);
}
$('ws-add').addEventListener('click', openWsModal);
// "Check for invites" — discovery also re-runs on window focus, but this is the immediate manual path for
// "I just accepted MK's invite on GitHub, show it now". onWorkspaceAdded repaints the list when it finds one.
if ($('ws-discover')) $('ws-discover').addEventListener('click', async () => {
  const b = $('ws-discover'); if (b.disabled) return;
  b.disabled = true; const was = b.textContent; b.textContent = 'checking…';
  let r = null; try { r = await claudible.discoverWorkspaces(); } catch {}
  b.disabled = false; b.textContent = was;
  if (r && r.ok) toast(r.added ? ('Found ' + r.added + ' invited project' + (r.added > 1 ? 's' : '')) : 'No new invites — you’re all caught up');
  else if (r && r.reason === 'gh-auth') toast('Connect GitHub first (Settings → GitHub) — invites can’t be checked without it');   // R31: "can't look" ≠ "all caught up"
  else if (r && r.reason === 'gh-missing') toast('The GitHub CLI isn’t installed — run the System check to set it up, then try again');
  else toast('Couldn’t check for invites');
});
// keyboard access for the radio-style picker: Enter/Space selects; arrows move through the group (standard radiogroup keys)
WS_KINDS.forEach((k, i) => {
  const el = $('ch-' + k); if (!el) return;
  el.addEventListener('click', () => selectWsKind(k));
  el.addEventListener('keydown', (e) => {
    const step = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 0;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectWsKind(k); }
    else if (step) {
      e.preventDefault();
      const nk = WS_KINDS[(i + step + WS_KINDS.length) % WS_KINDS.length];
      selectWsKind(nk); $('ch-' + nk).focus();
    }
  });
});
$('ws-create').addEventListener('click', createWorkspace);
$('ws-cancel').addEventListener('click', closeWsModal);
$('ws-name-in').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); createWorkspace(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeWsModal(); }
});
$('invite-go').addEventListener('click', doInvite);
$('invite-cancel').addEventListener('click', closeInviteModal);
$('sync-go').addEventListener('click', confirmSync);
$('sync-cancel').addEventListener('click', closeSyncModal);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('sync-modal').classList.contains('show')) { e.preventDefault(); closeSyncModal(); } });   // Esc closes the sync modal, matching its siblings
// live sync state from main → repaint the cloud button; refresh the switcher when sessions changed
claudible.onSyncState((s) => {
  if (!s || !s.id) return;
  const u = { status: s.status };                 // merge so a 'syncing' tick doesn't wipe the last counts
  if (s.synced != null) u.synced = s.synced;
  if (s.diverged != null) u.diverged = s.diverged;
  wsSyncState[s.id] = Object.assign({}, wsSyncState[s.id], u);
  renderWsChips();
});
claudible.onSyncChanged((s) => {
  if (!s || !s.id) return;
  _wsSessCache.delete(s.id);                                          // pulled changes are on disk now → any cached session list for this ws is stale; drop it so the switch-away pre-fill + non-active tree can't serve pre-sync rows
  if (s.id === activeWsId) { refreshSessions(); try { pollTitles(true); } catch (e) {} }   // a pull that changed anything also refreshes shared titles immediately (renames land on the next sync, not the next 20s poll)
  else { refreshWsSubtree(s.id); }                                    // a non-active but EXPANDED project must update in place too — not only when you next switch into it
  // Repo Review (diff + history feed) was never wired to sync: a pulled commit/revert only showed after switching
  // away and back. Refresh it now (no-op when the drawer is closed / the card is collapsed).
  try { refreshDiff({ quiet: true }); } catch (e) {}
});
// Main respawned an open tab because a sync replaced its transcript on disk (the "out of sync doesn't
// update the open session" fix). Mirror openSession's respawn housekeeping for THAT tab — clear the xterm
// (else the resume replay lands on top of stale scrollback), reset the scroll estimate, and reset the
// tracker baselines (token/cost state belongs to the old transcript) — then tell the user why it reloaded.
if (claudible.onSessionReloaded) claudible.onSessionReloaded((s) => {
  const t = tabs.get(s && s.tabId);
  if (t) { try { t.term.reset(); } catch {} t.altFrac = 0; resetStats(t); }
  toast('Session updated with synced changes');
  refreshSessions();
});
claudible.onWorkspaceAdded(() => { refreshWorkspaces(); });
$('invite-name-in').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); doInvite(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeInviteModal(); }
});
// The live workspace changed under main's control (a guest clicked a granted chip, or a workspace was
// deleted). The payload names the tab main ACTUALLY re-pointed — with the mirror pinned, that can be a
// BACKGROUND shared tab while the host views something else entirely, so resetting AT() here wiped an
// unrelated private tab's terminal/record (audit finding). Reset only the named tab.
claudible.onWorkspaceActiveChanged((p) => {
  const id = p && typeof p === 'object' ? p.id : p;
  const tabId = p && typeof p === 'object' ? p.tabId : null;
  const global = !(p && typeof p === 'object') || p.global !== false;   // global:false = a guest switched the (backgrounded) shared tab — reset THAT tab's record, but the host's sidebar scope stays put
  if (id == null) return;
  const t = (tabId != null && tabs.get(tabId)) || null;
  const tabNeeds = !!(t && (t.wsId !== id || t.session || t.label));    // the re-pointed tab's record is stale vs its fresh pty
  const globalNeeds = global && id !== activeWsId;
  if (!tabNeeds && !globalNeeds) return;                                // duplicate event → nothing to do
  if (globalNeeds) { activeWsId = id; lastTitlePoll = 0; titlesSig = ''; }
  if (tabNeeds) {
    t.wsId = id; t.session = ''; t.label = ''; t.curSessionLabel = ''; t.term.reset(); resetStats(t);
    if (t.tabId === activeTabId) activeSession = null;   // the re-pointed tab is the one on screen → its highlight resets too
  }
  refreshWorkspaces(); refreshSessions();
  try { if (globalNeeds && $('diffpanel') && $('diffpanel').classList.contains('open')) { refreshHistoryFeed(); refreshDiff(); } } catch {}   // Repo Review open → keep its feed + diff on the workspace we just switched to (don't let it show the old ws)
});

$('sessions-btn').addEventListener('click', () => openSidebar(!bodyEl.classList.contains('with-sessions')));
$('sidebar-close').addEventListener('click', () => openSidebar(false));
$('new-session').addEventListener('click', async () => {                            // a NEW tab — never clears the current session
  const name = await modalPrompt({ title: 'Name this session', body: 'Give it a clear name so it’s easy to find later — you can rename it anytime.', placeholder: 'e.g. auth refactor, bug #214…', ok: 'Create session' });
  if (name === null) return;                                                         // Cancel / Esc → don't create
  if (!newBlankTab(activeWsId, 'new', name || '')) toast('Tab limit reached (' + MAX_TABS + ') — close a tab first');   // empty (just hit Create) → unnamed, like before
});
// One-time migration: conversation order moved from the flat `sessionOrder` key to per-workspace
// `wsOrder_<id>`; carry the legacy arrangement over so it isn't lost on first launch after upgrade.
{ const _p = loadPrefs(); if (_p.sessionOrder && !_p.wsOrder_legacy) savePrefs({ wsOrder_legacy: _p.sessionOrder }); }
// Seed + activate the first tab ('main' — matches main.js's spawn fallback id) NOW that every const/helper
// it touches is defined. sidebarReady is still false here, so setActiveTab skips the sidebar refresh; the
// async loader below does workspaces + sessions once. (term resolves; the foreground pty starts fitted.)
makeTab('main', null, '');
setActiveTab('main');
sidebarReady = true;   // the sessions/workspace section is now fully initialized — tab switches may refresh the sidebar
(async () => { await refreshWorkspaces(); refreshSessions(); })();   // load workspaces first, then this workspace's conversations

// ---------- desktop clipboard shortcuts (Ctrl on Win/Linux, ⌘ on Mac) ----------
// In the TERMINAL: Ctrl/⌘+C copies the selection (or passes through as interrupt/SIGINT when nothing
// is selected, like Windows Terminal), Ctrl/⌘+V pastes (bracketed, no auto-submit), Ctrl/⌘+A selects
// all, and Backspace deletes the marked text (sends that many backspaces — reliable when the selection
// ends at your input cursor; with no selection it's a normal one-char backspace). In text fields
// (chat / voice box) the same combos act on the field. Clipboard goes through main so it works
// regardless of web clipboard permissions. Capture phase so we intercept before xterm.
const isMac = /mac/i.test(navigator.platform || navigator.userAgent || '');
window.addEventListener('keydown', (e) => {
  const mod = isMac ? (e.metaKey && !e.ctrlKey && !e.altKey) : (e.ctrlKey && !e.metaKey && !e.altKey);
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const inTerm = e.target && e.target.closest && e.target.closest('#terminal');
  const field = e.target && e.target.closest && e.target.closest('input, textarea');

  if (inTerm) {
    if (mod && k === 'c') {
      const sel = term.getSelection();
      if (sel && sel.length) { e.preventDefault(); e.stopPropagation(); claudible.clipWrite(sel); }
      return;                                   // empty selection → let Ctrl+C through as interrupt
    }
    if (mod && k === 'v') {
      e.preventDefault(); e.stopPropagation();
      claudible.clipRead().then((t) => { if (t) { sendInput('\x1b[200~' + t + '\x1b[201~'); term.focus(); } });
      return;
    }
    if (mod && k === 'a') { e.preventDefault(); e.stopPropagation(); term.selectAll(); return; }
    if (k === 'Backspace' && !mod) {
      const sel = term.getSelection();
      if (sel && sel.length) {
        e.preventDefault(); e.stopPropagation();
        sendInput('\x7f'.repeat(sel.length));   // delete the marked text
        term.clearSelection();
      }
      return;                                   // no selection → normal single-char backspace
    }
    return;
  }
  if (field) {
    if (mod && k === 'a') { e.preventDefault(); field.select(); return; }
    if (mod && k === 'c') {
      const s = (field.value || '').substring(field.selectionStart || 0, field.selectionEnd || 0);
      if (s) { e.preventDefault(); claudible.clipWrite(s); }
      return;
    }
    if (mod && k === 'v') {
      e.preventDefault();
      claudible.clipRead().then((t) => { if (t) insertIntoField(field, t); });
      return;
    }
  }
}, true);

// ---------- first-run onboarding wizard: connect Claude → create workspace → link GitHub (optional) ----------
// Shown once (gated on prefs.onboardingDone). Reuses the .approve modal shell. Detection is live via
// claudible.onboardStatus() (one bash probe). Sign-in is browser-OAuth, so Step 1 detects → guides → polls.
// SAFETY (invariant): the wizard is ALWAYS dismissable — a persistent Skip button + Escape route through
// dismiss(), which persists onboardingDone so it can never re-trap. It must never lock a user behind the
// full-screen scrim when a step can't complete (failed install, no runner, offline). Existing users (who
// already have a real workspace) skip the create step so it's never a forced workspace mutation.
(function () {
  const wiz = $('wizard'); if (!wiz || !claudible.onboardStatus) return;
  let step = 1, poll = null, pollSince = 0, signingIn = false, hasWs = false, done = false, ticking = false;
  const status = async () => { try { return await claudible.onboardStatus(); } catch { return null; } };
  function show(n) {
    step = n;
    for (const el of document.querySelectorAll('#wizard .wiz-step')) el.style.display = (+el.dataset.step === n) ? '' : 'none';
    document.querySelectorAll('.wiz-steps .wiz-dot').forEach((d, i) => d.classList.toggle('on', i < n));
  }
  function pollStart() { if (poll || done) return; pollSince = Date.now(); poll = setInterval(tick, 3000); }   // never re-arm after a Skip (done)
  function pollStop() { if (poll) { clearInterval(poll); poll = null; } }
  async function tick() {
    if (done || step !== 2 || ticking) return;   // ticking: never overlap probes (each spawns bash/node/network) — Claude is step 2 (after System check)
    // 6-min cap ONLY for the genuine orphan case: sign-in clicked → wizard HIDDEN to reveal the terminal → user
    // abandons the browser flow. While the wizard is visible there's no orphan risk (Skip/Escape always dismiss),
    // so the cap must not fire during a slow install and stomp its message or kill the poll mid-flow.
    if (signingIn && Date.now() - pollSince > 360000) {
      pollStop(); signingIn = false; if (!wiz.classList.contains('show')) { wiz.classList.add('show'); show(2); }
      const b = $('wiz-claude-busy'); if (b) { b.classList.add('err'); b.textContent = 'Didn’t detect sign-in — try again, or Skip for now.'; } return;
    }
    ticking = true;
    try { const s = await status(); if (s) applyClaude(s); } finally { ticking = false; }
  }
  async function open() {
    try {
      const wl = await claudible.workspaceList();
      const real = ((wl && wl.workspaces) || []).filter((w) => w && w.kind && w.kind !== 'legacy');
      // R23: the registry GUARANTEES a default Local workspace exists at boot (startup needs a cwd), so
      // "some workspace exists" was ALWAYS true and step 3 — naming your first project — was unreachable
      // dead code for every user: the wizard's four dots lied, and every install kept the placeholder name.
      // On a FIRST RUN the auto-created default doesn't count as "the user has a project" (creating a real
      // one triggers the existing placeholder cleanup); any other run keeps the old skip-if-any rule.
      hasWs = real.length > ((wl && wl.firstRun) ? 1 : 0);
    } catch {}
    wiz.classList.add('show'); show(1); refreshSystem();
  }
  function dismiss() { pollStop(); signingIn = false; wiz.classList.remove('show'); if (!done) { done = true; try { savePrefs({ onboardingDone: true, wsHintSeen: true }); } catch {} } }
  function finish() { dismiss(); setTimeout(() => { try { if (term) term.focus(); } catch {} }, 150); }
  function afterClaude() { if (hasWs) goGh(); else show(3); }   // existing users skip the create step (now step 3) — never a forced workspace mutation

  async function refreshClaude() { const s = await status(); if (s) applyClaude(s); }
  function applyClaude(s) {
    const msg = $('wiz-claude-msg'), act = $('wiz-claude-action'), next = $('wiz-claude-next');
    next.textContent = 'Next';   // default label; the not-signed-in branch flips it to 'Continue' (override)
    if (s.claudeSignedIn) {
      msg.textContent = '✓ Claude Code connected' + (s.claudeVersion ? ' (' + s.claudeVersion + ')' : '');
      act.style.display = 'none'; next.disabled = false; pollStop();
      if (signingIn) { signingIn = false; if (!wiz.classList.contains('show')) wiz.classList.add('show'); afterClaude(); }   // returned from sign-in → advance
    } else if (!s.claudeInstalled) {
      msg.textContent = 'Claude Code isn’t installed yet.';
      act.style.display = ''; act.textContent = 'Install Claude Code'; act.onclick = installClaude; next.disabled = true; pollStart();
    } else {
      // Installed but we couldn't CONFIRM sign-in. On native Windows the token may live in the Credential
      // Manager (not ~/.claude/.credentials.json), so this is often a false negative — do NOT trap a user who
      // is actually signed in. Offer Sign in, but ALSO let them Continue (and keep polling: if they do sign in
      // in the terminal, it flips to ✓ on its own).
      msg.textContent = 'Claude Code is installed. If you’re already signed in, just Continue. Not signed in yet? Click “Sign in to Claude”.';
      act.style.display = ''; act.textContent = 'Sign in to Claude'; act.onclick = signIn;
      next.disabled = false; next.textContent = 'Continue';   // override — Windows sign-in isn't always detectable
      pollStart();
    }
  }
  async function installClaude() {
    const b = $('wiz-claude-busy'), a = $('wiz-claude-action');
    a.disabled = true; b.classList.remove('err'); b.textContent = 'Installing Claude Code… (this can take a few minutes)';
    let r; try { r = await claudible.onboardInstallClaude(); } catch (e) { r = { ok: false, error: e && e.message }; }
    a.disabled = false;
    if (r && r.ok) { b.textContent = ''; refreshClaude(); }
    else { b.classList.add('err'); b.textContent = 'Install failed: ' + ((r && r.error) || 'unknown') + ' — retry, or Skip for now.'; }
  }
  async function signIn() {
    const b = $('wiz-claude-busy'); b.classList.remove('err'); b.textContent = 'Opening Claude — complete sign-in in the terminal/browser…';
    signingIn = true; pollStart(); pollSince = Date.now();   // anchor the 6-min abandon budget at THIS OAuth hand-off, not at first detection (slow installs mustn't burn it)
    try { await claudible.onboardClaudeLogin(); } catch {}
    wiz.classList.remove('show');   // reveal the terminal; the poll re-shows the wizard once signed in (or after the 6-min cap)
  }

  async function createWs() {
    if ($('wiz-ws-create').disabled) return;                  // in-flight guard (Enter can bypass the disabled button)
    const b = $('wiz-ws-busy'), btn = $('wiz-ws-create');
    const name = ($('wiz-ws-name').value || '').trim() || 'My Project';
    btn.disabled = true; b.classList.remove('err'); b.textContent = 'Creating project…';
    let r; try { r = await claudible.workspaceCreate('local', name, false); } catch (e) { r = { ok: false, error: e && e.message }; }
    btn.disabled = false;
    if (r && !r.ok && /already exists/i.test(r.error || '')) { b.textContent = ''; goGh(); return; }   // a prior run made it → just continue (no dead-end)
    if (!r || !r.ok) { b.classList.add('err'); b.textContent = (r && r.error) ? humanError(r.error) : 'Could not create the project.'; return; }
    b.textContent = '';
    // mirror createWorkspace()'s post-create reconcile so the foreground tab points at the NEW ws (else its
    // session list / live tracking key off the old ws — a sidebar desync immediately after onboarding).
    { const t = AT(); if (t) { t.wsId = (r.workspace && r.workspace.id) || activeWsId; t.session = 'new'; t.label = 'New session'; t.curSessionLabel = 'New session'; try { t.term.reset(); } catch {} resetStats(t); } }
    activeSession = null;
    try { await refreshWorkspaces(); } catch {}
    try { refreshSessions(); } catch {}
    goGh();
  }

  async function goGh() { show(4); const s = await status(); if (s) applyGh(s); }
  function applyGh(s) {
    const msg = $('wiz-gh-msg'), rc = $('wiz-gh-recheck');
    if (s.ghSignedIn) { msg.textContent = '✓ GitHub connected' + (s.ghAccount ? ' (@' + s.ghAccount + ')' : ''); rc.style.display = 'none'; }
    else { msg.textContent = 'GitHub isn’t connected yet — connect it to sync your projects across devices and invite people. In a terminal run:  gh auth login  (choose “Login with a web browser”), approve it, then click Re-check.'; rc.style.display = ''; }
  }

  // ---- System check (step 1): detect every dependency, install the missing ones --------------------
  // Rows come from preflight:status (deps.detect). Required infra (node/git) must be present to advance;
  // claude need only be INSTALLED here — its sign-in is the dedicated next step. Optional deps never block.
  // Skip/Escape still dismiss at any time (the wizard invariant), so a failed/unavailable install never traps.
  let depRows = [], restartNeeded = false;
  // Per-dependency message text (id -> {text, err}), rendered under THAT row — NOT one shared box. "Install
  // all missing" installs sequentially, and a single shared status line meant dep #2's result erased dep #1's
  // just-shown, sometimes-actionable message (a real copy-paste command) before anyone could read it.
  let depMsgs = {};
  const SYS_PILL = { ready: 'ready', missing: 'missing', outdated: 'update', installing: 'installing…', signin: 'sign in', unconfirmed: 'check', error: 'failed' };
  const sysInstallable = (d) => d.installable && (d.state === 'missing' || d.state === 'outdated' || d.state === 'error');
  const sysBlocking = (d) => d.required && !(d.state === 'ready' || (d.id === 'claude' && (d.state === 'unconfirmed' || d.state === 'signin')));
  // Update one row's message live (during an in-flight install) without waiting for a full renderSystem() rebuild.
  function setDepMsg(id, msg, err) {
    if (msg) depMsgs[id] = { text: msg, err: !!err }; else delete depMsgs[id];
    const r = document.querySelector('#wiz-dep-list .dep-row[data-dep="' + id + '"]'); if (!r) return;
    const main = r.querySelector('.dep-main'); if (!main) return;
    let m = main.querySelector('.dep-msg');
    if (!msg) { if (m) m.remove(); return; }
    if (!m) { m = document.createElement('div'); m.className = 'dep-msg'; main.appendChild(m); }
    m.classList.toggle('err', !!err);
    m.textContent = msg;
  }
  function setSysPill(id, cls, text) { const r = document.querySelector('#wiz-dep-list .dep-row[data-dep="' + id + '"]'); if (!r) return; const p = r.querySelector('.dep-pill'); if (p) { p.className = 'dep-pill ' + cls; p.textContent = text; } }
  function disableSysActs(on) { document.querySelectorAll('#wiz-dep-list .dep-act').forEach((b) => { b.disabled = on; }); const i = $('wiz-sys-install'); if (i) i.disabled = on; }
  async function refreshSystem() {
    const list = $('wiz-dep-list'); if (!list) return;
    let r; try { r = await claudible.preflightStatus(); } catch { r = null; }
    // The probe couldn't run at all. Without this, every dependency row rendered "missing" — six separate failures
    // for one cause the user was never told, and no discoverable way forward.
    if (r && r.unavailable) {
      list.innerHTML = ''; const d = document.createElement('div'); d.className = 'wiz-dim';
      d.textContent = r.unavailable === 'wsl'
        ? 'Claudible can’t reach WSL, so it can’t check anything else. Install WSL2 (PowerShell, as admin: wsl --install), restart, and reopen Claudible. Everything below depends on it.'
        : 'Claudible can’t run its setup shell, so it can’t check anything else.';
      list.appendChild(d);
      const n = $('wiz-sys-next'); n.disabled = false; n.textContent = 'Next'; $('wiz-sys-install').style.display = 'none'; return;
    }
    if (!r || !Array.isArray(r.deps) || !r.deps.length) {
      list.innerHTML = ''; const d = document.createElement('div'); d.className = 'wiz-dim';
      d.textContent = 'Couldn’t run the system check — you can Skip and set things up manually.';
      list.appendChild(d); const n = $('wiz-sys-next'); n.disabled = false; n.textContent = 'Next'; $('wiz-sys-install').style.display = 'none'; return;
    }
    depRows = r.deps; renderSystem();
  }
  function renderSystem() {
    const list = $('wiz-dep-list'); if (!list) return; list.innerHTML = '';
    let anyInstallable = false, blocking = 0;
    for (const d of depRows) {
      if (d.state === 'ready') delete depMsgs[d.id];   // a leftover failure message about a now-fixed dep is stale noise
      if (sysBlocking(d)) blocking++;
      const row = document.createElement('div'); row.className = 'dep-row'; row.dataset.dep = d.id;
      const main = document.createElement('div'); main.className = 'dep-main';
      const name = document.createElement('div'); name.className = 'dep-name'; name.textContent = d.label;
      if (!d.required) { const o = document.createElement('span'); o.className = 'wiz-opt'; o.textContent = 'optional'; name.appendChild(document.createTextNode(' ')); name.appendChild(o); }
      const detail = (d.id === 'gh' && d.state === 'ready' && d.account) ? ('@' + d.account) : d.version;
      if (detail) { const v = document.createElement('span'); v.className = 'wiz-dim'; v.style.marginLeft = '6px'; v.textContent = detail; name.appendChild(v); }
      const hint = document.createElement('div'); hint.className = 'dep-hint'; hint.textContent = d.hint || '';
      main.appendChild(name); main.appendChild(hint);
      const dm = depMsgs[d.id];
      if (dm) { const mEl = document.createElement('div'); mEl.className = 'dep-msg' + (dm.err ? ' err' : ''); mEl.textContent = dm.text; main.appendChild(mEl); }
      const pill = document.createElement('span'); pill.className = 'dep-pill ' + d.state; pill.textContent = SYS_PILL[d.state] || d.state;
      row.appendChild(main); row.appendChild(pill);
      if (sysInstallable(d)) { anyInstallable = true; const b = document.createElement('button'); b.className = 'dep-act'; b.textContent = 'Install'; b.onclick = () => installDep(d.id); row.appendChild(b); }
      list.appendChild(row);
    }
    $('wiz-sys-install').style.display = anyInstallable ? '' : 'none';
    const next = $('wiz-sys-next');
    if (restartNeeded) { next.disabled = false; next.textContent = 'Restart now'; }
    else { next.disabled = blocking > 0; next.textContent = blocking > 0 ? 'Install required to continue' : 'Next'; }
  }
  async function installDep(id) {
    setSysPill(id, 'installing', 'installing…'); disableSysActs(true); setDepMsg(id, '');
    let r; try { r = await claudible.preflightInstall(id); } catch (e) { r = { ok: false, error: e && e.message }; }
    disableSysActs(false);
    if (r && r.restartRequired) { restartNeeded = true; setSysPill(id, 'ready', 'installed'); setDepMsg(id, 'Installed. Claudible needs a quick restart to finish.'); const n = $('wiz-sys-next'); n.disabled = false; n.textContent = 'Restart now'; return; }
    if (!r || !r.ok) {
      setSysPill(id, 'error', 'failed');
      setDepMsg(id, installErrText(r && r.error), true);   // shared filter (R18) — raw exec-crash internals never reach the row; real script errors show in full
      return;
    }
    await refreshSystem();
  }
  async function installAllMissing() {
    disableSysActs(true);
    const ids = depRows.filter(sysInstallable).map((d) => d.id);   // manifest order → node before claude, uv before voice
    for (const id of ids) { await installDep(id); if (restartNeeded) break; }
    disableSysActs(false);
  }
  function sysNext() { if (restartNeeded) { try { claudible.preflightRestart(); } catch {} return; } show(2); refreshClaude(); }
  // live per-dep install progress (a SECOND onProvision listener; the voice chip's is guarded to dep==='voice')
  if (claudible.onProvision) claudible.onProvision((m) => {
    if (!m || !m.dep) return;
    const cls = m.phase === 'done' ? 'ready' : m.phase === 'error' ? 'error' : 'installing';
    const txt = m.phase === 'done' ? 'ready' : m.phase === 'error' ? 'failed' : 'installing…';
    setSysPill(m.dep, cls, txt);
    if (step === 1 && m.msg) setDepMsg(m.dep, m.phase === 'error' ? installErrText(m.msg) : m.msg, m.phase === 'error');   // the streamed path shows the same filtered text as the click path (R18)
  });

  $('wiz-sys-next').addEventListener('click', sysNext);
  $('wiz-sys-install').addEventListener('click', installAllMissing);
  $('wiz-claude-next').addEventListener('click', afterClaude);
  $('wiz-ws-back').addEventListener('click', () => show(2));
  $('wiz-ws-create').addEventListener('click', createWs);
  $('wiz-ws-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') createWs(); });
  $('wiz-gh-recheck').addEventListener('click', goGh);
  $('wiz-finish').addEventListener('click', finish);
  $('wiz-skip').addEventListener('click', dismiss);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && wiz.classList.contains('show')) { e.preventDefault(); dismiss(); } });

  try { if (!loadPrefs().onboardingDone) setTimeout(open, 700); } catch {}
})();

// ---------- Connect Claude Code (topbar mascot button + auto-pop when a terminal finds no claude) ----------
// Detect → install (preflight) → sign in (onboard:claude-login) → bring the terminal up (claude:connected).
// Status via the FOCUSED claude:state probe (cheap — no gh network / 6-tool scan on every launch or poll tick).
// The dot mirrors claude's connection; it pulses ONLY when claude is missing — never for "installed but sign-in
// not confirmable", which on Windows is a known false-negative (the token can live in Credential Manager), so
// nagging a signed-in user would be wrong. Always available as the standing "(re)connect Claude" escape hatch;
// the first-run wizard owns first-run claude setup, so auto-pop defers to it and never stacks on it.
(function () {
  const pop = $('claude-connect'), btn = $('claude-btn');
  if (!pop || !btn || !claudible.claudeState) return;
  const wizEl = $('wizard');
  const msg = $('cc-msg'), act = $('cc-action'), busy = $('cc-busy'), doneBtn = $('cc-done'), dot = $('claude-dot');
  let poll = null, pollSince = 0, lastState = '', userDismissed = false;
  const head = pop.querySelector('.cc-head h3'), center = $('cc-center');
  let ccVer = '';
  async function loadVer() { if (ccVer) return ccVer; try { ccVer = (await claudible.claudeVersion()) || ''; } catch {} return ccVer; }
  const stop = () => { if (poll) { clearInterval(poll); poll = null; } };
  async function getState() { try { return await claudible.claudeState(); } catch { return null; } }
  function toState(s) { if (!s) return ''; if (!s.installed) return 'missing'; return s.signedIn ? 'ready' : 'unconfirmed'; }
  function setDot(state) {
    lastState = state || '';
    if (dot) dot.className = 'claude-dot ' + (state === 'ready' ? 'ok' : state === 'missing' ? 'bad' : (state ? 'warn' : ''));
    btn.classList.toggle('attn', state === 'missing');   // nudge ONLY when truly absent (not the unconfirmed false-negative)
    btn.title = state === 'ready' ? ('Claude Code — Connected ✓' + (ccVer ? ' · ' + ccVer : '') + ' · click for status')
      : state === 'missing' ? 'Claude Code not installed — click to set up'
      : state === 'unconfirmed' ? 'Claude Code installed — click to sign in'
      : 'Claude Code — click to check status';
  }
  function fitSoon() { setTimeout(() => { try { window.dispatchEvent(new Event('resize')); } catch {} }, 450); }   // re-fit the revived terminal (it spawns at a default size)
  function open() { userDismissed = false; pop.classList.add('show'); render(); }
  function close() { stop(); pop.classList.remove('show'); userDismissed = true; if (lastState === 'ready') { try { claudible.claudeConnected && claudible.claudeConnected(); } catch {} fitSoon(); } }
  async function render() {
    const st = toState(await getState());
    setDot(st); busy.classList.remove('err'); busy.textContent = '';
    if (center) center.style.display = 'none';                                  // command center is the CONNECTED view only
    if (head) head.textContent = st === 'ready' ? 'Claude Code' : 'Connect Claude Code';
    if (st === '') { msg.textContent = 'Couldn’t check Claude Code — try again, or open a terminal manually.'; act.style.display = 'none'; return; }
    if (st === 'ready') {
      msg.textContent = '✓ Claude Code is connected.'; act.style.display = 'none'; doneBtn.textContent = 'Done'; stop();
      renderCenter();                                                           // version + running background sessions + terminate
    } else if (st === 'missing') {
      msg.textContent = 'Claude Code isn’t installed yet. Install it now — takes a minute (Node is already set up).';
      act.style.display = ''; act.textContent = 'Install Claude Code'; act.disabled = false; act.onclick = install; doneBtn.textContent = 'Close';
    } else {   // unconfirmed: installed, sign-in not confirmable (Windows often can't see the token) — don't nag
      msg.textContent = 'Claude Code is installed. If you’re already signed in, you’re all set — just close. If not, sign in below (opens in the terminal).';
      act.style.display = ''; act.textContent = 'Sign in to Claude'; act.disabled = false; act.onclick = signIn; doneBtn.textContent = 'Close';
    }
  }
  async function install() {
    act.disabled = true; busy.classList.remove('err'); busy.textContent = 'Installing Claude Code… (a minute or two)';
    let r; try { r = await claudible.preflightInstall('claude'); } catch (e) { r = { ok: false, error: e && e.message }; }
    act.disabled = false;
    if (r && r.ok) { busy.textContent = ''; render(); }
    else { busy.classList.add('err'); busy.textContent = 'Install failed: ' + installErrText(r && r.error) + ' — retry, or install it manually.'; }   // shared filter (R18): the third surface that used to show the raw exec-crash string
  }
  async function signIn() {
    busy.classList.remove('err'); busy.textContent = 'Opening Claude — finish sign-in in the terminal/browser…';
    try { await claudible.onboardClaudeLogin(); } catch {}    // (re)spawns the foreground tab running claude → login surfaces
    fitSoon();
    pop.classList.remove('show');                             // reveal the terminal; a BOUNDED poll re-confirms + updates the dot
    stop(); pollSince = Date.now();
    poll = setInterval(async () => {
      if (Date.now() - pollSince > 360000) { stop(); return; }   // abandon cap (mirrors the wizard) — never poll forever
      const st = toState(await getState()); setDot(st); if (st === 'ready') stop();
    }, 3000);
  }
  function ccName(rec) {                                                        // a friendly name for any running tab/session
    if (rec.kind === 'live') return (((rec.peer && (rec.peer.name || rec.peer.login)) || rec.hostName || 'collaborator') + '’s live session');
    if (rec.session && rec.session !== 'new' && typeof sessIndex !== 'undefined' && sessIndex[rec.session]) return sessTitle(sessIndex[rec.session]);
    return tabLabel(rec);
  }
  function renderCenter() {                                                     // the connected "command center": version + running sessions + terminate
    if (!center) return;
    center.style.display = ''; center.innerHTML = '';
    const meta = document.createElement('div'); meta.className = 'cc-meta';
    const vS = document.createElement('div'); vS.className = 'cc-stat';
    const vk = document.createElement('span'); vk.className = 'cc-k'; vk.textContent = 'Version'; vS.appendChild(vk);
    const vv = document.createElement('span'); vv.className = 'cc-v'; vv.textContent = ccVer ? ('claude code ' + ccVer) : 'checking…'; vS.appendChild(vv);
    if (!ccVer) loadVer().then((v) => { if (v) vv.textContent = 'claude code ' + v; });
    const cS = document.createElement('div'); cS.className = 'cc-stat';
    const ck = document.createElement('span'); ck.className = 'cc-k'; ck.textContent = 'Sessions'; cS.appendChild(ck);
    const cv = document.createElement('span'); cv.className = 'cc-v'; cv.textContent = tabs.size + ' running'; cS.appendChild(cv);
    meta.appendChild(vS); meta.appendChild(cS); center.appendChild(meta);
    const list = document.createElement('div'); list.className = 'cc-sess-list';
    Array.from(tabs.values()).forEach((rec) => {
      const row = document.createElement('div'); row.className = 'cc-sess';
      const d = document.createElement('span'); d.className = 'cc-d' + (rec.busy ? ' busy' : '') + (rec.kind === 'live' ? ' live' : ''); row.appendChild(d);
      const nm = document.createElement('span'); nm.className = 'cc-nm'; nm.textContent = ccName(rec); nm.title = nm.textContent; row.appendChild(nm);
      const ws = (typeof workspaces !== 'undefined') ? workspaces.find((w) => w.id === rec.wsId) : null;
      if (ws) { const wl = document.createElement('span'); wl.className = 'cc-ws'; wl.textContent = ws.label; row.appendChild(wl); }
      if (rec.tabId === activeTabId) { const a = document.createElement('span'); a.className = 'cc-active'; a.textContent = 'active'; row.appendChild(a); }
      const kill = document.createElement('button'); kill.className = 'cc-kill'; kill.textContent = '✕';
      kill.title = rec.kind === 'live' ? 'Leave this live session' : 'End this session';
      kill.disabled = tabs.size <= 1;                                           // never terminate the last running session
      kill.addEventListener('click', (e) => { e.stopPropagation(); try { closeTab(rec.tabId); } catch (_) {} renderCenter(); });
      row.appendChild(kill); list.appendChild(row);
    });
    center.appendChild(list);
  }
  btn.addEventListener('click', open);
  doneBtn.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pop.classList.contains('show')) { e.preventDefault(); close(); } });
  // Auto-pop on a missing-claude spawn — but DEFER to the first-run wizard (it owns first-run claude setup),
  // don't stack on it, don't re-pop while already open, and respect an explicit dismissal for the session.
  if (claudible.onClaudeNeeded) claudible.onClaudeNeeded(() => {
    try { if (!loadPrefs().onboardingDone) return; } catch {}
    if (wizEl && wizEl.classList.contains('show')) return;
    if (pop.classList.contains('show') || userDismissed) return;
    open();
  });
  getState().then((s) => setDot(toState(s)));   // initialize the dot (cheap, claude-only)
  loadVer().then(() => { if (lastState) setDot(lastState); });   // prefetch version so the tooltip shows it; refresh the title once known
})();
