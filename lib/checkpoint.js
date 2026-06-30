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
function snapshot(git, id, tmpIndex) {
  const env = { GIT_INDEX_FILE: tmpIndex };
  if (git(['add', '-A'], env).code !== 0) return '';                 // stage everything (incl untracked) into the scratch index
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
  const removed = git(['ls-files', '--others', '--exclude-standard']).stdout
    .split('\n').map((s) => s.trim()).filter(Boolean);                // anything now untracked vs the ckpt = added since → remove
  removed.forEach((p) => { try { rmFile(p); } catch {} });
  git(['read-tree', 'HEAD']);                                         // reset index to HEAD so the restore reads as unstaged edits
  return { ok: true, sha, removed };
}

module.exports = { REF, snapshot, resolve, restore, _internals: { REF, snapshot, resolve, restore } };
