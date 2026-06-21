// Claudible — shared-session guest viewer logic.
// Loaded as an EXTERNAL script (not inline) so the page's strict CSP (script-src 'self') still applies.
'use strict';
var $ = function (id) { return document.getElementById(id); };
var token = new URLSearchParams(location.search).get('t') || '';
var STORE_KEY = 'claudible_resume';
// If THIS tab already claimed THIS link before (a refresh), reuse its private resume token so we
// reconnect without re-prompting the host. A different/new link ignores a stale stored token.
var resume = null;
try { var s = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null'); if (s && s.t === token && s.r) resume = s.r; } catch (e) {}

// Tag <body class="mobile"> for PHONE-width screens only (matches the CSS @media breakpoint). Tablets,
// desktops and wide views are "non-mobile": side-by-side layout + scale-to-fill (see recomputeFit).
function vpWidth() { return (window.visualViewport && window.visualViewport.width) || window.innerWidth || 390; }
function flagMobile() {
  document.body.classList.toggle('mobile', vpWidth() <= 760);
  scheduleFit();                                  // re-fit when crossing a breakpoint (rotate, resize)
}
flagMobile();
window.addEventListener('resize', flagMobile);
window.addEventListener('orientationchange', flagMobile);

// Pin the layout to the LIVE visible viewport. Mobile browsers grow/shrink the visible area as the URL bar
// shows/hides; CSS svh/dvh help but lag or mis-report in some in-app webviews, leaving an empty gap under the
// chat or a scrollable page. Writing the measured height into --app-h (read by body{height:var(--app-h)}) keeps
// the app exactly the size of what's on screen — no gap, no page scroll.
function setAppHeight() {
  var h = (window.visualViewport && window.visualViewport.height) || window.innerHeight || 0;
  if (h) document.documentElement.style.setProperty('--app-h', Math.round(h) + 'px');
}
setAppHeight();
window.addEventListener('resize', setAppHeight);
window.addEventListener('orientationchange', function () { setTimeout(setAppHeight, 250); });
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', setAppHeight);
  window.visualViewport.addEventListener('scroll', setAppHeight);
}

var term = new Terminal({
  fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace',
  fontSize: 13, lineHeight: 1.15, cursorBlink: true, scrollback: 5000,
  theme: { background: '#0a0b0d', foreground: '#d8dde3', cursor: '#c6ced8',
           selectionBackground: '#23272e', black: '#070809', brightBlack: '#525861' },
});
term.open($('terminal'));

// custom scroll gutter (ported from the cockpit) — drives the terminal's scrollback so no native
// scrollbar sits over the text. Desktop/tablet only (CSS hides it on phones, where touch scrolls).
(function gutter() {
  var sc = $('gutter'), thumb = $('gthumb'); if (!sc || !thumb) return;
  function upd() {
    var b = term.buffer.active, rows = term.rows, baseY = b.baseY, total = b.length, trackH = sc.clientHeight;
    if (baseY <= 0 || total <= rows || trackH <= 0) { thumb.style.opacity = '0'; return; }
    var thumbH = Math.max(26, trackH * (rows / total));
    thumb.style.opacity = '1'; thumb.style.height = thumbH + 'px';
    thumb.style.transform = 'translateY(' + ((trackH - thumbH) * (b.viewportY / baseY)) + 'px)';
  }
  term.onScroll(upd); setInterval(upd, 150);
  var dragging = false, grabDY = 0;
  function thumbTop() { return thumb.getBoundingClientRect().top - sc.getBoundingClientRect().top; }
  function toFrac(f) { term.scrollToLine(Math.round(Math.max(0, Math.min(1, f)) * term.buffer.active.baseY)); }
  thumb.addEventListener('pointerdown', function (e) {
    dragging = true; grabDY = e.clientY - thumbTop(); thumb.classList.add('drag');
    try { thumb.setPointerCapture(e.pointerId); } catch (x) {} e.preventDefault(); e.stopPropagation();
  });
  window.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    var th = sc.clientHeight, hh = thumb.offsetHeight;
    var top = Math.max(0, Math.min(th - hh, e.clientY - sc.getBoundingClientRect().top - grabDY));
    toFrac((th - hh) > 0 ? top / (th - hh) : 0);
  });
  window.addEventListener('pointerup', function () { if (dragging) { dragging = false; thumb.classList.remove('drag'); } });
  sc.addEventListener('pointerdown', function (e) { if (e.target === thumb) return; toFrac((e.clientY - sc.getBoundingClientRect().top) / sc.clientHeight); });
})();

var readOnly = false, ws = null, retry = 0, denied = false, myName = 'Guest', hostName = 'host';
var grantedWs = [], wsPaused = false, lastLiveId = null;   // granted workspace library + private-pause state
var myPid = null;                                          // our voice-room peer id (from the hello)
// The connection indicator now lives on the top session chip's dot (green = live, red = down, amber = connecting).
function setStatus(txt, cls) {
  var s = $('stxt'); if (s) s.textContent = txt;
  var d = $('sess-dot'); if (d) d.className = 'dot' + (cls ? ' ' + cls : '');
}
function showOverlay(show, title, body, bad) {
  $('overlay').classList.toggle('show', !!show);
  if (title != null) $('ov-title').textContent = title;
  if (body != null) $('ov-body').textContent = body;
  $('card').classList.toggle('bad', !!bad);
}
function applySize(c, r) { if (c) hostCols = c; if (r) hostRows = r; try { term.resize(c, r); } catch (e) {} scheduleFit(); }

// ---- presence: tell the host we're active (green) or idle/AFK (amber); a disconnect shows red on the host. ----
var presence = null, idleTimer = null;
function sendPresence(st, force) {
  if (!force && st === presence) return;
  presence = st;
  if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify({ type: 'presence', state: st })); } catch (e) {} }
}
function markActive() {
  if (document.hidden) return;
  clearTimeout(idleTimer);
  sendPresence('active');
  idleTimer = setTimeout(function () { sendPresence('idle'); }, 60000);   // 60s of no activity while visible → AFK
}
document.addEventListener('visibilitychange', function () { sendPresence(document.hidden ? 'idle' : 'active'); if (!document.hidden) markActive(); });
['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove'].forEach(function (ev) { window.addEventListener(ev, markActive, { passive: true }); });
markActive();

// ---- size the mirrored terminal to the viewport ----
// The host runs a fixed grid (hostCols x hostRows). PHONES: default to readable text that scrolls inside the
// screen-capped pane (Fit pill shrinks all columns instead). TABLET / DESKTOP / WIDE: scale the WHOLE grid to
// FILL the pane — so you see everything the host sees, as large as the screen allows, adapting to any size.
// Font is computed from geometry (monospace advance ≈ 0.6 × fontSize, cell height ≈ 1.18 × fontSize), never
// by reflowing columns.
var BASE_FONT = 13;                                // matches Terminal({fontSize}) above
// PHONE sizing: the host paints a FIXED hostCols×hostRows grid, so at a fixed font the terminal can't "use" extra
// vertical space — it just leaves a gap. The only honest lever is the FONT. Baseline = the size at which all the
// host's ROWS exactly fill the available height, so the terminal always fills the pane AND grows into the space
// freed when the chat collapses (shrinks back when it reopens). The −/＋ and pinch apply a remembered MULTIPLIER
// on top of that baseline, so a viewer's size preference scales with the pane instead of leaving dead space.
// Whatever doesn't fit the width is reached by horizontal pan (CSS #terminal{width:max-content} + .wrap overflow).
var ZOOM_KEY = 'claudible_zoom';                   // persisted zoom multiplier (relative to the height-fit baseline)
var FONT_MIN = 7, FONT_MAX = 40;
var ZF_MIN = 0.4, ZF_MAX = 4;
var zoomFactor = 1;
try { var zf = parseFloat(localStorage.getItem(ZOOM_KEY)); if (zf >= ZF_MIN && zf <= ZF_MAX) zoomFactor = zf; } catch (e) {}
var lastEffFont = BASE_FONT;                       // last applied effective font (anchors the −/＋ steppers)
var hostCols = 120, hostRows = 32;                 // host's reported grid (set in applySize)
function isMobile() { return document.body.classList.contains('mobile'); }
function paneHeight() {
  var t = $('terminal'), wrap = t && t.closest('.wrap'); if (!wrap) return 0;
  var cs = getComputedStyle(wrap);
  return wrap.clientHeight - parseFloat(cs.paddingTop || 0) - parseFloat(cs.paddingBottom || 0);
}
function fitHeightFont() {                          // size at which hostRows rows fill the pane height
  var ph = paneHeight(); if (ph <= 0) return BASE_FONT;
  return Math.max(FONT_MIN, Math.min(FONT_MAX, ph / (Math.max(1, hostRows) * 1.18)));
}
function applyMobileZoom() {
  var eff = Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(fitHeightFont() * zoomFactor)));
  lastEffFont = eff;
  if (term.options.fontSize !== eff) term.options.fontSize = eff;
  var lbl = $('zoom-lbl'); if (lbl) lbl.textContent = eff + 'px';
}
function setZoomFactor(f) {
  zoomFactor = Math.max(ZF_MIN, Math.min(ZF_MAX, f));
  try { localStorage.setItem(ZOOM_KEY, String(zoomFactor)); } catch (e) {}
  applyMobileZoom();
}
function nudgeZoom(deltaPx) {                        // step the EFFECTIVE size by ~deltaPx, stored pane-relative
  var base = fitHeightFont(); if (base > 0) setZoomFactor((lastEffFont + deltaPx) / base);
}
function recomputeFit() {
  var t = $('terminal'); if (!t) return;
  var wrap = t.closest('.wrap'); if (!wrap) return;
  var cur = term.options.fontSize || BASE_FONT;
  var phone = isMobile();
  document.body.classList.toggle('can-fit', phone);           // the zoom control is a phone-only affordance
  if (phone) { applyMobileZoom(); return; }                   // fill the height; collapsing the chat grows it
  // tablet / desktop / wide: scale the whole grid to fill the pane (see everything, as large as it fits).
  var cs = getComputedStyle(wrap), tcs = getComputedStyle(t);
  var pw = wrap.clientWidth
    - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0)
    - parseFloat(tcs.paddingLeft || 0) - parseFloat(tcs.paddingRight || 0)
    - parseFloat(tcs.borderLeftWidth || 0) - parseFloat(tcs.borderRightWidth || 0) - 2;
  var ph = wrap.clientHeight
    - parseFloat(cs.paddingTop || 0) - parseFloat(cs.paddingBottom || 0)
    - parseFloat(tcs.paddingTop || 0) - parseFloat(tcs.paddingBottom || 0)
    - parseFloat(tcs.borderTopWidth || 0) - parseFloat(tcs.borderBottomWidth || 0) - 2;
  if (pw <= 0 || ph <= 0) return;
  var wFont = pw / (Math.max(1, hostCols) * 0.6);            // largest size whose columns fit the width
  var hFont = ph / (Math.max(1, hostRows) * 1.18);          // …and whose rows fit the height
  var target = Math.max(5, Math.min(40, Math.floor(Math.min(wFont, hFont))));   // contain → see everything, biggest that fits
  if (target !== cur) term.options.fontSize = target;
}
// xterm renders on rAF → reading size synchronously right after term.resize() is stale. Measure on double-rAF.
function scheduleFit() { requestAnimationFrame(function () { requestAnimationFrame(recomputeFit); }); }
window.addEventListener('orientationchange', function () { setTimeout(recomputeFit, 250); }); // dims settle after rotate
if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleFit);            // monospace FOUT → wrong char width
if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleFit);      // reliable in in-app webviews
scheduleFit();                                                                                 // first attempt at boot

// read-only viewers can't type — neutralize xterm's hidden helper textarea so a tap can't raise the keyboard
function applyReadOnlyInput() {
  if (!readOnly) return;                            // NEVER touch interactive viewers (would kill their keyboard)
  var ta = $('terminal').querySelector('.xterm-helper-textarea');
  if (!ta) return;
  ta.setAttribute('readonly', 'readonly');
  ta.setAttribute('inputmode', 'none');             // Android/iOS: a tap won't surface the soft keyboard
  ta.setAttribute('aria-hidden', 'true');
  ta.tabIndex = -1;
}

// Terminal text-size control (phones) — lives on the chat bar. −/＋ steps the size; pinch on the terminal works too.
// CSP-safe (wired here, no inline handlers). The whole control stops click propagation so tapping it never toggles
// the chat collapse (the chat bar itself is the collapse handle).
(function zoomCtl() {
  var ctl = $('zoomctl'), out = $('zoom-out'), inn = $('zoom-in');
  if (ctl) ctl.addEventListener('click', function (e) { e.stopPropagation(); });
  if (out) out.addEventListener('click', function () { nudgeZoom(-1); });
  if (inn) inn.addEventListener('click', function () { nudgeZoom(1); });
  var t = $('terminal'); if (!t) return;
  // pinch: scale the multiplier by the change in two-finger spread (native page-zoom is disabled in the viewport meta)
  var startDist = 0, startFactor = 1;
  function dist(e) { var a = e.touches[0], b = e.touches[1], dx = a.clientX - b.clientX, dy = a.clientY - b.clientY; return Math.sqrt(dx * dx + dy * dy); }
  t.addEventListener('touchstart', function (e) {
    if (e.touches.length === 2) { startDist = dist(e); startFactor = zoomFactor; }
  }, { passive: true });
  t.addEventListener('touchmove', function (e) {
    if (e.touches.length !== 2 || !startDist) return;
    e.preventDefault();                                       // we own the pinch; don't let the page do anything
    setZoomFactor(startFactor * (dist(e) / startDist));
  }, { passive: false });
  t.addEventListener('touchend', function (e) { if (e.touches.length < 2) startDist = 0; }, { passive: true });
})();
// Mirror the host's session tracker (context %, cost, tokens) — values arrive pre-formatted.
function applyStatus(s) {
  if (!s) return;
  if (typeof s.ctxPct === 'number') {
    $('ctxpct').textContent = s.ctxPct + '%';
    $('ctxfill').style.width = Math.max(2, Math.min(100, s.ctxPct)) + '%';
    var bar = $('ctxbar');
    bar.classList.toggle('warn', s.ctxPct >= 70 && s.ctxPct < 85);
    bar.classList.toggle('crit', s.ctxPct >= 85);
  }
  if (s.cost != null) $('trk-cost').textContent = s.cost;
  if (s.tokens != null) $('trk-tokens').textContent = s.tokens;
  if (s.session != null) {
    var chip = $('sess-chip');
    $('sess-chip-text').textContent = s.session || 'live session';   // keep the chip visible (it carries the connection dot)
    if (chip) chip.style.display = '';
  }
}

// ---- granted workspace library: the host shares a SUBSET of their Claudible. You watch the live one,
// and (when interactive) can click another granted workspace to switch the shared terminal to it. ----
function renderGuestWs() {
  var bar = $('wsbar'), box = $('wschips'); if (!bar || !box) return;
  box.innerHTML = '';
  if (!grantedWs.length) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  var liveId = null;
  grantedWs.forEach(function (w) {
    if (w.live) liveId = w.id;
    var c = document.createElement('div');
    c.className = 'wschip' + (w.live ? ' live' : '');
    c.title = w.label + (w.kind && w.kind !== 'legacy' ? ' (' + w.kind + ')' : '');
    var n = document.createElement('span'); n.textContent = w.label; c.appendChild(n);
    if (w.kind && w.kind !== 'legacy') { var k = document.createElement('span'); k.className = 'wsk'; k.textContent = w.kind; c.appendChild(k); }
    if (!readOnly) c.addEventListener('click', function () { switchWorkspaceReq(w.id, w.live); });
    box.appendChild(c);
  });
  if (liveId && liveId !== lastLiveId) { lastLiveId = liveId; try { term.reset(); } catch (e) {} }   // clean swap on switch
}
function switchWorkspaceReq(id, live) {
  if (readOnly || live) return;                                // can't switch when view-only or already there
  if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify({ type: 'switch', id: id })); } catch (e) {} }
}
function applyPaused(label) {
  var ov = $('paused-ov'); if (ov) ov.classList.toggle('show', !!wsPaused);
  var b = $('paused-body');
  if (b) b.textContent = (wsPaused && label)
    ? 'The host is working in "' + label + '" (not shared). The mirror resumes when they switch back to a shared workspace.'
    : 'The mirror resumes when they switch back to a shared workspace.';
}

// ---- read-only session browser: click through SHARED workspaces → their saved sessions → a transcript,
// entirely independent of the live mirror. It NEVER sends 'switch' and NEVER changes the host's terminal. ----
var browseView = 'ws', browseWsId = null, browseWsLabel = '', browseSessionId = null, lastSessions = [];
function browseSend(obj) { if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify(obj)); } catch (e) {} } }
function relTime(sec) {
  if (!sec) return '';
  var m = Math.floor(Date.now() / 1000 - sec) / 60;
  if (m < 1) return 'just now';
  if (m < 60) return Math.floor(m) + 'm ago';
  var h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}
function setBrowseHead() {
  var back = $('browse-back'), title = $('browse-title');
  if (browseView === 'ws') { title.textContent = 'Browse sessions'; back.style.display = 'none'; }
  else { back.style.display = ''; if (browseView === 'sessions') title.textContent = browseWsLabel || 'Sessions'; }
}
function browseNote(cls, text) { var b = $('browse-body'); b.innerHTML = ''; var d = document.createElement('div'); d.className = cls; d.textContent = text; b.appendChild(d); }
function openBrowse() { browseView = 'ws'; $('browse').classList.add('show'); renderBrowseWs(); }
function closeBrowse() { $('browse').classList.remove('show'); }
function browseBack() {
  if (browseView === 'transcript') { browseView = 'sessions'; setBrowseHead(); renderBrowseSessions(lastSessions); }
  else if (browseView === 'sessions') { browseView = 'ws'; renderBrowseWs(); }
  else closeBrowse();
}
function browItem(title, meta, onClick) {
  var it = document.createElement('button'); it.className = 'brow-item';
  var t = document.createElement('div'); t.className = 'bt'; t.textContent = title;
  var m = document.createElement('div'); m.className = 'bm'; m.textContent = meta;
  it.appendChild(t); it.appendChild(m); it.addEventListener('click', onClick);
  return it;
}
function renderBrowseWs() {
  setBrowseHead();
  var b = $('browse-body'); b.innerHTML = '';
  if (!grantedWs.length) { browseNote('brow-empty', 'No shared workspaces to browse.'); return; }
  grantedWs.forEach(function (w) {
    b.appendChild(browItem(w.label, (w.kind && w.kind !== 'legacy' ? w.kind : 'workspace') + (w.live ? ' · live now' : ''),
      function () { openBrowseSessions(w); }));
  });
}
function openBrowseSessions(w) {
  browseView = 'sessions'; browseWsId = w.id; browseWsLabel = w.label; lastSessions = [];
  setBrowseHead(); browseNote('brow-note', 'Loading sessions…');
  browseSend({ type: 'ws-sessions', id: w.id });
}
function renderBrowseSessions(list) {
  var b = $('browse-body'); b.innerHTML = '';
  if (!list.length) { browseNote('brow-empty', 'No saved sessions in this workspace yet.'); return; }
  list.forEach(function (s) {
    b.appendChild(browItem(s.preview || '(empty session)',
      relTime(s.mtime) + (s.msgs ? (' · ' + s.msgs + ' msg' + (s.msgs === 1 ? '' : 's')) : ''),
      function () { openBrowseTranscript(s); }));
  });
}
function openBrowseTranscript(s) {
  browseView = 'transcript'; browseSessionId = s.id;
  $('browse-back').style.display = '';
  var pv = s.preview || 'Transcript';
  $('browse-title').textContent = pv.length > 48 ? pv.slice(0, 48) + '…' : pv;
  browseNote('brow-note', 'Loading transcript…');
  browseSend({ type: 'ws-transcript', id: browseWsId, sid: s.id });
}
function renderTranscript(msgs) {
  var b = $('browse-body'); b.innerHTML = '';
  if (!msgs.length) { browseNote('brow-empty', 'This conversation has no readable messages.'); return; }
  msgs.forEach(function (mm) {
    var d = document.createElement('div'); d.className = 'brow-msg ' + (mm.role === 'you' ? 'you' : 'claude');
    var who = document.createElement('span'); who.className = 'bw'; who.textContent = (mm.role === 'you' ? (hostName || 'host') : 'claude');
    var body = document.createElement('div'); body.textContent = mm.text || '';   // textContent → no HTML injection from transcript text
    d.appendChild(who); d.appendChild(body); b.appendChild(d);
  });
  b.scrollTop = 0;
}
$('browse-open').addEventListener('click', openBrowse);
$('browse-x').addEventListener('click', closeBrowse);
$('browse-back').addEventListener('click', browseBack);

// ---- voice room: peer-to-peer audio with the host & other viewers (signaling relayed over our WS) ----
// floating per-person VOLUME control — right-click (or long-press on touch) a voice member to set how loud YOU
// hear them (0–200%). Local to this viewer; never changes what anyone else hears. Survives a rejoin.
var volPop = null;
function closeVolumePopover() {
  if (!volPop) return;
  if (volPop.parentNode) volPop.parentNode.removeChild(volPop);
  volPop = null;
  document.removeEventListener('mousedown', onVolOutside, true);
  document.removeEventListener('touchstart', onVolOutside, true);
  document.removeEventListener('keydown', onVolKey, true);
}
function onVolOutside(e) { if (volPop && !volPop.contains(e.target)) closeVolumePopover(); }
function onVolKey(e) { if (e.key === 'Escape') closeVolumePopover(); }
function openVolumePopover(anchor, id, name, room) {
  closeVolumePopover();
  var cur = Math.round((room.getVolume ? room.getVolume(id) : 1) * 100);
  var pop = document.createElement('div');
  pop.style.cssText = 'position:fixed;z-index:9999;display:flex;flex-direction:column;gap:8px;min-width:200px;padding:12px 14px;border:1px solid #2b2f37;border-radius:12px;background:linear-gradient(180deg,#14171c,#0e1013);box-shadow:0 16px 44px rgba(0,0,0,.6);font-family:inherit;color:#e7eaef';
  var head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;font-size:11px;color:#9097a1;gap:10px';
  var hn = document.createElement('span'); hn.textContent = '🔊 ' + name;
  hn.style.cssText = 'font-weight:600;color:#cfd6df;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  var pct = document.createElement('span'); pct.textContent = cur + '%'; pct.style.cssText = 'font-variant-numeric:tabular-nums';
  head.appendChild(hn); head.appendChild(pct);
  var slider = document.createElement('input');
  slider.type = 'range'; slider.min = '0'; slider.max = '200'; slider.step = '5'; slider.value = String(cur);
  slider.style.cssText = 'width:100%;accent-color:#5fb487;cursor:pointer;height:24px';
  function apply(v) { pct.textContent = v + '%'; try { room.setVolume(id, v / 100); } catch (e) {} }
  slider.addEventListener('input', function () { apply(+slider.value); });
  var rowx = document.createElement('div'); rowx.style.cssText = 'display:flex;gap:6px';
  function mk(txt, val) {
    var b = document.createElement('button'); b.type = 'button'; b.textContent = txt;
    b.style.cssText = 'flex:1;font:inherit;font-size:11px;color:#9097a1;background:#191c22;border:1px solid #2b2f37;border-radius:7px;padding:7px 0;cursor:pointer';
    b.addEventListener('click', function () { slider.value = String(val); apply(val); }); return b;
  }
  rowx.appendChild(mk('Mute', 0)); rowx.appendChild(mk('100%', 100)); rowx.appendChild(mk('Max', 200));
  pop.appendChild(head); pop.appendChild(slider); pop.appendChild(rowx);
  document.body.appendChild(pop);
  var r = anchor.getBoundingClientRect();
  var left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 8);
  var top = r.top - pop.offsetHeight - 8; if (top < 8) top = r.bottom + 8;
  pop.style.left = Math.max(8, left) + 'px'; pop.style.top = top + 'px';
  volPop = pop;
  setTimeout(function () {
    document.addEventListener('mousedown', onVolOutside, true);
    document.addEventListener('touchstart', onVolOutside, true);
    document.addEventListener('keydown', onVolKey, true);
  }, 0);
}
// long-press helper for touch devices (no right-click): fire after a steady ~480ms hold
function attachLongPress(el, cb) {
  var timer = null;
  function clear() { if (timer) { clearTimeout(timer); timer = null; } }
  el.addEventListener('touchstart', function () { clear(); timer = setTimeout(function () { timer = null; cb(); }, 480); }, { passive: true });
  el.addEventListener('touchend', clear);
  el.addEventListener('touchmove', clear);
  el.addEventListener('touchcancel', clear);
}
// "jump to bottom" — snap the terminal (and chat) to the latest, so a viewer who scrolled up doesn't have to
// drag all the way back down. Wired to the mobile floating button.
function jumpToBottom() {
  try { if (typeof term !== 'undefined' && term && term.scrollToBottom) term.scrollToBottom(); } catch (e) {}
  try { var w = document.querySelector('.wrap'); if (w) w.scrollTop = w.scrollHeight; } catch (e) {}
  try { var cl = $('chat-log'); if (cl) cl.scrollTop = cl.scrollHeight; } catch (e) {}
}
(function () { var jb = $('jumpbtn'); if (jb) jb.addEventListener('click', jumpToBottom); })();

function renderVoiceUi(st) {
  var btn = $('voice-btn'), mute = $('voice-mute'), box = $('voice-members');
  if (!btn) return;
  if (st && st.error === 'mic-denied') { btn.textContent = '🎙 Mic blocked'; btn.classList.remove('on'); return; }
  var joined = !!(st && st.joined);
  btn.textContent = joined ? '🎙 Leave voice' : '🎙 Join voice';
  btn.classList.toggle('on', joined);
  if (mute) { mute.style.display = joined ? '' : 'none'; mute.textContent = (st && st.muted) ? 'Unmute' : 'Mute'; mute.classList.toggle('muted', !!(st && st.muted)); }
  if (box) {
    box.innerHTML = '';
    ((st && st.members) || []).forEach(function (m) {
      var el = document.createElement('div');
      el.className = 'vm' + (m.speaking ? ' speaking' : '') + (m.self ? ' self' : '') + (m.conn ? ' c-' + m.conn : '');
      var dot = document.createElement('span'); dot.className = 'vmdot';
      var label = (m.id === 'host' ? (hostName || 'host') : m.name);
      if (!m.self && m.conn && m.conn !== 'connected') label += ' · ' + m.conn;   // surface connecting/failed for diagnosis
      var nm = document.createElement('span'); nm.textContent = label;
      if (m.self) { el.title = 'you'; }
      else {                                                            // right-click / long-press → set how loud you hear them
        var who = (m.id === 'host' ? (hostName || 'host') : m.name);
        el.title = 'Adjust ' + who + "'s volume";
        el.style.cursor = 'context-menu';
        (function (mid, mname) {
          el.addEventListener('contextmenu', function (ev) { ev.preventDefault(); openVolumePopover(el, mid, mname, voice); });
          attachLongPress(el, function () { openVolumePopover(el, mid, mname, voice); });
        })(m.id, who);
      }
      el.appendChild(dot); el.appendChild(nm); box.appendChild(el);
    });
  }
}
// `voice` is referenced by the message handlers, so it must ALWAYS be a valid object — even if the voice
// feature is unavailable. A no-op stub is the fallback; the whole setup is guarded so a missing/failed
// voice module can NEVER take down the terminal mirror (which is wired further down, after this).
var voice = { isJoined: function () { return false; }, join: function () { return Promise.resolve(); },
  leave: function () {}, toggleMute: function () {}, setMembers: function () {}, pushAudio: function () {} };
try {
  if (typeof makeVoiceRoom === 'function') {
    voice = makeVoiceRoom({
      myId: function () { return myPid; },
      sendAudio: function (b64, sr) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'audio', data: b64, sr: sr })); },
      setJoined: function (j) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: j ? 'voice-join' : 'voice-leave' })); },
      onUi: renderVoiceUi,
    });
    var _vb = $('voice-btn'), _vm = $('voice-mute');
    if (_vb) _vb.addEventListener('click', function () { if (voice.isJoined()) voice.leave(); else voice.join().catch(function () {}); });
    if (_vm) _vm.addEventListener('click', function () { voice.toggleMute(); });
  } else { var _vbar = $('voicebar'); if (_vbar) _vbar.style.display = 'none'; }
} catch (e) { try { var _vbar2 = $('voicebar'); if (_vbar2) _vbar2.style.display = 'none'; } catch (x) {} }

function connect() {
  var proto = location.protocol === 'https:' ? 'wss' : 'ws';
  var cred = (resume ? ('r=' + encodeURIComponent(resume)) : ('t=' + encodeURIComponent(token))) + '&n=' + encodeURIComponent(myName);
  ws = new WebSocket(proto + '://' + location.host + '/?' + cred);
  ws.binaryType = 'arraybuffer';
  var opened = false, gotHello = false;

  ws.onopen = function () { opened = true; retry = 0; if (!gotHello) setStatus('connecting…', 'work'); };
  ws.onmessage = function (ev) {
    if (typeof ev.data === 'string') {
      var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'hello') {
        gotHello = true;
        readOnly = !!msg.readOnly;
        myPid = msg.pid || null;                                // our voice-room peer id
        if (Array.isArray(msg.voice)) voice.setMembers(msg.voice);   // who's already in the voice room
        if (msg.host) hostName = msg.host;
        $('ro').style.display = readOnly ? '' : 'none';
        document.body.classList.toggle('ro', readOnly);
        applyReadOnlyInput();                                 // read-only: a tap won't raise the soft keyboard
        grantedWs = Array.isArray(msg.workspaces) ? msg.workspaces : [];
        wsPaused = !!msg.paused;
        renderGuestWs(); applyPaused();                       // show the granted library + freeze if host is private
        if (msg.resume) { resume = msg.resume; try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ t: token, r: resume })); } catch (e) {} }
        showOverlay(false);
        document.body.classList.add('connected');             // reveal the phone zoom control only once actually viewing
        var chip = $('sess-chip');                            // reveal the session chip — it carries the connection dot
        if (chip) { chip.style.display = ''; var ct = $('sess-chip-text'); if (ct && !ct.textContent) ct.textContent = 'live session'; }
        setStatus('connected', 'ok');
        sendPresence(document.hidden ? 'idle' : 'active', true);   // tell the host we're here (green) / AFK (amber)
        applySize(msg.cols, msg.rows);
        if (!isMobile() && !readOnly) term.focus();           // don't pop the on-screen keyboard on phones / read-only viewers
      } else if (msg.type === 'pending') {
        setStatus('waiting for approval', 'work');
        showOverlay(true, 'Waiting for the host to let you in…', 'The host needs to approve your connection. Keep this tab open.', false);
      } else if (msg.type === 'denied') {
        denied = true;
        var full = msg.reason === 'full';
        setStatus(full ? 'session full' : 'not approved', 'bad');
        showOverlay(true, full ? 'This session is full' : 'Connection not approved',
          full ? 'The host has reached the maximum number of viewers. Try again later.'
               : 'The host declined this connection. Ask them for a fresh link if this was a mistake.', true);
      } else if (msg.type === 'size') {
        applySize(msg.cols, msg.rows);
      } else if (msg.type === 'status') {
        applyStatus(msg.status);
      } else if (msg.type === 'chat') {
        if (msg.role === 'system') addSystemChat(msg.text);
        else addChat(msg.name || (msg.role === 'host' ? hostName : 'viewer'), msg.text, false);
      } else if (msg.type === 'workspaces') {
        grantedWs = Array.isArray(msg.list) ? msg.list : [];
        renderGuestWs();
      } else if (msg.type === 'paused') {
        wsPaused = !!msg.paused;
        applyPaused(msg.label);
      } else if (msg.type === 'ws-sessions') {
        if (browseView === 'sessions' && msg.wsId === browseWsId) { lastSessions = Array.isArray(msg.list) ? msg.list : []; renderBrowseSessions(lastSessions); }
      } else if (msg.type === 'ws-transcript') {
        if (browseView === 'transcript' && msg.wsId === browseWsId && msg.sessionId === browseSessionId) renderTranscript(Array.isArray(msg.msgs) ? msg.msgs : []);
      } else if (msg.type === 'voice-members') {
        voice.setMembers(msg.members || []);
      } else if (msg.type === 'audio') {
        voice.pushAudio(msg.from, msg.data, msg.sr);
      }
    } else {
      term.write(new Uint8Array(ev.data));   // raw terminal output
    }
  };
  ws.onclose = function () {
    if (denied) return;                                  // host rejected → do not hammer them with retries
    if (gotHello) { reconnect('reconnecting…'); return; }        // we were in; transient drop → resume
    if (!opened && !resume) {                            // upgrade refused on the LINK → it's used/invalid
      setStatus('link unavailable', 'bad');
      showOverlay(true, 'This link can’t be used', 'It may have already been used, expired, or the host stopped sharing. Ask for a new link.', true);
      return;
    }
    reconnect(opened ? 'reconnecting…' : 'host offline — retrying…');   // pending drop or resume refused
  };
  ws.onerror = function () { try { ws.close(); } catch (e) {} };
}
function reconnect(label) { setStatus(label, 'bad'); retry = Math.min(retry + 1, 6); setTimeout(connect, 400 * retry); }

term.onData(function (d) {
  if (readOnly || denied || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'input', data: d }));
});

// ---- chat with the host & other viewers (human↔human; never reaches Claude/terminal) ----
var chatLog = $('chat-log'), chatIn = $('chat-in');
function addChat(who, text, mine) {
  var empty = document.getElementById('chat-empty'); if (empty) empty.parentNode.removeChild(empty);
  var d = document.createElement('div');
  d.className = 'chat-msg ' + (mine ? 'me' : 'them');
  var w = document.createElement('span'); w.className = 'who'; w.textContent = who;
  var b = document.createElement('div'); b.textContent = text;   // textContent → no HTML injection
  d.appendChild(w); d.appendChild(b); chatLog.appendChild(d);
  chatLog.scrollTop = chatLog.scrollHeight;
  if (!mine) markUnread();                                       // light up if this arrived while the chat is hidden
}
function addSystemChat(text) {
  var empty = document.getElementById('chat-empty'); if (empty) empty.parentNode.removeChild(empty);
  var d = document.createElement('div'); d.className = 'chat-sys'; d.textContent = text;
  chatLog.appendChild(d); chatLog.scrollTop = chatLog.scrollHeight;
  markUnread();
}
function sendChat() {
  var text = (chatIn.value || '').trim(); if (!text) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  addChat(myName, text, true);
  ws.send(JSON.stringify({ type: 'chat', text: text }));
  chatIn.value = '';
}
$('chat-send').addEventListener('click', sendChat);
chatIn.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
chatLog.innerHTML = '<div class="chat-empty" id="chat-empty">Chat with the host here — Claude never sees these messages.</div>';

// ---- collapsible chat + unread light (tap the header to hide the log/input down to a slim bar) ----
var gchat = document.querySelector('.gchat'), gchatHead = $('gchat-head');
var chatCollapsed = false;
function setChatCollapsed(c) {
  chatCollapsed = !!c;
  if (gchat) gchat.classList.toggle('collapsed', chatCollapsed);
  document.body.classList.toggle('chat-collapsed', chatCollapsed);   // lets the zoom handle drop when chat is hidden
  var tg = $('gchat-toggle'); if (tg) tg.setAttribute('aria-expanded', String(!chatCollapsed));
  if (!chatCollapsed && gchat) gchat.classList.remove('has-unread');  // opening clears the unread light
  scheduleFit();                                                      // terminal pane grew/shrank → rescale (desktop)
}
function markUnread() { if (chatCollapsed && gchat) gchat.classList.add('has-unread'); }
if (gchatHead) gchatHead.addEventListener('click', function () { setChatCollapsed(!chatCollapsed); });

// ---- desktop shortcuts, scoped to where you're focused ----
// In the TERMINAL (code area): Ctrl/⌘+A selects ALL the terminal text, +C copies the selection,
// +V pastes into it (unless view-only). In the CHAT box: Ctrl/⌘+A selects only the chat text you typed,
// not the whole window. So select-all means different things depending on where your cursor is.
var isMac = /mac/i.test(navigator.platform || navigator.userAgent || '');
function copyText(t) {
  if (!t) return;
  try { navigator.clipboard.writeText(t); }
  catch (e) {
    try { var ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); } catch (e2) {}
  }
}
window.addEventListener('keydown', function (e) {
  var mod = isMac ? (e.metaKey && !e.ctrlKey && !e.altKey) : (e.ctrlKey && !e.metaKey && !e.altKey);
  var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  var inTerm = e.target && e.target.closest && e.target.closest('#terminal');
  var field = e.target && e.target.closest && e.target.closest('input, textarea');
  if (inTerm) {
    if (mod && k === 'a') { e.preventDefault(); e.stopPropagation(); term.selectAll(); return; }
    if (mod && k === 'c') { var sel = term.getSelection(); if (sel) { e.preventDefault(); e.stopPropagation(); copyText(sel); } return; }
    if (mod && k === 'v') {
      if (readOnly || !ws || ws.readyState !== WebSocket.OPEN) return;   // view-only can't type
      e.preventDefault(); e.stopPropagation();
      (navigator.clipboard && navigator.clipboard.readText ? navigator.clipboard.readText() : Promise.reject())
        .then(function (t) { if (t) ws.send(JSON.stringify({ type: 'input', data: '\x1b[200~' + t + '\x1b[201~' })); })
        .catch(function () {});
      return;
    }
    return;
  }
  if (field) {
    if (mod && k === 'a') { e.preventDefault(); field.select(); return; }   // ONLY the chat text, not the page
    if (mod && k === 'c') {
      var s = (field.value || '').substring(field.selectionStart || 0, field.selectionEnd || 0);
      if (s) { e.preventDefault(); copyText(s); }
      return;
    }
    // Ctrl/⌘+V in the chat box: the browser's native paste-into-input is correct, leave it.
  }
}, true);

// ---- name gate: ask the viewer for a display name before joining ----
var NAME_KEY = 'claudible_name';
function startJoin() {
  var v = ($('name-in').value || '').trim().slice(0, 40);
  myName = v || 'Guest';
  try { sessionStorage.setItem(NAME_KEY, myName); } catch (e) {}
  $('name-overlay').style.display = 'none';
  connect();
}
(function nameGate() {
  // A native Claudible join passes the chosen display name as ?n=… → skip the gate entirely and connect.
  var fromUrl = (new URLSearchParams(location.search).get('n') || '').trim().slice(0, 40);
  if (fromUrl) {
    myName = fromUrl;
    try { sessionStorage.setItem(NAME_KEY, myName); } catch (e) {}
    var ov = $('name-overlay'); if (ov) ov.style.display = 'none';
    connect();
    return;
  }
  var saved = '';
  try { saved = sessionStorage.getItem(NAME_KEY) || ''; } catch (e) {}
  $('name-in').value = saved;
  $('name-go').addEventListener('click', startJoin);
  $('name-in').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); startJoin(); } });
  setTimeout(function () { try { $('name-in').focus(); } catch (e) {} }, 40);
})();
