'use strict';
// A per-key serialization queue: tasks sharing a key run one at a time, in call order; different keys run
// concurrently. Pure — no IO, no timers — so it unit-tests headlessly.
//
// main.js uses one keyed by workspace id, because three code paths mutate a workspace's git worktree and nothing
// serialized them:
//   * checkpoint `snapshot`  — `git add -A` reads the whole worktree into a scratch index, and fires from the Stop
//                              hook after EVERY turn
//   * checkpoint `restore`   — `read-tree` + `checkout-index -a -f` overwrite the worktree, and take .git/index.lock
//   * diff-apply             — `git apply -R` rewrites files; `discard` deletes them
// A Stop landing while the user reverts a hunk snapshots a HALF-REVERTED tree, and that snapshot is what a later
// Revert restores them to. Two restores race on .git/index.lock and one dies with a git error nobody can act on.
//
// Reads are deliberately NOT queued: git reads take no lock, `diff:list` polls every 4s, and a stale frame in a
// self-repainting panel is not worth the latency.

function makeKeyedQueue() {
  const tails = new Map();   // key -> promise that settles when that key's chain is idle

  // Run `fn` once every earlier task for `key` has settled. Returns fn's own promise — the CALLER sees fn's result
  // or its rejection.
  function run(key, fn) {
    const k = key == null ? '_none' : String(key);
    const prev = tails.get(k) || Promise.resolve();
    // The tail we STORE is `quiet`, which swallows both outcomes. Two consequences, both load-bearing:
    //   1. It can never reject, so a failed task can never poison the chain. The Stop-hook snapshot is
    //      fire-and-forget; if its rejection killed the chain, the user's next Revert would hang with no error.
    //   2. Nothing ever leaves an unhandled rejection behind, even for a caller that ignores the returned promise.
    const next = prev.then(fn);
    const quiet = next.then(() => {}, () => {});
    tails.set(k, quiet);
    // Drop the key once its chain goes idle, so a long-lived process doesn't retain an entry per key forever.
    // The identity check is NOT cosmetic: if a task was queued while this one ran, `tails` now holds ITS quiet
    // promise. Deleting unconditionally would release the key while that task is still running, and the next
    // caller would start concurrently with it — reintroducing exactly the overlap this queue exists to prevent.
    quiet.then(() => { if (tails.get(k) === quiet) tails.delete(k); });
    return next;
  }

  function forget(key) { tails.delete(key == null ? '_none' : String(key)); }   // the key is gone for good (workspace deleted)
  function size() { return tails.size; }

  return { run, forget, size };
}

module.exports = { makeKeyedQueue };
