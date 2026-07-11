// test/contract.test.js — the static WIRING contract. Zero deps, pure text analysis of the shipped source.
//
// The renderer, preload bridge, main-process IPC, wsl scripts and CSS are wired together by STRING NAMES that
// nothing type-checks: a `$('foo')` that has no `id="foo"`, a `claudible.bar()` with no preload bridge, a
// `runScript('x.sh')` for a file that was renamed. Every one of those is a silent no-op or a crash the test
// suite can't see, because main.js can't even be require()'d and app.js needs a browser. This test closes that
// gap with grep-level rigor: it proves the names on both ends of each seam still match.
//
// It already found real dead paths on the way in ($('ptt-kbd'), $('vout-name'), .ptt-hint — all removed).
// Run: node test/contract.test.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP = read('renderer/app.js');
const HTML = read('renderer/index.html');
const GUEST_JS = read('share/guest.js');
const GUEST_HTML = read('share/guest.html');
const PRELOAD = read('preload.js');
const MAIN = read('main.js');

let pass = 0, fail = 0;
// list of offenders, capped so a wholesale breakage doesn't scroll forever
const none = (label, arr) => { if (!arr.length) { pass++; return; } fail++; console.error(`  FAIL ${label}: ${arr.slice(0, 12).join(', ')}${arr.length > 12 ? ` … (+${arr.length - 12})` : ''}`); };
const uniq = (a) => [...new Set(a)];
const matches = (s, re) => [...s.matchAll(re)].map((m) => m[1]);

// ---------------------------------------------------------------------------------------------------------
// 1. $('id') → an id that exists in the matching HTML (or is created dynamically by the same script).
//    The one dynamic case here is `toast` (document.createElement + t.id = 'toast'); the scan for `.id = '…'`
//    picks that up so it isn't a false positive.
// ---------------------------------------------------------------------------------------------------------
// ids the JS creates itself: `el.id = 'x'` AND `id="x"` written inside an innerHTML string template.
function declaredIds(html, js) {
  const s = new Set(matches(html, /id="([^"]+)"/g));
  matches(js, /\.id\s*=\s*['"]([a-zA-Z0-9_-]+)['"]/g).forEach((id) => s.add(id));   // el.id = 'x'
  matches(js, /\bid=["']([a-zA-Z0-9_-]+)["']/g).forEach((id) => s.add(id));         // id="x" inside an innerHTML string
  return s;
}
{
  const declared = declaredIds(HTML, APP);
  const looked = uniq(matches(APP, /\$\(['"]([a-zA-Z0-9_-]+)['"]\)/g));
  none("renderer: $('id') with no matching element", looked.filter((id) => !declared.has(id)));
}
{
  const declared = declaredIds(GUEST_HTML, GUEST_JS);
  const looked = uniq(matches(GUEST_JS, /getElementById\(['"]([a-zA-Z0-9_-]+)['"]\)/g));
  none("guest: getElementById('id') with no matching element", looked.filter((id) => !declared.has(id)));
}

// ---------------------------------------------------------------------------------------------------------
// 2. claudible.X() in the renderer → an X exposed by preload.js. A typo or a removed bridge = a TypeError the
//    moment that path runs. (share/guest.js never touches the preload bridge — it's a plain browser tab.)
// ---------------------------------------------------------------------------------------------------------
const preloadApi = new Set(matches(PRELOAD, /^\s{2}([a-zA-Z0-9_]+):/gm));
const apiCalls = uniq(matches(APP, /\bclaudible\.([a-zA-Z0-9_]+)\b/g));
none('renderer: claudible.X() with no preload bridge', apiCalls.filter((x) => !preloadApi.has(x)));

// ---------------------------------------------------------------------------------------------------------
// 3. Every preload IPC channel is served by main.js — as an ipcMain.handle/on target (renderer→main) OR pushed
//    to the renderer (main→renderer) via winSend/webContents.send, or over the live-mirror relay
//    (liveSend(tabId, 'chan') / liveForward) or a share-server callback that winSends. Resolve all of those, so
//    the 11 live:* channels don't read as orphans.
// ---------------------------------------------------------------------------------------------------------
const preloadInvokes = uniq(matches(PRELOAD, /ipcRenderer\.(?:invoke|send|sendSync)\(['"]([^'"]+)['"]/g));
const preloadListens = uniq(matches(PRELOAD, /ipcRenderer\.on\(['"]([^'"]+)['"]/g));
const mainHandles = new Set(matches(MAIN, /ipcMain\.(?:handle|on)\(['"]([^'"]+)['"]/g));
// every string literal main pushes out (winSend/webContents.send first arg, liveSend/liveForward SECOND arg)
const mainPushes = new Set([
  ...matches(MAIN, /(?:winSend|webContents\.send)\(['"]([^'"]+)['"]/g),
  ...matches(MAIN, /live(?:Send|Forward)\([^,]+,\s*['"]([^'"]+)['"]/g),
]);
none('preload invoke/send with no ipcMain handler', preloadInvokes.filter((c) => !mainHandles.has(c)));
none('preload ipcRenderer.on for a channel main never pushes', preloadListens.filter((c) => !mainPushes.has(c)));
// …and the reverse: an ipcMain handler the renderer can't reach (a dead channel). Informational but pinned:
// a handler with no bridge is code no one can call.
none('ipcMain handler with no preload bridge', [...mainHandles].filter((c) => !preloadInvokes.includes(c)));

// ---------------------------------------------------------------------------------------------------------
// 4. runScript('x.sh'|'x.js') → a file that exists under wsl/; and every wsl/*.sh|*.js is actually referenced
//    (by runScript, by a sibling script's `node .../x.js`, or by being sourced). A renamed script that left a
//    caller behind is a runtime failure the panel reports as "empty".
// ---------------------------------------------------------------------------------------------------------
const wslFiles = fs.readdirSync(path.join(ROOT, 'wsl'));
const runScriptNames = uniq(matches(MAIN, /runScript\(['"]([^'"]+)['"]/g));
none('runScript() names a wsl file that does not exist', runScriptNames.filter((n) => !wslFiles.includes(n)));
// reverse: is every shipped wsl script referenced somewhere? A reference can live in main.js, a runner
// (deps.js/wsl.js/posix.js/win.js call preflight.sh/provision.sh/install-claude.sh), _shared.js, or a SIBLING
// wsl script (a `.sh` invoking `node .../x-tool.js`, or `. _frag.sh`). The reference must be OUTSIDE the file
// itself (a script never writes its own filename), so we check each file's name against the corpus of all the
// OTHERS.
const runnersDir = fs.readdirSync(path.join(ROOT, 'runners')).filter((f) => f.endsWith('.js'));
const external = MAIN + runnersDir.map((f) => read('runners/' + f)).join('\n');
const wslDead = wslFiles.filter((f) => {
  if (f.startsWith('_')) return false;                        // sourced fragments (_git-safe.sh) — referenced by `. _git-safe.sh`, checked via the sibling corpus below
  const siblings = wslFiles.filter((o) => o !== f).map((o) => read('wsl/' + o)).join('\n');
  return !external.includes(f) && !siblings.includes(f);
});
none('wsl script referenced by nothing (dead file)', wslDead);

// ---------------------------------------------------------------------------------------------------------
// 5. Error-code contract: a SHORT error code (looks like a code, not a sentence) returned by main.js must have
//    a humanError() mapping in the renderer, else a raw code like 'sync-exec' shows in a toast. Full-sentence
//    errors are passed through by humanError untouched, so only code-shaped strings are checked.
// ---------------------------------------------------------------------------------------------------------
const humanErrorBlock = (APP.match(/function humanError[\s\S]*?\n}/) || [''])[0];
// humanError's map uses BOTH quoted keys ('bad handle':) and bare identifier keys (exec:, busy:, live:).
const mappedCodes = new Set([
  ...matches(humanErrorBlock, /['"]([a-z][a-z0-9 -]*?)['"]\s*:/g),
  ...matches(humanErrorBlock, /(?:^|[{,]|\s)([a-z][a-z0-9]*)\s*:/gm),
]);
// A code-shaped error returned by main.js must be HANDLED in the renderer — either mapped by humanError (so a
// toast reads plain English) OR special-cased by name at its call site (`if (r.error === 'cancelled')`), which
// shows up as the literal appearing anywhere in app.js. A code the renderer never names AND humanError doesn't
// map would show raw ('sync-exec') — the bug this catches.
// Allowlist: codes that are structurally never shown to a user. `append` = history:append's error; the renderer
// calls historyAppend fire-and-forget (`try { … } catch {}`, result discarded), so it can never reach a toast.
const CODE_NEVER_SHOWN = new Set(['append']);
const isCodeShaped = (s) => /^[a-z][a-z0-9-]*$/.test(s) && s.length <= 22;
const returnedCodes = uniq(matches(MAIN, /error:\s*['"]([^'"]+)['"]/g)).filter(isCodeShaped);
const codeNamedInRenderer = (c) => APP.includes(`'${c}'`) || APP.includes(`"${c}"`);
none('main.js returns a code-shaped error that is neither humanError-mapped nor handled by name in the renderer',
  returnedCodes.filter((c) => !mappedCodes.has(c) && !codeNamedInRenderer(c) && !CODE_NEVER_SHOWN.has(c)));

// ---------------------------------------------------------------------------------------------------------
// 6. CSS ↔ JS class contract. Only STATICALLY-literal class tokens are checked (classList.add/remove/toggle('x')
//    and className='x'); dynamically-composed names ('tb-'+cat, 'c-'+conn) can't be verified statically and are
//    out of scope. A literal class the JS toggles that has NO CSS rule is usually a typo or a removed style.
//    Compound selectors (.livebar.elsewhere) and descendant rules are handled by matching the token anywhere a
//    `.token` appears in the <style> block.
// ---------------------------------------------------------------------------------------------------------
const styleBlock = (HTML.match(/<style>[\s\S]*?<\/style>/) || [''])[0];
const cssClassPresent = (name) => new RegExp('\\.' + name.replace(/[-]/g, '\\-') + '(?![\\w-])').test(styleBlock);
const literalClasses = uniq([
  ...matches(APP, /classList\.(?:add|remove|toggle)\(['"]([a-zA-Z][a-zA-Z0-9_-]*)['"]/g),
  ...matches(APP, /className\s*=\s*['"]([a-zA-Z][a-zA-Z0-9_-]*)['"]/g),
]);
// A short curated allowlist of class tokens that are real but live in CSS the naive scan misses: xterm's own
// injected classes, and state classes only ever used in compound/descendant rules the token-scan still catches.
const CSS_OK = new Set(['xterm']);
none('renderer: a literal class toggled in JS with no CSS rule',
  literalClasses.filter((c) => !cssClassPresent(c) && !CSS_OK.has(c)));

// ---------------------------------------------------------------------------------------------------------
// 7. node ↔ node-path.sh contract. Every script is launched as `bash -lc '…'`, and a NON-INTERACTIVE login
//    shell never runs the nvm init in ~/.bashrc (it returns early). So `node` is simply absent on a machine
//    that installed node through nvm — the common case. wsl/node-path.sh exists to fix exactly that, and every
//    `node … || <fallback>` in this codebase swallows the failure into an empty result.
//
//    This shipped: session.sh silently staged its BASH fallback hooks on a machine with node installed;
//    transcript.sh returned [] so "Export conversation" wrote an empty file; preflight.sh reported
//    `node: missing` AND `claude: not signed in`, so the wizard offered to install a node that was there.
//    Nothing failed. Everything just quietly returned the empty answer.
//
//    Comment-blind matching is what let two earlier grep guards pass on prose, so strip comments first and
//    only match `node` in a real command position.
// ---------------------------------------------------------------------------------------------------------
const wslDir = path.join(ROOT, 'wsl');
// provision.sh is the node INSTALLER: priming PATH with an old nvm node would make its post-install
// version re-check read the wrong binary and report "still older than 22.12" after a successful upgrade.
const NODE_PATH_EXEMPT = new Set(['node-path.sh', 'provision.sh']);
const stripComments = (src) => src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const INVOKES_NODE = /(?:^|[;&|(]|\|\||&&|\$\()\s*node\s|command -v node\b|\bhave node\b|\bver node\b/m;
const missingNodePath = fs.readdirSync(wslDir).filter((f) => f.endsWith('.sh')).filter((f) => {
  if (NODE_PATH_EXEMPT.has(f)) return false;
  const src = stripComments(fs.readFileSync(path.join(wslDir, f), 'utf8'));
  return INVOKES_NODE.test(src) && !/\.\s+["']?\$(?:HERE|\(dirname[^)]*\))["']?\/node-path\.sh/.test(src);
});
none('a wsl script invokes `node` without sourcing node-path.sh', missingNodePath);
// …and the guard is only worth anything if it actually sees the scripts that DO invoke node.
const nodeUsers = fs.readdirSync(wslDir).filter((f) => f.endsWith('.sh') && !NODE_PATH_EXEMPT.has(f))
  .filter((f) => INVOKES_NODE.test(stripComments(fs.readFileSync(path.join(wslDir, f), 'utf8'))));
none('the node-path guard is vacuous — it matched fewer than 8 node-invoking scripts',
  nodeUsers.length >= 8 ? [] : [`only ${nodeUsers.length} matched: ${nodeUsers.join(' ')}`]);

// ---------------------------------------------------------------------------------------------------------
// 8. "The active tab always has a sidebar row." A tab can adopt a promptless session by a non-'new' path (an
//    explicitly-opened session goes unresumable and the pty falls back to a fresh id) — bornNew is false, the
//    session has 0 messages, so it lands in neither the saved list nor the draft bucket and the ACTIVE tab
//    disappears from the sidebar. `orphanTab` restores it, but only if it is wired into all THREE places:
//    the empty-list early return, the structural signature (else the smooth path returns before rendering),
//    and the render itself. Each is a silent, separate way to reintroduce the bug.
// ---------------------------------------------------------------------------------------------------------
none('renderer: orphanTab is not detected in refreshSessions',
  /const orphanTab = \(\(\) => \{/.test(APP) ? [] : ['no orphanTab detection']);
none('renderer: the empty-session early-return ignores orphanTab (would swallow the only row)',
  /!liveTabs\.length && !joinedLive\.length && !orphanTab/.test(APP) ? [] : ['early return not guarded by orphanTab']);
none('renderer: orphanTab is absent from the session signature (smooth path would skip its row)',
  /\bot:\s*orphanTab\s*\?/.test(APP) ? [] : ['orphanTab missing from sig']);
none('renderer: orphanTab is never rendered',
  /if \(orphanTab && !shown\.has\(orphanTab\.session\)\)[\s\S]{0,120}?renderLiveTabRow\(orphanTab\)/.test(APP) ? [] : ['orphanTab row never appended']);

// ---------------------------------------------------------------------------------------------------------
// 9. The Linux pty fallback must be PROVISIONED wherever a Linux artifact is produced. node-pty ships prebuilds
//    for win32 + darwin but NOT linux, so all three runners fall back to `node-pty-prebuilt-multiarch` at
//    runtime. It is deliberately not a dependency (it would add ~8 MB / 58 packages to the win+mac installers),
//    which means the ONLY thing keeping it present is an explicit install step. If that step is ever dropped,
//    a Linux build ships with no fallback and a failed node-pty source build kills the terminal — silently.
//    So: every runner that names the module must have it provisioned by `dist:linux`, and by CI's Linux jobs.
// ---------------------------------------------------------------------------------------------------------
{
  const PKG = JSON.parse(read('package.json'));
  const FALLBACK = 'node-pty-prebuilt-multiarch';
  const runnersNamingIt = ['runners/wsl.js', 'runners/posix.js', 'runners/win.js'].filter((f) => read(f).includes(FALLBACK));
  none('the pty-fallback guard is vacuous — no runner references the module',
    runnersNamingIt.length === 3 ? [] : [`only ${runnersNamingIt.length}/3 runners name ${FALLBACK}`]);
  none('package.json dist:linux does not provision the linux pty fallback',
    (PKG.scripts['dist:linux'] || '').includes(FALLBACK) ? [] : ['dist:linux is missing the install step']);
  const ciFiles = ['.github/workflows/build.yml', '.github/workflows/test.yml'];
  none('a CI workflow that builds/packs on linux does not provision the pty fallback',
    ciFiles.filter((f) => !read(f).includes(FALLBACK)));
}

// ---------------------------------------------------------------------------------------------------------
// 10. Live-teardown singleton. Hosting ends in exactly two ways — the Stop button (share:stop) and app quit
//     (window-all-closed) — and both MUST run the same teardown, stopLiveSharing(), because the two used to be
//     separate implementations and drifted: the quit path never cleared presence, so quitting while hosting left
//     live/<login>.json on the branch and peers saw "live · Join" for ~5 minutes after the app was gone. The
//     invariant that keeps that fixed: share.stop() is called from ONE place (inside stopLiveSharing), and the
//     quit handler calls the helper — never the pieces. (share/server.js's own stop() definition is not main.js;
//     the tunnel-death recovery at ~line 863 deliberately clears presence WITHOUT tearing down — that's allowed.)
// ---------------------------------------------------------------------------------------------------------
{
  const mainNoComments = MAIN.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const stopCalls = (mainNoComments.match(/\bshare\.stop\(\)/g) || []).length;
  none('main.js calls share.stop() outside stopLiveSharing (a teardown path that can drift again)',
    stopCalls === 1 ? [] : [`share.stop() appears ${stopCalls}× — must be exactly once, inside stopLiveSharing`]);
  const quitBlock = (MAIN.match(/app\.on\('window-all-closed'[\s\S]*?\n\}\);/) || [''])[0];
  none('the quit handler does not run the full live teardown (presence would outlive the app again)',
    /stopLiveSharing\(\)/.test(quitBlock) ? [] : ['window-all-closed does not call stopLiveSharing()']);
  none('the quit handler calls stopAdvertiseHeartbeat directly (nulls advertisedWs before any clear could use it)',
    /stopAdvertiseHeartbeat\(\)/.test(quitBlock) ? ['window-all-closed calls stopAdvertiseHeartbeat() around the helper'] : []);
}

// ---------------------------------------------------------------------------------------------------------
// 11. One session ordering. Three surfaces list a workspace's sessions — refreshSessions (authoritative),
//     primeSessionListForWs (switch-time pre-fill), renderWsNonActiveSessions (the expanded tree) — and they
//     MUST all order through orderedSessionsFor(). They used to order independently and drifted (the tree kept
//     used/mtime after a0c3c59 moved the other two to the saved order), so clicking into a project whose tree
//     was on screen visibly reordered the same rows in the same tick. Comment-blind matching bit us before, so
//     comments are stripped before matching; the body extraction is brace-naive but each function ends before
//     the next `function ` declaration, which is all the precision this needs.
// ---------------------------------------------------------------------------------------------------------
{
  const appNoComments = APP.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const bodyOf = (name) => (appNoComments.match(new RegExp('function ' + name + '\\([\\s\\S]*?(?=\\nfunction |\\nconst |\\nlet )')) || [''])[0];
  const surfaces = ['refreshSessions', 'primeSessionListForWs', 'renderWsNonActiveSessions'];
  none('a session-list surface does not use orderedSessionsFor (orders can drift again)',
    surfaces.filter((f) => !/orderedSessionsFor\(/.test(bodyOf(f))));
  none('a render surface grew its own used/mtime sort back',
    /\.sort\(\(a, b\) => \(\(b\.used \|\| b\.mtime/.test(appNoComments) ? ['a used||mtime session sort exists outside orderedSessionsFor'] : []);
  none('the tree fetch callback lost its activeness guard (a late fill() would gut the active list)',
    /if \(w\.id === activeWsId\) return;/.test(bodyOf('renderWsNonActiveSessions')) ? [] : ['renderWsNonActiveSessions.fill lacks `if (w.id === activeWsId) return;`']);
}

// ---------------------------------------------------------------------------------------------------------
// 12. livePeers is workspace-scoped. It is module-global, is NOT cleared on a workspace switch, and only ever
//     holds peers for the project the last poll ran in. Reading it unscoped painted a repo project's live peer
//     as a "Live session" row inside a LOCAL project's sidebar. Every read must go through peersForWs(wsId);
//     the poll must stamp each peer and must re-check the workspace after its await; and openLiveTab must take
//     the tab's peerWsId from the PEER, never from ambient activeWsId (that made the mis-pin permanent).
// ---------------------------------------------------------------------------------------------------------
{
  const appNoComments = APP.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  // peersForWs's own body is the ONE sanctioned reader — everything else must go through it.
  const bareReads = appNoComments.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /\blivePeers\.(find|some|forEach|map|filter|reduce)\(/.test(l) && !/function peersForWs\(/.test(l))
    .map(([n]) => 'app.js:' + n);
  none('livePeers is read without peersForWs() (a project’s peers can leak into another project’s sidebar)', bareReads);
  none('peersForWs() does not exist', /function peersForWs\(/.test(appNoComments) ? [] : ['helper missing']);
  const poll = (appNoComments.match(/async function pollLivePeers\(\)[\s\S]*?\n\}/) || [''])[0];
  none('pollLivePeers does not pin its workspace before the await', /const myWs = activeWsId;/.test(poll) ? [] : ['missing `const myWs = activeWsId;`']);
  none('pollLivePeers does not pass its workspace to the IPC (main would poll its own ambient one)',
    /claudible\.livePeers\(myWs\)/.test(poll) ? [] : ['livePeers() called without myWs']);
  none('pollLivePeers does not re-check the workspace after the await (stale peers get published)',
    /if \(myWs !== activeWsId\) return;/.test(poll) ? [] : ['missing post-await staleness guard']);
  none('pollLivePeers does not stamp peers with their workspace', /p\.wsId = myWs/.test(poll) ? [] : ['peers never stamped with wsId']);
  none('live:peers IPC ignores the workspace argument (ambient activeWorkspace again)',
    /ipcMain\.handle\('live:peers', \(e, wsId\)[\s\S]{0,240}?_wsById\(wsId\)/.test(MAIN) ? [] : ['main.js live:peers does not honor wsId']);
  none('openLiveTab stamps peerWsId from ambient activeWsId instead of the peer',
    /rec\.peerWsId = peer\.wsId \|\| activeWsId;/.test(appNoComments) ? [] : ['peerWsId not taken from peer.wsId']);
}

// ---------------------------------------------------------------------------------------------------------
// 13. Live-marker parity.
//
//   (a) BOTH row renderers must mark a session *I* am hosting. renderSessionRow (the active list) always did;
//       renderWsSessionRow (the non-active expanded tree) never did — so the host's own Live marker vanished the
//       instant they clicked into another project, and read as "the session ended". It must key off
//       isSharingSession (sharedSessionId, which SURVIVES a workspace switch), never off livePeers — pollLivePeers
//       WIPES that list whenever the active workspace is not a repo, i.e. it is empty in exactly the case this
//       arm exists for.
//   (b) The self-hosted arm must NOT use makeLiveBadge: that is a <button> wired to openLiveTab, so it would
//       offer a "Join →" on your own session.
//   (c) openSessionInNewTab must attempt reclaimTabSlot() at the cap. Every session-opening path funnels through
//       it, and two of them (a guest on an immutable live mirror; a click in another project's tree) had NO
//       recovery at all — a hard "Tab limit reached (8)" with nothing the user could do from there.
//   (d) reclaimTabSlot must keep all four safety exclusions. Dropping any one turns a convenience into data loss:
//       evicting a busy tab kills a running Claude; evicting sharedTabIdR disconnects every guest; evicting a live
//       mirror silently leaves someone's session; evicting activeTabId yanks the screen out from under the user.
// ---------------------------------------------------------------------------------------------------------
{
  const appNoComments = APP.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const bodyOf = (name) => (appNoComments.match(new RegExp('function ' + name + '\\([\\s\\S]*?(?=\\nfunction |\\nconst |\\nlet )')) || [''])[0];

  const treeRow = bodyOf('renderWsSessionRow');
  none('the non-active tree row does not mark a session I am hosting (host loses their own Live marker on switch)',
    /isSharingSession\(s\.id\)/.test(treeRow) ? [] : ['renderWsSessionRow lacks an isSharingSession branch']);
  none('the tree row offers a Join button on the host’s OWN session (makeLiveBadge in the self-hosted arm)',
    /isSharingSession\(s\.id\)\)\s*\{[^}]*makeLiveBadge/.test(treeRow) ? ['self-hosted arm uses makeLiveBadge'] : []);
  none('the self-hosted marker is driven off livePeers (wiped on a non-repo ws — empty exactly when needed)',
    /isSharingSession\(s\.id\)\)\s*\{[^}]*peersForWs/.test(treeRow) ? ['self-hosted arm reads peersForWs'] : []);

}

console.log(`\ncontract: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
