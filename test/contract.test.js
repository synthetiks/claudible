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
  // quitting:true is load-bearing (R7): it makes the presence-clear a DETACHED one-shot that survives app exit —
  // without it a non-detached child could die with the app before its push landed (the 2-min-ghost, quit edition).
  none('the quit handler does not run the full live teardown (presence would outlive the app again)',
    /stopLiveSharing\(\{ quitting: true \}\)/.test(quitBlock) ? [] : ['window-all-closed does not call stopLiveSharing({ quitting: true })']);
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
// 12. Live peers are workspace-scoped. They live in a per-workspace cache (livePeersByWs: wsId -> peers[]) so a
//     repo project's live collaborator can never paint as a "Live session" row inside another project's sidebar,
//     AND presence is held for the active project PLUS every expanded one (polling only the active project froze a
//     non-active project's badge until it was clicked). peersForWs(wsId) is the ONE scoped reader (bucket + the
//     per-peer wsId stamp); pollLivePeers is the ONE writer; it must fetch each target with its own wsId, stamp
//     each peer with the ws it was fetched for, and include expanded projects; openLiveTab must take peerWsId from
//     the PEER, never ambient activeWsId (that made the mis-pin permanent).
// ---------------------------------------------------------------------------------------------------------
{
  const appNoComments = APP.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  none('peersForWs() does not exist', /function peersForWs\(/.test(appNoComments) ? [] : ['helper missing']);
  none('peersForWs() no longer filters by the per-peer wsId stamp (the scoping guarantee at the reader)',
    /function peersForWs\(wsId\)[^\n]*p\.wsId === wsId/.test(appNoComments) ? [] : ['peersForWs does not filter by p.wsId === wsId']);
  const poll = (appNoComments.match(/async function pollLivePeers\(\)[\s\S]*?\n\}/) || [''])[0];
  // Only the declaration, peersForWs (reader) and pollLivePeers (writer + keep-last-known fallback) may name the
  // cache. A render path touching livePeersByWs directly is the unscoped-read bug.
  const cacheHits = appNoComments.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /\blivePeersByWs\b/.test(l) && l.trim()
      && !/function peersForWs\(/.test(l)
      && !/let livePeersByWs =/.test(l)
      && !poll.includes(l.trim()))
    .map(([n]) => 'app.js:' + n);
  none('livePeersByWs is touched outside peersForWs()/pollLivePeers() (a project’s peers can leak into another)', cacheHits);
  none('pollLivePeers does not stamp peers with the ws they were FETCHED for',
    /p\.wsId = wsId/.test(poll) ? [] : ['peers never stamped with their fetched wsId']);
  none('pollLivePeers does not fetch per-workspace (main would poll its own ambient one)',
    /claudible\.livePeers\(wsId\)/.test(poll) ? [] : ['livePeers() not called with each target wsId']);
  none('pollLivePeers no longer polls EXPANDED projects (a non-active project’s badge would freeze until clicked)',
    /isWsExpanded\(/.test(poll) ? [] : ['poll does not include expanded workspaces']);
  none('live:peers IPC ignores the workspace argument (ambient activeWorkspace again)',
    /ipcMain\.handle\('live:peers', \(e, wsId\)[\s\S]{0,240}?_wsById\(wsId\)/.test(MAIN) ? [] : ['main.js live:peers does not honor wsId']);
  none('openLiveTab stamps peerWsId from ambient activeWsId instead of the peer',
    /rec\.peerWsId = peer\.wsId \|\| activeWsId;/.test(appNoComments) ? [] : ['peerWsId not taken from peer.wsId']);
  // Fix 3: a joined tab's socket-proved-offline suppression must be consulted by the reader and self-cleaned by the poll.
  none('peersForWs() does not suppress socket-proved-dead sessions (Fix 3 badge would lag the git poll)',
    /function peersForWs\(wsId\)[^\n]*!deadPeerSessions\.has\(p\.session\)/.test(appNoComments) ? [] : ['peersForWs ignores deadPeerSessions']);
  none('pollLivePeers never self-cleans deadPeerSessions (the suppression set would grow forever)',
    /deadPeerSessions\.delete\(/.test(poll) ? [] : ['poll does not prune deadPeerSessions']);
  none('setLiveState does not feed deadPeerSessions on offline (the instant signal is dropped)',
    /rec\.liveState === 'offline'\) deadPeerSessions\.set/.test(appNoComments) ? [] : ['setLiveState does not add to deadPeerSessions on offline']);
}

// ---------------------------------------------------------------------------------------------------------
// 13. Live-marker parity + the tab cap is never a dead end.
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

  none('openSessionInNewTab refuses at the cap without trying to reclaim (a guest on a live mirror is hard-stuck)',
    /reclaimTabSlot\(\)/.test(bodyOf('openSessionInNewTab')) ? [] : ['no reclaimTabSlot() attempt before returning false']);

  const reclaim = bodyOf('reclaimTabSlot');
  none('reclaimTabSlot() does not exist', reclaim ? [] : ['helper missing']);
  const mustExclude = [
    ['the tab on screen', /rec\.tabId === activeTabId/],
    ['a mid-turn (busy) tab — would kill a running Claude', /rec\.busy/],
    ['the live-shared tab — would disconnect every guest', /rec\.tabId === sharedTabIdR/],
    ['a joined live mirror — would silently leave someone’s session', /rec\.kind === 'live'/],
  ];
  none('reclaimTabSlot lost a safety exclusion (evicting one of these is data loss, not convenience)',
    mustExclude.filter(([, re]) => !re.test(reclaim)).map(([why]) => why));
  none('reclaimTabSlot evicts by something other than least-recently-viewed',
    /lastActive/.test(reclaim) ? [] : ['no lastActive ordering']);
  none('setActiveTab does not stamp lastActive (reclaim would evict by an undefined ordering)',
    /rec\.lastActive = Date\.now\(\);/.test(bodyOf('setActiveTab')) ? [] : ['setActiveTab does not stamp lastActive']);

  // (e) newBlankTab is the OTHER door to the cap — "+ New Session", and every workspace switch whose current tab
  //     cannot be reused (mid-turn / live-shared / kept by main). Those are exactly the cases where "just recycle
  //     this tab" is unavailable, i.e. the same wall by a different door. It must reclaim too, and it must report
  //     failure rather than toast, so each caller keeps its own specific message instead of double-toasting.
  none('newBlankTab hard-refuses at the cap without trying to reclaim (New Session / project switch dead-end)',
    /reclaimTabSlot\(\)/.test(bodyOf('newBlankTab')) ? [] : ['newBlankTab never attempts reclaimTabSlot()']);
  none('a caller still pre-guards newBlankTab with the raw cap (its reclaim can then never run)',
    /if \(tabs\.size < MAX_TABS\)\s*\{?\s*(setWsExpanded\([^)]*\);\s*)?newBlankTab\(/.test(appNoComments)
      ? ['a `if (tabs.size < MAX_TABS) newBlankTab(...)` pre-guard survives'] : []);
}

// ---------------------------------------------------------------------------------------------------------
// 14. State flairs may never outlive their state. THE bug that came back ten times.
//
//   The left rails are CORRECT css (red = mid-turn, green = live, amber = draft). Nine previous fixes deleted
//   RAILS; the rails were never the bug — the STATE behind them was orphaned, and a dead rail on an unselected
//   row reads exactly like the old "selected" look, so it kept getting reported as a styling regression.
//
//   Two orphaning mechanisms, both closed here:
//   (a) BUSY / DONE were PUSHED onto one row, located via the tab's CURRENT session id. The class is stranded
//       forever whenever that (tab → row) link breaks: the tab is closed (markTabBusy bails on tabs.get), the tab
//       is re-pointed (onStatus reassigns rec.session with no busy guard), or the row isn't painted yet. They are
//       now PULLED: syncRowFlairs() recomputes every row on screen from the tabs Map, so nothing can orphan.
//   (b) LIVE state (sess-live-row + its Live/Join badge) lives on rows in NON-ACTIVE project trees, which
//       reconcileWsChips deliberately never repaints — while every share-end path called only refreshSessions(),
//       which touches the ACTIVE LIST ONLY. So the green rail AND the badge survived the share forever. Every
//       live-state transition must now also refreshExpandedTrees(). A class toggle is NOT enough there: the badge
//       is a DOM child, so the tree needs a real repaint.
// ---------------------------------------------------------------------------------------------------------
{
  const appNoComments = APP.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const bodyOf = (name) => (appNoComments.match(new RegExp('function ' + name + '\\([\\s\\S]*?(?=\\nfunction |\\nconst |\\nlet )')) || [''])[0];

  none('syncRowFlairs() does not exist (busy/done rails can orphan again)',
    /function syncRowFlairs\(\)/.test(appNoComments) ? [] : ['helper missing']);
  none('refreshExpandedTrees() does not exist (a non-active tree can keep a dead live rail + badge)',
    /function refreshExpandedTrees\(\)/.test(appNoComments) ? [] : ['helper missing']);

  // The sweep must be a PULL: it has to read the predicates, and it has to reach rows OUTSIDE the active list.
  const sweep = bodyOf('syncRowFlairs');
  none('syncRowFlairs does not recompute busy from sessionBusyInTab (it would not be a pull)',
    /sessionBusyInTab\(/.test(sweep) ? [] : ['does not call sessionBusyInTab']);
  none('syncRowFlairs does not recompute the done-pulse from sessionNeedsAttention',
    /sessionNeedsAttention\(/.test(sweep) ? [] : ['does not call sessionNeedsAttention']);
  none('syncRowFlairs only looks inside the active list — a non-active tree row would keep its stale rail',
    /bodyEl\.querySelectorAll/.test(sweep) ? [] : ['sweep is scoped to sessListEl, not the whole sidebar']);

  // The push-patchers must defer to the sweep, or a closed/re-pointed tab strands its rail again.
  none('markTabBusy does not run the sweep (a closed or re-pointed busy tab strands its red rail)',
    /syncRowFlairs\(\)/.test(bodyOf('markTabBusy')) ? [] : ['markTabBusy never calls syncRowFlairs()']);
  none('markTabAttention does not run the sweep (an unpainted row strands the done-pulse)',
    /syncRowFlairs\(\)/.test(bodyOf('markTabAttention')) ? [] : ['markTabAttention never calls syncRowFlairs()']);

  // refreshSessions is ACTIVE-LIST-ONLY. Both of its exits must still reconcile the trees.
  const refresh = bodyOf('refreshSessions');
  none('refreshSessions never reconciles the non-active trees (its smooth path early-returns past them)',
    (refresh.match(/syncRowFlairs\(\)/g) || []).length >= 2
      ? [] : ['refreshSessions must call syncRowFlairs() on BOTH the smooth path and the full rebuild']);

  // EVERY live-state transition must repaint the trees — the badge is a DOM CHILD, so a class toggle cannot
  // remove it. Asserted PER SITE, not by counting and not by proximity: a count guard passes while one transition
  // quietly loses its repaint, and a proximity window leaks into the neighbouring branch and "finds" ITS repaint.
  // Both weaker forms were tried here and both let a real regression through in mutation testing.
  const liveSites = [
    ['endLiveNow (host ends / force-end / shared tab closed)', bodyOf('endLiveNow')],
    ['deleteSession (the share dies with the session)', bodyOf('deleteSession')],
    ['pollLivePeers (a peer goes offline → stale Join badge elsewhere)', bodyOf('pollLivePeers')],
    ['onAdvertiseLost (a collaborator claimed the session)',
      (appNoComments.match(/onAdvertiseLost\([\s\S]{0,700}/) || [''])[0]],
    ['the already-live rollback (a collaborator beat us to the claim)',
      (appNoComments.match(/error === 'already-live'\)[\s\S]{0,500}/) || [''])[0]],
  ];
  none('a live-state transition does not repaint the non-active trees (stale green rail + Join badge)',
    liveSites.filter(([, body]) => !/refreshExpandedTrees\(\)/.test(body)).map(([who]) => who));
  // toggleShareSession owns BOTH arms — a tree must LOSE the marker on stop and GAIN it on start.
  const tog = bodyOf('toggleShareSession');
  none('toggleShareSession does not repaint the trees on BOTH arms (start and stop)',
    (tog.match(/refreshExpandedTrees\(\)/g) || []).length >= 2
      ? [] : ['needs a refreshExpandedTrees() in the stop arm AND the start arm']);
  none('the peer poll does not repaint the trees (a peer going offline strands a Join badge elsewhere)',
    /refreshExpandedTrees\(\)/.test(bodyOf('pollLivePeers')) ? [] : ['pollLivePeers never calls refreshExpandedTrees()']);
}

// ---------------------------------------------------------------------------------------------------------
// 15. RAILS ARE EXTINCT. No session row may ever carry a coloured left bar again, in ANY state.
//
//   The rail + wash grammar IS the deprecated selected look. Ten reports of "the old selection styling came
//   back" were stale-state bugs wearing live CSS (check 14 killed the staleness) — but the ELEVENTH was a
//   genuinely-live row: its base style was still rail+wash, so it dressed as the old bug whenever it wasn't
//   selected. The vocabulary is now: soft tinted boxes; state via ● LIVE pill / draft dot+text / red title
//   (mid-turn) / green title pulse (done-while-away). This check makes a coloured rail a red build.
// ---------------------------------------------------------------------------------------------------------
{
  const styleBlk = (HTML.match(/<style>[\s\S]*?<\/style>/) || [''])[0];
  // Keyframes first (they nest braces, so strip them before the flat rule scan) — and the old done-pulse drew a
  // rail-shaped `inset 2px` shadow inside its frames, which the flat scan would never see.
  const doneKf = (styleBlk.match(/@keyframes sess-done-pulse\{[\s\S]*?\}\s*\}/) || [''])[0];
  none('the done-pulse keyframes draw a rail again (inset shadow on the left edge)',
    doneKf && !/inset/.test(doneKf) ? [] : [doneKf ? 'sess-done-pulse contains an inset shadow' : 'sess-done-pulse keyframes missing']);
  const flat = styleBlk.replace(/@keyframes[\s\S]*?\}\s*\}/g, '');
  const offenders = [];
  flat.split('}').forEach((chunk) => {
    const [sel, body] = chunk.split('{');
    if (!sel || !body || !/\.sess(?![a-z-]*list)/.test(sel) || /\.ws-children/.test(sel)) return;
    const m = body.match(/border-left(?:-color)?\s*:\s*([^;]+)/);
    if (m && !/transparent/.test(m[1])) offenders.push(sel.trim().slice(0, 60) + ' → border-left ' + m[1].trim());
  });
  none('a .sess rule paints a coloured left rail (the deprecated selected grammar)', offenders);
  // Non-vacuous + the replacement styling is really there:
  none('live rows lost the calm flat tint (the 13:05 look) that replaced the rail',
    /\.sess\.sess-live-row,\.sess\.sess-peer-live\{[^}]*background-color:color-mix\(in srgb,var\(--ok\)/.test(flat) ? [] : ['live rows have no flat --ok background']);
  // Mid-turn must still SHOW — but as the row's quiet 6px pulsing dot, not by repainting the title. The first
  // post-rail attempt recoloured the whole title red, which shouted (and put a red title beside the green ● LIVE
  // pill on a live row — two contradictory claims on one row). The dot is the vocabulary the row already had.
  none('the mid-turn state lost its railless indicator (the pulsing busy dot)',
    /\.sess\.busy:not\(\.sess-draft\) \.sess-meta::before\{[^}]*background:var\(--live\)/.test(flat) ? [] : ['no .sess.busy .sess-meta::before busy-dot rule']);
  none('…and the busy dot must actually pulse (a static dot reads as decoration, not activity)',
    /\.sess\.busy:not\(\.sess-draft\) \.sess-meta::before\{[^}]*animation:ws-sync-pulse/.test(flat) ? [] : ['the busy dot has no ws-sync-pulse animation']);
  // A DRAFT row builds its OWN .sess-draftdot span and the rule above already pulses it when .busy is set. If the
  // busy dot stops excluding draft rows, a busy draft wears TWO dots — a red one and an amber one, side by side.
  // That shipped for one commit; it must not ship twice.
  none('the busy dot no longer excludes draft rows (a busy draft would wear two dots)',
    /\.sess\.busy(?!:not\(\.sess-draft\))[^{,]*\.sess-meta::before/.test(flat) ? ['.sess.busy .sess-meta::before is not :not(.sess-draft)-guarded'] : []);
  none('…and draft rows must still pulse their OWN dot while busy (the indicator they already had)',
    /\.sess\.busy \.sess-draftdot\{[^}]*animation:ws-sync-pulse/.test(flat.replace(/\.sess\.busy \.sess-livedot,/, '.sess.busy ')) ? [] : ['.sess.busy .sess-draftdot lost its pulse']);
  // The title is NOT a busy channel. Red-on-title is the regression this replaced; it must not come back.
  none('mid-turn repaints the session TITLE again (the loud look CrazyDev rejected)',
    /\.sess\.busy[^{]*\.sess-prev\{[^}]*color:var\(--live\)/.test(flat) ? ['.sess.busy .sess-prev sets a red title'] : []);
  // Cascade order is load-bearing: equal specificity means LAST wins, and "it started working again" must win —
  // a row that resumed work may not still wear done's green title.
  const gi = flat.indexOf('.sess.sess-done .sess-prev'), bi = flat.indexOf('.sess.sess-done.busy .sess-prev');
  none('a resumed row still wears done’s green title (cascade order regressed)',
    gi >= 0 && bi > gi ? [] : ['.sess.sess-done.busy .sess-prev must come AFTER .sess.sess-done .sess-prev']);
}

// ---------------------------------------------------------------------------------------------------------
// 16. TURN-BUSY HAS EXACTLY ONE WRITER (main.js). The renderer kept its own copy, armed by the UserPromptSubmit
//   hook and disarmed ONLY by Stop — so a turn ended by esc, a dead pty or a crashed Claude left the sidebar row
//   "working" forever, and every rebuild faithfully repainted that lie. main.js's setGenBusy already had every
//   clear the renderer lacked (pty exit, session switch, tab close, quiet-pty self-heal) because delete/switch/
//   auto-sync gating depends on it. The renderer must MIRROR it and never derive it.
// ---------------------------------------------------------------------------------------------------------
{
  none('main.js: setGenBusy does not tell the renderer (the sidebar would keep guessing)',
    /function setGenBusy[\s\S]{0,240}?winSend\('tab:busy'/.test(MAIN) ? [] : ['setGenBusy sends no tab:busy']);
  none('main.js: the quiet-pty self-heal clears busy without telling the renderer (flair outlives the flag)',
    /rec\.busy = false;[^\n]*winSend\('tab:busy',\s*\{\s*tabId,\s*busy:\s*false\s*\}\)/.test(MAIN) ? [] : ['the heal path sends no tab:busy']);
  none('preload.js: the tab:busy channel is not exposed',
    /onTabBusy:\s*\(cb\)\s*=>\s*ipcRenderer\.on\('tab:busy'/.test(PRELOAD) ? [] : ['no onTabBusy bridge']);
  none('renderer: does not subscribe to tab:busy (it would have nothing to mirror)',
    /claudible\.onTabBusy\(/.test(APP) ? [] : ['renderer never calls onTabBusy']);
  // THE invariant: main is the only writer. A `t.busy = …` / `rec.busy = …` anywhere in the renderer OUTSIDE the
  // onTabBusy handler is the bug coming back — a second, weaker copy that only a Stop hook can ever clear.
  // Strip `//` comments FIRST. Comment-blind matching is what let two earlier grep guards pass on prose — and the
  // comments around this very fix say the words "t.busy" out loud. `[^:]` keeps `https://` intact.
  const codeOnly = (l) => l.replace(/(^|[^:])\/\/.*$/, '$1');
  const busyWrites = [];
  APP.split('\n').forEach((l, i) => {
    const code = codeOnly(l);
    if (!/\b(t|rec|tab)\.busy\s*=(?!=)/.test(code)) return;
    busyWrites.push(`renderer/app.js:${i + 1}: ${code.trim().slice(0, 62)}`);
  });
  // Exactly one write is allowed: `t.busy = busy;` inside the onTabBusy mirror.
  none('the renderer writes turn-busy itself instead of mirroring main (the 10-round flair bug)',
    busyWrites.length === 1 && /\bt\.busy = busy;/.test(busyWrites[0]) ? [] : busyWrites.length ? busyWrites : ['no t.busy = busy mirror found at all']);
}

// ---------------------------------------------------------------------------------------------------------
// 17. THIRD-PARTY ATTRIBUTION. asar:false + no node_modules exclusion means the MIT deps (ws, node-pty, xterm,
//   addon-fit) are PHYSICALLY bundled in the installer, so their license text must be redistributed. The
//   attribution file must exist, name every bundled dep, and actually SHIP — build.files excludes `**/*.md`, so
//   it must be re-included AFTER that exclusion or it silently never reaches the installer.
// ---------------------------------------------------------------------------------------------------------
{
  const pkg = JSON.parse(read('package.json'));
  let tpl = '';
  try { tpl = read('THIRD-PARTY-LICENSES.md'); } catch {}
  none('THIRD-PARTY-LICENSES.md is missing (the bundled MIT deps are unattributed)', tpl ? [] : ['file absent']);
  const bundled = ['ws', 'node-pty', '@xterm/xterm', '@xterm/addon-fit'];
  none('the attribution file does not name every bundled dependency',
    bundled.filter((d) => !tpl.includes(d)));
  const files = (pkg.build && pkg.build.files) || [];
  none('THIRD-PARTY-LICENSES.md is not in build.files (it would be excluded by `!**/*.md` and never ship)',
    files.includes('THIRD-PARTY-LICENSES.md') ? [] : ['not listed in build.files']);
  // Order matters: the re-include must come AFTER `!**/*.md`, else the exclusion wins and it never ships.
  const mdExcl = files.indexOf('!**/*.md'), tplInc = files.indexOf('THIRD-PARTY-LICENSES.md');
  none('the attribution file is re-included BEFORE the `!**/*.md` exclusion (exclusion would win → never ships)',
    mdExcl >= 0 && tplInc > mdExcl ? [] : ['THIRD-PARTY-LICENSES.md must be listed after !**/*.md in build.files']);
}

// ---------------------------------------------------------------------------------------------------------
// 18. GUEST CAP IS ENFORCED AT ADMISSION, not only at connect. With approval on (the default), a joiner waits
//   in `pending` (bounded by MAX_PENDING=16, not MAX_GUESTS=8) between the connect-time check and admit(), so
//   the cap MUST be re-checked inside admit() for a fresh `link` join or a backlog of approvals seats > 8.
//   The cap counts grace-window seats (pendingDrops) as OCCUPIED — drop() releases clients.size immediately,
//   so a bare clients.size check lets a link joiner fill a seat whose owner's in-window resume (no cap check
//   by design) then overflows the cap. An orphaned-token resume (no reservation, no ghost) is capped too.
// ---------------------------------------------------------------------------------------------------------
{
  const server = read('share/server.js');
  const admitBody = (server.match(/function admit\(ws, mode, name, resumeTok\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
  none('share/server.js: admit() does not re-check MAX_GUESTS for a fresh link join (cap enforced only at connect)',
    /mode === 'link' && clients\.size \+ pendingDrops\.size >= MAX_GUESTS/.test(admitBody) ? [] : ['admit() lacks the link-mode MAX_GUESTS re-check (with grace-window seats counted)']);
  none('share/server.js: an orphaned-token resume (no grace record, no superseded ghost) bypasses MAX_GUESTS',
    /mode === 'resume' && !back && !ghost && clients\.size \+ pendingDrops\.size >= MAX_GUESTS/.test(admitBody) ? [] : ['admit() lacks the orphaned-resume MAX_GUESTS check']);
}

// ---------------------------------------------------------------------------------------------------------
// 13. One kind of project at creation time — and the repo plumbing must OUTLIVE its removal from the modal.
//     The New-project modal deliberately no longer offers "Shared repo project": every project starts plain and
//     becomes synced later via the consented ▾-menu flows. Two failure modes, both pinned:
//     (a) the tile creeping back (someone "restores" the choice and re-forks the UX);
//     (b) someone garbage-collecting the now-UI-unreachable repo-creation path — which invites, discovery and
//         upgrade still depend on. Deleting it would break accepting an invite, the exact kind of "cleanup"
//         a dead-code sweep would suggest.
// ---------------------------------------------------------------------------------------------------------
{
  none('the New-project modal grew a repo tile back', /ch-repo|Shared repo project/.test(HTML) ? ['index.html contains the repo tile again'] : []);
  none('the modal path can reach workspaceCreate with kind repo again',
    /const WS_KINDS = \['local', 'adopt'\]/.test(APP) && !/creating private repo on GitHub/.test(APP) ? [] : ['WS_KINDS regrew repo (or its busy text returned)']);
  // ^\s*repo\)\s*$ = the actual case label. A bare /repo\)/ was satisfied by the header comment
  // "kind (local|repo)," — the comment-blindness trap that has now bitten this repo's guards three times.
  none('the repo-creation plumbing was garbage-collected (invites/discovery/upgrade still need it)',
    /^\s*repo\)\s*$/m.test(read('wsl/create-workspace.sh')) && /workspace:create/.test(MAIN) && /upgrade-workspace\.sh/.test(MAIN) ? [] : ['create-workspace.sh repo branch / workspace:create / upgrade path missing']);
  // The deferred flows the modal now leans on must all still exist in the renderer.
  const deferred = ['upgradeWorkspace(', 'inviteToLocal(', 'openSyncModal('].filter((f) => !APP.includes(f));
  none('a deferred sync/share flow the modal copy promises is gone', deferred);
}

console.log(`\ncontract: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
