// scripts/ensure-build-sha.js — guarantees build-sha.txt exists before electron-builder packages the app.
// C-10.1: build-sha.txt is the packaged build's commit identity, read back by lib/buildIdentity.js's
// readPackagedBuildSha() (readGitSha() can't answer this for a packaged install — package.json's "files"
// deliberately excludes .git). build.yml's "Write packaged build SHA" step already writes the real sha
// before this ever runs in CI — this is only a local-dev fallback (`npm run dist:*` outside CI) so
// packaging never trips over a literal file the "files" allowlist expects but a plain checkout never made.
// Best-effort: on any failure the packaged build simply ships without a sha file, exactly like a source
// checkout — readPackagedBuildSha() degrades to null, no crash anywhere downstream.
'use strict';
const fs = require('fs');
const path = require('path');

// The file must exist EITHER WAY once this returns — package.json's "files" list names it literally, and
// an electron-builder run over a missing literal entry is not a risk worth taking. An empty file is exactly
// as harmless to readPackagedBuildSha() as a missing one (its regex just fails to match either way).
const target = path.join(__dirname, '..', 'build-sha.txt');
if (fs.existsSync(target)) process.exit(0);   // CI (or a previous run) already wrote the real one — never overwrite it
try {
  const sha = require('child_process').execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  fs.writeFileSync(target, /^[0-9a-f]{7,40}$/i.test(sha) ? sha + '\n' : '');
} catch {
  try { fs.writeFileSync(target, ''); } catch {}   // no git / not a repo / read-only dir — still leave an empty file behind
}
