'use strict';
// Main-process client for the presence relay (relay/worker.js): one WebSocket per shared repo, carrying
// ~300-byte "went live"/"ended" frames in <1s — the realtime layer on top of the authoritative git branch.
// HARD RULES this module lives by:
//   · Fire-and-forget: nothing here ever gates or delays the git path. If the relay is down, unset, or
//     rejects us, every publish/ensure is a cheap no-op and the polling path carries on alone.
//   · Git stays authoritative: inbound frames are merged into the last authoritative peers list purely as a
//     preview; the next beacon read overwrites wholesale. The relay never wins an argument with the branch.
// Connection lifecycle mirrors main.js's openLiveSocket (retry counter, 500ms×try backoff, 30s lifeline).
const crypto = require('crypto');

const DEFAULT_RELAY_URL = '';   // set to the https URL wrangler prints after deploying relay/ (auto-upgraded to wss) — until then the whole module is inert
const RELAY_URL = process.env.CLAUDIBLE_RELAY_URL || DEFAULT_RELAY_URL;

function roomKeyFor(owner, repo) {
  return crypto.createHash('sha256').update(String(owner).toLowerCase() + '/' + String(repo).toLowerCase()).digest('hex').slice(0, 20);
}

// Merge one relay frame into an authoritative peers list (pure — unit-tested). Presence is one blob per
// author, so frames key by LOGIN: 'live' replaces/inserts that author's entry, 'end' removes it. Foreign
// frame types change nothing. Always returns a NEW array (callers compare/paint by reference downstream).
function mergePeerFrame(list, frame) {
  const base = Array.isArray(list) ? list : [];
  if (!frame || typeof frame.login !== 'string' || !frame.login) return base.slice();
  const rest = base.filter((p) => p && p.login !== frame.login);
  if (frame.type === 'end') return rest;
  if (frame.type !== 'live' || typeof frame.session !== 'string') return base.slice();
  const peer = { login: frame.login, session: frame.session, name: frame.name || '', ts: frame.ts || 0 };
  if (frame.starting === true) peer.starting = true;
  if (frame.url) peer.url = frame.url;
  if (frame.token) peer.token = frame.token;
  if (frame.sha) peer.sha = frame.sha;
  rest.push(peer);
  return rest;
}

// Reconcile a fresh AUTHORITATIVE (git) peers list against the previously-shown one (pure — unit-tested).
// Git wins by default; the exception is a per-login entry whose previous ts is STRICTLY newer — that entry
// came from a relay frame the branch hasn't propagated yet, and blind-overwriting it made a just-announced
// peer flicker to "gone" for up to a heartbeat (~45s) whenever an unrelated branch change raced the frame.
// An entry git dropped whose previous ts is NOT newer stays dropped (an ended session must disappear).
function reconcilePeerLists(fresh, prev) {
  const out = Array.isArray(fresh) ? fresh.slice() : [];
  for (const p of (Array.isArray(prev) ? prev : [])) {
    if (!p || !p.login) continue;
    const i = out.findIndex((f) => f && f.login === p.login);
    if (i === -1) { if ((p.ts || 0) > _maxTs(fresh)) out.push(p); continue; }   // absent from git but newer than the whole read → keep the relay's word for now
    if ((p.ts || 0) > (out[i].ts || 0)) out[i] = p;
  }
  return out;
}
function _maxTs(list) { let m = 0; for (const x of (list || [])) if (x && (x.ts || 0) > m) m = x.ts; return m; }

// makePresenceRelay({ getCred, onFrame, log }) — getCred: async () => ({login, token} | null);
// onFrame(repoStr, frame) fires for every validated inbound frame; log(msg) is the timing journal.
function makePresenceRelay({ getCred, onFrame, log }) {
  const note = typeof log === 'function' ? log : () => {};
  const conns = new Map();   // 'owner/repo' -> { ws, refs, retry, closed, timer, role }

  function enabled() { return !!RELAY_URL; }

  function dial(repoStr, rec) {
    if (!enabled() || rec.closed) return;
    let WebSocketC;
    try { ({ WebSocket: WebSocketC } = require('ws')); } catch { return; }   // no node_modules (CI) → inert
    const [owner, repo] = repoStr.split('/');
    const url = RELAY_URL.replace(/^http/, 'ws').replace(/\/$/, '') + '/room/' + roomKeyFor(owner, repo);
    let ws;
    try { ws = new WebSocketC(url, { handshakeTimeout: 8000, maxPayload: 64 * 1024 }); } catch { return arm(repoStr, rec); }
    rec.ws = ws; rec.role = '';
    ws.on('open', async () => {
      let cred = null;
      try { cred = await getCred(); } catch {}
      if (!cred || !cred.token) { try { ws.close(); } catch {} return; }   // no credential → retry later via close path
      try { ws.send(JSON.stringify({ type: 'hello', owner, repo, login: cred.login || '', token: cred.token, clientId: crypto.randomUUID() })); } catch {}
    });
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(String(data)); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.type === 'welcome') { rec.retry = 0; rec.role = String(m.role || ''); note(`relay: connected ${repoStr} as ${rec.role}`); return; }
      if (m.type === 'reject') { note(`relay: rejected ${repoStr} (${m.reason || '?'})`); rec.closed = true; try { ws.close(); } catch {} return; }   // no access won't fix itself by retrying — stay on the git path
      if (m.type === 'live' || m.type === 'end') { try { onFrame(repoStr, m); } catch {} }
    });
    const drop = () => { if (rec.ws === ws) { rec.ws = null; rec.role = ''; arm(repoStr, rec); } };
    ws.on('close', drop);
    ws.on('error', () => { try { ws.close(); } catch {} });
  }

  function arm(repoStr, rec) {
    if (rec.closed || rec.refs <= 0 || rec.timer) return;
    rec.retry = Math.min(rec.retry + 1, 60);
    const delay = rec.retry > 8 ? 30000 : 500 * rec.retry;   // openLiveSocket's shape: quick tries, then a 30s lifeline
    rec.timer = setTimeout(() => { rec.timer = null; dial(repoStr, rec); }, delay);
    if (rec.timer.unref) rec.timer.unref();
  }

  function ensure(owner, repo) {
    if (!enabled() || !owner || !repo) return;
    const key = owner + '/' + repo;
    let rec = conns.get(key);
    if (rec) { rec.refs++; return; }
    rec = { ws: null, refs: 1, retry: 0, closed: false, timer: null, role: '' };
    conns.set(key, rec);
    dial(key, rec);
  }

  function release(owner, repo) {
    const key = owner + '/' + repo;
    const rec = conns.get(key);
    if (!rec) return;
    if (--rec.refs > 0) return;
    rec.closed = true;
    if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
    try { rec.ws && rec.ws.close(); } catch {}
    conns.delete(key);
  }

  function publish(owner, repo, frame) {
    if (!enabled()) return;
    const rec = conns.get(owner + '/' + repo);
    if (!rec || !rec.ws || rec.role !== 'publisher') return;   // not connected/authorized (yet) — the git path carries it
    try { if (rec.ws.readyState === rec.ws.OPEN) rec.ws.send(JSON.stringify(frame)); } catch {}
  }

  return { enabled, ensure, release, publish };
}

module.exports = { makePresenceRelay, mergePeerFrame, reconcilePeerLists, roomKeyFor, RELAY_URL };
