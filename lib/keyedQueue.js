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
//
// run(key, fn, {front:true}) queues fn ahead of every waiting NON-front task (but behind other front tasks, so
// front work stays FIFO among itself, and never preempts the task already running). Presence ops ride this: a
// "going live" stamp is seconds-critical and must not wait out a queued multi-second transcript sync — while two
// presence ops must still land in the order they were issued (a clear after a set must stay after it).

// There is deliberately NO forget(key). An earlier version had one, to drop a deleted workspace's entry — but
// the map is already self-bounding (a key is dropped when its queue drains), so forget() could only ever remove a
// key that was either idle (about to be cleaned up anyway) or BUSY. Force-dropping a busy key is a bug, not a
// cleanup: ws.id is `${kind}-${slug}`, so a workspace deleted mid-snapshot and re-created under the same name gets
// the SAME key — and its writes would then race the orphaned in-flight chain instead of queueing behind it, which
// is the exact overlap this queue exists to prevent. Letting the key drain naturally is both correct and simpler.
function makeKeyedQueue() {
  const chans = new Map();   // key -> { fronts: [], normals: [], running: false }

  function pump(k) {
    const c = chans.get(k);
    if (!c || c.running) return;
    const job = c.fronts.shift() || c.normals.shift();
    if (!job) { chans.delete(k); return; }   // drained → drop the key, so a long-lived process doesn't retain one per key forever
    c.running = true;
    // Two guarantees, both load-bearing (they mirror the original chained-promise design):
    //   1. A failed task can never poison the queue — pump continues regardless of outcome. The Stop-hook
    //      snapshot is fire-and-forget; if its rejection wedged the key, the user's next Revert would hang.
    //   2. Nothing ever leaves an unhandled rejection behind (see the pre-handled promise in run()).
    Promise.resolve().then(job.fn).then(
      (v) => job.resolve(v),
      (e) => job.reject(e)
    ).then(() => { c.running = false; pump(k); });
  }

  // Run `fn` once every earlier task for `key` has settled (front tasks: once every earlier FRONT task and the
  // currently-running task have). Returns fn's own promise — the CALLER sees fn's result or its rejection.
  function run(key, fn, opts) {
    const k = key == null ? '_none' : String(key);
    let c = chans.get(k);
    if (!c) { c = { fronts: [], normals: [], running: false }; chans.set(k, c); }
    const p = new Promise((resolve, reject) => {
      (opts && opts.front ? c.fronts : c.normals).push({ fn, resolve, reject });
      pump(k);
    });
    p.catch(() => {});   // pre-handle: a caller that ignores the returned promise must never cause an unhandled rejection
    return p;
  }

  function size() { return chans.size; }

  return { run, size };
}

module.exports = { makeKeyedQueue };
