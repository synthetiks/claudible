'use strict';
// The session list, COMPUTED. Given the transcripts on disk plus the facts recorded about them, this
// returns exactly what the sidebar should show. Nothing here is stored: every caller recomputes on
// every read, so two machines that hold the same facts always agree, and a row can always be thrown
// away and rebuilt rather than repaired in place.
//
// PURE by construction — no fs, no clock, no preferences. Everything it needs arrives as an argument
// (the `_internals` pattern used by lib/history.js and the runners), so the whole resolution can be
// driven from tests without a machine, a repo, or a live session.
//
// PARTIAL DATA IS THE NORMAL CASE, NOT THE EDGE CASE. Transcripts and facts travel by different
// routes and arrive at different times, so every combination below is a state a real machine sits in
// for seconds at a time, and each has a defined answer rather than an accident:
//   - a continuation's transcript is here but the fact recording it has not arrived: the new session
//     shows as its own row until the fact lands. It is not wrong, merely not yet folded.
//   - the fact is here but the transcript it points at is not: the fold is skipped ENTIRELY. Hiding
//     the older session on the strength of a successor nobody can open yet would leave the list
//     showing nothing at all for that conversation.
//   - a delete is recorded but the transcript is still on disk: hidden. The fact is the decision;
//     the file is a leftover.
//   - a transcript was deleted before facts existed: the older deletion markers are still honoured,
//     forever. Facts are additive to that mechanism, never a replacement for it.

const { mergeFacts } = require('./sessionFacts.js');

// Fold a fact list down to the last write per session per kind. Facts are already ordered oldest
// first by mergeFacts, so a straight forward pass leaves the newest in place.
function lastPerSession(facts, type, field) {
  const out = new Map();
  for (const f of facts) {
    if (!f || f.type !== type) continue;
    const sid = f.data && f.data.sessionId;
    if (!sid || typeof sid !== 'string') continue;
    out.set(sid, f.data[field]);
  }
  return out;
}

// Walk a continuation chain to the session that should represent it, skipping over any link whose
// target was deleted (a link to a conversation that no longer exists is not a continuation, and
// following it would fold a live row away permanently). Bounded by the number of links so a cycle
// introduced by a corrupt or hostile fact file can never hang the sidebar.
function resolveChain(startId, continues, deleted, limit) {
  let cur = startId;
  let hops = 0;
  while (hops++ < limit) {
    const next = continues.get(cur);
    if (!next || next === cur) return cur;
    if (deleted.has(next)) { cur = next; continue; }   // step over a deleted ancestor, keep the chain's shape
    cur = next;
  }
  return cur;
}

// transcripts: [{ id, title?, ts? }] in the order the caller wants them shown — the caller owns
//              sorting, this owns identity and visibility.
// facts:       the merged fact list (any order; merged again here so callers cannot pass a
//              half-sorted list and get a different answer than their peer).
// tombstones:  ids deleted before facts existed. Still authoritative.
// liveState:   { liveId } — which session is live right now. Live state is deliberately NOT a fact:
//              it is a property of this moment, not of the session's history, and recording it
//              would put a value in the permanent record that is wrong the instant it is written.
function deriveSessions(input) {
  const inp = input || {};
  const transcripts = Array.isArray(inp.transcripts) ? inp.transcripts : [];
  const facts = mergeFacts(Array.isArray(inp.facts) ? inp.facts : [], []);
  const tombstones = new Set(Array.isArray(inp.tombstones) ? inp.tombstones : []);
  const liveId = (inp.liveState && inp.liveState.liveId) || '';

  const titles = lastPerSession(facts, 'session.renamed', 'title');
  const continues = lastPerSession(facts, 'session.cleared', 'continuesFrom');

  const deleted = new Set(tombstones);
  for (const f of facts) {
    if (f && f.type === 'session.deleted' && f.data && typeof f.data.sessionId === 'string') deleted.add(f.data.sessionId);
  }

  const present = new Set();
  for (const t of transcripts) { if (t && t.id) present.add(t.id); }

  // Which sessions are superseded by a continuation we can actually open? Only those. A fold whose
  // successor is not here yet is not performed at all — see the partial-data note above.
  //
  // The walk goes up the WHOLE chain rather than one link, because a conversation cleared twice, or
  // one whose middle link was later deleted, still has exactly one live row at the top. Stopping at
  // the first parent would leave the grandparent standing beside its own continuation — the
  // duplicate row this mechanism exists to prevent.
  const superseded = new Set();
  for (const childId of continues.keys()) {
    if (!present.has(childId)) continue;               // successor not imported yet — leave the ancestors alone
    if (deleted.has(childId)) continue;                // successor itself deleted — the parent is still the conversation
    const seen = new Set([childId]);
    const climbed = [];
    let cur = continues.get(childId);
    let cyclic = false;
    while (cur && cur !== childId) {
      if (seen.has(cur)) { cyclic = true; break; }
      seen.add(cur);
      climbed.push(cur);
      cur = continues.get(cur);
    }
    if (cur === childId) cyclic = true;                // walked right back to where we started
    // A cycle means the record is corrupt. Fold NOTHING for this chain: showing an extra row is a
    // blemish, hiding every row in a loop loses the conversation entirely.
    if (cyclic) continue;
    for (const id of climbed) superseded.add(id);
  }

  const rows = [];
  for (const t of transcripts) {
    if (!t || !t.id) continue;
    if (deleted.has(t.id)) continue;                   // the decision to delete outranks the file still being there
    if (superseded.has(t.id)) continue;                // folded into its continuation
    const head = resolveChain(t.id, continues, deleted, continues.size + 1);
    rows.push({
      id: t.id,
      title: titles.has(t.id) ? titles.get(t.id) : (t.title || ''),
      continuesFrom: continues.get(t.id) || '',
      chainHead: head,
      live: !!liveId && liveId === t.id,
    });
  }
  return rows;
}

module.exports = { deriveSessions, _internals: { deriveSessions, lastPerSession, resolveChain } };
