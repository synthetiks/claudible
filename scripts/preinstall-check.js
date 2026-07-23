#!/usr/bin/env node
'use strict';
// Linux C-toolchain preflight, run by npm's `preinstall` hook.
//
// WHY THIS EXISTS: node-pty ships prebuilds for darwin-arm64/x64 and win32-arm64/x64 — and nothing for Linux.
// Its install script is `node scripts/prebuild.js || node-gyp rebuild`, so on Linux it ALWAYS falls through to
// compiling from source. Without gcc/make/python3 that ends in a multi-page node-gyp/compiler dump, which reads
// like "this repo is broken" rather than "install three packages". Every other prerequisite path in this
// project (setup/setup.sh, wsl/provision.sh) catches a missing tool and prints the exact install command; the
// core `npm install` was the one that didn't.
//
// DESIGN RULES:
//   · Linux only. Windows and macOS have prebuilds, so there is nothing to check and we must never interfere.
//   · Fail LOUD and EARLY (exit 1) rather than warn — the whole point is to replace the node-gyp wall with one
//     actionable message. A warning would just scroll past and get buried under the very output it warns about.
//   · Never block on our OWN failure: any unexpected error in this script exits 0 and lets npm proceed. A
//     preinstall hook that can wrongly refuse to install is worse than the problem it solves.
//   · CLAUDIBLE_SKIP_PREINSTALL=1 is the escape hatch for anyone with a toolchain we fail to detect.
try {
  if (process.platform !== 'linux' || process.env.CLAUDIBLE_SKIP_PREINSTALL === '1') process.exit(0);

  const { execFileSync } = require('child_process');
  const has = (bin) => {
    try { execFileSync('command', ['-v', bin], { stdio: 'ignore', shell: '/bin/sh' }); return true; }
    catch { return false; }
  };

  // A C compiler under either common name; `make`; and python3 (node-gyp requires it).
  const missing = [];
  if (!has('cc') && !has('gcc') && !has('clang')) missing.push('a C compiler (gcc/clang)');
  if (!has('make')) missing.push('make');
  if (!has('python3')) missing.push('python3');
  if (!missing.length) process.exit(0);

  // Name the package manager we can actually see, so the command is copy-pasteable rather than generic.
  const cmd = has('apt-get') ? 'sudo apt-get install -y build-essential python3'
    : has('dnf') ? 'sudo dnf install -y gcc-c++ make python3'
      : has('pacman') ? 'sudo pacman -S --needed base-devel python'
        : has('zypper') ? 'sudo zypper install -y gcc-c++ make python3'
          : 'install a C toolchain (gcc/g++, make) and python3 with your package manager';

  process.stderr.write(
    '\n  Claudible: missing build tools — ' + missing.join(', ') + '\n\n'
    + '  node-pty has no Linux prebuild, so `npm install` compiles it from source.\n'
    + '  Install the toolchain, then re-run npm install:\n\n'
    + '      ' + cmd + '\n\n'
    + '  (Set CLAUDIBLE_SKIP_PREINSTALL=1 to bypass this check.)\n\n');
  process.exit(1);
} catch {
  process.exit(0);   // our own bug must never stop someone installing
}
