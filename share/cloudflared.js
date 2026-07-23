// Claudible — cloudflared launcher.
//   Wraps the LOCAL share server (loopback) in a free Cloudflare quick-tunnel so a remote colleague
//   on a different network can reach it. Nothing is hosted by us: cloudflared connects OUT from this
//   machine and hands back a https://<random>.trycloudflare.com URL.
//
//   Binary resolution (first that launches wins): CLAUDIBLE_CLOUDFLARED env → the winget install path
//   under %LOCALAPPDATA% → cloudflared.exe / cloudflared on PATH. The winget path is checked explicitly
//   because (a) a freshly-updated PATH doesn't reach an already-running shell, and (b) Node's spawn on
//   Windows won't auto-append .exe for a bare command name.
//
//   startCloudflared() does NOT return until the URL has been proven to serve — see verifyTunnel() below. The
//   banner cloudflared prints is a promise, not a fact, and shipping it unchecked is what hands a colleague a
//   dead link while the app reports "live".
//
//   probeCloudflared() is the detection-grade twin of startCloudflared(): same candidates, same order, so
//   a dep row that says "ready" means "THIS process can launch it" — never "a binary exists somewhere". The
//   wsl runner overrides its guest-side preflight row with this probe precisely because those two statements
//   used to diverge (a Linux cloudflared inside WSL kept the row green while every spawn here ENOENT'd).
'use strict';
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const dns = require('dns');

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
  // The official Windows .msi installs here, NOT under %LOCALAPPDATA%, so the winget shortcut above never
  // covered it and we fell through to a bare PATH lookup. That lookup uses the PATH Electron INHERITED at
  // launch: install cloudflared while the app is open (or in any session that started before the installer
  // touched PATH) and the spawn fails with ENOENT even though `where cloudflared` finds it in a fresh shell.
  // The failure is silent — share:start still returns ok with a 127.0.0.1 URL — so the user hands a
  // collaborator a link pointing at the collaborator's own machine. Same reasoning as the winget entry:
  // check the deterministic location before trusting PATH.
  for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files', 'C:\\Program Files (x86)']) {
    if (!root) continue;
    const mp = path.join(root, 'cloudflared', 'cloudflared.exe');
    if (!list.includes(mp) && fs.existsSync(mp)) list.push(mp);
  }
  list.push('cloudflared.exe', 'cloudflared');
  return list;
}

// Try to launch one binary; resolves {ok:true,proc} once the OS confirms spawn, else {ok:false,err}.
function spawnCandidate(bin, port) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = cp.spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { windowsHide: true });   // 127.0.0.1 (not localhost) to match the share server's IPv4 bind — avoids localhost→::1 → unreachable origin/502 on dual-stack hosts
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
      if (url && registered) finish(resolve, { proc, url, registered: true });
    };
    proc.stdout && proc.stdout.on('data', scan);
    proc.stderr && proc.stderr.on('data', scan);   // cloudflared logs to stderr
    proc.on('exit', (code) => finish(reject, new Error('cloudflared exited (code ' + code + ') before a tunnel URL appeared')));
    const timer = setTimeout(() => {
      // A URL with no registration line is NOT proof of a routable tunnel. Hand it back flagged, and let
      // startCloudflared decide — it now demands positive DNS confirmation before shipping an unregistered URL.
      if (url) return finish(resolve, { proc, url, registered: false });
      try { proc.kill(); } catch {}
      finish(reject, new Error('timed out waiting for the cloudflared tunnel URL'));
    }, timeoutMs);
  });
}

// ---- PROVE THE LINK BEFORE HANDING IT OUT --------------------------------------------------------------
// A quick tunnel that PRINTS a hostname is not a quick tunnel that SERVES it, and the gap between the two is a
// trap with a 30-minute blast radius. MEASURED on this build of cloudflared, from one run:
//
//     +5.5s  cloudflared prints https://<name>.trycloudflare.com
//     +6.3s  "Registered tunnel connection"      <- the app used to reveal the link HERE
//     +8.7s  the A record for <name> actually exists in Cloudflare DNS
//
// Those middle ~2.4 seconds are the bug. The host is handed a link, clicks it to check it works, and their
// resolver answers NXDOMAIN because the record does not exist yet. And `trycloudflare.com`'s SOA minimum — the
// negative-cache TTL — is 1800 seconds. So ONE premature lookup poisons that machine's DNS cache against that
// hostname for HALF AN HOUR. The link never recovers, a freshly minted link walks into the same trap, and both
// host and guest see nothing but "site can't be reached" while the app insists the share is live.
//
// So verification here is not merely "check before showing". It must check WITHOUT BEING THE THING THAT POISONS
// THE CACHE, which rules out simply retrying a normal lookup until it works. Three stages:
//
//   1. GRACE — a short wait after registration. Cheap insurance on networks that hijack outbound DNS, where
//      stage 2 cannot bypass the caching resolver.
//   2. AUTHORITATIVE — ask Cloudflare's own nameservers for the zone directly. Authoritative servers do not
//      cache, so a "not yet" answer here costs nothing and can be repeated freely until the record appears.
//   3. HTTPS — only once stage 2 says the record exists, dial the real URL through the ORDINARY system
//      resolver. This proves the whole path end to end, and because the record now exists it warms the local
//      cache POSITIVELY — the host's browser inherits a good answer instead of a poisoned one.
//
// The stage-3 request asks for '/' with NO ?t= token on purpose. Our server answers that 403, which is a PASS:
// it proves a request crossed the edge, reached this machine, and was handled by us (X-Claudible-Share). Being
// token-free also means the probe can never consume or invalidate the one-time link about to be handed out.
const PROBE_HEADER = 'x-claudible-share';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The registrable zone — 'foo-bar.trycloudflare.com' → 'trycloudflare.com'. Derived, not hardcoded, so a change
// of tunnel domain doesn't silently send every query to the wrong nameservers.
function zoneOf(host) { return String(host).split('.').slice(-2).join('.'); }

// PUBLIC bootstrap resolvers, set EXPLICITLY. This line is the whole bug fix: a bare `new dns.Resolver()`
// inherits the OS resolver config, and inside Electron (42 / Node 24 on Windows) c-ares comes up with NO
// servers configured, so every query dies instantly with ECONNREFUSED. Plain Node on the same machine works,
// which is exactly why this passed review and still shipped broken — the whole authoritative stage was inert
// in the app, and verification silently fell through to the OS-resolver probe it was written to avoid.
const BOOTSTRAP_DNS = ['1.1.1.1', '8.8.8.8'];
// IPs of the zone's authoritative nameservers. Safe to cache-miss: NS records are long-lived and exist well
// before any tunnel does, so this lookup can never NXDOMAIN the way the tunnel hostname can.
async function authoritativeServers(host) {
  const r = new dns.promises.Resolver({ timeout: 3000, tries: 1 });
  r.setServers(BOOTSTRAP_DNS);
  const names = await r.resolveNs(zoneOf(host));
  const ips = [];
  for (const n of names) { try { ips.push(...(await r.resolve4(n))); } catch {} }
  return ips;
}
// Fallback existence check for networks that block outbound port 53 (hotel/corporate Wi-Fi, some VPNs): ask
// Cloudflare's resolver over HTTPS instead. Rides the same transport we already know works, and — like the
// authoritative query — it answers WITHOUT touching this machine's resolver cache, so it cannot poison it.
// Returns true (exists) / false (NXDOMAIN) / null (couldn't ask).
function dohHasRecord(host, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false, req = null;
    const done = (v) => { if (settled) return; settled = true; try { req && req.destroy(); } catch {} resolve(v); };
    try {
      req = https.request('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(host) + '&type=A',
        { headers: { accept: 'application/dns-json' }, timeout: timeoutMs || 4000 }, (res) => {
          let body = '';
          res.on('data', (c) => { body += c; if (body.length > 64 * 1024) done(null); });
          res.on('end', () => {
            try { const j = JSON.parse(body); done(j.Status === 0 ? (j.Answer || []).length > 0 : (j.Status === 3 ? false : null)); }
            catch { done(null); }
          });
        });
    } catch { return resolve(null); }
    req.on('timeout', () => done(null));
    req.on('error', () => done(null));
    req.end();
  });
}

// Stage 2. Resolves {ok, ms, tries, ips} once the record exists at the source, or {ok:false, why} on timeout.
// `unavailable:true` distinguishes "we could not ask" (blocked port 53, hijacked DNS) from "we asked and the
// record is not there" — the caller must not treat the former as a broken tunnel.
async function awaitDnsRecord(host, budgetMs, gapMs) {
  const t0 = Date.now();
  // Two independent ways to ask, both cache-free. c-ares straight to the zone's own nameservers is the primary;
  // DNS-over-HTTPS is the fallback for networks that block outbound 53. If BOTH are unreachable we say so
  // (unavailable) rather than pretending the record is missing.
  let r = null;
  try {
    const servers = await authoritativeServers(host);
    if (servers.length) { r = new dns.promises.Resolver({ timeout: 3000, tries: 1 }); r.setServers(servers); }
  } catch { r = null; }
  let tries = 0, answered = false, lastCode = 'none';
  while (Date.now() - t0 < budgetMs) {
    tries++;
    if (r) {
      try { const ips = await r.resolve4(host); answered = true; if (ips && ips.length) return { ok: true, via: 'authoritative', ms: Date.now() - t0, tries, ips }; }
      catch (e) {
        lastCode = (e && e.code) || 'unknown';
        // NXDOMAIN/NODATA = a real answer meaning "not published yet" — keep asking, it costs nothing.
        if (lastCode === 'ENOTFOUND' || lastCode === 'ENODATA' || lastCode === 'NXDOMAIN') answered = true;
        else r = null;   // refused/timeout/no servers → this channel is dead, stop paying for it and let DoH carry
      }
    }
    if (!r) {
      const doh = await dohHasRecord(host, 4000);
      if (doh === true) return { ok: true, via: 'doh', ms: Date.now() - t0, tries, ips: [] };
      if (doh === false) answered = true;                 // a real NXDOMAIN from Cloudflare's own resolver
      else if (!answered) lastCode = lastCode === 'none' ? 'doh-unreachable' : lastCode;
    }
    if (Date.now() - t0 + gapMs >= budgetMs) break;
    await sleep(gapMs);
  }
  return answered
    ? { ok: false, ms: Date.now() - t0, tries, why: 'no A record after ' + tries + ' cache-free queries over ' + Math.round((Date.now() - t0) / 1000) + 's' }
    : { ok: false, unavailable: true, ms: Date.now() - t0, tries, why: 'no cache-free way to check DNS from here (' + lastCode + ')' };
}

// Stage 3. One end-to-end HTTPS request through the SYSTEM resolver.
function probeOnce(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    const done = (r) => { if (settled) return; settled = true; try { req && req.destroy(); } catch {} resolve(r); };
    try {
      req = https.request(url, { method: 'GET', timeout: timeoutMs, headers: { 'User-Agent': 'claudible-tunnel-probe' } }, (res) => {
        res.resume();                                    // drain: never leave the socket half-read
        if (String(res.headers[PROBE_HEADER] || '') === '1') return done({ ok: true, status: res.statusCode });
        // Answered, but not by us. 5xx here is the ordinary "edge is up, route isn't live yet" shape —
        // Cloudflare's own 1033 "tunnel error" page is a 530, a dead origin is a 502.
        done({ ok: false, why: 'HTTP ' + res.statusCode + (res.statusCode >= 500 ? ' from the Cloudflare edge — the tunnel route is not live yet' : ' from something that is not this Claudible') });
      });
    } catch (e) { return resolve({ ok: false, why: (e && e.message) || 'probe failed' }); }
    req.on('timeout', () => done({ ok: false, why: 'no answer within ' + timeoutMs + 'ms' }));
    req.on('error', (e) => done({ ok: false, code: (e && e.code) || '', why: (e && e.code) || (e && e.message) || 'probe failed' }));
    req.end();
  });
}

// The whole check. Never throws. Resolves {ok, ...} — and on ok:true, `localDns:false` means the tunnel is
// genuinely good for remote guests but THIS machine still can't resolve it (an already-poisoned cache from an
// earlier premature click). That is a real and different situation from a broken tunnel: the link is safe to
// send, it just won't open here until the cache expires or is flushed.
async function verifyTunnel(url, opts = {}) {
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  if (!host) return { ok: false, why: 'unparseable tunnel URL' };
  const t0 = Date.now();
  await sleep(opts.graceMs == null ? 3000 : opts.graceMs);
  // 45s, not the ~5s publication this usually takes: MEASURED runs land at +3s to +5s after the URL, but one run
  // during a burst of tunnel creation had still not published at 25s. Waiting is cheap and only happens on the
  // slow path; giving up early means telling a host their working tunnel is local-only.
  const d = await awaitDnsRecord(host, opts.dnsMs || 45000, opts.dnsGapMs || 1500);
  // A cache-free source said the record does NOT exist. That is the one genuinely damning verdict: the hostname
  // is not routable and the link would be a dud.
  if (!d.ok && !d.unavailable) return { ok: false, published: false, stage: 'dns', ms: Date.now() - t0, tries: d.tries || 0, why: d.why };
  // Record exists (or we couldn't ask). Now the end-to-end probe — but its failure is NOT authoritative about
  // the tunnel: it goes through THIS machine's resolver, which may hold a stale negative from an earlier click.
  // A guest on another network is unaffected by that, so a probe failure downgrades confidence, never the link.
  const httpBudget = opts.verifyMs || 12000, gapMs = opts.verifyGapMs || 1500;
  const tHttp = Date.now();
  let last = { ok: false, why: 'never probed' }, tries = 0;
  while (Date.now() - tHttp < httpBudget) {
    tries++;
    last = await probeOnce(url, Math.max(1500, Math.min(5000, httpBudget - (Date.now() - tHttp))));
    if (last.ok) return { ok: true, published: !!d.ok, reachable: true, via: d.via || null, ms: Date.now() - t0, dnsMs: d.ms || 0, tries, status: last.status };
    if (Date.now() - tHttp + gapMs >= httpBudget) break;
    await sleep(gapMs);
  }
  // Reachability unproven from here. Two very different situations:
  //   • DNS confirmed the record → the link is live; only THIS machine can't see it (stale cache). Ship it.
  //   • We couldn't check DNS at all → we know nothing. Ship it only if the caller has other evidence
  //     (cloudflared registered with the edge); startCloudflared decides, not us.
  return { ok: true, published: !!d.ok, reachable: false, via: d.via || null, ms: Date.now() - t0, dnsMs: d.ms || 0, tries,
    why: d.ok ? ('the tunnel is published but this machine cannot resolve it yet (' + (last.code || last.why) + ')')
              : ('could not confirm the link from this machine (' + d.why + ')') };
}

// Resolves { proc, url, verify }; rejects with a clear message if no binary launches, no URL appears, or the URL
// that appears doesn't actually serve. A rejection here is NOT fatal to sharing: both callers fall back to the
// loopback link and arm the background retry, which is the honest state — a link that works on this machine only.
async function startCloudflared(port, opts = {}) {
  const timeoutMs = opts.timeoutMs || 20000;
  let lastErr = null;
  for (const bin of candidates(opts)) {
    const r = await spawnCandidate(bin, port);
    if (!r.ok) { lastErr = r.err; continue; }            // ENOENT etc → try the next candidate
    let got;
    try { got = await awaitUrl(r.proc, timeoutMs); }     // launched OK → this is our binary
    catch (e) { try { r.proc.kill(); } catch {} throw e; } // launched but no URL → a runtime issue, don't retry others
    // Escape hatch for the one network where the probe could be a false negative (egress that reaches Cloudflare
    // but not back in through it). Named in the failure message below so it's discoverable when it's needed.
    if (opts.verify === false || process.env.CLAUDIBLE_SKIP_TUNNEL_VERIFY === '1') { got.verify = { ok: true, skipped: true, ms: 0, tries: 0 }; return got; }
    const v = await verifyTunnel(got.url, opts);
    // THE DECISION TABLE. What matters is what we actually KNOW, not whether one probe happened to succeed:
    //
    //   DNS says NO RECORD          → dud. Kill it. (the only damning verdict)
    //   registered + DNS confirms   → ship, confirmed
    //   registered + probe worked   → ship, confirmed
    //   registered + can't confirm  → SHIP with an advisory. A failed probe goes through THIS machine's
    //                                 resolver; it says nothing about a guest on another network, and the edge
    //                                 acknowledged the route. Substituting a 127.0.0.1 link here would MANUFACTURE
    //                                 the very dud this check exists to prevent — which is what it used to do.
    //   NOT registered + confirmed  → ship (DNS is independent proof)
    //   NOT registered + unconfirmed→ dud. Kill it. A URL banner alone proves nothing.
    //
    const confirmed = !!(v.published || v.reachable);
    if (!v.ok || (!got.registered && !confirmed)) {
      try { got.proc.kill(); } catch {}
      const err = new Error(!v.ok
        ? ('Cloudflare never published DNS for this tunnel (' + v.why + ') after ' + Math.round(v.ms / 1000) + 's')
        : ('the tunnel never registered with Cloudflare and could not be confirmed (' + v.why + ')'));
      err.verify = v; err.reason = 'unverified';
      throw err;
    }
    got.verify = Object.assign({ confirmed }, v);
    return got;
  }
  // Distinguish "not installed" from "wouldn't start". The caller shows an install prompt ONLY for the former —
  // offering "Install cloudflared" to someone who already has it (because a probe timed out) is the false alarm
  // this whole pass exists to kill.
  const missing = !!(lastErr && lastErr.code === 'ENOENT');
  const err = new Error(missing
    ? 'cloudflared is not installed — install it (winget install Cloudflare.cloudflared) or set CLAUDIBLE_CLOUDFLARED to its path'
    : ('could not launch cloudflared' + (lastErr ? ': ' + lastErr.message : '')));
  err.reason = missing ? 'missing' : 'launch-failed';
  throw err;
}

// One candidate, detection-grade: does `<bin> --version` actually run HERE? Async execFile — this feeds
// detectDeps(), which the wsl/posix flavors re-run on a 3s poll while the Connect-Claude popup is open; a
// sync probe would freeze the whole main process (pty I/O + every IPC) for up to the timeout each tick.
// The timeout is mandatory for a different reason: without it a hung binary leaves detectDeps()'s promise
// pending forever and the System-check spinner never resolves.
function probeOne(bin) {
  return new Promise((resolve) => {
    try {
      cp.execFile(bin, ['--version'], { timeout: 4000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);                       // ENOENT / non-zero / timeout → not launchable here
        const m = String(stdout).match(/\d+\.\d+\.\d+/);
        resolve({ version: m ? m[0] : '' });
      });
    } catch { resolve(null); }
  });
}

// { installed, version, path } for the first candidate that launches. Never memoized — presence must flip
// both ways between polls (freshly installed mid-share, or removed), or the tunnel self-heal loop and the
// System-check could never see the state change they exist to react to.
async function probeCloudflared(opts = {}) {
  for (const bin of candidates(opts)) {
    const r = await probeOne(bin);
    if (r) return { installed: true, version: r.version, path: bin };
  }
  return { installed: false, version: '', path: '' };
}

module.exports = { startCloudflared, candidates, probeCloudflared, verifyTunnel };
