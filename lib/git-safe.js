'use strict';
// lib/git-safe.js — the ONE shared allowlist source of truth for the git-config-neutralization campaign
// across the app. wsl/_git-safe.sh and hooks/context-hook.js each carry their OWN copy of this list
// (they must — see the file-level comments there for why: a bash script cannot `require()`, and
// hooks/context-hook.js is staged as a standalone copy into $SDIR/.claude — wsl/session.sh:169,
// runners/win.js:305 — so it can never depend on lib/). This file exists so there is exactly ONE place a
// human decides what belongs on the list; test/adopt-workspace.test.js's parity pin requires this file and
// asserts the two copies match it key-for-key, so a key added to one place without the others fails the build.
//
// WHY each key: git reads several config VALUES as shell commands (or command-adjacent behavior) during
// ordinary operations against a repo whose .git/config the user does not control (an adopted folder, a cloned
// "starter template" zip). See wsl/_git-safe.sh's header for the fully-verified subset (fsmonitor, sshCommand).
// gpg.program / log.showSignature: git's show_signature path runs `gpg.program` on any log/show of a commit
// carrying a gpgsig trailer — hooks/context-hook.js:83 runs `git log -1` against the (adopted, untrusted)
// workspace on every single prompt, so this is a per-turn exposure, not a rare one. core.hooksPath:
// redirects git's own hook directory to an attacker-chosen path executed on checkout/commit/etc.
const SAFE_KEYS = [
  { key: 'core.fsmonitor', value: '' },                    // index-refresh hook command
  { key: 'core.sshCommand', value: 'ssh' },                 // per-repo ssh command (RCE, verified)
  { key: 'core.alternateRefsCommand', value: '' },          // alternate-refs enumeration command
  { key: 'core.gitProxy', value: '' },                      // git:// proxy command
  { key: 'protocol.ext.allow', value: 'never' },            // `ext` transport = arbitrary command
  { key: 'protocol.git.allow', value: 'never' },            // unauthenticated git:// has no place here
  { key: 'gpg.program', value: '' },                        // runs on show_signature (git log/show of a gpgsig commit)
  { key: 'log.showSignature', value: 'false' },             // forces the show_signature path off outright
  { key: 'core.hooksPath', value: '/dev/null' },            // redirects git's own hook dir to an inert path
];

// buildEnv(extraPairs?) — GIT_CONFIG_COUNT + GIT_CONFIG_KEY_n/VALUE_n for SAFE_KEYS (in order), then any
// extraPairs ({key,value} objects, same shape) appended after. Also sets GIT_TERMINAL_PROMPT/SSH_ASKPASS_REQUIRE.
// NOTE: the consumer must also `delete`/`unset` GIT_ASKPASS and SSH_ASKPASS from whatever env object it actually
// spawns with — this function cannot do that itself because it returns a plain additive object, not a spawn env
// (deleting inherited-but-unset keys here would be a no-op that gives a false sense of safety).
function buildEnv(extraPairs) {
  return envFromPairs(SAFE_KEYS.concat(Array.isArray(extraPairs) ? extraPairs : []));
}

// buildEnvWithout(excludedKeys, extraPairs?) — buildEnv minus the named SAFE_KEYS entries, RENUMBERED
// contiguously (git reads GIT_CONFIG_KEY_0..COUNT-1, so simply skipping an index would silently drop every key
// after the hole). For the one caller shape that must ask git what a config value RESOLVES to instead of
// overriding it: wsl/coauthor-tool.js locates the repo's hooks dir with `git rev-parse --git-path hooks`, and
// git ANSWERS that query with core.hooksPath when it is set — so under the full allowlist it would answer
// '/dev/null' and C-10.6 would install prepare-commit-msg into a non-directory (install() fails outright, and
// uninstall() then reads nothing and silently strands an already-installed hook). Everything else stays on.
// Callers must ALSO base their env on stripConfigEnv(process.env): an inherited GIT_CONFIG_KEY_8 from
// wsl/_git-safe.sh would otherwise survive the renumbering as a stale (ignored, but confusing) leftover.
function buildEnvWithout(excludedKeys, extraPairs) {
  const drop = new Set(Array.isArray(excludedKeys) ? excludedKeys : [excludedKeys]);
  return envFromPairs(SAFE_KEYS.filter((p) => !drop.has(p.key)).concat(Array.isArray(extraPairs) ? extraPairs : []));
}

// A COPY of `env` with every GIT_CONFIG_COUNT/KEY_n/VALUE_n removed — the clean base a process that inherited
// wsl/_git-safe.sh's exports must build on before applying its own (differently-numbered) set. Never mutates
// the input, so process.env is left alone.
function stripConfigEnv(env) {
  const out = Object.assign({}, env || {});
  delete out.GIT_CONFIG_COUNT;
  for (const k of Object.keys(out)) { if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) delete out[k]; }
  return out;
}

function envFromPairs(pairs) {
  const env = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach((p, i) => { env['GIT_CONFIG_KEY_' + i] = p.key; env['GIT_CONFIG_VALUE_' + i] = p.value; });
  env.GIT_TERMINAL_PROMPT = '0';
  env.SSH_ASKPASS_REQUIRE = 'never';
  return env;
}

module.exports = { SAFE_KEYS, buildEnv, buildEnvWithout, stripConfigEnv };
