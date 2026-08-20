'use strict';
// Session facts — the append-only record of everything that happens TO a session, as opposed to
// everything that happens IN one. A rename, a clear, a delete and a workspace change are facts; the
// messages themselves stay in Claude's transcript. This is the PURE core: no IO, no Date.now, no
// crypto — id/ts/author/machine are injected by the caller — so it unit-tests headlessly, mirroring
// the lib/history.js and runners/*.js `_internals` pattern.
//
// WHY THIS EXISTS SEPARATELY FROM lib/history.js, which has a very similar shape:
//   history.js backs the Repo Review activity feed, where a 200-entry ring is correct and where the
//   merge's last-writer-wins-per-id is deliberately relied upon (an entry updated at Stop time
//   replaces itself under the same id). Both properties are wrong here. A session's lifetime record
//   must never be pruned — a dropped rename or clear silently changes what the sidebar computes —
//   and every fact is a distinct occurrence that must survive alongside its neighbours rather than
//   overwrite one. Sharing the module would mean one of the two callers getting semantics it cannot
//   use, so the SHAPE is shared and the guarantees are not.
//
// THE ONE RULE THAT MAKES THE MERGE SAFE: every fact id is globally unique, minted once at creation
// and never reused. mergeFacts unions by id, so two machines that both record something end up with
// both records regardless of who syncs first. Reuse an id and one fact silently eats the other —
// which is why makeFact refuses to build a fact without one, rather than inventing a fallback.

const FACT_TYPES = [
  'session.renamed',      // data: { sessionId, title }
  'session.cleared',      // data: { sessionId, continuesFrom } — a clear starts a new session that continues an old one
  'session.deleted',      // data: { sessionId } — written by the deleting author into their OWN log
  'workspace.renamed',    // data: { workspaceId, label }
  'workspace.adopted',    // data: { workspaceId }
  'workspace.dismissed',  // data: { workspaceId }
];

// Normalize a fact to a stable shape. The caller injects `id` (globally unique), `ts` (the app's
// clock, never the sync shell's — see the note in wsl/sessions-sync.sh's presence path) and `seq`,
// so this stays deterministic under test. Returns null for anything unusable rather than throwing:
// a fact is recorded on a path that has already succeeded (the rename happened, the delete happened),
// so a malformed one must never turn completed work into an error.
function makeFact(o) {
  o = o || {};
  const id = String(o.id == null ? '' : o.id);
  const type = String(o.type == null ? '' : o.type);
  if (!id) return null;                                  // no id = no merge safety; refuse rather than invent one
  if (FACT_TYPES.indexOf(type) === -1) return null;
  const ts = Number(o.ts);
  if (!Number.isFinite(ts) || ts <= 0) return null;      // NOT `| 0` — that 32-bit-truncates a millisecond clock
  return {
    id: id,
    type: type,
    seq: o.seq | 0,
    ts: ts,
    author: o.author || 'unknown',
    authorId: o.authorId || '',
    machine: o.machine || { id: '', host: '', os: '' },
    required: o.required === true,   // a reader that does not understand this type must refuse rather than skip it
    data: (o.data && typeof o.data === 'object') ? o.data : {},
  };
}

// Union two fact lists by id, oldest first. Conflict-free BECAUSE ids are unique: no fact can
// displace another, so the result is the same whichever order two machines merge in. Ordered by ts
// (globally comparable across machines) with seq only as a same-instant tiebreak — seq is per-machine
// and means nothing between them, so two machines stamping the same millisecond order arbitrarily.
// That is an accepted limit, not an oversight: it can only matter for two renames of one session
// inside the same millisecond on two machines.
//
// NEVER TAKES A CAP. The feed's ring cap exists because a feed is a window; this is a lifetime
// record, and a pruned clear or delete does not degrade the sidebar, it corrupts it.
// A COLLISION IS RESOLVED BY CONTENT, NOT BY POSITION. Two different facts sharing an id should be
// impossible, but "impossible" resolved by first-seen or last-seen is exactly the positional rule
// this module exists to avoid — it would make the answer depend on who synced first, which is the
// original disease. Comparing the serialized facts picks the same winner on every machine, so a
// corrupt or hostile log degrades into a consistent view rather than a divergent one.
function pickStable(x, y) {
  const sx = JSON.stringify(x);
  const sy = JSON.stringify(y);
  if (sx === sy) return x;
  return sx < sy ? x : y;
}

function mergeFacts(a, b) {
  const byId = new Map();
  const all = (a || []).concat(b || []);
  for (const f of all) {
    if (!f || !f.id) continue;
    byId.set(f.id, byId.has(f.id) ? pickStable(byId.get(f.id), f) : f);
  }
  return Array.from(byId.values()).sort((x, y) => (x.ts - y.ts) || (x.seq - y.seq) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

// One fact per line, so appending is a byte-append rather than a read-modify-write of the whole file,
// and so the file can never be "rewritten" in a way that reads as a fork on another machine (the
// hazard the transcript machine-tags exist to defend against). No trailing newline is added here;
// the writer owns that.
function serializeFact(f) {
  return JSON.stringify(f);
}

// Parse a whole log file. Junk lines are DROPPED, never thrown on: one torn line written during a
// crash must not cost the reader every other fact in the file. Unknown types are handled by the
// caller (see isReadable) rather than here, so parsing stays a pure text concern.
function parseFactLines(text) {
  const out = [];
  for (const line of String(text == null ? '' : text).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o = null;
    try { o = JSON.parse(t); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    if (!o.id || typeof o.id !== 'string') continue;
    if (!Number.isFinite(Number(o.ts))) continue;
    o.ts = Number(o.ts);
    o.seq = o.seq | 0;
    o.required = o.required === true;
    o.data = (o.data && typeof o.data === 'object') ? o.data : {};
    out.push(o);
  }
  return out;
}

// Can this build act on this fact? A type we do not know is skipped when it is optional and REFUSED
// when it is required — the difference between a newer machine adding something cosmetic and a newer
// machine recording something this build would compute the wrong answer without. Be honest about the
// limit: this only protects a reader that already understands fact files at all. An older build that
// predates them reads no facts whatsoever, which is why the older per-author name map keeps being
// written for the whole transition rather than being cut over on the first release.
function isReadable(f) {
  if (!f || FACT_TYPES.indexOf(f.type) !== -1) return true;
  return !f.required;
}

// Any required fact this build cannot act on. A non-empty result means the reader must say so out
// loud instead of quietly computing a view from a partial record.
function unreadable(facts) {
  return (facts || []).filter((f) => f && FACT_TYPES.indexOf(f.type) === -1 && f.required === true);
}

module.exports = {
  FACT_TYPES, makeFact, mergeFacts, serializeFact, parseFactLines, isReadable, unreadable,
  _internals: { makeFact, mergeFacts, serializeFact, parseFactLines, isReadable, unreadable },
};
