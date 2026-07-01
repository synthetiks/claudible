// Claudible — voice room over the share WebSocket (SERVER-RELAYED audio). Replaces peer-to-peer WebRTC, which
// can't connect two home users behind NAT without a TURN server (and the free public TURN we tried is dead).
// Mic is captured as wideband mono PCM, base64'd, and relayed by the share server to the other voice members —
// the SAME proven path the terminal mirror uses, so it works regardless of NAT / STUN / TURN / CSP.
//   window.makeVoiceRoom({ myId(), sendAudio(b64, sampleRate), setJoined(bool), onUi(state) })
//   returns { join, leave, toggleMute, isJoined, setMembers, pushAudio(fromId, b64, sampleRate) }
(function () {
  'use strict';
  var FALLBACK_RATE = 48000;  // only used if a frame somehow arrives without its own sample rate
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
    var gains = {};      // sender id -> GainNode — playback routes src -> gain -> destination (per-person volume)
    var volume = {};     // sender id -> volume multiplier the LISTENER chose (persists across re-created nodes)

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
    // one GainNode per sender → lets the listener set how loud they hear each person (src -> gain -> speakers)
    function gainFor(from, ctx) {
      var g = gains[from];
      if (!g) {
        g = ctx.createGain();
        g.gain.value = (from in volume) ? volume[from] : 1;
        g.connect(ctx.destination);
        gains[from] = g;
      }
      return g;
    }
    function startCapture(stream) {
      try {
        inCtx = new (AC())();                                    // capture at the device's NATIVE rate (usually 48k)
        if (inCtx.state === 'suspended') { try { inCtx.resume(); } catch (e) {} }
        var rate = inCtx.sampleRate;                              // send THIS exact rate so playback needs NO resample (resampling each 40ms buffer on its own = boundary crackle)
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
    // Mobile: locking the phone / backgrounding the tab suspends the audio contexts (mic stops, playback stops).
    // The server now holds our seat across the brief disconnect, so just RESUME the contexts when we return and
    // voice keeps working without rejoining.
    try {
      document.addEventListener('visibilitychange', function () {
        if (!joined || document.hidden) return;
        try { if (inCtx && inCtx.state === 'suspended') inCtx.resume(); } catch (e) {}
        try { if (outCtx && outCtx.state === 'suspended') outCtx.resume(); } catch (e) {}
      });
    } catch (e) {}

    return {
      isJoined: function () { return joined; },
      join: function () {
        if (joined) return Promise.resolve();
        // Some in-app webviews (Slack/Discord/Instagram/Facebook embedded browsers) don't expose
        // navigator.mediaDevices even over https. Reading .getUserMedia off undefined would throw SYNCHRONOUSLY —
        // before a promise exists — so the caller's .catch() never runs and the mic-denied UI is skipped (silent
        // no-op). Guard it: surface the same 'mic-denied' feedback and return a REJECTED promise instead of throwing.
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          try { opts.onUi && opts.onUi({ joined: false, muted: false, members: [], error: 'mic-denied' }); } catch (x) {}
          return Promise.reject(new Error('no-mediaDevices'));
        }
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
        for (var gid in gains) { try { gains[gid].disconnect(); } catch (e) {} }
        inCtx = micSrc = proc = zero = null; speaking = {}; playHead = {}; srcs = {}; gains = {}; ui();   // keep `volume` so per-person levels survive a rejoin
      },
      toggleMute: function () {
        muted = !muted;
        if (localStream) localStream.getAudioTracks().forEach(function (t) { t.enabled = !muted; });
        if (muted) setSpeaking('self', false);
        ui();
      },
      setMembers: function (list) { members = Array.isArray(list) ? list : []; ui(); },
      // listener-side per-person volume: 0 = muted … 1 = normal … up to 4x. Applies live and persists across rejoin.
      setVolume: function (from, mult) {
        var v = Math.max(0, Math.min(4, +mult)); if (!isFinite(v)) v = 1;
        volume[from] = v;
        if (gains[from]) { try { gains[from].gain.value = v; } catch (e) {} }
        return v;
      },
      getVolume: function (from) { return (from in volume) ? volume[from] : 1; },
      // an audio frame arrived from another voice member → decode + schedule playback behind a jitter buffer
      pushAudio: function (from, b64, sr) {
        if (!joined || !b64) return;
        try {
          var f32 = int16ToFloat(int16FromB64(b64));
          setSpeaking(from, rms(f32) > GATE);
          var ctx = ensureOut();
          var rate = sr || FALLBACK_RATE;
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
          var src = ctx.createBufferSource(); src.buffer = ab; src.connect(gainFor(from, ctx));
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
