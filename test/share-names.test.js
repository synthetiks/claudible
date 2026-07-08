// test/share-names.test.js — the live-share guest-name uniqueness fix.
//   Part A (pure): share/server.js `uniqueName(base, isTaken, max)` — the disambiguator that keeps the name-keyed
//     roster/kick/chat logic correct by making a colliding joiner's display name unique. This is where the
//     max-length bug lives (a full-length base would slice the suffix off), so it MUST be unit-tested directly.
//   Part B (integration): a real ws server — two guests who both join as "Guest" end up "Guest"/"Guest (2)", a
//     case-variant collides too, and a RESUME reconnect keeps its (already-unique) name untouched.
// Run: node test/share-names.test.js
'use strict';
const assert = require('assert');
const { uniqueName, cleanName } = require('../share/server.js');

let pass = 0, fail = 0;
function eq(label, a, b) { try { assert.strictEqual(a, b); pass++; } catch { fail++; console.error(`  FAIL ${label}\n    got: ${JSON.stringify(a)}\n    exp: ${JSON.stringify(b)}`); } }
function ok(label, c) { c ? pass++ : (fail++, console.error('  FAIL ' + label)); }

// case-insensitive "already present?" predicate — mirrors the server's real nameTaken (eqCI).
const mk = (names) => { const s = new Set(names.map((x) => String(x).toLowerCase())); return (n) => s.has(String(n).toLowerCase()); };

// ---- Part A: uniqueName (pure) ----
eq('no collision → base unchanged', uniqueName('Alice', mk([])), 'Alice');
eq('collision → (2)', uniqueName('Guest', mk(['Guest'])), 'Guest (2)');
eq('collision is case-insensitive', uniqueName('Guest', mk(['guest'])), 'Guest (2)');
eq('walks past taken suffixes (case-insensitive)', uniqueName('GUEST', mk(['Guest', 'Guest (2)'])), 'GUEST (3)');
eq('empty base → Guest fallback', uniqueName('', mk([])), 'Guest');
eq('empty base collides with a present Guest', uniqueName('', mk(['guest'])), 'Guest (2)');
eq('base is trimmed/cleaned before use', uniqueName('  Bob  ', mk([])), 'Bob');

// the bug the fix exists for: a base at the length cap must TRUNCATE to make room for the suffix, else the suffix
// is sliced off, the candidate == base (still taken), and the guarantee silently fails.
{
  const r = uniqueName('ABCDE', mk(['abcde']), 5);
  ok('max-len(5): result fits the cap', r.length <= 5);
  ok('max-len(5): result is actually free', !mk(['abcde'])(r));
  eq('max-len(5): truncates base to fit " (2)"', r, 'A (2)');
}
{
  const base = 'X'.repeat(40);                       // NAME_MAX-length base, taken
  const r = uniqueName(base, mk([base]), 40);
  ok('max-len(40): result fits the cap', r.length <= 40);
  ok('max-len(40): result is free', !mk([base])(r));
  ok('max-len(40): keeps a real suffix', /\s\(\d+\)$/.test(r));
}

// cleanName is exported for the integration side; a quick guard that it caps + strips as expected.
eq('cleanName removes control chars (no space inserted)', cleanName('x\x00y', 'Guest'), 'xy');
eq('cleanName collapses runs of spaces', cleanName('a  b   c', 'Guest'), 'a b c');
eq('cleanName empty → fallback', cleanName('   ', 'Guest'), 'Guest');

// ---- Part B: real ws server integration ----
const { createShareServer } = require('../share/server.js');
let WebSocket = null;
try { WebSocket = require('ws'); } catch { /* ws unavailable → skip integration, pure tests still gate */ }

function done() {
  console.log(`share-names: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (!WebSocket) { console.log('  (ws module unavailable — integration skipped)'); done(); }

// connect a guest; resolve with the `you` name from its hello (and stash its resume token).
function joinAndHello(port, cred) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?${cred}`);
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; try { ws.close(); } catch {} reject(new Error('hello timeout')); } }, 4000);
    ws.on('message', (data) => {
      let m = null; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m && m.type === 'hello' && !settled) { settled = true; clearTimeout(t); resolve({ ws, you: m.you, resume: m.resume, pid: m.pid }); }
    });
    ws.on('error', (e) => { if (!settled) { settled = true; clearTimeout(t); reject(e); } });
  });
}

(async () => {
  const srv = createShareServer({});                 // all callbacks optional
  let port, token;
  try {
    const st = await srv.start({ requireApproval: false, name: 'Host' });   // auto-admit → no approval wiring needed
    port = st.port; token = st.token;

    const a = await joinAndHello(port, `t=${token}&n=Guest`);
    eq('guest A keeps its name', a.you, 'Guest');

    const b = await joinAndHello(port, `t=${token}&n=Guest`);
    eq('guest B (same name) is disambiguated', b.you, 'Guest (2)');

    const c = await joinAndHello(port, `t=${token}&n=GUEST`);   // case-variant collides with BOTH A and B
    eq('guest C (case-variant) becomes (3)', c.you, 'GUEST (3)');

    ok('a fresh joiner is handed a resume token', !!b.resume);

    // Regression (adversarial review): a SUFFIXED guest that drops and reconnects re-sending its STALE original name
    // (native guests never re-send the host-assigned name) must be restored to its RESERVED name from the grace
    // record — NOT reverted to the colliding "Guest" (which would also orphan an un-kickable "Guest (2)" entry).
    const resumeB = b.resume;
    await new Promise((res) => { b.ws.on('close', res); try { b.ws.close(); } catch {} });
    await new Promise((res) => setTimeout(res, 120));           // let the server's drop() land (grace window reserves "Guest (2)")
    const b2 = await joinAndHello(port, `r=${encodeURIComponent(resumeB)}&n=Guest`);   // stale ?n= = "Guest"
    eq('resume restores the RESERVED suffixed name, not the stale ?n=', b2.you, 'Guest (2)');
    ok('guest A is unaffected by B reconnecting', a.you === 'Guest');

    // A resume with a valid token but NO grace record, while a socket holding that SAME token is still registered:
    // that's the same guest coming back before the heartbeat reaped their silently-dead socket (laptop sleep — the
    // "mk (2)" roster-ghost bug). The old socket is SUPERSEDED (closed 4001, silent drop) and the newcomer reclaims
    // the exact name — which still comes from the SERVER's record (ghost._name), never the raw ?n= (spoof-proof).
    const aClosed = new Promise((res) => a.ws.on('close', (code) => res(code)));
    const a3 = await joinAndHello(port, `r=${encodeURIComponent(a.resume)}&n=SPOOF`);   // A never dropped → no pendingDrop; hostile ?n= must be ignored
    eq('resume over a zombie socket reclaims the SAME name (no "(2)" ghost)', a3.you, 'Guest');
    eq('the superseded socket is closed with 4001 (so a live duplicate stands down instead of flapping)', await aClosed, 4001);

    try { c.ws.close(); b2.ws.close(); a3.ws.close(); } catch {}
  } catch (e) {
    fail++; console.error('  FAIL integration threw: ' + (e && e.message));
  } finally {
    try { srv.stop(); } catch {}
  }

  // ---- Part C: the roster is BOUNDED -------------------------------------------------------------------------
  // Every distinct display name that ever joined left a permanent 'gone' tombstone: the Map had no `delete` at all,
  // only the wholesale clear() in stop()/regenerateLink(). And notifyRoster re-broadcasts the WHOLE list to every
  // client on every change, so the per-message payload grew with it too — a long-lived public link with drive-by
  // joiners grew both without limit. Kicking marks 'gone' immediately (no grace window), so this drives it fast.
  const srv2 = createShareServer({ onRoster: (list) => { latest = list; } });
  let latest = [];
  try {
    const st2 = await srv2.start({ requireApproval: false, name: 'Host' });
    const N = 45;   // > ROSTER_MAX (32)
    for (let i = 0; i < N; i++) {
      const g = await joinAndHello(st2.port, `t=${st2.token}&n=G${i}`);
      const closed = new Promise((res) => g.ws.on('close', res));
      srv2.kickGuest(`G${i}`);          // → 'gone' immediately
      await closed;
    }
    ok(`the roster stays bounded after ${N} distinct guests came and went`, latest.length <= 32);
    ok('…the most recent departure is still listed', latest.some((m) => m.name === `G${N - 1}`));
    ok('…and the oldest tombstone was evicted', !latest.some((m) => m.name === 'G0'));
    ok('…every retained entry is a real roster row', latest.every((m) => m && typeof m.name === 'string' && typeof m.state === 'string'));
  } catch (e) {
    fail++; console.error('  FAIL roster-bound threw: ' + (e && e.message));
  } finally {
    try { srv2.stop(); } catch {}
  }

  // ---- Part D: the peer-id is a PERSON id, and survives a reconnect ------------------------------------------
  // `ws._pid` tags every audio frame (`from: <pid>`) and keys the listener's per-person volume in voice-core.js,
  // whose `leave()` deliberately keeps that map "so per-person levels survive a rejoin". They could not: the pid
  // was re-minted on EVERY socket — including a resume — so one WiFi blip silently reset how loud you hear someone,
  // and the map grew a dead entry per reconnect. The server called the field "stable peer-id for voice signaling".
  //
  // Making it genuinely stable creates an aliasing hazard the drop() guard exists for: after a SUPERSEDE, the
  // zombie's close fires drop() with the same pid the live successor now owns. Unguarded, that evicts the successor
  // from byPid and from the voice room, mid-call. Both halves are asserted here.
  // Capture EVERY voice-member list the server computes (broadcastVoice calls onVoiceMembers synchronously with
  // the same array). The regression is a duplicate id in the list broadcast DURING a supersede, while the ghost
  // is still in `clients` sharing the successor's pid — onVoiceMembers sees it without any socket-timing games.
  const allVoiceLists = [];
  const srv3 = createShareServer({ onVoiceMembers: (list) => allVoiceLists.push(list) });
  try {
    const st3 = await srv3.start({ requireApproval: false, name: 'Host' });
    const port3 = st3.port, tok3 = st3.token;

    // A message-waiter that survives the socket being handed around.
    const waitFor = (ws, pred, ms = 2500) => new Promise((res, rej) => {
      const t = setTimeout(() => { ws.off('message', h); rej(new Error('timeout waiting for ' + pred.name)); }, ms);
      function h(data) { let m = null; try { m = JSON.parse(data.toString()); } catch { return; } if (pred(m)) { clearTimeout(t); ws.off('message', h); res(m); } }
      ws.on('message', h);
    });
    const isAudio = (m) => m && m.type === 'audio';
    const voiceIds = (m) => (m.members || []).map((x) => x.id).sort();

    const A = await joinAndHello(port3, `t=${tok3}&n=Ann`);
    const B = await joinAndHello(port3, `t=${tok3}&n=Bob`);
    ok('a fresh joiner is handed a peer-id', !!A.pid && !!B.pid);
    ok('two different people get different peer-ids', A.pid !== B.pid);

    A.ws.send(JSON.stringify({ type: 'voice-join' }));
    const vm = await waitFor(B.ws, (m) => m && m.type === 'voice-members' && m.members.length === 1);
    ok('A appears in the voice roster under its peer-id', voiceIds(vm).includes(A.pid));
    B.ws.send(JSON.stringify({ type: 'voice-join' }));
    await waitFor(A.ws, (m) => m && m.type === 'voice-members' && m.members.length === 2);

    // Audio is tagged with the SENDER's pid — this is the key B's volume slider is stored under.
    const heard1 = waitFor(B.ws, isAudio);
    A.ws.send(JSON.stringify({ type: 'audio', data: 'AAAA', sr: 16000 }));
    eq("B hears A tagged with A's peer-id", (await heard1).from, A.pid);

    // --- 1. DROP + RESUME inside the grace window: same person, same peer-id ---
    const aTok = A.resume;
    await new Promise((res) => { A.ws.on('close', res); try { A.ws.close(); } catch {} });
    await new Promise((res) => setTimeout(res, 120));                        // let drop() land + reserve the grace record
    const A2 = await joinAndHello(port3, `r=${encodeURIComponent(aTok)}&n=Ann`);
    eq('a resume inside the grace window keeps the SAME peer-id', A2.pid, A.pid);
    eq('…and the same name', A2.you, 'Ann');
    const heard2 = waitFor(B.ws, isAudio);
    A2.ws.send(JSON.stringify({ type: 'audio', data: 'BBBB', sr: 16000 }));
    eq("…so B's per-person volume for A still applies (same `from` key)", (await heard2).from, A.pid);

    // --- 2. SUPERSEDE (laptop sleep: no FIN, the old socket is still registered) ---
    const a2Closed = new Promise((res) => A2.ws.on('close', (code) => res(code)));
    const A3 = await joinAndHello(port3, `r=${encodeURIComponent(A2.resume)}&n=Ann`);
    eq('a supersede reclaims the zombie’s peer-id', A3.pid, A.pid);
    eq('…and the zombie is closed 4001', await a2Closed, 4001);

    // --- 3. the drop() guard: the zombie's close must not evict its successor ---
    await new Promise((res) => setTimeout(res, 150));                        // give the ghost's drop() time to run
    const heard3 = waitFor(B.ws, isAudio);
    A3.ws.send(JSON.stringify({ type: 'audio', data: 'CCCC', sr: 16000 }));
    eq('the successor is STILL in the voice room after the zombie’s drop', (await heard3).from, A.pid);
    const heard4 = waitFor(A3.ws, isAudio);
    B.ws.send(JSON.stringify({ type: 'audio', data: 'DDDD', sr: 16000 }));
    eq('…and still RECEIVES relayed audio (voiceGuests kept its pid)', (await heard4).from, B.pid);
    ok('…and B was never disturbed', B.pid !== A.pid);

    // --- 3b. NO voice-member list the server ever computed listed the same person twice ---
    // The dup would appear in the list broadcast during A3's supersede admit(): clients then held BOTH the
    // closing ghost A2 and the successor A3, both carrying pid A.pid, both in voiceGuests. Without the
    // readyState===OPEN guard in voiceMembers(), that list is [Bob, Ann, Ann]. `.close()` sets CLOSING
    // synchronously, so the guard excludes the ghost the moment broadcastVoice runs.
    const dupList = allVoiceLists.find((list) => { const ids = list.map((x) => x.id); return new Set(ids).size !== ids.length; });
    ok('no voice-member list ever listed the same peer-id twice (supersede window)', !dupList, dupList && JSON.stringify(dupList));
    ok('…and the server DID broadcast voice lists during the run (guard is not vacuous)', allVoiceLists.length > 0);

    // --- 4. a genuinely new guest still gets a fresh id, never a recycled one ---
    const C = await joinAndHello(port3, `t=${tok3}&n=Cid`);
    ok('a brand-new guest gets a peer-id nobody holds', C.pid !== A.pid && C.pid !== B.pid);

    try { A3.ws.close(); B.ws.close(); C.ws.close(); } catch {}
  } catch (e) {
    fail++; console.error('  FAIL peer-id threw: ' + (e && e.message));
  } finally {
    try { srv3.stop(); } catch {}
    done();
  }
})();
