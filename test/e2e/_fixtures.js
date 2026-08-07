// test/e2e/_fixtures.js — launches ONE fully isolated Claudible instance for a Playwright spec.
//
// ISOLATION — every mechanism below was confirmed by READING the app source (main.js / runners/win.js),
// not assumed:
//   • HOME + USERPROFILE   → main.js's PERSIST/RT defaults, ensureDefaultLocal()'s workspace dir, and
//                            runners/win.js's HOME() all resolve through process.env.USERPROFILE ||
//                            process.env.HOME. Pointing both at a fresh temp dir relocates ~/.claudible,
//                            ~/.claude, and the default "Local" workspace folder in one move.
//   • CLAUDIBLE_PERSIST     → main.js line ~208: settings.json/workspaces.json/history live here. Reads the
//                            env var FIRST, so this is a guaranteed override independent of how Electron's
//                            own app.getPath('home') resolves on this machine.
//   • CLAUDIBLE_RUNTIME     → per-tab status.json/hooks.ndjson/context.json. runners/win.js's runtimeDir()
//                            reads this env var UNCONDITIONALLY (not just when app.isPackaged, unlike
//                            main.js's own packaged-only default) — so setting it always relocates runtime,
//                            even in `electron .` dev mode.
//   • CLAUDIBLE_RUNNER=win  → forces the native-Windows runner instead of the platform-default WSL runner
//                            (runners/runner.js: `win32` → wsl unless CLAUDIBLE_RUNNER overrides it). wsl.js
//                            DELIBERATELY ignores CLAUDIBLE_RUNTIME (its header explains why: bash derives
//                            the runtime root from $APPDIR, and Windows env can't cross wsl.exe), so it is
//                            the one runner CLAUDIBLE_RUNTIME above cannot isolate. Forcing 'win' sidesteps
//                            that entirely and — as a bonus — means this harness has no dependency on WSL
//                            being installed on the machine running the tests.
//   • --user-data-dir       → Electron's own chromium profile (renderer localStorage/IndexedDB/session
//                            cookies) AND, critically, app.requestSingleInstanceLock() (main.js ~4173) is
//                            keyed off it — without a per-instance value, a second harness instance (or a
//                            real Claudible already running on the dev box) would lose the lock race and
//                            silently app.quit() before a window ever appears.
//   • APPDATA/LOCALAPPDATA  → defensive: main.js's refreshWindowsPath() and the win runner's gitBash()
//                            lookups fall back to these for portable-tool bins; nothing this harness does
//                            should ever touch the real machine's roaming config.
//
// FIRST-RUN WIZARD: not skipped via app source changes. main.js's preload reads settingsInitial via a
// SYNCHRONOUS 'settings:get' at boot (renderer/app.js loadPrefs()), which is CLAUDIBLE_PERSIST/settings.json
// — so pre-seeding that file with `onboardingDone:true` before launch is indistinguishable, from the app's
// point of view, from a real user who already finished onboarding (renderer/app.js:6105 gates the wizard on
// exactly that flag). Separately, a BRAND NEW workspaces.json has no local workspace yet, so main.js's
// ensureDefaultLocal() would materialize one and set registry.firstRun=true, which renderer/app.js's
// maybeFirstRun() turns into a "name your project" modal even with the wizard itself skipped — pre-seeding
// workspaces.json with the default local workspace already present avoids that too. No CLAUDIBLE_E2E hook
// was needed.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { _electron: electron } = require('playwright/test');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FAKE_CLAUDE_DIR = path.join(__dirname, 'fake-claude');
// test/e2e/fake-gh/ — the same shim technique as fake-claude, for wsl/sessions-sync.sh's ONE gh dependency:
// `gh api user --jq .login` (author identity for the sync branch). This has NOTHING to do with real GitHub
// auth — the bare-remote fixtures below stand in for GitHub entirely — but the script unconditionally shells
// out to gh to learn "who am I", so a sync-exercising instance needs *something* named `gh` on PATH that
// answers that one question deterministically, without ever touching the dev box's real `gh auth` state.
const FAKE_GH_DIR = path.join(__dirname, 'fake-gh');

function electronExecutable() {
  // Same resolution `electron .` (package.json's start script) relies on — the local devDependency, so the
  // native node-pty build matches the Electron ABI it was rebuilt against.
  const bin = require(path.join(REPO_ROOT, 'node_modules', 'electron'));
  if (!bin || typeof bin !== 'string' || !fs.existsSync(bin)) {
    throw new Error('electron binary not found at ' + bin + ' — run `npm install` first.');
  }
  return bin;
}

function seedIsolatedStorage({ persistDir, homeDir }) {
  fs.mkdirSync(persistDir, { recursive: true });
  // 1) Skip the first-run wizard (renderer/app.js:6105 gates it on loadPrefs().onboardingDone).
  fs.writeFileSync(
    path.join(persistDir, 'settings.json'),
    JSON.stringify({ onboardingDone: true, wsHintSeen: true }),
  );
  // 2) Pre-populate the registry with the SAME default-local shape main.js's ensureDefaultLocal() would
  //    synthesize (main.js DEFAULT_LOCAL) — this is why registry.firstRun never gets set, which is why the
  //    post-boot "name your project" ws-modal (renderer/app.js maybeFirstRun) never fires either.
  const wsId = 'local-local';
  fs.writeFileSync(
    path.join(persistDir, 'workspaces.json'),
    JSON.stringify({
      activeId: wsId,
      workspaces: [{ id: wsId, label: 'Local', kind: 'local', slug: 'local', createdAt: Date.now() }],
    }),
  );
  // Belt-and-suspenders: the real workspace folder main.js's runners/win.js sessionDir() would resolve to
  // for this workspace (home/.claudible/workspaces/local). installHooks() would mkdir -p it on first spawn
  // anyway, but creating it up front means even a spec that never spawns a session sees a sane filesystem.
  fs.mkdirSync(path.join(homeDir, '.claudible', 'workspaces', 'local'), { recursive: true });
}

// launchClaudible(opts) → { app, page, home, sandbox, stop() }
//   opts.withClaude   (bool, default false) — prepend test/e2e/fake-claude/ to PATH so runners/win.js's
//                     whichClaude()/pickClaudeBin() resolves OUR shim (a tiny node script that echoes input
//                     and stays alive) instead of any real claude on the dev machine. Leave this off for
//                     UI-only specs (sidebar/modals/share dialogs) per the harness's hard rules — they must
//                     not require a working claude at all.
//   opts.withGh       (bool, default false) — prepend test/e2e/fake-gh/ to PATH (see FAKE_GH_DIR above) AND
//                     set CLAUDIBLE_GIT_BASH so runners/win.js's runScript() (git-bash → wsl/*.sh) actually
//                     works — required for ANYTHING that touches a repo workspace's sync machinery
//                     (session:syncNow, session:list-ws, workspace registration). Off by default: most specs
//                     never open a repo workspace, and resolving git-bash costs a real subprocess at launch.
//   opts.ghLogin      (string) — the identity the fake gh shim answers `gh api user --jq .login` with
//                     (CLAUDIBLE_E2E_GH_LOGIN). Only meaningful with withGh.
//   opts.gitBash      (string) — override the auto-resolved git-bash path (see resolveGitBash below).
//   opts.seed         (async ({persist, home, runtime, sandbox}) => void) — runs AFTER the standard
//                     onboarding-skip seeding but BEFORE electron.launch(), so a caller can add more to
//                     workspaces.json (e.g. a pre-cloned repo workspace) while the registry is still just
//                     files on disk — the one point at which seeding is indistinguishable from a real user's
//                     prior state (see the FIRST-RUN WIZARD note above).
//   opts.skipOnboarding (bool, default true) — pre-seed settings.json/workspaces.json as described above.
//   opts.env          (object) — extra env vars merged in last (can override anything above).
//   opts.timeout      (ms, default 30000) — Electron launch timeout.
async function launchClaudible(opts = {}) {
  const withClaude = !!opts.withClaude;
  const withGh = !!opts.withGh;
  const skipOnboarding = opts.skipOnboarding !== false;

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'claudible-e2e-'));
  const home = path.join(sandbox, 'home');
  const persist = path.join(home, '.claudible', 'app');
  const runtime = path.join(home, '.claudible', 'runtime');
  const userData = path.join(sandbox, 'userdata');
  const appData = path.join(sandbox, 'appdata');
  const localAppData = path.join(sandbox, 'localappdata');
  for (const d of [home, persist, runtime, userData, appData, localAppData]) fs.mkdirSync(d, { recursive: true });

  if (skipOnboarding) seedIsolatedStorage({ persistDir: persist, homeDir: home });
  if (typeof opts.seed === 'function') await opts.seed({ persist, home, runtime, sandbox });

  const env = Object.assign({}, process.env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    CLAUDIBLE_PERSIST: persist,
    CLAUDIBLE_RUNTIME: runtime,
    CLAUDIBLE_RUNNER: 'win',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  });
  const pathParts = [];
  if (withClaude) pathParts.push(FAKE_CLAUDE_DIR);
  if (withGh) pathParts.push(FAKE_GH_DIR);
  if (pathParts.length) env.PATH = pathParts.join(path.delimiter) + path.delimiter + (process.env.PATH || '');
  if (withGh) {
    // Every repo-workspace script call (sync, session listing) goes through runners/win.js's runScript(),
    // which shells out to git-bash. win.js's own gitBash() candidate search assumes Git lives at a canonical
    // install root (Program Files\Git, or one level above a bin\git.exe) — it does NOT understand a scoop/
    // chocolatey shim tree (a small launcher .exe in one dir, the real MSYS install in another), so on a dev
    // box provisioned that way win.js resolves NO usable bash and every sync call fails closed. CLAUDIBLE_GIT_BASH
    // is win.js's own documented override (checked first, before any of its heuristics) — not a code change,
    // just supplying the one env var it already knows how to use.
    env.CLAUDIBLE_GIT_BASH = opts.gitBash || resolveGitBash() || '';
    if (!env.CLAUDIBLE_GIT_BASH) throw new Error('withGh:true but no usable git-bash was found — install Git for Windows, or pass opts.gitBash.');
    if (opts.ghLogin) env.CLAUDIBLE_E2E_GH_LOGIN = opts.ghLogin;
  }
  if (opts.env) Object.assign(env, opts.env);

  const app = await electron.launch({
    executablePath: electronExecutable(),
    // Mirrors `electron .`: first positional arg is the app directory (package.json main=main.js).
    args: [REPO_ROOT, '--user-data-dir=' + userData],
    cwd: REPO_ROOT,
    env,
    timeout: opts.timeout || 30000,
  });

  const page = await app.firstWindow({ timeout: opts.timeout || 30000 });

  // Track the main process pid up front — stop()'s orphan check needs it even if close() itself hangs.
  const pid = app.process().pid;

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    try { await app.close(); }
    catch {
      // close() talks to the app over CDP; if the renderer/main is already wedged, fall back to a hard kill
      // so a broken spec still leaves no orphan process.
      try { app.process().kill(); } catch {}
    }
    // Best-effort sandbox cleanup — never fails the test over a locked file on a slow disk.
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {}
  }

  return { app, page, home, sandbox, persist, runtime, userData, pid, stop };
}

// ---- process helpers for orphan checks (Windows tasklist/CIM — this harness only runs on the Windows dev box) --

// Is a pid still alive? `tasklist /FI "PID eq N"` prints one CSV-ish row per match, or an
// "INFO: No tasks..." line when there are none — check for the pid as a distinct token rather than
// parsing full CSV, since the exact banner text is locale-dependent.
function isPidAlive(pid) {
  if (!pid) return false;
  const cp = require('child_process');
  try {
    const out = cp.execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    return new RegExp(`"${pid}"`).test(out);
  } catch { return false; }
}

// pids of every live descendant of `pid` (children, grandchildren, …), via WMI/CIM — used to prove a
// claude-shim spawn actually happened (and later, that it's gone) without hardcoding an image name.
function listDescendantPids(pid) {
  if (!pid) return [];
  const cp = require('child_process');
  const children = (ppid) => {
    try {
      const out = cp.execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "ParentProcessId=${ppid}" | Select-Object -ExpandProperty ProcessId`,
      ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      return out.split(/\r?\n/).map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n));
    } catch { return []; }
  };
  const all = [];
  const queue = [pid];
  const seen = new Set();
  while (queue.length) {
    const cur = queue.shift();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const c of children(cur)) { all.push(c); queue.push(c); }
  }
  return all;
}

// ---- two-machine simulation: a local bare repo standing in for GitHub, and a pair of isolated instances
// pointed at it. See docs/TWO-MACHINE-TEST.md for what this replaces (manual A/B hardware testing) and
// wsl/sessions-sync.sh for the sync protocol these fixtures drive for real.

// win.js is REQUIRED DIRECTLY (not through the app's own runner.js) so this Node harness process can reuse
// its exact, already-unit-tested sessionDir()/claudeProjectsDir() path math (test/win-runner.test.js) instead
// of re-deriving the same non-alnum→'-' encoding by hand and risking a silent drift from the real thing. Pure
// functions only (fs/path/child_process) — safe to require outside Electron. Read-only use: nothing here
// calls any of win.js's Electron-dependent exports.
const winRunner = require(path.join(REPO_ROOT, 'runners', 'win.js'));

// Resolve a REAL (MSYS) git-bash for runners/win.js's runScript() to shell out to. Deliberately narrower than
// win.js's own gitBash() (runners/win.js:49-88): that function's fallback heuristics assume Git lives at a
// canonical two-level install root and cannot see through a package-manager shim (e.g. scoop installs a tiny
// launcher .exe under scoop\shims\git.exe with the real MSYS tree under scoop\apps\git\current\ — win.js's
// `where git.exe` → dirname(dirname()) derivation never finds it). CLAUDIBLE_GIT_BASH is win.js's own
// documented override for exactly this gap.
function resolveGitBash() {
  const cands = [
    process.env.CLAUDIBLE_GIT_BASH,
    path.join(os.homedir(), 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),   // scoop's real layout
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} }
  return null;
}

// A throwaway `git init --bare` repo standing in for "GitHub" — the sync protocol (wsl/sessions-sync.sh)
// only ever talks to a git remote named `origin`; it has no idea (and no way to tell) whether that remote is
// GitHub or a folder on the same disk. Cleaned up by the OS temp dir; not wired to any instance's stop().
function localBareRemote() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudible-e2e-remote-'));
  cp.execFileSync('git', ['init', '--bare', '-q', dir], { windowsHide: true });
  return dir;
}

// Register a repo workspace DIRECTLY in workspaces.json, pre-cloned from `remote` — bypassing every
// gh-CLI-dependent surface (repo create, collaborator invite, device auth) the hard rules keep out of scope.
// SHAPE SOURCE: main.js's workspace:import handler (main.js:2569-2570) —
//   `{ id: 'repo-'+slug, label, kind:'repo', slug, owner, repoName, repoUrl, createdAt, needsClone }`
// — with `needsClone` simply omitted (falsy, same as a normal completed clone: every sync/list call gates on
// `!ws.needsClone`) and `syncSessions:true` added, matching the same field workspace:create's shared-repo tile
// sets post-clone (main.js:2622) — that boolean, not the workspace's kind, is sync's own on/off switch
// (main.js's doSync/schedulePush/startPoll all gate on `ws.syncSessions`, e.g. main.js:1918).
//
// DELIBERATELY LEAVES registry.activeId ALONE (still the default 'local-local' seedIsolatedStorage wrote) —
// this is load-bearing, not an oversight: main.js opens a pty tab for the ACTIVE workspace at boot, and
// main.js's own adaptive background poll (startPoll, main.js:1975) only syncs a repo workspace that has an
// OPEN TAB — the beacon (main.js's remote-head probe, ~line 2046) is the ONLY mechanism documented to sync
// EVERY synced workspace "not just those with an open tab". Auto-activating the seeded repo workspace here
// would give it an open tab on both instances, letting the (working) slow poll silently stand in for the
// (hardware-broken, per B18/C29) beacon and mask exactly the bug the sync-pair spec exists to reproduce.
function seedRepoWorkspace({ persist, home }, { slug, owner, remote, collaborators }) {
  const wid = `repo-${slug}`;
  const ws = {
    id: wid, label: slug, kind: 'repo', slug, owner, repoName: slug,
    repoUrl: remote, syncSessions: true, createdAt: Date.now(),
  };
  const sdir = winRunner._internals.sessionDir(ws, home);   // C:\...\home\.claudible\repos\<slug> — same dir sessions-sync.sh's SDIR resolves to (see wsl/sessions-sync.sh:37)
  // main.js's OWN creation flow (workspace:create's attach()) always sets `path` to the script's resolved
  // absolute dir — several main.js gates key on it being truthy (e.g. _coauthorTargetWs, main.js ~3938: "ws.kind
  // === 'repo' && ws.path"). Setting it here to the SAME value sessionDir() would already compute from
  // kind+slug is a no-op for path resolution (sessionDir() prefers ws.path when present, and this IS that
  // value) — it exists purely so a seeded repo workspace's SHAPE matches a real one for every consumer that
  // checks ws.path's mere presence, not just its resolution.
  ws.path = sdir;
  if (Array.isArray(collaborators) && collaborators.length) ws.collaborators = collaborators;   // repo:invite'd GitHub identities — see coauthor-hook.js's buildCoauthorLines
  fs.mkdirSync(path.dirname(sdir), { recursive: true });
  cp.execFileSync('git', ['clone', '-q', remote, sdir], { windowsHide: true });

  const wsFile = path.join(persist, 'workspaces.json');
  const reg = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
  reg.workspaces.push(ws);
  fs.writeFileSync(wsFile, JSON.stringify(reg));
  return ws;
}

// An ADOPTED workspace: kind:'local', adopted:true, repoId:"owner/name" — the shape workspace:adopt (main.js)
// gives an EXISTING local git clone whose own `origin` remote already points at a real GitHub repo, as opposed
// to a repo Claudible created/invited the user into (kind:'repo'). This is the B14 hardware gap: the owners'
// own claudible-development workspace (the sessions/tools repo) was added this way — an existing local clone,
// not created/invited through the app — so it never carried ws.kind==='repo' at all. Mirrors seedRepoWorkspace's
// shape/clone logic exactly; only the registry entry's kind/adopted/repoId differ.
function seedAdoptedRepoWorkspace({ persist, home }, { slug, owner, remote, collaborators }) {
  const wid = `local-${slug}`;
  const sdir = path.join(home, '.claudible', 'workspaces', slug);   // workspace:adopt never provisions under ~/.claudible/repos — it points straight at wherever the folder already lives; this mirrors that shape without needing a real folder-picker dialog
  const ws = {
    id: wid, label: slug, kind: 'local', slug, adopted: true, path: sdir,
    repoId: `${owner}/${slug}`, createdAt: Date.now(),
  };
  if (Array.isArray(collaborators) && collaborators.length) ws.collaborators = collaborators;
  fs.mkdirSync(path.dirname(sdir), { recursive: true });
  cp.execFileSync('git', ['clone', '-q', remote, sdir], { windowsHide: true });

  const wsFile = path.join(persist, 'workspaces.json');
  const reg = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
  reg.workspaces.push(ws);
  fs.writeFileSync(wsFile, JSON.stringify(reg));
  return ws;
}

// Fabricate a real (qualifying) Claude transcript directly on disk — the file shape sync + the sidebar both
// gate on (wsl/prompt-scan.js's hasRealPrompt / wsl/sessions-tool.js's msgs counter): a `type:"user"` line
// whose message.content is non-empty text not starting with '<' or 'Caveat'. This is the harness's stand-in
// for "a Claude turn happened here" — it exercises the REAL sync pipeline (git branch, import/export, the
// sidebar's session:list-ws) against a real file on a real (fake) machine, without needing a working `claude`
// or fake-claude PTY for THIS spec's purpose (advancing sync state, not exercising the terminal).
function writeFakeTranscript(instance, ws, sessionId, promptText) {
  const sdir = winRunner._internals.sessionDir(ws, instance.home);
  const projDir = winRunner._internals.claudeProjectsDir(sdir, instance.home);
  fs.mkdirSync(projDir, { recursive: true });
  const line = JSON.stringify({ type: 'user', message: { content: String(promptText || 'hello') } });
  fs.writeFileSync(path.join(projDir, `${sessionId}.jsonl`), line + '\n');
  return { sdir, projDir, file: path.join(projDir, `${sessionId}.jsonl`) };
}

// Two fully isolated instances ('crazy-e2e' / 'mk-e2e' — distinct git/gh identities, per the mission's
// two-machine simulation) sharing ONE repo workspace pointed at the same local bare remote. Each instance
// gets its OWN sandboxed $HOME (so its own $HOME/.claudible/repos/<slug> clone, its own $HOME/.claude/projects
// transcript store) — exactly like two real machines, just both running on this box. The shared repo
// workspace is registered but NOT made active (see seedRepoWorkspace's comment) — the default 'Local'
// workspace stays active, so main.js's boot flow still opens a pty tab (defensively covered by
// withClaude:true — main.js's spawn-on-size fallback, see smoke.spec.js's comment, will try to resolve SOME
// `claude` shortly after boot regardless of what the spec cares about) but that tab is bound to 'local-local',
// never to the shared workspace — keeping the regular adaptive poll out of the picture entirely.
async function launchPair({ slug, remote, timeout } = {}) {
  const bareRemote = remote || localBareRemote();
  const gitBash = resolveGitBash();
  if (!gitBash) throw new Error('launchPair: no usable git-bash found — install Git for Windows, or pass opts to resolveGitBash via CLAUDIBLE_GIT_BASH.');

  async function launchOne(ghLogin) {
    let ws = null;
    const inst = await launchClaudible({
      withClaude: true,
      withGh: true,
      ghLogin,
      gitBash,
      seed: (ctx) => { ws = seedRepoWorkspace(ctx, { slug, owner: 'crazy-e2e', remote: bareRemote }); },
      timeout,
    });
    inst.ws = ws;
    inst.wsId = ws.id;
    inst.sdir = winRunner._internals.sessionDir(ws, inst.home);
    inst.projDir = winRunner._internals.claudeProjectsDir(inst.sdir, inst.home);
    return inst;
  }

  const A = await launchOne('crazy-e2e');
  const B = await launchOne('mk-e2e');
  return { A, B, remote: bareRemote };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait until the renderer's OWN top-level script (app.js) has actually started executing — NOT just that the
// document parsed far enough to have a <title> (Playwright's toHaveTitle only proves that, since <title> sits
// in <head>, long before the bottom-of-body <script src="app.js"> tag even starts fetching/running). Under this
// box's own documented cross-spec CPU contention (see share-guest.spec.js / sync-pair.spec.js's headers), that
// gap can outlast a spec's very first `page.evaluate` read of one of app.js's top-level `let`s — which throws a
// hard ReferenceError ("X is not defined"), not a soft "not yet" — and most of Playwright's own retry helpers
// (expect.poll included) do NOT retry past a thrown exception, so the race fails the WHOLE test in under a
// second instead of politely waiting out its timeout. `typeof` is the one JS construct that reads an
// undeclared identifier without throwing, so it is safe to poll before app.js exists at all. `activeWsId`
// (renderer/app.js line ~175, `let workspaces = [], activeWsId = 'legacy'`) is declared early and unconditionally.
async function waitForAppReady(page, timeout = 20000) {
  const { expect } = require('playwright/test');
  await expect.poll(() => page.evaluate(() => (typeof activeWsId !== 'undefined')), { timeout }).toBe(true);
}

// Retry session:syncNow through TRANSIENT failures — the remote-head beacon (main.js's per-ws probe chain,
// ~main.js:2046-2159) polls EVERY synced repo workspace regardless of whether it has an open tab, so it can
// be holding this workspace's sync lock at the exact moment a spec's own manual call fires. 'sync-busy'
// (doSync's own lock guard, main.js:1919) is the expected shape of that race — the renderer itself treats it
// as "redundant, not failed" (renderer/app.js:5982). Under sustained concurrent load the underlying git-bash/
// gh-shim round trip can also drop a call outright once in a while; retrying past that too is what a real
// user clicking "Sync sessions now" again would experience. A call that keeps failing for a DIFFERENT reason
// past the whole budget is a real result, not swallowed here — the caller still sees it.
async function syncNowRetry(page, wsId, { budgetMs = 30000, gapMs = 1500 } = {}) {
  const deadline = Date.now() + budgetMs;
  let r = null;
  do {
    r = await page.evaluate((wid) => globalThis.claudible.syncNow(wid), wsId);
    if (r && r.ok) return r;
    if (Date.now() >= deadline) return r;
    await sleep(gapMs);
  } while (true);
}

module.exports = {
  launchClaudible, REPO_ROOT, FAKE_CLAUDE_DIR, FAKE_GH_DIR, isPidAlive, listDescendantPids,
  resolveGitBash, localBareRemote, seedRepoWorkspace, seedAdoptedRepoWorkspace, writeFakeTranscript, launchPair,
  sleep, syncNowRetry, waitForAppReady,
};
