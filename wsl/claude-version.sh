#!/usr/bin/env bash
# Claudible — print the embedded Claude Code CLI version (its first --version line), or nothing if claude
# isn't on PATH. Cross-backend: runs under wsl.exe bash (WSL), bash directly (Linux/macOS), or git-bash on
# native Windows (where `claude` is the claude.exe npm shim). main.js extracts the semver for the status bar.
command -v claude >/dev/null 2>&1 || { printf ''; exit 0; }
claude --version 2>/dev/null | head -1
