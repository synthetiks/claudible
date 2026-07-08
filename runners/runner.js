// runners/runner.js — the OS-backend seam (Part 0 of docs/OS-CONVERSION-PLAN.md).
//
// main.js talks ONLY to a Runner; it never touches wsl.exe / wslpath / bash / a Windows path
// directly. Every OS-coupled call site in docs/SEAMS.md (74 of them) moves behind one of the
// methods below. Adding an OS = adding a runner module that implements this contract; nothing
// in main.js / the renderer changes.
//
// THE CONTRACT (every backend — wsl.js, and later win.js / posix.js — implements these):
//
//   id                                    'wsl' | 'win' | 'posix'
//   detect()                  -> bool     is this runner usable on this machine?
//   appDirGuest()             -> string|null   the app root as the execution space sees it
//                                              (WSL: /mnt/c/…  · native: the app root itself)
//   toGuestPath(hostPath)     -> string   host path -> execution-space path (identity on native)
//   toHostPath(guestPath)     -> string   execution-space path -> host path (identity on native)
//   runtimeDir()              -> string   host-FS runtime root; pollers read tabs/<id>/status.json
//                                         + hooks.ndjson here (SEAMS §2)
//   ptyInfo()                 -> {mod, err}    the loaded node-pty backend (or the load error)
//   spawnClaude(tabId, opts)  -> ptyProcess    launch the Claude TUI in a PTY (SEAMS §1)
//                                              opts: { cols, rows, session, ws, effort, runtimeId }
//   runScript(name,argStr,o)  -> Promise<{err, stdout}>   run wsl/<name> with wsEnv + args (SEAMS §7)
//                                              o: { ws, extraEnv, timeout, maxBuffer }
//   startVoiceServices()      -> void     bring up whisper(:2022) + kokoro(:8880) (SEAMS §5)
//   detectDeps()              -> map|Promise<map>   raw dependency status for the self-bootstrap provisioner
//                                              (runners/deps.js merges it with the install manifest). win:
//                                              pure-Node `where`/version/cred read (NO git-bash — Git itself
//                                              may be missing); wsl/posix: delegate to bash wsl/preflight.sh.
//
// NOT in the contract: hook installation and the per-OS install/build. The bash backends fuse hooks into
// spawnClaude (session.sh rewrites $SDIR/.claude on every boot) and win.js calls its own installHooks() from
// its spawnClaude — so no caller ever needs a runner method. Building is the installer's job (install.ps1 /
// setup/setup.sh). SEAMS §4/§6. Voice health lives in services.sh, not here.
//
// SELECTION (plan 0.4): honor CLAUDIBLE_RUNNER for testing; else auto-detect. Until win/posix are
// built and proven, every path resolves to the WSL backend, so today's behavior is unchanged.

const wsl = require('./wsl');
const posix = require('./posix');
const win = require('./win');

const REGISTRY = { wsl, posix, win };

function select() {
  const forced = String(process.env.CLAUDIBLE_RUNNER || '').trim().toLowerCase();
  if (forced && REGISTRY[forced]) return REGISTRY[forced];
  if (forced) {
    // e.g. an unknown value — fail SOFT to the platform default, loudly.
    console.error(`[claudible] CLAUDIBLE_RUNNER='${forced}' is unknown — using the platform default.`);
  }
  // Auto-detect by host platform. Windows keeps the proven WSL backend as default; the native Windows
  // backend ('win') is registered but opt-in via CLAUDIBLE_RUNNER=win until it passes a Windows smoke
  // test (docs/SMOKE.md) and is flipped here. Native Linux/macOS use Posix (WSL backend minus wsl.exe).
  if (process.platform === 'win32') return wsl;
  return posix;
}

module.exports = { select, REGISTRY, wsl, posix, win };
