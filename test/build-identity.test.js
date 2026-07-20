// test/build-identity.test.js — lib/buildIdentity.js readGitSha(): the running build's honest identity.
// package.json's version doesn't move between releases, so it can't distinguish unreleased builds — the sha
// can. Fixtures cover: symbolic ref (normal checkout), detached HEAD, packed-refs (gc'd repo), and garbage.
// Run: node test/build-identity.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readGitSha } = require('../lib/buildIdentity.js');

let pass = 0, fail = 0;
const ok = (label, c) => { c ? pass++ : (fail++, console.error('  FAIL ' + label)); };

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
function mk(layout) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-build-'));
  const g = path.join(dir, '.git');
  fs.mkdirSync(g, { recursive: true });
  for (const [rel, content] of Object.entries(layout)) {
    const f = path.join(g, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
  return dir;
}

{
  const d = mk({ 'HEAD': 'ref: refs/heads/main\n', 'refs/heads/main': SHA + '\n', 'logs/HEAD': 'x\n' });
  const r = readGitSha(d);
  ok('symbolic ref resolves', r && r.sha === SHA);
  ok('short is 12 hex', r && r.short === SHA.slice(0, 12));
  ok('at comes from logs/HEAD mtime', r && r.at > 0);
  fs.rmSync(d, { recursive: true, force: true });
}
{
  const d = mk({ 'HEAD': SHA.toUpperCase() + '\n' });
  const r = readGitSha(d);
  ok('detached HEAD resolves (case-normalized)', r && r.sha === SHA);
  fs.rmSync(d, { recursive: true, force: true });
}
{
  const d = mk({ 'HEAD': 'ref: refs/heads/main\n', 'packed-refs': '# pack-refs with: peeled fully-peeled sorted\n' + SHA + ' refs/heads/main\n' });
  const r = readGitSha(d);
  ok('packed-refs fallback resolves a gc-d loose ref', r && r.sha === SHA);
  fs.rmSync(d, { recursive: true, force: true });
}
{
  const d = mk({ 'HEAD': 'ref: refs/heads/main\n', 'refs/heads/main': 'not-a-sha\n' });
  ok('garbage ref → null, never a throw', readGitSha(d) === null);
  fs.rmSync(d, { recursive: true, force: true });
}
ok('missing repo → null', readGitSha(path.join(os.tmpdir(), 'cl-definitely-absent-' + Date.now())) === null);
ok('this repo self-identifies', (() => { const r = readGitSha(path.resolve(__dirname, '..')); return r && /^[0-9a-f]{40}$/.test(r.sha); })());

console.log(`build-identity: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
