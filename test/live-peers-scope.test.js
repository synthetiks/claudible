// test/live-peers-scope.test.js — executes the REAL peersForWs() lifted out of renderer/app.js.
//
// Live peers are cached PER WORKSPACE (livePeersByWs: wsId -> peers[]). Rendered unscoped, a repo project's live
// collaborator appeared as a "Live session" row inside a LOCAL project's sidebar — and clicking that ghost stamped
// the joined tab with the wrong project forever. peersForWs() is the single choke point every read goes through;
// this proves it is a real filter (bucket key + per-peer stamp), that an unstamped peer is inert rather than
// "probably fine", and that a session the joined socket proved dead (deadPeerSessions, Fix 3) is suppressed.
// Run: node test/live-peers-scope.test.js
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (label, c, extra) => { if (c) pass++; else { fail++; console.error('  FAIL ' + label + (extra ? '\n    ' + extra : '')); } };
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`);

const APP = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const src = (APP.match(/function peersForWs\(wsId\) \{.*\n?/) || [''])[0];
ok('peersForWs() found in app.js', !!src.trim());

// Real function, with the per-ws cache (a Map) + the dead-set bound to a scope we control. The test passes a flat
// array of peers for convenience; we bucket it by wsId exactly as pollLivePeers does.
const make = (peers, dead) => {
  const map = new Map();
  (peers || []).forEach((p) => { const k = p && p.wsId; if (!map.has(k)) map.set(k, []); map.get(k).push(p); });
  return new Function('livePeersByWs', 'deadPeerSessions', `${src}\nreturn peersForWs;`)(map, new Set(dead || []));
};

const REPO = 'repo-mk-crazy', LOCAL = 'local-scratch';
const peer = (session, wsId) => ({ session, wsId, url: 'https://x.trycloudflare.com', token: 't', ts: 1 });

// ---- the exact reported bug: a repo peer must be invisible from a LOCAL project --------------------------
{
  const f = make([peer('s-crazy', REPO)]);
  eq('the repo project sees its own live peer', f(REPO).map((p) => p.session), ['s-crazy']);
  eq('the LOCAL project sees nothing (no phantom "Live session" row)', f(LOCAL), []);
  eq('…repeated reads are stable (peersForWs is a pure read, not a mutation)', f(REPO).map((p) => p.session), ['s-crazy']);
}

// ---- Fix 3: a session the joined socket proved offline is suppressed even while git presence still lists it ---
{
  const f = make([peer('s-dead', REPO), peer('s-alive', REPO)], ['s-dead']);
  eq('a socket-proved-dead session is hidden from the badge immediately', f(REPO).map((p) => p.session), ['s-alive']);
}

// ---- two repos: peers never cross ---------------------------------------------------------------------------
{
  const f = make([peer('a', 'repo-a'), peer('b', 'repo-b'), peer('c', 'repo-a')]);
  eq('repo-a sees only its own', f('repo-a').map((p) => p.session), ['a', 'c']);
  eq('repo-b sees only its own', f('repo-b').map((p) => p.session), ['b']);
}

// ---- an UNSTAMPED peer is inert, never a wildcard -------------------------------------------------------------
// A pre-scoping build (or any future path that forgets to stamp) must degrade to "invisible", not "visible
// everywhere". Silence is the safe failure; a ghost row is not.
{
  const f = make([{ session: 'legacy', url: 'u', token: 't' }]);   // no wsId
  eq('an unstamped peer is not shown to any workspace', f(REPO), []);
  eq('…nor to a local one', f(LOCAL), []);
}

// ---- degenerate inputs: no wsId means no peers, never all peers ----------------------------------------------
{
  const f = make([peer('a', REPO)]);
  eq('undefined wsId → no peers (never a pass-through)', f(undefined), []);
  eq('null wsId → no peers', f(null), []);
  eq('empty-string wsId → no peers', f(''), []);
}
{
  const f = make([null, undefined, peer('good', REPO)]);
  eq('null/undefined entries are skipped, not thrown on', f(REPO).map((p) => p.session), ['good']);
}
{
  eq('empty list → empty', make([])(REPO), []);
}

// ---- the guard is a real filter: proven by a peer that would match on session id alone ------------------------
// Every unscoped read site matched on `p.session === id`. Same session id, wrong workspace ⇒ must not match.
{
  const f = make([peer('shared-id', REPO)]);
  const found = f(LOCAL).find((p) => p.session === 'shared-id');
  ok('a session-id match in the WRONG workspace is filtered out before any read site sees it', !found);
}

console.log(`\nlive-peers-scope: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
