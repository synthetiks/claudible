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

// Detect phone-sized / touch screens and tag <body class="mobile"> — a belt-and-suspenders companion
// to the CSS @media rules (some in-app browsers/webviews mis-report viewport width).
function flagMobile() {
  var small = window.matchMedia('(max-width: 760px)').matches;
  // coarse PRIMARY pointer + no hover = a touch device (phone/tablet, incl. large phones in landscape that
  // report >900px). Laptops/desktops have a fine primary pointer, so they never match and stay byte-identical.
  var coarse = window.matchMedia('(pointer: coarse)').matches && window.matchMedia('(hover: none)').matches;
  document.body.classList.toggle('mobile', small || coarse);
  scheduleFit();                                  // re-fit when crossing the mobile/desktop boundary (rotate, resize)
}
flagMobile();
window.addEventListener('resize', flagMobile);
window.addEventListener('orientationchange', flagMobile);

var term = new Terminal({
  fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace',
  fontSize: 13, lineHeight: 1.15, cursorBlink: true, scrollback: 5000,
  theme: { background: '#0a0b0d', foreground: '#d8dde3', cursor: '#c6ced8',
           selectionBackground: '#23272e', black: '#070809', brightBlack: '#525861' },
});
term.open($('terminal'));

var readOnly = false, ws = null, retry = 0, denied = false, myName = 'Guest', hostName = 'host';
function setStatus(txt, cls) { $('stxt').textContent = txt; $('dot').className = 'dot' + (cls ? ' ' + cls : ''); }
function showOverlay(show, title, body, bad) {
  $('overlay').classList.toggle('show', !!show);
  if (title != null) $('ov-title').textContent = title;
  if (body != null) $('ov-body').textContent = body;
  $('card').classList.toggle('bad', !!bad);
}
function applySize(c, r) { if (c) hostCols = c; try { term.resize(c, r); } catch (e) {} scheduleFit(); }

// ---- fit the mirrored terminal to the phone width (mobile only) ----
// The host runs a fixed-width grid (hostCols x rows). To make ALL columns fit a phone we shrink the FONT
// (never reflow — that shatters the TUI box-drawing). Crucially the size is computed straight from the
// SCREEN WIDTH and the column count (monospace advance ≈ 0.6 × fontSize), NOT by measuring the rendered
// DOM — DOM measurement was mis-reporting on real devices so Fit appeared to do nothing. Deterministic:
// one rule, fits all. 1:1 keeps the full font and lets the (screen-capped) pane scroll.
var BASE_FONT = 13;                                // matches Terminal({fontSize}) above
var FIT_KEY = 'claudible_fitmode';                 // 'fit' (default) | '1to1'
var fitMode = 'fit';                               // default: shrink so the whole width fits the phone
try { if (sessionStorage.getItem(FIT_KEY) === '1to1') fitMode = '1to1'; } catch (e) {}
var hostCols = 120;                                // host's reported column count (set in applySize)
function isMobile() { return document.body.classList.contains('mobile'); }
function recomputeFit() {
  var cur = term.options.fontSize || BASE_FONT;
  document.body.classList.toggle('term1to1', fitMode === '1to1');
  document.body.classList.toggle('can-fit', isMobile());       // show the Fit/1:1 pill on phones
  if (!isMobile() || fitMode === '1to1') {                     // desktop, or user chose full-size + scroll
    if (cur !== BASE_FONT) term.options.fontSize = BASE_FONT;
    return;
  }
  var vpW = (window.visualViewport && window.visualViewport.width) || window.innerWidth || 390;
  var avail = vpW - 26;                                        // terminal padding + borders + a hair
  // monospace cell advance ≈ 0.6 × fontSize → pick the largest size where hostCols columns span ≤ avail
  var target = Math.max(4, Math.min(BASE_FONT, Math.floor(avail / (Math.max(1, hostCols) * 0.6))));
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

// Fit / 1:1 toggle (CSP-safe: wired here, no inline handler). Labels the CURRENT state; dot color matches.
(function fitToggle() {
  var btn = $('fitbtn'); if (!btn) return;
  var lbl = $('fitbtn-l');
  function paint() { if (lbl) lbl.textContent = (fitMode === '1to1') ? '1:1' : 'Fit'; btn.setAttribute('aria-pressed', String(fitMode === 'fit')); }
  btn.addEventListener('click', function () {
    fitMode = (fitMode === '1to1') ? 'fit' : '1to1';
    try { sessionStorage.setItem(FIT_KEY, fitMode); } catch (e) {}
    paint(); recomputeFit();
    if (fitMode === '1to1') { var w = $('terminal').closest('.wrap'); if (w) w.scrollLeft = 0; }   // pan from column 0
  });
  paint();
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
    if (s.session) { $('sess-chip-text').textContent = s.session; chip.style.display = ''; }
    else { chip.style.display = 'none'; }
  }
}

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
        if (msg.host) hostName = msg.host;
        $('ro').style.display = readOnly ? '' : 'none';
        applyReadOnlyInput();                                 // read-only: a tap won't raise the soft keyboard
        if (msg.resume) { resume = msg.resume; try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ t: token, r: resume })); } catch (e) {} }
        showOverlay(false);
        document.body.classList.add('connected');             // reveal the mobile Fit/1:1 pill only once actually viewing
        setStatus('connected', 'ok');
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
}
function addSystemChat(text) {
  var empty = document.getElementById('chat-empty'); if (empty) empty.parentNode.removeChild(empty);
  var d = document.createElement('div'); d.className = 'chat-sys'; d.textContent = text;
  chatLog.appendChild(d); chatLog.scrollTop = chatLog.scrollHeight;
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
  var saved = '';
  try { saved = sessionStorage.getItem(NAME_KEY) || ''; } catch (e) {}
  $('name-in').value = saved;
  $('name-go').addEventListener('click', startJoin);
  $('name-in').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); startJoin(); } });
  setTimeout(function () { try { $('name-in').focus(); } catch (e) {} }, 40);
})();
