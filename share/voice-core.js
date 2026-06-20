// Claudible — voice room over the share WebSocket (SERVER-RELAYED audio). Replaces peer-to-peer WebRTC, which
// can't connect two home users behind NAT without a TURN server (and the free public TURN we tried is dead).
// Mic is captured as wideband mono PCM, base64'd, and relayed by the share server to the other voice members —
// the SAME proven path the terminal mirror uses, so it works regardless of NAT / STUN / TURN / CSP.
//   window.makeVoiceRoom({ myId(), sendAudio(b64, sampleRate), setJoined(bool), onUi(state) })
//   returns { join, leave, toggleMute, isJoined, setMembers, pushAudio(fromId, b64, sampleRate) }
(function () {
  'use strict';
  var TX_RATE = 24000;  // preferred capture rate — wideband voice; the ACTUAL rate travels with every frame
  var GATE = 0.012;     // RMS threshold for the "speaking" dots
  var JITTER = 0.15;    // playout cushion (s): schedule this far ahead so network jitter doesn't underrun (= crackle)
  var MAXBUF = 0.5;     // if buffered latency grows past this, resync (trim) instead of drifting

  function b64FromInt16(i16) {
    var bytes = new Uint8Array(i16.buffer, i16.byteOffset, i16.byteLength), s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function int16FromB64(b64) {
    var s = atob(b64), n = s.length, bytes = new Uint8Array(n);
    for (var i = 0; i < n; i++) bytes[i] = s.charCodeAt(i);
    return new Int16Array(bytes.buffer, 0, n >> 1);
  }
  function floatToInt16(f32) {
    var i16 = new Int16Array(f32.length);
    for (var i = 0; i < f32.length; i++) { var s = Math.max(-1, Math.min(1, f32[i])); i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
    return i16;
  }
  function int16ToFloat(i16) {
    var f32 = new Float32Array(i16.length);
    for (var i = 0; i < i16.length; i++) f32[i] = i16[i] / 0x8000;
    return f32;
  }
  function rms(f32) { var s = 0; for (var i = 0; i < f32.length; i++) s += f32[i] * f32[i]; return Math.sqrt(s / (f32.length || 1)); }

  window.makeVoiceRoom = function (opts) {
    var joined = false, muted = false, members = [], speaking = {}, quiet = {};
    var inCtx = null, outCtx = null, micSrc = null, proc = null, zero = null, localStream = null;
    var playHead = {};   // sender id -> next scheduled output time
    var srcs = {};       // sender id -> [still-pending BufferSources], so a resync can cancel the backlog

    function ui() {
      try {
        var me = opts.myId();
        opts.onUi && opts.onUi({
          joined: joined, muted: muted,
          members: members.map(function (m) {
            var isSelf = m.id === me;
            // the WS IS the connection, so anyone in the room is "connected"
            return { id: m.id, name: m.name, self: isSelf, speaking: !!speaking[isSelf ? 'self' : m.id], conn: isSelf ? 'self' : 'connected' };
          }),
        });
      } catch (e) {}
    }
    function setSpeaking(key, on) {
      if (on) { clearTimeout(quiet[key]); quiet[key] = setTimeout(function () { if (speaking[key]) { speaking[key] = false; ui(); } }, 320); }
      if (on !== !!speaking[key]) { speaking[key] = on; ui(); }
    }
    function AC() { return window.AudioContext || window.webkitAudioContext; }
    function ensureOut() {
      if (!outCtx) outCtx = new (AC())();
      if (outCtx.state === 'suspended') { try { outCtx.resume(); } catch (e) {} }
      return outCtx;
    }
    function startCapture(stream) {
      try {
        try { inCtx = new (AC())({ sampleRate: TX_RATE }); } catch (e) { inCtx = new (AC())(); }
        if (inCtx.state === 'suspended') { try { inCtx.resume(); } catch (e) {} }
        var rate = inCtx.sampleRate;                              // actual rate (browser may not honor TX_RATE) — sent per frame
        micSrc = inCtx.createMediaStreamSource(stream);
        var buf = 256; while (buf < rate * 0.04 && buf < 16384) buf <<= 1;   // ~40ms blocks regardless of the rate
        proc = inCtx.createScriptProcessor(buf, 1, 1);
        proc.onaudioprocess = function (e) {
          if (!joined) return;
          var input = e.inputBuffer.getChannelData(0);
          setSpeaking('self', rms(input) > GATE && !muted);
          if (muted) return;
          opts.sendAudio(b64FromInt16(floatToInt16(input)), rate);   // native-rate PCM (no lossy downsample) + its rate
        };
        // route through a SILENT gain so the ScriptProcessor actually runs but the mic isn't echoed locally
        zero = inCtx.createGain(); zero.gain.value = 0;
        micSrc.connect(proc); proc.connect(zero); zero.connect(inCtx.destination);
      } catch (e) {}
    }

    return {
      isJoined: function () { return joined; },
      join: function () {
        if (joined) return Promise.resolve();
        return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }).then(function (s) {
          localStream = s; joined = true; muted = false;
          opts.setJoined(true); ensureOut(); startCapture(s); ui();
        }).catch(function (e) { try { opts.onUi && opts.onUi({ joined: false, muted: false, members: [], error: 'mic-denied' }); } catch (x) {} throw e; });
      },
      leave: function () {
        if (!joined) return;
        joined = false; opts.setJoined(false);
        try { if (proc) { proc.onaudioprocess = null; proc.disconnect(); } } catch (e) {}
        try { if (zero) zero.disconnect(); } catch (e) {}
        try { if (micSrc) micSrc.disconnect(); } catch (e) {}
        try { if (inCtx) inCtx.close(); } catch (e) {}
        if (localStream) { localStream.getTracks().forEach(function (t) { t.stop(); }); localStream = null; }
        for (var id in srcs) { if (srcs[id]) srcs[id].forEach(function (s) { try { s.stop(); } catch (e) {} }); }
      inCtx = micSrc = proc = zero = null; speaking = {}; playHead = {}; srcs = {}; ui();
      },
      toggleMute: function () {
        muted = !muted;
        if (localStream) localStream.getAudioTracks().forEach(function (t) { t.enabled = !muted; });
        if (muted) setSpeaking('self', false);
        ui();
      },
      setMembers: function (list) { members = Array.isArray(list) ? list : []; ui(); },
      // an audio frame arrived from another voice member → decode + schedule playback behind a jitter buffer
      pushAudio: function (from, b64, sr) {
        if (!joined || !b64) return;
        try {
          var f32 = int16ToFloat(int16FromB64(b64));
          setSpeaking(from, rms(f32) > GATE);
          var ctx = ensureOut();
          var rate = sr || TX_RATE;
          var now = ctx.currentTime, t = playHead[from] || 0, resync = false;
          if (t < now + 0.02) { t = now + JITTER; resync = true; }          // underrun / first frame → (re)build the cushion
          else if (t > now + MAXBUF) { t = now + JITTER; resync = true; }   // overrun → trim the latency back down
          if (resync) {
            // the queue ran away (or restarted): SILENCE whatever is still scheduled for this sender so the new
            // cushion REPLACES the backlog — otherwise the trimmed frame plays on top of it → doubled/garbled audio
            if (srcs[from]) { for (var j = 0; j < srcs[from].length; j++) { try { srcs[from][j].stop(); } catch (e) {} } }
            srcs[from] = [];
            var n = Math.min(f32.length, Math.round(rate * 0.004));         // fade the re-entry in so it doesn't click
            for (var k = 0; k < n; k++) f32[k] *= k / n;
          }
          var ab = ctx.createBuffer(1, f32.length, rate); ab.getChannelData(0).set(f32);   // browser resamples rate->ctx cleanly
          var src = ctx.createBufferSource(); src.buffer = ab; src.connect(ctx.destination);
          if (!srcs[from]) srcs[from] = [];
          var bag = srcs[from]; bag.push(src);
          src.onended = function () { var i = bag.indexOf(src); if (i >= 0) bag.splice(i, 1); };   // prune once played
          src.start(t);
          playHead[from] = t + ab.duration;                                 // contiguous: next frame abuts this one → no gaps
        } catch (e) {}
      },
    };
  };
})();
