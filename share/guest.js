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
var resumeFails = 0;   // consecutive not-admitted closes while presenting a resume token (R14: 2 → fall back to the link)

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
// GUEST PASTE, step 1 of 2: make xterm NEVER handle the paste chord itself. Its stock keymap resolves
// Ctrl/⌘+V by PHYSICAL key into a raw 0x16 byte; relayed to the host's pty, the CLI there answers ^V by
// reading the clipboard of the machine it runs on — the HOST's clipboard, i.e. the wrong person's paste.
// Matching e.code (physical key) keeps this layout-independent: on a Cyrillic/Hebrew/Greek layout e.key
// isn't 'v' for the same chord (exactly how the old key-name-matching interceptor was bypassed). Returning
// false makes xterm skip the event WITHOUT preventDefault, so the browser's default accelerator fires the
// native 'paste' event below — which carries the GUEST's own clipboard in every browser, no permission
// prompt, no async clipboard API.
term.attachCustomKeyEventHandler(function (ev) {
  var isV = ev.code === 'KeyV' || (ev.key && String(ev.key).toLowerCase() === 'v');
  if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && isV) return false;
  return true;
});
// GUEST PASTE, step 2 of 2: the native paste event (chord, context menu, or touch menu) delivers THIS
// viewer's clipboard text with no permission gate. It rides its own typed frame — never the keystroke
// channel — so the host can wrap + sanitize it as one paste. Capture phase beats xterm's internal textarea
// paste handler; preventDefault/stopPropagation keep that handler from double-sending the text.
$('terminal').addEventListener('paste', function (e) {
  e.preventDefault(); e.stopPropagation();
  if (readOnly || denied) return;
  var t = '';
  try { t = e.clipboardData ? e.clipboardData.getData('text/plain') : ''; } catch (x) {}
  if (!t) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) { addSystemChat('Paste not sent — reconnecting to the host.'); return; }
  try { ws.send(JSON.stringify({ type: 'paste', data: t })); } catch (x) {}
}, true);
// SHARED SCROLL (deliberate, chosen over per-viewer isolation): the mirrored screen is ONE view — the TUI's
// scroll state lives in the host's pty, so anyone scrolling pages it for everyone, exactly like typing.
// Stock xterm wheel: in the TUI (alt buffer + mouse reports) it becomes scroll bytes that ride term.onData
// to the host; in a normal-buffer shell it moves THIS viewer's own local scrollback (emits nothing). A
// read-only viewer's scroll bytes are refused at the onData chokepoint below, same as their keystrokes.

// custom scroll gutter (ported from the cockpit) — drives the terminal's scrollback so no native
// scrollbar sits over the text. Desktop/tablet only (CSS hides it on phones, where touch scrolls).
// Claude Code (and any full-screen TUI) runs the ALTERNATE buffer, where xterm keeps no scrollback for the
// bar to map — but it scrolls its OWN view on PageUp/PageDown, so in alt mode the gutter instead drives the
// shared view with Page keys (over the same 'input' ws path as keystrokes) and keeps a position ESTIMATE
// (altFrac, 0=bottom..1=top) so the thumb moves as you page and rests at the bottom, where the newest output
// is. Ported from the cockpit's canPageShared/sendPage/jogPages + updateScrollbar alt-buffer branch
// (renderer/app.js ~lines 206-281). Normal-buffer shells keep the real xterm-scrollback behavior below.
(function gutter() {
  var sc = $('gutter'), thumb = $('gthumb'); if (!sc || !thumb) return;
  var ALT_PAGE = 0.14;      // estimate nudge per PageUp/PageDown (matches the cockpit)
  var altFrac = 0;          // 0=bottom .. 1=top — position ESTIMATE while in the alt (full-screen) buffer
  function isAlt() { return !!(term && term.buffer.active && term.buffer.active.type === 'alternate'); }
  // SHARED SCROLL: paging a live session co-drives the SAME view everyone's watching, exactly like typing
  // (commit b7d5f8d — no wheel-blocking guards here). The one viewer who genuinely can't drive it is a
  // READ-ONLY guest — their Page keys are refused at the same server chokepoint as their keystrokes, so the
  // gutter must stay honestly inert for them in alt mode: a moving thumb over refused pages is false feedback.
  function canPage() { return !readOnly; }
  function sendPage(dir) {   // PageUp (dir<0) / PageDown (dir>0) — rides the same input path as keystrokes
    if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify({ type: 'input', data: dir < 0 ? '\x1b[5~' : '\x1b[6~' })); } catch (e) {} }
  }
  function jogPages(dir) {   // wheel / gutter-click: fire pages + advance the estimate
    if (!dir || !canPage()) return;
    var n = Math.min(6, Math.abs(dir));
    for (var i = 0; i < n; i++) sendPage(dir < 0 ? -1 : 1);
    altFrac = Math.max(0, Math.min(1, altFrac + (dir < 0 ? 1 : -1) * ALT_PAGE * n));
    upd();
  }
  function upd() {
    if (isAlt() && !canPage()) { thumb.style.opacity = '0'; return; }   // read-only + full-screen: nothing honest for the thumb to show
    var trackH = sc.clientHeight; if (trackH <= 0) { thumb.style.opacity = '0'; return; }
    if (isAlt()) {              // full-screen app → draggable thumb pages the shared view, positioned from the estimate
      var thumbH = Math.max(40, trackH * 0.20);
      thumb.style.opacity = '1'; thumb.style.height = thumbH + 'px';
      if (!dragging) thumb.style.transform = 'translateY(' + ((trackH - thumbH) * (1 - altFrac)) + 'px)';
      return;
    }
    var b = term.buffer.active, rows = term.rows, baseY = b.baseY, total = b.length;
    if (baseY <= 0 || total <= rows) { thumb.style.opacity = '0'; return; }
    var thumbH = Math.max(26, trackH * (rows / total));
    thumb.style.opacity = '1'; thumb.style.height = thumbH + 'px';
    thumb.style.transform = 'translateY(' + ((trackH - thumbH) * (b.viewportY / baseY)) + 'px)';
  }
  term.onScroll(upd); setInterval(upd, 150);
  var dragging = false, grabDY = 0, jogLastY = 0;
  function thumbTop() { return thumb.getBoundingClientRect().top - sc.getBoundingClientRect().top; }
  function toFrac(f) { term.scrollToLine(Math.round(Math.max(0, Math.min(1, f)) * term.buffer.active.baseY)); }
  thumb.addEventListener('pointerdown', function (e) {
    dragging = true; grabDY = e.clientY - thumbTop(); jogLastY = e.clientY; thumb.classList.add('drag');
    try { thumb.setPointerCapture(e.pointerId); } catch (x) {} e.preventDefault(); e.stopPropagation();
  });
  window.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    var th = sc.clientHeight, hh = thumb.offsetHeight;
    var top = Math.max(0, Math.min(th - hh, e.clientY - sc.getBoundingClientRect().top - grabDY));
    if (isAlt()) {
      if (!canPage()) return;   // read-only: the page would be refused — don't move the thumb/estimate either (no false feedback)
      thumb.style.transform = 'translateY(' + top + 'px)';
      altFrac = (th - hh) > 0 ? 1 - (top / (th - hh)) : 0;
      var dy = e.clientY - jogLastY;
      if (Math.abs(dy) >= 24) { sendPage(dy < 0 ? -1 : 1); jogLastY = e.clientY; }
      return;
    }
    toFrac((th - hh) > 0 ? top / (th - hh) : 0);
  });
  window.addEventListener('pointerup', function () { if (dragging) { dragging = false; thumb.classList.remove('drag'); } });
  sc.addEventListener('pointerdown', function (e) {
    if (e.target === thumb) return;
    if (isAlt()) { var mid = sc.getBoundingClientRect().top + sc.clientHeight / 2; jogPages(e.clientY < mid ? -2 : 2); return; }
    toFrac((e.clientY - sc.getBoundingClientRect().top) / sc.clientHeight);
  });
  sc.addEventListener('wheel', function (e) { if (isAlt()) { jogPages(e.deltaY < 0 ? -1 : 1); e.preventDefault(); } }, { passive: false });
})();

var readOnly = false, ws = null, retry = 0, denied = false, myName = 'Guest', hostName = 'host';
var grantedWs = [], wsPaused = false, lastLiveId = null;   // granted workspace library + private-pause state
// end-state bookkeeping: `left` = the guest clicked Disconnect (a FINAL state — never auto-reconnect back in);
// `wasAdmitted` = we got past approval at least once (so a later dead socket is "the session ended", not "bad link");
// `reconnTries` = consecutive failed reconnects since we were last live, the signal that the host is gone for good.
var left = false, wasAdmitted = false, reconnTries = 0;
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
  var rj = $('ov-rejoin'); if (rj) rj.style.display = 'none';   // only the terminal end-states (showEnded) surface Rejoin
}
// show/hide the top session bar (holds the granted-project chips + the Disconnect button). Hidden before we're
// admitted and after we've left, so Disconnect is offered exactly when there's a live session to disconnect FROM.
function showBar(on) { var b = $('wsbar'); if (b) b.classList.toggle('hidden', !on); }
// The final, blurred end card — for the guest's own Disconnect ('left') and for a host share that's ended for
// good ('ended'). Reuses the approval overlay's blur + .bad styling, plus a Rejoin (reload) button.
function showEnded(kind) {
  left = true;                                    // both kinds are terminal: stop every reconnect/paint path
  showBar(false);
  try { document.body.classList.remove('connected'); } catch (e) {}
  showOverlay(true,
    kind === 'left' ? 'You’ve left the session' : 'Session ended',
    kind === 'left'
      ? 'You disconnected from the host’s terminal. Nothing here is live any more.'
      : 'The host stopped sharing, or the connection dropped for good. You can try to rejoin.',
    true);
  var rj = $('ov-rejoin'); if (rj) rj.style.display = '';
  setStatus(kind === 'left' ? 'disconnected' : 'session ended', 'bad');
}
// The guest's own clean exit. Detach onclose FIRST so closing the socket can't kick the reconnect loop.
function doDisconnect() {
  if (left) return;
  try { if (ws) { ws.onclose = null; ws.onerror = null; ws.close(1000, 'guest-left'); } } catch (e) {}
  try { if (voice && voice.leave) voice.leave(); } catch (e) {}
  showEnded('left');
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
    var segs = $('ctxsegs');
    if (segs) {
      var n = segs.children.length, lit = s.ctxPct > 0 ? Math.max(1, Math.min(n, Math.round(s.ctxPct / 100 * n))) : 0;
      for (var i = 0; i < n; i++) segs.children[i].classList.toggle('lit', i < lit);
    }
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
  var box = $('wschips'); if (!box) return;
  box.innerHTML = '';
  // The bar now also carries Disconnect, so it must NOT collapse when there are no granted projects — only the
  // "projects" label + chips hide; the bar (and its Disconnect) stays. Bar show/hide is owned by showBar (on
  // admit / on leave), not by the chip count.
  var has = grantedWs.length > 0, lbl = $('wsbar-lbl');
  if (lbl) lbl.style.display = has ? '' : 'none';
  box.style.display = has ? '' : 'none';
  if (!has) return;
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
// "who's typing" pill — names whoever's keystrokes are landing in the mirror (host or another guest; the
// server never echoes your own). Senders throttle to 1/s, so decay locally ~3s after the last ping.
var typistTimer = null;
function showTypist(name) {
  var chip = $('typist-chip'); if (!chip || !name) return;
  chip.textContent = '✎ ' + String(name).slice(0, 40);   // textContent — names are collaborator-supplied
  chip.classList.add('show');
  if (typistTimer) clearTimeout(typistTimer);
  typistTimer = setTimeout(function () { chip.classList.remove('show'); }, 3000);
}
function applyPaused(label) {
  var ov = $('paused-ov'); if (ov) ov.classList.toggle('show', !!wsPaused);
  var b = $('paused-body');
  if (b) b.textContent = (wsPaused && label)
    ? 'The host is working in "' + label + '" (not shared). The mirror resumes when they switch back to a shared project.'
    : 'The mirror resumes when they switch back to a shared project.';
}

// The read-only session browser was removed: a live link streams ONE session, not the repo's whole history, so
// there was nothing to browse. The server no longer answers ws-sessions/ws-transcript either (defense in depth —
// removing the button alone would still leave the history reachable via a crafted frame). Disconnect took its
// place in the bar; wire it (and the end-card's Rejoin) here.
{ var db = $('disconnect-btn'); if (db) db.addEventListener('click', doDisconnect); }
{ var rj = $('ov-rejoin'); if (rj) rj.addEventListener('click', function () { try { location.reload(); } catch (e) {} }); }

// ---- voice room: audio RELAYED through the share server (base64 PCM over our WS) — NOT peer-to-peer ----
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
        gotHello = true; wasAdmitted = true; reconnTries = 0;   // admitted → a later dead socket is "session ended", not "bad link"
        readOnly = !!msg.readOnly;
        myPid = msg.pid || null;                                // our voice-room peer id
        if (Array.isArray(msg.voice)) voice.setMembers(msg.voice);   // who's already in the voice room
        if (msg.host) hostName = msg.host;
        // The host may have disambiguated our name (a second "Guest" becomes "Guest (2)") — adopt what it assigned so
        // OUR own chat bubbles read right AND a later resume reconnects with the unique name (we send it as ?n=).
        if (msg.you && msg.you !== myName) { myName = msg.you; try { sessionStorage.setItem(NAME_KEY, myName); } catch (e) {} }
        $('ro').style.display = readOnly ? '' : 'none';
        document.body.classList.toggle('ro', readOnly);
        applyReadOnlyInput();                                 // read-only: a tap won't raise the soft keyboard
        grantedWs = Array.isArray(msg.workspaces) ? msg.workspaces : [];
        wsPaused = !!msg.paused;
        renderGuestWs(); applyPaused(); showBar(true);        // show the granted library + the Disconnect button + freeze if host is private
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
      } else if (msg.type === 'typist') {
        showTypist(msg.name);                                 // host or another guest is typing (the server never echoes your own)
      } else if (msg.type === 'paused') {
        wsPaused = !!msg.paused;
        applyPaused(msg.label);
      } else if (msg.type === 'voice-members') {
        voice.setMembers(msg.members || []);
      } else if (msg.type === 'audio') {
        voice.pushAudio(msg.from, msg.data, msg.sr);
      }
    } else {
      term.write(new Uint8Array(ev.data));   // raw terminal output
    }
  };
  ws.onclose = function (ev) {
    if (left) return;                                    // guest chose Disconnect — this is a final state, never reconnect back in
    if (ev && ev.code === 4001) {                        // superseded: our own resume token reconnected on another socket (new tab / woken device) — that one owns the identity now; retrying from here would just evict it back and flap
      setStatus('continued elsewhere', 'bad');
      showOverlay(true, 'Session continued elsewhere', 'You reconnected from another tab or device, so this view stepped aside. Close it — or reload here to take over again.', true);
      return;
    }
    if (denied) return;                                  // host rejected → do not hammer them with retries
    if (gotHello) { resumeFails = 0; reconnect('reconnecting…'); return; }   // we were in; transient drop → resume
    if (!opened && !resume) {                            // upgrade refused on the LINK → it's used/invalid
      setStatus('link unavailable', 'bad');
      showOverlay(true, 'This link can’t be used', 'It may have already been used, expired, or the host stopped sharing. Ask for a new link.', true);
      return;
    }
    // R14: a not-admitted close while presenting a resume token means the server no longer knows it (its ~15s
    // grace expired — tokens are deleted, not archived). Retrying the SAME dead token loops "host offline —
    // retrying…" forever, and even a reload can't escape (sessionStorage resupplies it). After 2 consecutive
    // refusals, drop it and fall back to the link token → the normal approval flow, which actually works.
    if (!gotHello && resume) {
      resumeFails++;
      if (resumeFails >= 2 && token) {
        resume = null; resumeFails = 0;
        try { sessionStorage.removeItem(STORE_KEY); } catch (e) {}
        reconnect('asking to rejoin…');
        return;
      }
    }
    reconnect(opened ? 'reconnecting…' : 'host offline — retrying…');   // pending drop or resume refused
  };
  ws.onerror = function () { try { ws.close(); } catch (e) {} };
}
function reconnect(label) {
  if (left) return;                                          // already in a terminal state
  // Once we've BEEN admitted, a run of failed reconnects means the host stopped sharing (the quick tunnel is
  // gone) — not a blip. Rather than loop "host offline — retrying…" forever, surface the blurred "Session
  // ended" card with a Rejoin button. A real transient drop reconnects well before this and resets the count.
  if (wasAdmitted && ++reconnTries >= 6) { showEnded('ended'); return; }
  setStatus(label, 'bad'); retry = Math.min(retry + 1, 6); setTimeout(connect, 400 * retry);
}

term.onData(function (d) {
  if (readOnly || denied || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (!d) return;
  // Belt-and-braces: never ship a raw ^V byte. On the host's pty the CLI answers 0x16 by pasting the
  // HOST's clipboard; guest paste has its own 'paste' frame (see the terminal paste listener above), so
  // any 0x16 that still reaches onData is a keymap leak, not intent. The server strips it too.
  if (d.indexOf('\x16') !== -1) { d = d.split('\x16').join(''); if (!d) return; }
  ws.send(JSON.stringify({ type: 'input', data: d }));   // keystrokes AND scroll bytes (Page keys, wheel reports) — shared view, shared scroll
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
  // Three real failure modes, all covered: API absent (plain-http/LAN share -> navigator.clipboard is
  // undefined), API throws synchronously, and — the common one — writeText REJECTS asynchronously
  // (document unfocused, permission denied, in-app webviews). A bare try/catch cannot see an async
  // rejection, so the legacy fallback silently never engaged and nothing was copied.
  function legacyCopy() {
    try { var ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); } catch (e2) {}
  }
  try {
    var p = navigator.clipboard && navigator.clipboard.writeText(t);
    if (p && typeof p.then === 'function') p.catch(legacyCopy); else if (!p) legacyCopy();
  } catch (e) { legacyCopy(); }
}
window.addEventListener('keydown', function (e) {
  var mod = isMac ? (e.metaKey && !e.ctrlKey && !e.altKey) : (e.ctrlKey && !e.metaKey && !e.altKey);
  var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  // PHYSICAL key first (e.code), key name as fallback — matching by e.key alone is layout-dependent: on a
  // Cyrillic/Hebrew/Greek layout the same physical chord reports a non-Latin e.key, the branch is skipped,
  // and xterm's (layout-INDEPENDENT, keyCode-based) keymap turns Ctrl+C into a raw 0x03 that rides the wire
  // and INTERRUPTS the host's running turn — the copy chord must never degrade into SIGINT-by-layout. The
  // inner `if (sel)` decide/fallthrough is untouched: empty selection still passes through as interrupt on
  // every layout, exactly like Windows Terminal.
  var isA = e.code === 'KeyA' || k === 'a';
  var isC = e.code === 'KeyC' || k === 'c';
  var inTerm = e.target && e.target.closest && e.target.closest('#terminal');
  var field = e.target && e.target.closest && e.target.closest('input, textarea');
  if (inTerm) {
    if (mod && isA) { e.preventDefault(); e.stopPropagation(); term.selectAll(); return; }
    if (mod && isC) { var sel = term.getSelection(); if (sel) { e.preventDefault(); e.stopPropagation(); copyText(sel); } return; }
    // Ctrl/⌘+V is deliberately NOT intercepted here: the browser's default accelerator must run so the
    // native 'paste' event fires with the GUEST's clipboard (see the #terminal paste listener up top).
    // The old async-clipboard-API interceptor matched by KEY NAME ('v'), which non-Latin layouts bypass —
    // the chord then fell through to xterm as a raw 0x16 and pasted the HOST's clipboard at the CLI.
    return;
  }
  if (field) {
    if (mod && isA) { e.preventDefault(); field.select(); return; }   // ONLY the chat text, not the page
    if (mod && isC) {
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
