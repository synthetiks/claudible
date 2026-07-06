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
      if (m && m.type === 'hello' && !settled) { settled = true; clearTimeout(t); resolve({ ws, you: m.you, resume: m.resume }); }
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
    done();
  }
})();
