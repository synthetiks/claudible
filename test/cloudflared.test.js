// test/cloudflared.test.js — cloudflared resolution (share/cloudflared.js). The property under test: candidates()
// is the ONE source of truth for where cloudflared may live, and probeCloudflared() walks it in the exact order
// startCloudflared() spawns it — so a dep row saying "ready" can only ever mean "THIS process can launch it".
// (The wsl flavor shipped with detection probing the WSL guest while the spawner ran on the Windows host — green
// row, every spawn ENOENT.) Run: node test/cloudflared.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { candidates, probeCloudflared } = require('../share/cloudflared');

let pass = 0, fail = 0;
function ok(label, c) { c ? pass++ : (fail++, console.error('  FAIL ' + label)); }
function eq(label, a, b) { ok(label + ' (got ' + JSON.stringify(a) + ')', JSON.stringify(a) === JSON.stringify(b)); }

// The exact winget layout candidates() checks under %LOCALAPPDATA% — must stay in lockstep with WINGET_REL.
const WINGET_REL = path.join('Microsoft', 'WinGet', 'Packages',
  'Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe', 'cloudflared.exe');

// Env is process-global state — every block below snapshots and restores it, so a dev box that really has
// cloudflared on PATH (or CLAUDIBLE_CLOUDFLARED exported) can never flake these assertions.
const SAVED = { CLAUDIBLE_CLOUDFLARED: process.env.CLAUDIBLE_CLOUDFLARED, LOCALAPPDATA: process.env.LOCALAPPDATA, PATH: process.env.PATH };
function restore() { for (const k of Object.keys(SAVED)) { if (SAVED[k] == null) delete process.env[k]; else process.env[k] = SAVED[k]; } }

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'claudible-cf-'));
function fakeBin(rel, out) {   // a launchable stand-in: prints what a real `cloudflared --version` would
  const p = path.join(scratch, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '#!/bin/sh\necho "' + out + '"\n', { mode: 0o755 });
  return p;
}

// ---- candidates(): order and membership ----
{
  delete process.env.CLAUDIBLE_CLOUDFLARED; delete process.env.LOCALAPPDATA;
  eq('bare fallbacks only, PATH names last', candidates({}), ['cloudflared.exe', 'cloudflared']);
  process.env.CLAUDIBLE_CLOUDFLARED = '/env/cf';
  eq('env candidate leads when set', candidates({})[0], '/env/cf');
  eq('opts.bin REPLACES env (explicit override, not a longer list)', candidates({ bin: '/opt/cf' })[0], '/opt/cf');
  ok('…and the env value is then absent entirely', !candidates({ bin: '/opt/cf' }).includes('/env/cf'));
  restore();
}
{
  // LOCALAPPDATA winget path joins only when the file EXISTS (deterministic beats PATH-propagation lag),
  // ordered after the env override and before the bare PATH names.
  delete process.env.CLAUDIBLE_CLOUDFLARED;
  process.env.LOCALAPPDATA = path.join(scratch, 'lad-empty');
  eq('winget path absent from list when the exe does not exist', candidates({}), ['cloudflared.exe', 'cloudflared']);
  const wingetExe = fakeBin(path.join('lad', WINGET_REL), 'cloudflared version 9.9.9');
  process.env.LOCALAPPDATA = path.join(scratch, 'lad');
  eq('winget path present when the exe exists', candidates({}), [wingetExe, 'cloudflared.exe', 'cloudflared']);
  process.env.CLAUDIBLE_CLOUDFLARED = '/env/cf';
  eq('env still outranks the winget path', candidates({}), ['/env/cf', wingetExe, 'cloudflared.exe', 'cloudflared']);
  restore();
}

// ---- probeCloudflared(): launch-based, falls through dead candidates, never throws ----
// The fixtures are shell scripts, so the exec cases are posix-only (CI is ubuntu; the win flavor exercises the
// real binary via its own detection path). The pure candidates() cases above run everywhere.
(async () => {
  if (process.platform !== 'win32') {
    {
      const bin = fakeBin('ok/cloudflared', 'cloudflared version 1.2.3 (built 2026-01-01)');
      const r = await probeCloudflared({ bin });
      eq('launchable candidate → installed with parsed version', r, { installed: true, version: '1.2.3', path: bin });
    }
    {
      // a dead opts.bin must FALL THROUGH to the next candidate (same resilience startCloudflared has), here
      // the fabricated winget install — proving detection survives a stale CLAUDIBLE_CLOUDFLARED override.
      delete process.env.CLAUDIBLE_CLOUDFLARED;
      process.env.LOCALAPPDATA = path.join(scratch, 'lad');   // winget exe fabricated in the block above
      const r = await probeCloudflared({ bin: path.join(scratch, 'no-such-binary') });
      ok('dead override falls through to the winget candidate', r.installed === true && r.path === path.join(scratch, 'lad', WINGET_REL));
      restore();
    }
    {
      const bin = fakeBin('odd/cloudflared', 'cloudflared version unknown');
      const r = await probeCloudflared({ bin });
      ok('launchable but unparseable version → installed, version empty', r.installed === true && r.version === '');
    }
    {
      // nothing anywhere: no override, no env, no winget file, PATH pointed at an empty dir → clean negative,
      // not a throw (a crash in this one probe used to be able to blank the whole System-check list).
      delete process.env.CLAUDIBLE_CLOUDFLARED; delete process.env.LOCALAPPDATA;
      process.env.PATH = path.join(scratch, 'empty-path');
      fs.mkdirSync(process.env.PATH, { recursive: true });
      const r = await probeCloudflared({});
      eq('nothing launchable → clean installed:false', r, { installed: false, version: '', path: '' });
      restore();
    }
  }

  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
  console.log('cloudflared: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
