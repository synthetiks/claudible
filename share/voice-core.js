// Claudible — voice-room core (WebRTC audio mesh). Loaded by BOTH the guest viewer and the host cockpit so
// the logic stays identical. Transport-agnostic: the caller supplies send()/setJoined() and feeds in the
// member list + incoming signals. Audio is peer-to-peer; only offer/answer/ICE pass through the relay.
//   window.makeVoiceRoom({ myId(), send(to,kind,data), setJoined(bool), onUi(state) })
(function () {
  'use strict';
  // STUN handles most home networks; the TURN relay is the fallback that makes audio cross strict/symmetric
  // NATs (where two peers can't connect directly). The TURN entries are Metered's free public OpenRelay —
  // best-effort; for production, run your own TURN. CSP connect-src already allows stun:/turn:/turns:.
  var ICE = { iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ] };

  window.makeVoiceRoom = function (opts) {
    var joined = false, muted = false, localStream = null, ac = null, sinkEl = null;
    var peers = {};      // peerId -> { pc, audioEl }
    var members = [];    // [{id,name}]
    var speaking = {};   // id ('self'|peerId) -> bool

    // Hidden, off-screen container for the remote <audio> sinks — positioned (so it's OUT of any CSS grid),
    // but NOT display:none (which can suspend playback in some engines).
    function sink() {
      if (!sinkEl) {
        sinkEl = document.createElement('div'); sinkEl.setAttribute('aria-hidden', 'true');
        sinkEl.style.cssText = 'position:fixed;left:-2px;bottom:-2px;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
        (document.body || document.documentElement).appendChild(sinkEl);
      }
      return sinkEl;
    }

    function ui() {
      try {
        var me = opts.myId();
        opts.onUi && opts.onUi({
          joined: joined, muted: muted,
          members: members.map(function (m) {
            var isSelf = m.id === me, rec = peers[m.id];
            // per-peer WebRTC state, surfaced to the chips: new/connecting/connected/failed/disconnected
            var conn = isSelf ? 'self' : (rec ? (rec.pc.connectionState || rec.pc.iceConnectionState || 'connecting') : (joined ? 'connecting' : 'idle'));
            return { id: m.id, name: m.name, self: isSelf, speaking: !!speaking[isSelf ? 'self' : m.id], conn: conn };
          }),
        });
      } catch (e) {}
    }

    // crude voice-activity detection per stream (drives the "speaking" dots)
    function monitor(key, stream) {
      try {
        if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
        var src = ac.createMediaStreamSource(stream), an = ac.createAnalyser();
        an.fftSize = 512; src.connect(an);
        var buf = new Uint8Array(an.frequencyBinCount);
        (function tick() {
          if (key === 'self' ? !localStream : !peers[key]) return;   // stream gone → stop
          an.getByteFrequencyData(buf);
          var sum = 0; for (var i = 0; i < buf.length; i++) sum += buf[i];
          var sp = (sum / buf.length) > 12 && !(key === 'self' && muted);
          if (sp !== speaking[key]) { speaking[key] = sp; ui(); }
          setTimeout(tick, 140);
        })();
      } catch (e) {}
    }

    // *** THE BUG ***: RTCSessionDescription / RTCIceCandidate are platform objects that Electron IPC's
    // structured clone CANNOT serialize, so the HOST's offer/answer/ICE were silently dropped (DataCloneError,
    // swallowed) and the connection FAILED. Convert to PLAIN objects (toJSON) before sending so they survive
    // BOTH transports: IPC (host) and JSON.stringify (guest).
    function ser(o) { return (o && typeof o.toJSON === 'function') ? o.toJSON() : o; }
    function flushIce(rec) { if (!rec) return; var q = rec.pendingIce; rec.pendingIce = []; q.forEach(function (c) { try { rec.pc.addIceCandidate(c).catch(function () {}); } catch (e) {} }); }

    function makePeer(peerId) {
      if (peers[peerId]) return peers[peerId];
      var pc = new RTCPeerConnection(ICE);
      var audioEl = document.createElement('audio'); audioEl.autoplay = true; audioEl.dataset.peer = peerId;
      audioEl.volume = 1;
      sink().appendChild(audioEl);   // off-screen SINK (out of layout) — NOT display:none, which can block audio playback
      peers[peerId] = { pc: pc, audioEl: audioEl, pendingIce: [], remoteSet: false };
      if (localStream) localStream.getTracks().forEach(function (t) { pc.addTrack(t, localStream); });
      pc.onicecandidate = function (e) { if (e.candidate) opts.send(peerId, 'ice', ser(e.candidate)); };
      pc.ontrack = function (e) {
        audioEl.srcObject = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
        try { var pr = audioEl.play(); if (pr && pr.catch) pr.catch(function () {}); } catch (x) {}   // autoplay can be blocked → call play() explicitly
        monitor(peerId, audioEl.srcObject);
      };
      pc.onconnectionstatechange = function () { ui(); if (pc.connectionState === 'closed') removePeer(peerId); };   // surface state to the chips
      pc.oniceconnectionstatechange = function () { ui(); };
      return peers[peerId];
    }
    function removePeer(peerId) {
      var rec = peers[peerId]; if (!rec) return;
      try { rec.pc.close(); } catch (e) {}
      try { rec.audioEl.srcObject = null; rec.audioEl.remove(); } catch (e) {}
      delete peers[peerId]; delete speaking[peerId]; ui();
    }
    function offerTo(peerId) {
      var rec = makePeer(peerId);
      rec.pc.createOffer().then(function (o) { return rec.pc.setLocalDescription(o); })
        .then(function () { opts.send(peerId, 'offer', ser(rec.pc.localDescription)); })
        .catch(function () {});
    }
    // Reconcile peer connections against the current room membership. Deterministic initiator (the smaller
    // id "calls") avoids glare; the other side creates its peer when the offer arrives.
    function reconcile() {
      if (!joined) return;
      var me = opts.myId(), present = {};
      members.forEach(function (m) {
        if (m.id === me) return;
        present[m.id] = true;
        if (!peers[m.id] && me < m.id) offerTo(m.id);
      });
      Object.keys(peers).forEach(function (id) { if (!present[id]) removePeer(id); });
    }

    return {
      isJoined: function () { return joined; },
      join: function () {
        if (joined) return Promise.resolve();
        return navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then(function (s) {
          localStream = s; joined = true; muted = false;
          opts.setJoined(true); monitor('self', s); reconcile(); ui();
        }).catch(function (e) { try { opts.onUi && opts.onUi({ joined: false, muted: false, members: [], error: 'mic-denied' }); } catch (x) {} throw e; });
      },
      leave: function () {
        if (!joined) return;
        joined = false; opts.setJoined(false);
        Object.keys(peers).forEach(removePeer);
        if (localStream) { localStream.getTracks().forEach(function (t) { t.stop(); }); localStream = null; }
        speaking = {}; ui();
      },
      toggleMute: function () {
        if (!localStream) return; muted = !muted;
        localStream.getAudioTracks().forEach(function (t) { t.enabled = !muted; });
        if (muted) speaking['self'] = false;
        ui();
      },
      setMembers: function (list) { members = Array.isArray(list) ? list : []; reconcile(); ui(); },
      handleSignal: function (sig) {
        if (!joined || !sig || !sig.from) return;     // ignore signals when we're not in the room
        var rec = makePeer(sig.from);
        if (sig.kind === 'offer') {
          rec.pc.setRemoteDescription(sig.data)
            .then(function () { rec.remoteSet = true; flushIce(rec); return rec.pc.createAnswer(); })
            .then(function (a) { return rec.pc.setLocalDescription(a); })
            .then(function () { opts.send(sig.from, 'answer', ser(rec.pc.localDescription)); })
            .catch(function () {});
        } else if (sig.kind === 'answer') {
          rec.pc.setRemoteDescription(sig.data).then(function () { rec.remoteSet = true; flushIce(rec); }).catch(function () {});
        } else if (sig.kind === 'ice') {
          if (rec.remoteSet) { try { rec.pc.addIceCandidate(sig.data).catch(function () {}); } catch (e) {} }
          else rec.pendingIce.push(sig.data);   // ICE before the remote description → buffer, then flush
        }
      },
    };
  };
})();
