@echo off
rem test/e2e/fake-claude/claude.cmd — the shim on PATH that runners/win.js's whichClaude()/pickClaudeBin()
rem resolves instead of a real (signed-in) claude CLI. win.js prefers a .cmd/.exe/.bat hit over a bare
rem extensionless shim (CreateProcess 193 otherwise) and routes .cmd spawns through "cmd /c" — this file
rem IS that .cmd, so it is picked up exactly the way a real npm-installed `claude.cmd` would be.
node "%~dp0fake-claude.js" %*
