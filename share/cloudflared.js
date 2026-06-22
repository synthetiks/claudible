// Claudible — cloudflared launcher.
//   Wraps the LOCAL share server (loopback) in a free Cloudflare quick-tunnel so a remote colleague
//   on a different network can reach it. Nothing is hosted by us: cloudflared connects OUT from this
//   machine and hands back a https://<random>.trycloudflare.com URL.
//
//   Binary resolution (first that launches wins): CLAUDIBLE_CLOUDFLARED env → the winget install path
//   under %LOCALAPPDATA% → cloudflared.exe / cloudflared on PATH. The winget path is checked explicitly
//   because (a) a freshly-updated PATH doesn't reach an already-running shell, and (b) Node's spawn on
//   Windows won't auto-append .exe for a bare command name.
'use strict';
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
// Stable winget package id — same for every user, only %LOCALAPPDATA% differs.
const WINGET_REL = path.join('Microsoft', 'WinGet', 'Packages',
  'Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe', 'cloudflared.exe');

function candidates(opts) {
  const list = [];
  const envBin = opts.bin || process.env.CLAUDIBLE_CLOUDFLARED;
  if (envBin) list.push(envBin);
  if (process.env.LOCALAPPDATA) {
    const wp = path.join(process.env.LOCALAPPDATA, WINGET_REL);
    if (fs.existsSync(wp)) list.push(wp);   // deterministic, beats PATH-propagation lag
  }
  list.push('cloudflared.exe', 'cloudflared');
  return list;
}

// Try to launch one binary; resolves {ok:true,proc} once the OS confirms spawn, else {ok:false,err}.
function spawnCandidate(bin, port) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = cp.spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { windowsHide: true });
    } catch (e) { return resolve({ ok: false, err: e }); }
    let done = false;
    proc.once('spawn', () => { if (!done) { done = true; resolve({ ok: true, proc }); } });
    proc.once('error', (e) => { if (!done) { done = true; resolve({ ok: false, err: e }); } });
  });
}

// Wait until cloudflared both PRINTS the URL and REGISTERS the connection — the URL banner appears a
// few seconds before the edge route is live, so handing it back too early yields 5xx pages. We resolve
// on (url && registered); on timeout we degrade to url-only (usable, just maybe not instantly routable).
const REGISTERED_RE = /Registered tunnel connection/i;
function awaitUrl(proc, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false, buf = '', url = null, registered = false;
    const finish = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); try { proc.stdout && proc.stdout.removeListener('data', scan); proc.stderr && proc.stderr.removeListener('data', scan); } catch {} buf = ''; fn(arg); };   // detach scanners + drop the growing log buffer once resolved (leak fix)
    const scan = (chunk) => {
      buf += chunk.toString();
      if (!url) { const m = buf.match(URL_RE); if (m) url = m[0]; }
      if (!registered && REGISTERED_RE.test(buf)) registered = true;
      if (url && registered) finish(resolve, { proc, url });
    };
    proc.stdout && proc.stdout.on('data', scan);
    proc.stderr && proc.stderr.on('data', scan);   // cloudflared logs to stderr
    proc.on('exit', (code) => finish(reject, new Error('cloudflared exited (code ' + code + ') before a tunnel URL appeared')));
    const timer = setTimeout(() => {
      if (url) return finish(resolve, { proc, url });   // got a URL but no registration line — hand it back anyway
      try { proc.kill(); } catch {}
      finish(reject, new Error('timed out waiting for the cloudflared tunnel URL'));
    }, timeoutMs);
  });
}

// Resolves { proc, url }; rejects with a clear message if no binary launches or no URL appears.
async function startCloudflared(port, opts = {}) {
  const timeoutMs = opts.timeoutMs || 20000;
  let lastErr = null;
  for (const bin of candidates(opts)) {
    const r = await spawnCandidate(bin, port);
    if (!r.ok) { lastErr = r.err; continue; }            // ENOENT etc → try the next candidate
    try { return await awaitUrl(r.proc, timeoutMs); }    // launched OK → this is our binary
    catch (e) { try { r.proc.kill(); } catch {} throw e; } // launched but no URL → a runtime issue, don't retry others
  }
  const hint = (lastErr && lastErr.code === 'ENOENT')
    ? 'cloudflared not found — install it (winget install Cloudflare.cloudflared) or set CLAUDIBLE_CLOUDFLARED to its path'
    : ('could not launch cloudflared' + (lastErr ? ': ' + lastErr.message : ''));
  throw new Error(hint);
}

module.exports = { startCloudflared };
