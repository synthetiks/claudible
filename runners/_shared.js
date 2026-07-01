// runners/_shared.js — OS-agnostic command construction shared by the bash-based backends (WSL + Posix).
//
// The bash COMMAND text is identical across WSL and native Linux/macOS — only the execution wrapper
// differs (`wsl.exe -e bash -lc <cmd>` vs `bash -lc <cmd>`). These pure builders own that shared text
// so the two backends can never drift. The Windows-native backend has no bash and does NOT use these
// (see runners/win.js). All three are validated against runners/runner.js's contract.

// Env prefix the wsl/*.sh scripts read to run in the active workspace's cwd. slug re-sanitized
// (defense in depth — it's interpolated into bash); custom path must be single-quote-free.
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
function bootStr(appdir, session, ws, runtimeId, effort, permMode) {
  if (!appdir) return 'echo "[claudible] could not resolve the app path — is the environment set up?"; sleep 8';
  const sel = String(session || '').replace(/[^A-Za-z0-9-]/g, '').replace(/^-+/, '');   // strip leading dashes (no flag-lookalike ids)
  const tab = String(runtimeId || 'default').replace(/[^A-Za-z0-9-]/g, '') || 'default';   // interpolated into single-quoted bash → sanitize (defense-in-depth; tab ids are app-generated, but keep parity with sel/slug which are stripped)
  const effLevel = effort === 'ultracode' ? 'xhigh' : effort;
  const eff = ['low', 'medium', 'high', 'xhigh', 'max'].includes(effLevel) ? ` CLAUDIBLE_EFFORT='${effLevel}'` : '';
  // Only non-default modes are inlined; 'default' (or unset) omits it so session.sh launches Claude's own
  // prompting default. session.sh ALWAYS sandboxes a foreign session regardless of this.
  const perm = ['bypass', 'acceptEdits'].includes(permMode) ? ` CLAUDIBLE_PERMISSION_MODE='${permMode}'` : '';
  const prefix = (sel ? `CLAUDIBLE_SESSION='${sel}' ` : '') + `CLAUDIBLE_TAB='${tab}'` + eff + perm + ' ' + wsEnv(ws) + ' ';
  return `${prefix}bash '${appdir}/wsl/session.sh' '${appdir}'`;
}

// The wsl/<name> invocation tail (appdir injected). Each call site passes its EXACT arg string verbatim,
// so command text is unchanged from the original inline sites. env keeps its own trailing space.
function scriptCmd(appdir, name, argStr = '', opts = {}) {
  const env = opts.extraEnv ? String(opts.extraEnv) : '';
  const wsp = opts.ws ? wsEnv(opts.ws) + ' ' : '';
  const tail = String(argStr || '').trim();
  return `${env}${wsp}bash '${appdir}/wsl/${name}'${tail ? ' ' + tail : ''}`;
}

module.exports = { wsEnv, bootStr, scriptCmd };
