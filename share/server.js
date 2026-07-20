// Claudible — local terminal-sharing server.
//   Streams the SAME node-pty session main.js already owns to remote guests over WebSockets, and feeds
//   their keystrokes back into the pty. No third-party service: runs on THIS machine, loopback only
//   (cloudflared/ngrok carry the last hop — see cloudflared.js).
//
//   Security & sharing model:
//   • Approve-guest. Every new viewer waits for the host to approve them (the host sees the viewer's
//     chosen name) before any terminal data flows. A rejected/timed-out/over-cap attempt is closed.
//   • Reusable, approval-gated link. The shareable token (?t=) is NOT burned on first use — several
//     people (up to MAX_GUESTS) can join the SAME link, each gated by approval. Each approved guest is
//     minted its own private resume token (?r=) for silent reconnect/refresh, which is revoked once they
//     leave for good. regenerateLink() ("new link") is a full reset: it disconnects every current guest and
//     revokes all tokens, so re-inviting locks out anyone who held the old link.
//   • Names. Host names itself when sharing; each viewer names itself on join. Approvals and the chat
//     side-channel show those names, plus system "X joined / X left" lines. Chat never reaches Claude.
//   • read-only mode lets guests watch (and chat) but not type. A ring buffer replays recent output.
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
// NB: 'ws' is lazy-required inside start() (the only place it's used), NOT at module load — so this file's pure
// helpers (uniqueName/cleanName) stay require-able in an environment without node_modules installed (the CI test
// job runs pure Node + bash with no `npm ci`). Loading it eagerly here would crash that suite.

const NM = path.join(__dirname, '..', 'node_modules');
const ASSETS = {
  '/xterm.js':     { file: path.join(NM, '@xterm/xterm/lib/xterm.js'),         type: 'text/javascript; charset=utf-8' },
  '/xterm.css':    { file: path.join(NM, '@xterm/xterm/css/xterm.css'),        type: 'text/css; charset=utf-8' },
  '/addon-fit.js': { file: path.join(NM, '@xterm/addon-fit/lib/addon-fit.js'), type: 'text/javascript; charset=utf-8' },
  '/guest.js':     { file: path.join(__dirname, 'guest.js'),                   type: 'text/javascript; charset=utf-8' },
  '/voice-core.js':{ file: path.join(__dirname, 'voice-core.js'),             type: 'text/javascript; charset=utf-8' },
  '/logo.png':     { file: path.join(__dirname, '..', 'assets', 'logo.png'),   type: 'image/png' },
};
const GUEST_HTML = path.join(__dirname, 'guest.html');
let APP_VERSION = ''; try { APP_VERSION = require('../package.json').version || ''; } catch {}   // rides the hello frame so a joiner can surface host/guest build skew
const RING_CAP = 256 * 1024;
const APPROVAL_TIMEOUT = 90000;
const MAX_GUESTS = 8;            // cap concurrent viewers (the host typically invites a few)
const MAX_PENDING = 16;          // cap UNAPPROVED sockets in the lobby: MAX_GUESTS only bounds ADMITTED clients, so without this a link holder could open unlimited pending sockets (connection amplification) — each held for the full APPROVAL_TIMEOUT
const MAX_WS_PAYLOAD = 512 * 1024;   // hard per-frame cap on the guest-facing server AND the live-join client. ws defaults to 100 MiB, reassembled BEFORE app code runs — an unapproved link holder (or a hostile advertised session) could flood ~100MB frames and block/OOM the whole Electron main loop. 512KB clears the largest legit frame (audio ≤128KB, chat 2000 chars, keystrokes tiny) with headroom.
const MAX_AUDIO_B64 = 128 * 1024;   // reject an oversized relayed voice frame. Real frames are ~40ms blocks (a few KB base64; ~44KB at the 16384-sample ceiling), so 128KB is generous headroom while bounding a hostile/oversized frame on the internet-facing relay
const NAME_MAX = 40;
const ROSTER_MAX = 32;           // MAX_GUESTS(8) live + up to 24 'left' tombstones. Beyond that, the oldest tombstone is evicted (see trimRoster) — the Map had no delete at all and grew one entry per distinct name, forever.
const newToken = () => crypto.randomBytes(16).toString('hex');

function serveFile(res, file, type) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}
function safeEqual(a, b) {
  if (a == null || b == null) return false;
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
function paramFromUrl(url, name) {
  try { return new URL(url, 'http://x').searchParams.get(name); } catch { return null; }
}
function cleanName(n, fallback) {
  // strip control chars, collapse whitespace, cap length; clients render names via textContent (no injection)
  const s = (n == null ? "" : String(n)).replace(/[\x00-\x1f\x7f]/g, "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
  return s || fallback;
}
const eqCI = (a, b) => String(a == null ? "" : a).toLowerCase() === String(b == null ? "" : b).toLowerCase();   // names compare case-insensitively ("mk" and "MK" are the same person to a human)
// Disambiguate a display name against everyone already present. The roster/kick/chat-attribution logic is all
// KEYED BY NAME, so two guests who pick the same name (or both default to "Guest") would otherwise collapse into a
// single roster entry — the second's presence would clobber the first, one drop would mark BOTH "gone", and a kick
// would hit both. Rather than reject the join (forcing a rename), we make the name unique for the joiner by
// appending " (2)", " (3)"… — so joining always succeeds and the existing by-name logic becomes correct by
// construction. The base is truncated to leave room for the suffix; a full-length base would otherwise slice the
// suffix back off and silently defeat the guarantee. Pure + deterministic (isTaken reports use); exported for tests.
function uniqueName(base, isTaken, max) {
  const cap = max || NAME_MAX;
  const b = cleanName(base, "Guest");
  if (!isTaken(b)) return b;
  for (let i = 2; i < 1000; i++) {
    const suffix = " (" + i + ")";
    const cand = cleanName(b.slice(0, Math.max(1, cap - suffix.length)) + suffix, "Guest");
    if (!isTaken(cand)) return cand;
  }
  return cleanName(b.slice(0, Math.max(1, cap - 8)) + " " + newToken().slice(0, 6), "Guest");   // pathological (998 collisions) — random tail
}

// ---- guest terminal-input hygiene (pure; exported for tests) ----
// A raw ^V (0x16) from a guest must never reach the host's pty: the CLI attached to it answers ^V by
// reading the clipboard of the machine it runs on — the HOST's — so any guest byte that triggers it is a
// confused-deputy paste of the wrong person's clipboard. The current guest client can no longer emit one
// (paste rides its own typed frame), but a stale cached tab or a future keymap regression dies here.
function stripCtrlV(data) {
  const s = String(data == null ? '' : data);
  return s.indexOf('\x16') === -1 ? s : s.split('\x16').join('');
}
// One guest paste, host-wrapped: the payload is enclosed in bracketed-paste marks ON THE HOST (mirroring
// the host's own Ctrl+V path), so the marks themselves must not appear INSIDE the payload — an embedded
// \x1b[201~ would terminate the paste early and turn everything after it into live keystrokes (paste
// injection — real risk when a guest pastes text they copied from an untrusted page). NUL and ^V bytes are
// dropped for the same reason ^V is stripped from keystrokes.
function sanitizePaste(text) {
  return String(text == null ? '' : text).replace(/\x1b\[20[01]~/g, '').replace(/[\x00\x16]/g, '');
}
const MAX_PASTE_CHARS = 200 * 1000;   // a paste, not an upload — and MAX_WS_PAYLOAD already bounds the frame

// onInput(data) · onPaste(text,{pid,name}) · onGuests(n) · onApprovalRequest({id,name,addr},fn) · onApprovalCancel(id)
// onChat({role,name,text})  — a guest chat OR a system join/left line, surfaced to the host UI
function createShareServer({ onInput, onPaste, onGuests, onRoster, onApprovalRequest, onApprovalCancel, onChat, onSwitchWorkspace, onBrowseSessions, onBrowseTranscript, onVoiceMembers, onAudio } = {}) {
  let server = null, wss = null, port = null, readOnly = false, requireApproval = true;
  let heartbeatTimer = null;   // ~30s WS ping/pong — catches SILENT disconnects (a network drop with no clean 'close')
  let linkToken = null, hostName = 'Host';
  let cols = 120, rows = 32;
  let ring = Buffer.alloc(0);
  let lastStatus = null;
  let lastHistory = [];   // the active workspace's session-history log (host-pushed) — replayed to late joiners like lastStatus
  let paused = false;            // host is in a NON-granted workspace → stream nothing to guests
  let workspaces = [];           // granted workspace library shown to guests: [{id,label,kind,live}]
  const clients = new Set();
  const resumeTokens = new Map();   // private reconnect token per approved guest -> the client IP it was minted for (fail-open replay guard)
  const pending = new Map();
  let pendingSeq = 0;
  // ---- voice room (server-relayed audio) ----  every participant has a stable id; the host is 'host', guests
  // are 'gN'. Audio is RELAYED through this server as base64 PCM frames (audioFromHost / the guest voice frames
  // below) — it is NOT peer-to-peer. The original WebRTC-mesh design was dropped in c4b9c4f; the server both
  // tracks membership AND forwards every audio frame, so voice traffic does cross the relay.
  let pidSeq = 0;
  const byPid = new Map();           // pid -> ws (find the target of a relayed signal)
  const voiceGuests = new Set();     // pids of guests currently in the voice room (mic on)
  let hostVoice = false;             // is the host in the voice room?
  // A guest whose socket dropped but may still reconnect: a mobile lock / tab background closes the WS, then the
  // guest auto-reconnects with their resume token. Keyed by that token — we HOLD the "left" announcement and their
  // voice seat for a grace window, cancelling both if they return in time (so a phone lock isn't a fake departure).
  const pendingDrops = new Map();    // resume token -> { timer, wasVoice, name }
  const REJOIN_GRACE = Number(process.env.CLAUDIBLE_REJOIN_GRACE_MS) || 15000;   // narrowed from 45s — shorter silent-rejoin window
  const HEARTBEAT_MS = Number(process.env.CLAUDIBLE_HEARTBEAT_MS) || 30000;      // ping each guest this often; no pong by the next tick → terminate
  function voiceMembers() {
    const m = [];
    if (hostVoice) m.push({ id: 'host', name: hostName });
    // `ws.readyState === ws.OPEN` is NOT optional here, and it is the one consumer of `clients` in the voice
    // subsystem that was missing it (audioFromHost and the guest relay both have it). A superseded socket stays
    // in `clients` until its async 'close' lands, and since the pid-stability fix its `_pid` is now IDENTICAL to
    // the successor's — so without this guard, both objects match voiceGuests during the reconnect window and the
    // same person is listed TWICE (and it never self-heals: a superseded drop() doesn't re-broadcast). .close()
    // sets readyState to CLOSING synchronously, so the ghost is already excluded by the time this runs.
    for (const ws of clients) { if (ws.readyState === ws.OPEN && voiceGuests.has(ws._pid)) m.push({ id: ws._pid, name: ws._name }); }
    return m;
  }
  function broadcastVoice() {
    const members = voiceMembers();
    const s = JSON.stringify({ type: 'voice-members', members });
    for (const ws of clients) { if (ws.readyState === ws.OPEN) { try { ws.send(s); } catch {} } }
    try { onVoiceMembers && onVoiceMembers(members); } catch {}   // keep the host UI in sync too
  }
  function hostVoiceSet(on) { hostVoice = !!on; broadcastVoice(); }
  function audioFromHost(data, sr) {                              // host's audio frame → every voice guest
    if (typeof data !== 'string') return;
    const aout = JSON.stringify({ type: 'audio', from: 'host', data: data, sr: sr });
    for (const c of clients) { if (voiceGuests.has(c._pid) && c.readyState === c.OPEN) { try { c.send(aout); } catch {} } }
  }

  const notifyGuests = () => { try { onGuests && onGuests(clients.size); } catch {} };
  // presence roster — name -> 'active'(green) | 'idle'(amber/AFK) | 'gone'(red, closed tab). 'gone' is kept so the
  // host can see who left; a resume reconnect flips it back to active.
  const roster = new Map();
  // Mark a departed guest. delete+set moves them to the END of the Map's insertion order, so eviction below is
  // genuinely oldest-tombstone-first even for a name that joined long ago and only just left.
  const markGone = (name) => { roster.delete(name); roster.set(name, 'gone'); };
  // BOUND THE ROSTER. Every distinct display name that ever joined left a permanent 'gone' tombstone — the Map had
  // no `delete` anywhere except the wholesale clear() in stop()/regenerateLink(). And notifyRoster re-broadcasts the
  // WHOLE list to every client on every change, so the per-message payload grew with it. A long-lived public link
  // with drive-by joiners grew both without limit. Only tombstones are ever evicted; live guests are untouchable.
  const trimRoster = () => {
    if (roster.size <= ROSTER_MAX) return;
    for (const [name, state] of roster) {          // Map iterates in insertion order → oldest first
      if (roster.size <= ROSTER_MAX) break;
      if (state === 'gone') roster.delete(name);
    }
  };
  const notifyRoster = () => {
    trimRoster();
    const list = Array.from(roster, ([name, state]) => ({ name, state }));
    try { onRoster && onRoster(list); } catch {}                                  // → host UI
    const s = JSON.stringify({ type: 'roster', list });                           // → every guest too, so a native joiner can show "who's here"
    for (const ws of clients) { if (ws.readyState === ws.OPEN) { try { ws.send(s); } catch {} } }
  };
  function appendRing(buf) {
    ring = ring.length ? Buffer.concat([ring, buf]) : Buffer.from(buf);
    if (ring.length > RING_CAP) ring = ring.slice(ring.length - RING_CAP);
  }
  // Best-effort client IP: behind cloudflared the socket is the tunnel's localhost, so prefer the proxy's
  // forwarded header; fall back to the raw socket for LAN/localhost. Used ONLY as a fail-open replay guard
  // (we never reject when an IP is unknown — see onConnection's resume branch), so exactness isn't critical;
  // only CONSISTENCY between mint and resume matters (same device → same string → matches).
  function clientIp(req) {
    try {
      const h = (req && req.headers) || {};
      const cf = h['cf-connecting-ip'];
      if (cf) return String(cf).trim();
      const xff = h['x-forwarded-for'];
      if (xff) return String(xff).split(',')[0].trim();
      return (req && req.socket && req.socket.remoteAddress) || '';
    } catch { return ''; }
  }
  function hasResume(r) { if (!r) return false; for (const t of resumeTokens.keys()) { if (safeEqual(r, t)) return true; } return false; }

  function pageAuthorized(url) {
    const t = paramFromUrl(url, 't'), r = paramFromUrl(url, 'r');
    return (linkToken && safeEqual(t, linkToken)) || hasResume(r);
  }
  // WS upgrade → 'resume' (approved guest reconnecting), 'link' (joining via the invite), or null.
  function wsAuth(url) {
    const t = paramFromUrl(url, 't'), r = paramFromUrl(url, 'r');
    if (hasResume(r)) return 'resume';
    if (linkToken && safeEqual(t, linkToken)) return 'link';
    return null;
  }

  // chat fan-out: relay a message to every client except the sender; bubble guest/system lines to host.
  function relayChat(payloadObj, fromWs) {
    const s = JSON.stringify(payloadObj);
    for (const ws of clients) { if (ws !== fromWs && ws.readyState === ws.OPEN) { try { ws.send(s); } catch {} } }
    if (payloadObj.role !== 'host') { try { onChat && onChat(payloadObj); } catch {} }
  }
  function systemChat(text) { relayChat({ type: 'chat', role: 'system', text }, null); }
  // "who's typing" — a tiny throttled signal so every viewer can label the keystrokes they see land in the
  // mirror. Sent immediately when the typist CHANGES, else at most 1/s during a burst; renderers decay the
  // chip locally (~3s), so no stop event is needed. Never sent while paused (same privacy rule as the mirror),
  // and never echoed to the typist's own socket (you know you're typing).
  let typName = '', typTs = 0;
  function typistPing(name, exceptWs) {
    if (paused || !name) return;
    const now = Date.now();
    if (name === typName && (now - typTs) < 1000) return;
    typName = name; typTs = now;
    const s = JSON.stringify({ type: 'typist', name });
    for (const ws of clients) { if (ws !== exceptWs && ws.readyState === ws.OPEN) { try { ws.send(s); } catch {} } }
  }
  function broadcastTypist(name) { typistPing(cleanName(name, hostName), null); }   // the HOST is typing → tell every guest

  // Is this display name already in use by someone present? Checks the host, every live client, AND anyone still
  // inside their reconnect grace window (a briefly-dropped guest whose name is theirs to return to). Case-insensitive.
  function nameTaken(nm) {
    if (eqCI(nm, hostName)) return true;
    for (const ws of clients) { if (eqCI(ws._name, nm)) return true; }
    for (const p of pendingDrops.values()) { if (p && eqCI(p.name, nm)) return true; }
    return false;
  }

  // Start streaming to a guest. Fresh 'link' joins mint a private resume token + announce them.
  function admit(ws, mode, name, resumeTok) {
    if (ws.readyState !== ws.OPEN) return;
    // Re-check the guest cap HERE, not only at connect (the check at the bottom of onConnection). With approval
    // ON (the default), a fresh joiner waits in `pending` — bounded by MAX_PENDING(16), not MAX_GUESTS(8) —
    // between that connect-time check and this admission, so a backlog of approvals could otherwise seat more
    // than MAX_GUESTS. A seat inside its owner's grace window (pendingDrops) counts as OCCUPIED: drop()
    // releases clients.size immediately, so without the reservation a link joiner could fill the seat and the
    // original guest's in-window resume — which has NO cap check of its own by design — would overflow the cap.
    if (mode === 'link' && clients.size + pendingDrops.size >= MAX_GUESTS) {
      try { ws.send(JSON.stringify({ type: 'denied', reason: 'full' })); } catch {}
      try { ws.close(); } catch {}
      return;
    }
    // Look up the returning guest's grace-window record FIRST — it's the SERVER's record of the exact name they
    // dropped under, and the roster identity below is resolved from it (not the client's ?n=).
    const back = (mode === 'resume' && resumeTok) ? pendingDrops.get(resumeTok) : null;
    // SUPERSEDE: a resume presenting a token that a STILL-REGISTERED socket owns is the same guest coming back
    // before the heartbeat noticed the old socket died (laptop sleep / WiFi blip — no FIN ever arrives, so
    // drop() hasn't run and there's no grace record yet). That zombie was holding the guest's name, which used
    // to force uniqueName below to mint "name (2)" for their own reconnect — the roster-ghost bug. Instead:
    // adopt the zombie's name (the server's OWN record, never the raw ?n=), carry its voice membership over,
    // and close it with 4001 so a genuinely-live duplicate (a copied tab) shows "continued elsewhere" instead
    // of fighting back with retries. Its drop() then goes silent (_superseded) — no announce, no grace record.
    let ghost = null, ghostVoice = false;
    if (mode === 'resume' && resumeTok && !back) {
      for (const c of clients) { if (c !== ws && c._resume === resumeTok) { ghost = c; break; } }
      if (ghost) {
        ghost._superseded = true;
        if (voiceGuests.delete(ghost._pid)) ghostVoice = true;
        try { ghost.close(4001, 'superseded'); } catch {}
      }
    }
    // A resume that neither reclaims a grace reservation (back) nor supersedes a still-connected ghost is,
    // seat-wise, a NEW occupant — their old seat was fully released when the grace window expired. Cap it
    // exactly like a link join, or a valid-but-orphaned token re-admits past MAX_GUESTS.
    if (mode === 'resume' && !back && !ghost && clients.size + pendingDrops.size >= MAX_GUESTS) {
      try { ws.send(JSON.stringify({ type: 'denied', reason: 'full' })); } catch {}
      try { ws.close(); } catch {}
      return;
    }
    // A FRESH joiner gets a roster-unique name here — inside admit's single synchronous critical section, BEFORE
    // clients.add below, so no two joins racing through the approval queue can slip identical names past (and the
    // check never matches the joiner against itself). A RESUME returns to its RESERVED name (back.name), NOT the
    // client-supplied ?n=: for a native guest that ?n= is the stale ORIGINAL (main.js never re-sends the assigned
    // name), and for a hostile guest it's attacker-controlled — trusting it would revert a suffixed guest to a
    // colliding name AND orphan its un-kickable "Guest (2)" roster entry. hello.you (below) echoes the name back.
    if (mode === 'link') name = uniqueName(name, nameTaken);
    else if (ghost) name = ghost._name;        // reclaiming their own zombie's identity — exact same roster key, no "(2)"
    else if (back && back.name) name = back.name;
    else name = uniqueName(name, nameTaken);   // resume with NO grace record and NO superseded socket → still keep the roster unique rather than trusting the raw ?n=
    ws._name = name;
    if (mode === 'link') { const tok = newToken(); resumeTokens.set(tok, ws._ip || ''); ws._resume = tok; }
    else {
      // RESUME → ROTATE: a reconnect CONSUMES the presented token and mints a fresh single-use one bound to this
      // IP. The guest re-stores it from the hello below, so a token captured from the URL/history is useless the
      // moment the real guest reconnects with it (defense-in-depth atop the IP binding + 15s grace window).
      resumeTokens.delete(resumeTok);
      const tok = newToken(); resumeTokens.set(tok, ws._ip || ''); ws._resume = tok;
    }
    ws.binaryType = 'nodebuffer';
    ws._alive = true;
    ws.on('pong', () => { ws._alive = true; });   // heartbeat: the client answered our ping → still connected
    clients.add(ws);
    // Peer-id. This is a PERSON id, not a socket id — every audio frame is tagged `from: <pid>`, voiceMembers()
    // reports it, and both the guest and the host key their per-person volume slider on it. So a RESUME must
    // inherit the pid the same person was using: from the zombie it just superseded, or from its grace record.
    // It used to mint a fresh 'g<n>' on every socket while calling itself "stable", so a single WiFi blip
    // silently reset everyone's carefully-set volume for that person — and voice-core.js's `volume` map, which
    // is deliberately kept across a rejoin ("levels survive a rejoin"), accumulated a dead entry per reconnect.
    // Aliasing consequence, handled in drop(): a superseded socket must NOT evict the successor that now owns
    // its pid. A fresh pid is minted only for someone genuinely new.
    ws._pid = (ghost && ghost._pid) || (back && back.pid) || ('g' + (++pidSeq));
    byPid.set(ws._pid, ws);
    // Returning from a transient drop within the grace window → cancel the pending "left" and restore voice.
    if (back) { clearTimeout(back.timer); pendingDrops.delete(resumeTok); if (back.wasVoice) voiceGuests.add(ws._pid); }
    if (ghostVoice) voiceGuests.add(ws._pid);              // superseded socket was in voice → the successor stays in
    ws._presence = 'active'; roster.set(name, 'active');
    notifyGuests(); notifyRoster();
    if ((back && back.wasVoice) || ghostVoice) broadcastVoice();   // re-list them as a voice member under the new pid
    try {
      ws.send(JSON.stringify({ type: 'hello', readOnly, cols, rows, resume: ws._resume, host: hostName, you: name, workspaces, paused, pid: ws._pid, voice: voiceMembers(), appVersion: APP_VERSION }));   // appVersion: lets a joining cockpit SURFACE host/guest build skew instead of failing as a generic bad handle (native join across mismatched builds was undiagnosable)
      // Never replay status/scrollback/history while paused — the live workspace is private (belt-and-suspenders with the setPaused clear).
      if (!paused && lastStatus) ws.send(JSON.stringify({ type: 'status', status: lastStatus }));
      if (!paused && lastHistory.length) ws.send(JSON.stringify({ type: 'history', entries: lastHistory }));
      if (!paused && ring.length) ws.send(ring);
    } catch {}
    if (mode === 'link') systemChat(name + ' joined');   // only on a fresh join, not on reconnect
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg = null; try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg) return;
      if (msg.type === 'chat' && typeof msg.text === 'string') {     // allowed even read-only
        relayChat({ type: 'chat', role: 'guest', name: ws._name, text: msg.text.slice(0, 2000) }, ws);
        return;
      }
      if (msg.type === 'presence') {                                  // active (green) / idle = AFK (amber)
        ws._presence = (msg.state === 'idle') ? 'idle' : 'active';
        roster.set(ws._name, ws._presence); notifyRoster();
        return;
      }
      if (msg.type === 'switch' && typeof msg.id === 'string') {       // guest navigates to another GRANTED workspace
        if (readOnly) return;                                          // view-only guests can't drive navigation
        if (!workspaces.some((w) => w.id === msg.id)) return;          // never switch to a non-granted workspace
        try { onSwitchWorkspace && onSwitchWorkspace(msg.id); } catch {}
        return;
      }
      // Read-only browsing of a GRANTED workspace's saved sessions/transcripts. Allowed even for view-only
      // guests AND while paused — it reads saved text from SHARED workspaces only, and NEVER touches the live
      // terminal or a private workspace. Replies go only to THIS requesting guest.
      const sendBack = (p) => { if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(p)); } catch {} } };
      if (msg.type === 'ws-sessions' && typeof msg.id === 'string') {
        if (!workspaces.some((w) => w.id === msg.id)) return;          // only granted (shared) workspaces are browsable
        try { onBrowseSessions && onBrowseSessions(msg.id, sendBack); } catch {}
        return;
      }
      if (msg.type === 'ws-transcript' && typeof msg.id === 'string' && typeof msg.sid === 'string') {
        if (!workspaces.some((w) => w.id === msg.id)) return;          // gate to granted workspaces (transcripts can be sensitive)
        try { onBrowseTranscript && onBrowseTranscript(msg.id, msg.sid, sendBack); } catch {}
        return;
      }
      if (msg.type === 'input' && typeof msg.data === 'string') {
        if (readOnly || paused) return;   // paused = host on a private/non-granted workspace; never inject into it
        const data = stripCtrlV(msg.data);   // a raw ^V would paste the HOST's clipboard at the CLI — see stripCtrlV
        if (!data) return;
        try { onInput && onInput(data, { pid: ws._pid, name: ws._name }); } catch {}   // pass the typist's identity so session-history can attribute the prompt to the guest, not the host
        typistPing(ws._name, ws);         // label this guest's keystrokes for every OTHER viewer (the host UI learns via onInput)
        return;
      }
      // A guest's paste — THEIR clipboard text as one typed frame, kept off the keystroke channel so the
      // host can wrap it in bracketed-paste marks and sanitize it as a unit (see onPaste in main.js).
      if (msg.type === 'paste' && typeof msg.data === 'string') {
        if (readOnly || paused) return;              // same gate as keystrokes — paste IS typing
        if (msg.data.length > MAX_PASTE_CHARS) return;   // pathological payload; MAX_WS_PAYLOAD backstops the frame anyway
        try { onPaste && onPaste(msg.data, { pid: ws._pid, name: ws._name }); } catch {}
        typistPing(ws._name, ws);                    // a paste lights the typist chip like any other input
        return;
      }
      // ---- voice room (allowed even for VIEW-ONLY guests — talking is not terminal control) ----
      if (msg.type === 'voice-join') { voiceGuests.add(ws._pid); broadcastVoice(); return; }
      if (msg.type === 'voice-leave') { if (voiceGuests.delete(ws._pid)) broadcastVoice(); return; }
      // Server-relayed voice: fan a guest's audio frame out to the OTHER voice members + the host. Only voice
      // members may send/receive; nothing reaches a non-participant or a paused/non-shared workspace.
      if (msg.type === 'audio' && typeof msg.data === 'string') {
        if (!voiceGuests.has(ws._pid)) return;
        if (msg.data.length > MAX_AUDIO_B64) return;   // drop an oversized frame — amplification guard at the relay fan-out (a legit ~40ms block is far smaller)
        const aout = JSON.stringify({ type: 'audio', from: ws._pid, data: msg.data, sr: msg.sr });
        for (const c of clients) { if (c !== ws && voiceGuests.has(c._pid) && c.readyState === c.OPEN) { try { c.send(aout); } catch {} } }
        if (hostVoice) { try { onAudio && onAudio({ from: ws._pid, data: msg.data, sr: msg.sr }); } catch {} }
        return;
      }
    });
    const drop = () => {
      if (!clients.delete(ws)) return;
      // A SUPERSEDED socket handed its whole identity — name, peer-id, voice membership — to its successor back
      // in admit(). It owns nothing now. Deleting byPid[ws._pid] here would evict the LIVE socket that holds
      // that pid, and voiceGuests.delete(ws._pid) would drop the successor out of the voice room mid-call.
      // (Before pids were inherited this was merely redundant; now it would be destructive.)
      if (ws._superseded) { notifyGuests(); return; }   // no announce, no grace record — the roster entry belongs to the successor
      if (byPid.get(ws._pid) === ws) byPid.delete(ws._pid);
      const wasVoice = voiceGuests.delete(ws._pid);
      notifyGuests();
      const tok = ws._resume, who = ws._name;
      if (tok && !ws._kicked) {
        // Don't cry "left" the instant the socket closes — a backgrounded tab / locked phone reconnects with this
        // token. Show them amber ("away") and wait out the grace window; only a real, lasting departure announces.
        // (A host-KICKED guest skips this entirely — handled in the else: token killed, gone immediately.)
        roster.set(who, 'idle'); notifyRoster();
        const prev = pendingDrops.get(tok); if (prev) clearTimeout(prev.timer);
        const timer = setTimeout(() => {
          pendingDrops.delete(tok);
          resumeTokens.delete(tok);                       // truly left → kill the silent-reconnect token (no indefinite, approval-free rejoin)
          markGone(who); notifyRoster();
          systemChat(who + ' disconnected');
          if (wasVoice) broadcastVoice();
        }, REJOIN_GRACE);
        if (timer && timer.unref) timer.unref();
        pendingDrops.set(tok, { timer, wasVoice, name: who, pid: ws._pid });   // pid too: a resume inside the grace window is the same person, and must come back as the same voice peer
      } else {
        if (ws._kicked && tok) resumeTokens.delete(tok);   // kick → kill the resume token so they can't silently rejoin
        markGone(who); notifyRoster();
        systemChat(who + (ws._kicked ? ' was removed by the host' : ' disconnected'));
        if (wasVoice) broadcastVoice();
      }
    };
    ws.on('close', drop);
    ws.on('error', drop);
  }

  function onConnection(ws, mode, req) {
    const name = cleanName(paramFromUrl(req.url, 'n'), 'Guest');
    ws._ip = clientIp(req);   // bound to the resume token at mint; checked (fail-open) on a resume reconnect
    if (mode === 'resume') {
      const r = paramFromUrl(req.url, 'r');
      const boundIp = resumeTokens.get(r);   // wsAuth already matched r to a token, so this is its bound IP
      // FAIL-OPEN: only act when BOTH the bound and current IPs are known AND differ (a resume from a different
      // network — could be a replay, or simply a guest roaming cell↔wifi). When either is unknown, resume silently.
      if (boundIp && ws._ip && boundIp !== ws._ip) {
        // Don't SILENTLY rejoin from a new IP — but don't lock a roaming guest out either. Retire the stale token
        // and fall through to a normal join so the host just re-approves them (and they get a fresh IP-bound
        // token). Graceful degrade, not a dead-end — a replay attacker faces the same approval gate.
        resumeTokens.delete(r);
        mode = 'link';
      } else {
        return admit(ws, 'resume', name, r);
      }
    }
    // mode === 'link' (a new viewer joining the invite). Grace-window seats count as occupied — see admit().
    if (clients.size + pendingDrops.size >= MAX_GUESTS) {
      try { ws.send(JSON.stringify({ type: 'denied', reason: 'full' })); } catch {}
      try { ws.close(); } catch {}
      return;
    }
    if (!requireApproval) return admit(ws, 'link', name);
    if (pending.size >= MAX_PENDING) {   // lobby full of unapproved sockets → refuse rather than let an attacker hold unlimited pending slots
      try { ws.send(JSON.stringify({ type: 'denied', reason: 'busy' })); } catch {}
      try { ws.close(); } catch {}
      return;
    }
    const id = String(++pendingSeq);
    try { ws.send(JSON.stringify({ type: 'pending' })); } catch {}
    const finish = (ok) => {
      if (!pending.has(id)) return;
      clearTimeout(timer); pending.delete(id);
      if (ok) admit(ws, 'link', name);
      else { try { ws.send(JSON.stringify({ type: 'denied' })); } catch {} try { ws.close(); } catch {} }
    };
    const timer = setTimeout(() => finish(false), APPROVAL_TIMEOUT);
    pending.set(id, { ws, finish });
    ws.on('close', () => { if (!pending.has(id)) return; clearTimeout(timer); pending.delete(id); try { onApprovalCancel && onApprovalCancel(id); } catch {} });
    const info = { id, name, addr: (req && req.socket && req.socket.remoteAddress) || null };
    try { onApprovalRequest && onApprovalRequest(info, finish); } catch { finish(false); }
  }

  function decideApproval(id, ok) { const p = pending.get(id); if (!p) return false; p.finish(!!ok); return true; }

  function start(opts = {}) {
    if (server) return Promise.resolve(status());
    readOnly = !!opts.readOnly;
    requireApproval = opts.requireApproval !== false;
    hostName = cleanName(opts.name, 'Host');
    linkToken = newToken(); resumeTokens.clear();
    ring = Buffer.alloc(0); lastStatus = null; lastHistory = []; paused = false; workspaces = [];
    server = http.createServer((req, res) => {
      const u = (req.url || '').split('?')[0];
      if (u === '/' || u === '/index.html') {
        if (!pageAuthorized(req.url)) { res.writeHead(403); return res.end('forbidden'); }
        return serveFile(res, GUEST_HTML, 'text/html; charset=utf-8');
      }
      if (Object.prototype.hasOwnProperty.call(ASSETS, u)) return serveFile(res, ASSETS[u].file, ASSETS[u].type);
      res.writeHead(404); res.end('not found');
    });
    const { WebSocketServer } = require('ws');   // lazy: only when a share actually starts (keeps the module loadable without node_modules — see top-of-file note)
    wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });   // bound every incoming frame — the default 100 MiB is a main-loop-freeze DoS on an internet-facing socket
    server.on('upgrade', (req, socket, head) => {
      const mode = wsAuth(req.url);
      if (!mode) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, mode, req));
    });
    // Heartbeat: ping every client ~30s; one that didn't answer the previous ping (silent network drop, no clean
    // 'close') is terminated → that fires drop() → the grace-window "disconnected" announce. Without this, a dead
    // socket lingers until the OS/TCP eventually times it out, so chat would never show the disconnect.
    heartbeatTimer = setInterval(() => {
      for (const ws of clients) {
        if (ws.readyState !== ws.OPEN) continue;
        if (ws._alive === false) { try { ws.terminate(); } catch {} continue; }
        ws._alive = false;
        try { ws.ping(); } catch {}
      }
    }, HEARTBEAT_MS);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(status()); });
    });
  }

  // "New link" is a full ACCESS RESET, not a soft rotation: disconnect every current guest, revoke all reconnect
  // tokens + pending drops, then mint a fresh invite — so re-inviting genuinely locks out everyone who held the old
  // link. (Previously it kept old guests' tokens, letting a departed/denied guest silently rejoin via ?r=.)
  // Host kicks ONE guest by display name: deny + close their socket. drop() then kills their resume token and marks
  // them 'gone' immediately (no grace), so the kick sticks until they re-join through the link (host can also
  // regenerateLink to lock everyone out). Returns true if at least one matching connection was closed.
  function kickGuest(name) {
    const nm = String(name || '');
    let hit = false;
    for (const ws of clients) {
      if (ws._name === nm) {
        ws._kicked = true;
        // Revoke the resume token NOW, synchronously — do NOT wait for drop() on the socket 'close' event. A
        // server-initiated ws.close() waits up to ws's closeTimeout (~30s) for the client's close-ack; a hostile
        // guest that withholds it keeps this token valid and re-dials ?r=<token>, whose resume branch skips BOTH
        // approval and MAX_GUESTS — silently regaining access past the kick. Deleting here (mirrors the grace-window
        // path below) makes the reconnect's hasResume() fail immediately. drop()'s later delete becomes a no-op.
        if (ws._resume) { resumeTokens.delete(ws._resume); ws._resume = null; }
        try { ws.send(JSON.stringify({ type: 'denied', reason: 'removed' })); } catch {}
        try { ws.close(); } catch {}   // → drop(): roster 'gone', "removed by host" (token already revoked above)
        hit = true;
      }
    }
    // also evict a guest of that name still in the reconnect grace window (disconnected, token alive) so a
    // backgrounded tab can't silently rejoin past the kick.
    let graceKicked = false, graceVoice = false;
    for (const [tok, p] of Array.from(pendingDrops.entries())) {
      if (p && p.name === nm) { try { clearTimeout(p.timer); } catch {} if (p.wasVoice) graceVoice = true; pendingDrops.delete(tok); resumeTokens.delete(tok); markGone(nm); hit = true; graceKicked = true; }
    }
    if (graceKicked) { try { systemChat(nm + ' was removed by the host'); } catch {} }   // a guest kicked while in the reconnect grace window has no live socket, so drop()'s "removed by host" line never fires — announce it here for parity
    if (graceVoice) { try { broadcastVoice(); } catch {} }   // …and if they were a voice member when they dropped, refresh the voice roster so they don't linger in it (pre-existing gap: drop()'s own branches do this, the grace-kick path didn't)
    if (hit) notifyRoster();
    return hit;
  }
  function regenerateLink() {
    if (!server) return null;
    for (const ws of clients) { try { ws.send(JSON.stringify({ type: 'denied', reason: 'revoked' })); } catch {} try { ws.close(); } catch {} }
    clients.clear(); byPid.clear(); voiceGuests.clear(); roster.clear();
    for (const [, p] of pendingDrops) { try { clearTimeout(p.timer); } catch {} }
    pendingDrops.clear();
    // Drop anyone mid-approval on the OLD link too — else the host approving them later mints a fresh token. Each
    // entry's finish(false) clears its 90s timer, removes it from `pending`, and denies+closes the socket; then fire
    // onApprovalCancel explicitly to dismiss the host's stale prompt (the async ws 'close' handler can't — by the
    // time it runs, pending is already cleared, so it would skip the cancel).
    for (const [id, p] of Array.from(pending.entries())) { try { p.finish(false); } catch {} try { onApprovalCancel && onApprovalCancel(id); } catch {} }
    pending.clear();
    resumeTokens.clear();
    notifyGuests(); notifyRoster();
    try { broadcastVoice(); } catch {}                    // voice room is now empty → update the host's view
    linkToken = newToken();
    return linkToken;
  }

  function broadcast(data) {
    if (!server || paused) return;     // paused = host is in a private (non-granted) workspace: stream nothing, ring nothing
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    appendRing(buf);
    for (const ws of clients) { if (ws.readyState === ws.OPEN) { try { ws.send(buf); } catch {} } }
  }
  function setSize(c, r) {
    if (c) cols = c; if (r) rows = r;
    for (const ws of clients) { if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify({ type: 'size', cols, rows })); } catch {} } }
  }
  function broadcastStatus(s) {
    if (paused) return;                // don't leak a private workspace's tracker/session label
    lastStatus = s;
    for (const ws of clients) { if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify({ type: 'status', status: s })); } catch {} } }
  }
  // Host moved to a private/granted workspace → tell guests to freeze/unfreeze the mirror.
  // Pausing CLEARS the ring + lastStatus so a now-private workspace's scrollback/label can never
  // replay to a guest who joins later (the single choke point for setShared / syncShare / start / respawn).
  // The private workspace NAME is deliberately NOT broadcast (guests show a generic "private" message).
  function setPaused(p) {
    paused = !!p;
    if (paused) { ring = Buffer.alloc(0); lastStatus = null; lastHistory = []; }   // history is per-workspace content, same privacy rule as scrollback/status
    const s = JSON.stringify({ type: 'paused', paused });
    for (const ws of clients) { if (ws.readyState === ws.OPEN) { try { ws.send(s); } catch {} } }
  }
  // Session-history over the live channel (SESSION-HISTORY.md: live-channel, not git). Same privacy model as
  // status/ring: cached for late joiners (replayed on admit), never sent or retained while paused. The host
  // pushes a full snapshot on share-start/foreground/toggle transitions and per-entry increments after that.
  function pushHistory(entries) {
    lastHistory = Array.isArray(entries) ? entries.slice(-200) : [];
    if (paused) { lastHistory = []; return; }
    const s = JSON.stringify({ type: 'history', entries: lastHistory });
    for (const ws of clients) { if (ws.readyState === ws.OPEN) { try { ws.send(s); } catch {} } }
  }
  function pushHistoryEntry(entry) {
    if (paused || !entry || typeof entry !== 'object' || !entry.id) return;
    const i = lastHistory.findIndex((e) => e && e.id === entry.id);   // an update (e.g. Stop-time file stats) replaces its entry
    if (i >= 0) lastHistory[i] = entry; else lastHistory.push(entry);
    if (lastHistory.length > 200) lastHistory = lastHistory.slice(-200);
    const s = JSON.stringify({ type: 'history-entry', entry });
    for (const ws of clients) { if (ws.readyState === ws.OPEN) { try { ws.send(s); } catch {} } }
  }
  // Push the granted workspace library (stripped to {id,label,kind,live}) to guests.
  function setWorkspaces(list) {
    workspaces = Array.isArray(list) ? list : [];
    const s = JSON.stringify({ type: 'workspaces', list: workspaces });
    for (const ws of clients) { if (ws.readyState === ws.OPEN) { try { ws.send(s); } catch {} } }
  }
  function broadcastChat(text) { relayChat({ type: 'chat', role: 'host', name: hostName, text: String(text).slice(0, 2000) }, null); }

  function resetRing() { ring = Buffer.alloc(0); }
  function resetStatus() { lastStatus = null; }

  function stop() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    for (const [, p] of pending) { try { p.ws.close(); } catch {} }
    pending.clear();
    for (const ws of clients) { try { ws.close(); } catch {} }
    clients.clear(); roster.clear(); notifyGuests(); notifyRoster();
    try { wss && wss.close(); } catch {}
    try { server && server.close(); } catch {}
    server = null; wss = null; port = null; ring = Buffer.alloc(0);
    linkToken = null; resumeTokens.clear(); paused = false; workspaces = [];
    byPid.clear(); voiceGuests.clear(); hostVoice = false; pidSeq = 0;
    for (const [, p] of pendingDrops) { try { clearTimeout(p.timer); } catch {} }
    pendingDrops.clear();
  }

  function status() {
    return { running: !!server, port, token: linkToken, readOnly, requireApproval, guests: clients.size, hostName };
  }

  return { start, stop, broadcast, broadcastStatus, broadcastChat, broadcastTypist, setSize, setPaused, setWorkspaces, pushHistory, pushHistoryEntry, resetRing, resetStatus, regenerateLink, kickGuest, decideApproval, status, hostVoiceSet, audioFromHost };
}

module.exports = { createShareServer, uniqueName, cleanName, stripCtrlV, sanitizePaste };
