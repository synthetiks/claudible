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
// Comment-free views. The ORDERING assertions below cap the distance between two statements, and every one of
// them has broken at least once because an explanatory COMMENT grew between them — the code was always correct.
// Stripping comments first measures the thing the check is actually about. ([^:] keeps https:// intact.)
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const MAIN_NC = stripComments(MAIN), APP_NC = stripComments(APP);

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
// NOT gated on tunnelUp (two-phase advertise): the moment Share is clicked main stamps a url-less
// "going live…" presence; the full handle follows when the tunnel lands. The pin's real invariant is that
// advertise keys on the SHARED session (never the viewed one) — that part must never regress.
ok('app.js: updateAdvertise wants the SHARED session',
  /const want = \(aw && aw\.kind === 'repo' && sharedSessionId\) \? sharedSessionId : null;/.test(APP));
ok('app.js: sharedWsId is cleared everywhere sharedSessionId is',
  (APP.match(/sharedSessionId = null/g) || []).length === (APP.match(/sharedWsId = null/g) || []).length);

// ---- 5. source guards: privacy + tab semantics ----
// `movesShared` (was `sessionMoved`): the pinned tab is being re-pointed off the conversation guests are watching.
// It used to only PAUSE the mirror — and then kill the pty anyway. It now REFUSES, except for endShare (below).
ok('main.js: respawnPty detects the pinned tab leaving its session',
  /const onPinned = sharing && !!sharedTabId && tabId === sharedTabId;/.test(MAIN)
  && /const movesShared = !trusted && onPinned && !!rec && rec\.session !== \(session \|\| ''\);/.test(MAIN));
// The guard must NOT fire for the share's own machinery: a guest switching to another GRANTED workspace, and a
// Claude re-login restart, both legitimately pass session:'' on the pinned tab. Both ALSO carry guardBusy now:
// trusted-reroute exempts them from the moves-shared freeze, never from the mid-turn kill guard.
ok('main.js: a guest switching granted workspaces is a trusted reroute (never freezes the room) AND busy-guarded (never kills a mid-turn Claude)',
  /respawnPty\(target, '', \{ trustedReroute: true, guardBusy: true \}\)/.test(MAIN));
ok('main.js: restarting Claude for re-login is a trusted reroute AND busy-guarded',
  /respawnPty\(fgTabId, '', \{ trustedReroute: true, guardBusy: true \}\)/.test(MAIN));
ok('main.js: the guard only engages while a share is actually running',
  /const sharing = \(\(\) => \{ try \{ return !!share\.status\(\)\.running; \} catch \{ return false; \} \}\)\(\);/.test(MAIN));
// The one allowed reroute of the pinned tab (its workspace was deleted) freezes the mirror and keeps it frozen.
// freezeMirror is keyed on the PINNED tab, not on movesShared: a web-share pins whatever tab was foreground, and
// that tab's session can be '' — which makes movesShared false and would let syncShare stream the fallback project.
ok('main.js: the teardown freeze wipes the replay ring (no stale bytes for the next joiner)',
  /const freezeMirror = onPinned && endShare;\s*\n\s*if \(freezeMirror\) \{ try \{ share\.setPaused\(true\); share\.resetRing\(\); share\.resetStatus\(\);/.test(MAIN));
ok('main.js: syncShare cannot un-freeze the mirror',
  /if \(tabId === mirrorTabId\(\) && !freezeMirror\) syncShare\(\);/.test(MAIN));
ok('main.js: the workspace-granular pause never overrides the freeze',
  /share\.status\(\)\.running && !freezeMirror/.test(MAIN));
ok('main.js: workspace:delete freezes AND stops advertising before the respawn (covers a web-share pinned to a session-less tab)',
  /if \(sharedHere\) \{[\s\S]{0,700}?share\.setPaused\(true\); share\.resetRing\(\); share\.resetStatus\(\);[\s\S]{0,300}?stopAdvertising\(\);[\s\S]{0,300}?winSend\('share:force-end'/.test(MAIN_NC));
// …and syncShare() must NOT run in that branch: every tab already points at `fallback`, so it would re-derive the
// pause from a workspace the guests were never granted and un-freeze the mirror it just froze.
ok('main.js: workspace:delete skips syncShare when the shared tab is one of the moved ones',
  /\} else \{\s*\n\s*syncShare\(\);   \/\/ refresh the granted library for guests/.test(MAIN));
// Closing the shared tab is the OTHER way a live pty dies — respawnPty never sees it. Pausing alone left a zombie:
// tunnel up, host UI saying "live", guests frozen on a dead process.
ok('main.js: closing the shared tab ends the share for real (pause + stop advertising), not just pauses it',
  /if \(sharedTabId === tabId\) \{[\s\S]{0,300}?share\.setPaused\(true\); share\.resetRing\(\); share\.resetStatus\(\);[\s\S]{0,300}?stopAdvertising\(\);[\s\S]{0,300}?winSend\('share:force-end', \{ reason: 'tab-closed' \}\)/.test(MAIN));
ok('app.js: …and the host is asked first (the Command Center ✕ had no confirm at all)',
  /if \(tabId === sharedTabIdR && !confirm\(/.test(APP));
ok('main.js: the dead share:session-moved channel is gone (nothing moves the pinned tab any more)',
  !/share:session-moved/.test(MAIN) && !/onShareSessionMoved/.test(APP));
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
  /openSession\(next,[^\n]*\{ inPlace: true[,}]/.test(APP));
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

// ===========================================================================================================
// 3. THE LIVE SESSION IS NOT COLLATERAL — the class of navigation this spec originally missed.
//
// 2e2192a keyed the tunnel on the SHARED session, so `shareStop()` stopped firing on a sidebar click. But the
// tunnel staying up is not the same as the session staying alive: `respawnPty` KILLS the tab's pty. Its old
// guard paused the mirror (no foreign bytes leaked — that part worked) and then killed the conversation guests
// were watching anyway. `share.status().running` never flipped, and yet the live session was over.
//
// Only `openSession` avoided re-pointing the pinned tab. `switchWorkspace` — clicking a PROJECT chip, or an
// "out of sync" chip on another project's row (its handler switches workspace first) — went straight through.
// So did `workspace:create` and `workspace:adopt`. Modelled below against both the old and new predicates.
// ===========================================================================================================
// main.js respawnPty: does this call destroy the conversation guests are watching?
const killsLiveSession = (s) => {
  const trusted = !!s.trustedReroute, endShare = !!s.endShare;
  const movesShared = !trusted && s.sharing && !!s.sharedTabId && s.tabId === s.sharedTabId && !!s.rec && s.rec.session !== (s.session || '');
  if (movesShared && !endShare) return false;   // NEW: refused → the pty is never killed
  return true;                                  // the pty is killed and respawned
};
// the OLD predicate, for the record: it only ever paused, then killed regardless
const killsLiveSessionOld = () => true;

const shared = { tabId: 'T1', sharedTabId: 'T1', sharing: true, rec: { session: 'S1' } };
ok('respawn: re-pointing the pinned tab at another session is REFUSED',
  !killsLiveSession(Object.assign({}, shared, { session: 'S2' })));
ok('respawn: …and passing session:"" (workspace:open, create, adopt) is refused too',
  !killsLiveSession(Object.assign({}, shared, { session: '' })));
ok('respawn: …and session:"new" (workspace:create / adopt) is refused too',
  !killsLiveSession(Object.assign({}, shared, { session: 'new' })));
ok('respawn: the OLD code killed the live session in every one of those cases (the bug)',
  killsLiveSessionOld() && killsLiveSessionOld() && killsLiveSessionOld());
ok('respawn: a post-sync reload of the SAME session still respawns (never blocked)',
  killsLiveSession(Object.assign({}, shared, { session: 'S1' })));
ok('respawn: a guest switching granted workspaces is trusted and still respawns',
  killsLiveSession(Object.assign({}, shared, { session: '', trustedReroute: true })));
ok('respawn: deleting the live session\'s own workspace may proceed (endShare)',
  killsLiveSession(Object.assign({}, shared, { session: '', endShare: true })));
ok('respawn: an UNSHARED tab is untouched by any of this',
  killsLiveSession({ tabId: 'T2', sharedTabId: 'T1', sharing: true, rec: { session: 'S2' }, session: 'S3' }));
ok('respawn: not sharing at all → ordinary respawn',
  killsLiveSession({ tabId: 'T1', sharedTabId: null, sharing: false, rec: { session: 'S1' }, session: 'S2' }));

// renderer switchWorkspace: does a project click recycle the tab (killing what runs in it)?
const recyclesTab = (t, sharedTabIdR) => !(t.busy || t.tabId === sharedTabIdR);
ok('switchWorkspace: the live-shared tab is never recycled (opens a new tab instead)',
  !recyclesTab({ tabId: 'T1', busy: false }, 'T1'));
ok('switchWorkspace: a busy tab is still never recycled', !recyclesTab({ tabId: 'T2', busy: true }, 'T1'));
ok('switchWorkspace: an idle, unshared tab is recycled as before', recyclesTab({ tabId: 'T2', busy: false }, 'T1'));
ok('switchWorkspace: the OLD predicate recycled the shared tab (the bug)',
  ((t) => !t.busy)({ tabId: 'T1', busy: false }));

// The "out of sync" chip must not show on a LIVE session: `resolve remote` REPLACES the .jsonl that the host's
// Claude is appending to right now, and everyone in a live session is watching one pty byte-for-byte anyway.
const DEAD = new Set(['offline', 'denied']);
const sessionIsLive = (id, s) => !!id && (s.sharedSessionId === id
  || s.joined.some((r) => r.peer && r.peer.session === id && !DEAD.has(r.liveState))
  || s.livePeers.some((p) => p.session === id));
{
  const st = {
    sharedSessionId: 'MINE',
    joined: [{ peer: { session: 'JOINED' }, liveState: 'connected' }, { peer: { session: 'DEAD' }, liveState: 'offline' }],
    livePeers: [{ session: 'THEIRS' }],
  };
  ok('chip: hidden on the session I host', sessionIsLive('MINE', st));
  ok('chip: hidden on a session I joined', sessionIsLive('JOINED', st));
  ok('chip: hidden on a session a collaborator hosts', sessionIsLive('THEIRS', st));
  ok('chip: still shown on an ordinary diverged session', !sessionIsLive('QUIET', st));
  ok('chip: an empty id is never "live"', !sessionIsLive('', st));
  // A joined tab whose host ended their session lingers (reconcileJoinedTabs only auto-closes it while you're
  // viewing ITS project — see peerWsId). Keying liveness on the tab merely EXISTING hid that session's chip forever.
  ok('chip: a DEAD joined tab does not keep its session "live"', !sessionIsLive('DEAD', st));
  ok('chip: a reconnecting one still counts as live (transient)',
    sessionIsLive('BLIP', { sharedSessionId: null, joined: [{ peer: { session: 'BLIP' }, liveState: 'reconnecting' }], livePeers: [] }));
}

// deleteSession must prove the delete can succeed BEFORE tearing down the share. It used to clear sharedSessionId
// and drop the tunnel first, then hit the busy check and abort: guests disconnected, nothing deleted, and the
// "live session ended" toast overwritten by "that session is still running" (toast reuses one element).
const deleteSessionOrder = (owners, wasSharedTab) => {
  if (owners.some((r) => r.busy)) return { aborted: true, shareEnded: false };   // pre-flight, before any teardown
  const ordered = owners.filter((r) => r.tabId !== wasSharedTab).concat(owners.filter((r) => r.tabId === wasSharedTab));
  for (const rec of ordered) { if (rec.busy) return { aborted: true, shareEnded: false }; }
  return { aborted: false, shareEnded: wasSharedTab != null };
};
ok('delete: a busy owning tab aborts WITHOUT ending the share',
  (() => { const r = deleteSessionOrder([{ tabId: 'T1', busy: true }], 'T1'); return r.aborted && !r.shareEnded; })());
ok('delete: …even when a DIFFERENT tab is the busy one',
  (() => { const r = deleteSessionOrder([{ tabId: 'T2', busy: true }, { tabId: 'T1', busy: false }], 'T1'); return r.aborted && !r.shareEnded; })());
ok('delete: a clean delete ends the share', deleteSessionOrder([{ tabId: 'T1', busy: false }], 'T1').shareEnded);
ok('delete: deleting an unshared session never touches the share',
  !deleteSessionOrder([{ tabId: 'T2', busy: false }], null).shareEnded);
ok('delete: the SHARED tab is re-pointed last (so every abort leaves the live session intact)',
  (() => {
    const owners = [{ tabId: 'T1' }, { tabId: 'T2' }, { tabId: 'T3' }];   // T1 is the shared one, and it is FIRST here
    const ordered = owners.filter((r) => r.tabId !== 'T1').concat(owners.filter((r) => r.tabId === 'T1'));
    return ordered[ordered.length - 1].tabId === 'T1';
  })());

// ---- grep guards: pin all of the above to the real source ----
ok('main.js: respawnPty REFUSES the reroute instead of pausing-then-killing',
  /if \(movesShared && !endShare\) \{[\s\S]{0,300}?return false;/.test(MAIN));
{
  // …and it refuses BEFORE setGenBusy: the tab keeps running its turn, so its sync gate must stay closed.
  // Scope both searches to respawnPty's body — `setGenBusy(tabId, false)` also appears in earlier functions.
  const body = MAIN.indexOf('function respawnPty');
  ok('main.js: …and refuses BEFORE setGenBusy clears the running tab\'s sync gate',
    body > -1 && MAIN.indexOf('if (movesShared && !endShare)', body) < MAIN.indexOf('setGenBusy(tabId, false);', body));
}
// endShare reaches respawnPty from EXACTLY TWO places, and both are structural destruction of the shared thing:
// its workspace is deleted, or the session itself is. Matched on the CALL, not on the `opts.endShare:` line of prose
// that explains it (a doc comment satisfying a guard is how a guard rots — it happened twice while writing this).
ok('main.js: only a workspace/session deletion may end the share, and only for the pinned tab',
  (MAIN.match(/respawnPty\([^)]*endShare/g) || []).length === 2
  && /respawnPty\(tid, '', \{ guardBusy: true, endShare: tid === sharedTabId \}\)/.test(MAIN)          // workspace:delete
  && /respawnPty\(tabId, id, \{ guardBusy: true, endShare: !!endShare \}\)/.test(MAIN));               // session:open, only when deleteSession says so
ok('app.js: deleting the SHARED session re-points its pinned tab with endShare (else the delete self-aborts)',
  /const wasSharedTab = \(sharedSessionId === id\) \? sharedTabIdR : null;/.test(APP)
  && /\{ inPlace: true, endShare: rec\.tabId === wasSharedTab \}/.test(APP)
  && /claudible\.sessionOpen\(rec\.tabId, next, rec\.tabId === wasSharedTab\)/.test(APP));
{
  // …and it captures the pinned tab BEFORE clearing sharedSessionId (after, `sharedTabIdR` is still set but the
  // guard `sharedSessionId === id` is not — the flag would silently never be passed). Search FORWARD from the
  // capture: `sharedSessionId = null` appears in four other functions, and indexOf would find endLiveNow's first.
  const iCapture = APP.indexOf('const wasSharedTab = (sharedSessionId === id)');
  const iClear = iCapture > -1 ? APP.indexOf('sharedSessionId = null; sharedWsId = null;', iCapture) : -1;
  ok('app.js: …and captures the pinned tab BEFORE clearing sharedSessionId', iCapture > -1 && iClear > iCapture);
}
ok('app.js: an ordinary session click never passes endShare',
  /claudible\.sessionOpen\(t\.tabId, id, opts && opts\.endShare\)/.test(APP));
ok('main.js: …and tells the renderer to tear the tunnel down for real', /winSend\('share:force-end'/.test(MAIN));
ok('main.js: workspace:open reports a tab it declined to re-point', /return \{ ok: true, keptTab: !respawned \};/.test(MAIN));
// keptTab ("we refused") and superseded ("you're looking at another tab now") must never be conflated: a repo clone
// runs for minutes and a folder picker for as long as the user stares at it. Collapsing them let a slow create seize
// whatever tab was active on resolve, clear its terminal, and relabel it "New session".
ok('main.js: workspace:create distinguishes a refused re-point from a superseded one',
  /let keptTab = false, superseded = fgTabId !== targetTab;/.test(MAIN)
  && /resolve\(\{ ok: true, workspace: ws, keptTab, superseded \}\)/.test(MAIN));
ok('main.js: openWorkspaceInTab (adopt) does too',
  /if \(fgTabId !== targetTab\) return \{ keptTab: false, superseded: true \};/.test(MAIN)
  && /return \{ keptTab: !respawned, superseded: false \};/.test(MAIN));
ok('app.js: createWorkspace repaints NOTHING when superseded',
  /if \(r\.superseded \|\| r\.keptTab\) \{[\s\S]{0,300}?if \(r\.keptTab\) \{/.test(APP));
// switchWorkspace mutates the tab record optimistically (that's what makes the switch flicker-free). On a refusal
// the pty never moved, so the record has to go back — a tab claiming a workspace its process isn't in orphans the
// sidebar highlight forever. And its terminal must not be cleared for a switch that never happened.
ok('app.js: switchWorkspace rolls the tab record back when main keeps the tab',
  /const prev = \{ wsId: t\.wsId, session: t\.session, label: t\.label, curSessionLabel: t\.curSessionLabel, pendingTitle: t\.pendingTitle \};/.test(APP)
  // Deliberately NOT pinned to newBlankTab's ARGUMENT: what this check is about is the ORDER — the record must be
  // restored before a new tab is opened, because newBlankTab's setActiveTab repaints synchronously. Pinning the
  // arg made this fail the moment the session it opens changed (a project with sessions must not open a blank
  // draft), which is a different concern entirely.
  && /if \(kept\) \{[\s\S]{0,700}?Object\.assign\(t, prev\);[\s\S]{0,600}?newBlankTab\(id,/.test(APP_NC));   // comment-stripped + widened: the kept branch gained a dedupe (and its WHY) between the restore and the open — the ORDER this check pins is unchanged
ok('app.js: …and only resets the terminal for a switch that actually re-pointed the pty (a failed switch rolls the GLOBALS back too)',
  /if \(failed\) \{ rollBack\(\);[\s\S]{0,120}?return; \}/.test(APP)
  && APP.indexOf('const r = await claudible.workspaceOpen(id, sess);') < APP.indexOf('t.term.reset(); resetStats(t);')
  && /const rollBack = \(\) => \{[\s\S]{0,400}?activeWsId = prev\.wsId;/.test(APP));
ok('main.js: resolveDiverged refuses to overwrite a LIVE session\'s transcript',
  /if \(sid === liveSessionId\(\)\) return resolve\(\{ ok: false, error: 'live' \}\);/.test(MAIN));
ok('main.js: …and a mid-turn one', /rec\.session === sid && rec\.busy\) return resolve\(\{ ok: false, error: 'busy' \}\)/.test(MAIN));
ok('main.js: liveSessionId comes from the PINNED tab (covers a web-share with no sharedSessionId)',
  /function liveSessionId\(\)[\s\S]{0,260}?ptys\.get\(sharedTabId\)/.test(MAIN));
ok('app.js: switchWorkspace never recycles the live-shared tab',
  /if \(t\.busy \|\| t\.tabId === sharedTabIdR\) \{/.test(APP));
ok('app.js: createWorkspace/adopt open a new tab when main kept the current one',
  /if \(r\.keptTab\) \{[\s\S]{0,600}?newBlankTab\(newWsId, 'new'\)/.test(APP));
ok('app.js: the share ends in exactly one place, called only by End Session + force-end',
  /function endLiveNow\(msg\)/.test(APP)
  && (APP.match(/endLiveNow\(/g) || []).length === 3);   // definition + terminateLive + onShareForceEnd
ok('app.js: a host browsing elsewhere still sees their live session is running',
  /bar\.classList\.add\('elsewhere'\)/.test(APP) && /live-jump/.test(APP));
// The chip must ask about liveness in the ROW's OWN project (w && w.id): a tree row checked against the ACTIVE
// project's peer bucket found nothing and painted "out of sync" onto a session being hosted live on screen.
ok('app.js: the out-of-sync chip is suppressed on a live session — checked in the row’s own project',
  /\} else if \(s\.diverged && !sessionIsLive\(s\.id, w && w\.id\)\) \{/.test(APP));
// The peer-hosted arm reads peersForWs(wsId || activeWsId) — per-row scoping with the active bucket as the
// active-list default. An UNSCOPED livePeers.some let a repo project's live collaborator mark a LOCAL project's
// session as "live"; a HARDCODED activeWsId broke the suppression for every non-active tree row.
// contract.test.js check 12 owns the no-bare-reads invariant across the file; this pins sessionIsLive's shape.
ok('app.js: sessionIsLive covers hosted, joined, and peer-hosted sessions — scoped, and ignores dead joined tabs',
  /function sessionIsLive\(id, wsId\)[\s\S]{0,200}?sharedSessionId === id[\s\S]{0,700}?r\.peer\.session === id && !LIVE_DEAD\.has\(r\.liveState\)[\s\S]{0,400}?peersForWs\(wsId \|\| activeWsId\)\.some/.test(APP)
  && /const LIVE_DEAD = new Set\(\['offline', 'denied'\]\);/.test(APP));
// closeTab is reachable from the Command Center's always-visible "End this session" ✕ with zero other guard —
// killing a mid-turn Claude must never be silent. The confirm must sit BEFORE the actual tabClose IPC.
ok('app.js: closeTab confirms before killing a BUSY session (R1 — the last unguarded kill path)',
  /function closeTab\(tabId\) \{[\s\S]{0,1400}?rec\.busy && !confirm\([\s\S]{0,1600}?claudible\.tabClose\(tabId\)/.test(APP_NC));
// A JOINED session renders exactly once, sidebar-wide. The active list pins the joined row (its `shown` set);
// the expanded-tree renderer must consult the SAME authority (joinedTabSessionIds) and stand its saved copy
// down — this is the "I see the same live session twice" screenshot (joined row under the active project +
// the home tree's saved row with a live badge). Both join/leave transitions must repaint the trees, or the
// dedup only lands on the next unrelated refresh.
ok('app.js: a joined session renders once — the home tree stands down and repaints on join/leave',
  /const joined = joinedTabSessionIds\(\);/.test(APP)
  && /!joined\.has\(s\.id\) && \(\(s\.msgs \|\| 0\) > 0 \|\| hasExplicitTitle\(s\.id, w\.id\)\)/.test(APP)
  && /function joinedTabSessionIds\(\)[\s\S]{0,300}?r\.kind === 'live' && r\.peer && r\.peer\.session/.test(APP)
  && /refreshSessions\(\);[^\n]*\n\s*refreshExpandedTrees\(\);[^\n]*cross-project/.test(APP)
  && /if \(rec\.kind === 'live'\) refreshExpandedTrees\(\);/.test(APP));
// R6: reconcileWsChips only refills an EMPTY tree, so a tab switch off a joined tab must repaint the trees
// itself — `prev` is captured BEFORE activeTabId moves, and the refresh fires on live-tab transitions.
ok('app.js: switching off/onto a joined tab repaints the expanded trees (R6 — the vanishing joined row)',
  /function setActiveTab\(tabId\) \{[\s\S]{0,220}?const prev = tabs\.get\(activeTabId\);[\s\S]{0,3000}?\(prev\.kind === 'live' \|\| rec\.kind === 'live'\)\) refreshExpandedTrees\(\);/.test(APP_NC));
// Viewing a joined tab scopes the sidebar to its HOME project (peerWsId) — the pinned row used to land under
// whatever project happened to be active, so joining visually "moved" the session into an unrelated project
// (three sightings). main's activeWorkspace stays untouched (live tabs still skip tabForeground).
ok('app.js: the sidebar follows a joined tab to its home project',
  /const sideWs = rec\.wsId \|\| \(rec\.kind === 'live' && rec\.peerWsId\) \|\| null;/.test(APP)
  && /if \(sideWs && sideWs !== activeWsId\) \{ activeWsId = sideWs; primeSessionListForWs\(sideWs\)/.test(APP));
// The share is torn down only after every owning tab is confirmed off the doomed session.
ok('app.js: deleteSession pre-flights busy BEFORE touching the share',
  APP.indexOf('if (owners.some((r) => r.busy)) return abort();') > -1
  && APP.indexOf('if (owners.some((r) => r.busy)) return abort();') < APP.indexOf('// Every owning tab is off the doomed session'));
ok('app.js: …and re-points the SHARED tab last, so no abort can strand guests',
  /const ordered = owners\.filter\(\(r\) => r\.tabId !== wasSharedTab\)\.concat\(owners\.filter\(\(r\) => r\.tabId === wasSharedTab\)\);/.test(APP));
ok('app.js: …ending the share only once nothing can abort',
  /nothing can abort from here[\s\S]{0,350}?if \(sharedSessionId === id\) \{\s*\n\s*sharedSessionId = null; sharedWsId = null;/.test(APP));

// A JOINER clicking away must not lose their live tab either. `livePeers` is polled from the ACTIVE project's
// presence branch only, so while its owner browses another project the host is simply invisible to it — never
// "gone". Auto-leave has to be scoped to the workspace the peer was discovered on.
const autoLeaves = (rec, activeWsId, pollOk) => !!(pollOk && rec.peerWsId === activeWsId && ['offline', 'reconnecting'].includes(rec.liveState));
ok('joined: a reconnecting tab whose host really vanished is auto-left',
  autoLeaves({ peerWsId: 'wsA', liveState: 'reconnecting' }, 'wsA', true));
ok('joined: …but NOT while its owner is browsing another project (the peer list never saw that host)',
  !autoLeaves({ peerWsId: 'wsA', liveState: 'reconnecting' }, 'wsB', true));
ok('joined: …nor on a failed poll', !autoLeaves({ peerWsId: 'wsA', liveState: 'offline' }, 'wsA', false));
ok('joined: a healthy connected tab is never auto-left',
  !autoLeaves({ peerWsId: 'wsA', liveState: 'connected' }, 'wsA', true));
// Taken from the PEER, not from ambient activeWsId: a peer clicked from a stale row would otherwise permanently
// pin the joined tab to whatever project happened to be on screen.
ok('app.js: the joined tab records the workspace its host was discovered on (from the peer, not ambient state)',
  /rec\.peerWsId = peer\.wsId \|\| activeWsId;/.test(APP));
ok('app.js: …and auto-leave is scoped to it',
  /pollOk && rec\.peerWsId === activeWsId && LIVE_RECONNECTABLE\.has\(rec\.liveState\)/.test(APP));

console.log(`\ntabs-share: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
