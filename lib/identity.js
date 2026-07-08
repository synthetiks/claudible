'use strict';
// Identity + machine fingerprint for session-history attribution. PURE core (all IO injected by the
// caller: hostname, platform, the persisted machine-id, a fresh uuid) so it tests headlessly. This
// normalizes those inputs into the {author, machine} shapes the event log stamps onto every entry —
// answering "who wrote this / which PC".

// Who an action is attributed to. Live co-drive -> the connection that submitted the prompt;
// local/solo -> the host's own username. Falls back so an entry is never left unattributed.
function resolveAuthor(o) {
  o = o || {};
  const name = (o.username || '').trim();
  return name || (o.fallback || '').trim() || 'unknown';
}

// Stable per-machine record. `savedId` = a uuid persisted once per machine (caller reads/writes it);
// `uuid` = a freshly generated one used only the first time, before anything is saved.
function machineRecord(o) {
  o = o || {};
  return { id: (o.savedId || o.uuid || '').trim(), host: (o.host || '').trim(), os: o.os || '' };
}

module.exports = { resolveAuthor, machineRecord, _internals: { resolveAuthor, machineRecord } };
