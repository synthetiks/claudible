// test/adopt-workspace.test.js — "add a folder I already have" as a project.
//
// Adopting inverts the assumption every other workspace path is built on: Claudible did NOT create this folder.
// It's the user's working tree, often a real git repo with a real `origin`. Three existing code paths would
// destroy it, and each is guarded by the `adopted:true` marker rather than a new `kind` (an unknown kind silently
// degrades to 'legacy' in the runners' ['local','repo','legacy'] allowlists and would point Claude at
// ~/.claudible/session instead):
//
//   1. workspace:delete shells to delete-workspace.sh, which prefers CLAUDIBLE_WS_DIR (= ws.path) and `mv -f`s
//      that directory into ~/.claudible/trash. On an adopted folder that moves the user's source tree.
//   2. workspace:upgrade shells to upgrade-workspace.sh, which runs `git remote remove origin` + `git add -A` +
//      `gh repo create --source=. --push`. On an adopted repo that drops their remote and republishes the tree.
//   3. session.sh / win.js installHooks overwrite <folder>/.claude/settings.json unconditionally — the user's
//      own permissions, MCP servers and hooks, gone. Now snapshotted once, before we take ownership.
//
// The renderer + main are single non-modular scripts, so the predicates are mirrored here as pure functions AND
// pinned to the real source with grep guards. Run: node test/adopt-workspace.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
const SESSION_SH = fs.readFileSync(path.join(ROOT, 'wsl/session.sh'), 'utf8');
const WIN = fs.readFileSync(path.join(ROOT, 'runners/win.js'), 'utf8');
const DIFF_SH = fs.readFileSync(path.join(ROOT, 'wsl/diff.sh'), 'utf8');
const SHARED = fs.readFileSync(path.join(ROOT, 'runners/_shared.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (label, c) => c ? pass++ : (fail++, console.error('  FAIL ' + label));
const eq = (label, got, want) => ok(label + ' (got ' + JSON.stringify(got) + ')', got === want);

// ===========================================================================================================
// 1. THE DESTRUCTIVE GATES — mirrored predicates. Each `false` below is a folder that does not get destroyed.
// ===========================================================================================================
// main.js workspace:delete — does this deletion shell out to delete-workspace.sh (which moves the folder)?
const trashesFolder = (ws, APPDIR_WSL = true) => {
  const slug = String(ws.slug || '').replace(/[^A-Za-z0-9-]/g, '');
  return !!(APPDIR_WSL && slug && !ws.adopted && (ws.kind === 'local' || ws.kind === 'repo'));
};
ok('delete: a Claudible-created local workspace IS trashed', trashesFolder({ kind: 'local', slug: 'mine' }));
ok('delete: a cloned repo workspace IS trashed (GitHub copy survives)', trashesFolder({ kind: 'repo', slug: 'team' }));
ok('delete: an ADOPTED folder is NEVER touched on disk', !trashesFolder({ kind: 'local', slug: 'crazy', adopted: true, path: '/home/mk/code/crazy' }));
ok('delete: adoption beats every other condition', !trashesFolder({ kind: 'repo', slug: 'x', adopted: true }));
ok('delete: a legacy workspace is left alone (unchanged)', !trashesFolder({ kind: 'legacy', slug: '' }));

// main.js workspace:upgrade — does this reach upgrade-workspace.sh (git remote remove origin + republish)?
const republishes = (ws) => {
  if (ws.kind === 'repo') return false;              // already a repo → { ok:true, already:true }
  if (ws.kind !== 'local') return false;
  if (ws.adopted) return false;                      // ← the guard
  return true;
};
ok('upgrade: a Claudible-created local workspace CAN be upgraded', republishes({ kind: 'local', slug: 'mine' }));
ok('upgrade: an ADOPTED folder is refused (its origin is not ours to remove)', !republishes({ kind: 'local', adopted: true }));
ok('upgrade: an already-repo workspace short-circuits', !republishes({ kind: 'repo' }));

// wsEnv's allowlist is exactly why adoption reuses kind:'local' instead of inventing kind:'adopted'.
const { wsEnv } = require(path.join(ROOT, 'runners/_shared.js'));
const adopted = { kind: 'local', slug: 'crazy', adopted: true, path: '/home/mk/code/crazy' };
ok('wsEnv: an adopted ws still resolves as a LOCAL kind', /CLAUDIBLE_WS_KIND='local'/.test(wsEnv(adopted)));
ok('wsEnv: …and carries its real folder as CLAUDIBLE_WS_DIR', /CLAUDIBLE_WS_DIR='\/home\/mk\/code\/crazy'/.test(wsEnv(adopted)));
ok('wsEnv: an unknown kind WOULD have degraded to legacy (why we reuse local)', /CLAUDIBLE_WS_KIND='legacy'/.test(wsEnv({ kind: 'adopted', slug: 'x' })));

// ===========================================================================================================
// 2. REGISTRATION: dedupe by canonical path, uniquify the slug, parse the GitHub remote.
// ===========================================================================================================
// The exact regex main.js uses, read from the source so this test can never drift from what ships.
const reSrc = /const GITHUB_REMOTE = (\/.*\/i);/.exec(MAIN);
ok('main.js exposes a GITHUB_REMOTE literal', !!reSrc);
const GITHUB_REMOTE = eval(reSrc[1]);   // eslint-disable-line no-eval — a literal lifted verbatim from source
const repoId = (u) => { const m = GITHUB_REMOTE.exec(u); return m ? `${m[1]}/${m[2]}` : null; };
eq('remote: https', repoId('https://github.com/MKDevv05/Crazy.git'), 'MKDevv05/Crazy');
eq('remote: https, no .git', repoId('https://github.com/MKDevv05/Crazy'), 'MKDevv05/Crazy');
eq('remote: https with trailing slash', repoId('https://github.com/MKDevv05/Crazy/'), 'MKDevv05/Crazy');
eq('remote: ssh scp-style', repoId('git@github.com:thecrazydev1/claudible.git'), 'thecrazydev1/claudible');
eq('remote: ssh:// url', repoId('ssh://git@github.com/thecrazydev1/claudible.git'), 'thecrazydev1/claudible');
eq('remote: https with a token/user prefix', repoId('https://x-token@github.com/a/b.git'), 'a/b');
eq('remote: www.', repoId('https://www.github.com/a/b'), 'a/b');
eq('remote: a NON-github remote yields nothing to link to', repoId('https://gitlab.com/a/b.git'), null);
eq('remote: a lookalike host is not github', repoId('https://github.com.evil.tld/a/b'), null);
eq('remote: empty', repoId(''), null);

// slug uniquify — two different folders can share a basename; the registry id must not collide.
function adoptSlug(existingIds, name) {
  const base = String(name || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';
  let slug = base, n = 1;
  while (existingIds.includes(`local-${slug}`)) slug = `${base}-${++n}`;
  return slug;
}
eq('slug: a plain name', adoptSlug([], 'Crazy'), 'crazy');
eq('slug: spaces + junk collapse to dashes', adoptSlug([], 'My  Cool_Project!'), 'my-cool-project');
eq('slug: a second folder with the same basename gets -2', adoptSlug(['local-api'], 'api'), 'api-2');
eq('slug: …and a third gets -3', adoptSlug(['local-api', 'local-api-2'], 'api'), 'api-3');
eq('slug: a name with no usable chars still yields an id', adoptSlug([], '???'), 'project');
eq('slug: it does not collide with a REPO workspace of the same name', adoptSlug(['repo-api'], 'api'), 'api');

// ===========================================================================================================
// 3. PROJECT HISTORY lists EVERY project. The old filter hid every non-active local — including the adopted
//    folder whose commit history is the only one the user recognises.
// ===========================================================================================================
const phProjects = (workspaces, activeWsId) => {
  const list = workspaces.filter(Boolean);
  list.sort((a, b) => (a.id === activeWsId ? -1 : b.id === activeWsId ? 1 : 0));
  return list;
};
{
  const WS = [
    { id: 'local-home', kind: 'local' },
    { id: 'repo-team', kind: 'repo' },
    { id: 'local-crazy', kind: 'local', adopted: true },
    { id: 'repo-invited', kind: 'repo', needsClone: true },
  ];
  const got = phProjects(WS, 'repo-team').map((w) => w.id);
  eq('history: the active project sorts first', got[0], 'repo-team');
  eq('history: every project is listed', got.length, 4);
  ok('history: a non-active local project is listed', got.includes('local-home'));
  ok('history: an adopted folder is listed', got.includes('local-crazy'));
  ok('history: an un-cloned invite is listed (its card says "not downloaded yet")', got.includes('repo-invited'));
  // the OLD predicate, for the record: `kind === 'repo' || id === activeWsId`
  const old = WS.filter((w) => w.kind === 'repo' || w.id === 'repo-team').map((w) => w.id);
  ok('history: the OLD filter hid the adopted folder (this is the bug)', !old.includes('local-crazy'));
}

// ===========================================================================================================
// 4. adopt-workspace.sh, driven for real against throwaway folders.
// ===========================================================================================================
const HAS_BASH = (() => { try { cp.execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const HAS_GIT = (() => { try { cp.execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
function adopt(dir) {
  const out = cp.execFileSync('bash', [path.join(ROOT, 'wsl/adopt-workspace.sh'), dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try { return JSON.parse(out.trim()); } catch { return { ok: false, error: 'PARSE_FAIL:' + out.slice(0, 120) }; }
}
function newRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-'));
  const g = (...a) => cp.execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 'T'); g('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(d, 'x.txt'), 'x'); g('add', '-A'); g('commit', '-qm', 'root');
  return d;
}
if (!HAS_BASH || !HAS_GIT) {
  console.log('adopt-workspace: bash/git unavailable — skipping the shell leg');
} else {
  // (a) a plain, non-git folder
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-'));
  const ra = adopt(plain);
  ok('sh: a plain folder adopts', ra.ok === true);
  eq('sh: …reports it is not a repo', ra.repo, false);
  ok('sh: …and gets the .claude runtime dir Claude Code needs', fs.existsSync(path.join(plain, '.claude')));
  eq('sh: …named after its basename', ra.name, path.basename(plain));
  eq('sh: …with a canonical path', ra.path, fs.realpathSync(plain));
  fs.rmSync(plain, { recursive: true, force: true });

  // (b) a git repo: the runtime dir must become invisible to `git status`, WITHOUT touching the tracked .gitignore
  const repo = newRepo();
  cp.execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:MKDevv05/Crazy.git'], { stdio: 'ignore' });
  const rb = adopt(repo);
  ok('sh: a git repo adopts', rb.ok === true && rb.repo === true);
  eq('sh: …and its origin is reported for the card link', repoId(rb.origin), 'MKDevv05/Crazy');
  eq('sh: …the runtime is excluded', rb.excluded, true);
  const status = cp.execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
  eq('sh: …so the user\'s repo stays clean', status.trim(), '');
  ok('sh: …via .git/info/exclude, never the shared .gitignore', !fs.existsSync(path.join(repo, '.gitignore')));
  const excl = fs.readFileSync(path.join(repo, '.git/info/exclude'), 'utf8');
  ok('sh: …anchored at the repo root', /^\/\.claude\/$/m.test(excl));

  // (c) idempotent: adopting twice must not append the rule twice
  adopt(repo);
  const lines = fs.readFileSync(path.join(repo, '.git/info/exclude'), 'utf8').split('\n').filter((l) => l === '/.claude/');
  eq('sh: re-adopting does not duplicate the exclude rule', lines.length, 1);

  // (d) a SUBDIR of a repo anchors the pattern to that subdir, not to every .claude in the tree
  const sub = path.join(repo, 'packages', 'api');
  fs.mkdirSync(sub, { recursive: true });
  const rd = adopt(sub);
  ok('sh: a subdirectory of a repo adopts', rd.ok === true && rd.repo === true);
  const excl2 = fs.readFileSync(path.join(repo, '.git/info/exclude'), 'utf8');
  ok('sh: …with a pattern anchored to that subdir', /^\/packages\/api\/\.claude\/$/m.test(excl2));
  fs.rmSync(repo, { recursive: true, force: true });

  // (e) a repo that TRACKS .claude — no exclude rule can help, so say so instead of pretending
  const tracked = newRepo();
  fs.mkdirSync(path.join(tracked, '.claude'));
  fs.writeFileSync(path.join(tracked, '.claude/settings.json'), '{}');
  cp.execFileSync('git', ['-C', tracked, 'add', '-A'], { stdio: 'ignore' });
  cp.execFileSync('git', ['-C', tracked, 'commit', '-qm', 'track .claude'], { stdio: 'ignore' });
  const re = adopt(tracked);
  eq('sh: a repo tracking .claude is adopted but flagged honestly', re.claudeTracked, true);
  eq('sh: …and no exclude rule is claimed', re.excluded, false);
  fs.rmSync(tracked, { recursive: true, force: true });

  // (f) refusals — every one of these would point Claude somewhere it must never run
  eq('sh: refuses the filesystem root', adopt('/').ok, false);
  eq('sh: refuses $HOME', adopt(os.homedir()).ok, false);
  eq('sh: refuses a folder Claudible already manages', adopt(path.join(os.homedir(), '.claudible')).ok, false);
  eq('sh: refuses a path that does not exist', adopt(path.join(os.tmpdir(), 'no-such-dir-xyz')).ok, false);
  eq('sh: refuses a path containing a quote', adopt("/tmp/it's").ok, false);

  // (g) `..` and a trailing slash must canonicalize to ONE spelling — main dedupes adopted projects by path string
  const canon = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-'));
  fs.mkdirSync(path.join(canon, 'a'));
  const p1 = adopt(path.join(canon, 'a')).path;
  const p2 = adopt(path.join(canon, 'a') + '/').path;
  const p3 = adopt(path.join(canon, 'a', '..', 'a')).path;
  ok('sh: /x/a, /x/a/ and /x/./a/../a all canonicalize alike', p1 === p2 && p2 === p3);
  fs.rmSync(canon, { recursive: true, force: true });
}

// ===========================================================================================================
// 4b. git-fetch.sh's credential wiring — the one line that decides whether a PRIVATE repo ever refreshes.
//
// `-c credential.helper=` resets the whole helper chain (that's the point: no Git Credential Manager GUI can
// pop while the panel polls). But the reset is total — it also clears the URL-scoped helper `gh auth setup-git`
// installs, so a bare reset makes every private fetch die with "could not read Username" and the panel silently
// freezes on stale refs. The script re-adds exactly one helper, scoped to github.com. The sanitizer that decides
// whether the gh path is safe to embed had a bug that disabled it for EVERY path — pinned here.
// ===========================================================================================================
const GITFETCH = fs.readFileSync(path.join(ROOT, 'wsl/git-fetch.sh'), 'utf8');
ok('git-fetch.sh: resets the helper chain (no GCM GUI can pop during a background fetch)',
  /-c credential\.helper=/.test(GITFETCH));
ok('git-fetch.sh: …then re-adds gh\'s helper, scoped to github.com (private repos must still refresh)',
  /-c "credential\.https:\/\/github\.com\.helper=!'\$GH' auth git-credential"/.test(GITFETCH));
ok('git-fetch.sh: the scoped key means a GitHub token is never offered to another host',
  !/-c "?credential\.helper=!/.test(GITFETCH));
ok('git-fetch.sh: git\'s own prompt is off', /GIT_TERMINAL_PROMPT=0/.test(GITFETCH));
ok('git-fetch.sh: ssh cannot escalate to a GUI passphrase dialog', /SSH_ASKPASS_REQUIRE=never/.test(GITFETCH));
ok('git-fetch.sh: an explicit branch, never a bare `git fetch origin` (which would rewrite claudible/sessions)',
  /fetch --no-tags --no-recurse-submodules --quiet "\$remote" "\$rbranch"/.test(GITFETCH));
ok('git-fetch.sh: never repacks somebody else\'s repo as a side effect', /-c gc\.auto=0/.test(GITFETCH));
if (HAS_BASH) {
  // Run the SHIPPED sanitizer line against real inputs. `$(printf '\n')` inside a case pattern is the empty
  // string (command substitution strips trailing newlines) → the pattern `*""*` matches everything → GH="" →
  // no helper → every private fetch fails. Verified against the live repo; pinned so it can't come back.
  const sanitizer = GITFETCH.split('\n').find((l) => l.trim().startsWith('case "$GH" in'));
  ok('git-fetch.sh: the gh-path sanitizer line is findable', !!sanitizer);
  const sanitize = (p) => cp.execFileSync('bash', ['-c', `GH="$1"\n${sanitizer}\nprintf '%s' "$GH"`, '_', p], { encoding: 'utf8' });
  eq('git-fetch.sh: a normal gh path SURVIVES the sanitizer', sanitize('/usr/bin/gh'), '/usr/bin/gh');
  eq('git-fetch.sh: …a Windows path with spaces survives too (it gets single-quoted)',
    sanitize('/c/Program Files/GitHub CLI/gh.exe'), '/c/Program Files/GitHub CLI/gh.exe');
  eq('git-fetch.sh: a path with a single quote is rejected (it would break out of the helper string)', sanitize("/tmp/g'h"), '');
  eq('git-fetch.sh: a path with a backslash is rejected', sanitize('/tmp/g\\h'), '');
  eq('git-fetch.sh: a path with a newline is rejected', sanitize('/tmp/g\nh'), '');
}

// ===========================================================================================================
// 4c. TAKING OVER <folder>/.claude. session.sh and win.js stage Claudible's runtime under fixed names —
// settings.json, statusline.js, hook.js, context-hook.js (+ the bash-fallback .sh twins) — and overwrite each
// unconditionally. In an adopted folder every one of those may already be the user's own file. The ownership
// block snapshots them ONCE. It must also NOT snapshot a .claude that is already Claudible's: every existing
// workspace predates the sidecar, and "backing up" our own settings into settings.json.pre-claudible would be
// litter on every install. The block below is lifted verbatim from the shipped script and driven for real.
// ===========================================================================================================
if (HAS_BASH) {
  const lines = SESSION_SH.split('\n');
  const start = lines.findIndex((l) => l.startsWith('if [ ! -e "$SDIR/.claude/.claudible-owned" ]; then'));
  const end = start > -1 ? lines.findIndex((l, i) => i > start && l === 'fi') : -1;
  ok('session.sh: the .claude ownership block is findable', start > -1 && end > start);
  const BLOCK = lines.slice(start, end + 1).join('\n');
  const own = (sdir) => cp.execFileSync('bash', ['-c', `SDIR="$1"\n${BLOCK}`, '_', sdir], { stdio: ['ignore', 'ignore', 'ignore'] });
  const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'own-')); fs.mkdirSync(path.join(d, '.claude')); return d; };
  const CLAUDIBLE_SETTINGS = '{"autoCompactEnabled": false, "env": { "DISABLE_AUTO_COMPACT": "1" },\n'
    + '"statusLine": { "type": "command", "command": "\'/usr/bin/node\' \'/x/.claude/statusline.js\' \'/rt/s.json\'" } }';

  // (a) an adopted folder carrying the user's own runtime: every name we take is snapshotted first
  let d = mk();
  fs.writeFileSync(path.join(d, '.claude/settings.json'), '{"permissions":{"allow":["Bash"]}}');
  fs.writeFileSync(path.join(d, '.claude/statusline.js'), 'MY STATUSLINE');
  fs.writeFileSync(path.join(d, '.claude/hook.sh'), 'MY HOOK');
  own(d);
  eq('own: the user\'s settings.json survives as .pre-claudible',
    fs.readFileSync(path.join(d, '.claude/settings.json.pre-claudible'), 'utf8'), '{"permissions":{"allow":["Bash"]}}');
  eq('own: …and so does their statusline.js (the destructive gap the settings fix missed)',
    fs.readFileSync(path.join(d, '.claude/statusline.js.pre-claudible'), 'utf8'), 'MY STATUSLINE');
  eq('own: …and their bash-fallback hook.sh',
    fs.readFileSync(path.join(d, '.claude/hook.sh.pre-claudible'), 'utf8'), 'MY HOOK');
  ok('own: the sidecar records that we took over', fs.existsSync(path.join(d, '.claude/.claudible-owned')));
  fs.rmSync(d, { recursive: true, force: true });

  // (b) an EXISTING Claudible workspace (settings written by us, no sidecar yet): sidecar only, zero litter
  d = mk();
  fs.writeFileSync(path.join(d, '.claude/settings.json'), CLAUDIBLE_SETTINGS);
  fs.writeFileSync(path.join(d, '.claude/statusline.js'), 'claudible');
  own(d);
  eq('own: an already-Claudible .claude is adopted with NO backup litter',
    fs.readdirSync(path.join(d, '.claude')).filter((f) => f.endsWith('.pre-claudible')).length, 0);
  ok('own: …but it still gets the sidecar', fs.existsSync(path.join(d, '.claude/.claudible-owned')));
  fs.rmSync(d, { recursive: true, force: true });

  // (c) idempotent: the snapshot is of the ORIGINAL, never of a later Claudible-written file
  d = mk();
  fs.writeFileSync(path.join(d, '.claude/statusline.js'), 'USER');
  own(d);
  fs.writeFileSync(path.join(d, '.claude/statusline.js'), 'CLAUDIBLE');   // as a launch would
  own(d);
  eq('own: a second launch never overwrites the snapshot',
    fs.readFileSync(path.join(d, '.claude/statusline.js.pre-claudible'), 'utf8'), 'USER');
  fs.rmSync(d, { recursive: true, force: true });

  // (d) a fresh workspace has nothing to snapshot
  d = mk(); own(d);
  eq('own: a fresh .claude yields no backups', fs.readdirSync(path.join(d, '.claude')).length, 1);
  fs.rmSync(d, { recursive: true, force: true });

  // (e) the fingerprint must be SPECIFIC — a user config that merely disables auto-compact is still theirs
  d = mk();
  fs.writeFileSync(path.join(d, '.claude/settings.json'), '{"env":{"DISABLE_AUTO_COMPACT":"1"}}');
  own(d);
  ok('own: DISABLE_AUTO_COMPACT alone does not make a file "ours" (no statusLine → back it up)',
    fs.existsSync(path.join(d, '.claude/settings.json.pre-claudible')));
  fs.rmSync(d, { recursive: true, force: true });
}

// ===========================================================================================================
// 4d. "Never delete the last local" must not lock an ADOPTED project in place. Removing one deletes nothing —
// it's a pointer. Repro that made this urgent: adopt on first run → the auto-created placeholder is cleaned up
// as redundant → the adopted entry is the only kind:'local' → un-removable forever.
// ===========================================================================================================
const isLastLocal = (w, workspaces) => {
  if (!w) return false;
  if (w.adopted) return !workspaces.some((x) => x.id !== w.id && (x.kind === 'local' || (x.kind === 'repo' && !x.needsClone)));
  return w.kind === 'local' && workspaces.filter((x) => x.kind === 'local').length <= 1;
};
{
  const A = { id: 'local-crazy', kind: 'local', adopted: true };
  const HOME = { id: 'local-local', kind: 'local' };
  const REPO = { id: 'repo-team', kind: 'repo' };
  const INVITE = { id: 'repo-inv', kind: 'repo', needsClone: true };
  ok('lastLocal: an adopted project alongside a local home is removable', !isLastLocal(A, [A, HOME]));
  ok('lastLocal: …alongside a cloned repo too', !isLastLocal(A, [A, REPO]));
  ok('lastLocal: …but NOT when it is the only project', isLastLocal(A, [A]));
  ok('lastLocal: …nor when the only other project has no folder yet', isLastLocal(A, [A, INVITE]));
  ok('lastLocal: the guaranteed local home is still protected', isLastLocal(HOME, [HOME, REPO]));
  ok('lastLocal: …and released once a second local exists', !isLastLocal(HOME, [HOME, A]));
  ok('lastLocal: a repo project was never subject to the rule', !isLastLocal(REPO, [REPO]));
  // the OLD predicate, for the record — this is the lock
  const old = (w, ws) => !!(w && w.kind === 'local' && ws.filter((x) => x.kind === 'local').length <= 1);
  ok('lastLocal: the OLD rule locked a sole adopted project (this is the bug)', old(A, [A, REPO]));
}

// ===========================================================================================================
// 5. GREP GUARDS — pin each invariant to the real source, so a refactor fails here instead of drifting.
// ===========================================================================================================
ok('main.js: workspace:delete skips the folder-trashing script for an adopted ws',
  /!ws\.adopted && \(ws\.kind === 'local' \|\| ws\.kind === 'repo'\)/.test(MAIN));
// The refusal must sit INSIDE workspace:upgrade and BEFORE its only runScript — an `adopted` check placed after
// the shell-out would read fine and still republish the user's repo.
{
  const h = /ipcMain\.handle\('workspace:upgrade'[\s\S]*?\n\}\);/.exec(MAIN);
  ok('main.js: the workspace:upgrade handler is findable', !!h);
  const body = h ? h[0] : '';
  const iRefuse = body.indexOf("if (ws.adopted) return { ok: false");
  const iShell = body.indexOf("runScript('upgrade-workspace.sh'");   // the CALL, not the comment that explains it
  ok('main.js: workspace:upgrade refuses an adopted ws BEFORE it can shell out',
    iRefuse > -1 && iShell > -1 && iRefuse < iShell);
}
ok('main.js: an adopted repo suppresses its own re-discovery as a clone-me invite',
  /w\.adopted && w\.repoId === owner \+ '\/' \+ slug/.test(MAIN));
ok('main.js: the background-fetch throttle stamps BEFORE the await (no stacked spawns)',
  /_lastFetch\.set\(ws\.id, Date\.now\(\)\);[\s\S]{0,200}?fetchLock\.add\(ws\.id\);[\s\S]{0,200}?runScript\('git-fetch\.sh'/.test(MAIN));
ok('main.js: deleting a workspace clears its fetch throttle', /_lastFetch\.delete\(id\); fetchLock\.delete\(id\)/.test(MAIN));
// The snapshot must precede EVERY write into .claude — the hook `cp`s come first, the settings heredoc later.
{
  const iOwn = SESSION_SH.indexOf('.claudible-owned');
  const iHooks = SESSION_SH.indexOf('cp "$APPDIR/hooks/statusline.js"');
  const iSettings = SESSION_SH.indexOf('cat > "$SDIR/.claude/settings.json"');
  ok('session.sh: the ownership snapshot runs BEFORE the hook scripts are staged', iOwn > -1 && iHooks > iOwn);
  ok('session.sh: …and before settings.json is written', iSettings > iOwn);
  ok('session.sh: it covers the hook scripts, not just settings.json',
    /for _f in settings\.json statusline\.js hook\.js context-hook\.js statusline\.sh hook\.sh context-hook\.sh/.test(SESSION_SH));
}
{
  const iOwn = WIN.indexOf(".claudible-owned");
  const iHooks = WIN.indexOf("fs.copyFileSync(path.join(APP_ROOT, 'hooks', 'statusline.js')");
  const iSettings = WIN.indexOf("fs.writeFileSync(path.win32.join(cdir, 'settings.json')");
  ok('win.js: the Windows-native twin snapshots before staging its hooks', iOwn > -1 && iHooks > iOwn);
  ok('win.js: …and before writing settings.json', iSettings > iOwn);
  ok('win.js: it covers the hook scripts too',
    /for \(const f of \['settings\.json', 'statusline\.js', 'hook\.js', 'context-hook\.js'\]\)/.test(WIN));
}
ok('main.js: an adopted project can be removed once another OPENABLE project remains',
  /if \(ws\.adopted\) \{[\s\S]{0,320}?w\.kind === 'repo' && !w\.needsClone/.test(MAIN));
ok('main.js: checkpoint restore is refused at the DESTRUCTIVE call site, not by luck elsewhere',
  /_ckptAllowed\(ws\)\) return resolve\(\{ ok: false[\s\S]{0,200}?_ckptRun\(ws, 'restore ' \+ cid\)/.test(MAIN)
  && /_ckptAllowed\(ws\)\) return resolve\(\{ ok: false[\s\S]{0,200}?_ckptRun\(ws, 'restore undo'\)/.test(MAIN));
ok('main.js: an adopted project\'s GitHub link is re-derived from the folder\'s live origin',
  /ws\.adopted && typeof r\.origin === 'string'/.test(MAIN));
ok('app.js: both delete affordances share ONE prompt (they can never disagree about the folder)',
  (APP.match(/confirm\(deleteWsPrompt\(w\)\)/g) || []).length === 2);
ok('diff.sh: reports the folder\'s own origin so a stale cached link can self-heal',
  /origin="\$\(git remote get-url origin/.test(DIFF_SH));
ok('app.js: Project History lists every workspace (no kind filter)',
  /function _phProjects\(\)[\s\S]{0,700}?\.filter\(Boolean\)/.test(APP) && !/_phProjects[\s\S]{0,400}?w\.kind === 'repo' \|\| w\.id === activeWsId/.test(APP));
ok('app.js: an un-cloned invite says so instead of "not a git repo"',
  /if \(w\.needsClone\)[\s\S]{0,200}?Not downloaded yet/.test(APP));
ok('app.js: the ws menu never offers upgrade/invite on an adopted folder',
  /else if \(w\.kind === 'local' && !w\.adopted\)/.test(APP));
ok('app.js: "Remove from Claudible" is the adopted wording (nothing is deleted)',
  /w\.adopted \? \{[\s\S]{0,300}?Remove from Claudible/.test(APP));
ok('app.js: a commit is only labelled unpushed when its push state is KNOWN',
  /c\.pushed === false/.test(APP) && !/!c\.pushed\b/.test(APP));
ok('app.js: committed diffs stay review-only (readOnly=true is what forbids reverting them)',
  /committed\.forEach\(\(f\) => body\.appendChild\(renderDiffFile\(f, true, targetWsId\)\)\)/.test(APP));
ok('diff.sh: never fetches — the panel\'s 30s read budget must not absorb the network',
  !/git\s+(-c[^\n]*\s)?fetch/.test(DIFF_SH));
ok('diff.sh: an upstream that isn\'t actually on disk is treated as no upstream',
  /rev-parse --verify --quiet "\$upstream\^\{commit\}"[\s\S]{0,80}?upstream=""/.test(DIFF_SH));
ok('diff.sh: uses `git symbolic-ref` for the branch (rev-parse --abbrev-ref prints "HEAD" on an unborn branch)',
  /branch="\$\(git symbolic-ref --quiet --short HEAD/.test(DIFF_SH) && !/branch="\$\(git rev-parse --abbrev-ref HEAD/.test(DIFF_SH));
ok('_shared.js: the wsEnv kind allowlist is unchanged (adoption must not need a new kind)',
  /\['local', 'repo', 'legacy'\]\.includes\(ws\.kind\)/.test(SHARED));

console.log(`adopt-workspace: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
