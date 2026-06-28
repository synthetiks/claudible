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
    exec: 'the WSL command could not run', parse: 'could not read the response',
    'bad handle': 'that live link looks invalid', 'bad url': 'that live link looks invalid',
    'bad token': 'that live link looks invalid', 'bad id': 'that item could not be found',
    'not live': "you're not sharing a live session right now", 'bad workspace': 'that workspace is not available',
    'bad ws': 'that workspace is not available', 'bad args': 'invalid request', 'bad slug': 'that name is not allowed',
    apply: 'could not apply that change', 'stopped during start': 'sharing was stopped while it was starting',
    'push failed': 'could not reach the server — check your connection', 'pull failed': 'could not reach the server — check your connection',
    full: 'the session is full', 'not found': 'not found', unknown: 'something went wrong',
  };
  const c = String(code == null ? '' : code).trim();
  if (map[c]) return map[c];
  if (/\s/.test(c) && c.length <= 120 && !/[{}<>]|Error:|\bat .*:\d|\bE[A-Z]{3,}\b|Cannot read prop/.test(c)) return c;   // already a human sentence → keep it (but never a raw node/JS exception)
  return 'something went wrong';
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
  theme: { background: '#0a0b0d', foreground: '#d8dde3', cursor: '#c6ced8',
           selectionBackground: '#23272e', black: '#070809', brightBlack: '#525861' },
};
const tabs = new Map();           // tabId -> per-tab record (own xterm/fit/container + tracker/agents/sessionLog)
let activeTabId = null;

// ---------- themes: re-tint the UI (CSS :root vars via html[data-theme]) + the xterm terminal palette ----------
// Dark = default (no data-theme attr). The UI palettes live in index.html (html[data-theme="…"]); these are the
// matching TERMINAL palettes. applyTheme also updates TERM_OPTS so newly-spawned tabs adopt the chosen palette.
const TERM_THEMES = {
  dark:      { background: '#0a0b0d', foreground: '#d8dde3', cursor: '#c6ced8', selectionBackground: '#23272e', black: '#070809', brightBlack: '#525861' },
  graphite:  { background: '#11141b', foreground: '#e8ecf3', cursor: '#cfd8e4', selectionBackground: '#2c3441', black: '#0d1015', brightBlack: '#687283' },
  starlight: { background: '#1a1f27', foreground: '#f4f7fc', cursor: '#dde4ee', selectionBackground: '#343c4a', black: '#161a21', brightBlack: '#7c8693' },
  midnight:  { background: '#081227', foreground: '#d4e2f5', cursor: '#a9c1e8', selectionBackground: '#1b3354', black: '#050b18', brightBlack: '#54668a' },
  aurora:    { background: '#0e0a20', foreground: '#e3dcf3', cursor: '#bdaee2', selectionBackground: '#29204f', black: '#0b0717', brightBlack: '#675b86' },
  evergreen: { background: '#07140d', foreground: '#d6ecdf', cursor: '#a6dab9', selectionBackground: '#143826', black: '#050c08', brightBlack: '#4e7860' },
};
function applyTheme(name) {
  const t = TERM_THEMES[name] ? name : 'dark';
  if (t === 'dark') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  try { TERM_OPTS.theme = TERM_THEMES[t]; } catch {}                              // new tabs spawn with this palette
  for (const r of tabs.values()) { try { r.term.options.theme = TERM_THEMES[t]; } catch {} }   // retint live terminals
}
let term, fit;                    // ALWAYS point at the ACTIVE tab, so the 40+ foreground term.* sites need no change
let tabSeq = 0;
const newTabId = () => 'tab-' + (++tabSeq);
// Declared here (not in the sessions section) so the tab-strip boot below can reference them safely:
let activeSession = null;                       // the ACTIVE tab's session id (mirrors AT().session) — drives sidebar row highlight
let livePeers = [], livePeersSig = '', advertisedSession = null;   // collaborators live in this repo workspace + my own advertised session
let remoteTitles = {}, titlesSig = '', lastTitlePoll = 0;   // session names shared across the workspace (id -> title), polled from the branch
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
  if (kind === 'live') t.onData((d) => { const r = tabs.get(tabId); if (r && !r.liveReadOnly) claudible.liveInput(tabId, d); });   // co-drive: keystrokes → the peer's terminal
  else t.onData((d) => claudible.ptyInput(tabId, d));          // keystrokes → THIS tab's pty
  t.onScroll(() => { if (tabId === activeTabId) updateScrollbar(); });
  const rec = { tabId, term: t, fit: f, container, started: false, kind, peer: opts.peer || null, wsId: wsId || null, session: session || '',
    baseCost: null, lastCostUsd: null, sessTok: 0, lastUsageKey: null, sessionLog: [], curCtxPct: null, curSessionLabel: '',
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
  try {
    t.fit.fit();
    if (t.term.cols < 2 || t.term.rows < 2) return;            // not laid out yet → don't start/resize at 0×0
    // Leave ~1 row of breathing room at the bottom: Claude's TUI anchors its input box, the
    // bypass-permissions banner and the status/“working… esc to interrupt” line to the last rows —
    // running them flush to the pane edge clips them. One reserved row keeps those always visible.
    if (t.term.rows > 6) t.term.resize(t.term.cols, t.term.rows - 1);
    if (!t.started) { t.started = true; claudible.tabOpen(t.tabId, t.wsId, t.session); claudible.ptyStart(t.tabId, t.term.cols, t.term.rows); } // spawn at the EXACT fitted size
    else claudible.ptyResize(t.tabId, t.term.cols, t.term.rows);
    updateScrollbar();
  } catch {}
}
// Route incoming bytes to the ADDRESSED tab's xterm — background tabs keep accumulating while hidden.
// Auto-scroll only the active tab, and only when it was already at the bottom (don't yank the reader down).
claudible.onPtyData((tabId, d) => {
  const t = tabs.get(tabId); if (!t) return;
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
let altFrac = 0;                       // 0 = bottom (newest) … 1 = scrolled fully up (an estimate; Claude never reports it)
const ALT_PAGE = 0.14;                 // estimate nudge per PageUp/PageDown
function sendPage(dir) { sendInput(dir < 0 ? '\x1b[5~' : '\x1b[6~'); }   // PageUp (older) / PageDown (newer)
function jogPages(dir) {                // wheel / gutter-click: fire pages + advance the estimate
  if (!term || !dir) return;
  const n = Math.min(6, Math.abs(dir));
  for (let i = 0; i < n; i++) sendPage(dir < 0 ? -1 : 1);
  altFrac = Math.max(0, Math.min(1, altFrac + (dir < 0 ? 1 : -1) * ALT_PAGE * n));
  updateScrollbar();
}
function updateScrollbar() {
  if (!term) return;                                 // no active tab yet (pre-boot)
  const trackH = sc.clientHeight;
  if (trackH <= 0) { thumb.style.opacity = '0'; return; }
  if (isAlt()) {                                      // full-screen app → a draggable thumb that pages Claude's view
    const thumbH = Math.max(40, trackH * 0.20);
    thumb.style.opacity = '1'; thumb.style.height = thumbH + 'px';
    if (!dragging) thumb.style.transform = 'translateY(' + ((trackH - thumbH) * (1 - altFrac)) + 'px)';   // 0=bottom
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
    thumb.style.transform = 'translateY(' + top + 'px)';
    altFrac = (trackH - thumbH) > 0 ? 1 - (top / (trackH - thumbH)) : 0;   // estimate = where the thumb now sits
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
// There is NO top tab strip anymore — every live session is shown as a row in the LEFT SIDEBAR instead
// (saved ones as their normal session row, brand-new unsaved ones as a synthetic "live" row). So this
// function just keeps the old top strip permanently hidden; all the renderTabStrip() callers stay valid.
const MAX_TABS = 8;
function tabLabel(rec) {
  if (rec.label) return rec.label;
  return (rec.session === 'new' || !rec.session) ? 'New session' : 'Session';
}
function renderTabStrip() {
  const strip = $('tabstrip'); if (strip) { strip.innerHTML = ''; strip.style.display = 'none'; }
}
// Show one tab, hide the rest. Point the global term/fit at it, fit it (NEVER fit a hidden tab), and
// project its meter/agents/scroll into the shared UI. Tells main this is the foreground (guest-mirrored) tab.
function setActiveTab(tabId) {
  const rec = tabs.get(tabId); if (!rec) return;
  activeTabId = tabId;
  for (const r of tabs.values()) r.container.classList.toggle('active', r.tabId === tabId);
  term = rec.term; fit = rec.fit;
  if (rec.kind !== 'live') { try { claudible.tabForeground(tabId); } catch {} }   // guests + main's active-workspace follow the foreground tab — a live tab must NOT (it would hijack your own outgoing mirror)
  sync();                                          // fit the now-visible tab + (re)start/resize its pty (or fit the live mirror)
  scheduleFit();                                    // …and re-fit once layout settles (the container just became visible)
  try { rec.term.refresh(0, rec.term.rows - 1); } catch {}   // force a repaint of the freshly-shown (was-hidden) buffer
  if (rec.kind === 'live') repaintLiveTracker(rec); else repaintTracker(rec);    // project this tab's tracker into #trk-*
  _agentsSig = '';                                 // force an agents rebuild for THIS tab (the sig guard is module-global)
  renderAgents();                                  // …and its agents into the agents pane
  updateScrollbar();
  renderTabStrip();
  refreshCollabSurfaces();                          // chat/roster/live-bar/voice follow the active tab's context (host-share vs joined)
  activeSession = (rec.session && rec.session !== 'new') ? rec.session : null;
  if (sidebarReady) {   // guard: the sessions/workspace section's consts aren't initialized during the boot tab
    if (rec.wsId && rec.wsId !== activeWsId) { activeWsId = rec.wsId; renderWsChips(); }   // sidebar library follows the tab's ws
    refreshSessions();                                                                     // re-highlight rows for this tab's ws/session
  }
  setTimeout(() => { if (term) term.focus(); }, 0);
}
// Open a brand-new session in a NEW tab (the current tab keeps running in the background).
function newBlankTab(wsId, session, name) {
  if (tabs.size >= MAX_TABS) { toast('Tab limit reached (' + MAX_TABS + ')'); return; }
  const id = newTabId();
  const rec = makeTab(id, wsId || activeWsId, session || 'new');
  if (name && rec) { rec.label = name; rec.curSessionLabel = name; rec.pendingTitle = name; }   // named up front → show it now + persist once the session gets its real id (onStatus reconcile)
  setActiveTab(id);                                // activating fits + starts its pty
}
function closeTab(tabId) {
  const rec = tabs.get(tabId); if (!rec || tabs.size <= 1) return;   // never close the last tab
  if (tabId === liveVoiceTabId) { try { liveVoice.leave(); } catch {} liveVoiceTabId = null; }   // leaving a joined session drops its voice
  if (rec.kind === 'live') { try { claudible.liveDisconnect(tabId); } catch {} }   // leaving a JOINED peer session: tear down the client WebSocket too (was leaking)
  try { claudible.tabClose(tabId); } catch {}
  try { rec.term.dispose(); } catch {}
  try { rec.container.remove(); } catch {}
  tabs.delete(tabId);
  if (activeTabId === tabId) setActiveTab(tabs.keys().next().value);
  else renderTabStrip();
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
})();

// ---------- session tracker ----------
// Claude Code's statusLine reports CUMULATIVE cost/tokens for the (persisted, --continue'd)
// conversation. We want THIS session's usage, so we subtract a baseline captured at launch and
// re-baseline on /clear or any upstream reset. Baseline resets every app launch (fresh process).
const fmtK = (n) => n >= 1e6 ? ((+(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)) + 'M') : (n >= 1000 ? ((+(n / 1000).toFixed(n >= 100000 ? 0 : 1)) + 'k') : String(n));
// Tracker accumulators are PER TAB (on each tab's record): the #trk-* DOM always projects the ACTIVE tab,
// and only the active tab's tracker is mirrored to guests — so two concurrent sessions never cross-count.
// Mirror the active tab's tracker (and which session is live) to any shared guests. Guests render verbatim.
function pushTracker() {
  const t = AT(); if (!t) return;
  if (t.kind === 'live') return;   // viewing a peer's session — never mirror THEIR tracker to YOUR guests
  try { claudible.shareTracker({ ctxPct: t.curCtxPct, cost: $('trk-cost').textContent, tokens: $('trk-tokens').textContent, session: t.curSessionLabel, sessionId: (t.session && t.session !== 'new') ? t.session : '' }); } catch {}   // sessionId lets a guest detect "host moved to a different session than I joined"
}
// Paint the #trk-* gauges from a tab record (called for the active tab on update and on every tab switch).
function repaintTracker(t) {
  if (!t) return;
  const pct = t.curCtxPct, bar = $('trk-ctxbar');
  if (typeof pct === 'number') {
    $('trk-ctx').textContent = 'CONTEXT ' + pct + '%';
    $('trk-ctxfill').style.width = Math.max(2, Math.min(100, pct)) + '%';
    bar.classList.toggle('warn', pct >= 70 && pct < 85);
    bar.classList.toggle('crit', pct >= 85);
    bar.title = pct >= 70 ? `context ${pct}% — click to /compact` : 'context window used';
  } else {
    $('trk-ctx').textContent = 'CONTEXT —'; $('trk-ctxfill').style.width = '2%';
    bar.classList.remove('warn', 'crit'); bar.title = 'context window used';
  }
  $('trk-cost').textContent = '$' + ((t.baseCost === null || t.lastCostUsd == null) ? 0 : Math.max(0, t.lastCostUsd - t.baseCost)).toFixed(2);
  if (bar) bar.title = bar.title + ' · ' + $('trk-cost').textContent + ' this session';   // append cost to the (warn-aware) context tooltip — cost lives here now
  const at = t.agentTok || 0;                                    // subagent/swarm tokens (the main meter misses these)
  $('trk-tokens').textContent = fmtK((t.sessTok || 0) + at);
  $('trk-tokens').title = at ? (fmtK(t.sessTok || 0) + ' main + ' + fmtK(at) + ' agents') : '';
}
function resetStats(t) {
  t = t || AT(); if (!t) return;
  t.baseCost = null; t.sessTok = 0; t.agentTok = 0; t.lastUsageKey = null; t.lastCostUsd = null; t.sessionLog.length = 0; t.curCtxPct = null;
  if (t.tabId === activeTabId) { repaintTracker(t); pushTracker(); }
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
  // Reconcile a freshly-started tab with the real session id Claude assigned it, so its synthetic "live"
  // sidebar row collapses into the proper saved session row (and the right row highlights as active).
  if (s.sessionId && t.session !== s.sessionId && (t.session === 'new' || !t.session)) {
    t.session = s.sessionId;
    if (t.tabId === activeTabId) activeSession = s.sessionId;
    if (t.pendingTitle) {                                       // a name chosen at "+ New Session" → make it stick now that the session has a real id (mirrors the rename flow)
      const nm = t.pendingTitle; t.pendingTitle = null;
      const titles = loadPrefs().sessionTitles || {}; titles[s.sessionId] = nm; savePrefs({ sessionTitles: titles });
      const _aw = workspaces.find((w) => w.id === activeWsId);
      if (_aw && _aw.kind === 'repo') { remoteTitles[s.sessionId] = nm; try { claudible.titleSet(s.sessionId, nm).then(() => pollTitles(true)).catch(() => {}); } catch (e) {} }   // repo workspace → share the name with collaborators
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
  if (t.tabId === activeTabId) { repaintTracker(t); pushTracker(); }   // only the foreground tab paints + mirrors
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
const pttHint = document.querySelector('.ptt-hint');
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
      if (pttHeld && !pttCombo) { if (pttHint) pttHint.classList.add('live'); startRecording(); }
    }, PTT_HOLD_MS);
    return;
  }
  if (pttHeld) { pttCombo = true; pttCancelTimer(); }   // another key while held => a shortcut, never start the mic
}, true);
window.addEventListener('keyup', (e) => {
  if (e.code === pttKey && pttHeld) {
    e.preventDefault(); e.stopPropagation();
    pttHeld = false; pttCancelTimer();
    if (pttHint) pttHint.classList.remove('live');
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
  if (pttHint) pttHint.classList.remove('live');
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
  const kbd = $('ptt-kbd'); if (kbd) kbd.textContent = keyLabel(pttKey);
  const btn = $('ptt-key-btn'); if (btn && !pttCapturing) btn.textContent = keyLabel(pttKey);
}
function setPttKey(code) { pttKey = code; savePrefs({ pttKey: code }); applyPttKey(); }
function startCapture() { pttCapturing = true; const b = $('ptt-key-btn'); if (b) { b.textContent = 'press a key…'; b.classList.add('capturing'); } }
function stopCapture() { pttCapturing = false; const b = $('ptt-key-btn'); if (b) b.classList.remove('capturing'); applyPttKey(); }
if ($('ptt-key-btn')) $('ptt-key-btn').addEventListener('click', () => { pttCapturing ? stopCapture() : startCapture(); });

// ---------- (out) Kokoro TTS — Speak <-> Stop Speech ----------
let ttsAudio = null, ttsBusy = false, selectedVoice = 'af_bella', alwaysSpeak = true, ttsUrl = null, speakGen = 0, fullReadout = true;
let lastReply = '';                                  // Claude's latest reply (stripped) — the manual "▶ Speak" reads this
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
const VOICE_NAMES = { af_bella: 'Bella', af_heart: 'Heart', am_michael: 'Michael' };
const VOICE_ORDER = ['af_bella', 'af_heart', 'am_michael'];
function syncVoiceUI() {
  document.querySelectorAll('.vpill').forEach((x) => x.classList.toggle('on', x.dataset.voice === selectedVoice));
  const n = $('vout-name'); if (n) n.textContent = VOICE_NAMES[selectedVoice] || selectedVoice;
  const a = $('vout-auto'); if (a) { a.classList.toggle('on', alwaysSpeak); a.setAttribute('aria-pressed', String(alwaysSpeak)); }
  const t = $('always-toggle'); if (t) t.classList.toggle('on', alwaysSpeak);
  const cb = $('always-speak'); if (cb) cb.checked = alwaysSpeak;
}
function setVoice(v) { selectedVoice = v; savePrefs({ voice: v }); syncVoiceUI(); }
function setAlways(on) { alwaysSpeak = !!on; savePrefs({ alwaysSpeak: alwaysSpeak }); syncVoiceUI(); }
// drawer voice pills
document.querySelectorAll('.vpill').forEach((p) => p.addEventListener('mousedown', (e) => { e.preventDefault(); setVoice(p.dataset.voice); }));
// top-bar Voice Out: voice name cycles voices, ■ stops Claude speaking, auto = always-speak toggle
if ($('vout-name')) $('vout-name').addEventListener('click', () => { const i = VOICE_ORDER.indexOf(selectedVoice); setVoice(VOICE_ORDER[(i + 1) % VOICE_ORDER.length]); });
if ($('vout-stop')) {
  $('vout-stop').addEventListener('click', async () => {
    if (ttsBusy || ttsAudio) { stopSpeech(); return; }
    if (lastReply) { speak(lastReply); return; }
    // Nothing captured this app-session — fetch the OPEN session's latest reply from its transcript so you can
    // re-listen (after a relaunch, or for a session opened from history). Empty → tell the user there's nothing.
    const sid = activeSession;
    if (sid) {
      try {
        const r = await claudible.latestReply(sid);
        if (r && r.text && r.text.trim()) { lastReply = stripForSpeech(r.text); if ($('tts-in')) $('tts-in').value = lastReply; speak(lastReply); return; }
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
  if (!moved && pill && pill.dataset.cmd) { send(pill.dataset.cmd); if (pill.dataset.cmd === '/clear') resetStats(); }
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
claudible.onHookLine((tabId, line) => {
  const t = tabs.get(tabId); if (!t) return;            // route every hook to the tab it came from
  let o; try { o = JSON.parse(line); } catch { return; }
  if (o.hook_event_name === 'UserPromptSubmit') {
    t.busy = true; markTabBusy(t.tabId, true);
    if (o.prompt) t.sessionLog.push({ role: 'you', text: String(o.prompt) });   // captures typed AND voice turns
  } else if (o.hook_event_name === 'Stop') {
    t.busy = false; markTabBusy(t.tabId, false);
    // A turn just finished: if this tab is still showing a "live · unsaved" row, its transcript now exists on
    // disk, so refresh the sidebar to collapse that live row into its proper saved session row.
    if (sidebarReady && t.wsId === activeWsId && sessListEl && sessListEl.querySelector('.sess.sess-live[data-tab="' + t.tabId + '"]')) refreshSessions();
    if (o.last_assistant_message) {
      t.sessionLog.push({ role: 'claude', text: String(o.last_assistant_message) });
      if (tabId === activeTabId) {   // only the FOREGROUND tab speaks / fills the Speak box, so background turns never talk over it
        const reply = stripForSpeech(o.last_assistant_message);
        lastReply = reply;                  // remember it for the manual "▶ Speak" button
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
// One card per agent — Task subagents (simple) + workflow/Agent-tool agents (rich: chips, a tool-glyph strip, and an
// expandable detail with the task, full tool feed, and result).
function agentRow(a, nowSec) {
  const running = a.status === 'running';
  const tools = Array.isArray(a.tools) ? a.tools : [];
  const rich = tools.length > 0 || !!(a.result && a.result.length) || (a.tokens || 0) > 0;
  const row = document.createElement('div');
  row.className = 'agent-row ' + (running ? 'running' : (a.ok === false ? 'err' : 'done')) + (rich ? ' rich' : '') + (expandedAgents.has(a.id) ? ' expanded' : '');
  if (a.type) row.style.setProperty('--rail', typeHue(a.type));
  const head = document.createElement('div'); head.className = 'agent-head';
  const dot = document.createElement('span'); dot.className = 'agent-dot'; head.appendChild(dot);
  const c = document.createElement('div'); c.className = 'agent-body';
  const label = a.desc || a.label || 'agent';
  const name = document.createElement('div'); name.className = 'agent-name'; name.textContent = label; name.title = label; c.appendChild(name);
  // stat chips — the numbers that matter, at a glance
  const chips = document.createElement('div'); chips.className = 'agent-chips';
  const chip = (cls, txt, ds) => { const e = document.createElement('span'); e.className = 'chip ' + cls; e.textContent = txt; if (ds != null) e.dataset.start = ds; chips.appendChild(e); };
  if (a.type) chip('chip-type', a.type);
  const startSec = a.start || (a.startedAt ? a.startedAt / 1000 : null);
  if (running) chip('chip-dur', startSec ? fmtDur(nowSec - startSec) : '0s', startSec || '');
  else { const d = (a.durationMs != null) ? fmtDur(a.durationMs / 1000) : ((a.start && a.last) ? fmtDur(a.last - a.start) : ''); if (d) chip('chip-dur', d); }
  if ((a.tokens || 0) > 0) chip('chip-tok', fmtK(a.tokens) + ' tok');
  const tc = a.toolCount || tools.length; if (tc > 0) chip('chip-tools', tc + (tc === 1 ? ' tool' : ' tools'));
  if (a.ok === false) chip('chip-err', 'failed');
  c.appendChild(chips);
  if (tools.length) {   // tool-glyph activity strip (the recent tools, colored by kind)
    const strip = document.createElement('div'); strip.className = 'agent-strip';
    tools.slice(-8).forEach((t) => strip.appendChild(toolBadge(t)));
    c.appendChild(strip);
  }
  head.appendChild(c);
  if (rich) { const chev = document.createElement('span'); chev.className = 'agent-chev'; chev.textContent = '⌄'; head.appendChild(chev); }
  row.appendChild(head);
  if (rich) {   // expandable detail: task · full tool feed · result
    const det = document.createElement('div'); det.className = 'agent-detail';
    const taskText = (a.prompt && a.prompt.trim()) || (label !== 'agent' ? label : '');
    if (taskText) { const task = document.createElement('div'); task.className = 'agent-task'; task.textContent = taskText; det.appendChild(task); }
    if (tools.length) {
      const feed = document.createElement('div'); feed.className = 'agent-feed';
      tools.forEach((t) => { const r = document.createElement('div'); r.className = 'agent-tool';
        r.appendChild(toolBadge(t)); const s = document.createElement('span'); s.className = 'agent-tt'; s.textContent = t.target || ''; r.appendChild(s); feed.appendChild(r); });
      det.appendChild(feed);
    }
    if (!running && a.result) { const res = document.createElement('div'); res.className = 'agent-result'; res.textContent = a.result; det.appendChild(res); }
    row.appendChild(det);
    head.addEventListener('click', () => {
      if (expandedAgents.has(a.id)) { expandedAgents.delete(a.id); row.classList.remove('expanded'); }
      else { expandedAgents.add(a.id); row.classList.add('expanded'); }
    });
  }
  return row;
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
  const sig = JSON.stringify([running.map((a) => (a.desc || a.label || '') + (a.id || '') + (a.toolCount || 0) + (a.tokens || 0)), done.map((a) => (a.desc || a.label || '') + a.status + (a.toolCount || 0)), doneAll.length]);
  if (sig === _agentsSig) {
    el.querySelectorAll('.chip-dur[data-start]').forEach((m) => { m.textContent = fmtDur(nowSec - parseFloat(m.dataset.start)); });   // tick the running timers in place
    return;
  }
  _agentsSig = sig;
  if (!all.length) {
    el.innerHTML = '<div class="agents-empty"><span class="agents-empty-ico">' + SWARM_SVG + '</span>'
      + 'No agents running.<br>When Claude spawns subagents or a workflow swarm, they appear here.</div>';
    return;
  }
  el.innerHTML = '';
  // swarm summary — reads the group as ONE unit: count · running/done · total tokens, with a progress bar
  const totalTok = all.reduce((s, a) => s + (a.tokens || 0), 0);
  const sum = document.createElement('div'); sum.className = 'agents-summary';
  sum.innerHTML = '<span class="sum-ico">' + SWARM_SVG + '</span>';
  const sm = document.createElement('div'); sm.className = 'sum-meta';
  const stT = document.createElement('div'); stT.className = 'sum-title'; stT.textContent = all.length + (all.length === 1 ? ' agent' : ' agents');
  const stS = document.createElement('div'); stS.className = 'sum-stats'; stS.textContent = running.length + ' running · ' + doneAll.length + ' done' + (totalTok > 0 ? ' · ' + fmtK(totalTok) + ' tok' : '');
  sm.appendChild(stT); sm.appendChild(stS); sum.appendChild(sm);
  const sb = document.createElement('div'); sb.className = 'sum-bar'; const sf = document.createElement('div'); sf.className = 'sum-fill'; sf.style.width = (all.length ? Math.round((doneAll.length / all.length) * 100) : 0) + '%'; sb.appendChild(sf); sum.appendChild(sb);
  el.appendChild(sum);
  if (running.length) {
    const hd = document.createElement('div'); hd.className = 'agents-section'; hd.textContent = 'Running · ' + running.length; el.appendChild(hd);
    running.forEach((a) => el.appendChild(agentRow(a, nowSec)));
  }
  if (done.length) {
    const hd = document.createElement('div'); hd.className = 'agents-section';
    hd.textContent = 'Done · ' + doneAll.length + (doneAll.length > done.length ? ' (showing ' + done.length + ')' : '');
    el.appendChild(hd);
    done.forEach((a) => el.appendChild(agentRow(a, nowSec)));
  }
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

// ---------- Save Session (pop-out tab) ----------
function buildTranscript() {
  const head = 'Claudible session — ' + new Date().toLocaleString() + '\n' + '='.repeat(48) + '\n\n';
  const at = AT();
  const body = (at ? at.sessionLog : []).map((turn) => `[${turn.role}]\n${turn.text}\n`).join('\n');
  return head + (body || '(no turns recorded this session yet)') + '\n';
}
// (save-session and clear-input toolbar buttons removed — sessions auto-save; the git button now sits bottom-right)

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
  renderLiveBar(); repaintVoiceForActive();
}
// presence roster in the chat header: you + each viewer with a green(here)/amber(AFK)/red(closed-tab) light
// Your collab display name (settings) — what teammates see when you're in a synced session. Falls back to the
// web-share name then a generic label. Used for the live bar, your roster chip, advertising, and joining.
function collabName() { return (loadPrefs().collabName || '').trim(); }
function youName() {
  const t = AT();
  if (t && t.kind === 'live') return collabName() || 'You';   // on a joined session you appear by your collab name
  return collabLive ? (collabName() || 'You') : (hostDisplayName || collabName() || 'You');
}
// The "who's here" members for the ACTIVE context: your guests (host-share), or — on a joined tab — the host plus
// every other participant from that session's roster (you're rendered separately as the "you" chip).
function activeRosterMembers() {
  const t = AT();
  if (t && t.kind === 'live') {
    const me = collabName() || 'Guest', out = [];   // the name the host's server registered us under (mirror its cleanName fallback) so we don't list ourselves twice
    if (t.hostName) out.push({ name: t.hostName, state: 'active', host: true });
    (t.roster || []).forEach((g) => { if (g.name !== me) out.push(g); });
    return out;
  }
  return lastRoster;
}
function renderRoster(roster) {
  const el = $('chat-roster'); if (!el) return;
  el.innerHTML = '';
  const you = document.createElement('span'); you.className = 'rmember you';
  const yd = document.createElement('span'); yd.className = 'rdot ok'; you.appendChild(yd);
  you.appendChild(document.createTextNode(youName()));
  el.appendChild(you);
  activeRosterMembers().forEach((g) => {
    const cls = g.state === 'active' ? 'ok' : (g.state === 'idle' ? 'idle' : 'gone');
    const m = document.createElement('span'); m.className = 'rmember' + (g.state === 'gone' ? ' gone' : '');
    m.title = g.host ? 'host' : (g.state === 'active' ? 'here' : (g.state === 'idle' ? 'away / AFK' : 'closed the tab'));
    const d = document.createElement('span'); d.className = 'rdot ' + cls;
    m.appendChild(d); m.appendChild(document.createTextNode(g.name));
    el.appendChild(m);
  });
}
// The cockpit LIVE bar: visible whenever this session is live (synced collab) — shows you + everyone who's joined.
let lastRoster = [];
function renderLiveBar() {
  const bar = $('livebar'); if (!bar) return;
  const t = AT(), liveTab = !!(t && t.kind === 'live');
  if (!collabLive && !liveTab) { bar.style.display = 'none'; return; }   // show when hosting a synced session OR viewing a joined one
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
  pop.style.cssText = 'position:fixed;z-index:9999;display:flex;flex-direction:column;gap:8px;min-width:190px;padding:11px 13px;border:1px solid #2b2f37;border-radius:11px;background:linear-gradient(180deg,#14171c,#0e1013);box-shadow:0 16px 44px rgba(0,0,0,.6);font-family:inherit;color:#e7eaef';
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
    b.style.cssText = 'flex:1;font:inherit;font-size:10.5px;color:#9097a1;background:#191c22;border:1px solid #2b2f37;border-radius:7px;padding:5px 0;cursor:pointer';
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
  btn.textContent = joined ? '🎙 Leave voice' : '🎙 Join voice';
  btn.classList.toggle('on', joined);
  if (mute) { mute.style.display = joined ? '' : 'none'; mute.textContent = (st && st.muted) ? 'Unmute' : 'Mute'; mute.classList.toggle('muted', !!(st && st.muted)); }
  if (box) {
    box.innerHTML = '';
    ((st && st.members) || []).forEach((m) => {
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
  }
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
  } else { const vr = $('voicerow'); if (vr) vr.style.display = 'none'; }
} catch (e) { try { const vr = $('voicerow'); if (vr) vr.style.display = 'none'; } catch (x) {} }

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
$('host-name-in').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doStartSharing(); } });
$('name-cancel').addEventListener('click', () => $('namemodal').classList.remove('show'));
// click the link to copy it (clipboard handled in main, so it works regardless of web perms)
shareLink.addEventListener('click', () => {
  if (!shareLink.value) return;
  shareLink.select(); claudible.clipWrite(shareLink.value);
  const prev = shareOut.textContent;
  shareOut.textContent = 'link copied ✓';
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
claudible.onShareApproval((info) => { approveQueue.push(info); showNextApproval(); });
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
    el.innerHTML = '<div class="ext-empty">No user/project skills found. Add one at <b>~/.claude/skills/&lt;name&gt;/SKILL.md</b> or this workspace’s <b>.claude/skills/</b>. (Bundled &amp; plugin skills aren’t listed here.)</div>';
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
    tog.addEventListener('click', async () => { let r = null; try { r = await claudible.skillsSet(s.name, on ? 'off' : 'on'); } catch {} if (r && r.ok) loadSkills(); });
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
  if (open) { refreshDiff(); _diffTimer = setInterval(() => refreshDiff({ quiet: true }), 4000); }   // keep it live while open
}
// The Repo Review header: which repo you're looking at (name + GitHub identity / local) + a live change summary.
function repoReviewHeader(aw, files, untracked, committed, commits, total) {
  const h = document.createElement('div'); h.className = 'rr-head';
  const name = document.createElement('div'); name.className = 'rr-name';
  const ico = document.createElement('span'); ico.className = 'rr-ico'; ico.innerHTML = (aw && aw.kind === 'repo') ? WS_REPO_SVG : WS_FOLDER_SVG;
  const nm = document.createElement('span'); nm.className = 'rr-nm'; nm.textContent = (aw && aw.label) || 'this folder'; nm.title = nm.textContent;
  name.appendChild(ico); name.appendChild(nm);
  let idText, url = '';
  if (aw && aw.kind === 'repo') {
    if (aw.owner && aw.slug) { idText = aw.owner + '/' + aw.slug; url = 'https://github.com/' + aw.owner + '/' + aw.slug; }
    else {
      const ru = String(aw.repoUrl || '');
      idText = ru.replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/^git@github\.com:/i, '').replace(/\.git$/, '') || 'shared GitHub repo';
      if (/^https?:\/\//i.test(ru)) url = ru.replace(/\.git$/, '');
      else if (/^git@github\.com:/i.test(ru)) url = 'https://github.com/' + ru.replace(/^git@github\.com:/i, '').replace(/\.git$/, '');
    }
  } else idText = 'local folder · private to you';
  const id = document.createElement('span'); id.className = 'rr-id'; id.textContent = idText; id.title = idText; name.appendChild(id);
  if (url) {                                                          // a clickable jump to the repo on GitHub (opens in the real browser)
    const visit = document.createElement('button'); visit.className = 'rr-visit'; visit.title = 'Open ' + idText + ' on GitHub ↗'; visit.setAttribute('aria-label', 'Open this repo on GitHub');
    visit.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
    visit.addEventListener('click', (e) => { e.stopPropagation(); try { claudible.openExternal(url); } catch (_) {} });
    name.appendChild(visit);
  }
  h.appendChild(name);
  const adds = files.reduce((s, f) => s + (f.additions || 0), 0), dels = files.reduce((s, f) => s + (f.deletions || 0), 0);
  const parts = [];
  if (typeof total === 'number' && total > 0) parts.push(total.toLocaleString() + ' commit' + (total > 1 ? 's' : '') + ' total');
  if (files.length) parts.push(files.length + ' file' + (files.length > 1 ? 's' : '') + ' changed');
  if (adds || dels) parts.push('+' + adds + ' −' + dels);
  if (untracked.length) parts.push(untracked.length + ' new');
  if (commits.length) parts.push(commits.length + ' this week');
  const sum = document.createElement('div'); sum.className = 'rr-sum'; sum.textContent = parts.length ? parts.join('  ·  ') : 'working tree clean';
  h.appendChild(sum);
  return h;
}
let _diffSig = '', _diffBusy = false;
async function refreshDiff(opts) {
  const body = $('diff-body'); if (!body) return;
  const quiet = opts && opts.quiet;                                    // auto-refresh: don't flash "reading…" or rebuild if unchanged
  if (quiet && _diffBusy) return;                                      // a refresh is already in flight — don't stack WSL spawns
  if (!quiet) body.innerHTML = '<div class="diff-empty">reading changes…</div>';
  _diffBusy = true;
  let r = null; try { r = await claudible.diffList(); } catch {}
  _diffBusy = false;
  if (!r || !r.ok) { if (!quiet) body.innerHTML = '<div class="diff-empty">Couldn’t read changes.</div>'; return; }
  if (!r.repo) { _diffSig = 'norepo'; body.innerHTML = '<div class="diff-empty">This workspace isn’t a git repo — nothing to review.<br>Diff review works in repo workspaces (or any folder that’s a git repo).</div>'; return; }
  const files = r.files || [], untracked = r.untracked || [], committed = r.committed || [], commits = r.commits || [];
  const aw = (typeof workspaces !== 'undefined') ? workspaces.find((w) => w.id === activeWsId) : null;   // which repo this review is for
  const total = (r && typeof r.total === 'number') ? r.total : null;   // lifetime commit tally
  // change-signature, so a silent auto-refresh leaves the panel (and your scroll) untouched when nothing changed
  const sig = JSON.stringify({ ws: activeWsId, t: total, f: files.map((f) => [f.path, f.additions, f.deletions]), u: untracked, c: commits.map((c) => c.hash), cf: committed.map((f) => [f.path, f.additions, f.deletions]) });
  if (quiet && sig === _diffSig) return;
  _diffSig = sig;
  if (!files.length && !untracked.length && !committed.length) {
    body.innerHTML = ''; body.appendChild(repoReviewHeader(aw, files, untracked, committed, commits, total));
    const _e = document.createElement('div'); _e.className = 'diff-empty'; _e.textContent = 'No changes yet — nothing in the working tree or recent commits. ✨'; body.appendChild(_e); return;
  }
  body.innerHTML = '';
  body.appendChild(repoReviewHeader(aw, files, untracked, committed, commits, total));   // header: which repo + change summary
  if (files.length || untracked.length) {
    const lbl = document.createElement('div'); lbl.className = 'diff-sec-lbl'; lbl.textContent = 'uncommitted — in the working tree';
    body.appendChild(lbl);
    files.forEach((f) => body.appendChild(renderDiffFile(f, false)));
    if (untracked.length) {
      const ul = document.createElement('div'); ul.className = 'diff-sec-lbl'; ul.textContent = 'new files (untracked)';
      body.appendChild(ul);
      untracked.forEach((p) => body.appendChild(renderUntracked(p)));
    }
  }
  if (committed.length) {                                              // work Claude already committed — visible, review-only
    const lbl = document.createElement('div'); lbl.className = 'diff-sec-lbl';
    lbl.textContent = 'recent · this week' + (commits.length ? ' · ' + commits.length + ' commit' + (commits.length > 1 ? 's' : '') : '') + ' · review only';
    body.appendChild(lbl);
    if (commits.length) body.appendChild(renderCommitList(commits));
    committed.forEach((f) => body.appendChild(renderDiffFile(f, true)));
  }
}
function renderCommitList(commits) {
  const box = document.createElement('div'); box.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin:2px 0 8px';
  commits.forEach((c) => {
    const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:baseline;gap:8px;font-size:11.5px;line-height:1.4';
    const h = document.createElement('code'); h.textContent = c.hash; h.style.cssText = 'color:#7f9cff;flex:none;font-size:11px';
    const s = document.createElement('span'); s.textContent = c.subject; s.title = c.subject; s.style.cssText = 'color:var(--ink,#e7eaef);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0';
    const m = document.createElement('span'); m.textContent = [c.author, c.date].filter(Boolean).join(' · '); m.style.cssText = 'color:var(--ink-faint,#565c66);flex:none;font-size:10px';
    row.appendChild(h); row.appendChild(s); row.appendChild(m); box.appendChild(row);
  });
  return box;
}
async function doDiffRevert(patch, btn, label) {
  btn.disabled = true;
  let r = null; try { r = await claudible.diffRevert(patch); } catch {}
  if (r && r.ok) { toast(label || 'Reverted'); refreshDiff(); }
  else { btn.disabled = false; toast('Revert failed' + (r && r.error ? ': ' + humanError(r.error) : '')); }
}
function renderDiffFile(f, readOnly) {
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
    rb.addEventListener('click', () => doDiffRevert(f.filePatch, rb, 'Reverted ' + f.path));
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
      rv.addEventListener('click', () => doDiffRevert(h.patch, rv, 'Reverted hunk'));
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
function renderUntracked(p) {
  const row = document.createElement('div'); row.className = 'diff-file';
  const head = document.createElement('div'); head.className = 'diff-file-head';
  const nm = document.createElement('span'); nm.className = 'diff-path'; nm.textContent = p; nm.title = p;
  const tag = document.createElement('span'); tag.className = 'diff-counts'; const t = document.createElement('i'); t.className = 'add'; t.textContent = 'new'; tag.appendChild(t);
  const db = document.createElement('button'); db.className = 'diff-revert-file'; db.textContent = 'Discard'; db.title = 'Delete this new file';
  db.addEventListener('click', async () => {
    db.disabled = true; let r = null; try { r = await claudible.diffDiscard(p); } catch {}
    if (r && r.ok) { toast('Discarded ' + p); refreshDiff(); } else { db.disabled = false; toast('Discard failed' + (r && r.error ? ': ' + humanError(r.error) : '')); }
  });
  head.appendChild(nm); head.appendChild(tag); head.appendChild(db); row.appendChild(head); return row;
}
$('diff-btn').addEventListener('click', () => openDiff(!$('diffpanel').classList.contains('open')));
$('diff-close').addEventListener('click', () => openDiff(false));
$('diff-refresh').addEventListener('click', refreshDiff);
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
    d.appendChild(w); d.appendChild(body); chatLog.appendChild(d);
  });
  chatLog.scrollTop = chatLog.scrollHeight;
}
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
    loadPrefs._cache = Object.assign({}, ls, disk);   // disk is source of truth; ls only fills gaps (migration)
    try { if (window.claudible && claudible.settingsSave && Object.keys(ls).length && !Object.keys(disk).length) claudible.settingsSave(loadPrefs._cache); } catch {}
  }
  return loadPrefs._cache;
}
function savePrefs(patch) {
  const p = loadPrefs(); Object.assign(p, patch);
  try { if (window.claudible && claudible.settingsSave) claudible.settingsSave(p); } catch {}   // durable, synchronous file write
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch {}                            // legacy mirror
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
  applyTtsSpeed(p.ttsSpeed || 0, false);
  if (p.pttKey) { if (isSafePttKey(p.pttKey)) pttKey = p.pttKey; else savePrefs({ pttKey: 'AltLeft' }); }   // self-heal a bad saved key (e.g. an old rebind to Space) so it can't keep eating the spacebar
  applyPttKey();   // render the current push-to-talk key (default or saved)
  syncVoiceUI();   // reflect saved voice + always-speak in the top-bar Voice Out box
})();

// ---------- sessions sidebar (switch between Claude conversations, like Claude Code) ----------
const sessListEl = $('sess-list');
const bodyEl = document.querySelector('.body');
// activeSession / workspaces / activeWsId are declared up top (near the tabs Map) so the tab-strip boot can
// reference them. The conversation order is stored PER workspace so switching libraries never reshuffles another's.
function orderKey() { return 'wsOrder2_' + activeWsId; }   // v2: re-seed from the shared `created` order (drops divergent per-machine v1 orders)
function getOrder() { return loadPrefs()[orderKey()] || []; }
function setOrder(order) { savePrefs({ [orderKey()]: order }); }
function relTime(sec) {
  if (!sec) return '';
  const d = Math.max(0, Date.now() / 1000 - sec);
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  return Math.floor(d / 86400) + 'd ago';
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
const CARET_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';   // ▾ options-menu trigger (shared by workspace chips and session rows)
let sessIndex = {};                                                                 // id -> session record (labels/preview)
// Session title: prefer the workspace-shared name (so everyone in a repo workspace sees the SAME title), then a
// local-only override (legacy/local workspaces, or before the first poll), then the transcript-derived preview.
function sessTitle(s) {
  const shared = remoteTitles[s.id];
  if (shared) return shared;
  const t = (loadPrefs().sessionTitles || {})[s.id];
  return t || s.preview;
}
function sessionOpenInTab(id) { for (const r of tabs.values()) if (r.wsId === activeWsId && r.session === id) return true; return false; }
// ---- Live sessions: advertise the session I'm hosting; discover + join a collaborator's, natively ----
// Explicit opt-in: I only host (advertise) a session after I pick "Share live" on it — NOT automatically just
// because sync is on. sharedSessionId is the one session I've chosen to share (null = not sharing). It resets on
// reload, so a refresh never silently re-hosts (the bug that made two people both host the same session).
let sharedSessionId = null;
function isSharingSession(id) { return !!id && sharedSessionId === id; }
// Advertise only changes when it actually changes (avoids spamming presence pushes).
function updateAdvertise() {
  const aw = workspaces.find((w) => w.id === activeWsId);
  const want = (tunnelUp && aw && aw.kind === 'repo' && activeSession && activeSession === sharedSessionId) ? activeSession : null;
  if (want === advertisedSession) return;
  advertisedSession = want;
  if (!want) { try { claudible.liveUnadvertise(); } catch (e) {} return; }
  // advertise + warn the host if the tunnel isn't actually up (so they know WHY a collaborator can't join,
  // instead of silently publishing an unreachable handle). The main-process heartbeat self-heals once it connects.
  try {
    claudible.liveAdvertise(want, collabName())
      .then((r) => { if (r && r.error === 'tunnel-down') toast('Sharing started — but the live tunnel isn’t up yet, so collaborators can’t join until it connects. Check your internet / that cloudflared isn’t blocked.'); })
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
  const aw = workspaces.find((w) => w.id === activeWsId);
  collabLive = !!(aw && aw.kind === 'repo' && activeSession && activeSession === sharedSessionId);   // explicit: tunnel only when I've chosen to Share THIS session
  ensureTunnel();
  renderLiveBar();                                  // show/hide the in-session "● Live · who's here" bar
}
// Toggle live-sharing of a session from the ▾ menu. Sharing streams the live pty, so the session must be the
// active one — switch to it if needed. Stop sharing drops the tunnel (unless a manual web-share is up).
function toggleShareSession(s) {
  if (!s || !s.id) return;
  if (sharedSessionId === s.id) {
    sharedSessionId = null;
    updateCollab(); updateAdvertise(); refreshSessions();
    toast('Stopped sharing this session');
  } else {
    sharedSessionId = s.id;
    if (activeSession !== s.id) openSession(s.id, sessTitle(s));   // must be the running session to stream it live
    updateCollab(); updateAdvertise(); refreshSessions();
    toast('Sharing live — collaborators can now Join');
  }
}
// Poll the shared branch for collaborators who are live (only in a repo workspace). Re-render on change.
async function pollLivePeers() {
  const aw = workspaces.find((w) => w.id === activeWsId);
  if (!(aw && aw.kind === 'repo')) { if (livePeers.length) { livePeers = []; livePeersSig = ''; refreshSessions(); } return; }
  let peers = []; try { peers = await claudible.livePeers(); } catch (e) {}
  const now = Date.now() / 1000;
  peers = (peers || []).filter((p) => p && p.session && p.url && p.token && (now - (p.ts || 0) < 300));   // drop stale (>5 min; a live host re-stamps every ~2 min)
  const sig = JSON.stringify(peers.map((p) => [p.session, p.login, p.ts, !!sessIndex[p.session]]).sort());   // include local-presence so the Join badge re-renders the moment the host's session syncs into our list — not only when a peer changes (fixes "Join only shows when I click around")
  if (sig === livePeersSig) return;
  livePeersSig = sig; livePeers = peers; refreshSessions();
}
setInterval(pollLivePeers, 10000);
// Poll the workspace-shared session names (repo workspaces only). Throttled so the list render that calls it
// can't spam branch reads; a forced call (after my own rename's push) bypasses the throttle. Re-render on change.
async function pollTitles(force) {
  const aw = workspaces.find((w) => w.id === activeWsId);
  if (!(aw && aw.kind === 'repo')) { remoteTitles = {}; titlesSig = ''; return; }
  const now = Date.now();
  if (!force && now - lastTitlePoll < 15000) return;
  lastTitlePoll = now;
  let m = {}; try { m = await claudible.titleList(); } catch (e) {}
  if (!m || typeof m !== 'object') m = {};
  const sig = JSON.stringify(Object.entries(m).sort());
  if (sig === titlesSig) return;
  titlesSig = sig; remoteTitles = m; refreshSessions();
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
// Sizing: a guest can't resize the host's pty, so we mirror the host's FIXED grid and scale the font to contain
// it in the pane (never a CSS transform — that breaks xterm's char metrics + text selection).
function fitLiveTab(rec) {
  if (!rec || rec.kind !== 'live' || !rec.container) return;
  const cols = rec.hostCols || 120, rows = rec.hostRows || 32;
  const cs = getComputedStyle(rec.container);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const pw = rec.container.clientWidth - padX, ph = rec.container.clientHeight - padY;
  if (pw <= 0 || ph <= 0) return;
  const wFont = pw / (cols * 0.6), hFont = ph / (rows * 1.18);       // largest font whose whole grid still fits
  const fs = Math.max(6, Math.min(30, Math.floor(Math.min(wFont, hFont))));
  try { if (rec.term.options.fontSize !== fs) rec.term.options.fontSize = fs; } catch {}
  try { rec.term.resize(cols, rows); } catch {}
}
// Per-tab overlay for the non-streaming states (connecting / waiting / reconnecting / paused / declined / offline).
function setLiveState(rec, state, detail) {
  if (!rec || rec.kind !== 'live') return;
  rec.liveState = state || '';
  rec.liveReason = detail || rec.liveReason || '';
  const meta = document.querySelector('[data-livetab="' + rec.tabId + '"] .sess-meta');
  if (meta) meta.innerHTML = '<span class="sess-livedot"></span>joined · ' + (LIVE_STATE_LABEL[rec.liveState] || 'live') + (((rec.liveState === 'offline' || rec.liveState === 'denied') && rec.liveReason) ? ' — ' + rec.liveReason : '');
  let ov = rec.container.querySelector('.live-ov');
  if (!(state && state !== 'live')) { if (ov) ov.classList.remove('show'); return; }
  if (!ov) { ov = document.createElement('div'); ov.className = 'live-ov'; rec.container.appendChild(ov); }
  const who = (rec.peer && (rec.peer.name || rec.peer.login)) || rec.hostName || 'the host';
  ov.textContent = ({
    connecting: 'Connecting to ' + who + '’s live session…',
    pending: 'Waiting for ' + who + ' to let you in…',
    reconnecting: 'Reconnecting…',
    paused: who + ' stepped into a private workspace — the mirror is paused.',
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
    $('trk-ctx').textContent = 'CONTEXT ' + pct + '%';
    $('trk-ctxfill').style.width = Math.max(2, Math.min(100, pct)) + '%';
    bar.classList.toggle('warn', pct >= 70 && pct < 85);
    bar.classList.toggle('crit', pct >= 85);
    bar.title = 'host context window used';
  } else {
    $('trk-ctx').textContent = 'CONTEXT —'; $('trk-ctxfill').style.width = '2%';
    bar.classList.remove('warn', 'crit'); bar.title = 'host context window used';
  }
  $('trk-cost').textContent = rec.liveCost != null ? rec.liveCost : '$0.00'; $('trk-cost').title = 'host session cost';
  if (bar) bar.title = bar.title + ' · ' + $('trk-cost').textContent + ' host session cost';
  $('trk-tokens').textContent = rec.liveTokens != null ? rec.liveTokens : '0'; $('trk-tokens').title = 'host session tokens';
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
  rec.label = 'Live · ' + who; rec.curSessionLabel = 'Live · ' + who; rec.hostName = who;
  rec.joinedAsLabel = localLabel || '';                              // name the joined tab after the row you clicked, until the host broadcasts its own session name
  setActiveTab(id);
  setLiveState(rec, 'connecting');
  refreshSessions();                                                 // surface the joined-tab row immediately
  claudible.liveConnect(id, peer, collabName()).then((r) => {
    if (!r || !r.ok) { toast('Could not join ' + who + ': ' + humanError(r && r.error)); closeTab(id); }   // don't leave a dead "ended" tab — close it and tell the user why
  }).catch((err) => { console.error('[live] liveConnect rejected:', err); toast('Could not join ' + who + ' — connection failed'); closeTab(id); });
 } catch (e) { console.error('[live] openLiveTab THREW:', e && (e.stack || e.message || e)); toast('Join failed: ' + ((e && e.message) || e)); }
}
// A joined live session as a sidebar row (pinned at the top): click to switch, ✕ to leave.
function renderJoinedTabRow(rec) {
  const row = document.createElement('div');
  row.className = 'sess sess-joined-live' + (rec.tabId === activeTabId ? ' active' : '');
  row.dataset.livetab = rec.tabId; row.setAttribute('role', 'button'); row.tabIndex = 0;
  const who = (rec.peer && (rec.peer.name || rec.peer.login)) || rec.hostName || 'collaborator';
  const sessName = rec.liveSessName || '';                                          // host's real current session name (once reported), else a host-name placeholder
  const p = document.createElement('div'); p.className = 'sess-prev'; p.textContent = '● ' + (sessName || rec.joinedAsLabel || (who + '’s session'));
  const m = document.createElement('div'); m.className = 'sess-meta';
  if (rec.sessMismatch) m.innerHTML = '<span class="sess-livedot"></span>⚠ host moved to another session · ' + who;
  else m.innerHTML = '<span class="sess-livedot"></span>joined · ' + who + ' · ' + (LIVE_STATE_LABEL[rec.liveState] || 'live') + (((rec.liveState === 'offline' || rec.liveState === 'denied') && rec.liveReason) ? ' — ' + rec.liveReason : '');
  row.appendChild(p); row.appendChild(m);
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
function renderSessionRow(s) {
  const row = document.createElement('div');
  row.className = 'sess' + (s.id === activeSession ? ' active' : '') + (sessionOpenInTab(s.id) ? ' open-in-tab' : '');
  row.dataset.id = s.id; row.setAttribute('role', 'button'); row.tabIndex = 0;
  const p = document.createElement('div'); p.className = 'sess-prev'; p.textContent = sessTitle(s);
  const m = document.createElement('div'); m.className = 'sess-meta';
  const mt = document.createElement('span'); mt.className = 'sess-meta-t';
  mt.textContent = relTime(s.mtime);   // last-active time only — msg count dropped to cut clutter
  m.appendChild(mt);
  // live indicator — inline at the right of the meta line (normal flow, so it can never overflow the row)
  if (isSharingSession(s.id)) {
    row.classList.add('sess-live-row');                              // green left accent bar — you're sharing this live
    const lv = document.createElement('span'); lv.className = 'sess-live-ind';
    lv.innerHTML = '<span class="live-dot"></span><span class="liw">Live</span>'; lv.title = 'You are sharing this session live';
    m.appendChild(lv);
  } else {
    const _lp = livePeers.find((x) => x.session === s.id);
    if (_lp) { row.classList.add('sess-live-row'); m.appendChild(makeLiveBadge(_lp, sessTitle(s))); }   // a collaborator is live here → green bar + calm dot, "Join" on hover (carry this row's name onto the joined tab)
  }
  row.appendChild(p); row.appendChild(m);
  if (s.deletedRemote) {                                             // a collaborator deleted this on GitHub → soft red "removed" chip
    const db = document.createElement('button');
    db.className = 'sess-chip removed'; db.title = 'Deleted from GitHub by a collaborator';
    db.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>removed';
    db.addEventListener('click', (e) => { e.stopPropagation(); openDeletedRemoteModal(s); });
    m.appendChild(db);
  } else if (s.diverged) {                                           // same session edited on both machines → soft amber "diverged" chip
    const vb = document.createElement('button');
    vb.className = 'sess-chip diverged'; vb.title = 'Edited on both machines — your copy and the shared copy differ';
    vb.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg>diverged';
    vb.addEventListener('click', (e) => { e.stopPropagation(); openDivergedInfo(s); });
    m.appendChild(vb);
  }
  // A single ▾ opens the per-session options menu (Rename / Export / Delete) — mirrors the workspace ▾ menu,
  // so the row stays a clean title with nothing crowding it and no inline confirm strip to overflow.
  const mb = document.createElement('button');
  mb.className = 'sess-menu-btn'; mb.title = 'Session options'; mb.setAttribute('aria-label', 'Session options');
  mb.innerHTML = CARET_SVG;
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
// Inline rename: pencil → editable input in place of the title; Enter/blur saves, Esc cancels. Stored in prefs.
function startSessEdit(row, p, s) {
  if (row.querySelector('.sess-rename')) return;
  row.classList.add('renaming');                                      // hide the ▾ so nothing floats over the input
  const inp = document.createElement('input');
  inp.className = 'sess-rename'; inp.type = 'text'; inp.maxLength = 200; inp.value = sessTitle(s);
  p.style.display = 'none'; row.insertBefore(inp, p);
  inp.focus(); inp.select();
  let done = false;
  const commit = (save) => {
    if (done) return; done = true;
    if (save) {
      const t = inp.value.trim();
      const titles = loadPrefs().sessionTitles || {};
      if (t && t !== s.preview) titles[s.id] = t; else delete titles[s.id];   // blank or == auto preview → clear override
      savePrefs({ sessionTitles: titles });
      // In a repo workspace, publish the name so EVERY collaborator sees it (last-writer-wins on the branch).
      // Optimistically reflect it locally so the row updates instantly; a forced poll reconciles after the push.
      const _aw = workspaces.find((w) => w.id === activeWsId);
      if (_aw && _aw.kind === 'repo') {
        const shared = (t && t !== s.preview) ? t : '';
        if (shared) remoteTitles[s.id] = shared; else delete remoteTitles[s.id];
        try { claudible.titleSet(s.id, shared).then(() => pollTitles(true)).catch(() => {}); } catch (e) {}
      }
      p.textContent = sessTitle(s);
      { const at = AT(); if (at && s.id === activeSession) { at.curSessionLabel = p.textContent; pushTracker(); } }   // mirror the new title to guests
    }
    try { inp.remove(); } catch {} p.style.display = ''; row.classList.remove('renaming');
  };
  inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); commit(true); } else if (e.key === 'Escape') { e.preventDefault(); commit(false); } });
  inp.addEventListener('blur', () => commit(true));
  inp.addEventListener('pointerdown', (e) => e.stopPropagation());   // don't start a row drag / open
  inp.addEventListener('click', (e) => e.stopPropagation());
}
// ---- per-session options (▾) menu: Rename / Export / Delete live here so each row stays a clean title ----
// Mirrors the workspace ▾ menu (same .ws-menu look) and, like the workspace delete, confirms via the native
// dialog — so there's no inline confirm strip to overflow the narrow row.
function doExportSession(s) {
  claudible.exportSession(s.id).then((r) => {
    if (r && r.saved) toast('Replay saved · ' + r.saved.replace(/^.*[\\/]/, ''));
    else if (r && r.canceled) { /* user dismissed the save dialog */ }
    else toast(r && r.error === 'empty' ? 'Nothing to export in this session yet' : 'Export failed');
  }).catch(() => toast('Export failed'));
}
function doExportSessionText(s) {
  claudible.exportSessionText(s.id).then((r) => {
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
      hint: isSharingSession(s.id) ? 'Stop sharing this session with collaborators.' : 'Share this session live so a collaborator can Join and co-drive it.',
      act: () => toggleShareSession(s) });
    const peer = livePeers.find((x) => x.session === s.id);
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
      act: () => { if (confirm('Delete “' + sessTitle(s) + '” from this machine?\nIt may sync back if a collaborator still has it. Moves to ~/.claudible/trash (recoverable).')) deleteSession(s.id, 'local'); } });
    items.push({ icon: TRASH_SVG, label: 'Delete everywhere', danger: true, hint: 'Also delete from GitHub for everyone — can’t be undone.',
      act: () => { if (confirm('Delete “' + sessTitle(s) + '” everywhere?\nThis removes it from GitHub for everyone and can’t be undone.')) deleteSession(s.id, 'everywhere'); } });
  } else {
    items.push({ icon: TRASH_SVG, label: 'Delete', danger: true, hint: 'Move to trash (recoverable).',
      act: () => { if (confirm('Delete “' + sessTitle(s) + '”?\nMoves to ~/.claudible/trash (recoverable).')) deleteSession(s.id, 'local'); } });
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
  const rows = Array.prototype.slice.call(sessListEl.querySelectorAll('.sess:not(.sess-live)')).filter((r) => r !== sdrag.row);
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
    const order = Array.prototype.slice.call(sessListEl.querySelectorAll('.sess:not(.sess-live)')).map((r) => r.dataset.id);
    setOrder(order);                                                               // manual order persists (per workspace)
  } else {
    openSession(d.id, d.label);                                                    // plain click → open
  }
}
const deletingIds = new Set();                                                     // hide rows mid-delete so they can't flash back as "fresh"
async function deleteSession(id, scope) {
  if (deletingIds.has(id)) return;
  deletingIds.add(id);
  const order = getOrder().filter((x) => x !== id);
  setOrder(order);
  // Any tab resuming this session must switch OFF it BEFORE the file is deleted (else it holds the file open).
  for (const rec of Array.from(tabs.values())) {
    if (rec.wsId === activeWsId && rec.session === id) {
      const next = order[0] || 'new';
      if (rec.tabId === activeTabId) await openSession(next, next === 'new' ? '' : (sessIndex[next] && sessIndex[next].preview));
      else { rec.session = next; rec.label = ''; try { await claudible.sessionOpen(rec.tabId, next); } catch {} }
    }
  }
  let r = null; try { r = await claudible.sessionDelete(id, scope || 'local'); } catch {} finally { deletingIds.delete(id); }
  if (scope === 'everywhere') { try { toast(r && r.ok ? 'Deleted everywhere' : 'Deleted here — GitHub removal failed, try Sync'); } catch {} }
  refreshSessions(); renderTabStrip();
}
// Lightweight centered choice modal (self-contained; labels/subs are static strings we control). Resolves the
// chosen key, or null on Cancel / backdrop / Esc.
function modalChoice({ title, body, choices }) {
  if (pttCapturing) stopCapture();                                   // a modal cancels any in-progress PTT rebind — else the capture-phase keydown eats the modal's Escape/keys
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.style.cssText = 'position:fixed;inset:0;z-index:10002;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)';   /* above toasts (10001) so a toast can't obscure the modal */
    const box = document.createElement('div');
    box.style.cssText = 'min-width:320px;max-width:440px;padding:20px;border:1px solid #2b2f37;border-radius:14px;background:linear-gradient(180deg,#14171c,#0e1013);box-shadow:0 24px 64px rgba(0,0,0,.6);color:#e7eaef;font-family:inherit';
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
      const danger = c.danger ? 'border-color:#7a3030;color:#ff8e8e;background:rgba(150,40,40,.12)' : 'border-color:#2b2f37;color:#cfd6df;background:#191c22';
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
    box.style.cssText = 'min-width:330px;max-width:440px;padding:20px;border:1px solid #2b2f37;border-radius:14px;background:linear-gradient(180deg,#14171c,#0e1013);box-shadow:0 24px 64px rgba(0,0,0,.6);color:#e7eaef;font-family:inherit';
    const h = document.createElement('div'); h.textContent = title; h.style.cssText = 'font-size:15px;font-weight:650;margin-bottom:8px'; box.appendChild(h);
    if (body) { const bd = document.createElement('div'); bd.textContent = body; bd.style.cssText = 'font-size:12.5px;line-height:1.5;color:#aab2bd;margin-bottom:14px'; box.appendChild(bd); }
    const inp = document.createElement('input'); inp.type = 'text'; inp.maxLength = 200; inp.placeholder = placeholder || ''; inp.value = value || '';
    inp.style.cssText = 'width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #2b2f37;border-radius:9px;background:#0a0b0d;color:#e7eaef;font:inherit;font-size:13px;outline:none;margin-bottom:16px';
    box.appendChild(inp);
    const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
    cancel.style.cssText = 'font:inherit;font-size:12.5px;padding:8px 14px;border:1px solid #2b2f37;border-radius:9px;cursor:pointer;color:#cfd6df;background:#191c22';
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
  const name = sessTitle(s);
  const choice = await modalChoice({
    title: 'Session deleted on GitHub',
    body: 'A collaborator deleted “' + name + '” from the shared workspace. Your local copy is still here — delete it too, or keep it on this machine?',
    choices: [
      { key: 'delete', label: 'Fully delete', sub: 'Remove it from this machine too. It stays deleted for everyone.', danger: true },
      { key: 'keep', label: 'Keep locally', sub: 'Keep your copy here. It won’t be re-shared, and this alert clears.' },
      { key: 'cancel', label: 'Cancel' },
    ],
  });
  if (choice === 'delete') await deleteSession(s.id, 'local');       // already tombstoned on the branch → just trash the local copy
  else if (choice === 'keep') { try { await claudible.sessionKeep(s.id); } catch (e) {} refreshSessions(); }
}
// Same session edited on both machines (true fork) — informational.
function openDivergedInfo(s) {
  modalChoice({
    title: 'This session diverged',
    body: '“' + sessTitle(s) + '” was edited on both machines, so your copy and the shared copy differ and can’t auto-merge. Keep working in whichever copy you want; the badge clears once they line up again.',
    choices: [{ key: 'ok', label: 'Got it' }],
  });
}
async function refreshSessions() {
  const myWs = activeWsId;                                                          // ignore this refresh if we switch workspaces mid-flight
  closeSessMenu();                                                                  // a re-render replaces the rows the open ▾ menu was anchored to
  if (!sessListEl.querySelector('.sess')) sessListEl.innerHTML = '<div class="sess-empty">loading…</div>';   // only show the spinner on a cold list (no flash on re-render)
  let list = []; try { list = await claudible.sessionList(); } catch {}
  if (myWs !== activeWsId) return;                                                  // a newer workspace switch already owns the list
  if (!Array.isArray(list)) list = [];
  if (deletingIds.size) list = list.filter((s) => !deletingIds.has(s.id));          // hide rows being deleted
  const savedIds = new Set(list.map((s) => s.id));
  // A live tab gets its OWN sidebar row whenever it isn't ALREADY shown as a saved row. That covers a brand-
  // new 'new' tab AND a just-started session whose real id exists but whose transcript file hasn't been
  // written to disk yet — so the row never vanishes in the gap between "created" and "first saved". The
  // empty-session boot tab ('') is excluded: it resolves to the most-recent saved row via reconcile, so it
  // must not flash a phantom "New session" at launch.
  const liveTabs = Array.from(tabs.values()).filter((r) => r.wsId === activeWsId && r.session !== '' && !savedIds.has(r.session));
  const joinedLive = Array.from(tabs.values()).filter((r) => r.kind === 'live');   // peers' sessions I've joined (cross-workspace) → always reachable
  if (!list.length && !liveTabs.length && !joinedLive.length) {
    sessListEl.innerHTML = '<div class="sess-empty">No saved sessions yet. Start working and it’ll show up here.</div>';
    return;
  }
  const order = mergeSessionOrder(getOrder(), list);
  setOrder(order);
  sessIndex = {}; list.forEach((s) => { sessIndex[s.id] = s; });
  const ordered = order.map((id) => sessIndex[id]).filter(Boolean);
  // Default highlight must match what session.sh `--continue` resumes — the most-recent conversation
  // (max mtime) — not the top of the stable saved order.
  // Pick a default highlight only when the active tab isn't itself on a brand-new session (don't hijack the
  // highlight to a saved row while the user is sitting in a fresh "New session").
  if (!activeSession && list.length && !(AT() && AT().session === 'new')) { const mru = list.slice().sort((a, b) => (b.mtime || 0) - (a.mtime || 0))[0]; activeSession = (mru || ordered[0]).id; }
  const act = sessIndex[activeSession];
  const at = AT();
  if (at && act && !at.curSessionLabel) { at.curSessionLabel = act.preview; pushTracker(); }    // tell guests which session is live
  sessListEl.innerHTML = '';
  joinedLive.forEach((rec) => sessListEl.appendChild(renderJoinedTabRow(rec)));      // peers' live sessions I've joined — pinned at the top
  ordered.forEach((s) => sessListEl.appendChild(renderSessionRow(s)));
  liveTabs.forEach((rec) => sessListEl.appendChild(renderLiveTabRow(rec)));          // live, not-yet-saved sessions, appended below
  if (livePeers.length) {                                                            // a collaborator is live in a session we don't have locally yet
    const _localIds = new Set(ordered.map((s) => s.id));
    livePeers.forEach((p) => { if (!_localIds.has(p.session)) sessListEl.appendChild(renderLivePeerRow(p)); });
  }
  const activeLive = sessListEl.querySelector('.sess.sess-live.active');             // a just-created session sits at the bottom → bring it into view
  if (activeLive) { try { activeLive.scrollIntoView({ block: 'nearest' }); } catch {} }
  updateCollab();                                                                   // synced repo session → tunnel up so a peer can Join live (no bottom-left indicator)
  pollTitles();                                                                     // refresh workspace-shared names (throttled inside)
}
// A live, not-yet-saved session (a tab with no transcript on disk yet) rendered as a sidebar row: click to
// switch to it; the ▾ menu renames or CLOSES it (nothing to delete on disk). Mirrors a saved row's look.
function renderLiveTabRow(rec) {
  const row = document.createElement('div');
  row.className = 'sess sess-live' + (rec.tabId === activeTabId ? ' active' : '') + (rec.busy ? ' busy' : '');
  row.dataset.tab = rec.tabId; row.setAttribute('role', 'button'); row.tabIndex = 0;
  const p = document.createElement('div'); p.className = 'sess-prev'; p.textContent = rec.label || 'New session';
  const m = document.createElement('div'); m.className = 'sess-meta';
  m.innerHTML = '<span class="sess-livedot"></span>' + (rec.busy ? 'working…' : 'live · unsaved');
  row.appendChild(p); row.appendChild(m);
  const mb = document.createElement('button');
  mb.className = 'sess-menu-btn'; mb.title = 'Session options'; mb.setAttribute('aria-label', 'Session options');
  mb.innerHTML = CARET_SVG;
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
  let done = false;
  const commit = (save) => {
    if (done) return; done = true;
    if (save) {
      rec.label = inp.value.trim() || '';
      rec.pendingTitle = rec.label;                                  // keep the to-persist title in sync so a rename BEFORE the session resolves sticks (and isn't clobbered by the creation-time name)
      p.textContent = rec.label || 'New session';
      if (rec.tabId === activeTabId) { rec.curSessionLabel = p.textContent; pushTracker(); }   // mirror to guests
    }
    try { inp.remove(); } catch {} p.style.display = ''; row.classList.remove('renaming');
  };
  inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); commit(true); } else if (e.key === 'Escape') { e.preventDefault(); commit(false); } });
  inp.addEventListener('blur', () => commit(true));
  inp.addEventListener('pointerdown', (e) => e.stopPropagation());
  inp.addEventListener('click', (e) => e.stopPropagation());
}
// Cheap in-place busy toggle on a tab's sidebar row (no disk re-read): live row by tab id, or saved row by session id.
function markTabBusy(tabId, busy) {
  const rec = tabs.get(tabId); if (!rec || !sessListEl) return;
  let row = sessListEl.querySelector('.sess.sess-live[data-tab="' + tabId + '"]');
  if (!row && rec.session && rec.session !== 'new') row = sessListEl.querySelector('.sess[data-id="' + rec.session + '"]');
  if (!row) return;
  row.classList.toggle('busy', !!busy);
  if (row.classList.contains('sess-live')) {
    const meta = row.querySelector('.sess-meta');
    if (meta) meta.innerHTML = '<span class="sess-livedot"></span>' + (busy ? 'working…' : 'live · unsaved');
  }
}
// The sidebar is DOCKED (a left column of .body) — toggling .with-sessions slides the layout, it
// never covers the terminal/chat. The terminal auto-refits via its ResizeObserver when the column changes.
function openSidebar(open) {
  bodyEl.classList.toggle('with-sessions', open);
  if (open) { refreshWorkspaces(); refreshSessions(); }
}
// Clicking a session row: if a tab already hosts it, focus that tab; otherwise re-point the CURRENT tab
// to it (replacing the current tab's session, like before — but other tabs keep running). The explicit
// "New session" button opens a NEW tab instead (so it never clears what you're on).
async function openSession(id, label) {
  if (id !== 'new') {
    for (const rec of tabs.values()) {                // focus an existing tab for this (ws, session)
      if (rec.wsId === activeWsId && rec.session === id) { setActiveTab(rec.tabId); return; }
    }
  }
  const t = AT(); if (!t) return;
  if (id !== 'new' && t.session === id && t.wsId === activeWsId) return;   // already on this one
  t.session = id; t.wsId = activeWsId;
  t.label = (id === 'new') ? 'New session' : (label || 'Session');
  t.curSessionLabel = (id === 'new') ? 'New session' : (label || '');      // mirrored to guests
  activeSession = (id === 'new') ? null : id;
  updateAdvertise();                                  // if I'm sharing in a repo workspace, advertise the now-active session
  refreshSessions();                                  // re-highlight without collapsing (stays docked)
  t.term.reset();                                     // clear this tab's view
  resetStats(t);                                      // reset THIS tab's tracker baselines + push label to guests
  try { await claudible.sessionOpen(t.tabId, id); } catch {}   // re-point this tab's pty
  renderTabStrip();
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
function renderWsSessionRow(w, s) {
  const row = document.createElement('div'); row.className = 'sess'; row.setAttribute('role', 'button'); row.tabIndex = 0;
  const p = document.createElement('div'); p.className = 'sess-prev'; p.textContent = sessTitle(s); p.title = p.textContent;
  const m = document.createElement('div'); m.className = 'sess-meta'; const mt = document.createElement('span'); mt.className = 'sess-meta-t'; mt.textContent = relTime(s.mtime); m.appendChild(mt);
  row.appendChild(p); row.appendChild(m);
  const go = () => { switchWorkspace(w.id).then(() => openSession(s.id, sessTitle(s))); };   // switch to that workspace, then open the specific session
  row.addEventListener('click', go);
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  return row;
}
function renderWsNonActiveSessions(w, kids) {                          // a saved-sessions list for a NON-active expanded workspace
  const fill = (list) => {
    Array.from(kids.querySelectorAll('.sess,.sess-empty,.newsess-row')).forEach((n) => n.remove());
    const ordered = (list || []).slice().sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).slice(0, 60);
    if (!ordered.length) { const e = document.createElement('div'); e.className = 'sess-empty'; e.textContent = 'no sessions yet'; kids.appendChild(e); }
    else ordered.forEach((s) => kids.appendChild(renderWsSessionRow(w, s)));
    const nb = document.createElement('button'); nb.className = 'newsess-row'; nb.textContent = '+ New Session';
    nb.addEventListener('click', (e) => { e.stopPropagation(); switchWorkspace(w.id).then(() => newBlankTab(w.id, 'new')); });
    kids.appendChild(nb);
  };
  const c = _wsSessCache.get(w.id);
  if (c) fill(c.list); else { const l = document.createElement('div'); l.className = 'sess-empty'; l.textContent = 'loading…'; kids.appendChild(l); }
  if (!c || Date.now() - c.ts > 4000) {
    claudible.sessionListWs(w.id).then((list) => { const arr = Array.isArray(list) ? list : []; _wsSessCache.set(w.id, { list: arr, ts: Date.now() }); if (document.body.contains(kids)) fill(arr); }).catch(() => {});
  }
}
function renderWsChips() {
  const el = $('ws-chips'); if (!el) return;
  closeWsMenu();                 // a re-render replaces the chips/caret the open menu was anchored to
  // Preserve the live sessions list + its inline "+ New Session" across the wipe — they get moved INTO the active
  // workspace node below. .remove() keeps the JS ref (sessListEl) and the already-rendered rows alive, so a bare
  // renderWsChips() never drops the sessions. Without this, el.innerHTML='' would destroy the relocated nodes.
  const newSessEl = $('new-session');
  if (el.contains(sessListEl)) sessListEl.remove();
  if (newSessEl && el.contains(newSessEl)) newSessEl.remove();
  el.innerHTML = '';
  workspaces.forEach((w) => {
    const chip = document.createElement('div');
    chip.className = 'ws-chip' + (w.id === activeWsId ? ' active' : '') + (isWsExpanded(w.id) ? ' expanded' : '') + (w.shared ? ' shared' : '');
    chip.title = w.kind === 'legacy' ? 'Default space — quick chats, not tied to a project folder'
      : w.kind === 'repo' ? ((w.repoUrl || w.label) + ' — shared GitHub repo; sessions sync with your team')
      : (w.label + ' — a project folder on your machine (private to you)');
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
      const tag = document.createElement('span'); tag.textContent = 'invited';
      tag.style.cssText = 'flex:none;font-size:8px;letter-spacing:.06em;text-transform:uppercase;color:var(--ok,#5fb487);margin-left:4px';
      chip.appendChild(tag);
      chip.title = (w.owner ? w.owner + '/' + (w.slug || w.label) : w.label) + ' — invited shared workspace · click to choose where to save it';
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
    mb.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>';   // ⋯ manage — distinct from the expand chevron, never confused
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
      if (isLastLocal(w)) { try { toast('You need at least one local workspace'); } catch (e) {} return; }   // never delete the last local (the guaranteed home)
      e.preventDefault(); e.stopPropagation();
      if (confirm('Delete workspace "' + w.label + '"?\nIts folder moves to ~/.claudible/trash (recoverable). A repo workspace keeps its GitHub repo — only the local copy is removed.')) deleteWorkspace(w);
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
  pop.innerHTML = '<span class="wt"><b>What’s a workspace?</b></span>'
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
    + '<p>Teammates who have Claudible don’t need this — they just <b>Join</b> from the synced workspace.</p>';
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
    title: 'Add shared workspace',
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
  let r = null; try { r = await claudible.workspaceDelete(w.id); } catch {}
  if (r && r.ok) {
    if (r.activeId) activeWsId = r.activeId;
    // A background tab may still name the just-deleted workspace; main already repointed its pty to the
    // fallback, but the renderer tab record's wsId would otherwise let a later setActiveTab set activeWsId
    // to a workspace that no longer exists (blank chips + empty sessions header). Repoint those tabs too.
    for (const rec of tabs.values()) { if (rec.wsId === w.id) rec.wsId = r.activeId || activeWsId; }
    await refreshWorkspaces(); refreshSessions();
  } else toast('Delete failed' + (r && r.error ? ': ' + humanError(r.error) : ''));
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
        hint: 'Stop sharing this workspace’s sessions — no more sync, and teammates can no longer Join live.', act: () => disableSync(w) });
    } else {
      items.push({ icon: CLOUD_SVG, label: 'Collaborate in Claudible…',
        hint: 'Sync this workspace’s sessions over its GitHub repo so teammates can open, resume, AND Join your sessions live — no link needed.',
        act: () => openSyncModal(w) });
    }
  } else if (w.kind === 'local') {
    items.push({ icon: CLOUD_SVG, label: 'Sync across my devices…',
      hint: 'Back this workspace with a private GitHub repo so it + its sessions appear on your other devices (needs GitHub connected).',
      act: () => upgradeWorkspace(w) });
    items.push({ icon: PERSON_ADD_SVG, label: 'Invite someone…',
      hint: 'Share this workspace with a teammate — creates its private GitHub repo first, then adds them.',
      act: () => inviteToLocal(w) });
  }
  items.push({ sep: true });
  items.push({ icon: PENCIL_SVG, label: 'Rename', hint: 'Rename this workspace (local label only).', act: () => startWsEdit(chip, nm, w) });
  if (!isLastLocal(w)) {                                  // never offer delete on the LAST local workspace (the guaranteed home)
    items.push({
      icon: TRASH_SVG, label: 'Delete workspace', danger: true,
      hint: 'Move this workspace’s folder to trash (recoverable). A repo keeps its GitHub copy.',
      act: () => { if (confirm('Delete workspace "' + w.label + '"?\nIts folder moves to ~/.claudible/trash (recoverable). A repo workspace keeps its GitHub repo — only the local copy is removed.')) deleteWorkspace(w); },
    });
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
      if (t && t !== w.label) { let r = null; try { r = await claudible.workspaceRename(w.id, t); } catch {} if (r && r.ok) w.label = r.label; }
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
  if (!confirm('Sync "' + w.label + '" across your devices?\n\nThis creates a PRIVATE GitHub repo for it (you need GitHub connected). The workspace + its sessions then appear on your other devices, and you can invite people. Your Claude transcripts stay OUT of the repo.')) return;
  toast('Setting up sync — creating a private repo…');
  let r = null; try { r = await claudible.workspaceUpgrade(w.id); } catch (e) { r = { ok: false, error: e && e.message }; }
  if (r && r.ok) { toast('Synced ✓ — this workspace now appears on your other devices'); try { await refreshWorkspaces(); } catch {} }
  else { const m = (r && r.error) || 'unknown'; toast('Could not sync: ' + m + (/(gh|github|auth)/i.test(m) ? ' — connect GitHub first' : '')); }
}
// Inviting to a local workspace: it must become a synced repo first (collaborators need a GitHub repo), then
// open the normal invite modal on the now-repo workspace.
async function inviteToLocal(w) {
  toast('Preparing to share — creating a private repo…');
  let r = null; try { r = await claudible.workspaceUpgrade(w.id); } catch (e) { r = { ok: false, error: e && e.message }; }
  if (!r || !r.ok) { const m = (r && r.error) || 'unknown'; toast('Could not share: ' + m + (/(gh|github|auth)/i.test(m) ? ' — connect GitHub first' : '')); return; }
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
  else { busy.textContent = (r && r.error) || 'invite failed'; busy.classList.add('err'); }
}
// sessions sync: manual "sync now" (when already on); state arrives via the sync:state event from main.
async function triggerSyncNow(w) {
  wsSyncState[w.id] = Object.assign({}, wsSyncState[w.id], { status: 'syncing' }); renderWsChips();
  let r = null; try { r = await claudible.syncNow(w.id); } catch {}
  if (r && !r.ok && r.error !== 'busy') { wsSyncState[w.id] = { status: 'error' }; renderWsChips(); }
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
  else { busy.textContent = (r && r.error) || 'could not turn on sharing'; busy.classList.add('err'); }
}
let firstRunHandled = false, firstRunActive = false;
function isLastLocal(w) { return !!(w && w.kind === 'local' && workspaces.filter((x) => x.kind === 'local').length <= 1); }
// First launch (no local workspace existed → main materialized a default): once, welcome the user and open the
// workspace setup modal so they name + place their Local workspace. Clearing the flag means it shows only once.
function maybeFirstRun(r) {
  if (firstRunHandled || !r || !r.firstRun) return;
  firstRunHandled = true; firstRunActive = true;
  try { claudible.workspaceFirstRunDone && claudible.workspaceFirstRunDone(); } catch (e) {}
  try { toast('Welcome — name your workspace and pick where to keep it'); } catch (e) {}
  setTimeout(() => { try { openWsModal(); } catch (e) {} }, 450);
}
async function refreshWorkspaces() {
  let r = null; try { r = await claudible.workspaceList(); } catch {}
  if (r && Array.isArray(r.workspaces)) { workspaces = r.workspaces; if (r.activeId) activeWsId = r.activeId; }
  const at = AT(); if (at && !at.wsId) at.wsId = activeWsId;   // bind the boot tab to the real active workspace
  renderWsChips();
  maybeFirstRun(r);
}
// Switching the workspace re-points the FOREGROUND tab to that ws (main respawns its pty in the new cwd).
// Background tabs in other workspaces keep running. (New session / + opens a fresh tab instead.)
async function switchWorkspace(id) {
  if (id === activeWsId) return;
  let t = AT();
  if (t && t.kind === 'live') {                     // viewing a peer's session — a workspace switch applies to YOUR own tab, never the live mirror
    const local = [...tabs.values()].find((r) => r.kind !== 'live');
    if (!local) { toast('Open one of your own sessions first'); return; }
    setActiveTab(local.tabId); t = local;
  }
  if (!t) return;
  activeWsId = id; t.wsId = id; t.session = ''; t.label = '';
  setWsExpanded(id, true);                          // switching to a workspace auto-expands it (you can collapse it again with its chevron)
  activeSession = null; t.curSessionLabel = '';   // the conversation list is about to change entirely
  lastTitlePoll = 0; titlesSig = '';               // force a fresh shared-names fetch for the new workspace
  renderWsChips(); renderTabStrip();
  t.term.reset(); resetStats(t);                   // clear the foreground tab's view; main respawns its pty in the new cwd
  try { const r = await claudible.workspaceOpen(id); if (r && r.ok === false && r.error !== 'superseded') toast('Could not switch workspace' + (r.error ? ': ' + humanError(r.error) : '')); } catch (e) { toast('Could not switch workspace'); }
  refreshSessions();
  setTimeout(() => { if (term) term.focus(); }, 150);
}
// new-workspace chooser modal
let wsChoiceKind = 'local';
function selectWsKind(kind) {
  wsChoiceKind = kind;
  $('ch-local').classList.toggle('sel', kind === 'local');
  $('ch-repo').classList.toggle('sel', kind === 'repo');
  const pr = $('ws-pick-row'); if (pr) pr.style.display = (kind === 'local') ? '' : 'none';   // custom folder is local-only
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
  if (!name) { busy.textContent = 'enter a name first'; busy.classList.add('err'); return; }
  const pick = wsChoiceKind === 'local' && $('ws-pick') && $('ws-pick').checked;   // custom folder (local only)
  busy.textContent = pick ? 'choose a folder…' : (wsChoiceKind === 'repo' ? 'creating private repo on GitHub…' : 'creating folder…');
  $('ws-create').disabled = true;
  let r = null; try { r = await claudible.workspaceCreate(wsChoiceKind, name, pick); } catch {}
  $('ws-create').disabled = false;
  if (!r || !r.ok) { busy.textContent = (r && r.error) || 'creation failed'; busy.classList.add('err'); return; }
  const wasFirstRun = firstRunActive; firstRunActive = false;
  if (r.note) { try { toast(r.note); } catch {} }   // honest partial-success (e.g. repo created but the discovery marker push failed)
  closeWsModal();                                   // main already switched the foreground tab + respawned a fresh conversation
  { const t = AT(); if (t) { t.wsId = (r.workspace && r.workspace.id) || activeWsId; t.session = 'new'; t.label = 'New session'; t.curSessionLabel = 'New session'; t.term.reset(); resetStats(t); } }
  activeSession = null;
  await refreshWorkspaces();
  // first-run: the workspace they just made replaces the auto-created "Local" placeholder — remove it now that
  // another local exists (the >=1-local invariant still holds). A repo creation keeps the placeholder (still the only local).
  if (wasFirstRun && workspaces.some((w) => w.id === 'local-local') && workspaces.filter((w) => w.kind === 'local').length >= 2) {
    try { await claudible.workspaceDelete('local-local'); await refreshWorkspaces(); } catch (e) {}
  }
  refreshSessions(); renderTabStrip();
  setTimeout(() => { if (term) term.focus(); }, 150);
}
$('ws-add').addEventListener('click', openWsModal);
$('ch-local').addEventListener('click', () => selectWsKind('local'));
$('ch-repo').addEventListener('click', () => selectWsKind('repo'));
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
// live sync state from main → repaint the cloud button; refresh the switcher when sessions changed
claudible.onSyncState((s) => {
  if (!s || !s.id) return;
  const u = { status: s.status };                 // merge so a 'syncing' tick doesn't wipe the last counts
  if (s.synced != null) u.synced = s.synced;
  if (s.diverged != null) u.diverged = s.diverged;
  wsSyncState[s.id] = Object.assign({}, wsSyncState[s.id], u);
  renderWsChips();
});
claudible.onSyncChanged((s) => { if (s && s.id === activeWsId) refreshSessions(); });
claudible.onWorkspaceAdded(() => { refreshWorkspaces(); });
$('invite-name-in').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); doInvite(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeInviteModal(); }
});
// A guest switched the live workspace (they clicked a granted chip) → reflect it in the host UI.
claudible.onWorkspaceActiveChanged((id) => {
  if (id === activeWsId) return;
  const t = AT();
  activeWsId = id; activeSession = null; lastTitlePoll = 0; titlesSig = '';
  if (t) { t.wsId = id; t.session = ''; t.label = ''; t.curSessionLabel = ''; t.term.reset(); resetStats(t); }   // main re-pointed the foreground tab
  refreshWorkspaces(); refreshSessions(); renderTabStrip();
});

$('sessions-btn').addEventListener('click', () => openSidebar(!bodyEl.classList.contains('with-sessions')));
$('sidebar-close').addEventListener('click', () => openSidebar(false));
$('new-session').addEventListener('click', async () => {                            // a NEW tab — never clears the current session
  const name = await modalPrompt({ title: 'Name this session', body: 'Give it a clear name so it’s easy to find later — you can rename it anytime.', placeholder: 'e.g. auth refactor, bug #214…', ok: 'Create session' });
  if (name === null) return;                                                         // Cancel / Esc → don't create
  newBlankTab(activeWsId, 'new', name || '');                                        // empty (just hit Create) → unnamed, like before
});
// One-time migration: conversation order moved from the flat `sessionOrder` key to per-workspace
// `wsOrder_<id>`; carry the legacy arrangement over so it isn't lost on first launch after upgrade.
{ const _p = loadPrefs(); if (_p.sessionOrder && !_p.wsOrder_legacy) savePrefs({ wsOrder_legacy: _p.sessionOrder }); }
// Seed + activate the first tab ('main' — matches main.js's spawn fallback id) NOW that every const/helper
// it touches is defined. sidebarReady is still false here, so setActiveTab skips the sidebar refresh; the
// async loader below does workspaces + sessions once. (term/fit resolve; the foreground pty starts fitted.)
makeTab('main', null, '');
setActiveTab('main');
sidebarReady = true;   // the sessions/workspace section is now fully initialized — tab switches may refresh the sidebar
(async () => { await refreshWorkspaces(); refreshSessions(); renderTabStrip(); })();   // load workspaces first, then this workspace's conversations

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
    try { const wl = await claudible.workspaceList(); hasWs = !!(wl && (wl.workspaces || []).some((w) => w && w.kind && w.kind !== 'legacy')); } catch {}
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
    btn.disabled = true; b.classList.remove('err'); b.textContent = 'Creating workspace…';
    let r; try { r = await claudible.workspaceCreate('local', name, false); } catch (e) { r = { ok: false, error: e && e.message }; }
    btn.disabled = false;
    if (r && !r.ok && /already exists/i.test(r.error || '')) { b.textContent = ''; goGh(); return; }   // a prior run made it → just continue (no dead-end)
    if (!r || !r.ok) { b.classList.add('err'); b.textContent = (r && r.error) || 'Could not create the workspace.'; return; }
    b.textContent = '';
    // mirror createWorkspace()'s post-create reconcile so the foreground tab points at the NEW ws (else its
    // session list / live tracking key off the old ws — a sidebar desync immediately after onboarding).
    { const t = AT(); if (t) { t.wsId = (r.workspace && r.workspace.id) || activeWsId; t.session = 'new'; t.label = 'New session'; t.curSessionLabel = 'New session'; try { t.term.reset(); } catch {} resetStats(t); } }
    activeSession = null;
    try { await refreshWorkspaces(); } catch {}
    try { refreshSessions(); renderTabStrip(); } catch {}
    goGh();
  }

  async function goGh() { show(4); const s = await status(); if (s) applyGh(s); }
  function applyGh(s) {
    const msg = $('wiz-gh-msg'), rc = $('wiz-gh-recheck');
    if (s.ghSignedIn) { msg.textContent = '✓ GitHub connected' + (s.ghAccount ? ' (@' + s.ghAccount + ')' : ''); rc.style.display = 'none'; }
    else { msg.textContent = 'GitHub isn’t connected yet — connect it to sync your workspaces across devices and invite people. In a terminal run:  gh auth login  (choose “Login with a web browser”), approve it, then click Re-check.'; rc.style.display = ''; }
  }

  // ---- System check (step 1): detect every dependency, install the missing ones --------------------
  // Rows come from preflight:status (deps.detect). Required infra (node/git) must be present to advance;
  // claude need only be INSTALLED here — its sign-in is the dedicated next step. Optional deps never block.
  // Skip/Escape still dismiss at any time (the wizard invariant), so a failed/unavailable install never traps.
  let depRows = [], restartNeeded = false;
  const SYS_PILL = { ready: 'ready', missing: 'missing', outdated: 'update', installing: 'installing…', signin: 'sign in', unconfirmed: 'check', error: 'failed' };
  const sysInstallable = (d) => d.installable && (d.state === 'missing' || d.state === 'outdated' || d.state === 'error');
  const sysBlocking = (d) => d.required && !(d.state === 'ready' || (d.id === 'claude' && (d.state === 'unconfirmed' || d.state === 'signin')));
  function sysBusy(msg, err) { const b = $('wiz-sys-busy'); if (!b) return; b.classList.toggle('err', !!err); b.textContent = msg || ''; }
  function setSysPill(id, cls, text) { const r = document.querySelector('#wiz-dep-list .dep-row[data-dep="' + id + '"]'); if (!r) return; const p = r.querySelector('.dep-pill'); if (p) { p.className = 'dep-pill ' + cls; p.textContent = text; } }
  function disableSysActs(on) { document.querySelectorAll('#wiz-dep-list .dep-act').forEach((b) => { b.disabled = on; }); const i = $('wiz-sys-install'); if (i) i.disabled = on; }
  async function refreshSystem() {
    const list = $('wiz-dep-list'); if (!list) return;
    let r; try { r = await claudible.preflightStatus(); } catch { r = null; }
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
      if (sysBlocking(d)) blocking++;
      const row = document.createElement('div'); row.className = 'dep-row'; row.dataset.dep = d.id;
      const main = document.createElement('div'); main.className = 'dep-main';
      const name = document.createElement('div'); name.className = 'dep-name'; name.textContent = d.label;
      if (!d.required) { const o = document.createElement('span'); o.className = 'wiz-opt'; o.textContent = 'optional'; name.appendChild(document.createTextNode(' ')); name.appendChild(o); }
      const detail = (d.id === 'gh' && d.state === 'ready' && d.account) ? ('@' + d.account) : d.version;
      if (detail) { const v = document.createElement('span'); v.className = 'wiz-dim'; v.style.marginLeft = '6px'; v.textContent = detail; name.appendChild(v); }
      const hint = document.createElement('div'); hint.className = 'dep-hint'; hint.textContent = d.hint || '';
      main.appendChild(name); main.appendChild(hint);
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
    setSysPill(id, 'installing', 'installing…'); disableSysActs(true); sysBusy('');
    let r; try { r = await claudible.preflightInstall(id); } catch (e) { r = { ok: false, error: e && e.message }; }
    disableSysActs(false);
    if (r && r.restartRequired) { restartNeeded = true; setSysPill(id, 'ready', 'installed'); sysBusy('Installed. Claudible needs a quick restart to finish.'); const n = $('wiz-sys-next'); n.disabled = false; n.textContent = 'Restart now'; return; }
    if (!r || !r.ok) { setSysPill(id, 'error', 'failed'); sysBusy((r && r.error) || 'Install failed — retry, or Skip for now.', true); return; }
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
    if (step === 1 && m.msg) sysBusy(m.msg, m.phase === 'error');
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
    else { busy.classList.add('err'); busy.textContent = 'Install failed: ' + ((r && r.error) || 'unknown') + ' — retry, or install it manually.'; }
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
