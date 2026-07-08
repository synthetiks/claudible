'use strict';
// Crash-safe file write: write a sibling temp file, then rename it over the target. rename(2) within a
// directory is atomic on POSIX and on NTFS (MoveFileEx), so a reader — or the next boot after a force-kill —
// sees either the whole old file or the whole new one. Never a torn one.
//
// This matters here because EVERY reader in this app turns a parse error into a silent default:
// loadRegistry() rebuilds workspaces.json from scratch, readSettings() returns {}, historyStore.load()
// returns []. A half-written file doesn't crash — it quietly erases the user's projects, their session
// titles, or their history. The window is small; the failure is total.
//
// `fs` is injected so lib/ stays IO-free and this unit-tests against a temp dir (or a fake).

// Write `data` to `file` atomically. Throws whatever fs throws, after cleaning up the temp file — a caller
// that swallows the error must not also leave a stale `<file>.tmp` behind for a globber to trip over.
function atomicWrite(fs, file, data) {
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// The JSON case, which is all of them. `indent` defaults to 2 (these files get read by humans);
// pass 0 for the hot per-tab context.json. Output is byte-identical to a plain JSON.stringify write.
function atomicWriteJson(fs, file, value, indent) {
  atomicWrite(fs, file, JSON.stringify(value, null, indent === undefined ? 2 : indent));
}

module.exports = { atomicWrite, atomicWriteJson };
