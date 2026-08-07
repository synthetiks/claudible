@echo off
rem test/e2e/fake-gh/gh.cmd — the shim on PATH that stands in for the GitHub CLI. wsl/sessions-sync.sh's
rem sync protocol (init/pull/push/sync/status) shells out to `gh api user --jq .login` for exactly ONE
rem thing: "who am I" (the author subdirectory it writes transcripts under). It has nothing to do with the
rem real GitHub — the harness's local bare-remote fixtures (test/e2e/_fixtures.js's localBareRemote) stand
rem in for GitHub entirely — but the script has no other identity source, so a sync-exercising instance
rem needs SOMETHING named `gh` on PATH that answers deterministically, without ever touching the dev box's
rem real `gh auth` state (the hard rules keep real device auth / repo create / invite OUT of scope).
node "%~dp0fake-gh.js" %*
