#!/usr/bin/env bash
# Claudible — resolve (and ensure) the trash root every delete/prune script already uses. Args: none.
# Emits its GUEST-side path as JSON; main.js's trash:open converts it to a host-openable path via
# runner.toHostPath() (identity on native win/posix, wslpath -w on the WSL backend) before shell.openPath.
set -u
dir="$HOME/.claudible/trash"
mkdir -p "$dir" 2>/dev/null   # "Open trash" before anything was ever deleted must still open SOMETHING, not ENOENT
if [ -d "$dir" ]; then
  printf '{"ok":true,"path":"%s"}' "$dir"
else
  printf '{"ok":false,"error":"could not create the trash folder"}'
fi
