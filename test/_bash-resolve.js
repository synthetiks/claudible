// test/_bash-resolve.js — resolve a REAL bash for the test harness itself (run-all.js's own *.sh steps,
// plus test/adopt-workspace.test.js and test/appdir-quoting.test.js, which shell out directly).
//
// Plain `bash` on PATH is not safe to spawn on win32: if WSL is installed, C:\Windows\System32\bash.exe (the
// WSL interop launcher) sits ahead of any real Git Bash on PATH. It either mangles a Windows-style path in its
// argv translation (backslashes vanish: `C:\Users\x\test\foo.sh` arrives as `C:Usersxtestfoo.sh`) or drops the
// argument into a WSL distro that has no notion of that path at all — see run-all.js's header for the exact
// symptom. Resolve MSYS (Git Bash) the same way runners/win.js already does for the app itself — reusing its
// probe/rejection so the two can never drift apart — and only fall back to WSL (translating any Windows-style
// path argument through `wsl.exe wslpath -a`, since that is the one conversion WSL's own argv translation is
// not trusted to do consistently) when no MSYS bash exists.
//
// Every non-win32 platform (ubuntu CI) never touches this file's win32 branch: resolve() there is `bash` as-is
// and toPath() is the identity, so behavior stays byte-identical to before this file existed.
'use strict';
const cp = require('child_process');

let _msys;   // undefined = unresolved; null = no MSYS bash found
function msysBash() {
  if (_msys !== undefined) return _msys;
  try { _msys = require('../runners/win.js')._internals.gitBash(); }
  catch { _msys = null; }
  return _msys;
}

let _wsl;    // undefined = unchecked; null = no usable WSL bash
function wslBash() {
  if (_wsl !== undefined) return _wsl;
  try { cp.execFileSync('wsl.exe', ['-e', 'bash', '-c', 'true'], { timeout: 5000, windowsHide: true, stdio: 'ignore' }); _wsl = true; }
  catch { _wsl = false; }
  return _wsl;
}

// Does `s` look like an absolute Windows path worth translating for WSL (drive-letter form only)? A bash -c
// script BODY or an already-POSIX test fixture string must never be run through wslpath.
const looksWindowsPath = (s) => /^[A-Za-z]:[\\/]/.test(String(s));

// `wsl.exe wslpath -a <p>` — the one conversion trusted over WSL's own automatic argv translation.
function toWslPath(p) {
  try { return cp.execFileSync('wsl.exe', ['wslpath', '-a', p], { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim() || p; }
  catch { return p; }
}

// { bin, isWsl } — the executable to spawn, and whether it needs the WSL argv shape (`-e bash <args>` plus
// path translation) rather than being handed `<args>` directly like a normal bash.
let _resolved;
function resolve() {
  if (process.platform !== 'win32') return { bin: 'bash', isWsl: false };
  if (_resolved !== undefined) return _resolved;
  const msys = msysBash();
  if (msys) { _resolved = { bin: msys, isWsl: false }; return _resolved; }
  if (wslBash()) { _resolved = { bin: 'wsl.exe', isWsl: true }; return _resolved; }
  _resolved = { bin: 'bash', isWsl: false };   // nothing usable found — behave as before (will fail the same way it always did)
  return _resolved;
}

// Map a bash argv (as if calling `bash <args...>`) to the argv actually handed to resolve().bin, translating
// any Windows-style path argument through wslpath when (and only when) the WSL fallback is in play.
function toArgs(args) {
  const r = resolve();
  if (!r.isWsl) return args;
  return ['-e', 'bash', ...args.map((a) => (looksWindowsPath(a) ? toWslPath(a) : a))];
}

// A single Windows-style path argument (e.g. a temp dir handed to a script as $1), translated for whichever
// bash was resolved: MSYS accepts the mixed form directly (forward slashes, drive letter intact — the same
// form cygpath -m produces and runners/win.js already relies on); WSL needs its own wslpath conversion.
function toPath(p) {
  const r = resolve();
  if (process.platform !== 'win32') return p;
  if (r.isWsl) return toWslPath(p);
  return looksWindowsPath(p) ? String(p).replace(/\\/g, '/') : p;
}

module.exports = { resolve, toArgs, toPath };
