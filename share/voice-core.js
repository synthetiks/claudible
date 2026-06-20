// Claudible — voice room over the share WebSocket (SERVER-RELAYED audio). Replaces peer-to-peer WebRTC, which
// can't connect two home users behind NAT without a TURN server (and the free public TURN we tried is dead).
// Mic is captured as 16 kHz mono PCM, base64'd, and relayed by the share server to the other voice members —
// the SAME proven path the terminal mirror uses, so it works regardless of NAT / STUN / TURN / CSP.
//   window.makeVoiceRoom({ myId(), sendAudio(b64), setJoined(bool), onUi(state) })
//   returns { join, leave, toggleMute, isJoined, setMembers, pushAudio(fromId, b64) }
(function () {
  'use strict';
  var SR = 16000;       // transmit sample rate (plenty for voice)
  var FRAME = 2048;     // ScriptProcessor block size (at the input device rate)
  var GATE = 0.012;     // RMS threshold for the "speaking" dots

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
  function downsample(buf, inRate, outRate) {
    if (outRate >= inRate) return buf;
    var ratio = inRate / outRate, len = Math.round(buf.length / ratio), out = new Float32Array(len);
    for (var i = 0; i < len; i++) out[i] = buf[Math.min(Math.round(i * ratio), buf.length - 1)];
    return out;
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
        inCtx = new (AC())();
        if (inCtx.state === 'suspended') { try { inCtx.resume(); } catch (e) {} }
        micSrc = inCtx.createMediaStreamSource(stream);
        proc = inCtx.createScriptProcessor(FRAME, 1, 1);
        proc.onaudioprocess = function (e) {
          if (!joined) return;
          var input = e.inputBuffer.getChannelData(0);
          setSpeaking('self', rms(input) > GATE && !muted);
          if (muted) return;
          opts.sendAudio(b64FromInt16(floatToInt16(downsample(input, inCtx.sampleRate, SR))));
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
        inCtx = micSrc = proc = zero = null; speaking = {}; playHead = {}; ui();
      },
      toggleMute: function () {
        muted = !muted;
        if (localStream) localStream.getAudioTracks().forEach(function (t) { t.enabled = !muted; });
        if (muted) setSpeaking('self', false);
        ui();
      },
      setMembers: function (list) { members = Array.isArray(list) ? list : []; ui(); },
      // an audio frame arrived from another voice member → decode + schedule playback (small jitter buffer)
      pushAudio: function (from, b64) {
        if (!joined || !b64) return;
        try {
          var f32 = int16ToFloat(int16FromB64(b64));
          setSpeaking(from, rms(f32) > GATE);
          var ctx = ensureOut();
          var ab = ctx.createBuffer(1, f32.length, SR); ab.getChannelData(0).set(f32);
          var src = ctx.createBufferSource(); src.buffer = ab; src.connect(ctx.destination);
          var now = ctx.currentTime;
          var start = Math.max(now + 0.05, playHead[from] || 0);
          if (start > now + 0.6) start = now + 0.05;   // drift guard: if the queue ran away, resync
          src.start(start);
          playHead[from] = start + ab.duration;
        } catch (e) {}
      },
    };
  };
})();
