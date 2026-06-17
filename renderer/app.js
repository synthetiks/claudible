// Claudible — renderer controller.
'use strict';
const $ = (id) => document.getElementById(id);
const setDot = (id, cls) => { const e = $(id); if (e) e.className = 'dot' + (cls ? ' ' + cls : ''); };
const setActive = (id, on) => { const e = $(id); if (e) e.classList.toggle('active', on); };

// ---------- embedded live TUI ----------
const term = new Terminal({
  fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Mono", Consolas, monospace',
  fontSize: 13, lineHeight: 1.15, cursorBlink: true, scrollback: 5000,
  theme: { background: '#0a0b0d', foreground: '#d8dde3', cursor: '#c6ced8',
           selectionBackground: '#23272e', black: '#070809', brightBlack: '#525861' },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open($('terminal'));

let ptyStarted = false;
function sync() {
  try {
    fit.fit();
    if (!ptyStarted) { ptyStarted = true; claudible.ptyStart(term.cols, term.rows); } // spawn Claude at the EXACT fitted size
    else claudible.ptyResize(term.cols, term.rows);
    updateScrollbar();
  } catch {}
}
term.onData((d) => claudible.ptyInput(d));
// Auto-scroll ONLY when already at the bottom, so scrolling up to read isn't yanked back down.
claudible.onPtyData((d) => {
  const b = term.buffer.active;
  const wasAtBottom = b.viewportY >= b.baseY - 1;
  term.write(d, () => { if (wasAtBottom) term.scrollToBottom(); updateScrollbar(); });
});

// ---------- custom scroll gutter (lives in the UI, never covers terminal text) ----------
const sc = $('scroll'), thumb = $('scroll-thumb');
function updateScrollbar() {
  const b = term.buffer.active, rows = term.rows, baseY = b.baseY, total = b.length;
  const trackH = sc.clientHeight;
  if (baseY <= 0 || total <= rows || trackH <= 0) { thumb.style.opacity = '0'; return; }
  const thumbH = Math.max(26, trackH * (rows / total));
  const top = (trackH - thumbH) * (b.viewportY / baseY);
  thumb.style.opacity = '1';
  thumb.style.height = thumbH + 'px';
  thumb.style.transform = 'translateY(' + top + 'px)';
}
term.onScroll(() => updateScrollbar());
setInterval(updateScrollbar, 120);   // poll so the thumb tracks the live scroll position even when onScroll is sparse

let dragging = false, grabDY = 0;
function thumbTop() { return thumb.getBoundingClientRect().top - sc.getBoundingClientRect().top; }
function scrollToFrac(frac) {
  const baseY = term.buffer.active.baseY;
  term.scrollToLine(Math.round(Math.max(0, Math.min(1, frac)) * baseY));
}
thumb.addEventListener('pointerdown', (e) => {
  dragging = true; grabDY = e.clientY - thumbTop(); thumb.classList.add('drag');
  thumb.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation();
});
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const trackH = sc.clientHeight, thumbH = thumb.offsetHeight;
  const top = Math.max(0, Math.min(trackH - thumbH, e.clientY - sc.getBoundingClientRect().top - grabDY));
  scrollToFrac((trackH - thumbH) > 0 ? top / (trackH - thumbH) : 0);
});
window.addEventListener('pointerup', () => { if (dragging) { dragging = false; thumb.classList.remove('drag'); } });
sc.addEventListener('pointerdown', (e) => {           // click the gutter to jump
  if (e.target === thumb) return;
  scrollToFrac((e.clientY - sc.getBoundingClientRect().top) / sc.clientHeight);
});
new ResizeObserver(sync).observe($('terminal'));
window.addEventListener('resize', sync);
setTimeout(sync, 180);
setTimeout(() => term.focus(), 350);   // keyboard ready in the terminal on launch

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
})();

// ---------- session tracker ----------
// Claude Code's statusLine reports CUMULATIVE cost/tokens for the (persisted, --continue'd)
// conversation. We want THIS session's usage, so we subtract a baseline captured at launch and
// re-baseline on /clear or any upstream reset. Baseline resets every app launch (fresh process).
const fmtK = (n) => n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : String(n);
let baseCost = null, sessTok = 0, lastUsageKey = null, sessionLog = [];
function resetStats() {
  baseCost = null; sessTok = 0; lastUsageKey = null; sessionLog.length = 0;
  $('trk-cost').textContent = '$0.00';
  $('trk-tokens').textContent = '0';
}
claudible.onStatus((s) => {
  // context % — live current-fill gauge + guardrail (amber ≥70%, red ≥85%; becomes a /compact shortcut)
  if (typeof s.ctxPct === 'number') {
    const pct = s.ctxPct;
    $('trk-ctx').textContent = pct + '%';
    $('trk-ctxfill').style.width = Math.max(2, Math.min(100, pct)) + '%';
    const bar = $('trk-ctxbar');
    bar.classList.toggle('warn', pct >= 70 && pct < 85);
    bar.classList.toggle('crit', pct >= 85);
    bar.title = pct >= 70 ? `context ${pct}% — click to /compact` : 'context window used';
  }
  // session cost — statusLine cost is cumulative for the continued conversation; show delta since launch
  if (typeof s.costUsd === 'number' && s.costUsd >= 0) {
    if (baseCost === null && s.costUsd > 0) baseCost = s.costUsd;        // baseline at launch
    if (baseCost !== null && s.costUsd < baseCost) baseCost = s.costUsd; // upstream reset (e.g. /clear)
    $('trk-cost').textContent = '$' + (baseCost === null ? 0 : Math.max(0, s.costUsd - baseCost)).toFixed(2);
  }
  // session tokens — accumulate genuinely-NEW (non-cache) tokens per turn (current_usage changes each turn).
  // Skip the FIRST key seen this launch: on a --continue session it's the PRE-launch turn's usage, which must
  // not be counted (mirrors the cost baseline above so tokens and cost both start at 0 for the app session).
  if (s.usageKey != null && s.usageKey !== lastUsageKey) {
    if (lastUsageKey !== null) sessTok += (s.newTok || 0);
    lastUsageKey = s.usageKey;
    $('trk-tokens').textContent = fmtK(sessTok);
  }
});

// ---------- (b) mic -> Whisper STT  (shared by the Talk button + the Left-Ctrl push-to-talk hold) ----------
let mediaRecorder = null, chunks = [], recording = false, micStream = null, discardClip = false;
function talkUI(on) { $('talk').textContent = on ? '■ Stop' : 'Talk'; $('talk').className = on ? 'primary live' : 'primary'; setActive('lbl-in', on); }

async function startRecording() {
  if (recording) return;
  recording = true; discardClip = false;   // claim synchronously — blocks double-trigger re-entry
  stopSpeech();                            // barge-in: stop any TTS the instant the user starts talking
  talkUI(true); setDot('d-stt', 'work'); $('stt-out').textContent = 'listening…'; $('stt-out').className = 'out';
  try { micStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) {
    recording = false; talkUI(false);
    setDot('d-stt', 'bad'); $('stt-out').textContent = 'mic blocked: ' + e.message + ' — enable Windows mic for desktop apps'; $('stt-out').className = 'out';
    return;
  }
  if (!recording) { micStream.getTracks().forEach((t) => t.stop()); return; }   // released during the async mic-grant gap
  const mt = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
  mediaRecorder = new MediaRecorder(micStream, { mimeType: mt }); chunks = [];
  mediaRecorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  mediaRecorder.onstop = async () => {
    micStream.getTracks().forEach((t) => t.stop());
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
    claudible.ptyInput('\x1b[200~' + text + '\x1b[201~');   // paste the transcript into the live TUI
    setTimeout(() => claudible.ptyInput('\r'), 120);        // …then submit it
  };
  mediaRecorder.start(1000);               // 1s timeslice: collect data incrementally so LONG recordings
                                           // capture reliably (concatenated webm chunks decode fine via ffmpeg)
}
function stopRecording(opts) {
  if (!recording) return;
  discardClip = !!(opts && opts.discard);
  recording = false; talkUI(false);
  try { if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop(); } catch {}
}
$('talk').addEventListener('click', () => { recording ? stopRecording() : startRecording(); });

// ---------- Push-to-talk: HOLD Left Ctrl ----------
// Left Ctrl is also the terminal's busiest modifier (Ctrl+C/R/D/…), so we DON'T fire the mic on a
// quick press. A ~150ms hold-debounce means only a deliberate hold (with no other key) starts
// recording; a quick Ctrl+<key> shortcut cancels the timer and never touches the mic — and still
// works, because we only swallow the lone Ctrl keydown while the other key's event still carries
// ctrlKey=true. Capture phase so xterm never sees the lone Ctrl. Trade-off: speech onset begins
// ~150ms after you press (press, then speak — natural for push-to-talk).
const PTT_HOLD_MS = 150;
let pttHeld = false, pttStart = 0, pttCombo = false, pttTimer = null;
const pttHint = document.querySelector('.ptt-hint');
function pttCancelTimer() { if (pttTimer) { clearTimeout(pttTimer); pttTimer = null; } }
window.addEventListener('keydown', (e) => {
  if (e.code === 'ControlLeft') {
    e.preventDefault(); e.stopPropagation();
    if (pttHeld) return;                   // ignore auto-repeat while held
    pttHeld = true; pttCombo = false; pttStart = Date.now();
    pttTimer = setTimeout(() => {          // held long enough alone => it's a deliberate talk, start the mic
      pttTimer = null;
      if (pttHeld && !pttCombo) { if (pttHint) pttHint.classList.add('live'); startRecording(); }
    }, PTT_HOLD_MS);
    return;
  }
  if (pttHeld) { pttCombo = true; pttCancelTimer(); }   // another key while held => a shortcut, never start the mic
}, true);
window.addEventListener('keyup', (e) => {
  if (e.code === 'ControlLeft' && pttHeld) {
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

// ---------- (out) Kokoro TTS — Speak <-> Stop Speech ----------
let ttsAudio = null, ttsBusy = false, selectedVoice = 'af_bella', alwaysSpeak = true, ttsUrl = null, speakGen = 0;
function stripForSpeech(t) {
  return t.replace(/```[\s\S]*?```/g, ' … code block … ').replace(/`([^`]+)`/g, '$1')
          .replace(/[#*_>]/g, '').replace(/\n{2,}/g, '. ').replace(/\s+/g, ' ').trim().slice(0, 600);
}
function setSpeakBtn(on) { const b = $('speak'); b.textContent = on ? 'Stop Speech' : 'Speak'; b.classList.toggle('live', on); }
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

// voice selector pills
document.querySelectorAll('.vpill').forEach((p) => p.addEventListener('mousedown', (e) => {
  e.preventDefault();
  document.querySelectorAll('.vpill').forEach((x) => x.classList.remove('on'));
  p.classList.add('on'); selectedVoice = p.dataset.voice;
}));
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
  alwaysSpeak = e.target.checked;
  $('always-toggle').classList.toggle('on', alwaysSpeak);
  setTimeout(() => term.focus(), 0);
});

// ---------- commands ----------
// Robust even when switching between commands: ESC closes any open menu (e.g. the /effort
// selector) / clears partial input, then type the command + Enter, then refocus the terminal.
// mousedown + preventDefault => the FIRST press registers even while the terminal holds focus
// (avoids the focus-war "click twice" problem).
const send = (cmd) => {
  claudible.ptyInput('\x1b');                                   // close prior menu / clear input
  setTimeout(() => claudible.ptyInput(cmd + '\r'), 120);        // then run the command
  setTimeout(() => term.focus(), 150);                    // keyboard back in the terminal
};
[['cmd-effort', '/effort'], ['cmd-context', '/context'], ['cmd-model', '/model'],
 ['cmd-compact', '/compact'], ['cmd-clear', '/clear'], ['cmd-status', '/status']].forEach(([id, cmd]) =>
  $(id).addEventListener('mousedown', (e) => { e.preventDefault(); send(cmd); if (cmd === '/clear') resetStats(); }));

// Context guardrail: the ctx bar becomes a one-tap /compact shortcut only once it's in the warn/crit zone.
$('trk-ctxbar').addEventListener('mousedown', (e) => {
  const bar = $('trk-ctxbar');
  if (bar.classList.contains('warn') || bar.classList.contains('crit')) { e.preventDefault(); send('/compact'); }
});

// ---------- Claude's reply -> VOICE OUT (via the Stop hook) ----------
claudible.onHookLine((line) => {
  let o; try { o = JSON.parse(line); } catch { return; }
  if (o.hook_event_name === 'UserPromptSubmit' && o.prompt) {
    sessionLog.push({ role: 'you', text: String(o.prompt) });           // captures typed AND voice turns
  } else if (o.hook_event_name === 'Stop' && o.last_assistant_message) {
    sessionLog.push({ role: 'claude', text: String(o.last_assistant_message) });
    const reply = stripForSpeech(o.last_assistant_message);
    $('tts-in').value = reply;            // populate the (collapsible) box for manual Speak
    if (alwaysSpeak) speak(reply);        // auto-speak the reply in the selected voice
    else setDot('d-tts', 'ok');
  }
});

// ---------- Save Session (pop-out tab) ----------
function buildTranscript() {
  const head = 'Claudible session — ' + new Date().toLocaleString() + '\n' + '='.repeat(48) + '\n\n';
  const body = sessionLog.map((t) => `[${t.role}]\n${t.text}\n`).join('\n');
  return head + (body || '(no turns recorded this session yet)') + '\n';
}
$('savetab').addEventListener('click', async () => {
  const lbl = $('savetab').querySelector('.lbl');
  const r = await claudible.saveSession(buildTranscript());
  if (r && r.saved) { lbl.textContent = 'saved ✓'; setTimeout(() => { lbl.textContent = 'save session'; }, 1800); }
  else if (r && r.error) { lbl.textContent = 'save failed'; setTimeout(() => { lbl.textContent = 'save session'; }, 1800); }
});

// ---------- Clear input (pop-out tab, bottom-right) ----------
// One click wipes whatever you've typed/dictated in Claude's prompt box — no holding backspace.
// Sequence = space + Esc-Esc (empirically the ONLY thing that clears every input state: single-line
// cursor-anywhere AND multi-line). The leading space is a guard: Esc-Esc on an EMPTY field opens
// Claude's "Rewind" picker, so we inject one throwaway char first => Esc-Esc always takes the
// clear-draft path, then clears the space too. Sent RAW (not via send(), which would append Enter
// and submit). Note: if clicked WHILE Claude is generating, the Esc interrupts the reply (and may
// leave a stray space) — harmless and recoverable; clear is meant for the idle/just-dictated case.
$('cleartab').addEventListener('click', () => {
  claudible.ptyInput('\x20\x1b\x1b');
  setTimeout(() => term.focus(), 0);
  const lbl = $('cleartab').querySelector('.lbl');
  lbl.textContent = 'cleared ✓'; setTimeout(() => { lbl.textContent = 'clear input'; }, 1200);
});

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

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const inTerm = !!e.target.closest('#terminal');
  const field = e.target.closest('input, textarea');
  const sel = inTerm ? term.getSelection() : String(window.getSelection() || '');
  const items = [];
  if (sel && sel.trim()) items.push({ label: 'Copy', act: () => claudible.clipWrite(sel) });
  if (inTerm || field) items.push({ label: 'Paste', act: async () => {
    const t = await claudible.clipRead(); if (!t) return;
    if (inTerm) { claudible.ptyInput('\x1b[200~' + t + '\x1b[201~'); term.focus(); }   // bracketed paste, no auto-submit
    else insertIntoField(field, t);
  } });
  if (inTerm || field) items.push({ label: 'Select All', act: () => { if (inTerm) term.selectAll(); else field.select(); } });
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
