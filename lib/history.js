'use strict';
// Session-history backbone — the single append-only event log that powers BOTH the Repo Review
// activity feed AND revert ("one log, not two features"). This is the PURE core: no IO, no Date.now,
// no disk — id/ts/author/machine are injected by the caller — so it unit-tests headlessly. Mirrors
// the runners/*.js `_internals` pattern. IO (disk persistence, hostname, prefs) lives in the caller.

const MAX_ENTRIES = 200;   // retention cap: keep the last N entries on disk (oldest pruned); the feed paginates 10 at a time

// Normalize a log entry to a stable shape. Caller injects `id`, `seq`, `ts` (kept out of the pure
// core so tests are deterministic). `files` = [{path, add, del}]; `checkpointRef` links to the
// snapshot that revert restores (filled in later phases).
function makeEntry(o) {
  o = o || {};
  return {
    id: String(o.id),
    seq: o.seq | 0,
    ts: Number(o.ts) || 0,   // NOT `| 0` — that 32-bit-truncates Date.now() and corrupts every timestamp
    author: o.author || 'unknown',
    authorId: o.authorId || '',
    machine: o.machine || { id: '', host: '', os: '' },
    session: o.session || '',
    prompt: String(o.prompt == null ? '' : o.prompt),
    summary: o.summary || '',
    files: Array.isArray(o.files) ? o.files : [],
    checkpointRef: o.checkpointRef || null,
  };
}

// Append + prune to the `max` newest entries (by seq). Returns a NEW array — never mutates input.
function ringPush(log, entry, max) {
  max = max || MAX_ENTRIES;
  const next = log.concat([entry]).sort((a, b) => a.seq - b.seq);
  return next.length > max ? next.slice(next.length - max) : next;
}

// Union two logs by id (dedupe), ordered oldest->newest by seq then ts. This is the conflict-free
// merge used when a joiner reconciles its log with the host's (sync across machines).
function mergeLogs(a, b, max) {
  max = max || MAX_ENTRIES;
  const byId = new Map();
  for (const e of a.concat(b)) byId.set(e.id, e);   // last-writer-wins per id
  const all = Array.from(byId.values()).sort((x, y) => (x.ts - y.ts) || (x.seq - y.seq));   // ts is globally comparable across machines; seq is per-machine, so order by ts first (seq only as a same-instant tiebreak)
  return all.length > max ? all.slice(all.length - max) : all;
}

// "3 files (+42/-10)" — the GitHub-style one-liner the feed shows per entry.
function summarizeFiles(files) {
  if (!files || !files.length) return 'no file changes';
  const add = files.reduce((n, f) => n + (f.add | 0), 0);
  const del = files.reduce((n, f) => n + (f.del | 0), 0);
  const n = files.length;
  return n + ' file' + (n === 1 ? '' : 's') + ' (+' + add + '/-' + del + ')';
}

module.exports = {
  MAX_ENTRIES, makeEntry, ringPush, mergeLogs, summarizeFiles,
  _internals: { makeEntry, ringPush, mergeLogs, summarizeFiles },
};
