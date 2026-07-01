'use strict';
// Per-prompt worktree checkpoints — the snapshot layer that revert restores from. Git-backed:
// captures the FULL worktree (tracked + untracked) to a hidden ref refs/claudible/ckpt/<id> WITHOUT
// touching the user's HEAD / index / branch (it stages into a throwaway index file). restore() rolls
// the worktree back to a checkpoint and removes files added since (scoped via ls-files --others —
// never a blind `git clean`). The git runner + rmFile are injected, so this tests against a real
// throwaway repo. Every op is git plumbing on the local repo — tiny and fast, no network.

const REF = (id) => 'refs/claudible/ckpt/' + String(id);

// Snapshot the current worktree to refs/claudible/ckpt/<id>. Returns the commit sha, or '' on failure.
//   git(args, env?) runs git in the repo, returning { code, stdout }.
//   tmpIndex = path to a scratch index file so the user's REAL index is never disturbed.
function snapshot(git, id, tmpIndex, forcePaths) {
  const env = { GIT_INDEX_FILE: tmpIndex };
  if (git(['add', '-A'], env).code !== 0) return '';                 // stage everything (incl untracked, but NOT gitignored) into the scratch index
  // Optionally force-stage specific paths even if gitignored. Used for the pre-revert 'undo' snapshot: a path that
  // restore is about to overwrite but is currently gitignored+untracked would otherwise be MISSING from the undo
  // tree (git add -A skips it), so undo couldn't bring it back — silent data loss. Force-adding those exact paths
  // captures their current content. Chunked to stay under argv limits.
  if (forcePaths && forcePaths.length) {
    for (let i = 0; i < forcePaths.length; i += 400) git(['add', '-f', '--', ...forcePaths.slice(i, i + 400)], env);
  }
  const tree = git(['write-tree'], env).stdout.trim();
  if (!tree) return '';
  const head = git(['rev-parse', '-q', '--verify', 'HEAD']).stdout.trim();
  const mk = head
    ? ['commit-tree', tree, '-p', head, '-m', 'claudible ckpt ' + id]   // chain off HEAD when there is one
    : ['commit-tree', tree, '-m', 'claudible ckpt ' + id];             // else a root commit (fresh repo)
  const sha = git(mk).stdout.trim();
  if (!sha) return '';
  git(['update-ref', REF(id), sha]);
  return sha;
}

// Does the checkpoint ref exist? -> sha | ''
function resolve(git, id) {
  return git(['rev-parse', '-q', '--verify', REF(id)]).stdout.trim();
}

// Every path in a checkpoint's tree (NUL-delimited so non-ASCII / spaced names are exact). Used to force-stage
// those paths into the undo snapshot (see snapshot's forcePaths) so a revert can never orphan a file it overwrites.
function treePaths(git, id) {
  const sha = resolve(git, id); if (!sha) return [];
  return (git(['ls-tree', '-r', '--name-only', '-z', sha]).stdout || '').split('\0').filter(Boolean);
}

// Roll the worktree back to checkpoint <id>. Returns { ok, sha, removed[] } or { ok:false }.
// DESTRUCTIVE: this overwrites worktree files and deletes files added since the checkpoint. The
// Phase-7 caller that wires this MUST snapshot() the CURRENT worktree to an undo ref FIRST — restore
// itself takes no auto-undo, so without that step a roll-back can irrecoverably destroy uncommitted
// work. Files present now but absent from the checkpoint are deleted via the injected rmFile(path)
// (relative paths); restored state is left as UNSTAGED worktree edits (index reset to HEAD).
function restore(git, id, rmFile) {
  const sha = resolve(git, id);
  if (!sha) return { ok: false };
  if (git(['read-tree', sha]).code !== 0) return { ok: false };       // index := checkpoint tree
  if (git(['checkout-index', '-a', '-f']).code !== 0) {              // write those files into the worktree
    git(['read-tree', 'HEAD']);                                      // ...failed: undo the index mutation above so we don't leave a corrupted index
    return { ok: false };
  }
  const removed = (git(['ls-files', '--others', '--exclude-standard', '-z']).stdout || '')
    .split('\0').filter(Boolean);                                     // -z: NUL-delimited + UNquoted, so non-ASCII/CJK/spaced names are the REAL path (a quoted \n-split would fail to delete them and mis-report)
  removed.forEach((p) => { try { rmFile(p); } catch {} });
  // Reset the index so the restore reads as unstaged worktree edits. On a repo with NO commits HEAD doesn't resolve,
  // so empty the index instead (else it stays staged to the checkpoint tree, contradicting the contract above).
  if (git(['rev-parse', '-q', '--verify', 'HEAD']).stdout.trim()) git(['read-tree', 'HEAD']);
  else git(['read-tree', '--empty']);
  return { ok: true, sha, removed };
}

// List existing checkpoint ids (the part after refs/claudible/ckpt/).
function list(git) {
  const out = (git(['for-each-ref', '--format=%(refname)', 'refs/claudible/ckpt/']).stdout || '');
  return out.split('\n').map((s) => s.trim()).filter(Boolean).map((r) => r.replace('refs/claudible/ckpt/', ''));
}

// Delete every checkpoint whose id is NOT in keepIds — the ring-buffer cleanup so aged-out history entries don't
// leave their snapshot refs (and the objects they pin) around forever. The 'undo' ref is NEVER pruned (it's the
// safety net for "undo revert", overwritten on each restore). Returns the ids actually deleted.
function prune(git, keepIds) {
  const keep = new Set((keepIds || []).map(String));
  const gone = [];
  for (const id of list(git)) {
    if (id === 'undo' || keep.has(id)) continue;
    if (git(['update-ref', '-d', REF(id)]).code === 0) gone.push(id);
  }
  return gone;
}

module.exports = { REF, snapshot, resolve, restore, treePaths, list, prune, _internals: { REF, snapshot, resolve, restore, treePaths, list, prune } };
