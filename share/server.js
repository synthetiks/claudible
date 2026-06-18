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
//     minted its own private resume token (?r=) for silent reconnect/refresh. regenerateLink() rotates
//     the invite without dropping anyone.
//   • Names. Host names itself when sharing; each viewer names itself on join. Approvals and the chat
//     side-channel show those names, plus system "X joined / X left" lines. Chat never reaches Claude.
//   • read-only mode lets guests watch (and chat) but not type. A ring buffer replays recent output.
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const NM = path.join(__dirname, '..', 'node_modules');
const ASSETS = {
  '/xterm.js':     { file: path.join(NM, '@xterm/xterm/lib/xterm.js'),         type: 'text/javascript; charset=utf-8' },
  '/xterm.css':    { file: path.join(NM, '@xterm/xterm/css/xterm.css'),        type: 'text/css; charset=utf-8' },
  '/addon-fit.js': { file: path.join(NM, '@xterm/addon-fit/lib/addon-fit.js'), type: 'text/javascript; charset=utf-8' },
  '/guest.js':     { file: path.join(__dirname, 'guest.js'),                   type: 'text/javascript; charset=utf-8' },
  '/logo.png':     { file: path.join(__dirname, '..', 'assets', 'logo.png'),   type: 'image/png' },
};
const GUEST_HTML = path.join(__dirname, 'guest.html');
const RING_CAP = 256 * 1024;
const APPROVAL_TIMEOUT = 90000;
const MAX_GUESTS = 8;            // cap concurrent viewers (the host typically invites a few)
const NAME_MAX = 40;
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

// onInput(data) · onGuests(n) · onApprovalRequest({id,name,addr},fn) · onApprovalCancel(id)
// onChat({role,name,text})  — a guest chat OR a system join/left line, surfaced to the host UI
function createShareServer({ onInput, onGuests, onRoster, onApprovalRequest, onApprovalCancel, onChat, onSwitchWorkspace } = {}) {
  let server = null, wss = null, port = null, readOnly = false, requireApproval = true;
  let linkToken = null, hostName = 'Host';
  let cols = 120, rows = 32;
  let ring = Buffer.alloc(0);
  let lastStatus = null;
  let paused = false;            // host is in a NON-granted workspace → stream nothing to guests
  let workspaces = [];           // granted workspace library shown to guests: [{id,label,kind,live}]
  const clients = new Set();
  const resumeTokens = new Set();   // one private reconnect token per approved guest
  const pending = new Map();
  let pendingSeq = 0;

  const notifyGuests = () => { try { onGuests && onGuests(clients.size); } catch {} };
  // presence roster — name -> 'active'(green) | 'idle'(amber/AFK) | 'gone'(red, closed tab). 'gone' is kept so the
  // host can see who left; a resume reconnect flips it back to active.
  const roster = new Map();
  const notifyRoster = () => { try { onRoster && onRoster(Array.from(roster, ([name, state]) => ({ name, state }))); } catch {} };
  function appendRing(buf) {
    ring = ring.length ? Buffer.concat([ring, buf]) : Buffer.from(buf);
    if (ring.length > RING_CAP) ring = ring.slice(ring.length - RING_CAP);
  }
  function hasResume(r) { if (!r) return false; for (const t of resumeTokens) { if (safeEqual(r, t)) return true; } return false; }

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

  // Start streaming to a guest. Fresh 'link' joins mint a private resume token + announce them.
  function admit(ws, mode, name, resumeTok) {
    if (ws.readyState !== ws.OPEN) return;
    ws._name = name;
    if (mode === 'link') { const tok = newToken(); resumeTokens.add(tok); ws._resume = tok; }
    else { ws._resume = resumeTok; }
    ws.binaryType = 'nodebuffer';
    clients.add(ws);
    ws._presence = 'active'; roster.set(name, 'active');
    notifyGuests(); notifyRoster();
    try {
      ws.send(JSON.stringify({ type: 'hello', readOnly, cols, rows, resume: ws._resume, host: hostName, you: name, workspaces, paused }));
      // Never replay status/scrollback while paused — the live workspace is private (belt-and-suspenders with the setPaused clear).
      if (!paused && lastStatus) ws.send(JSON.stringify({ type: 'status', status: lastStatus }));
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
      if (msg.type === 'input' && typeof msg.data === 'string') {
        if (readOnly) return;
        try { onInput && onInput(msg.data); } catch {}
      }
    });
    const drop = () => { if (clients.delete(ws)) { roster.set(ws._name, 'gone'); notifyGuests(); notifyRoster(); systemChat(ws._name + ' left'); } };
    ws.on('close', drop);
    ws.on('error', drop);
  }

  function onConnection(ws, mode, req) {
    const name = cleanName(paramFromUrl(req.url, 'n'), 'Guest');
    if (mode === 'resume') return admit(ws, 'resume', name, paramFromUrl(req.url, 'r'));
    // mode === 'link' (a new viewer joining the invite)
    if (clients.size >= MAX_GUESTS) {
      try { ws.send(JSON.stringify({ type: 'denied', reason: 'full' })); } catch {}
      try { ws.close(); } catch {}
      return;
    }
    if (!requireApproval) return admit(ws, 'link', name);
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
    ring = Buffer.alloc(0); lastStatus = null; paused = false; workspaces = [];
    server = http.createServer((req, res) => {
      const u = (req.url || '').split('?')[0];
      if (u === '/' || u === '/index.html') {
        if (!pageAuthorized(req.url)) { res.writeHead(403); return res.end('forbidden'); }
        return serveFile(res, GUEST_HTML, 'text/html; charset=utf-8');
      }
      if (Object.prototype.hasOwnProperty.call(ASSETS, u)) return serveFile(res, ASSETS[u].file, ASSETS[u].type);
      res.writeHead(404); res.end('not found');
    });
    wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const mode = wsAuth(req.url);
      if (!mode) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, mode, req));
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(status()); });
    });
  }

  function regenerateLink() { if (!server) return null; linkToken = newToken(); return linkToken; }   // rotate invite; keeps current guests

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
    if (paused) { ring = Buffer.alloc(0); lastStatus = null; }
    const s = JSON.stringify({ type: 'paused', paused });
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
    for (const [, p] of pending) { try { p.ws.close(); } catch {} }
    pending.clear();
    for (const ws of clients) { try { ws.close(); } catch {} }
    clients.clear(); roster.clear(); notifyGuests(); notifyRoster();
    try { wss && wss.close(); } catch {}
    try { server && server.close(); } catch {}
    server = null; wss = null; port = null; ring = Buffer.alloc(0);
    linkToken = null; resumeTokens.clear(); paused = false; workspaces = [];
  }

  function status() {
    return { running: !!server, port, token: linkToken, readOnly, requireApproval, guests: clients.size, hostName };
  }

  return { start, stop, broadcast, broadcastStatus, broadcastChat, setSize, setPaused, setWorkspaces, resetRing, resetStatus, regenerateLink, decideApproval, status };
}

module.exports = { createShareServer };
