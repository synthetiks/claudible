// test/keyed-queue.test.js — lib/keyedQueue.js, the per-workspace serialization behind checkpoint snapshot /
// restore and diff revert / discard.
//
// The property that matters is NEGATIVE: two tasks on the same key never OVERLAP. Asserting they finish in
// order is not the same thing — a queue that starts both immediately and just resolves them in order would pass
// that. So every task here records enter/exit and the test asserts no interleaving ever occurred.
// Run: node test/keyed-queue.test.js
'use strict';
const { makeKeyedQueue } = require('../lib/keyedQueue.js');

let pass = 0, fail = 0;
function ok(label, c) { c ? pass++ : (fail++, console.error('  FAIL ' + label)); }
function eq(label, a, b) { const A = JSON.stringify(a), B = JSON.stringify(b); if (A === B) pass++; else { fail++; console.error(`  FAIL ${label}\n    got: ${A}\n    exp: ${B}`); } }
const tick = (n = 0) => new Promise((r) => setTimeout(r, n));

// A task that logs when it starts and stops, so overlap is observable.
function tracer(log) {
  return (name, ms, opts) => () => {
    log.push('+' + name);
    return tick(ms).then(() => {
      log.push('-' + name);
      if (opts && opts.throw) throw new Error('boom:' + name);
      return name;
    });
  };
}
// No two tasks on the same key may be open at once: the log must read +a -a +b -b, never +a +b.
const noOverlap = (log) => {
  let open = 0;
  for (const e of log) { if (e[0] === '+') { if (++open > 1) return false; } else open--; }
  return true;
};

(async () => {
  // ---- same key: strict serialization, in call order ------------------------------------------------------
  {
    const q = makeKeyedQueue(), log = [], t = tracer(log);
    // Deliberately give the FIRST task the longest delay: a queue that doesn't actually wait would let b and c
    // finish first, and the log would interleave.
    const p = [q.run('ws1', t('a', 30)), q.run('ws1', t('b', 1)), q.run('ws1', t('c', 1))];
    eq('same key: results come back to the right callers', await Promise.all(p), ['a', 'b', 'c']);
    ok('same key: no two tasks were ever open at once', noOverlap(log));
    eq('same key: ran in call order despite a slow first task', log.join(''), '+a-a+b-b+c-c');
  }

  // ---- different keys run concurrently (a slow project must not block another) -----------------------------
  {
    const q = makeKeyedQueue(), log = [], t = tracer(log);
    const p = [q.run('ws1', t('slow', 40)), q.run('ws2', t('fast', 1))];
    await Promise.all(p);
    ok('different keys overlap (they must — a Revert in project A can’t wait on project B)', log.join('') === '+slow+fast-fast-slow');
  }

  // ---- a rejected task must not poison the chain ------------------------------------------------------------
  // The Stop-hook snapshot is fire-and-forget. If its rejection killed the chain, the user's next Revert would
  // hang forever with no error anywhere.
  {
    const q = makeKeyedQueue(), log = [], t = tracer(log);
    const bad = q.run('ws1', t('bad', 1, { throw: true }));
    const good = q.run('ws1', t('good', 1));
    let caught = null;
    try { await bad; } catch (e) { caught = e.message; }
    eq('the failing caller sees its own rejection', caught, 'boom:bad');
    eq('the next task still runs, and returns normally', await good, 'good');
    ok('…and it waited for the failed one (no overlap)', noOverlap(log));
    eq('…in order', log.join(''), '+bad-bad+good-good');
  }
  // A task that throws SYNCHRONOUSLY (before returning a promise) must behave the same.
  {
    const q = makeKeyedQueue();
    let caught = null;
    try { await q.run('ws1', () => { throw new Error('sync-boom'); }); } catch (e) { caught = e.message; }
    eq('a synchronous throw rejects the caller', caught, 'sync-boom');
    eq('…and the chain survives it', await q.run('ws1', () => 'after'), 'after');
  }

  // ---- the map does not grow forever -------------------------------------------------------------------------
  {
    const q = makeKeyedQueue();
    await Promise.all([q.run('a', () => tick(1)), q.run('b', () => tick(1)), q.run('c', () => tick(1))]);
    await tick(5);                                    // let the idle-cleanup microtasks land
    eq('idle keys are dropped', q.size(), 0);
  }
  {
    // …but a key with work still queued behind it must NOT be dropped mid-chain.
    const q = makeKeyedQueue(), log = [], t = tracer(log);
    const p1 = q.run('ws1', t('first', 15));
    const p2 = q.run('ws1', t('second', 1));          // queued while `first` is still running
    ok('a busy key is retained', q.size() === 1);
    await Promise.all([p1, p2]);
    ok('the queued task still waited its turn', noOverlap(log) && log.join('') === '+first-first+second-second');
    await tick(5);
    eq('…and the key is released once idle', q.size(), 0);
  }
  {
    // The identity guard on the idle-cleanup. `a` settles while `b` is STILL RUNNING, so `a`'s cleanup fires with
    // `b`'s tail installed. Delete the key there and the next caller (`c`) starts on top of `b` — the very overlap
    // this queue exists to prevent. A test that only queues tasks up-front never reaches this state.
    const q = makeKeyedQueue(), log = [], t = tracer(log);
    const pa = q.run('ws1', t('a', 5));
    const pb = q.run('ws1', t('b', 40));              // outlives a's cleanup
    await pa;
    await tick(5);                                    // a's quiet resolves; its cleanup microtask runs here
    ok('the key survives a settled task while a successor is still running', q.size() === 1);
    const pc = q.run('ws1', t('c', 1));               // must queue behind b, not race it
    await Promise.all([pb, pc]);
    ok('a task queued after an earlier one settled still waits for the RUNNING one', noOverlap(log));
    eq('…and ran last', log.join(''), '+a-a+b-b+c-c');
  }

  // ---- a re-created same-key workspace queues behind an in-flight task, never races it -----------------------
  // main.js keys on ws.id = `${kind}-${slug}`, which RECURS: delete a project mid-checkpoint, re-create one with
  // the same name, and both map to the same key. There is deliberately no forget() — force-dropping the busy key
  // would let the new workspace's writes race the orphaned snapshot, the exact overlap this queue prevents. This
  // pins that: a second run() on a key whose task is still in flight must wait, even across the "workspace was
  // deleted" gap (which, without forget(), is invisible to the queue — as it should be).
  {
    const q = makeKeyedQueue(), log = [], t = tracer(log);
    const deleted = q.run('repo-proj', t('snapshot-of-deleted-ws', 25));   // Stop-hook snapshot still running…
    // …workspace deleted here (no queue call — the id just recurs later)…
    const recreated = q.run('repo-proj', t('write-in-recreated-ws', 1));   // same id, new workspace
    await Promise.all([deleted, recreated]);
    ok('a re-created same-id workspace never overlaps the orphaned in-flight task', noOverlap(log));
    eq('…it waited its turn', log.join(''), '+snapshot-of-deleted-ws-snapshot-of-deleted-ws+write-in-recreated-ws-write-in-recreated-ws');
  }

  // ---- null / undefined keys collapse to one chain (main.js passes ws && ws.id) --------------------------------
  {
    const q = makeKeyedQueue(), log = [], t = tracer(log);
    await Promise.all([q.run(null, t('x', 10)), q.run(undefined, t('y', 1))]);
    ok('a null key still serializes (never a free-for-all)', noOverlap(log) && log.join('') === '+x-x+y-y');
  }

  // ---- the real scenario: a Stop-hook snapshot landing mid-revert ---------------------------------------------
  // Without the queue, `git add -A` walks the worktree while `git apply -R` is rewriting it, and the resulting
  // checkpoint captures a half-reverted tree — which is what a LATER revert restores you to.
  {
    const q = makeKeyedQueue();
    const worktree = { files: 'CLEAN' };
    let snapshotSaw = null;
    const revert = q.run('ws1', async () => { worktree.files = 'TORN'; await tick(20); worktree.files = 'REVERTED'; });
    const snapshot = q.run('ws1', async () => { await tick(1); snapshotSaw = worktree.files; });
    await Promise.all([revert, snapshot]);
    eq('the Stop snapshot never sees a half-reverted worktree', snapshotSaw, 'REVERTED');
  }

  console.log(`\nkeyed-queue: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
