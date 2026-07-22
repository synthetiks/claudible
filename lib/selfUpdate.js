'use strict';
// Self-update for CLONE installs — the machinery behind the drift chip's "Update & restart" button.
// Clone installs have no other update path: the packaged-build checker never runs for them, and
// install.ps1's own pull silently skips dirty trees — which is exactly how two collaborators spent a day
// on different builds with zero signal. Everything here runs HOST-side against the app's own directory
// (plain child_process, same as lib/buildIdentity.js — the WSL/git-bash runner is the wrong execution
// context for the app's own checkout, see docs/SEAMS.md). Policy: NOTHING here mutates without an explicit
// user click, a dirty tree is REFUSED with the evidence (never auto-stashed), and failures return typed
// results — the caller decides what to show.
const { execFile, spawn } = require('child_process');

const GIT_TIMEOUT = 30000;

function git(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function gitOk(cwd) { return !(await git(['--version'], cwd)).err; }
async function isDirty(cwd) {
  const r = await git(['status', '--porcelain'], cwd);
  if (r.err) return { err: r.stderr || r.err.message };
  return { dirty: r.stdout.trim().length > 0, detail: r.stdout.trim().slice(0, 500) };
}
async function currentSha(cwd) {
  const r = await git(['rev-parse', 'HEAD'], cwd);
  return r.err ? '' : r.stdout.trim();
}

// One ff-only pull, classified: {ok} | {ok:false, kind:'non-ff'|'offline'|'no-branch'|'git', detail}
async function pull(cwd) {
  const r = await git(['pull', '--ff-only'], cwd);
  if (!r.err) return { ok: true };
  const s = (r.stderr + '\n' + (r.err.message || '')).slice(0, 2000);
  if (/not possible to fast-forward|fast-forward/i.test(s)) return { ok: false, kind: 'non-ff', detail: s };
  if (/could not resolve host|unable to access|timed out|Connection refused/i.test(s)) return { ok: false, kind: 'offline', detail: s };
  if (/not currently on any branch|no tracking information/i.test(s)) return { ok: false, kind: 'no-branch', detail: s };
  return { ok: false, kind: 'git', detail: s };
}

// Recover a DIVERGED clone install (upstream history was rewritten — e.g. a force-push — so ff-only
// refuses and `git pull` is a dead end forever). An app checkout holds no work of the user's: the caller
// has already proven the tree is clean, so snapping to the upstream tip is exactly what a human would do
// by hand, and is the difference between the app healing itself and someone running git commands.
// Deliberately NOT reachable with a dirty tree — that check stays the caller's gate.
async function resetToUpstream(cwd) {
  const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const branch = head.err ? '' : head.stdout.trim();
  if (!branch || branch === 'HEAD') return { ok: false, detail: 'not on a branch' };
  const f = await git(['fetch', 'origin', branch], cwd);
  if (f.err) return { ok: false, detail: (f.stderr || '').slice(-300) };
  const r = await git(['reset', '--hard', 'origin/' + branch], cwd);
  if (r.err) return { ok: false, detail: (r.stderr || '').slice(-300) };
  return { ok: true };
}

// Did the pull change anything npm cares about? Diffing BOTH manifest and lockfile catches transitive bumps
// a bare dependencies-object comparison would miss.
async function depsChanged(cwd, beforeSha, afterSha) {
  if (!beforeSha || !afterSha || beforeSha === afterSha) return false;
  const r = await git(['diff', '--name-only', beforeSha, afterSha, '--', 'package.json', 'package-lock.json'], cwd);
  return !r.err && r.stdout.trim().length > 0;
}

// The one dependency npm CANNOT safely reinstall under us: electron's dist binary IS the running process on
// a clone install — Windows refuses to overwrite an executing file, and a half-replaced runtime is worse.
// Detect the bump up front and refuse with a named instruction instead of a baffling npm error.
async function electronVersionChanged(cwd, beforeSha, afterSha) {
  const read = async (sha) => {
    const r = await git(['show', sha + ':package.json'], cwd);
    if (r.err) return null;
    try { return ((JSON.parse(r.stdout) || {}).devDependencies || {}).electron || ''; } catch { return null; }
  };
  const a = await read(beforeSha), b = await read(afterSha);
  return a != null && b != null && a !== b;
}

// npm install with line-streamed progress. onLine(msg) fires per output line; resolves {ok} or {ok:false, detail}.
function npmInstall(cwd, onLine) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install'], { cwd, windowsHide: true, shell: false });
    } catch (e) { return resolve({ ok: false, detail: e.message }); }
    const tail = [];
    const feed = (buf) => {
      for (const ln of String(buf).split(/\r?\n/)) {
        const t = ln.trim();
        if (!t) continue;
        tail.push(t); if (tail.length > 20) tail.shift();
        try { onLine && onLine(t); } catch {}
      }
    };
    child.stdout && child.stdout.on('data', feed);
    child.stderr && child.stderr.on('data', feed);
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 10 * 60 * 1000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, detail: e.message }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve(code === 0 ? { ok: true } : { ok: false, detail: tail.join('\n').slice(-1500) }); });
  });
}

module.exports = { gitOk, isDirty, currentSha, pull, resetToUpstream, depsChanged, electronVersionChanged, npmInstall };
