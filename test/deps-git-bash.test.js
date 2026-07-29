// test/deps-git-bash.test.js — the S6 System-check gap: a PATH git WITHOUT git-bash read "Git: ready".
// `where git` succeeds for a Scoop/Chocolatey-shimmed or custom-path git, but runScript needs Git for
// Windows' bash.exe — so Step 1 passed green and the user's FIRST failure was a generic "shell backend is
// not available" at Create-project, with nothing connecting the two. The row (labelled "Git for Windows"
// on the win runner) must read MISSING in that shape — its Install button (winget Git.Git) is the actual
// fix — and must carry the note that explains why a machine "with git" is being told to install Git.
// Run: node test/deps-git-bash.test.js
'use strict';
const assert = require('assert');
const win = require('../runners/win.js');
const deps = require('../runners/deps.js');
const { buildDepReport } = win._internals;

let pass = 0, fail = 0;
const ok = (label, c) => { c ? pass++ : (fail++, console.error('  FAIL ' + label)); };
const eq = (label, a, b) => { try { assert.strictEqual(a, b); pass++; } catch { fail++; console.error(`  FAIL ${label}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); } };

// same fake-IO shape as test/win-runner.test.js — the pure report core runs anywhere
function fakeIO(spec) {
  return {
    gitBashPresent: () => !!spec.gitBash,
    resolveTool: (id) => (spec.present && id in spec.present) ? `C:\\bin\\${id}.exe` : '',
    toolVersion: (id) => (spec.present && spec.present[id]) || '',
    claudeSignedIn: () => false,
    ghAuth: () => ({ signedIn: false, account: '' }),
  };
}

(async () => {
  // the trap shape: git resolves on PATH, bash does not
  const scoopish = buildDepReport(fakeIO({ gitBash: false, present: { git: 'git version 2.45.0' } }));
  ok('the trap is real: git LOOKS installed', scoopish.git.installed === true);
  ok('…while gitBash rides beside it as false', scoopish.gitBash === false);

  const d = await deps.detect({ id: 'win', detectDeps: () => scoopish }, {});
  const git = d.deps.find((x) => x.id === 'git');
  eq('the System-check row reads MISSING, not ready (bash is what the scripts run on)', git.state, 'missing');
  ok('the row is installable (winget Git.Git is the actual fix)', git.installable === true);
  ok('the row carries the note resolving the "but I have git!" contradiction', /not Git for Windows/.test(git.note));

  // the healthy shape is untouched: real Git for Windows → ready, no note
  const healthy = buildDepReport(fakeIO({ gitBash: true, present: { git: 'git version 2.45.0' } }));
  const h = await deps.detect({ id: 'win', detectDeps: () => healthy }, {});
  const hg = h.deps.find((x) => x.id === 'git');
  eq('real Git for Windows still reads ready', hg.state, 'ready');
  eq('…with no note', hg.note, '');

  // and the non-win runners are untouched: their probes have no gitBash concept, and its absence must not
  // flip their git row (raw.gitBash is simply undefined there)
  const w = await deps.detect({ id: 'wsl', detectDeps: () => ({ git: { installed: true, version: 'git version 2.43.0' } }) }, {});
  const wg = w.deps.find((x) => x.id === 'git');
  eq('wsl runner: git stays ready without a gitBash field', wg.state, 'ready');
  eq('wsl runner: no note', wg.note, '');

  console.log(`deps-git-bash: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
