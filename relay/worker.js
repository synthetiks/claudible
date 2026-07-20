// Claudible presence relay — a Cloudflare Worker + Durable Object.
//
// One DO instance per shared repo ("room"), addressed by a client-computed sha256(owner/repo) so repo names
// never appear in edge logs/URLs. Collaborators' apps hold one WebSocket per shared repo; a host going
// live / ending fans out a ~300-byte presence frame to everyone else in well under a second. The relay is a
// DUMB PIPE with exactly one job and two hard rules:
//   · AUTH: on hello, the caller's GitHub token is checked once against the repo (permissions.push →
//     publisher, permissions.pull → subscriber, else reject). The token is used for that single read-only
//     call and never stored or logged.
//   · NON-AUTHORITY: the relay never decides who is live. Frames mirror what the git branch (the source of
//     truth) is being told in parallel; the login field is FORCED to the hello-verified login so nobody can
//     speak as someone else. Arbitration (one host per session) stays in the git path's live-holder.
// No storage is used; hibernation keeps idle rooms free. Deploy: `wrangler deploy` in this directory.
'use strict';

const MAX_FRAME = 2048;
const AUTH_TTL_MS = 10 * 60 * 1000;

async function sha20(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 20);
}

export default {
  async fetch(req, env) {
    const m = new URL(req.url).pathname.match(/^\/room\/([0-9a-f]{20})$/);
    if (!m) return new Response('not found', { status: 404 });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket only', { status: 426 });
    return env.PRESENCE_ROOM.get(env.PRESENCE_ROOM.idFromName(m[1])).fetch(req);
  },
};

export class PresenceRoom {
  constructor(state) {
    this.state = state;
    this.authCache = new Map();   // tokenHash -> { role, login, ts } — in-memory only; hibernation may drop it (fine: sockets re-auth only on reconnect, live sockets carry their role in the attachment)
  }

  async fetch(req) {
    const roomKey = new URL(req.url).pathname.split('/')[2];
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ authed: false, role: '', login: '', roomKey });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_FRAME) return;
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const att = ws.deserializeAttachment() || {};

    if (!att.authed) {
      if (msg.type !== 'hello' || typeof msg.owner !== 'string' || typeof msg.repo !== 'string' || typeof msg.token !== 'string') {
        try { ws.send(JSON.stringify({ type: 'reject', reason: 'bad-hello' })); } catch {}
        try { ws.close(1008, 'bad hello'); } catch {}
        return;
      }
      // The room key is client-derived — verify the hello names the SAME repo the socket connected to, so a
      // token valid for repo A can never authorize frames into repo B's room.
      const expect = await sha20(msg.owner.toLowerCase() + '/' + msg.repo.toLowerCase());
      if (expect !== att.roomKey) {
        try { ws.send(JSON.stringify({ type: 'reject', reason: 'room-mismatch' })); } catch {}
        try { ws.close(1008, 'room mismatch'); } catch {}
        return;
      }
      const verdict = await this.verify(msg.owner, msg.repo, msg.token);
      if (!verdict.role) {
        try { ws.send(JSON.stringify({ type: 'reject', reason: 'no-access' })); } catch {}
        try { ws.close(1008, 'no access'); } catch {}
        return;
      }
      ws.serializeAttachment({ authed: true, role: verdict.role, login: verdict.login, roomKey: att.roomKey });
      try { ws.send(JSON.stringify({ type: 'welcome', role: verdict.role })); } catch {}
      return;
    }

    // Authenticated traffic: publishers may broadcast live/end presence frames; everything else is dropped.
    if (att.role !== 'publisher') return;
    if (msg.type !== 'live' && msg.type !== 'end') return;
    if (typeof msg.session !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(msg.session)) return;
    const out = {
      type: msg.type,
      session: msg.session,
      login: att.login,                       // FORCED to the verified identity — the one field nobody may choose
      name: String(msg.name || '').slice(0, 40),
      ts: Math.floor(Date.now() / 1000),      // relay-stamped: client clocks don't get a vote
    };
    if (msg.type === 'live') {
      if (msg.starting === true) out.starting = true;
      if (typeof msg.url === 'string' && /^https:\/\/[A-Za-z0-9:/._-]+$/.test(msg.url) && msg.url.length < 200) out.url = msg.url;
      if (typeof msg.token === 'string' && /^[A-Za-z0-9._~-]{1,80}$/.test(msg.token)) out.token = msg.token;
      if (typeof msg.sha === 'string' && /^[0-9a-f]{1,12}$/.test(msg.sha)) out.sha = msg.sha;
      if (!out.starting && !(out.url && out.token)) return;   // a joinable claim needs a full handle; a phase-1 claim needs starting:true
    }
    const line = JSON.stringify(out);
    for (const peer of this.state.getWebSockets()) {
      if (peer === ws) continue;
      try { peer.send(line); } catch {}
    }
  }

  async webSocketClose() {}   // hibernation API manages the socket set; nothing to clean up (no storage, no roster)
  async webSocketError() {}

  async verify(owner, repo, token) {
    const th = await sha20('t:' + token);
    const hit = this.authCache.get(th);
    if (hit && Date.now() - hit.ts < AUTH_TTL_MS) return hit;
    let role = '', login = '';
    try {
      const r = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'claudible-presence-relay', Accept: 'application/vnd.github+json' },
      });
      if (r.ok) {
        const j = await r.json();
        const p = (j && j.permissions) || {};
        role = p.push ? 'publisher' : (p.pull ? 'subscriber' : '');
        if (role) {
          const u = await fetch('https://api.github.com/user', {
            headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'claudible-presence-relay', Accept: 'application/vnd.github+json' },
          });
          if (u.ok) login = String(((await u.json()) || {}).login || '');
          if (!login) role = '';               // no verified identity → no seat (login is what frames are forced to)
        }
      }
    } catch {}
    const verdict = { role, login, ts: Date.now() };
    this.authCache.set(th, verdict);
    if (this.authCache.size > 200) { const k = this.authCache.keys().next().value; this.authCache.delete(k); }
    return verdict;
  }
}
