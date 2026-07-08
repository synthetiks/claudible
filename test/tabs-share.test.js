// test/tabs-share.test.js — guards the two invariants behind "sessions are independent tabs":
//
//   1. LIVE-SHARE SURVIVAL. Sharing is a property of the PINNED tab (main's sharedTabId), not of whatever the
//      host is looking at. Every tab switch runs setActiveTab → refreshSessions → updateCollab → ensureTunnel,
//      so keying `collabLive`/`want` on the VIEWED session made an ordinary sidebar click call shareStop() —
//      which closes every guest socket. The model below reproduces that bug against the OLD predicate and
//      proves the NEW one (keyed on sharedSessionId + sharedWsId) keeps guests connected.
//
//   2. PRIVACY. Re-pointing the pinned tab onto another conversation must never tee the new session's bytes to
//      guests (respawnPty's sessionMoved guard pauses the mirror first).
//
// The renderer is a single non-modular script, so the predicates are mirrored here as pure functions AND
// pinned to the real source with grep guards — a refactor that changes the source shape fails the guard rather
// than silently drifting from this spec. Run: node test/tabs-share.test.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (label, c) => c ? pass++ : (fail++, console.error('  FAIL ' + label));

// ---- the two predicates, mirrored from renderer/app.js (updateCollab / updateAdvertise) ----
// OLD (buggy): tunnel wanted only while VIEWING the shared session, in the VIEWED workspace.
const collabLiveOld = (s, wsOf) => { const aw = wsOf(s.activeWsId); return !!(aw && aw.kind === 'repo' && s.activeSession && s.activeSession === s.sharedSessionId); };
// NEW: tunnel wanted whenever a session is shared, evaluated in the SHARED workspace.
const collabLiveNew = (s, wsOf) => { const aw = wsOf(s.sharedWsId || s.activeWsId); return !!(aw && aw.kind === 'repo' && s.sharedSessionId); };

// Minimal host model: share a session, then navigate. `shareStops` counts guest-killing teardowns.
function host(predicate) {
  const WS = { wsA: { id: 'wsA', kind: 'repo' }, wsB: { id: 'wsB', kind: 'local' }, wsC: { id: 'wsC', kind: 'repo' } };
  const s = { activeSession: null, activeWsId: null, sharedSessionId: null, sharedWsId: null,
    tunnelUp: false, webShare: false, guests: 0, shareStops: 0, advertised: null };
  const wsOf = (id) => WS[id];
  const advertise = () => {
    const aw = wsOf(predicate === collabLiveNew ? (s.sharedWsId || s.activeWsId) : s.activeWsId);
    const want = predicate === collabLiveNew
      ? ((s.tunnelUp && aw && aw.kind === 'repo' && s.sharedSessionId) ? s.sharedSessionId : null)
      : ((s.tunnelUp && aw && aw.kind === 'repo' && s.activeSession && s.activeSession === s.sharedSessionId) ? s.activeSession : null);
    s.advertised = want;
  };
  const ensureTunnel = () => {
    const want = s.webShare || predicate(s, wsOf);
    if (want !== s.tunnelUp) {
      if (want) s.tunnelUp = true;
      else { s.tunnelUp = false; s.shareStops++; s.guests = 0; }   // shareStop() force-closes every guest socket
    }
    advertise();
  };
  return {
    s,
    share(sess, ws) { s.sharedSessionId = sess; if (predicate === collabLiveNew) s.sharedWsId = ws; s.activeSession = sess; s.activeWsId = ws; ensureTunnel(); s.guests = 2; },
    view(sess, ws) { s.activeSession = sess; s.activeWsId = ws; ensureTunnel(); },   // setActiveTab → refreshSessions → updateCollab
    stop() { s.sharedSessionId = null; s.sharedWsId = null; ensureTunnel(); },
  };
}

// ---- 1. the bug the fix exists for: it MUST still reproduce against the old predicate ----
{
  const h = host(collabLiveOld);
  h.share('sessX', 'wsA');
  ok('old predicate: sharing brings the tunnel up with guests', h.s.tunnelUp && h.s.guests === 2);
  h.view('sessY', 'wsA');
  ok('old predicate REPRODUCES the bug: a session switch stops the share', !h.s.tunnelUp && h.s.shareStops === 1 && h.s.guests === 0);
}

// ---- 2. the fix: guests survive every kind of navigation ----
{
  const h = host(collabLiveNew);
  h.share('sessX', 'wsA');
  h.view('sessY', 'wsA');
  ok('new: guests survive switching to another session in the SAME project', h.s.tunnelUp && h.s.shareStops === 0 && h.s.guests === 2);
  ok('new: still advertising the SHARED session, not the viewed one', h.s.advertised === 'sessX');
}
{
  const h = host(collabLiveNew);
  h.share('sessX', 'wsA');
  h.view('sessZ', 'wsB');   // a LOCAL (non-repo) workspace — the old predicate's other failure mode
  ok('new: guests survive switching to a non-repo project', h.s.tunnelUp && h.s.shareStops === 0 && h.s.guests === 2);
  ok('new: advertise unaffected by the viewed workspace', h.s.advertised === 'sessX');
}
{
  const h = host(collabLiveNew);
  h.share('sessX', 'wsA');
  h.view('sessQ', 'wsC');
  ok('new: guests survive switching to another repo project', h.s.tunnelUp && h.s.guests === 2);
}

// ---- 3. no regression: an explicit stop still tears the tunnel down ----
{
  const h = host(collabLiveNew);
  h.share('sessX', 'wsA'); h.view('sessY', 'wsA'); h.stop();
  ok('new: "stop sharing" still drops the tunnel + guests', !h.s.tunnelUp && h.s.shareStops === 1 && h.s.guests === 0);
  ok('new: "stop sharing" unadvertises', h.s.advertised === null);
}
{
  const h = host(collabLiveNew);
  h.view('sessX', 'wsA');
  ok('new: merely browsing a repo session never opens a tunnel', !h.s.tunnelUp && h.s.advertised === null);
}

// ---- 4. source guards: the shipped predicates must stay keyed on the SHARED session ----
ok('app.js: collabLive keys on sharedSessionId (not activeSession)',
  /collabLive = !!\(aw && aw\.kind === 'repo' && sharedSessionId\)/.test(APP));
ok('app.js: updateCollab resolves the workspace from sharedWsId',
  /function updateCollab\(\)[\s\S]{0,900}?workspaces\.find\(\(w\) => w\.id === \(sharedWsId \|\| activeWsId\)\)/.test(APP));
ok('app.js: updateAdvertise wants the SHARED session',
  /const want = \(tunnelUp && aw && aw\.kind === 'repo' && sharedSessionId\) \? sharedSessionId : null;/.test(APP));
ok('app.js: sharedWsId is cleared everywhere sharedSessionId is',
  (APP.match(/sharedSessionId = null/g) || []).length === (APP.match(/sharedWsId = null/g) || []).length);

// ---- 5. source guards: privacy + tab semantics ----
ok('main.js: respawnPty pauses the mirror when the pinned tab leaves its session',
  /const sessionMoved = !trusted && sharing && sharedTabId && tabId === sharedTabId && rec && rec\.session !== \(session \|\| ''\);/.test(MAIN));
// The pause must NOT fire for the share's own machinery: a guest switching to another GRANTED workspace, and a
// Claude re-login restart, both legitimately pass session:'' on the pinned tab.
ok('main.js: a guest switching granted workspaces is a trusted reroute (never freezes the room)',
  /respawnPty\(target, '', \{ trustedReroute: true \}\)/.test(MAIN));
ok('main.js: restarting Claude for re-login is a trusted reroute',
  /respawnPty\(fgTabId, '', \{ trustedReroute: true \}\)/.test(MAIN));
ok('main.js: the "moved" toast only fires while a share is actually running',
  /const sharing = \(\(\) => \{ try \{ return !!share\.status\(\)\.running; \} catch \{ return false; \} \}\)\(\);/.test(MAIN));
ok('main.js: the sessionMoved pause wipes the replay ring (no stale bytes for the next joiner)',
  /if \(sessionMoved\)[\s\S]{0,240}?share\.setPaused\(true\); share\.resetRing\(\);/.test(MAIN));
ok('main.js: syncShare cannot un-pause a sessionMoved mirror',
  /if \(tabId === mirrorTabId\(\) && !sessionMoved\) syncShare\(\);/.test(MAIN));
ok('main.js: the workspace-granular pause never overrides the sessionMoved pause',
  /share\.status\(\)\.running && !sessionMoved/.test(MAIN));
// pendingTitle gets PERSISTED as the session's title once the id resolves; a resume that falls back to a fresh
// conversation would then be stamped with the clicked session's name. Assert no ASSIGNMENT inside the helper
// (the word appears in its explanatory comment, so match `pendingTitle =`, and strip comments first).
{
  const m = APP.match(/function openSessionInNewTab\([\s\S]*?\n}/);
  const body = m ? m[0].replace(/\/\/[^\n]*/g, '') : '';
  ok('app.js: openSessionInNewTab exists', !!m);
  ok('app.js: opening a saved session in a new tab never assigns pendingTitle (would mis-title a resume fallback)',
    !!m && !/pendingTitle\s*=/.test(body));
  ok('app.js: openSessionInNewTab still sets the display labels', /rec\.label = label; rec\.curSessionLabel = label;/.test(body));
}
ok('app.js: the shared tab is never recycled onto another session',
  /if \(!inPlace && t\.tabId === sharedTabIdR && id !== t\.session\)/.test(APP));
ok('app.js: deleteSession parks its tab on a session no other tab holds',
  /const next = order\.find\(\(x\) => !openElsewhere\.has\(x\)\) \|\| 'new';/.test(APP));
// Occupancy is keyed by SESSION, not tab identity — keying it on `tabId !== activeTabId` let a background tab be
// parked onto the ACTIVE tab's session, running two Claudes on one transcript.
ok('app.js: deleteSession excludes occupied sessions by session id, not by tab',
  /openElsewhere = new Set\(Array\.from\(tabs\.values\(\)\)\.filter\(\(r\) => r\.kind !== 'live' && r\.wsId === activeWsId && r\.session !== id\)/.test(APP));
// The pulse must reach a background tab living in a NON-active project (the new cross-project tab workflow).
ok('app.js: attention/busy helpers accept an explicit workspace',
  /function sessionNeedsAttention\(id, wsId\)/.test(APP) && /function sessionBusyInTab\(id, wsId\)/.test(APP));
ok('app.js: non-active project rows paint the busy dot + done pulse',
  /sessionBusyInTab\(s\.id, w\.id\) \? ' busy' : ''/.test(APP) && /sessionNeedsAttention\(s\.id, w\.id\) \? ' sess-done' : ''/.test(APP));
ok('app.js: markTabAttention can find a row inside an expanded project tree',
  /\.ws-children \.sess\[data-id="/.test(APP));
ok('app.js: clearTabAttention clears the DOM class unconditionally (refreshSessions can bail mid-rename/drag)',
  /function clearTabAttention\(tabId\) \{\s*\n\s*const rec = tabs\.get\(tabId\); if \(!rec\) return;/.test(APP));
ok('app.js: deleteSession re-points IN PLACE (never opens a new tab off a doomed session)',
  /openSession\(next,[^\n]*\{ inPlace: true \}\)/.test(APP));
ok('app.js: cross-project session clicks clone an invited repo before spawning a pty',
  /function openWsSessionInTab[\s\S]{0,600}?needsClone\) \{ openAcceptInviteModal\(w\); return; \}/.test(APP));
ok('app.js: a background tab finishing its turn raises the sidebar pulse',
  /if \(tabId !== activeTabId\) \{ t\.attention = true; markTabAttention\(t\.tabId, true\); \}/.test(APP));
ok('app.js: the pulse survives a full sidebar rebuild (painted from the tab record)',
  /sessionNeedsAttention\(s\.id\) \? ' sess-done' : ''/.test(APP));
ok('app.js: activating a tab clears its pulse', /rec\.attention = false;/.test(APP) && /clearTabAttention\(tabId\);/.test(APP));
// collabLive is now view-independent, so the "● Live" bar must be gated on actually VIEWING the shared tab —
// otherwise it claims an unrelated conversation is being shared.
ok('app.js: the live bar only paints on the shared tab (or a joined mirror)',
  /const onSharedTab = !!\(t && t\.kind !== 'live' && \(\(sharedTabIdR != null && t\.tabId === sharedTabIdR\)/.test(APP)
  && /if \(!\(collabLive && onSharedTab\) && !liveTab\)/.test(APP));
// Deleting the shared session must end the share, not leave a frozen tunnel pinned to a dead conversation.
ok('app.js: deleting the shared session ends the share first',
  /if \(sharedSessionId === id\) \{\s*\n\s*sharedSessionId = null; sharedWsId = null;/.test(APP));

console.log(`\ntabs-share: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
