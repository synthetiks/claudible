'use strict';
// Claudible — the WSL-side adapter that runs the tested lib/checkpoint.js against the REAL workspace repo.
// checkpoint.sh cd's into the repo and invokes this with a subcommand; we inject a real `git` runner (cwd = the
// repo the shell is in) and emit ONE JSON line for main.js. Keeps ALL snapshot/restore plumbing in the pure,
// unit-tested lib — this file is only argv + git wiring + the mandatory pre-restore "undo" snapshot.
//   snapshot <id>          -> { ok, id, sha }
//   restore  <id>          -> { ok, id, undo, removed[] }   (snapshots the CURRENT tree to the 'undo' ref FIRST)
//   prune    <keepId...>   -> { ok, pruned[] }              (drop every ckpt ref not in the keep list, never 'undo')
//   numstat  <from> <to>   -> { ok, files:[{path,add,del}] } (what changed between two checkpoints; unresolvable -> [])
//   exists   <id>          -> { ok, id, exists }             (does that checkpoint ref exist RIGHT NOW, in THIS repo? read-only, non-destructive)
const cp = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const ck = require('../lib/checkpoint.js');
const gitSafe = require('../lib/git-safe.js');

const repo = process.cwd();   // checkpoint.sh cd'd into the workspace repo before invoking node
// checkpoint-tool runs against a possibly-adopted workspace repo whose .git/config is not ours to
// trust — neutralize the same command-executing keys the shell sites already do. GIT_ASKPASS/SSH_ASKPASS are
// deleted once here (not by buildEnv, which only returns an additive object) so no inherited value survives.
delete process.env.GIT_ASKPASS;
delete process.env.SSH_ASKPASS;
// git runner bound to the repo; returns { code, stdout } and merges any env (e.g. GIT_INDEX_FILE) — matches
// the contract lib/checkpoint.js + its test expect.
function git(args, env) {
  try {
    const stdout = cp.execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: Object.assign({}, process.env, gitSafe.buildEnv(), env || {}), stdio: ['ignore', 'pipe', 'ignore'] });
    return { code: 0, stdout };
  } catch (e) { return { code: e.status || 1, stdout: e.stdout ? String(e.stdout) : '' }; }
}
const rmFile = (rel) => { try { fs.unlinkSync(path.join(repo, rel)); } catch {} };
// unique scratch index per invocation (each run is its own process → pid is unique) so concurrent turns/syncs
// hitting the same repo never share an index file.
const tmpIdx = () => path.join(os.tmpdir(), 'cl-ckpt-idx-' + process.pid);
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const validId = (x) => typeof x === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x);

function main() {
  const sub = process.argv[2];
  const id = process.argv[3];
  if (sub === 'snapshot') {
    if (!validId(id)) return emit({ ok: false, error: 'bad id' });
    const idx = tmpIdx();
    let sha = '';
    try { sha = ck.snapshot(git, id, idx); } finally { try { fs.unlinkSync(idx); } catch {} }
    return emit(sha ? { ok: true, id, sha } : { ok: false, error: 'snapshot failed' });
  }
  if (sub === 'restore') {
    if (!validId(id)) return emit({ ok: false, error: 'bad id' });
    if (!ck.resolve(git, id)) return emit({ ok: false, error: 'no such checkpoint' });
    // Capture the CURRENT tree to the 'undo' ref so the revert is reversible — but ONLY when reverting to a real
    // checkpoint (restoring 'undo' itself must not re-snapshot to 'undo', which would clobber the very state it's
    // about to restore → a self-erasing no-op; so "undo revert" is a clean one-level undo). We FORCE-include every
    // path the restore will overwrite (even now-gitignored ones) so the undo can bring them all back, and we ABORT
    // the whole revert if that safety snapshot fails — never destroy the worktree without a recoverable undo.
    if (id !== 'undo') {
      // Force-include ONLY the checkpoint paths that STILL EXIST on disk. `git add -f -- <paths>` aborts the whole
      // command (fatal pathspec) if ANY path is missing — and Claude routinely deletes/renames files between a
      // checkpoint and a revert — which would leave the precious now-ignored file in that chunk unstaged (the very
      // data loss this guards against). A since-deleted checkpoint path needs no force-add: restore recreates it
      // from the tree, and undo's `ls-files --others` cleans it up.
      const forcePaths = ck.treePaths(git, id).filter((p) => { try { return fs.existsSync(path.join(repo, p)); } catch { return false; } });
      const idx = tmpIdx();
      let undoSha = '';
      try { undoSha = ck.snapshot(git, 'undo', idx, forcePaths); } finally { try { fs.unlinkSync(idx); } catch {} }
      if (!undoSha) return emit({ ok: false, error: 'undo snapshot failed' });   // no safety net → refuse to revert
    }
    const res = ck.restore(git, id, rmFile);
    return emit(res.ok ? { ok: true, id, undo: id !== 'undo' ? 'undo' : null, removed: res.removed } : { ok: false, error: 'restore failed' });
  }
  if (sub === 'prune') {
    const keep = process.argv.slice(3).filter(validId);
    return emit({ ok: true, pruned: ck.prune(git, keep) });
  }
  if (sub === 'numstat') {
    const to = process.argv[4];
    if (!validId(id) || !validId(to)) return emit({ ok: false, error: 'bad id' });
    return emit({ ok: true, files: ck.numstat(git, id, to) });   // either ref unresolvable → files:[] (stats are best-effort, never an error)
  }
  if (sub === 'exists') {
    // C-8.2: lets a caller ask TRUTH — does this ref exist in THIS repo right now — without restoring anything.
    // Used before a revert to decide whether to warn that the single 'undo' slot is about to be replaced,
    // regardless of what any in-memory renderer flag remembers (that resets on drawer close / app restart).
    if (!validId(id)) return emit({ ok: false, error: 'bad id' });
    return emit({ ok: true, id, exists: !!ck.resolve(git, id) });
  }
  return emit({ ok: false, error: 'bad subcommand' });
}

try { main(); } catch (e) { emit({ ok: false, error: String((e && e.message) || e) }); }
