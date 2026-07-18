// runners/_shared.js — OS-agnostic command construction shared by the bash-based backends (WSL + Posix).
//
// The bash COMMAND text is identical across WSL and native Linux/macOS — only the execution wrapper
// differs (`wsl.exe -e bash -lc <cmd>` vs `bash -lc <cmd>`). These pure builders own that shared text
// so the two backends can never drift. The Windows-native backend has no bash and does NOT use these
// (see runners/win.js). All three are validated against runners/runner.js's contract.

// Quote a string for safe interpolation INSIDE a single-quoted bash argument ('…' → '\'' … '\'').
//
// The one string that must go through this is the app's own install dir. It is NOT a user-picked path (those are
// rejected outright by lib/pathSafe.js) — it is wherever the installer landed, e.g. C:\Users\O'Brien\… . An OS
// account name may legally contain an apostrophe, and interpolating it raw CLOSED the quote: `bash '/home/O'Brien/
// claudible/wsl/session.sh'` re-parses to /home/OBrien/…, a path that does not exist. Every session, workspace,
// diff and clone command silently pointed at nothing, and the only symptom was a generic "node-pty unavailable".
// runners/win.js already used exactly this escape inline for its own cygpath calls; this is that escape, hoisted
// so the command BUILDERS below share one copy. (win.js still inlines it at its three cygpath sites — same escape,
// and those are host→guest path translation rather than command construction. If you harden the escape, harden it
// there too.) The bug was two implementations of one idea, with the second one simply absent.
function shq(s) { return String(s == null ? '' : s).replace(/'/g, "'\\''"); }

// Env prefix the wsl/*.sh scripts read to run in the active workspace's cwd. slug re-sanitized
// (defense in depth — it's interpolated into bash); custom path must be single-quote-free.
// NOTE: `p` deliberately keeps its REJECT-on-quote rule rather than moving to shq() — a workspace path also has to
// round-trip back out through the scripts' `printf '…"path":"%s"…'` JSON, which escaping here would not fix. That
// rejection is lib/pathSafe.js's job and it happens at pick time; this is its defense-in-depth copy.
function wsEnv(ws) {
  const kind = ws && ['local', 'repo', 'legacy'].includes(ws.kind) ? ws.kind : 'legacy';
  const slug = String((ws && ws.slug) || '').replace(/[^A-Za-z0-9-]/g, '');
  let s = `CLAUDIBLE_WS_KIND='${kind}'` + (slug ? ` CLAUDIBLE_WS_SLUG='${slug}'` : '');
  const p = ws && ws.path;
  if (p && typeof p === 'string' && !p.includes("'")) s += ` CLAUDIBLE_WS_DIR='${p}'`;
  return s;
}

// The `bash -lc` boot string for the Claude TUI (appdir injected — pure, so a parity test can verify it).
// 'ultracode' isn't a CLI value: launch at xhigh, main.js injects `/effort ultracode` once it settles.
function bootStr(appdir, session, ws, runtimeId, effort, permMode, modelStrategy) {
  if (!appdir) return 'echo "[claudible] could not resolve the app path — is the environment set up?"; sleep 8';
  const sel = String(session || '').replace(/[^A-Za-z0-9-]/g, '').replace(/^-+/, '');   // strip leading dashes (no flag-lookalike ids)
  const tab = String(runtimeId || 'default').replace(/[^A-Za-z0-9-]/g, '') || 'default';   // interpolated into single-quoted bash → sanitize (defense-in-depth; tab ids are app-generated, but keep parity with sel/slug which are stripped)
  const effLevel = effort === 'ultracode' ? 'xhigh' : effort;
  const eff = ['low', 'medium', 'high', 'xhigh', 'max'].includes(effLevel) ? ` CLAUDIBLE_EFFORT='${effLevel}'` : '';
  // Only non-default modes are inlined; 'default' (or unset) omits it so session.sh launches Claude's own
  // prompting default. session.sh ALWAYS sandboxes a foreign session regardless of this.
  const perm = ['bypass', 'acceptEdits'].includes(permMode) ? ` CLAUDIBLE_PERMISSION_MODE='${permMode}'` : '';
  // "Plan big, execute small" (Anthropic cookbook pattern): the main session plans/synthesizes on the user's
  // chosen model while SUBAGENTS — the token-heavy leg — run on Sonnet 5. session.sh translates this into
  // CLAUDE_CODE_SUBAGENT_MODEL. Allowlist inline: only the one known value ever reaches the bash string.
  const strat = modelStrategy === 'planBigExecSmall' ? ` CLAUDIBLE_MODEL_STRATEGY='planBigExecSmall'` : '';
  const prefix = (sel ? `CLAUDIBLE_SESSION='${sel}' ` : '') + `CLAUDIBLE_TAB='${tab}'` + eff + perm + strat + ' ' + wsEnv(ws) + ' ';
  return `${prefix}bash '${shq(appdir)}/wsl/session.sh' '${shq(appdir)}'`;
}

// The wsl/<name> invocation tail (appdir injected). Each call site passes its EXACT arg string verbatim,
// so command text is unchanged from the original inline sites. env keeps its own trailing space.
function scriptCmd(appdir, name, argStr = '', opts = {}) {
  const env = opts.extraEnv ? String(opts.extraEnv) : '';
  // CLAUDIBLE_VOICE is a DOCUMENTED user override (README Configuration) consumed by preflight/services/
  // setup inside the guest — but env vars don't cross the Windows→WSL boundary on their own, so under the
  // WSL runner it silently did nothing. Inline it like every other CLAUDIBLE_* value. Same quote-reject rule
  // as wsEnv's path (defense in depth: it's interpolated into a single-quoted bash string).
  const vp = process.env.CLAUDIBLE_VOICE;
  const voice = (vp && typeof vp === 'string' && !vp.includes("'")) ? `CLAUDIBLE_VOICE='${vp}' ` : '';
  const wsp = opts.ws ? wsEnv(opts.ws) + ' ' : '';
  const tail = String(argStr || '').trim();
  return `${env}${voice}${wsp}bash '${shq(appdir)}/wsl/${name}'${tail ? ' ' + tail : ''}`;
}

module.exports = { shq, wsEnv, bootStr, scriptCmd };
