'use strict';
// Which COMMIT is this running app? package.json's version can't answer it — every unreleased fix ships
// under the same semver, which is exactly how two machines both saying "0.8.4" spent a day 5 commits apart
// with zero signal (the recurring live-latency goose chase). A git sha is the only honest identity for a
// clone-install. Pure fs on the fast path (this is read at boot and re-read on a timer — never spawn git
// per tick); a git subprocess only as the packed-refs fallback. Fail-soft: any surprise returns null and
// callers degrade to "unknown", never throw.
const fs = require('fs');
const path = require('path');

function readGitSha(dir) {
  try {
    const gitDir = path.join(dir, '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    let sha = '';
    if (/^[0-9a-f]{40}$/i.test(head)) {
      sha = head;                                            // detached HEAD
    } else if (head.startsWith('ref: ')) {
      const ref = head.slice(5).trim();
      try {
        sha = fs.readFileSync(path.join(gitDir, ...ref.split('/')), 'utf8').trim();
      } catch {
        // No loose ref file — the repo was gc'd into packed-refs. Try the pack, then a one-shot git.
        try {
          const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
          for (const ln of packed.split('\n')) {
            if (ln.endsWith(' ' + ref)) { sha = ln.slice(0, 40); break; }
          }
        } catch {}
        if (!sha) {
          try { sha = require('child_process').execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(); } catch {}
        }
      }
    }
    if (!/^[0-9a-f]{40}$/i.test(sha)) return null;
    let at = 0;
    try { at = fs.statSync(path.join(gitDir, 'logs', 'HEAD')).mtimeMs; } catch {}   // "when did the checkout last move" — the drift check compares against this
    return { sha: sha.toLowerCase(), short: sha.slice(0, 12).toLowerCase(), at };
  } catch { return null; }
}

module.exports = { readGitSha };
