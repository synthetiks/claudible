'use strict';
// Claudible — the WSL-side adapter that runs lib/coauthorHook.js (C-10.6) against the REAL workspace repo.
// coauthor-hook.sh cd's into the repo and invokes this; the hooks dir + git dir are resolved here via git
// itself (`--git-path hooks` / `--git-dir`), never assumed to be `.git/hooks` — core.hooksPath can move it.
// Emits ONE JSON line for main.js.
//   sync <b64Entries>  -> installs/refreshes the hook (only when entries decode to >=1 usable line) and
//                          (re)writes the coauthors file. Entries that resolve to ZERO lines just clear the
//                          file — the hook stays installed (so it wakes up the instant another guest joins)
//                          but goes quiet: a solo commit gets no trailer (C-10.6).
//   uninstall          -> reverses install() (restores any backed-up foreign hook, or removes our own fresh
//                          one) and clears the coauthors file.
const cp = require('child_process');
const path = require('path');
const ch = require('../lib/coauthorHook.js');

const repo = process.cwd();   // coauthor-hook.sh cd'd into the workspace repo before invoking node
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');

// Resolve the git dir + hooks dir FOR THIS REPO via git plumbing — not a hardcoded `.git/hooks` guess, so a
// repo with core.hooksPath pointed elsewhere (or a worktree, whose git dir is a file, not a folder) still
// gets the real paths.
function gitDirs() {
  const gitDirRaw = cp.execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repo, encoding: 'utf8' }).trim();
  const gitDirAbs = path.isAbsolute(gitDirRaw) ? gitDirRaw : path.join(repo, gitDirRaw);
  let hooksRel = '';
  try { hooksRel = cp.execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: repo, encoding: 'utf8' }).trim(); } catch {}
  const hooksDir = hooksRel ? (path.isAbsolute(hooksRel) ? hooksRel : path.join(repo, hooksRel)) : path.join(gitDirAbs, 'hooks');
  return { gitDirAbs, hooksDir };
}

function decodeEntries(b64) {
  try {
    const j = JSON.parse(Buffer.from(String(b64 || ''), 'base64').toString('utf8'));
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

function main() {
  const sub = process.argv[2];
  let dirs;
  try { dirs = gitDirs(); } catch { return emit({ ok: false, error: 'not a git repo' }); }
  if (sub === 'sync') {
    const entries = decodeEntries(process.argv[3]);
    const { lines, skipped } = ch.buildCoauthorLines(entries);
    if (lines.length) {
      const r = ch.install(dirs.hooksDir);
      if (!r.ok) return emit({ ok: false, error: r.error || 'install failed' });
      ch.writeCoauthorsFile(dirs.gitDirAbs, lines);
      return emit({ ok: true, active: lines.length, skipped, chained: !!r.chained });
    }
    ch.writeCoauthorsFile(dirs.gitDirAbs, []);   // nobody with a usable identity right now -> quiet, hook left in place
    return emit({ ok: true, active: 0, skipped });
  }
  if (sub === 'uninstall') {
    const r = ch.uninstall(dirs.hooksDir);
    ch.writeCoauthorsFile(dirs.gitDirAbs, []);
    return emit(r.ok ? { ok: true, restored: !!r.restored } : { ok: false, error: r.error });
  }
  return emit({ ok: false, error: 'bad subcommand' });
}

try { main(); } catch (e) { emit({ ok: false, error: String((e && e.message) || e) }); }
