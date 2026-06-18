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
let baseCost = null, sessTok = 0, lastUsageKey = null, sessionLog = [], curCtxPct = null, curSessionLabel = '';
// Mirror the tracker (and which session is live) to any shared guests. Guests render these verbatim.
function pushTracker() {
  try { claudible.shareTracker({ ctxPct: curCtxPct, cost: $('trk-cost').textContent, tokens: $('trk-tokens').textContent, session: curSessionLabel }); } catch {}
}
function resetStats() {
  baseCost = null; sessTok = 0; lastUsageKey = null; sessionLog.length = 0; curCtxPct = null;
  $('trk-cost').textContent = '$0.00';
  $('trk-tokens').textContent = '0';
  pushTracker();
}
claudible.onStatus((s) => {
  // context % — live current-fill gauge + guardrail (amber ≥70%, red ≥85%; becomes a /compact shortcut)
  if (typeof s.ctxPct === 'number') {
    const pct = s.ctxPct; curCtxPct = pct;
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
  pushTracker();   // mirror the freshly-updated tracker to shared guests
});

// ---------- (b) mic -> Whisper STT  (shared by the Talk button + the Left-Ctrl push-to-talk hold) ----------
let mediaRecorder = null, chunks = [], recording = false, micStream = null, discardClip = false;
function talkUI(on) {
  $('talk').textContent = on ? '■ Stop' : 'Talk'; $('talk').className = on ? 'primary live' : 'primary'; setActive('lbl-in', on);
  // Top-bar Voice In box — always visible (even with the drawer closed) so you can see you're talking.
  const vi = $('voice-in'); if (vi) { vi.classList.toggle('live', on); const s = $('vin-stat'); if (s) s.textContent = on ? 'listening…' : 'ready'; }
}

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
const pttHint = document.querySelector('.ptt-hint');
function pttCancelTimer() { if (pttTimer) { clearTimeout(pttTimer); pttTimer = null; } }
window.addEventListener('keydown', (e) => {
  if (pttCapturing) {                      // rebinding: the next key becomes the new push-to-talk key
    e.preventDefault(); e.stopPropagation();
    if (e.key !== 'Escape') setPttKey(e.code);   // Escape cancels without changing it
    stopCapture();
    return;
  }
  if (e.code === pttKey) {
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
let ttsAudio = null, ttsBusy = false, selectedVoice = 'af_bella', alwaysSpeak = true, ttsUrl = null, speakGen = 0;
let lastReply = '';                                  // Claude's latest reply (stripped) — the manual "▶ Speak" reads this
let ttsSpeed = 0;                                    // % faster over baseline (0–25), applied via audio.playbackRate
let announceOn = true, chimeOn = true;               // factory-on: spoken "task complete" cue + soft chat chime
// Voice Out button is dual: ▶ Speak (idle, reads lastReply) ↔ ■ Stop (while speaking). Disabled when nothing to speak.
function updateVoiceOutBtn() {
  const b = $('vout-stop'); if (!b) return;
  const speaking = ttsBusy || !!ttsAudio;
  b.textContent = speaking ? '■ Stop' : '▶ Speak';
  b.disabled = !speaking && !lastReply;
  b.title = speaking ? 'Stop speaking' : (lastReply ? "Speak Claude's latest reply" : 'Nothing to speak yet');
}
function stripForSpeech(t) {
  return t.replace(/```[\s\S]*?```/g, ' … code block … ').replace(/`([^`]+)`/g, '$1')
          .replace(/[#*_>]/g, '').replace(/\n{2,}/g, '. ').replace(/\s+/g, ' ').trim().slice(0, 600);
}
function setSpeakBtn(on) { const b = $('speak'); b.textContent = on ? 'Stop Speech' : 'Speak'; b.classList.toggle('live', on); const vo = $('voice-out'); if (vo) vo.classList.toggle('speaking', on); updateVoiceOutBtn(); }
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
if ($('vout-stop')) { $('vout-stop').addEventListener('click', () => { if (ttsBusy || ttsAudio) stopSpeech(); else if (lastReply) speak(lastReply); }); updateVoiceOutBtn(); }
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
  claudible.ptyInput('\x1b');                                   // close prior menu / clear input
  setTimeout(() => claudible.ptyInput(cmd + '\r'), 120);        // then run the command
  setTimeout(() => term.focus(), 150);                    // keyboard back in the terminal
};
// Command bar: 5 pills visible, the rest reached by horizontal scroll/drag in the same width.
// Fire on pointer-UP (so a drag scrolls instead of triggering); preventDefault on pointer-DOWN
// holds focus in the terminal (keeps the click-twice focus-war fix above).
const cmdscroll = $('cmdscroll'), cmdwrap = cmdscroll.parentElement;
let cdrag = null;
function cmdEdges() {                                          // fade the side(s) that have more off-screen
  const max = cmdscroll.scrollWidth - cmdscroll.clientWidth;
  cmdwrap.classList.toggle('more-l', cmdscroll.scrollLeft > 2);
  cmdwrap.classList.toggle('more-r', cmdscroll.scrollLeft < max - 2);
}
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
    lastReply = reply;                    // remember it for the manual "▶ Speak" button
    $('tts-in').value = reply;            // populate the (collapsible) box for manual Speak
    updateVoiceOutBtn();                  // enable ▶ Speak now that there's a reply
    if (alwaysSpeak) speak(reply);        // auto-speak the reply in the selected voice
    else { setDot('d-tts', 'ok'); if (announceOn && String(o.last_assistant_message).length > 700) speak('The task is complete.'); }   // long-task done cue (raw length — stripForSpeech caps reply at 600)
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

function selectNodeText(node) {                                // select a whole DOM node's text (for Copy on non-input regions)
  const r = document.createRange(); r.selectNodeContents(node);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
}
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const inTerm = !!e.target.closest('#terminal');
  const chatLog = e.target.closest('#chat-log');                // right-clicked inside the viewer chat log
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
let sharing = false;
const shareBtn = $('share-btn'), shareLink = $('share-link'), shareOut = $('share-out'), shareNew = $('share-newlink');
function shareUI(on) {
  shareBtn.textContent = on ? 'Stop sharing' : 'Share session';
  shareBtn.classList.toggle('live', on);
  setActive('lbl-share', on);
  setDot('d-share', on ? 'ok' : '');
  $('share-ro').disabled = on;                 // mode is fixed for the life of a session
  shareNew.style.display = on ? 'block' : 'none';
  document.querySelector('.body').classList.toggle('sharing', on);   // reveal/hide the chat column
  if (on) { chatReset(); renderRoster([]); }                         // show "you" in the roster the moment sharing starts
}
// presence roster in the chat header: you + each viewer with a green(here)/amber(AFK)/red(closed-tab) light
function renderRoster(roster) {
  const el = $('chat-roster'); if (!el) return;
  el.innerHTML = '';
  const you = document.createElement('span'); you.className = 'rmember you';
  const yd = document.createElement('span'); yd.className = 'rdot ok'; you.appendChild(yd);
  you.appendChild(document.createTextNode((hostDisplayName || 'You') + ' · you'));
  el.appendChild(you);
  (roster || []).forEach((g) => {
    const cls = g.state === 'active' ? 'ok' : (g.state === 'idle' ? 'idle' : 'gone');
    const m = document.createElement('span'); m.className = 'rmember' + (g.state === 'gone' ? ' gone' : '');
    m.title = g.state === 'active' ? 'here' : (g.state === 'idle' ? 'away / AFK' : 'closed the tab');
    const d = document.createElement('span'); d.className = 'rdot ' + cls;
    m.appendChild(d); m.appendChild(document.createTextNode(g.name));
    el.appendChild(m);
  });
}
claudible.onShareRoster((roster) => renderRoster(roster));
function showLink(url) {
  shareLink.value = url; shareLink.style.display = 'block'; shareLink.style.opacity = '1';
  shareLink.title = 'Click to copy';
}
let hostDisplayName = 'Host';
shareBtn.addEventListener('click', async () => {
  if (sharing) {
    shareBtn.disabled = true;
    await claudible.shareStop();
    sharing = false; shareUI(false);
    shareLink.style.display = 'none'; shareLink.value = '';
    shareOut.textContent = 'sharing stopped'; shareOut.className = 'out';
    shareBtn.disabled = false;
    return;
  }
  // ask the host for a display name before sharing (prefilled from last time)
  $('host-name-in').value = loadPrefs().hostName || '';
  $('namemodal').classList.add('show');
  setTimeout(() => $('host-name-in').focus(), 30);
});
async function doStartSharing() {
  hostDisplayName = ($('host-name-in').value || '').trim().slice(0, 40) || 'Host';
  savePrefs({ hostName: hostDisplayName });
  $('namemodal').classList.remove('show');
  shareBtn.disabled = true;
  shareOut.textContent = 'starting tunnel…'; shareOut.className = 'out';
  setDot('d-share', 'work');
  const readOnly = $('share-ro').checked;
  let r; try { r = await claudible.shareStart({ readOnly, name: hostDisplayName }); } catch (e) { r = { ok: false, error: String(e) }; }
  shareBtn.disabled = false;
  if (!r || !r.ok) {
    setDot('d-share', 'bad'); shareOut.textContent = 'share failed: ' + ((r && r.error) || 'unknown'); shareOut.className = 'out';
    return;
  }
  sharing = true; shareUI(true);
  showLink(r.url);
  const mode = readOnly ? ' · view-only' : '';
  shareOut.textContent = (r.remote === false)
    ? 'local link only (tunnel off)' + mode + ' — ' + (r.note || '')
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
  setTimeout(() => { if (sharing) shareOut.textContent = prev; }, 1200);
});
// rotate the invite link — the old one stops working for NEW joins; people already in stay connected
shareNew.addEventListener('click', async () => {
  shareNew.disabled = true;
  let r; try { r = await claudible.shareNewLink(); } catch (e) { r = null; }
  shareNew.disabled = false;
  if (r && r.ok) { showLink(r.url); shareOut.textContent = 'fresh invite link — the old one is now dead'; shareOut.className = 'out live'; }
  else { shareOut.textContent = 'could not make a new link'; }
});
// reflect connected viewers while sharing
claudible.onShareGuests((n) => {
  if (!sharing) return;
  shareOut.textContent = n > 0 ? (n + ' viewer' + (n === 1 ? '' : 's') + ' connected') : 'waiting for people to join';
  shareOut.className = 'out live';
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
  if (!open) setTimeout(() => term.focus(), 0);
}
$('settings-btn').addEventListener('click', () => openDrawer(!drawer.classList.contains('open')));
$('drawer-close').addEventListener('click', () => openDrawer(false));
drawerScrim.addEventListener('click', () => openDrawer(false));
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawer.classList.contains('open')) openDrawer(false); });

// ---------- viewer chat (human↔human side channel; never reaches Claude/terminal) ----------
const chatLog = $('chat-log'), chatIn = $('chat-in');
function chatReset() {
  chatLog.innerHTML = '<div class="chat-empty" id="chat-empty">Messages here go only between you and your viewer — Claude never sees them.</div>';
}
function addChat(who, text, mine) {
  const empty = $('chat-empty'); if (empty) empty.remove();
  const d = document.createElement('div');
  d.className = 'chat-msg ' + (mine ? 'me' : 'them');
  const w = document.createElement('span'); w.className = 'who'; w.textContent = who;
  const body = document.createElement('div'); body.textContent = text;   // textContent → no HTML injection
  d.appendChild(w); d.appendChild(body); chatLog.appendChild(d);
  chatLog.scrollTop = chatLog.scrollHeight;
}
function addSystemChat(text) {
  const empty = $('chat-empty'); if (empty) empty.remove();
  const d = document.createElement('div'); d.className = 'chat-sys'; d.textContent = text;
  chatLog.appendChild(d); chatLog.scrollTop = chatLog.scrollHeight;
}
function sendChat() {
  const text = chatIn.value.trim(); if (!text) return;
  addChat(hostDisplayName, text, true);
  claudible.shareSendChat(text);
  chatIn.value = '';
}
$('chat-send').addEventListener('click', sendChat);
chatIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
claudible.onShareChat((m) => {
  if (!m) return;
  if (m.role === 'system') addSystemChat(m.text);          // "X joined" / "X left"
  else if (m.text) { addChat(m.name || 'viewer', m.text, false); if (chimeOn) playChime(); }   // soft ping so you don't miss a codev's chat
});
chatReset();

// ---------- persisted preferences (voice + Always Speak) ----------
// Stored in the renderer's localStorage (kept in Electron's userData), so they survive app restarts.
const PREFS_KEY = 'claudible_prefs';
function loadPrefs() { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch { return {}; } }
function savePrefs(patch) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(Object.assign(loadPrefs(), patch))); } catch {} }
(function applyPrefs() {
  const p = loadPrefs();
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
  applyTtsSpeed(p.ttsSpeed || 0, false);
  if (p.pttKey) pttKey = p.pttKey;
  applyPttKey();   // render the current push-to-talk key (default or saved)
  syncVoiceUI();   // reflect saved voice + always-speak in the top-bar Voice Out box
})();

// ---------- sessions sidebar (switch between Claude conversations, like Claude Code) ----------
const sessListEl = $('sess-list');
const bodyEl = document.querySelector('.body');
let activeSession = null;
// Workspaces: which library the conversations below belong to. The conversation order is stored
// PER workspace so switching libraries never reshuffles another one's list.
let workspaces = [], activeWsId = 'legacy';
function orderKey() { return 'wsOrder_' + activeWsId; }
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
                    .sort((a, b) => (b.mtime || 0) - (a.mtime || 0))                // new ones: chronological, newest first
                    .map((s) => s.id);
  return [...fresh, ...kept];
}
const TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
const PENCIL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
let sessIndex = {};                                                                 // id -> session record (labels/preview)
// Manual session title override (user-set — no auto-titling), stored per id in prefs; falls back to the preview.
function sessTitle(s) { const t = (loadPrefs().sessionTitles || {})[s.id]; return t || s.preview; }
function renderSessionRow(s) {
  const row = document.createElement('div');
  row.className = 'sess' + (s.id === activeSession ? ' active' : '');
  row.dataset.id = s.id; row.setAttribute('role', 'button'); row.tabIndex = 0;
  const p = document.createElement('div'); p.className = 'sess-prev'; p.textContent = sessTitle(s);
  const m = document.createElement('div'); m.className = 'sess-meta';
  m.textContent = relTime(s.mtime) + (s.msgs ? (' · ' + s.msgs + ' msg' + (s.msgs === 1 ? '' : 's')) : '');
  row.appendChild(p); row.appendChild(m);
  const del = document.createElement('button');
  del.className = 'sess-del'; del.title = 'Delete session'; del.setAttribute('aria-label', 'Delete session');
  del.innerHTML = TRASH_SVG;
  del.addEventListener('click', (e) => { e.stopPropagation(); row.classList.add('confirming'); });
  const conf = document.createElement('div'); conf.className = 'sess-confirm';
  const lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = 'Delete?';
  const yes = document.createElement('button'); yes.className = 'sess-yes'; yes.textContent = 'Delete';
  const no = document.createElement('button'); no.className = 'sess-no'; no.textContent = 'Cancel';
  yes.addEventListener('click', (e) => { e.stopPropagation(); deleteSession(s.id); });
  no.addEventListener('click', (e) => { e.stopPropagation(); row.classList.remove('confirming'); });
  conf.appendChild(lbl); conf.appendChild(yes); conf.appendChild(no);
  const edit = document.createElement('button');
  edit.className = 'sess-edit'; edit.title = 'Rename session'; edit.setAttribute('aria-label', 'Rename session');
  edit.innerHTML = PENCIL_SVG;
  edit.addEventListener('click', (e) => { e.stopPropagation(); startSessEdit(row, p, s); });
  row.appendChild(edit); row.appendChild(del); row.appendChild(conf);
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
      p.textContent = t || s.preview;
      if (s.id === activeSession) { curSessionLabel = p.textContent; pushTracker(); }   // mirror the new title to guests
    }
    try { inp.remove(); } catch {} p.style.display = '';
  };
  inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); commit(true); } else if (e.key === 'Escape') { e.preventDefault(); commit(false); } });
  inp.addEventListener('blur', () => commit(true));
  inp.addEventListener('pointerdown', (e) => e.stopPropagation());   // don't start a row drag / open
  inp.addEventListener('click', (e) => e.stopPropagation());
}
// pointer-drag reorder with a movement threshold: a plain click opens; a drag past 5px reorders the DOM
// live and persists the new order. A press on the trash / confirm controls never starts a drag or open.
let sdrag = null;
function onSessPointerDown(e, row, s) {
  if (e.button !== 0) return;
  if (e.target.closest('.sess-del') || e.target.closest('.sess-confirm') || e.target.closest('.sess-edit') || e.target.closest('.sess-rename') || row.classList.contains('confirming')) return;
  sdrag = { id: s.id, label: sessTitle(s), row, startY: e.clientY, moved: false, pid: e.pointerId };
  try { row.setPointerCapture(e.pointerId); } catch {}
}
function onSessPointerMove(e) {
  if (!sdrag) return;
  if (!sdrag.moved) { if (Math.abs(e.clientY - sdrag.startY) < 5) return; sdrag.moved = true; sdrag.row.classList.add('dragging'); }
  const rows = Array.prototype.slice.call(sessListEl.querySelectorAll('.sess')).filter((r) => r !== sdrag.row);
  let before = null;
  for (let i = 0; i < rows.length; i++) { const r = rows[i].getBoundingClientRect(); if (e.clientY < r.top + r.height / 2) { before = rows[i]; break; } }
  if (before) sessListEl.insertBefore(sdrag.row, before); else sessListEl.appendChild(sdrag.row);
  const lr = sessListEl.getBoundingClientRect();                                    // gentle auto-scroll near the edges
  if (e.clientY < lr.top + 22) sessListEl.scrollTop -= 10;
  else if (e.clientY > lr.bottom - 22) sessListEl.scrollTop += 10;
}
function onSessPointerUp() {
  if (!sdrag) return;
  const d = sdrag; sdrag = null;
  try { d.row.releasePointerCapture(d.pid); } catch {}
  d.row.classList.remove('dragging');
  if (d.moved) {
    const order = Array.prototype.slice.call(sessListEl.querySelectorAll('.sess')).map((r) => r.dataset.id);
    setOrder(order);                                                               // manual order persists (per workspace)
  } else {
    openSession(d.id, d.label);                                                    // plain click → open
  }
}
const deletingIds = new Set();                                                     // hide rows mid-delete so they can't flash back as "fresh"
async function deleteSession(id) {
  if (deletingIds.has(id)) return;
  deletingIds.add(id);
  const order = getOrder().filter((x) => x !== id);
  setOrder(order);
  if (id === activeSession) {                                                       // switch the pty OFF it BEFORE deleting the open file
    const next = order[0] || 'new';
    await openSession(next, next === 'new' ? '' : (sessIndex[next] && sessIndex[next].preview));
  }
  try { await claudible.sessionDelete(id); } catch {} finally { deletingIds.delete(id); }
  refreshSessions();
}
async function refreshSessions() {
  const myWs = activeWsId;                                                          // ignore this refresh if we switch workspaces mid-flight
  sessListEl.innerHTML = '<div class="sess-empty">loading…</div>';
  let list = []; try { list = await claudible.sessionList(); } catch {}
  if (myWs !== activeWsId) return;                                                  // a newer workspace switch already owns the list
  if (Array.isArray(list) && deletingIds.size) list = list.filter((s) => !deletingIds.has(s.id));   // hide rows being deleted
  if (!Array.isArray(list) || !list.length) {
    sessListEl.innerHTML = '<div class="sess-empty">No saved sessions yet. Start working and it’ll show up here.</div>';
    return;
  }
  const order = mergeSessionOrder(getOrder(), list);
  setOrder(order);
  sessIndex = {}; list.forEach((s) => { sessIndex[s.id] = s; });
  const ordered = order.map((id) => sessIndex[id]).filter(Boolean);
  // Default highlight must match what session.sh `--continue` resumes — the most-recent conversation
  // (max mtime) — not the top of the stable saved order.
  if (!activeSession) { const mru = list.slice().sort((a, b) => (b.mtime || 0) - (a.mtime || 0))[0]; activeSession = (mru || ordered[0]).id; }
  const act = sessIndex[activeSession];
  if (act && !curSessionLabel) { curSessionLabel = act.preview; pushTracker(); }    // tell guests which session is live
  sessListEl.innerHTML = '';
  ordered.forEach((s) => sessListEl.appendChild(renderSessionRow(s)));
}
// The sidebar is DOCKED (a left column of .body) — toggling .with-sessions slides the layout, it
// never covers the terminal/chat. The terminal auto-refits via its ResizeObserver when the column changes.
function openSidebar(open) {
  bodyEl.classList.toggle('with-sessions', open);
  if (open) { refreshWorkspaces(); refreshSessions(); }
}
async function openSession(id, label) {
  if (id !== 'new' && id === activeSession) return;   // already on this one
  activeSession = (id === 'new') ? null : id;
  curSessionLabel = (id === 'new') ? 'New session' : (label || '');   // mirrored to guests
  refreshSessions();                                  // re-highlight without collapsing (stays docked)
  term.reset();                                       // clear the old conversation from view
  resetStats();                                       // reset tracker baselines + push label to guests
  try { await claudible.sessionOpen(id); } catch {}
  setTimeout(() => term.focus(), 150);
}
// ---------- workspaces (the library a session belongs to: legacy / local folder / private repo) ----------
const WS_FOLDER_SVG = '<svg class="ws-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const WS_REPO_SVG = '<svg class="ws-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';
function renderWsChips() {
  const el = $('ws-chips'); if (!el) return;
  el.innerHTML = '';
  workspaces.forEach((w) => {
    const chip = document.createElement('div');
    chip.className = 'ws-chip' + (w.id === activeWsId ? ' active' : '');
    chip.title = (w.kind === 'repo' && w.repoUrl) ? w.repoUrl : w.label;
    chip.innerHTML = (w.kind === 'repo' ? WS_REPO_SVG : WS_FOLDER_SVG) +
      '<span class="ws-name"></span>' +
      (w.kind === 'legacy' ? '' : '<span class="ws-kind">' + (w.kind === 'repo' ? 'repo' : 'local') + '</span>');
    chip.querySelector('.ws-name').textContent = w.label;
    chip.addEventListener('click', () => switchWorkspace(w.id));
    el.appendChild(chip);
  });
}
async function refreshWorkspaces() {
  let r = null; try { r = await claudible.workspaceList(); } catch {}
  if (r && Array.isArray(r.workspaces)) { workspaces = r.workspaces; if (r.activeId) activeWsId = r.activeId; }
  renderWsChips();
}
async function switchWorkspace(id) {
  if (id === activeWsId) return;
  activeWsId = id;
  activeSession = null; curSessionLabel = '';     // the conversation list is about to change entirely
  renderWsChips();
  term.reset(); resetStats();                      // clear the old workspace's view; main respawns the pty in the new cwd
  try { await claudible.workspaceOpen(id); } catch {}
  refreshSessions();
  setTimeout(() => term.focus(), 150);
}
// new-workspace chooser modal
let wsChoiceKind = 'local';
function selectWsKind(kind) {
  wsChoiceKind = kind;
  $('ch-local').classList.toggle('sel', kind === 'local');
  $('ch-repo').classList.toggle('sel', kind === 'repo');
}
function openWsModal() {
  selectWsKind('local');
  $('ws-name-in').value = ''; $('ws-busy').textContent = ''; $('ws-busy').classList.remove('err');
  $('ws-modal').classList.add('show');
  setTimeout(() => $('ws-name-in').focus(), 60);
}
function closeWsModal() { $('ws-modal').classList.remove('show'); }
async function createWorkspace() {
  if ($('ws-create').disabled) return;                      // in-flight guard (the Enter key can bypass the disabled button)
  const name = $('ws-name-in').value.trim();
  const busy = $('ws-busy'); busy.classList.remove('err');
  if (!name) { busy.textContent = 'enter a name first'; busy.classList.add('err'); return; }
  busy.textContent = wsChoiceKind === 'repo' ? 'creating private repo on GitHub…' : 'creating folder…';
  $('ws-create').disabled = true;
  let r = null; try { r = await claudible.workspaceCreate(wsChoiceKind, name); } catch {}
  $('ws-create').disabled = false;
  if (!r || !r.ok) { busy.textContent = (r && r.error) || 'creation failed'; busy.classList.add('err'); return; }
  closeWsModal();                                   // main already switched + respawned a fresh conversation
  activeSession = null; curSessionLabel = '';
  await refreshWorkspaces();
  term.reset(); resetStats(); refreshSessions();
  setTimeout(() => term.focus(), 150);
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

$('sessions-btn').addEventListener('click', () => openSidebar(!bodyEl.classList.contains('with-sessions')));
$('sidebar-close').addEventListener('click', () => openSidebar(false));
$('new-session').addEventListener('click', () => openSession('new'));
// One-time migration: conversation order moved from the flat `sessionOrder` key to per-workspace
// `wsOrder_<id>`; carry the legacy arrangement over so it isn't lost on first launch after upgrade.
{ const _p = loadPrefs(); if (_p.sessionOrder && !_p.wsOrder_legacy) savePrefs({ wsOrder_legacy: _p.sessionOrder }); }
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
      claudible.clipRead().then((t) => { if (t) { claudible.ptyInput('\x1b[200~' + t + '\x1b[201~'); term.focus(); } });
      return;
    }
    if (mod && k === 'a') { e.preventDefault(); e.stopPropagation(); term.selectAll(); return; }
    if (k === 'Backspace' && !mod) {
      const sel = term.getSelection();
      if (sel && sel.length) {
        e.preventDefault(); e.stopPropagation();
        claudible.ptyInput('\x7f'.repeat(sel.length));   // delete the marked text
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
