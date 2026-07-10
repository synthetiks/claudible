// test/live-peers-scope.test.js — executes the REAL peersForWs() lifted out of renderer/app.js.
//
// livePeers is module-global, is never cleared on a workspace switch, and only ever holds peers for the project
// the last poll ran in. Rendered unfiltered, a repo project's live collaborator appeared as a "Live session" row
// inside a LOCAL project's sidebar until the next 10s poll tick — and clicking that ghost stamped the joined tab
// with the wrong project forever. peersForWs() is the single choke point every read now goes through; this proves
// it is a real filter (not a pass-through), and that an unstamped peer is inert rather than "probably fine".
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

// Real function, with `livePeers` bound to a scope we control.
const make = (peers) => new Function('livePeers', `${src}\nreturn peersForWs;`)(peers);

const REPO = 'repo-mk-crazy', LOCAL = 'local-scratch';
const peer = (session, wsId) => ({ session, wsId, url: 'https://x.trycloudflare.com', token: 't', ts: 1 });

// ---- the exact reported bug: a repo peer must be invisible from a LOCAL project --------------------------
{
  const livePeers = [peer('s-crazy', REPO)];
  const f = make(livePeers);
  eq('the repo project sees its own live peer', f(REPO).map((p) => p.session), ['s-crazy']);
  eq('the LOCAL project sees nothing (no phantom "Live session" row)', f(LOCAL), []);
  ok('…and the underlying list was NOT mutated (switching must not need a clear)', livePeers.length === 1);
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
