// test/live-holder.test.js — the ONE-live-host-per-session claim arbiter. wsl/sessions-sync-tool.js
// `live-holder` reads the pulled worktree's live/*.json claims and decides whether presence-set may claim a
// session: it prints a complete already-live refusal line when another author holds a FRESH claim (and we
// don't win the race tie-break), or NOTHING when the claim may proceed. This is what makes "two people go
// live on the same session" impossible: the pre-write check refuses a second host outright, and the
// post-push-race re-check makes exactly ONE of two simultaneous claimants yield (deterministic: earlier ts
// wins, login ascending on a tie) — never both, never neither.
// Run: node test/live-holder.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const TOOL = path.join(__dirname, '..', 'wsl', 'sessions-sync-tool.js');

let pass = 0, fail = 0;
function ok(label, c) { c ? pass++ : (fail++, console.error('  FAIL ' + label)); }
function eq(label, a, b) { (a === b) ? pass++ : (fail++, console.error(`  FAIL ${label}\n    got: ${JSON.stringify(a)}\n    exp: ${JSON.stringify(b)}`)); }

const NOW = Math.floor(Date.now() / 1000);
const FRESH = NOW - 10, STALE = NOW - 400;   // TTL is 300s (matches the renderer's Join-badge filter)
const SKEWED = NOW + 4000;   // a machine whose clock is ~an hour fast (WSL2 after host sleep, a restored VM snapshot, or a hand-written blob — any peer with push access can write any author path)

// build a temp live/ dir from {author: claimObjOrRawString}, run the tool as `me` claiming `sid`.
function run(files, sid, me, extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-livehold-'));
  for (const [author, v] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, author + '.json'), typeof v === 'string' ? v : JSON.stringify(Object.assign({ login: author }, v)));
  }
  // Hermetic: strip any inherited CLAUDIBLE_NOW so the default cases age on the tool's own clock; a case that wants
  // to pin the injected clock passes it via extraEnv.
  const env = Object.assign({}, process.env, { CL_DIR: dir, CL_SID: sid, CL_ME: me });
  delete env.CLAUDIBLE_NOW;
  Object.assign(env, extraEnv || {});
  const r = spawnSync(process.execPath, [TOOL, 'live-holder'], { encoding: 'utf8', env });
  fs.rmSync(dir, { recursive: true, force: true });
  return (r.stdout || '').trim();
}
function refusal(out) { try { return JSON.parse(out); } catch { return null; } }

// ---- the core rule: a fresh rival claim refuses a newcomer ----
{
  const out = run({ daisy: { session: 's1', ts: FRESH, name: 'CrazyDev' } }, 's1', 'niburu');
  const r = refusal(out);
  ok('fresh rival claim → refusal line', !!r);
  eq('refusal is a presence-set result', r && r.op, 'presence-set');
  eq('refusal error is already-live', r && r.error, 'already-live');
  eq('refusal names the holder (display name)', r && r.by, 'CrazyDev');
  eq('refusal carries the holder login', r && r.login, 'daisy');
}
// ---- staleness: a crashed/sleeping host must not lock the session forever ----
eq('STALE rival claim → free to claim', run({ daisy: { session: 's1', ts: STALE, name: 'CrazyDev' } }, 's1', 'niburu'), '');
// ---- scoping: a rival live on a DIFFERENT session never blocks this one ----
eq('rival live on another session → free', run({ daisy: { session: 's2', ts: FRESH } }, 's1', 'niburu'), '');
// ---- self: my own fresh claim is the heartbeat re-stamping, never a refusal ----
eq('my own fresh claim → proceed (heartbeat)', run({ niburu: { session: 's1', ts: FRESH } }, 's1', 'niburu'), '');
// ---- the push race: both fresh → deterministic single winner ----
eq('race, my ts EARLIER → I win (proceed)', run({ niburu: { session: 's1', ts: FRESH - 5 }, daisy: { session: 's1', ts: FRESH } }, 's1', 'niburu'), '');
{
  const out = run({ niburu: { session: 's1', ts: FRESH }, daisy: { session: 's1', ts: FRESH - 5, name: 'CrazyDev' } }, 's1', 'niburu');
  eq('race, my ts LATER → I yield', (refusal(out) || {}).error, 'already-live');
}
{
  // equal ts: login-ascending tie-break, and the SAME two claims must produce exactly ONE yielder when
  // evaluated from each side — the property that prevents both-yield (zero hosts) and neither-yield (two hosts).
  const claims = { alice: { session: 's1', ts: FRESH }, bob: { session: 's1', ts: FRESH } };
  const aliceSees = run(claims, 's1', 'alice');
  const bobSees = run(claims, 's1', 'bob');
  eq('equal ts: lexicographically-smaller login proceeds', aliceSees, '');
  eq('equal ts: the other side yields', (refusal(bobSees) || {}).error, 'already-live');
  ok('symmetric race → exactly one yielder', (aliceSees === '') !== (bobSees === ''));
}
// ---- robustness: junk files must never lock a session (mirrors presence-filter's discipline) ----
eq('corrupt rival file → ignored (free)', run({ daisy: '{}x{}' }, 's1', 'niburu'), '');
eq('rival file with no ts → treated stale (free)', run({ daisy: { session: 's1' } }, 's1', 'niburu'), '');
{
  const out = run({ daisy: { session: 's1', ts: FRESH, name: '' } }, 's1', 'niburu');
  eq('empty display name → refusal falls back to login', (refusal(out) || {}).by, 'daisy');
}
// ---- two rivals: the refusal names the FIRST claimant (earliest ts), not an arbitrary one ----
{
  const out = run({ daisy: { session: 's1', ts: FRESH, name: 'CrazyDev' }, zoe: { session: 's1', ts: FRESH - 20, name: 'Zoe' } }, 's1', 'niburu');
  eq('multiple rivals → earliest claimant named', (refusal(out) || {}).by, 'Zoe');
}
// ---- phase-1 TTL: an ORPHANED starting stamp stops blocking at the UI's own 60s, not 120s ----
{
  const AGED = NOW - 70;   // older than STARTING_TTL (60) but younger than LIVE_TTL (120)
  eq('a 70s-old STARTING claim no longer blocks (nobody visibly live -> claimable)',
    run({ daisy: { session: 's1', ts: AGED, starting: true } }, 's1', 'niburu'), '');
  const out = run({ daisy: { session: 's1', ts: AGED } }, 's1', 'niburu');
  eq('…but a 70s-old FULL claim still blocks (host re-stamps every 45s; 120s covers two missed beats)',
    (refusal(out) || {}).error, 'already-live');
}
// ---- phase-1 claims: a "going live…" stamp (starting:true, no url yet) claims the session like a full one ----
// Two hosts must not both slip through the tunnel-spawn window: the arbiter matches on session+ts, so a
// url-less starting stamp blocks a rival exactly as a full advertisement would.
{
  const out = run({ daisy: { session: 's1', ts: FRESH, name: 'CrazyDev', starting: true } }, 's1', 'niburu');
  eq('fresh STARTING rival claim → refusal', (refusal(out) || {}).error, 'already-live');
}

// ---- CLOCK SKEW: a future-dated claim must be IGNORED, never treated as fresh ----------------------------
// `now - ts` goes NEGATIVE for a forward-skewed writer, which reads as "always fresh" — so before the SKEW_TOL
// guard, such a claim refused every future claimant on that session FOREVER, with no TTL that could ever expire
// it. That is unrecoverable without hand-editing the branch, which is why it is worth a guard and a test.
// Clamping cannot fix it: the stamp is fixed on the branch, so min(ts, now) re-evaluates to age 0 on every read.
{
  const out = run({ daisy: { session: 's1', ts: SKEWED, name: 'CrazyDev' } }, 's1', 'niburu');
  ok('a far-future rival claim does NOT lock the session (no refusal)', out === '');
}
{
  // inside tolerance (a few seconds fast) must still be honoured — rejecting honest small drift would let TWO
  // hosts go live, which is worse than the thing we are guarding against.
  const out = run({ daisy: { session: 's1', ts: NOW + 5, name: 'CrazyDev' } }, 's1', 'niburu');
  ok('a slightly-fast rival clock is still a valid claim (refuses)', !!refusal(out));
}
{
  // Boundary, both sides. (Deliberately not testing the exact edge: the tool reads its own clock a moment after
  // the test computes NOW, so an exactly-at-tolerance stamp is inherently flaky. These sit well inside/outside.)
  const kept = run({ daisy: { session: 's1', ts: NOW + 118 } }, 's1', 'niburu');
  ok('a claim just inside the skew tolerance is still honoured', !!refusal(kept));
  const dropped = run({ daisy: { session: 's1', ts: NOW + 240 } }, 's1', 'niburu');
  ok('a claim beyond the skew tolerance is ignored', dropped === '');
}

// ---- CLOCK DOMAIN: the arbiter ages claims on CLAUDIBLE_NOW (the app's Electron clock, injected by main.js) when
// present, NOT the tool's own Date.now(). Under the WSL runner Date.now() is the drift-prone WSL2 clock; a stamp is
// written from the SAME injected clock (sessions-sync.sh), so write and read must judge it on that one time base. -----
{
  // A claim stamped at real-NOW, judged with an injected clock 1000s AHEAD → age 1000s > LIVE_TTL(120) → STALE → free.
  eq('CLAUDIBLE_NOW ahead of the stamp ages a real-now claim out (arbiter honors the injected clock)',
    run({ daisy: { session: 's1', ts: NOW, name: 'CrazyDev' } }, 's1', 'niburu', { CLAUDIBLE_NOW: String(NOW + 1000) }), '');
  // The SAME claim WITHOUT the injection is fresh (age ~0) and refuses — so the verdict flipped because of the
  // injected clock, not the stamp. Guards a no-op "fix" that reads the env but never uses it.
  ok('the same claim without CLAUDIBLE_NOW is fresh and refuses (the injected clock moved the verdict)',
    !!refusal(run({ daisy: { session: 's1', ts: NOW, name: 'CrazyDev' } }, 's1', 'niburu')));
  // A claim stamped AT the injected clock is fresh under it — end-to-end agreement between the bash ts stamp and
  // the arbiter. Without the injection this same +1000s ts is future-rejected (free); with it, it's a valid refusal.
  ok('a claim stamped at CLAUDIBLE_NOW is fresh under it (write and read share the clock)',
    !!refusal(run({ daisy: { session: 's1', ts: NOW + 1000, name: 'CrazyDev' } }, 's1', 'niburu', { CLAUDIBLE_NOW: String(NOW + 1000) })));
}

console.log(`live-holder: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
