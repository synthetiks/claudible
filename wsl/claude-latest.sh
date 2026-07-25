#!/usr/bin/env bash
# Claudible — print the LATEST published Claude Code CLI version from the npm registry (one semver line), or
# NOTHING on any failure (offline, npm missing, registry down, proxy). main.js compares it to the installed
# version (claude-version.sh) to decide whether the "update available" dot goes amber. Cross-backend: WSL bash,
# Linux/macOS, git-bash on native Windows.
#
# FAIL-SILENT BY DESIGN: a missing/erroring "latest" prints empty, and the caller treats empty as "unknown →
# stay green". A false "out of date" is worse than saying nothing.
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/node-path.sh" 2>/dev/null || true              # a version-manager (nvm/fnm/volta) node+npm isn't on PATH in a non-interactive `bash -lc` — same fix the sibling node scripts carry
command -v npm >/dev/null 2>&1 || { printf ''; exit 0; }
npm view @anthropic-ai/claude-code version 2>/dev/null | tr -d '\r' | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1
