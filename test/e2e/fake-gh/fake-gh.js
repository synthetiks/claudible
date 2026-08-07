#!/usr/bin/env node
// test/e2e/fake-gh/fake-gh.js — minimal `gh` stand-in for wsl/sessions-sync.sh's ONE real dependency on the
// GitHub CLI: resolving "who am I" (wsl/sessions-sync.sh:155-160, `gh api user --jq .login`). Everything
// sync actually reads/writes goes over the git remote `origin` — which the harness points at a local bare
// repo (test/e2e/_fixtures.js's localBareRemote), never at github.com — so this shim never needs to talk to
// the network or know anything about a real account. It answers exactly the two gh calls the sync script can
// make and refuses (loudly, not silently) anything else, so a caller reaching for an unsupported subcommand
// fails fast instead of hanging or fabricating a plausible-looking answer.
//
// Identity is per-INSTANCE, not baked into this file: CLAUDIBLE_E2E_GH_LOGIN is set per launchPair() instance
// (test/e2e/_fixtures.js) so 'crazy-e2e' and 'mk-e2e' write to disjoint sessions/<login>/ dirs on the shared
// branch, exactly like two real collaborators' two real GitHub accounts would.
'use strict';

const argv = process.argv.slice(2);
const login = process.env.CLAUDIBLE_E2E_GH_LOGIN || 'e2e-user';

// `gh api user --jq .login` — sessions-sync.sh's author resolution (also cached by it for 10 minutes).
if (argv[0] === 'api' && argv.includes('user')) {
  process.stdout.write(login + '\n');
  process.exit(0);
}
// `gh auth token` — sessions-sync.sh's relay-cred op (main.js's presence-relay credential fetch). Not
// exercised by the sync-pair spec (RELAY_URL is unset in this harness, making the relay a no-op anyway), but
// answering it keeps that code path from hanging if something ever calls it.
if (argv[0] === 'auth' && argv[1] === 'token') {
  process.stdout.write('e2e-fake-gh-token\n');
  process.exit(0);
}

// Everything else — repo create, collaborator invite, device auth, `auth status` — is deliberately OUT OF
// SCOPE per the harness's hard rules (the bare remote replaces GitHub for sync; real device auth is never
// exercised). Fail loudly so a caller that reaches here treats it as "not signed in / not available" rather
// than hanging on a shim that pretends to be a full gh install.
process.stderr.write('fake-gh: unsupported subcommand (out of scope for this harness): ' + argv.join(' ') + '\n');
process.exit(1);
