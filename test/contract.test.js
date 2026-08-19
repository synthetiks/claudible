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
const SETUPWIN = read('setup/setup-win.ps1');
const SETUPSH = read('setup/setup.sh');
const deps = require('../runners/deps.js');

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
  const teardownFn = (MAIN.match(/function teardownForExit\(\)[\s\S]*?\n\}/) || [''])[0];
  // quitting:true is load-bearing (R7): it makes the presence-clear a DETACHED one-shot that survives app exit —
  // without it a non-detached child could die with the app before its push landed (the 2-min-ghost, quit edition).
  // The teardown now lives in ONE named function so the self-update restart path (app.exit bypasses
  // window-all-closed entirely) can run the identical sequence — pin both the extraction and the wiring.
  none('the quit handler does not run the full live teardown (presence would outlive the app again)',
    /teardownForExit\(\)/.test(quitBlock) && /stopLiveSharing\(\{ quitting: true \}\)/.test(teardownFn) ? [] : ['window-all-closed must call teardownForExit(), and teardownForExit must run stopLiveSharing({ quitting: true })']);
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
  // The beacon's push handler is the SECOND sanctioned writer: it buckets by the PUSHED workspace id and
  // stamps each peer with it, preserving the same scoping guarantee as the poll (asserted below).
  const push = (appNoComments.match(/claudible\.onLivePeersPush\(\(p\) => \{[\s\S]*?\n\}\);/) || [''])[0];
  // Only the declaration, peersForWs (reader), pollLivePeers and the beacon push handler (writers) may name the
  // cache. A render path touching livePeersByWs directly is the unscoped-read bug.
  const cacheHits = appNoComments.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /\blivePeersByWs\b/.test(l) && l.trim()
      && !/function peersForWs\(/.test(l)
      && !/let livePeersByWs =/.test(l)
      && !poll.includes(l.trim())
      && !push.includes(l.trim()))
    .map(([n]) => 'app.js:' + n);
  none('livePeersByWs is touched outside peersForWs()/pollLivePeers()/the beacon push (a project’s peers can leak into another)', cacheHits);
  // Both writers stamp through the ONE shared filter now (filterLivePeers) — pin the stamp inside it and
  // pin that BOTH the poll and the push actually route through it (a hand-rolled copy would drift).
  const filterFn = (appNoComments.match(/function filterLivePeers\([\s\S]*?\n\}/) || [''])[0];
  none('the shared peer filter does not stamp peers with their fetched/pushed wsId',
    /p\.wsId = wsId/.test(filterFn) ? [] : ['filterLivePeers missing or does not stamp p.wsId']);
  none('pollLivePeers does not route through the shared peer filter',
    /filterLivePeers\(peers, wsId, now\)/.test(poll) ? [] : ['poll no longer uses filterLivePeers']);
  none('the beacon push handler does not route through the shared peer filter',
    push && /filterLivePeers\(p\.peers, wsId/.test(push) ? [] : ['push handler missing or not using filterLivePeers']);
  none('pollLivePeers does not fetch per-workspace (main would poll its own ambient one)',
    /claudible\.livePeers\(wsId\)/.test(poll) ? [] : ['livePeers() not called with each target wsId']);
  none('pollLivePeers no longer polls EXPANDED projects (a non-active project’s badge would freeze until clicked)',
    /isWsExpanded\(/.test(poll) ? [] : ['poll does not include expanded workspaces']);
  none('live:peers IPC ignores the workspace argument (ambient activeWorkspace again)',
    /ipcMain\.handle\('live:peers', \(e, wsId\)[\s\S]{0,500}?_wsById\(wsId\)/.test(MAIN) ? [] : ['main.js live:peers does not honor wsId']);
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
  // It now LEADS the row (::before on the title) rather than heading the right-hand meta cluster — a status light
  // belongs at the left edge. The anchor moved; the invariant did not. It is also --sync BLUE, not --live red:
  // mid-turn is progress, and it shares the token with the project dot that makes the same claim.
  none('the mid-turn state lost its railless indicator (the busy dot)',
    /\.sess\.busy:not\(\.sess-draft\) \.sess-prev::before\{[^}]*background:var\(--sync\)/.test(flat) ? [] : ['no .sess.busy .sess-prev::before busy-dot rule on var(--sync)']);
  // It must still MOVE — a wholly static dot is indistinguishable from decoration. But at one blink per 10s,
  // not the old 1s breathe: ws-sync-pulse is 50%-duty, so reusing it at 10s reads as slow dimming, not a flash.
  none('…and the busy dot must still animate (a static dot reads as decoration, not activity)',
    /\.sess\.busy:not\(\.sess-draft\) \.sess-prev::before\{[^}]*animation:sess-busy-blink 10s/.test(flat) ? [] : ['the busy dot has no sess-busy-blink 10s animation']);
  none('…and sess-busy-blink must hold steady and blink, not fade across the whole cycle',
    /@keyframes sess-busy-blink\{0%,100%\{opacity:1\}[\d.]+%\{opacity:\.\d+\}/.test(styleBlk) ? [] : ['sess-busy-blink is missing or is not a short-duty blink']);
  // A DRAFT row owns this SAME ::before now (its amber dot moved out of the meta line to join the left-edge
  // convention). So the exclusion matters more than it used to, for a sharper reason: without it BOTH rules
  // target one pseudo-element on a busy draft and the later declaration simply repaints the amber dot --sync
  // blue — the row loses the amber that says "not saved yet" exactly while it is working. (Before the move the
  // same guard prevented a different symptom: two dots side by side, red ::before beside the meta's amber span.
  // That shipped for one commit; it must not ship twice, in either form.)
  none('the busy dot no longer excludes draft rows (a busy draft would lose its amber)',
    /\.sess\.busy(?!:not\(\.sess-draft\))[^{,]*\.sess-prev::before/.test(flat) ? ['.sess.busy .sess-prev::before is not :not(.sess-draft)-guarded'] : []);
  none('a draft row lost its leading amber dot (the only at-rest signal a brand-new session has)',
    /\.sess\.sess-draft \.sess-prev::before\{[^}]*background:var\(--warn\)/.test(flat)
      ? [] : ['no amber ::before on .sess-draft .sess-prev']);
  none('…and draft rows must still pulse that dot while busy (the indicator they already had)',
    /\.sess\.sess-draft\.busy \.sess-prev::before\{[^}]*animation:ws-sync-pulse/.test(flat)
      ? [] : ['the draft dot lost its pulse']);
  // The dot is markup-free now, so the old span must not creep back into either render path — but scope this to
  // the FUNCTIONS and to real CSS. The prose around both deliberately names the old span and the old label to
  // explain what moved and why, and a whole-file grep matched that history and failed on it. (Third time this
  // file's own opening warning about comment-blind matching has proven itself, twice while writing new pins.)
  const draftRender = (APP.match(/function renderLiveTabRow\(rec\) \{[\s\S]*?\n\}/) || [''])[0]
    + (APP.match(/function markTabBusy\(tabId, busy\) \{[\s\S]*?\n\}/) || [''])[0];
  const cssOnly = HTML.replace(/\/\*[\s\S]*?\*\//g, '');
  none('the draft dot went back into the meta line as a span',
    [/sess-draftdot/.test(draftRender) ? 'a draft render path still builds .sess-draftdot' : '',
     /sess-draftdot/.test(cssOnly) ? 'index.html still styles .sess-draftdot' : ''].filter(Boolean));
  // Two words, one claim. "unsaved" restated "draft" in the narrowest text in the sidebar.
  none('the draft label says the same thing twice again',
    /draft · unsaved/.test(draftRender) ? ['"draft · unsaved" is back in a render path'] : []);
  none('the two draft render paths disagree (they drifted apart before)',
    (APP.match(/\? 'working…' : 'draft'/g) || []).length === 2
      ? [] : ['expected exactly 2 identical draft-label render sites (renderLiveTabRow + markTabBusy)']);
  // The title is NOT a busy channel. Red-on-title is the regression this replaced; it must not come back.
  none('mid-turn repaints the session TITLE again (the loud look CrazyDev rejected)',
    /\.sess\.busy[^{]*\.sess-prev\{[^}]*color:var\(--live\)/.test(flat) ? ['.sess.busy .sess-prev sets a red title'] : []);
  // Cascade order is load-bearing: equal specificity means LAST wins, and "it started working again" must win —
  // a row that resumed work may not still wear done's green title.
  const gi = flat.indexOf('.sess.sess-done .sess-prev'), bi = flat.indexOf('.sess.sess-done.busy .sess-prev');
  none('a resumed row still wears done’s green title (cascade order regressed)',
    gi >= 0 && bi > gi ? [] : ['.sess.sess-done.busy .sess-prev must come AFTER .sess.sess-done .sess-prev']);
  // TRANSFORM BELONGS TO THE PRESS, NOT TO LAYOUT. `button:active{transform:translateY(1px)}` is global and
  // outranks a plain class rule, so any BUTTON centered with transform:translate*(-50%) gets its centering
  // REPLACED on mousedown — it leaps to the container's edge and back. The ▾ shipped exactly that for one
  // commit ("jiggles concerningly"). Centre buttons with top/bottom + margin:auto instead.
  const BTNISH = /\.(?:[a-z-]*-btn|iconbtn|ws-add|share-btn|cmdpill|termtab|ws-info|sess-flair|panel-close)\b/;
  const jig = [];
  // Comments must be stripped FIRST: they trail into the next rule's selector chunk, and a comment that merely
  // mentions `:active` (like the one above the ▾) would silently exempt the very rule it documents.
  flat.replace(/\/\*[\s\S]*?\*\//g, '').split('}').forEach((chunk) => {
    const [sel, body] = chunk.split('{');
    if (!sel || !body || !BTNISH.test(sel) || /:active/.test(sel)) return;
    if (/transform\s*:\s*[^;]*translate[^;]*-50%/.test(body)) jig.push(sel.trim().slice(0, 60) + ' centres with transform');
  });
  none('a button uses transform for centring (button:active will clobber it → the press jiggles)', jig);
  // The ▾ is now an in-flow flex child of the row, centred by the row's align-items:center — still transform-free,
  // so button:active can't clobber its centring (the original "jiggle" fix, preserved by a different mechanism).
  none('…and the ▾ itself must stay transform-free centred (via the flex row now, not absolute + margin:auto)',
    /\.sess\{[^}]*display:flex;align-items:center/.test(flat) && /\.sess-menu-btn\{[^}]*flex:none/.test(flat) && !/\.sess-menu-btn\{[^}]*translate/.test(flat)
      ? [] : ['.sess-menu-btn is not centred by the flex row without a transform']);
  // A LIVE row does not show the hover timestamp: the pill already claims 78px of a one-line row (they collided),
  // and "last used 2h ago" contradicts a session in use right now. The reveal must stay :has(.sess-live-ind)-gated.
  const reveal = (flat.match(/[^};]*:hover \.sess-meta-t[^}]*\{[^}]*display:inline/) || [''])[0];
  none('the hover timestamp is no longer suppressed on live rows (it collides with the Live pill)',
    /:not\(:has\(\.sess-live-ind\)\)/.test(reveal) ? [] : [reveal ? 'the :hover .sess-meta-t reveal is not :has(.sess-live-ind)-gated' : 'no :hover .sess-meta-t reveal rule at all']);
  // …but a peer-live row's .sess-meta-t is the "X is live now" DESCRIPTION, not a timestamp. It is not hover-gated
  // and must never be swept up by the rules above, or a joinable row loses the only text that explains it.
  none('peer-live rows lost their always-on description text',
    /\.sess:not\(\.sess-peer-live\) \.sess-meta-t\{display:none\}/.test(flat) ? [] : ['the at-rest hide is not :not(.sess-peer-live)-scoped']);
  // THE PROJECTS HEAD IS CENTRED BY A SUM, NOT BY ITS OWN PADDING. .ws-chips' padding-top continues the gap under
  // the head — no border or background divides them, so the eye reads one space. Balance is therefore
  //     head-padding-top === head-padding-bottom + chips-padding-top
  // It shipped as 3 vs 2+8=10 and visibly sat high. These three numbers have each been tuned in isolation more
  // than once, which is exactly how it drifted; this check makes the coupling fail loudly instead of silently.
  const headPad = (flat.match(/\.ws-section-head\{padding:([\d.]+)px [\d.]+px ([\d.]+)px/) || []).slice(1).map(Number);
  const chipsPad = Number((flat.match(/\.ws-chips\{[^}]*?padding:([\d.]+)px/) || [])[1]);
  none('the projects head is no longer optically centred (head-top must equal head-bottom + chips-top)',
    headPad.length === 2 && Number.isFinite(chipsPad) && headPad[0] === headPad[1] + chipsPad
      ? [] : [headPad.length === 2 && Number.isFinite(chipsPad)
          ? `above=${headPad[0]}px but below=${headPad[1]}+${chipsPad}=${headPad[1] + chipsPad}px`
          : 'could not read .ws-section-head / .ws-chips padding']);
  // ── DESIGN SYSTEM: the tokens are the system. A raw value re-introduces the drift they replaced. ─────────
  // Type scale: 19 ad-hoc sizes became 8 tokens. A stray `font-size:13px` is how the 19 came back last time.
  // (font-size:0 is the icon-button glyph-hiding idiom, not a size — allowed.)
  const rawFs = (styleBlk.match(/font-size:(?!0[;}\s])[0-9.]+px/g) || []);
  none('a raw font-size px value escaped the type scale (use var(--fs-*))', rawFs);
  // …and the scale must actually be anchored on the sidebar's own sizes, or "the sidebar does not move" breaks.
  none('the type scale drifted off its sidebar anchors (2xs/xs/sm must stay 9 / 10.5 / 12px)',
    /--fs-2xs:9px/.test(styleBlk) && /--fs-xs:10\.5px/.test(styleBlk) && /--fs-sm:12px/.test(styleBlk)
      ? [] : ['--fs-2xs/--fs-xs/--fs-sm are no longer 9 / 10.5 / 12px']);
  // Motion: the two shared curves are tokens. A literal cubic-bezier means an element animating off-system.
  none('a raw easing curve escaped the motion system (use var(--ease-out) / var(--ease-pop))',
    (styleBlk.match(/cubic-bezier\(\.2,\.7,\.15,1\)|cubic-bezier\(\.2,\.7,\.2,1\)/g) || []).filter((_, i, a) => a.length > 2));
  // A custom property that references ITSELF is invalid at computed-value time and takes every consumer down
  // with it. The scale rewrite produced exactly this (`--ease-pop:var(--ease-pop)`) from a duplicate :root.
  const selfRef = [];
  (styleBlk.match(/--[a-z0-9-]+:\s*var\(--[a-z0-9-]+\)/g) || []).forEach((d) => {
    const [lhs, rhs] = d.split(':'); if (lhs.trim() === rhs.trim().slice(4, -1)) selfRef.push(d);
  });
  none('a design token references itself (cyclic → invalid, breaks every var() that reads it)', selfRef);

  // ── COMMAND PALETTE ─────────────────────────────────────────────────────────────────────────────────────
  // This app is a TERMINAL. Ctrl+K is readline's kill-to-end-of-line and Ctrl+P is previous-command; binding
  // either globally would silently break them inside the shell. The chord must require Shift.
  const cmdkKey = (APP.match(/if \(!mod \|\| !e\.shiftKey[\s\S]{0,220}?cmdkOpen/) || [''])[0];
  none('the command palette hotkey no longer requires Shift (it would collide with the terminal’s own Ctrl+K/Ctrl+P)',
    /!e\.shiftKey/.test(cmdkKey) && /KeyP/.test(cmdkKey) ? [] : ['the palette chord is not a Shift-guarded KeyP']);
  none('the palette does not hand the keyboard back to the terminal on close',
    /function cmdkOpen[\s\S]{0,400}?focusTermSoon/.test(APP) ? [] : ['cmdkOpen(false) never calls focusTermSoon']);

  // ── TOAST ───────────────────────────────────────────────────────────────────────────────────────────────
  // It is anchored over the terminal but must stay position:FIXED. The theme toast fires from inside the
  // Settings drawer — a fixed, filtered element with its own stacking context — so an in-flow toast would
  // render behind the very panel that triggered it.
  none('the toast left position:fixed (it would render behind the drawer that triggered it)',
    /\.toast\{position:fixed/.test(flat) ? [] : ['.toast is no longer position:fixed']);
  // The box must HUG its text. It is anchored by `left` alone; if a rule also pins `right` (or drops
  // width:max-content), the two edges stretch it to max-width and a three-word message wears a 420px box.
  const toastRule = (flat.match(/\.toast\{[^}]*\}/) || [''])[0];
  none('the toast box no longer hugs its text (width:max-content lost → it stretches to max-width)',
    /width:max-content/.test(toastRule) ? [] : ['.toast has no width:max-content']);
  none('the toast pins BOTH horizontal edges (left+right stretches the box instead of centring it)',
    /(^|;)left:/.test(toastRule) && /(^|;)right:/.test(toastRule) ? ['.toast sets both left and right'] : []);
  none('…and app.js must anchor by one edge only, letting translateX centre it',
    /placeToast[\s\S]{0,600}?style\.right\s*=/.test(APP) ? ['placeToast still sets style.right'] : []);
  // Scoped to toast()'s OWN body: `placeToast(t)` also appears in the resize listener, so a loose search for it
  // passes even when toast() has stopped calling it (it did, on first write of this check).
  none('the toast is no longer anchored to the terminal at show time',
    /function placeToast[\s\S]{0,400}?getBoundingClientRect/.test(APP) && /function toast\(msg[^)]*\)[\s\S]{0,300}?placeToast\(/.test(APP)
      ? [] : ['placeToast is missing, or toast() no longer calls it']);
  // A toast is often the ONLY place an error sentence is ever shown, and the reader is usually looking at the
  // terminal, not at the toast. 2.2s was gone before a full sentence could be read; the default is now ~7s, with
  // a per-call override for anything that needs to be shorter or longer.
  none('the toast dismisses too fast to finish reading an error sentence',
    /setTimeout\([^;]*?remove\('show'\),\s*ms \|\| 7200\)/.test(APP) && !/remove\('show'\),\s*2200\)/.test(APP)
      ? [] : ['toast() does not dismiss on `ms || 7200`']);
  // The toast floats over the terminal, so its edge must be SEEN, not merely felt — the faint seam token is for
  // regions that separate by background step, and on a floating box it read as no border at all.
  none('the toast border went back to the felt-not-seen seam (it floats — its edge must be visible)',
    /var\(--hairline\)/.test(toastRule) ? ['.toast borders with var(--hairline)'] : []);
  // Stepped off the body token (+8%), not written as a raw px: a literal here would re-open the ad-hoc type
  // sizes the scale replaced, and the raw-px check above would fail.
  none('the toast text dropped back to body size (error wording reads a notch larger)',
    /font-size:calc\(var\(--fs-sm\) \* 1\.08\)/.test(toastRule) ? [] : ['.toast is not stepped up off --fs-sm']);
  // …and the fix must stay SCOPED to the toast: widening the shared seam token would put a hard line around
  // every region in the app.
  none('the shared seam token was widened instead of the toast being fixed in place',
    /--hairline:rgba\(255,255,255,\.05\);/.test(HTML) ? [] : ['the --hairline token is no longer rgba(255,255,255,.05)']);

  // ── SELECTION IS NEUTRAL ────────────────────────────────────────────────────────────────────────────────
  // Selected ≠ alert. Projects were Claude-orange and sessions were --live red; both now read from --sel.
  // comments stripped first — they trail into the next rule's selector chunk and get reported as the offender
  const selRules = flat.replace(/\/\*[\s\S]*?\*\//g, '').split('}').filter((c) => /\.(sess\.active|ws-chip\.active)\{/.test(c));
  none('the selected row/project is painted with an ALERT colour again (orange / --live)',
    selRules.filter((c) => /217,119,87|var\(--live\)/.test(c)).map((c) => c.split('{')[0].trim().slice(0, 50)));
  none('…and it must still actually paint something (via --sel)',
    selRules.length >= 2 && selRules.every((c) => /var\(--sel\)/.test(c)) ? [] : ['.sess.active / .ws-chip.active do not both use var(--sel)']);

  // …and the resting first row must start past the top fade, or the vignette washes out a project name.
  const topFade = Number((flat.match(/\.ws-chips\{[^}]*?mask-image:linear-gradient\(to bottom,transparent,#000 ([\d.]+)px/) || [])[1]);
  none('the scroll vignette now eats into the first project row (top fade outruns .ws-chips padding-top)',
    Number.isFinite(topFade) && Number.isFinite(chipsPad) && topFade <= chipsPad
      ? [] : [`top fade ${topFade}px > padding-top ${chipsPad}px`]);
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
// 13. Three kinds of project at creation time (owner decision, 2026-07-19, restoring what 476630e removed):
//     Local / Shared GitHub project / Add existing folder. The invariants that survive from both eras:
//     (a) the shared tile exists AND its creation path carries the SAME honest transcript-sync consent as the
//         ▾-menu share flows (the pre-476630e tile had none — that gap must never come back);
//     (b) the repo-creation plumbing stays alive (invites, discovery, upgrade AND the tile depend on it);
//     (c) the later ▾-menu flows survive for projects that start private.
// ---------------------------------------------------------------------------------------------------------
{
  // See the import tile's twin below for why role= is `button` now. Reachability is the rule, not the role.
  none('the New-project modal lost its shared-repo tile', /id="ch-repo" data-kind="repo" role="button"/.test(HTML) ? [] : ['index.html has no #ch-repo tile']);
  // 3b added a FOURTH kind, 'import' (clone an existing GitHub repo). What this pin protects is unchanged —
  // 'repo' must stay reachable from the modal with its creating-a-private-repo busy text — so the list is
  // matched by membership rather than by exact equality, which would have to be edited for every future kind.
  none('the modal path cannot reach workspaceCreate with kind repo',
    /const WS_KINDS = \[[^\]]*'repo'[^\]]*\]/.test(APP) && /creating private repo on GitHub/.test(APP) ? [] : ['WS_KINDS lost repo (or its busy text is gone)']);
  // Creating shared publishes transcripts from birth — the tile must gate on the same honest disclosure the
  // ▾-menu flows use (R2). The gate MOVED when the modal split into two steps: out of a native confirm() and
  // onto the page, because the surface people click past is the wrong home for the most consequential sentence
  // in the flow. It was also CORRECTED — the old text said transcripts land in "that private repo", meaning the
  // code repo, which stopped being true when create-workspace.sh started minting a separate <slug>-sessions
  // repo and gitignoring .claude/ out of the code one. The old wording made the app sound leakier than it is.
  //
  // Same rule, five clauses, all of which must hold — a disclosure nobody must acknowledge is not a gate, and
  // an acknowledged gate that describes the wrong repo is not a disclosure:
  //   (a) createWorkspace REFUSES the shared path on an unticked box. Enforced in JS rather than by the disabled
  //       button alone, because Enter reaches createWorkspace past a disabled button (its own in-flight guard
  //       exists for that reason).
  //   (b) that refusal happens BEFORE workspaceCreate is called — asserted by source position, which the old
  //       confirm()-shaped pin could not express.
  //   (c) the disclosure is in the markup and says TWO repos, so a revert to the single-repo claim fails here.
  //   (d) the acknowledgement control exists.
  //   (e) the button gate exists and the checkbox re-evaluates it — otherwise the charset validator, which sets
  //       .disabled from the name alone, silently re-enables Create the moment a valid name is typed.
  {
    const iAck = APP.indexOf("const ack = $('ws-consent-ok')");
    const iCreate = APP.indexOf('claudible.workspaceCreate(');
    none('the shared tile creates without the transcript-sync consent gate',
      [/wsChoiceKind === 'repo'\) \{[\s\S]{0,240}?ws-consent-ok[\s\S]{0,240}?!ack\.checked[\s\S]{0,240}?return;/.test(APP)
        ? '' : 'createWorkspace no longer refuses the shared path when the consent box is unticked',
       (iAck > 0 && iCreate > 0 && iAck < iCreate)
        ? '' : 'the consent check no longer precedes workspaceCreate — a shared project could be created before it is agreed to',
       /id="ws-consent"[\s\S]{0,1200}?two private repos/i.test(HTML)
        ? '' : 'the two-repo disclosure is missing from #ws-consent, or has reverted to the old single-repo wording',
       /id="ws-consent-ok"/.test(HTML) ? '' : 'no #ws-consent-ok acknowledgement checkbox',
       /function syncWsCreateGate\(\)[\s\S]{0,400}?btn\.disabled = true/.test(APP)
        ? '' : 'syncWsCreateGate no longer forces Create disabled while the consent box is unticked',
       /\$\('ws-consent-ok'\)\.addEventListener\('change'/.test(APP)
        ? '' : 'the consent checkbox is not wired to re-evaluate the Create button'].filter(Boolean));
  }
  // ^\s*repo\)\s*$ = the actual case label. A bare /repo\)/ was satisfied by the header comment
  // "kind (local|repo)," — the comment-blindness trap that has now bitten this repo's guards three times.
  none('the repo-creation plumbing was garbage-collected (invites/discovery/upgrade/the tile all need it)',
    /^\s*repo\)\s*$/m.test(read('wsl/create-workspace.sh')) && /workspace:create/.test(MAIN) && /upgrade-workspace\.sh/.test(MAIN) ? [] : ['create-workspace.sh repo branch / workspace:create / upgrade path missing']);
  // The ▾-menu flows must all still exist for projects that start private.
  const deferred = ['upgradeWorkspace(', 'inviteToLocal(', 'openSyncModal('].filter((f) => !APP.includes(f));
  none('a ▾-menu sync/share flow is gone', deferred);
}

// ---------------------------------------------------------------------------------------------------------
// 14. A wsl/posix voice install must START the services it installed (R8). deps.install only downloads/builds
//     (provision.sh voice → setup.sh); the only other startVoiceServices callers are boot-path. Without this,
//     the wizard reports "ready" while Whisper/Kokoro aren't running and the first Talk fails until a relaunch.
// ---------------------------------------------------------------------------------------------------------
{
  const pf = (MAIN.match(/ipcMain\.handle\('preflight:install'[\s\S]*?\n\}\);/) || [''])[0];
  none('preflight:install does not start voice services after a successful non-win voice install (R8)',
    /if \(id === 'voice'\) startVoiceServices\(\);/.test(pf) ? [] : ['no startVoiceServices() in the success path']);
  // …and it must sit INSIDE the res.ok branch: starting services after a FAILED install would mask the failure.
  none('the R8 service-start is reachable on failure (must be inside the res.ok branch)',
    /if \(res\.ok\) \{[\s\S]*?if \(id === 'voice'\) startVoiceServices\(\);[\s\S]*?\n  \}/.test(pf) ? [] : ['startVoiceServices() is not inside the res.ok block']);
}

// ---------------------------------------------------------------------------------------------------------
// 15. R4 — durable state lives OUTSIDE the app folder. runtime/ sits in the clone, so delete-and-reclone (the
//     documented uninstall, update-by-reclone, an antivirus quarantine) wiped the registry, every sync consent
//     and every title (the 2026-07-18 data loss). Settings/registry/history must anchor at ~/.claudible/app,
//     with a one-time migration so existing installs don't boot empty. Per-tab runtime deliberately STAYS in
//     RT (wsl/session.sh derives the same path from $APPDIR — moving it would split writer from pollers).
// ---------------------------------------------------------------------------------------------------------
{
  none('PERSIST is not anchored at ~/.claudible/app (or lost its test override)',
    /const PERSIST = process\.env\.CLAUDIBLE_PERSIST \|\| path\.join\(app\.getPath\('home'\), '\.claudible', 'app'\)/.test(MAIN) ? [] : ['PERSIST default wrong/missing']);
  none('settings.json moved back inside the clone (R4 regression: wiped by delete-and-reclone)',
    /const SETTINGS_FILE = path\.join\(PERSIST, 'settings\.json'\)/.test(MAIN) ? [] : ['SETTINGS_FILE not under PERSIST']);
  none('workspaces.json moved back inside the clone (R4 regression)',
    /const WORKSPACES = path\.join\(PERSIST, 'workspaces\.json'\)/.test(MAIN) ? [] : ['WORKSPACES not under PERSIST']);
  none('session history moved back inside the clone (R4 regression)',
    /path\.join\(PERSIST, 'history'\)/.test(MAIN) ? [] : ['_histFile not under PERSIST']);
  none('the one-time migration from the old in-clone location is gone (existing installs would boot empty)',
    /copyAtomic\(oldP, newP\)/.test(MAIN) && /'settings\.json', 'workspaces\.json'/.test(MAIN) && /fs\.renameSync\(tmp, dst\)/.test(MAIN) ? [] : ['migration copy missing (or no longer atomic)']);
  none('writeSettings still mkdirs the old RT root instead of PERSIST',
    /function writeSettings\(obj\) \{ fs\.mkdirSync\(PERSIST/.test(MAIN) ? [] : ['writeSettings mkdirs the wrong root']);
}

// ---------------------------------------------------------------------------------------------------------
// 16. R2/R3 — consent tells the truth, and a promise made is a promise kept.
//     R2: publishing a local project to GitHub (upgrade OR invite) must be gated by a confirm that HONESTLY
//     discloses transcript sync — the old text claimed transcripts "stay OUT of the repo" while the same click
//     enabled the machinery that commits them. R3: the accept-invite modal says "sessions still sync with the
//     team"; accepting must actually enable syncSessions (and kick the first sync), or the promise is a lie.
// ---------------------------------------------------------------------------------------------------------
{
  // Comments stripped first — the fix's own comment QUOTES the old line (comment-blindness, reverse edition).
  const appCode = APP.split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
  none('the sync/share consent claims transcripts stay OUT of the repo again (they sync — that is the feature)',
    /stay OUT of the repo/i.test(appCode) ? ['the lying consent line is back'] : []);
  const upg = (APP.match(/async function upgradeWorkspace\(w\) \{[\s\S]*?\n\}/) || [''])[0];
  none('upgradeWorkspace lost its consent gate or its transcript disclosure',
    /if \(!confirm\([\s\S]*?transcripts/.test(upg) ? [] : ['no confirm with a transcript disclosure']);
  const inv = (APP.match(/async function inviteToLocal\(w\) \{[\s\S]*?\n\}/) || [''])[0];
  none('inviteToLocal publishes to GitHub without consent (R2 — must confirm BEFORE workspaceUpgrade)',
    /if \(!confirm\([\s\S]*?transcripts[\s\S]*?workspaceUpgrade\(/.test(inv) ? [] : ['no confirm before workspaceUpgrade']);
  const acc = (MAIN.match(/ipcMain\.handle\('workspace:acceptInvite'[\s\S]*?\n\}\);/) || [''])[0];
  none('acceptInvite does not enable syncSessions on a successful clone (R3 — the modal promises sync)',
    /after\.syncSessions = true; saveRegistry\(\);/.test(acc) ? [] : ['no syncSessions enable in acceptInvite']);
  none('acceptInvite enables sync but never kicks the first one (team sessions would wait for a poll tick)',
    /runSync\(after, 'init'/.test(acc) && /doSync\(after, 'sync'/.test(acc) ? [] : ['no init/sync kick after enabling']);
  // The import must be AWAITED before the handler returns ok — the renderer switches into the project the
  // instant acceptInvite resolves and reads the on-disk session list; a fire-and-forget import returned ok with
  // the dir still empty → the resolver said 'new' → the phantom draft. Both init and the transcript-copying
  // `sync` op are awaited, in order.
  none('acceptInvite returns before the session import lands (the phantom-draft race)',
    /await runSync\(after, 'init', \{\}\); if \(ir && ir\.ok\) await doSync\(after, 'sync', \{\}\);/.test(acc) ? [] : ['acceptInvite does not await the session import before returning']);
  // A SHARED project created from the modal must behave like an upgraded one from birth: sync enabled + the
  // sessions-branch init/first-push kicked inside workspace:create's attach(). Without this, the "Shared repo
  // project" tile mints a repo whose creator can't see collaborators' sessions until a manual menu click.
  const wc = MAIN.slice(MAIN.indexOf("ipcMain.handle('workspace:create'"), MAIN.indexOf("ipcMain.handle('workspace:adopt'"));
  none('a created shared repo does not auto-enable session sync (creator-side sync dead until a manual click)',
    /ws\.syncSessions = true;/.test(wc) && /runSync\(ws, 'init'/.test(wc) && /doSync\(ws, 'sync'/.test(wc) ? [] : ['no syncSessions/init/sync kick in workspace:create attach']);
  none('workspace:create drops the authIssue flag (the connect-GitHub hint would never show for creation)',
    /authIssue: !!r\.authIssue/.test(wc) && /"authIssue":true/.test(read('wsl/create-workspace.sh')) ? [] : ['authIssue not threaded through the create path']);
}

// ---------------------------------------------------------------------------------------------------------
// 17. R14 — reconnects must survive real life. (a) hello resets every retry counter (they accumulated for the
//     tab's LIFETIME — the 9th cold dial ever was permanent death); (b) the cold give-up arms a 30s lifeline
//     instead of a bare return; (c) the browser guest drops a twice-refused resume token and falls back to the
//     link (it retried the same dead token forever, and reload couldn't escape sessionStorage); (d) a dead
//     joined row offers ↻ reconnect (it offered only focus and Leave).
// ---------------------------------------------------------------------------------------------------------
{
  const GUEST = read('share/guest.js');
  none('hello does not reset the reconnect counters (blips accumulate to permanent death)',
    /case 'hello': \{\s*\n\s*gotHello = true;[^\n]*\n\s*r\.retry = 0; r\.coldTries = 0; r\.resumeFails = 0;/.test(MAIN) ? [] : ['no counter reset in hello']);
  none('the cold give-up is a permanent return again (no lifeline timer)',
    /coldTries > 8\) \{[\s\S]{0,900}?setTimeout\(\(\) => openLiveSocket\(tabId\), 30000\)/.test(MAIN) ? [] : ['no 30s lifeline after coldTries > 8']);
  none('guest.js retries a dead resume token forever (no link fallback)',
    /resumeFails >= 2 && token/.test(GUEST) && /sessionStorage\.removeItem\(STORE_KEY\)/.test(GUEST) ? [] : ['no resume→link fallback in guest.js']);
  none('a dead joined row has no reconnect affordance',
    /rec\.liveState === 'offline' \|\| rec\.liveState === 'denied'\) \{[\s\S]{0,900}?Reconnect to this live session/.test(APP) ? [] : ['no ↻ button on offline/denied joined rows']);
}

// ---------------------------------------------------------------------------------------------------------
// 18. R16/R18/R30 — error surfaces speak human. One shared installer filter guards ALL THREE install-error
//     surfaces (click path, streamed provision path, Connect-Claude popover); the join catch toasts through
//     humanError (never a raw JS exception); the joined row maps wire denial codes ('full') to sentences.
// ---------------------------------------------------------------------------------------------------------
{
  none('installErrText is missing or unused on one of its three surfaces (R18)',
    /function installErrText\(raw\)/.test(APP) && (APP.match(/installErrText\(/g) || []).length >= 4 ? [] : ['def + 3 call sites required']);
  none('openLiveTab toasts a raw JS exception on a join crash (R16)',
    /toast\('Join failed: ' \+ humanError\(e && e\.message\)\)/.test(APP) ? [] : ['join catch bypasses humanError']);
  none('the joined row paints raw wire denial codes (R30)',
    /function liveReasonText\(/.test(APP)
      && /function joinedTooltip\(rec\)[\s\S]{0,400}?liveReasonText\(rec\.liveReason\)/.test(APP)
      && (APP.match(/appendChild\(joinedBadge\(rec\)\)/g) || []).length === 2   // BOTH paint paths go through the one builder (calls, not the definition)
      ? [] : ['wire codes must map through liveReasonText in the shared joined-row builder, used by both sites']);
}

// ---------------------------------------------------------------------------------------------------------
// 19. R13 — the live-session sync exclusion takes the UNION of live writers. opts.live (newest busy session)
//     must never SUPPRESS the advertised/hosted session: with a second tab mid-turn, "Sync now" exported the
//     hosted transcript while Claude appended to it. main builds a deduped space-joined list (per-id charset
//     check before the shell line); the script's is_live() matches against the list at BOTH skip sites.
// ---------------------------------------------------------------------------------------------------------
{
  const SYNC = read('wsl/sessions-sync.sh');
  none('doSync collapses the live ids with || again (the hosted session loses its exclusion)',
    /new Set\(_cands\)/.test(MAIN) && /\.join\(' '\)/.test(MAIN) ? [] : ['no union build in doSync']);
  none('sessions-sync.sh lost its list-aware live check (is_live), or a skip site bypasses it',
    /is_live\(\) \{ case " \$LIVE " in \*" \$1 "\*\)/.test(SYNC) && (SYNC.match(/is_live "\$id" && continue/g) || []).length === 2 ? [] : ['is_live missing or not used at both import+export sites']);
}

// ---------------------------------------------------------------------------------------------------------
// 20. R12 — an invite targets the repo's RECORDED owner, never whoever happens to be signed in. The script
//     used to resolve `gh api user` (the clicker) as the namespace: a collaborator inviting a third person
//     PUT against their own account — a same-named repo of theirs got the invite, or it 404'd as "invited".
// ---------------------------------------------------------------------------------------------------------
{
  const INV = read('wsl/repo-invite.sh');
  none('repo:invite does not pass the workspace owner through to the script',
    /const owner = String\(ws\.owner \|\| ''\)/.test(MAIN) && /repo-invite\.sh', `'\$\{repo\}' '\$\{login\}' '\$\{owner\}'`/.test(MAIN) ? [] : ['owner not threaded through repo:invite']);
  none('repo-invite.sh trusts the signed-in user as the namespace again',
    /owner="\$\{3:-\}"/.test(INV) && /\[ "\$me" != "\$owner" \]/.test(INV) && /repos\/\$owner\/\$slug\/collaborators/.test(INV) ? [] : ['script must take owner as $3, refuse a non-owner, and PUT against $owner']);
}

// ---------------------------------------------------------------------------------------------------------
// 21. R9 — a stale git lock self-heals. An interrupted git write (timeout-killed wrapper, sleep, force-quit)
//     left index.lock behind and NOTHING cleared it: every later sync write failed silently, forever. The
//     clear must be age-BOUNDED (>60s) so a genuinely-running git is never stepped on, and must run before
//     the first write of every invocation (ensure_worktree's healthy path).
// ---------------------------------------------------------------------------------------------------------
{
  const SYNC = read('wsl/sessions-sync.sh');
  none('sessions-sync.sh lost its stale-lock self-heal (one interrupted write wedges sync forever)',
    /clear_stale_locks\(\) \{/.test(SYNC) && /index\.lock/.test(SYNC) && /-gt 60 \]/.test(SYNC) ? [] : ['clear_stale_locks with a 60s bound is required']);
  none('the stale-lock heal is not wired into ensure_worktree’s healthy path',
    /rev-parse --is-inside-work-tree >\/dev\/null 2>&1; then\n\s*clear_stale_locks/.test(SYNC) ? [] : ['ensure_worktree must call clear_stale_locks before the first write']);
}

// ---------------------------------------------------------------------------------------------------------
// 22. R17/R19 — the last two raw-error surfaces speak human. install-claude.sh classifies permission/network
//     failures into next steps (raw npm noise only survives labeled "npm said:"); the voice STT/TTS handlers
//     translate transport failures (services down / timeout) instead of returning String(err) internals.
// ---------------------------------------------------------------------------------------------------------
{
  const IC = read('wsl/install-claude.sh');
  none('install-claude.sh dumps raw npm output again (R17)',
    /EACCES/.test(IC) && /network problem reaching npm/.test(IC) && /npm said: /.test(IC) ? [] : ['classification missing']);
  none('a voice STT/TTS failure returns the raw exception again (R19)',
    /function voiceErrText\(err, what\)/.test(MAIN)
    && /voiceErrText\(err, 'transcription'\)/.test(MAIN) && /voiceErrText\(err, 'speech'\)/.test(MAIN)
    && !/catch \(err\) \{ return \{ error: String\(err\) \}; \}/.test(MAIN) ? [] : ['voiceErrText missing or a catch still returns String(err)']);
}

// ---------------------------------------------------------------------------------------------------------
// 23. R20 — ending a live session releases the HOST's own voice-room membership. Every guest path already
//     drops voice on leave (closeTab does it for joined tabs); the host's end paths never did — the mic stayed
//     hot after "End Session" and the next share inherited a ghost member. endLiveNow is the ONE host-side
//     teardown (check 10's singleton), so the leave belongs exactly there.
// ---------------------------------------------------------------------------------------------------------
{
  none('endLiveNow does not release the host voice room (mic stays hot after End Session)',
    /function endLiveNow\(msg\) \{[\s\S]{0,700}?hostVoice\.isJoined\(\)\) hostVoice\.leave\(\);/.test(APP) ? [] : ['no hostVoice.leave() in endLiveNow']);
}

// ---------------------------------------------------------------------------------------------------------
// 24. R21 — node-path.sh rescues EVERY rc-file-init version manager, not just nvm. fnm/volta/asdf/n park
//     their nodes in predictable dirs and rely on shell init a `-lc` shell never runs — the identical
//     silent-empty-answer hole nvm had. The sweep must cover them and pick the newest node found.
// ---------------------------------------------------------------------------------------------------------
{
  const NP = read('wsl/node-path.sh');
  const missing = ['fnm/node-versions', '.asdf/installs/nodejs', '.volta/tools/image/node', 'versions/node']
    .filter((p) => !NP.includes(p));
  none('node-path.sh dropped a version manager from its sweep (its users get silent empty answers)', missing);
  none('the sweep no longer picks the NEWEST managed node (a stale manager dir would shadow the real one)',
    /_clbestv" "\$_clnv" \| sort -V \| tail -n1/.test(NP) ? [] : ['newest-wins comparison missing']);
}

// ---------------------------------------------------------------------------------------------------------
// 25. R23 — the wizard's "Create your project" step is reachable on a first run. The registry guarantees a
//     default workspace at boot, so a bare "some workspace exists" gate made step 3 permanently dead: every
//     user skipped naming their first project. On firstRun, the auto-created default must not count.
// ---------------------------------------------------------------------------------------------------------
//     The gate now reads bootFirstRun — the boot-time firstRun value captured in maybeFirstRun BEFORE the
//     registry flag is cleared — because the wizard re-reads workspaceList ~700ms later, by which point
//     reading wl.firstRun directly always saw false (re-breaking R23 via the second read + stacking a modal).
// ⚠️ SUPERSEDED 2026-08-02 — R23's gate is gone because the STEP it gated is gone. Read this before "fixing" it.
//   R23 made the create-project step reachable so users could name their first project. That was a real fix for
//   a real problem (the step was dead code; every install kept the placeholder name). It also meant a fresh
//   install ended up with TWO local projects: main.js's ensureDefaultLocal guarantees `local-local` at boot —
//   startup needs a valid cwd, so it is synchronous at registry load and cannot just be dropped — and then this
//   step created a second. Observed on a real registry: `local-local` "Local" alongside `local-my-project`
//   "My Project", two placeholders, neither asked for.
//   createWorkspace() (the sidebar modal) has a cleanup that deletes the leftover `local-local` in exactly this
//   case. The wizard's createWs() never called it. That asymmetry was the bug.
//   Owners (CRAZY + MK) chose to delete the step rather than port the cleanup: a step whose only job is to make
//   a project you already have should not exist. Cost accepted — a new install keeps the name "Local" instead
//   of one the user typed, which is the very thing R23 improved; against that, a click-through user was getting
//   "My Project" AND "Local" anyway, and inline rename has always existed.
//   Side effect, deliberate: GitHub now follows Claude directly — the patch plan's W3, for free.
//   RESTORING THE STEP? Port the `local-local` cleanup with it, or make it RENAME `local-local` instead of
//   creating a sibling. Do not re-add it alone; that is how the duplicate came back the first time.
{
  none('the wizard create-project step is back without the cleanup that made it safe',
    [/wiz-ws-create/.test(HTML) ? 'index.html has the create-project step markup again' : '',
     /function createWs\(\)/.test(APP) ? 'app.js has createWs() again' : ''].filter(Boolean));
  none('the wizard no longer runs System check → Claude → GitHub as three steps',
    (HTML.match(/class="wiz-step" data-step=/g) || []).length === 3
      && ([...(HTML.match(/<div class="wiz-steps">[^<]*(?:<span[^>]*><\/span>)+<\/div>/) || [''])[0].matchAll(/wiz-dot/g)].length === 3)
      ? [] : ['step count and the progress dots disagree, or there are not exactly 3 of each']);
  none('GitHub is not the step the device-flow poll watches (an abandoned approval would never time out)',
    /step === 3 && ghWaiting/.test(APP) && /async function goGh\(\) \{ show\(3\)/.test(APP)
      ? [] : ['goGh/tick disagree about which step GitHub is']);
}

// ---------------------------------------------------------------------------------------------------------
// 26. R11 — per-machine tags. "My login's branch copy differs from my local" is self-compaction ONLY when it
//     came from THIS machine; a copy exported by ANOTHER of the user's machines is a real fork and must hit
//     the full divergence detection (it was silently masked — last pusher overwrote the other device). The
//     behavioral proof lives in sessions-divergence scenarios 6-7; this pins the wiring so it can't be
//     garbage-collected: MID resolution (env > file > generate), tag_write on export, tag_of in the _own gate.
// ---------------------------------------------------------------------------------------------------------
{
  const SYNC = read('wsl/sessions-sync.sh');
  none('the per-machine identity resolution is gone (R11)',
    /MID="\$\{CLAUDIBLE_MACHINE_ID:-\}"/.test(SYNC) && /machine-id/.test(SYNC) ? [] : ['MID env>file>generate chain missing']);
  none('exports no longer stamp their machine tag (R11)',
    /&& tag_write "\$id"/.test(SYNC) ? [] : ['tag_write not called on export']);
  none('the own-compaction gate ignores the machine tag again (R11 — own-device forks masked)',
    /\[ "\$_own" -eq 1 \] && \{ _tid="\$\(tag_of "\$id"\)"; \[ -z "\$_tid" \] \|\| \[ "\$_tid" = "\$MID" \]; \}/.test(SYNC) ? [] : ['the _own gate must consult tag_of vs MID']);
  // Reinstalling mints a new machine identity, so this machine's own earlier exports carry a dead one. Where the
  // branch copy under our own login is byte-identical there is no fork to report, and import must re-claim the
  // row for this machine — otherwise every self-authored session reads as another device's copy forever.
  none('the identical own-dir branch no longer re-claims a stale machine stamp (self-authored sessions read as another device forever)',
    /if cmp -s "\$f" "\$dest"; then\s*\n\s*\[ "\$_own" -eq 1 \] && tag_heal "\$id"/.test(SYNC) && /^tag_heal\(\) \{/m.test(SYNC)
      ? [] : ['tag_heal must be defined and called in the identical own-dir branch']);
  // The re-claim is only ever safe for a transcript this machine wrote itself. An id that arrived from the
  // branch keeps its exporter's stamp: claiming it would make the own-compaction gate above read a genuine
  // second-device fork as this machine's own rewrite and resolve it silently, which is the exact masking the
  // stamp exists to prevent. So: exactly one call site, and the foreign-set guard inside.
  const HEAL = SYNC.slice(SYNC.indexOf('tag_heal() {'), SYNC.indexOf('# --- ensure the sessions worktree'));
  none('the stale-stamp re-claim escaped its own-transcript limits (a live second device\'s copy could be claimed)',
    [(SYNC.match(/tag_heal "\$id"/g) || []).length === 1 ? '' : 'tag_heal must be called from exactly one branch (the identical own-dir one)',
     /grep -qxF -- "\$1" "\$FSET" 2>\/dev\/null && return 0/.test(HEAL) ? '' : 'tag_heal must refuse ids recorded in the foreign set',
     HEAL.indexOf('"$FSET"') < HEAL.indexOf('tag_write') ? '' : 'the foreign-set guard must run before the re-stamp'].filter(Boolean));
}

// ---------------------------------------------------------------------------------------------------------
// 27. R15 — delete-tombstones cover every GitHub-identified workspace. The old kind==='repo' gate meant a
//     deleted ADOPTED project (kind:'local') never tombstoned and re-surfaced as a phantom invite; a delete
//     before the ghId backfill tombstoned by name only, so an external rename resurrected it. The tombstone
//     is now kind-agnostic, and the stable gh: key is backfilled in the background onto a snapshot.
// ---------------------------------------------------------------------------------------------------------
{
  // C-3.6 refactored the inline ipcMain.handle callback into a named workspaceDeleteCore(id) (so the "Delete
  // from GitHub" path can call the exact same core after the repo itself is gone) — capture the FUNCTION now,
  // not the registration line, up to the point it hands back off to ipcMain.handle.
  // The refuse-with-override work gave it a second parameter (`force` — the user's explicit "delete anyway" for a dirty/unpushed
  // clone), so the signature is matched loosely; the capture window is unchanged.
  const del = (MAIN.match(/function workspaceDeleteCore\([^)]*\) \{[\s\S]*?\nipcMain\.handle\('workspace:delete'/) || [''])[0];
  none('the workspaceDeleteCore capture went vacuous (every check in this block would pass on an empty string)',
    del ? [] : ['workspaceDeleteCore(...) → ipcMain.handle(\'workspace:delete\') no longer matches — fix the pin, do not let it match nothing']);
  none('the delete tombstone regrew its kind gate (adopted repos become phantoms again)',
    /const keys = repoTombstoneKeys\(ws\);\s*\n\s*if \(keys\.length\)/.test(del) && !/ws\.kind === 'repo' && ws\.owner && ws\.slug\) \{\s*\n\s*registry\.dismissedRepos/.test(del) ? [] : ['kind-agnostic tombstone missing']);
  none('the background gh-key backfill on delete is gone (external renames resurrect deleted projects)',
    /backfillRepoIdentity\(snap\)\.then/.test(del) && /'gh:' \+ snap\.ghId/.test(del) ? [] : ['no snapshot backfill append']);
}

// ---------------------------------------------------------------------------------------------------------
// 28. R10 — every sessions-branch operation rides ONE per-workspace chain (_syncQ). syncLock only guarded
//     doSync against itself; presence/delete/resolve/title ran the same script concurrently and pull_branch's
//     reset --hard could discard another op's commit. Every sessions-sync.sh invocation in main must run
//     inside _syncQ.run — EXCEPT the detached quit-path clear (a queue dies with the process; R7).
// ---------------------------------------------------------------------------------------------------------
{
  const calls = (MAIN.match(/runner\.runScript\('sessions-sync\.sh'/g) || []).length;
  const queued = (MAIN.match(/_syncQ\.run\([^\n]*runner\.runScript\('sessions-sync\.sh'/g) || []).length;
  // TWO sanctioned un-queued sites, each with a reason the queue exists to protect against NOT applying:
  //   · runPresence's exec() — queued for every op, direct ONLY when opts.detach (the quit path; R7) or
  //     opts.direct (the beacon's skip-fetch presence read: a lock-free object-store read with no worktree,
  //     no fetch, no merge — front-of-queue can't help against a RUNNING multi-second sync, so it must not
  //     queue at all).
  //   · the beacon's 'remote-head' probe — a narrow branch fetch the script answers before ever touching the
  //     worktree (no merge, no lock). It MUST bypass: queued behind a 120s sync it would be a dead beacon.
  //     The op string is pinned literal here so no other op can ride this exemption.
  //   · the relay's 'relay-cred' read — one `gh auth token` + the cached author, no git at all, no worktree;
  //     queueing it would couple relay connects to transcript syncs for nothing. Pinned literal, exactly one.
  const beaconProbes = (MAIN.match(/runner\.runScript\('sessions-sync\.sh', 'remote-head'/g) || []).length;
  const credReads = (MAIN.match(/runner\.runScript\('sessions-sync\.sh', 'relay-cred'/g) || []).length;
  none('a sessions-sync.sh invocation escaped the per-ws serialization chain (R10)',
    calls === queued + 1 + beaconProbes + credReads && beaconProbes === 1 && credReads === 1 && /if \(opts && \(opts\.detach \|\| opts\.direct\)\) \{ exec\(\); return; \}/.test(MAIN) ? []
      : [`${calls} invocations, ${queued} queued, ${beaconProbes} remote-head, ${credReads} relay-cred — every site except runPresence's detach/direct-guarded exec and the two pinned literal reads must go through _syncQ.run`]);
  none('presence-beat coalescing lost its byte-identical guard (a re-share would advertise a stale handle)',
    /_beatArgs\.get\(key\) === args\) return;/.test(MAIN) ? [] : ['coalescing must compare exact args']);
}

// ---------------------------------------------------------------------------------------------------------
// 29. R22 — the win-native pty kill reaps the WHOLE tree. ConPTY's kill can be single-process (the known
//     Electron/node-pty failure), and killtree.sh never runs on the win runner — so the claude.exe→node
//     child tree survived every close path. facade.kill() must fire a detached `taskkill /T /F` on the pid
//     captured BEFORE the kill. Static pin only — this machine has no win-native install; the behavior needs
//     the Windows smoke pass (docs/TWO-MACHINE-TEST.md flags it).
// ---------------------------------------------------------------------------------------------------------
{
  const WIN = read('runners/win.js');
  // kill() gained an OPTIONAL onReaped callback (X/2d — respawnPty must not spawn a replacement claude into a
  // tree that is still dying), so the body is no longer one straight line. Every invariant this pin exists for
  // is unchanged and still asserted: the pid is captured BEFORE inner.kill, taskkill walks the tree with /T /F
  // on that pid, and the child stays detached + unref'd so the quit sweep's reap outlives app.quit().
  none('win.js facade.kill no longer tree-reaps (children pile up across restarts on win-native)',
    /const pid = inner && inner\.pid;[\s\S]{0,400}?try \{ inner\.kill\(signal\); \} catch \{\}[\s\S]{0,240}?cp\.spawn\('taskkill', \['\/PID', String\(pid\), '\/T', '\/F'\]/.test(WIN)
    && /detached: true, stdio: 'ignore'/.test(WIN) && /c\.unref\(\);/.test(WIN)
      ? [] : ['taskkill /T /F tree-reap missing from facade.kill']);
}

// ---------------------------------------------------------------------------------------------------------
// 30. R32 — exactly one instance. A second launch used to boot a whole second app: two voice-service owners
//     racing the ports (the double-spawn 59c407d closed, resurrected across processes), two pollers on one
//     runtime dir, two sync engines on one branch. The second instance must defer and the first must surface.
// ---------------------------------------------------------------------------------------------------------
none('the single-instance lock is gone (a double-launch races voice/pollers/sync again)',
  /if \(!app\.requestSingleInstanceLock\(\)\) \{\s*\n\s*app\.quit\(\);/.test(MAIN)
  && /app\.on\('second-instance'/.test(MAIN) ? [] : ['requestSingleInstanceLock + second-instance focus required']);

// ---------------------------------------------------------------------------------------------------------
// 31. R35/R36/R37/R38/R41 — the remaining quiet/raw failure surfaces. Skill toggle can't fail silently or
//     print a bare code; kicking a guest reports its failure; checkpoint-revert's fallthrough humanizes;
//     the new-session name-share failure toasts like the rename path; delete-workspace only appends a
//     sentence-shaped reason.
// ---------------------------------------------------------------------------------------------------------
{
  none('the skill toggle fails silently / prints a raw code again (R35)',
    /Could not switch that skill — ' \+ humanError\(\(r && r\.error\) \|\| 'exec'\)/.test(APP) ? [] : ['skill toggle not humanized']);
  none('kicking a guest fails silently again (R36)',
    /Could not remove ' \+ g\.name/.test(APP) ? [] : ['no kick-failure toast']);
  none('checkpoint-revert renders a bare internal label again (R37)',
    /'session history is off' : \(r && r\.error\) \? humanError\(r\.error\)/.test(APP) ? [] : ['revert fallthrough not humanized']);
  none('a new-session name-share failure is silent again (R38)',
    /Named here — sharing the name failed, will keep retrying/.test(APP) && (APP.match(/sharing the name failed/g) || []).length >= 2 ? [] : ['pendingTitle publish failure must toast like the rename path']);
  none('delete-workspace staples a bare code onto its message again (R41)',
    /r\.error && \/\\s\/\.test\(r\.error\) \? ': ' \+ r\.error : ''/.test(MAIN) ? [] : ['sentence-gate missing']);
}

// ---------------------------------------------------------------------------------------------------------
// 32. R24/R25 — sync-file hygiene. Every rewrite of a shared marker/staging file uses a PID-unique temp
//     (delete-session.sh runs OUTSIDE the R10 queue, so fixed names still raced), and a sync whose PUSH fails
//     still reports the ids its IMPORT changed — main reloads open tabs from that list, and a bare fail()
//     left them silently stale until the next successful pass.
// ---------------------------------------------------------------------------------------------------------
{
  const SYNC = read('wsl/sessions-sync.sh'), DEL = read('wsl/delete-session.sh');
  none('a shared tmp filename lost its PID suffix (R24 — cross-process rewrites race again)',
    /cltmp\.\$\$/.test(SYNC) && /claudible-deleted\.tmp\.\$\$/.test(SYNC) && /\$dl\.tmp\.\$\$/.test(DEL) ? [] : ['PID-unique tmps required in import_file, the sync-side marker rewrite, and delete-session.sh']);
  none('a failed push swallows the import results again (R25 — open tabs stay stale)',
    /"ok\\":false,\\"error\\":\\"push failed[^\n]*\\"ids\\":\$\(ids_json\)/.test(SYNC) ? [] : ['the sync op must emit ids on push failure']);
}

// ---------------------------------------------------------------------------------------------------------
// 33. R26/R27/R31/R39/R40 — joined-tab + discovery truthfulness. Read-only mirrors say so (toast once + row
//     label); a hard reconnect re-arms the voice room; "Check for invites" distinguishes can't-look from
//     found-nothing; /clear on a mirror keeps the host's tracker; no Join badge on an already-joined session.
// ---------------------------------------------------------------------------------------------------------
{
  const DISC = read('wsl/sessions-discover.sh');
  none('a read-only mirror is indistinguishable again (R26)',
    /View-only — the host shared a watch link/.test(APP)
      && /return rec\.liveReadOnly \? 'view-only' : 'joined';/.test(APP)   // persistent ROW word, not just the join toast
      ? [] : ['toast + a persistent read-only word on the joined row are both required']);
  none('a hard reconnect strands the voice room again (R27)',
    /rec\.liveWasLost\) \{ try \{ liveVoice\.leave\(\); liveVoice\.join\(\)/.test(APP) && /rec\.liveWasLost = true/.test(APP) ? [] : ['loss flag + hello re-arm required']);
  none('discovery reports [] when it cannot look (R31 — "all caught up" on a machine with no gh)',
    /gh-missing/.test(DISC) && /gh-auth/.test(DISC) && /r\.reason === 'gh-auth'/.test(APP) ? [] : ['error emit + renderer reason handling required']);
  none('/clear resets a joined mirror’s tracker again (R39)',
    /'\/clear' && !\(AT\(\) && AT\(\)\.kind === 'live'\)\) resetStats\(\)/.test(APP) ? [] : ['live-tab guard on the /clear resetStats missing']);
  none('a Join badge can render on an already-joined session again (R40)',
    /!joinedTabSessionIds\(\)\.has\(s\.id\) && peersForWs\(activeWsId\)\.find/.test(APP) ? [] : ['the badge arm must consult joinedTabSessionIds']);
}

// ---------------------------------------------------------------------------------------------------------
// 34. R28/R29/R34 — the last sidebar/deps mediums. A drag re-inserts joined-suppressed ids at their old
//     positions (never silently drops them from the saved order); a non-active tree renders standalone rows
//     for live peers with no local copy; the win runner's voice row is installable (routes to
//     ensureVoiceProvisioned — every other runner already had the button).
// ---------------------------------------------------------------------------------------------------------
{
  const DEPS = read('runners/deps.js');
  none('a drag drops joined-suppressed ids from the saved order again (R28)',
    /joined\.has\(id\) && !order\.includes\(id\)\) order\.splice/.test(APP) ? [] : ['the order merge is gone']);
  none('a live peer with no local copy is invisible in a non-active tree again (R29)',
    /seenIds\.has\(p2\.session\) \|\| joined\.has\(p2\.session\)\) return; kids\.appendChild\(renderLivePeerRow\(p2\)\)/.test(APP) ? [] : ['tree standalone peer rows missing']);
  none('the packaged-win voice row lost its Install button again (R34)',
    /m\.id === 'voice' && runnerId === 'win'\) return true/.test(DEPS) ? [] : ['voice must be installable on the win runner']);
}

// ---------------------------------------------------------------------------------------------------------
// 35. PLAN USAGE (5-hour / weekly limits) is ACCOUNT-scoped, not session-scoped. Three ways it silently lies:
//
//   (a) leaking to guests. A joined mirror already receives the HOST's tracker by design (R39). Rate limits
//       are per-ACCOUNT, so mirroring them would tell a guest they've burned 65% of a limit that isn't theirs.
//       The value must never enter pushTracker.
//   (b) painting absent-as-zero. The upstream field is optional — missing for API-key/Bedrock/Vertex users and
//       until the first API response — so a missing reading must leave the gauge alone, never render a
//       reassuring green 0%.
//   (c) the epoch unit. `resets_at` is seconds; treating it as milliseconds puts every reset in 1970 and the
//       "resets at" line silently reads "any moment" forever.
// ---------------------------------------------------------------------------------------------------------
{
  none('main.js stopped forwarding rate_limits from the statusLine payload',
    /rate:\s*d\.rate_limits\s*\|\|\s*null/.test(MAIN) ? [] : ['pollStatus no longer sends d.rate_limits']);
  // (a) — scan pushTracker's body for any usage reference.
  const pt = (APP.match(/function pushTracker\([\s\S]*?\n\}/) || [''])[0];
  none('plan usage leaks into the guest mirror (a guest would see the HOST’s limits as their own)',
    pt && /_ownRate|rate_limits|\brate\b/.test(pt) ? ['pushTracker references plan-usage state'] : []);
  // (b) — the guard must sit BEFORE any DOM write in setOwnRate.
  const sor = (APP.match(/function setOwnRate\([\s\S]*?\n\}/) || [''])[0];
  const guardAt = sor.indexOf("typeof five.used_percentage !== 'number'");
  const paintAt = sor.indexOf('box.style.display');
  none('an absent usage reading paints a false 0% (the field is optional upstream)',
    guardAt >= 0 && paintAt > guardAt ? [] : ['setOwnRate writes the DOM before checking the reading exists']);
  // (c) — seconds, not milliseconds.
  none('resets_at is treated as milliseconds (every reset lands in 1970)',
    /function fmtReset[\s\S]{0,200}?sec \* 1000/.test(APP) ? [] : ['fmtReset does not convert resets_at seconds -> ms']);
  // Non-vacuity + the invariant that the battery and the number can never disagree: ONE class sets both.
  none('the battery fill and the percentage stopped sharing one severity class',
    /box\.className = 'usagebar ' \+ rateClass\(pct\)/.test(APP) && /\.ubpct\{[^}]*color:currentColor/.test(HTML)
      ? [] : ['the gauge colour and the number are no longer driven by the same class']);
  // The fill must track the SAME direction as the number (both rise with usage) — an inverted fill was the
  // "how much is left" reading we explicitly rejected, and it reads as correct until you compare the two.
  none('a nonzero usage reading can light zero cells (a used plan would look untouched)',
    /pct === 0 \? 0 : Math\.min\(4, Math\.ceil\(pct \/ 25\)\)/.test(APP) ? [] : ['the cell count is not ceil(pct/25) with an explicit 0 case']);
}

// ---------------------------------------------------------------------------------------------------------
// 36. LIVE-SHARE TRUTHFULNESS. Two silent-lie classes, both of which let the UI claim something false:
//
//   (a) A presence push that FAILS while the UI says "Sharing live". The beat used to branch only on
//       'already-live', so a dead network / revoked gh token / rate limit produced no retry and no signal —
//       the host believed they were joinable while no peer ever saw them.
//   (b) A future-dated peer stamp. `now - ts` goes negative for a forward-skewed writer, which reads as
//       "always fresh". It CANNOT be fixed by clamping (the stamp is fixed on the branch, so min(ts,now)
//       re-evaluates to age 0 forever) — the claim has to be distrusted past a tolerance, or it can refuse
//       every future claim on that session with no TTL escape.
// ---------------------------------------------------------------------------------------------------------
{
  const TOOL = read('wsl/sessions-sync-tool.js');
  // (a) the failure has to reach the user
  none('a failed presence beat is silent again (no health signal)',
    /_notePresenceHealth\(false/.test(MAIN) && /live:presence-health/.test(MAIN) ? [] : ['presenceBeatOnce no longer reports a failed push']);
  none('a failed presence beat waits a full 45s cadence again (no short retry)',
    /if \(!isRetry && advertisedSid === sid\)[\s\S]{0,200}?presenceBeatOnce\(true\)/.test(MAIN) ? [] : ['the beat has no one-shot short retry']);
  none('preload: the presence-health channel is not bridged',
    /onPresenceHealth:\s*\(cb\)\s*=>\s*ipcRenderer\.on\('live:presence-health'/.test(PRELOAD) ? [] : ['no onPresenceHealth bridge']);
  none('renderer: nothing consumes presence-health (the chip can never appear)',
    /onPresenceHealth\(/.test(APP) && /function renderPresenceWarn/.test(APP) ? [] : ['renderer does not subscribe to presence-health']);
  none('a stale "presence failing" chip outlives the share (teardown must clear it)',
    /function stopAdvertiseHeartbeat\(\)[\s\S]{0,400}?live:presence-health/.test(MAIN) ? [] : ['stopAdvertiseHeartbeat does not clear the health warning']);
  // …and it must name the RIGHT cause: blaming cloudflared for a GitHub push failure sends the user to fix
  // the wrong thing. main threads stampError; the renderer must branch on it.
  // Must assert the BRANCH, not the mere presence of the identifier: the message body also interpolates
  // stampError, so a substring check still passed with the branch itself removed (it did, on first write).
  none('the phase-1 failure toast blames cloudflared for a presence-push failure again',
    /stampError:/.test(MAIN) && /toast\(r\.stampError\s*\n?\s*\?/.test(APP) ? [] : ['the toast does not branch on r.stampError']);

  // (b) skew — REJECT past tolerance, in both the arbiter and the renderer's filter, with matching constants.
  none('the arbiter trusts a future-dated claim again (a phantom lock with no TTL escape)',
    /if \(ts > now \+ SKEW_TOL\) continue;/.test(TOOL) ? [] : ['liveHolder has no future-ts guard']);
  none('the renderer paints a future-dated peer row again',
    /\(p\.ts \|\| 0\) <= now \+ SKEW_TOL_S/.test(APP) ? [] : ['filterLivePeers has no future-ts guard']);
  // The two constants govern the same decision on two sides of the wire; drift makes the arbiter and the UI
  // disagree about who is live — exactly the class of bug the LIVE_TTL/LIVE_TTL_S pairing already guards.
  const tolTool = (TOOL.match(/const SKEW_TOL = (\d+)/) || [])[1];
  const tolApp = (APP.match(/const SKEW_TOL_S = (\d+)/) || [])[1];
  none('the skew tolerances drifted apart (arbiter vs renderer)',
    tolTool && tolApp && tolTool === tolApp ? [] : [`SKEW_TOL=${tolTool} vs SKEW_TOL_S=${tolApp}`]);

  // (c) CLOCK DOMAIN — a presence ts is stamped from the app's Electron clock (main injects CLAUDIBLE_NOW), the SAME
  // clock every reader ages a stamp with. Under the WSL runner the backend's own `date +%s` is the WSL2 guest clock,
  // which silently drifts after a host sleep/resume — a stamp written there reads minutes-stale to peers and the live
  // row vanishes until WSL re-syncs. This trio (main INJECTS → the bash stamp CONSUMES → the arbiter AGES on it) keeps
  // write and read on one time base; the WSL `date` remains ONLY as a fallback for direct/standalone CLI invocation.
  const SYNC = read('wsl/sessions-sync.sh');
  none('main no longer injects its Electron clock into presence stamps (WSL-clock drift hides live sessions)',
    MAIN.includes('CLAUDIBLE_NOW=${Math.floor(Date.now() / 1000)} ') ? [] : ['runPresence does not inject CLAUDIBLE_NOW']);
  none('the presence ts stopped reading CLAUDIBLE_NOW (falls back to the drift-prone WSL `date`)',
    SYNC.includes('now_ts="${CLAUDIBLE_NOW:-}"') && SYNC.includes('\\"ts\\":$now_ts') ? [] : ['presence-set/starting no longer stamp ts from CLAUDIBLE_NOW']);
  none('the arbiter ages claims on the WSL clock again (skew vs the Electron-stamped ts it compares)',
    TOOL.includes('const envNow = Number(process.env.CLAUDIBLE_NOW);') ? [] : ['liveHolder no longer honors CLAUDIBLE_NOW']);
}

// ---------------------------------------------------------------------------------------------------------
// 37. TWO "THE APP IS CONFIDENTLY WRONG AFTER SITTING IDLE" BUGS.
//
//   (a) The usage gauge asserted a DEAD window. status.json is written by Claude Code's statusLine, which
//       fires on spawn and on activity and NEVER on a timer — an idle tab's file was measured 375 minutes
//       untouched with a live Claude attached. So it cannot be polled fresher; the only defence is to stop
//       trusting a reading once resets_at has passed. Two separate failures fed the reported 96%-all-morning:
//       an expired reading was painted at boot, and — because main dedupes unchanged files and sends a stale
//       one exactly once — whichever tab reported LAST won, regardless of which reading was newer.
//   (b) The boot highlight guessed from raw file mtime, which any background rewrite (a sessions-sync pull)
//       bumps on a session the user never opened. `used` is NOT a fix: sessions-tool.js defines it as
//       Math.max(lastTs, act, mtime), so the mtime leaks straight back in.
// ---------------------------------------------------------------------------------------------------------
{
  none('an expired usage window is painted as if it were current',
    /if \(rateExpired\(r, Date\.now\(\)\)\) \{[^}]*renderRateStale\(\); return; \}/.test(APP) ? [] : ['setOwnRate does not reject an expired reading before painting']);
  none('nothing re-checks expiry while the app sits idle (the whole reported bug)',
    /setInterval\(\(\) => \{ if \(_ownRate && rateExpired\(_ownRate, Date\.now\(\)\)\) renderRateStale\(\); \}/.test(APP) ? [] : ['no idle re-check timer']);
  none('a stale reading can clobber a fresher one again (last-writer-wins across tabs)',
    /five\.resets_at < prev\) return;/.test(APP) ? [] : ['setOwnRate no longer prefers the newer window by resets_at']);
  // The stale state must read as UNKNOWN, not as a reassuring 0% — the limit is account-wide, so what was
  // consumed on another machine after the reset is genuinely unknowable from here.
  none('the stale gauge asserts a number instead of admitting it does not know',
    /function renderRateStale[\s\S]{0,400}?textContent = '—'/.test(APP) ? [] : ['renderRateStale does not blank the reading']);
  none('…and the popover still reports a dead window as current',
    /renderUsagePop[\s\S]{0,600}?rateExpired\(_ownRate, Date\.now\(\)\)/.test(APP) ? [] : ['the popover does not check expiry']);

  // (b) boot session restore
  none('the boot highlight guesses from raw file mtime again (a synced session steals it)',
    /const remembered = lastSessionFor\(activeWsId\);[\s\S]{0,600}?activeSession = still \? remembered :/.test(APP) ? [] : ['boot no longer prefers the remembered session']);
  none('nothing records which session you were actually in',
    /rememberLastSession\(t\.wsId \|\| activeWsId, activeSession\)/.test(APP) && /function rememberLastSession/.test(APP) ? [] : ['openSession does not remember the switch']);
  // A draft has no id to come back to; persisting it would restore you to nothing.
  none('a draft session is remembered as somewhere to restore to',
    /function rememberLastSession[\s\S]{0,300}?sessionId === 'new'\) return;/.test(APP) ? [] : ['rememberLastSession does not skip drafts']);

  // …and the TERMINAL half of the same bug, which is the one the user actually sees. The renderer's
  // activeSession only drives the sidebar highlight; which conversation the pty RESUMES is decided in
  // wsl/session.sh, because main boots the first tab with an empty session argument. That default used
  // `ls -1t` over the transcripts — raw mtime again — so a sessions-sync pull that rewrote an untouched
  // .jsonl made it win at every boot. .claudible-used/<id> (written by mark_used on every real resume) is
  // the only signal that moves when Claudible actually opens a session.
  const SESH = read('wsl/session.sh');
  none('the default resume orders by transcript mtime again (a pulled session steals the boot tab)',
    /ls -1t "\$PROJ\/\.claudible-used"/.test(SESH) ? [] : ['session.sh does not order the default resume by activation stamps']);
  none('…and the activation ordering must come BEFORE the mtime fallback, not after',
    SESH.indexOf('.claudible-used"') < SESH.indexOf('ls -1t "$PROJ"/*.jsonl') ? [] : ['the mtime scan runs first, so the stamps can never win']);
  none('a stamp whose transcript was deleted resumes a session that no longer exists',
    /\[ -f "\$PROJ\/\$cand\.jsonl" \] \|\| continue/.test(SESH) ? [] : ['no existence check on the stamped id']);
  // Non-vacuity: mark_used must actually still write the sidecar the ordering now depends on.
  none('mark_used no longer writes the activation stamp the boot ordering reads',
    /touch "\$PROJ\/\.claudible-used\/\$1"/.test(SESH) ? [] : ['mark_used does not write .claudible-used/<id>']);

  // THE DECIDING FIX. Both of the script's signals are self-polluting: transcript mtime moves when a pull
  // rewrites a conversation nobody opened, and the .claudible-used stamp is written by the auto-open itself,
  // so whatever got picked once kept re-picking itself every boot (measured: two stamps 3s apart, both from a
  // single boot). Only the renderer knows which session was genuinely being worked in — main must prefer that
  // record over letting the script guess, and the renderer must actually WRITE it on real activity rather than
  // only when a session is clicked (it did not, so the pref never existed and the whole chain was inert).
  none('main lets the script guess again instead of using the recorded session',
    /rememberedSessionFor\(ws\) \|\| ''/.test(MAIN) && /function rememberedSessionFor/.test(MAIN) ? [] : ['pty:start does not fall back to the recorded session']);
  // MUST be turn-start, not presence. Recording "the session the foreground tab is showing" cannot distinguish
  // a session you CHOSE from one that auto-opened into that tab — and for the auto-opened case those are
  // precisely the states that differ. Shipped that way once: the wrong session opened, recorded itself as
  // current, and reopened at every boot. A turn requires a prompt the user submitted, so a session nobody
  // writes in can never nominate itself.
  none('the recorded session is written from mere presence again (an auto-opened session re-nominates itself)',
    /if \(busy && t\.tabId === activeTabId\) rememberLastSession\(t\.wsId \|\| activeWsId, t\.session\)/.test(APP)
      ? [] : ['the record is not driven by turn start']);
  none('…and it must NOT also be written from onStatus, which reintroduces the loop',
    /rememberLastSession\([^)]*s\.sessionId\)/.test(APP) ? ['onStatus still records on presence'] : []);
  none('a deleted session stays recorded and keeps losing the boot race',
    /if \(remembered && !still && !rawIds\.includes\(remembered\)\) forgetLastSession\(activeWsId\)/.test(APP) && /function forgetLastSession/.test(APP) ? [] : ['a stale recorded id is never cleared']);
  // main interpolates this id into a shell command via spawnPty -> session.sh, so it must be charset-gated.
  none('the recorded session id reaches the shell without a charset gate',
    /function rememberedSessionFor[\s\S]{0,300}?\/\^\[A-Za-z0-9-\]\+\$\/\.test\(id\)/.test(MAIN) ? [] : ['rememberedSessionFor does not validate the id']);
}

// ---------------------------------------------------------------------------------------------------------
// 38. TOP-BAR / LIVE-ROW PRESENTATION INVARIANTS.
//   · ONE live state. "going live · <name>" and "live · <name>" overflowed a one-line session row, and the
//     two-state vocabulary made a ~3-second transition look like a status the reader had to learn.
//   · The usage gauge must be up at LAUNCH like context and tokens. Claude Code reports rate_limits only
//     "after the first API response", so a freshly spawned status.json has none and the box stayed hidden
//     until the user typed.
//   · Every top-bar control shares one height. The icon buttons were 29px (6+6 padding + a 15px glyph) next
//     to 31px voice/telemetry boxes, so the row sat unevenly.
// ---------------------------------------------------------------------------------------------------------
{
  const styleBlk2 = (HTML.match(/<style>[\s\S]*?<\/style>/) || [''])[0];
  none('the live badge shows the peer name again (it never fit the one-line row)',
    /textContent = 'live · ' \+ who|textContent = 'going live · ' \+ who/.test(APP) ? ['makeLiveBadge still interpolates the host name'] : []);
  // 3a merged the two badge branches into ONE builder, so "both phases render the same word" stopped being a
  // thing to check by counting two identical string literals and became true by construction. The assertion is
  // now stronger, not weaker: there is a single `liw` label, and the separate inert `.sess-starting` span that
  // could have drifted from it is gone entirely. Both phases are the same <button class="sess-join">, which is
  // also what makes the "Join →" hover rule (index.html) apply while the host is still spinning up.
  none('…and both presence phases must render the SAME word',
    (APP.match(/liw\.textContent = 'live';/g) || []).length === 1
      && !/sess-live-ind sess-starting/.test(APP)
      ? [] : ['the two presence phases no longer share one badge builder']);
  none('a phase-1 (going-live) row is inert again — the click that used to do nothing',
    /const b = document\.createElement\('button'\); b\.className = 'sess-live-ind sess-join';\s*\n\s*if \(peer\.starting\) b\.style\.opacity/.test(APP)
      ? [] : ['makeLiveBadge no longer builds a joinable button for peer.starting']);
  none('hovering a joinable live row no longer offers Join',
    /jx\.textContent = 'Join →'/.test(APP) ? [] : ['the joinx hover affordance is gone']);

  // Must pin the RESTORE block, not the identifier: `loadPrefs().lastRate` also appears in the write-on-change
  // check inside setOwnRate, so a loose match passed with the restore deleted (it did, on first write).
  none('the usage gauge is hidden at launch again (nothing replays the last reading)',
    /cached = loadPrefs\(\)\.lastRate/.test(APP) && /savePrefs\(\{ lastRate: r \}\)/.test(APP)
      ? [] : ['no launch restore for the usage gauge']);
  // The restore sits ABOVE `const PREFS_KEY`, so running it during module evaluation throws a temporal-dead-zone
  // ReferenceError on every launch. It shipped that way and an empty catch hid it: the gauge never appeared and
  // nothing reported why. It must stay deferred past module evaluation, and must never swallow the failure.
  none('the launch restore runs during module evaluation again (TDZ: it is above PREFS_KEY)',
    /setTimeout\(\(\) => \{\s*\n\s*if \(_ownRate\) return;[\s\S]{0,600}?loadPrefs\(\)\.lastRate/.test(APP)
      ? [] : ['the restore is not deferred to a macrotask']);
  none('…and a failing restore is silent again (an empty catch is why this took a rebuild to find)',
    /catch \(e\) \{ console\.error\('\[claudible\] usage cache unreadable:'/.test(APP) ? [] : ['the restore swallows its error']);
  none('…and the cache can overwrite a fresher live reading',
    /setTimeout\(\(\) => \{\s*\n\s*if \(_ownRate\) return;/.test(APP) ? [] : ['the deferred restore does not yield to a real status']);
  // …and the replay must respect expiry, or launch resurrects yesterday's number — the exact bug we just fixed.
  none('the launch replay resurrects an expired window',
    /if \(rateExpired\(cached, Date\.now\(\)\)\) \{ _ownRate = cached; renderRateStale\(\); \} else setOwnRate\(cached\)/.test(APP)
      ? [] : ['the cached reading is replayed without an expiry check']);
  // Status arrives every turn; persisting an identical blob each time would be a disk write per message.
  none('the usage cache is rewritten on every status (a disk write per message)',
    /cf\.used_percentage !== five\.used_percentage \|\| cf\.resets_at !== five\.resets_at\) savePrefs/.test(APP)
      ? [] : ['lastRate is saved unconditionally']);

  // One height across the bar controls. 31px is set by .ctxbar/.tokbar/.vbox; .iconbtn must match.
  // .usagebar is DELIBERATELY out of this set now: it is a 26px ring, not a box. It left the row of labelled
  // controls when usage moved to the far right of the cockpit as a dial, so holding it to the box height would
  // pin a shape it no longer has. Its own size is asserted separately below.
  const h = (re) => { const m = styleBlk2.match(re); return m ? m[1] : null; };
  const heights = {
    iconbtn: h(/\.iconbtn\{[^}]*height:(\d+)px/), vbox: h(/\.vbox\{[^}]*height:(\d+)px/),
    ctxbar: h(/\.ctxbar\{[^}]*height:(\d+)px/), tokbar: h(/\.tokbar\{[^}]*height:(\d+)px/),
  };
  const odd = Object.entries(heights).filter(([, v]) => v !== '31').map(([k, v]) => `${k}=${v}`);
  none('the top-bar controls drifted off one shared height', odd);
  // The ring must stay square and stay driven by --u-pct, or it silently becomes a lozenge / a full circle.
  none('the usage ring lost its circular geometry or its percentage source',
    /\.usagebar\{[^}]*width:26px[^}]*height:26px[^}]*border-radius:50%/.test(styleBlk2)
      && /conic-gradient\(currentColor calc\(var\(--u-pct/.test(styleBlk2)
      && /setProperty\('--u-pct'/.test(APP)
      ? [] : ['.usagebar is no longer a --u-pct-driven circle']);
  // …and one shared rhythm: the voice group must space like the icon buttons, not as a detached cluster.
  // The group MOVED to the cockpit row at the bottom of the shell, so the parent named here moved with it —
  // the rule being defended is unchanged (one 6px rhythm, no detached cluster), only its address.
  none('the voice group spaces differently from the icon buttons again',
    /\.vgroup\{[^}]*gap:6px/.test(styleBlk2) && /\.cockpit>\.vgroup\{margin-left:0\}/.test(styleBlk2)
      ? [] : ['.vgroup gap / margin no longer matches .topbtns']);
  // The cockpit row is the voice + telemetry home now; if either group drifts back upstairs, say so.
  none('voice or telemetry drifted back into the top bar',
    /<div class="status cockpit">/.test(HTML) && !/<div class="top">[\s\S]*?class="(vgroup|trk)"[\s\S]*?<\/div>\s*<div class="body/.test(HTML)
      ? [] : ['.vgroup/.trk is back inside .top, or .status lost its cockpit class']);

  // The palette trigger moved to the terminal corner; wherever it lives it must still be wired.
  none('the command-palette trigger lost its click handler in the move',
    /\$\('cmdk-btn'\)\.addEventListener\('click'/.test(APP) && /id="cmdk-btn"/.test(HTML) ? [] : ['cmdk-btn is unbound or missing']);
  none('…and it must not overlap the git tab it sits beside',
    /\.termtab\.cmdk-tab\{right:(\d+)px\}/.test(styleBlk2) && Number((styleBlk2.match(/\.termtab\.cmdk-tab\{right:(\d+)px\}/) || [])[1]) >= 44
      ? [] : ['cmdk-tab is not clear of the git tab (16px icon + 18px padding + 2px border + 8px offset = 44)']);
}

// ---------------------------------------------------------------------------------------------------------
// 39. THE COMMAND PALETTE IS CLAUDE CODE'S COMMAND LIST — nothing else.
//   App actions (Settings, Project History, New session, Share) live in the top bar and sidebar; mixing them
//   in made the palette a grab-bag rather than "the terminal's commands". The list is transcribed from the
//   INSTALLED build's own registry, so entries must stay slash-prefixed and carry no click handlers.
// ---------------------------------------------------------------------------------------------------------
{
  const items = (APP.match(/const CMDK_ITEMS = \[[\s\S]*?\n\];/) || [''])[0];
  const names = [...items.matchAll(/name: '([^']+)'/g)].map((m) => m[1]);
  none('the palette lists a non-slash entry (app actions belong in the chrome, not here)',
    names.filter((n) => !n.startsWith('/')));
  none('a palette entry carries a click handler again (it should only ever type into the terminal)',
    /act:\s*\(\)/.test(items) ? ['CMDK_ITEMS contains an act() entry'] : []);
  none('cmdkRun can still invoke an app action instead of sending the command',
    /function cmdkRun[\s\S]{0,200}?it\.act/.test(APP) ? ['cmdkRun still branches on it.act'] : []);
  none('the palette shrank to a token list (it should cover the installed command surface)',
    names.length >= 40 ? [] : [`only ${names.length} commands listed`]);
  none('duplicate commands in the palette', (() => {
    const seen = new Set(), dup = [];
    names.forEach((n) => (seen.has(n) ? dup.push(n) : seen.add(n)));
    return dup;
  })());
  // Anchored to its trigger, not centred: the trigger sits in the terminal's bottom-right corner, so a
  // screen-centre panel made the eye travel the whole window for a control just clicked.
  none('the palette centres on the window again instead of opening at its trigger',
    /function placeCmdk[\s\S]{0,400}?getBoundingClientRect/.test(APP) && /if \(on\) \{ placeCmdk\(\);/.test(APP)
      ? [] : ['placeCmdk is missing or never called on open']);
  // The stylesheet must NOT re-add translateX(-50%): it would fight the measured left placeCmdk sets.
  none('the centring transform is back, fighting the measured position',
    /\.cmdk\.show\{[^}]*translateX\(-50%\)/.test(HTML) ? ['.cmdk.show still applies translateX(-50%)'] : []);
  // Anchoring by `bottom` must also RELEASE `top`, and release it to 'auto' rather than ''. Clearing an inline
  // value falls back to the stylesheet's top:18vh, and a box pinned at both edges stretches to span them —
  // which renders as dead space under the list. Exactly the trap the toast hit; caught here a second time.
  none('the palette pins top AND bottom again (it stretches, leaving dead space below the list)',
    /box\.style\.top = 'auto';/.test(APP) ? [] : ["placeCmdk does not release top to 'auto'"]);
  // The voice labels were --ink-faint on the box background: 2.85:1, below even the 3:1 large-text floor.
  none('the Talk/Read labels faded back to near-invisible',
    /\.vbox \.vstat\{[^}]*color:var\(--ink-dim\)/.test(HTML) ? [] : ['.vbox .vstat is not --ink-dim']);
  // …while the glyphs must still match the icon buttons beside them.
  none('the voice glyphs outshine the icon buttons they sit beside',
    /\.vbox\{[^}]*color:var\(--ink-dim\)/.test(HTML) ? [] : ['.vbox base colour no longer matches .iconbtn']);
}

// ---------------------------------------------------------------------------------------------------------
// 40. A LIVE LINK DIES WITH THE PROCESS — say so, and clean up after yourself.
//   A trycloudflare URL is single-use and cloudflared is killed on exit, so a link already pasted to a
//   collaborator is dead the instant the app restarts. That failed silently: both ends saw a bare connection
//   error with nothing to explain it. An app self-update is enough to trigger it.
// ---------------------------------------------------------------------------------------------------------
{
  none('a live link dies on exit with nothing recorded, so the next boot cannot explain it',
    /share\.status\(\)\.running\) writeSettings\(Object\.assign\(readSettings\(\), \{ shareEndedByExit/.test(MAIN)
      ? [] : ['the exit path does not record that a live share was running']);
  none('…and nothing tells the user on the way back in',
    /shareEndedByExit/.test(APP) && /trycloudflare links are single-use/.test(APP) ? [] : ['no boot notice for a share killed by restart']);
  none('…and the notice must fire once, not on every boot',
    /savePrefs\(\{ shareEndedByExit: 0 \}\)/.test(APP) ? [] : ['the notice never clears its flag']);
  // The runner must be able to confirm a detached child actually reached the OS — the whole quit-path fix
  // rests on it, and all three backends implement one contract.
  const runners = ['runners/wsl.js', 'runners/win.js', 'runners/posix.js'];
  none('a runner cannot confirm a detached spawn reached the OS',
    runners.filter((f) => !/child\.once\('spawn', \(\) => \{ try \{ opts\.onSpawn\(\)/.test(read(f))));
}

// ---------------------------------------------------------------------------------------------------------
// 41. A TUNNEL-LESS SHARE MUST NOT LOOK LIKE A WORKING ONE.
//   share:start deliberately returns ok:true with a 127.0.0.1 URL when cloudflared fails — a local link is
//   genuinely useful on your own machine. But 127.0.0.1 means "this computer" to whoever opens it, so a
//   collaborator gets only "site can't be reached". The standing chip sits at the bottom of the sidebar,
//   easy to miss at exactly the moment you are copying a link to send someone.
// ---------------------------------------------------------------------------------------------------------
{
  const CF = read('share/cloudflared.js');
  none('a degraded (local-only) share is silent again',
    /r\.remote === false\)\s*\{[\s\S]{0,400}?only works on THIS machine/.test(APP)
      ? [] : ['nothing tells the user the link is local-only at the moment it happens']);
  // The .msi installs to Program Files, not %LOCALAPPDATA%, so the winget shortcut never covered it and the
  // lookup fell through to a bare PATH spawn — which uses the PATH Electron inherited AT LAUNCH. Installing
  // cloudflared while the app is open then fails with ENOENT even though `where cloudflared` finds it.
  none('the cloudflared lookup trusts PATH alone for a Program Files install',
    /ProgramFiles\(x86\)/.test(CF) && /'cloudflared', 'cloudflared\.exe'/.test(CF)
      ? [] : ['candidates() does not check the .msi install locations explicitly']);
  none('…and the explicit paths must be tried BEFORE the bare PATH lookup',
    CF.indexOf("ProgramFiles(x86)") < CF.indexOf("list.push('cloudflared.exe'")
      ? [] : ['the PATH fallback is ordered ahead of the deterministic paths']);
}

// ---------------------------------------------------------------------------------------------------------
// 42. A LINK IS NOT LIVE UNTIL IT HAS BEEN PROVEN LIVE — AND PROVING IT MUST NOT POISON DNS.
//   MEASURED: cloudflared prints the URL at +5.5s, registers at +6.3s, but the A record only exists at +8.7s.
//   The app used to reveal the link at registration, so the host's own test click landed in that gap and got
//   NXDOMAIN — which trycloudflare.com's SOA pins in the resolver's negative cache for 1800s. Half an hour of
//   "site can't be reached", surviving every fresh link, for host and guest alike. Hence: verify before
//   revealing, and verify against the AUTHORITATIVE nameservers (which never cache) before ever asking the
//   system resolver, so the check itself can never be what poisons the cache.
// ---------------------------------------------------------------------------------------------------------
{
  const CF = read('share/cloudflared.js');
  const SRV = read('share/server.js');
  none('startCloudflared hands back a URL it never checked',
    /const v = await verifyTunnel\(got\.url, opts\);/.test(CF) && /got\.verify = Object\.assign\(\{ confirmed \}, v\);/.test(CF)
      ? [] : ['startCloudflared does not gate its return on verifyTunnel']);
  none('…and an unprovable tunnel is left running to be handed out',
    /if \(!v\.ok \|\| \(!got\.registered && !confirmed\)\) \{\s*\n\s*try \{ got\.proc\.kill\(\); \} catch \{\}/.test(CF)
      ? [] : ['a rejected tunnel is not reaped']);
  none('the check asks the system resolver before the authoritative one (it would cache the NXDOMAIN itself)',
    CF.indexOf('const d = await awaitDnsRecord(') < CF.indexOf('last = await probeOnce(url,')
      ? [] : ['the HTTPS probe is ordered ahead of the poison-free authoritative check']);
  none('the authoritative check is not actually authoritative',
    /resolveNs\(zoneOf\(host\)\)/.test(CF) && /r\.setServers\(servers\)/.test(CF)
      ? [] : ['awaitDnsRecord does not query the zone nameservers directly']);
  // "We could not ask" and "we asked and the record is absent" are different facts. Conflating them condemns a
  // working tunnel on any network that blocks outbound port 53.
  none('an unreachable nameserver is treated as a missing DNS record',
    /if \(!d\.ok && !d\.unavailable\) return \{ ok: false, published: false, stage: 'dns'/.test(CF)
      ? [] : ['a blocked authoritative lookup fails the whole verification']);
  // The inverse of the bug: record published, but THIS machine is still poisoned from an earlier click. The
  // link is fine for guests — condemning it would be the same false report in the other direction.
  // The old special-case branch is gone because the GENERAL rule now subsumes it: an unreachable probe never
  // condemns a link (it only lowers confidence); ONLY a cache-free "no such record" does.
  none('a stale LOCAL cache condemns a link that works for everyone else',
    /return \{ ok: true, published: !!d\.ok, reachable: false/.test(CF)
      && /this machine cannot resolve it yet/.test(CF)
      ? [] : ['an unreachable probe still condemns a published tunnel']);
  none('…and the host is never told why their own link will not open here',
    /r\.localDns === false\)/.test(APP) && /flushdns/.test(APP)
      ? [] : ['nothing explains the stale-cache case to the host']);
  // The probe proves OUR server answered, not merely that something did — a Cloudflare edge error page is a
  // perfectly valid HTTP response from a route that reaches nothing.
  none('the probe accepts any HTTP answer as proof the share is reachable',
    /String\(res\.headers\[PROBE_HEADER\] \|\| ''\) === '1'/.test(CF)
      ? [] : ['probeOnce does not require the Claudible marker header']);
  none('…and the server does not emit that marker on every response',
    /res\.setHeader\('X-Claudible-Share', '1'\);/.test(SRV)
      ? [] : ['share/server.js never sets the marker header']);
  // Token-free by construction: a probe that carried ?t= would burn the one-time link the host is about to send.
  none('the probe spends the host’s one-time token',
    /probeOnce\(url, /.test(CF) && !/probeOnce\([^)]*\?t=/.test(CF)
      ? [] : ['the reachability probe appends a link token']);
  // Every way a share can die must name itself in the journal, or the next failure is as blind as this one was.
  const deaths = [
    ['the tunnel process exiting', /share: cloudflared EXIT code=/],
    ['an explicit share:stop', /share: STOP via share:stop IPC/],
    ['closing the pinned tab', /share: FORCE-END — the pinned tab/],
    ['deleting the pinned tab’s project', /share: FORCE-END — the project owning the pinned tab/],
    ['the self-heal retry', /share: tunnel retry firing on port/],
  ];
  none('a share dies leaving nothing in the journal to say what killed it',
    deaths.filter(([, re]) => !re.test(MAIN)).map(([w]) => w));
}

// ---------------------------------------------------------------------------------------------------------
// 43. THE PINNED TAB MUST BE VISIBLE, AND KILLING IT MUST NAME WHAT DIES.
//   share:start pins whatever tab was in the foreground — for a plain "Share a live link" exactly as for a
//   session share, though nothing in that UI says a tab is involved. main tears the share down when that tab
//   closes or its project is deleted; the renderer's guards must say so FIRST, in terms of the link already
//   sitting in someone else's chat window. isSharingSession() only ever covered the sharedSessionId path.
// ---------------------------------------------------------------------------------------------------------
{
  const SRV = read('share/server.js');
  none('a web share leaves no mark on the row that carries the link',
    /function isWebSharePinnedTo\(id\)/.test(APP) && /isWebSharePinnedTo\(s\.id\)/.test(APP)
      ? [] : ['nothing marks the session row a web share is pinned to']);
  // Two independent row renderers (active list + expanded non-active tree). Marking one and not the other is
  // how the indicator silently vanishes depending on which project you happen to be looking at.
  none('only one of the two session-row renderers marks the pinned row',
    (APP.match(/isWebSharePinnedTo\(s\.id\)/g) || []).length >= 2
      ? [] : ['the expanded-tree row renderer does not mark the pinned session']);
  none('…and the marker never appears until some unrelated repaint',
    /onSharePinned\(\(p\) => \{[^}]*refreshSessions\(\)/.test(APP) ? [] : ['pinning does not repaint the sidebar']);
  none('closing the pinned tab does not mention the link that dies with it',
    /This tab carries your live link[\s\S]{0,300}?STOPS WORKING/.test(APP)
      ? [] : ['the close confirm never names the public link']);
  none('deleting the pinned tab’s project does not mention live sharing at all',
    // C-3.6 replaced the single deleteWsPrompt() string with the confirmDeleteWorkspace() modal flow; the
    // live-share warning moved into its own shared helper (liveShareWarnSuffix), appended in every branch.
    /function liveShareWarnSuffix\(w\)[\s\S]{0,300}?liveShareLivesInWs\(w\.id\)/.test(APP)
      && (APP.match(/liveShareWarnSuffix\(w\)/g) || []).length >= 4   // definition + all 3 confirmDeleteWorkspace body branches
      ? [] : ['confirmDeleteWorkspace has no live-share warning, or a branch stopped appending it']);
  // The only auth path that never reaches guest.js, so no error card of its own can explain it.
  none('a revoked link still renders as an unstyled one-word page',
    /res\.writeHead\(403, \{ 'Content-Type': 'text\/html/.test(SRV) && /DENIED_HTML/.test(SRV)
      ? [] : ['the 403 has no Content-Type or no body worth reading']);
  none('…and that page pulls assets it is not authorized to fetch',
    /const DENIED_HTML = `<!doctype html>/.test(SRV) && !/DENIED_HTML[\s\S]{0,1400}?<(script|link)\b/.test(SRV)
      ? [] : ['the denied page references an external asset']);
}

// ---------------------------------------------------------------------------------------------------------
// 44. SAFE-BY-DEFAULT SHARING. Co-drive lets an approved guest type into the host pty (share/server.js gates
//   only on readOnly), which is a shell on the host's machine. The dangerous mode must be opt-IN: view-only
//   defaults on, and the share dialog must say — in red, scaling with the toggle — what turning it off means.
// ---------------------------------------------------------------------------------------------------------
{
  none('view-only is not on by default (co-drive is the accidental default)',
    /<input type="checkbox" id="share-ro" checked\s*\/?>/.test(HTML)
      ? [] : ['#share-ro has no `checked` — a fresh share is co-drive']);
  none('the share dialog carries no security warning',
    /id="share-warn"/.test(HTML) && /function renderShareWarn\(\)/.test(APP)
      ? [] : ['no security note element or no renderer for it']);
  none('the warning does not escalate when co-drive is chosen',
    /box\.classList\.toggle\('danger', !ro\)/.test(APP)
      ? [] : ['renderShareWarn does not turn red when view-only is off']);
  none('…and the danger copy never names the actual risk',
    /can run commands on your computer/.test(APP) ? [] : ['the co-drive warning does not say what co-drive grants']);
  none('…and never points at the safer GitHub path',
    /invite them to the repo on GitHub/.test(APP) ? [] : ['no soft pointer to the repo-collaborator flow']);
  none('the warning is painted before the dialog opens AND on every toggle',
    /renderShareWarn\(\);\s*\/\/ paint the security note/.test(APP) && /\$\('share-ro'\)[\s\S]{0,120}?addEventListener\('change', renderShareWarn\)/.test(APP)
      ? [] : ['the warning is not wired to open + change']);
}

// ---------------------------------------------------------------------------------------------------------
// 45. A LIVE LINK SHARES ONE SESSION — NOT THE WHOLE HISTORY — AND A GUEST CAN LEAVE CLEANLY.
//   The guest browser had a "Browse sessions" panel that walked every granted project's saved conversations
//   and transcripts. That's the repo's history, not the one live session. Removing the BUTTON is not enough:
//   the server must stop answering the frames, or a link holder crafts them by hand. And a guest had no clean
//   exit — closing the tab just dropped the socket. Now: Disconnect in the bar → a final blurred end card.
// ---------------------------------------------------------------------------------------------------------
{
  const SRV = read('share/server.js');
  none('the guest can still open a read-only session/history browser',
    !/id="browse-open"/.test(GUEST_HTML) && !/class="browse"/.test(GUEST_HTML)
      ? [] : ['the Browse-sessions button or panel is still in guest.html']);
  none('the server still answers the history-browsing frames (button removal is not the gate)',
    !/msg\.type === 'ws-sessions'/.test(SRV) && !/msg\.type === 'ws-transcript'/.test(SRV)
      ? [] : ['share/server.js still handles ws-sessions/ws-transcript']);
  none('…and main still wires the browse callbacks that feed them',
    !/onBrowseSessions:/.test(MAIN) && !/onBrowseTranscript:/.test(MAIN)
      ? [] : ['main.js still implements onBrowseSessions/onBrowseTranscript']);
  none('the guest has no Disconnect control',
    /id="disconnect-btn"/.test(GUEST_HTML) && /addEventListener\('click', doDisconnect\)/.test(GUEST_JS)
      ? [] : ['no Disconnect button, or it is not wired to doDisconnect']);
  // Bound widened 320 → 560 for B15: doDisconnect now also sends the `leave` frame and clears the stored
  // resume token before ending, which is ~90 chars of real work. The bound exists to keep the match INSIDE
  // this function (so showEnded can't be satisfied by a later one) — not to cap the body — so widening it to
  // just past the current length preserves the guard. Re-measure before widening again.
  none('Disconnect does not reach a final, no-reconnect state',
    /function doDisconnect\(\)[\s\S]{0,560}?showEnded\('left'\)/.test(GUEST_JS) && /function showEnded\(kind\)/.test(GUEST_JS)
      ? [] : ['doDisconnect does not enter the terminal end state']);
  // …and the explicit leave must actually revoke, on BOTH ends (B15). Server: a `leave` frame retires the
  // resume token and marks the socket so drop() grants no grace. Guest: the stored token is cleared, so the
  // end card's Rejoin button cannot re-enter on an approval the host never gave again.
  none('an explicit guest Disconnect can silently rejoin within the grace window again',
    [/msg\.type === 'leave'/.test(read('share/server.js')) ? '' : 'server has no leave-frame handler',
     /resumeTokens\.delete\(ws\._resume\); ws\._resume = null;[\s\S]{0,120}?_left = true/.test(read('share/server.js')) ? '' : 'leave does not retire the token + skip the grace window',
     /if \(tok && !ws\._kicked && !ws\._left\)/.test(read('share/server.js')) ? '' : 'an explicit leave no longer skips the grace window',
     /systemChat\(who \+ \(ws\._kicked \?/.test(read('share/server.js')) ? '' : 'the "removed by the host" line is no longer gated on a REAL kick — a voluntary Disconnect must not claim the host removed them',
     /sessionStorage\.removeItem\(STORE_KEY\)/.test(GUEST_JS) ? '' : 'guest keeps its resume token after leaving'].filter(Boolean));
  none('…and a left guest can still be dragged back by the reconnect loop',
    /ws\.onclose = function \(ev\) \{\s*\n\s*if \(left\) return;/.test(GUEST_JS) && /function reconnect\(label\) \{\s*\n\s*if \(left\) return;/.test(GUEST_JS)
      ? [] : ['onclose/reconnect do not honor the left flag']);
  none('a host that stops sharing loops "retrying…" forever instead of ending',
    /if \(wasAdmitted && \+\+reconnTries >= 6\) \{ showEnded\('ended'\)/.test(GUEST_JS)
      ? [] : ['no terminal end state when the host is gone for good']);
  none('the end card offers no way back',
    /id="ov-rejoin"/.test(GUEST_HTML) && /getElementById|\$\('ov-rejoin'\)/.test(GUEST_JS) && /location\.reload\(\)/.test(GUEST_JS)
      ? [] : ['no Rejoin affordance on the end card']);
}

// ---------------------------------------------------------------------------------------------------------
// 46. SESSION-NAME TRUNCATION IS PIXEL-ACCURATE, NOT A GUESS. The row was an absolute meta cluster over a
//   title padded by fixed :has() reserves (30/52/72/78px). When timestamp + author + out-of-sync all showed,
//   the cluster overran the reserve and squished the timestamp. Now it's a flexbox (title flex:1 min-width:0,
//   meta flex:none) — the same pattern .ws-chip already uses — so the name ellipsizes to exactly what's left.
// ---------------------------------------------------------------------------------------------------------
{
  const flat = HTML.replace(/\s*\n\s*/g, '');
  none('the session row is not a flex layout (name can still overrun the meta)',
    /\.sess\{[^}]*display:flex;align-items:center/.test(flat) ? [] : ['.sess is not display:flex']);
  none('the title does not flex-shrink to ellipsis (it needs flex:1 + min-width:0)',
    /\.sess-prev\{[^}]*flex:1;min-width:0[^}]*text-overflow:ellipsis/.test(flat) ? [] : ['.sess-prev is not a flex:1 min-width:0 ellipsis']);
  none('the meta cluster is still absolutely positioned (the old overlap bug)',
    /\.sess-meta\{[^}]*flex:none/.test(flat) && !/\.sess-meta\{[^}]*position:absolute/.test(flat)
      ? [] : ['.sess-meta is not a flex:none in-flow cluster']);
  none('the fixed :has() padding guesses are still present (they undercount the real cluster)',
    !/\.sess:has\(\.sess-flair:not\(\.author\)\) \.sess-prev\{padding-right/.test(flat) && !/\.sess:has\(\.sess-live-ind\) \.sess-prev\{padding-right/.test(flat)
      ? [] : ['the old per-row padding-right reserves were left behind']);
  none('a long peer-live line can starve the title (no cap on the timestamp width)',
    /\.sess-meta-t\{[^}]*max-width:\d/.test(flat) ? [] : ['.sess-meta-t has no max-width bound']);
}

// ---------------------------------------------------------------------------------------------------------
// 47. SHARE UI, TIDIED. The guest page dropped the redundant projects strip (a live link streams ONE session)
//   and moved Disconnect into the voice bar; the main-app share dock dropped the "share live" label + the dead
//   status dot and folded the icon into the button. Two real traps guarded here: Disconnect must not disappear
//   when voice is unavailable, and webShareUI must not wipe the button's icon by setting textContent.
// ---------------------------------------------------------------------------------------------------------
{
  // GUEST — the projects strip is gone, Disconnect lives in the voice bar.
  none('the redundant guest projects bar is still present',
    !/id="wsbar"/.test(GUEST_HTML) && !/class="wschip"/.test(GUEST_HTML) ? [] : ['the guest wsbar/wschip markup survives']);
  none('Disconnect is not in the voice bar next to Join voice',
    /id="voicebar"[\s\S]*?id="voice-btn"[\s\S]*?id="disconnect-btn"[\s\S]*?<\/div>/.test(GUEST_HTML)
      ? [] : ['#disconnect-btn is not inside #voicebar after #voice-btn']);
  none('an unavailable voice feature hides Disconnect along with the whole bar',
    /function hideVoiceControls\(\)[\s\S]*?'voice-btn'/.test(GUEST_JS) && !/voicebar["']\)[\s\S]{0,50}?display\s*=\s*["']none["']/.test(GUEST_JS)
      ? [] : ['voice-unavailable hides #voicebar (taking Disconnect with it), or hideVoiceControls does not target the voice controls']);
  none('the guest grid still reserves a row for the removed projects strip',
    /grid-template-rows:52px 1fr 22px/.test(GUEST_HTML) ? [] : ['guest body grid still has the workspaces row']);
  // MAIN APP — the share dock is tidied.
  none('the redundant "share live" label or dead status dot is still in the dock',
    !/class="sl-text"/.test(HTML) && !/id="d-share"/.test(HTML) ? [] : ['sl-text or #d-share survives in the share dock']);
  none('the share icon was not folded into the button',
    /id="share-btn"[^>]*>\s*<svg class="ico"[\s\S]*?id="sb-label"/.test(HTML) ? [] : ['#share-btn has no leading icon + #sb-label span']);
  none('webShareUI wipes the button icon by setting shareBtn.textContent',
    /\$\('sb-label'\)[\s\S]{0,120}?textContent = on/.test(APP) && !/shareBtn\.textContent/.test(APP)
      ? [] : ['webShareUI still sets shareBtn.textContent (nuking the icon) instead of the label span']);
}

// ---------------------------------------------------------------------------------------------------------
// 48. THE SHARE CTA AND ITS INFO POPOVER.
//   The "i" gave up its own row (~27px for one glyph) and now rides the button's right edge. The button wears a
//   low-chroma green wash as the sidebar's primary action. THE TRAP: every rest-state rule must be scoped
//   :not(.live), or it overrides the generic button.live red and "Stop sharing" silently stays green — which is
//   exactly what the first draft did, caught only by rendering both states side by side.
// ---------------------------------------------------------------------------------------------------------
{
  const flat = HTML.replace(/\s*\n\s*/g, '');
  // OWNER REVERSAL 2026-08-19. The three pins that used to live here guarded the OPPOSITE layout: the "i" as a
  // sibling absolutely positioned over the button's right rim, with a 38px right-side reserve so the label could
  // not collide with it. That geometry centred icon+label in the full box and then hung the badge off the rim,
  // so the three read as one cluster sitting left of centre — the owner's complaint. The badge is now the
  // button's last flex child and the box is symmetric, which centres all three at any label width with no
  // measured offsets to re-derive. The overlay was retired deliberately; it was not lost in a refactor.
  // Adjacency, not "appears somewhere after": a lazy [\s\S]*? would happily match a share-info that had been
  // moved back OUTSIDE the button, because it would just run on to the next </button> in the file.
  none('the "i" fell back out of the button into its own element (the cluster goes off-centre again)',
    /id="sb-label">[^<]*<\/span><span class="ws-info" id="share-info"[^>]*>i<\/span><\/button>/.test(HTML)
      ? [] : ['#share-info is not the last child INSIDE #share-btn, directly after #sb-label']);
  none('…and it is back to being a <button> (a button may not contain a button)',
    /<span class="ws-info" id="share-info" role="button" tabindex="0"/.test(HTML)
      ? [] : ['#share-info is not a <span role="button" tabindex="0">']);
  none('…so it needs its own keyboard activation, and both handlers must stop the bubble to the share action',
    /\$\('share-info'\)[\s\S]{0,600}?addEventListener\('keydown'[\s\S]{0,300}?stopPropagation\(\)[\s\S]{0,120}?openShareInfo\(\)/.test(APP)
      && /\$\('share-info'\)[\s\S]{0,400}?addEventListener\('click', \(e\) => \{ e\.stopPropagation\(\)/.test(APP)
      ? [] : ['the share-info badge lost its keydown activation or a stopPropagation guard']);
  // The reserve is gone WITH the overlay: an uneven box would push the cluster off centre, which is the whole
  // defect this replaced. The ellipsis guard below stays — monospace metrics still differ per machine.
  none('an asymmetric padding reserve came back (it re-creates the off-centre cluster)',
    /\.share-btn\{[^}]*padding-left:14px;padding-right:14px/.test(flat) && /\.share-btn\{[^}]*letter-spacing:\.02em/.test(flat)
      ? [] : ['.share-btn padding is not symmetric, or the width-saving tracking was reverted']);
  none('…and the label cannot ellipsize, so a wider mono face would collide again',
    /\.sb-label\{[^}]*text-overflow:ellipsis/.test(flat) ? [] : ['.sb-label has no ellipsis guard']);
  // THE ONE THAT MATTERS: an unscoped rest style silently kills the red stop state.
  none('the share button’s rest styling is not :not(.live)-scoped (Stop sharing would stay green)',
    /\.share-btn:not\(\.live\)\{[^}]*background:linear-gradient/.test(flat) && !/\.share-btn\{[^}]*background/.test(flat)
      ? [] : ['a rest-state background is applied unscoped and will override button.live']);
  none('…and the live stop state lost its own red treatment',
    /button\.live\{[^}]*border-color:var\(--live\)/.test(flat) && /\.share-btn\.live \.ico\{[^}]*color:var\(--live\)/.test(flat)
      ? [] : ['the live/stop styling is gone']);
  none('the accent glow is on at rest (it would compete with the live state’s glow)',
    /\.share-btn:not\(\.live\):hover\{[^}]*box-shadow/.test(flat) && !/\.share-btn:not\(\.live\)\{[^}]*box-shadow/.test(flat)
      ? [] : ['the glow is not hover-only']);
  // Popover: bigger + ranked, not three equal paragraphs.
  none('the share popover is not sized up (262px / +5% body)',
    /\.ws-info-pop\.sharepop\{[^}]*width:262px[^}]*font-size:calc\(var\(--fs-sm\) \* 1\.05\)/.test(flat)
      ? [] : ['.sharepop is missing its wider width or +5% font size']);
  none('…and its title has no hierarchy over the body',
    /\.sharepop \.wt\{[^}]*font-size:var\(--fs-md\)/.test(flat) ? [] : ['the popover title is not stepped up to --fs-md']);
  none('the popover content is back to undifferentiated paragraphs',
    /class="sip-lead"/.test(APP) && /class="sip-rows"/.test(APP) && /class="sip-foot"/.test(APP)
      ? [] : ['openShareInfo no longer builds lead / rows / footer']);
  none('…and it stopped naming the two controls, or the cheaper alternative',
    /<b>You approve<\/b>/.test(APP) && /<b>View-only<\/b>/.test(APP) && /they can <b>Join<\/b>/.test(APP)
      ? [] : ['the approve / view-only / Join lines are not all present']);
}

// ---------------------------------------------------------------------------------------------------------
// 49. THE GUEST TERMINAL CARRIES NO SCROLLBAR AT ALL — NOT A CUSTOM ONE, NOT THE NATIVE ONE.
//   The custom scroll gutter is gone, matching the host. It estimated its own position rather than knowing it,
//   and the embedded CLI holds the terminal's ALTERNATE screen, which carries no scrollback — so the bar was
//   scrolling an estimate over content that cannot scroll, and charged a repaint timer every 150ms for the life
//   of the page to keep the estimate on screen. THE TRAP on the way out: the two rules that hide xterm's OWN
//   scrollbar must stay, or deleting the custom bar simply puts a scrollbar back — the opposite of the fix.
// ---------------------------------------------------------------------------------------------------------
{
  const gflat = GUEST_HTML.replace(/\s*\n\s*/g, '');
  none('the custom scroll gutter is back in the guest markup',
    !/id="gutter"/.test(GUEST_HTML) && !/id="gthumb"/.test(GUEST_HTML)
      ? [] : ['the guest page renders a gutter/thumb element again']);
  none('…and its styling is back',
    !/\.gutter\{/.test(gflat) && !/\.gthumb\{/.test(gflat)
      ? [] : ['.gutter / .gthumb rules are back in guest.html']);
  none('…and the script that drove it is back',
    !/\$\('gutter'\)/.test(GUEST_JS) && !/altFrac/.test(GUEST_JS) && !/setInterval\(upd/.test(GUEST_JS)
      ? [] : ['guest.js drives a gutter again (element lookup, position estimate, or repaint timer)']);
  none('removing it exposed xterm’s NATIVE scrollbar instead',
    /#terminal \.xterm-viewport\{scrollbar-width:none\}/.test(gflat)
      && /#terminal \.xterm-viewport::-webkit-scrollbar\{width:0/.test(gflat)
      ? [] : ['the rules hiding xterm’s own scrollbar are gone — the guest terminal has a scrollbar again']);
}

// ---------------------------------------------------------------------------------------------------------
// 50. THE GUEST TERMINAL IS PINNED, AND SHOWS ONLY WHAT A GUEST CAN USE.
//   A guest saw a second scroll OUTSIDE the terminal: the pane was overflow:auto, and the fit was computed from
//   NOMINAL monospace metrics (0.6 advance / 1.18 line), which round differently per browser/OS/zoom — so a grid
//   computed as "just fits" could render a couple of pixels over. Desktop is now overflow:hidden AND the fit is
//   corrected against what actually rendered. Phones keep overflow: their grid is deliberately wider than the
//   screen and is panned. Separately: session cost + tokens are the HOST's billing numbers, useless to a viewer.
// ---------------------------------------------------------------------------------------------------------
{
  const gflat = GUEST_HTML.replace(/\s*\n\s*/g, '');
  none('the guest pane can still scroll outside the terminal on desktop',
    /\.wrap\{[^}]*overflow:hidden/.test(gflat) ? [] : ['.wrap is not overflow:hidden on desktop']);
  none('…and phones lost the horizontal pan they need (their grid is wider than the screen by design)',
    /body\.mobile \.wrap\{[^}]*overflow:auto/.test(gflat) && /@media \(max-width:760px\)\{\s*\.wrap\{[^}]*overflow:auto/.test(gflat)
      ? [] : ['the mobile overflow:auto overrides were lost']);
  none('the fit trusts estimated font metrics with no correction against what actually rendered',
    /function shrinkToFit\(left\)/.test(GUEST_JS) && /getBoundingClientRect\(\)/.test(GUEST_JS)
      && /scheduleShrinkToFit\(\);/.test(GUEST_JS)
      ? [] : ['recomputeFit has no measured shrink-to-fit pass']);
  none('…and that correction can grow the font or run unbounded',
    /if \(left <= 0 \|\| isMobile\(\)\) return;/.test(GUEST_JS) && /term\.options\.fontSize = cur - 1;/.test(GUEST_JS)
      && !/term\.options\.fontSize = cur \+ 1;/.test(GUEST_JS)
      ? [] : ['shrinkToFit is not bounded + shrink-only']);
  none('the guest still shows the host’s session cost / token count',
    !/id="trk-cost"/.test(GUEST_HTML) && !/id="trk-tokens"/.test(GUEST_HTML)
      && !/trk-cost/.test(GUEST_JS) && !/trk-tokens/.test(GUEST_JS)
      ? [] : ['cost/tokens readouts survive on the guest page']);
  none('…and lost the context meter, which is the one figure a viewer can use',
    /id="ctxbar"/.test(GUEST_HTML) && /id="ctxpct"/.test(GUEST_HTML) && /ctxPct/.test(GUEST_JS)
      ? [] : ['the context meter was removed too']);
}

// ---------------------------------------------------------------------------------------------------------
// 51. GUEST CHROME: A READABLE TYPING LINE, A SLEEK CHAT SCROLLBAR, A GROUPED TOP BAR, A TIGHTER FRAME.
//   The typing hint was a 10px pill in the corner reading "✎ MK" — too small to notice and too cryptic to
//   parse. It is now a sentence ("<name> is typing…") centred at the TOP of the pane: terminal activity
//   belongs over the terminal, and never at the bottom where the prompt and cursor live.
// ---------------------------------------------------------------------------------------------------------
{
  const gflat = GUEST_HTML.replace(/\s*\n\s*/g, '');
  none('the typing hint is still a tiny corner pill',
    /\.typist-chip\{[^}]*top:0;left:50%/.test(gflat) && !/\.typist-chip\{[^}]*border-radius:999px/.test(gflat)
      ? [] : ['.typist-chip is not the centred top banner (or is still pill-shaped)']);
  none('…and it never says what is actually happening',
    /' is typing…'/.test(GUEST_JS) && !/'✎ '/.test(GUEST_JS)
      ? [] : ['the chip does not read "<name> is typing…"']);
  // Names are collaborator-supplied. The old code used textContent (safe); the new markup has a <b>, so it must
  // be BUILT FROM NODES — an innerHTML shortcut here would be an XSS hole on someone else's machine.
  none('the typing line interpolates a collaborator-supplied name into HTML',
    /var b = document\.createElement\('b'\); b\.textContent = String\(name\)/.test(GUEST_JS)
      && !/chip\.innerHTML/.test(GUEST_JS)     // an assignment, not the word — a comment mentioning innerHTML must not trip this
      ? [] : ['the typist name is not built from text nodes']);
  none('the guest chat scrollbar is still the browser default',
    /\.gchat-log::-webkit-scrollbar\{width:7px\}/.test(gflat) && /\.gchat-log\{scrollbar-width:thin/.test(gflat)
      ? [] : ['.gchat-log has no thin/custom scrollbar styling']);
  none('…and it is painted at rest instead of fading in on hover',
    /\.gchat-log::-webkit-scrollbar-thumb\{background:transparent/.test(gflat) && /\.gchat:hover \.gchat-log::-webkit-scrollbar-thumb\{background:rgba/.test(gflat)
      ? [] : ['the chat scrollbar thumb is not transparent-at-rest + hover-revealed']);
  none('the top bar does not group the session with its "shared live session" label',
    /class="sesslbl">shared live session:<\/span><b id="sess-chip-text">/.test(GUEST_HTML) && /class="barsep"/.test(GUEST_HTML)
      ? [] : ['the session label/name group or the brand separator is missing']);
  none('…and the old free-floating "shared" tag came back beside the wordmark',
    !/<span class="tag">/.test(GUEST_HTML) ? [] : ['the standalone .tag element is back']);
  // 11 top / 3 bottom: the TOTAL is still 14px (so the fitted terminal is the same size) but it sits ~4px lower,
  // giving the "is typing…" banner room above and taking those pixels off the dead gap below.
  none('the vertical frame around the terminal was not tightened / re-balanced',
    /\.wrap\{[^}]*padding:11px 14px 3px/.test(gflat) && /#terminal\{[^}]*padding:5px 12px/.test(gflat)
      ? [] : ['the .wrap / #terminal vertical padding is not the tightened, top-weighted pair']);
  // A just-admitted guest has no session details yet — the host's first tracker push is ~1s behind the
  // admission. Whatever fills the chip in that gap must read as plainly temporary; a generic name-shaped
  // label settles like a real session name and then changes under the viewer. Scoped to the admission
  // branch so the settled-state fallback below keeps its own generic wording.
  const helloBranch = (GUEST_JS.match(/msg\.type === 'hello'[\s\S]*?msg\.type === 'pending'/) || [''])[0];
  none('the just-admitted session chip paints a name-shaped placeholder instead of a loading label',
    /ct\.textContent = 'loading…'/.test(helloBranch) && !/live session/.test(helloBranch)
      ? [] : ['the admission path does not set a neutral loading label on the empty session chip']);
  none('…and the settled label lost its fallback for a genuinely unnamed session',
    /s\.session \|\| 'live session'/.test(GUEST_JS)
      ? [] : ['the status handler no longer falls back to a generic label for an unnamed session']);
}

// ---------------------------------------------------------------------------------------------------------
// 52. SCROLLING IS NOT TYPING. Every full-screen TUI enables mouse tracking, so xterm forwards wheel and click
//   REPORTS down the same channel as keystrokes, and the guest's scroll gutter sends Page keys there too. Both
//   used to light the typist indicator, so "MK is typing…" appeared while MK was only scrolling. This is the
//   one check in the file that EXERCISES the code rather than reading it — the classifier is pure, so run it.
// ---------------------------------------------------------------------------------------------------------
{
  let isTypingBytes = null;
  try { ({ isTypingBytes } = require('../share/server')); } catch {}
  if (typeof isTypingBytes !== 'function') {
    none('share/server.js no longer exports the typing/scroll classifier', ['isTypingBytes is not exported']);
  } else {
    const TYPING = [['a', 'a printable char'], ['hello', 'a word'], ['\r', 'Enter'], ['\x7f', 'Backspace'],
      ['\x03', 'Ctrl+C'], ['\x1b[A', 'Arrow Up'], ['\x1b[<64;1;1Mx', 'a wheel report followed by a real keystroke']];
    const NOT_TYPING = [['\x1b[5~', 'PageUp (the scroll gutter)'], ['\x1b[6~', 'PageDown'],
      ['\x1b[<64;12;34M', 'SGR wheel-up'], ['\x1b[<65;12;34M', 'SGR wheel-down'], ['\x1b[<0;5;7M', 'mouse press'],
      ['\x1b[<0;5;7m', 'mouse release'], ['\x1b[M\x20\x30\x40', 'X10 mouse report'],
      ['\x1b[<64;1;1M\x1b[<64;1;1M', 'a burst of wheel reports'], ['', 'an empty frame']];
    none('real keystrokes are no longer counted as typing',
      TYPING.filter(([b]) => isTypingBytes(b) !== true).map(([, d]) => d));
    none('scrolling / clicking still counts as typing (the reported bug)',
      NOT_TYPING.filter(([b]) => isTypingBytes(b) !== false).map(([, d]) => d));
  }
  // …and both trigger points must actually consult it — guest input and the host's own keystrokes alike.
  none('a guest’s scroll can still light the typist indicator',
    /if \(isTypingBytes\(data\)\) typistPing\(ws\._name, ws\);/.test(read('share/server.js'))
      ? [] : ['the guest input handler does not gate typistPing on isTypingBytes']);
  none('…and the host’s scroll can still tell every guest the host is typing',
    /if \(tabId === mirrorTabId\(\) && isTypingBytes\(data\)\)/.test(MAIN)
      ? [] : ['main.js does not gate broadcastTypist on isTypingBytes']);
}

// ---------------------------------------------------------------------------------------------------------
// 53. THE COCKPIT'S TYPING INDICATOR MATCHES THE GUEST PAGE. Two surfaces, one product: the host's chip read
//   "✎ MK" as a pill badge while the guest page read "MK is typing…" on a scrim. Same wording, same emphasis,
//   no pencil, no pill on either. (Placement differs on purpose — corner in the cockpit, top-centre on the
//   guest page — because only the guest page has a terminal that owns the whole pane.)
// ---------------------------------------------------------------------------------------------------------
{
  const flat = HTML.replace(/\s*\n\s*/g, '');
  none('the cockpit typing indicator is still a pencil pill',
    !/\.typist-chip\{[^}]*border-radius:999px/.test(flat) && !/'✎ ' \+ name/.test(APP)
      ? [] : ['the cockpit chip is still pill-shaped or still prefixes a pencil']);
  none('…and does not use the same "<name> is typing…" wording as the guest page',
    /' is typing…'/.test(APP) && /' is typing…'/.test(GUEST_JS)
      ? [] : ['the two surfaces disagree on the typing wording']);
  none('…and emphasises the name differently on the two surfaces',
    /\.typist-chip b\{font-weight:600/.test(flat) && /\.typist-chip b\{font-weight:600/.test(GUEST_HTML.replace(/\s*\n\s*/g, ''))
      ? [] : ['only one surface emphasises the typist name']);
  // Same XSS rule as the guest page: the name arrives over the wire from another machine.
  none('the cockpit builds the typing line by interpolating a remote name into HTML',
    /const who = document\.createElement\('b'\); who\.textContent = String\(name\)/.test(APP)
      ? [] : ['the cockpit typist name is not built from text nodes']);
}

// ---------------------------------------------------------------------------------------------------------
// 54. THE TUNNEL CHECK MUST WORK IN ELECTRON, AND "UNSURE" MUST NOT MEAN "BROKEN".
//   A bare `new dns.Resolver()` inherits the OS resolver config — and inside Electron (42 / Node 24, Windows)
//   c-ares comes up with NO servers, so every query died with ECONNREFUSED. Plain Node on the same machine
//   works, which is why this shipped: the authoritative stage was INERT in the app, verification fell through
//   to the OS-resolver probe it existed to avoid, that probe poisoned the cache, and the failure was then
//   reported to the user as "install cloudflared". Servers are now set EXPLICITLY, with DoH as a fallback.
// ---------------------------------------------------------------------------------------------------------
{
  const CF = read('share/cloudflared.js');
  none('the DNS check trusts the OS resolver config (ECONNREFUSED inside Electron → the whole stage is inert)',
    /const BOOTSTRAP_DNS = \['1\.1\.1\.1', '8\.8\.8\.8'\]/.test(CF) && /r\.setServers\(BOOTSTRAP_DNS\)/.test(CF)
      ? [] : ['authoritativeServers does not set its nameservers explicitly']);
  none('…and has no fallback when outbound port 53 is blocked',
    /function dohHasRecord\(/.test(CF) && /cloudflare-dns\.com\/dns-query/.test(CF)
      ? [] : ['no DNS-over-HTTPS fallback for the DNS check']);
  // THE DECISION TABLE. "Couldn't confirm from here" must never discard a live tunnel — substituting a
  // 127.0.0.1 link MANUFACTURES the dud the check exists to prevent, which is exactly what it used to do.
  none('an unconfirmed but REGISTERED tunnel is still thrown away (manufacturing a loopback dud)',
    /const confirmed = !!\(v\.published \|\| v\.reachable\);/.test(CF)
      && /if \(!v\.ok \|\| \(!got\.registered && !confirmed\)\)/.test(CF)
      ? [] : ['startCloudflared does not ship a registered-but-unconfirmed tunnel']);
  none('…and an UNREGISTERED url ships without positive DNS proof (a banner is not a routable tunnel)',
    /registered: false/.test(CF) && /!got\.registered && !confirmed/.test(CF)
      ? [] : ['an unregistered URL can be shipped unconfirmed']);
  none('a DNS verdict of "no such record" no longer condemns the link',
    /if \(!d\.ok && !d\.unavailable\) return \{ ok: false, published: false, stage: 'dns'/.test(CF)
      ? [] : ['a definitive NXDOMAIN is not treated as a dud']);
  // "Install cloudflared" is for ONE state. Offering it because a probe timed out is the false alarm.
  none('a failed tunnel cannot be told apart from a missing binary',
    /err\.reason = missing \? 'missing' : 'launch-failed';/.test(CF) ? [] : ['startCloudflared does not tag ENOENT distinctly']);
  none('…so main still hands out a loopback link when cloudflared is absent',
    /if \(reason === 'missing'\)[\s\S]{0,500}?return \{ ok: false, error: note, reason: 'missing' \}/.test(MAIN)
      ? [] : ['main.js still returns a 127.0.0.1 link when cloudflared is missing']);
  none('…and the renderer offers "Install cloudflared" for failures that are not a missing binary',
    /const missing = lastShareReason === 'missing';/.test(APP)
      && /\$\('tunnel-warn-install'\); if \(b\) b\.style\.display = missing \? '' : 'none'/.test(APP)
      ? [] : ['the install button is not gated on the missing-binary reason']);
  none('the 5–10s wait is unexplained (silence reads as a hang)',
    /creating your live link… this usually takes 5–10 seconds/.test(APP) ? [] : ['no progress message naming the expected duration']);
}

// ---------------------------------------------------------------------------------------------------------
// 55. A JOINED ROW READS LIKE A SHARED ONE — ONE NAME, ONE DOT, ONE WORD.
//   It used to render "● joined · CRAZY · live": a literal ● baked into the TITLE STRING, a second .sess-livedot
//   span, and ~150px of prose in a flex:none cluster. Against the flex:1 title that starved the session name to
//   a bare "…" on a narrow sidebar — and the ● survived, being the title's first glyph. It now uses the SAME
//   .sess-live-ind badge the host's own live row uses, so the two read alike.
// ---------------------------------------------------------------------------------------------------------
{
  none('the joined title carries a literal ● that duplicates the dot and eats the truncation budget',
    !/sess-prev'; p\.textContent = '● '/.test(APP) ? [] : ['the joined row still prefixes a ● character to its title']);
  none('…and a second .sess-livedot span is still built beside the badge',
    !/sess-livedot/.test(APP.replace(/\/\/[^\n]*/g, '')) ? [] : ['.sess-livedot is still created in the renderer']);
  none('the joined row does not reuse the host live row’s badge component',
    /function joinedBadge\(rec\)[\s\S]{0,300}?className = 'sess-live-ind'/.test(APP)
      && /className = 'live-dot'/.test(APP) && /className = 'liw'/.test(APP)
      ? [] : ['the joined badge is not built from .sess-live-ind + .live-dot + .liw']);
  // THE TRAP: renderJoinedTabRow() builds this line and setLiveState() REBUILDS it on every state change.
  // Fixing one leaves the row reverting to the old shape the moment the connection state moves.
  none('only one of the two paint paths was fixed (the other reverts on the next state change)',
    (APP.match(/appendChild\(joinedBadge\(rec\)\)/g) || []).length === 2
      ? [] : ['both renderJoinedTabRow and setLiveState must paint via the shared builder']);
  none('…and the host username / prose is back on the row, starving the title again',
    !/'joined · '/.test(APP) ? [] : ['the joined row rebuilt its prose meta line']);
  // The badge must not claim "joined" while the mirror is anything but live.
  none('the badge claims "joined" while reconnecting, declined or ended',
    /if \(st !== '' && st !== 'live'\) return LIVE_STATE_LABEL\[st\] \|\| 'joined';/.test(APP)
      ? [] : ['joinedBadgeWord ignores the live state']);
  none('…and the detail it dropped is not reachable at all',
    /function joinedTooltip\(rec\)/.test(APP) && /[^a-zA-Z]row\.title = joinedTooltip\(rec\)/.test(APP) && /jrow\.title = joinedTooltip\(rec\)/.test(APP)
      ? [] : ['host name / view-only / reason are not preserved in the row tooltip on both paths']);
}

// ---------------------------------------------------------------------------------------------------------
// 56. THE CLAUDE-CODE BUTTON GAINS "UPDATE AVAILABLE" + "REFRESH SESSION" — additively, in the existing popup.
//   Amber dot when the installed CLI is behind the latest published (a distinct gold, NOT the not-installed
//   amber). One-click update (npm -g latest, reusing the install path) and one-click session refresh (resume →
//   history kept). Two footguns guarded: a false amber when the registry can't be reached, and refreshing a
//   session that is HOSTING a live share (which would drop the guests).
// ---------------------------------------------------------------------------------------------------------
{
  const flat = HTML.replace(/\s*\n\s*/g, '');
  const LATEST = read('wsl/claude-latest.sh');
  none('the "latest version" check can hang or crash instead of failing silent',
    /command -v npm >\/dev\/null 2>&1 \|\| \{ printf ''; exit 0; \}/.test(LATEST) && /npm view @anthropic-ai\/claude-code version/.test(LATEST)
      ? [] : ['claude-latest.sh does not fail silent on missing npm']);
  none('main.js does not fetch/cache the latest version fail-silent',
    /ipcMain\.handle\('claude:latest'/.test(MAIN) && /_claudeLatest = ''; _claudeLatestTs = Date\.now\(\); resolve\(''\)/.test(MAIN) && /24 \* 60 \* 60 \* 1000/.test(MAIN)
      ? [] : ['claude:latest is missing its daily cache or its fail-silent catch']);
  none('the refresh IPC does not restart the foreground session via respawn (resume)',
    /ipcMain\.handle\('claude:refresh-session'[\s\S]{0,2400}?respawnPty\(tabId, \(rec && rec\.session\) \|\| ''/.test(MAIN)
      ? [] : ['claude:refresh-session does not respawn the fg tab on its own session']);
  none('…and it can restart a session that is HOSTING a live share (dropping the guests)',
    /if \(hosting && sharedTabId != null && tabId === sharedTabId\) return \{ ok: false, reason: 'hosting'/.test(MAIN)
      ? [] : ['the refresh IPC has no hosting guard']);
  none('the out-of-date dot state does not exist / collides with the not-installed amber',
    /\.claude-dot\.stale\{background:#f5b74a/.test(flat) && !/\.claude-dot\.bad\{background:#f5b74a/.test(flat)
      ? [] : ['no distinct .claude-dot.stale gold, or it reuses the not-installed colour']);
  none('the dot does not go amber on "installed + signed in + out of date"',
    /state === 'ready' \? \(ccStale \? 'stale' : 'ok'\)/.test(APP)
      ? [] : ['setDot does not map ready+ccStale to the stale dot']);
  none('a registry that can’t be reached still turns the dot amber (false out-of-date)',
    /async function checkStale\(\)[\s\S]{0,400}?ccStale = !!\(ccLatest && verLt\(inst, ccLatest\)\)/.test(APP)
      && /catch \{ ccStale = false; \}/.test(APP)
      ? [] : ['checkStale can leave ccStale true without a confirmed newer version']);
  none('Update does not reuse the proven install path',
    /async function update\(b\)[\s\S]{0,300}?claudible\.preflightInstall\('claude'\)/.test(APP)
      ? [] : ['the update button does not call preflightInstall(claude)']);
  none('…and does not re-evaluate staleness after updating (amber would never clear)',
    /async function update\(b\)[\s\S]{0,400}?loadVerForce\(\); await checkStale\(\)/.test(APP)
      ? [] : ['update never re-reads the version / re-checks stale']);
  // The busy guard must live in MAIN (it alone knows which tab it will restart). Guarding on the renderer's
  // AT() — the tab ON SCREEN — is the actual defect: while a joined live session is viewed, AT() and fgTabId
  // diverge by design and a live-tab record has no `busy` field, so the confirm never fired and a different,
  // mid-turn session was killed silently.
  none('the mid-turn guard is back on the renderer’s on-screen tab (it can kill a DIFFERENT busy session)',
    /if \(rec && rec\.busy && !\(opts && opts\.force\)\) return \{ ok: false, reason: 'busy', tabId/.test(MAIN)
      && !/AT\(\) && AT\(\)\.busy && !confirm\(/.test(APP)
      ? [] : ['claude:refresh-session does not own the busy check, or the renderer still guards on AT()']);
  none('…and the renderer does not confirm against the tab main actually named',
    /if \(r && r\.reason === 'busy'\)[\s\S]{0,900}?claudeRefreshSession\(\{ force: true \}\)/.test(APP)
      && /function refreshTargetName\(tabId\)/.test(APP)
      ? [] : ['the renderer does not re-confirm-and-force against main’s reported tab']);
  none('the new IPCs are not exposed on the preload bridge',
    /claudeLatest: \(\) => ipcRenderer\.invoke\('claude:latest'\)/.test(PRELOAD) && /claudeRefreshSession: \(opts\) => ipcRenderer\.invoke\('claude:refresh-session', opts\)/.test(PRELOAD)
      ? [] : ['claudeLatest / claudeRefreshSession are not in preload.js']);
}

// ---------------------------------------------------------------------------------------------------------
// 57. SWITCHING TO A PROJECT OPENS THE SESSION YOU LAST WORKED IN — not the newest-mtime guess.
//   The remembered-session fallback (rememberedSessionFor) is what stops session.sh's filesystem-timestamp
//   guess from opening the wrong conversation (a sessions-sync/git-pull rewrite bumps an untouched session's
//   mtime → e.g. GIT PULL wins). It guarded the new-tab path (pty:start) but the workspace-SWITCH respawn
//   (workspace:open) resumed '' directly — so switching back to a project opened the wrong session. Both
//   respawn paths must carry the same fallback.
// ---------------------------------------------------------------------------------------------------------
{
  none('workspace:open resumes the newest-mtime guess instead of the remembered session',
    /respawnPty\(targetTab, session \|\| rememberedSessionFor\(ws\) \|\| '', \{ guardBusy: true \}\)/.test(MAIN)
      ? [] : ['workspace:open does not fall back to rememberedSessionFor before session.sh guesses']);
  none('…and the new-tab path lost the same fallback (they must stay in lockstep)',
    /spawnPty\(tabId, cols, rows, ws, \(rec && rec\.session\) \|\| \(intent && intent\.session\) \|\| rememberedSessionFor\(ws\) \|\| ''\)/.test(MAIN)
      ? [] : ['pty:start no longer resolves through rememberedSessionFor']);
  // Resuming a session that's already live in another tab spawns a duplicate claude → Claude Code's "already
  // running or being resumed" modal, which swallows the spacebar. The normal switch path must focus the
  // existing tab instead (the busy/shared branch already did; this extends it).
  none('switching to a project can spawn a SECOND claude on a session another tab already runs (spacebar-eating modal)',
    /const sess = await sessionToOpenFor\(id, targetSession(?:, \w+)?\);[\s\S]{0,1000}?if \(sess !== 'new'\) \{[\s\S]{0,400}?for \(const rec of tabs\.values\(\)\) if \(rec\.kind !== 'live' && rec\.wsId === id && rec\.session === sess\) \{ setActiveTab\(rec\.tabId\); return; \}/.test(APP)
      ? [] : ['switchWorkspace normal path does not dedupe an already-open session']);
}

// ---------------------------------------------------------------------------------------------------------
// 58. THE NAMING DIALOG'S OK BUTTON WORKS, AND THE INLINE RENAME ✓/✗ FIT THE FLEX ROW.
//   modalPrompt (the "+ New Session" naming dialog) wired Cancel but NOT OK — clicking "Create session" did
//   nothing, only Enter committed. And the inline-rename ✓/✗ (.sess-rename-actions) were position:absolute at a
//   fixed top, tuned for the pre-flex row; once .sess became a flexbox they stopped centring and overlapped the
//   input, so clicks missed them.
// ---------------------------------------------------------------------------------------------------------
{
  const flat = HTML.replace(/\s*\n\s*/g, '');
  none('the naming dialog OK button has no click handler (only Enter commits)',
    /okb\.addEventListener\('click', \(\) => close\(answer\(\)\)\)/.test(APP) && /const answer = \(\) => \(chk \? \{ value: inp\.value\.trim\(\)/.test(APP)
      ? [] : ['modalPrompt okb is not wired to close/commit']);
  none('…and Cancel is still wired (guard against removing the wrong one)',
    /cancel\.addEventListener\('click', \(\) => close\(null\)\)/.test(APP)
      ? [] : ['modalPrompt cancel lost its handler']);
  none('the inline-rename ✓/✗ are still absolutely positioned over the flex-row input',
    /\.sess-rename-actions\{flex:none;display:flex;align-items:center/.test(flat) && !/\.sess-rename-actions\{position:absolute/.test(flat)
      ? [] : ['.sess-rename-actions is not an in-flow flex child']);
}

// ---------------------------------------------------------------------------------------------------------
// 59. SWITCHING PROJECTS MUST NOT LURCH THE SIDEBAR.
//   A cold session cache used to replace the whole list with ONE .sess-empty block (measured 56.75px) and then
//   snap open to N rows (6 rows = 205.25px) — a 148.5px jump that only happened for projects you hadn't visited,
//   so the same click felt smooth or glitchy at random. Skeleton rows now hold the height (measured: identical
//   32.38px per row, swap delta 0.00px).
// ---------------------------------------------------------------------------------------------------------
{
  const flat = HTML.replace(/\s*\n\s*/g, '');
  none('a cold project switch collapses the list to the tall placeholder again',
    /const n = Math\.max\(3, Math\.min\(8, outgoing \|\| 5\)\);/.test(APP) && /sk\.className = 'sess-skel'/.test(APP)
      ? [] : ['primeSessionListForWs no longer paints height-matched skeletons']);
  // THE TRAP: app.js maps .sess rows to dataset.id for the persisted drag order — a skeleton carrying .sess
  // would write `undefined` into it. It must be its own class.
  none('the skeleton carries the .sess class and can poison the persisted session order',
    !/className = 'sess sess-skel'/.test(APP) && !/classList\.add\('sess'\)[\s\S]{0,40}sess-skel/.test(APP)
      ? [] : ['skeleton rows are in the .sess set used by the drag/order queries']);
  // A real row's height comes from the 22px ▾ (in flow at opacity:0), NOT its 16.2px text line box.
  none('the skeleton lost the strut that matches the ▾ button’s box (rows drift ~6px each)',
    /\.sess-skel::after\{content:'';flex:none;width:0;height:22px\}/.test(flat)
      ? [] : ['.sess-skel::after strut missing — skeleton height no longer matches a real row']);
  none('…and refreshSessions clobbers the skeletons straight back to the tall placeholder',
    /!sessListEl\.querySelector\('\.sess,\.sess-skel'\)/.test(APP)
      ? [] : ['the cold-list guard does not treat skeletons as already-painted']);
  // A row's height was set by its tallest child, and the two renderers build different children: the ACTIVE
  // project's list appends a 22px .sess-menu-btn, the non-active tree's rows don't. Measured 32.38 vs 26.56 —
  // every row in a project grew 5.82px the instant you selected it. The floor makes all paths land on one height.
  none('a session row’s height still depends on whether its renderer added the ▾ (selected vs unselected drift)',
    /\.sess\{[^}]*min-height:29px[^}]*padding:3\.5px 6px/.test(flat) ? [] : ['.sess lost its uniform 29px row box — selected/unselected rows will drift apart again']);
  none('…and the skeleton drifted off that floor',
    /\.sess-skel\{[^}]*min-height:29px/.test(flat) ? [] : ['.sess-skel no longer shares .sess’s 29px box']);
}

// ---------------------------------------------------------------------------------------------------------
// 60. A PROJECT THAT HAS SESSIONS MUST NOT OPEN AS A BLANK DRAFT — AND NEVER TWO CLAUDES ON ONE SESSION.
//   Two faces of one root cause (a session resolved lazily or not at all):
//   * sessionToOpenFor consulted only lastSessionFor + a cache that is warmed exclusively by activating or
//     expanding a project — so a never-visited project (typically a SHARED one whose sessions synced in from a
//     collaborator) resolved to 'new' and opened as a phantom blank draft. It now FETCHES on a cold cache
//     (async), so 'new' means "genuinely empty", not "not looked". Behavioural cases live in
//     test/session-resolution.test.js (an async helper can't be lifted into this synchronous file).
//   * the NORMAL switch path fell back to '' — which skipped the very dedupe gate added for ec9308f (it was
//     keyed on a non-empty id) and left main's `--continue` to resume by mtime, possibly a session ALREADY
//     live in another tab: two claudes, the "already running" modal, a dead spacebar. Every switch path now
//     awaits a real id, and main's respawnPty carries its own cross-tab dedupe as defence in depth.
// ---------------------------------------------------------------------------------------------------------
{
  // All three sites now pass an OPTIONAL out-object (P: "we could not look" ≠ "the project is empty"), hence
  // the `(?:, \w+)?`. What this pin protects is unchanged: exactly three sites, every one awaited, none bare.
  none('a switch path stopped awaiting the resolver (an unawaited call hands a Promise to newBlankTab)',
    (APP.match(/await sessionToOpenFor\(id, targetSession(?:, \w+)?\)/g) || []).length === 3
      && !/[^t] sessionToOpenFor\(id/.test(APP)
      ? [] : ['expected exactly 3 awaited sessionToOpenFor call sites (busy, normal, kept) and no bare ones']);
  none('the normal switch path fell back to \'\' again (it walks straight past the dedupe gate)',
    /const sess = await sessionToOpenFor\(id, targetSession(?:, \w+)?\);/.test(APP)
      && !/lastSessionFor\(id\) \|\| ''/.test(APP)
      ? [] : ['switchWorkspace resolves sess with an \'\' fallback again']);
  none('…or the dedupe gate is keyed on truthiness again (\'\' would skip it)',
    /if \(sess !== 'new'\) \{[\s\S]{0,400}?rec\.session === sess\) \{ setActiveTab\(rec\.tabId\); return; \}/.test(APP)
      ? [] : ['the normal-path dedupe is not keyed on the resolved id']);
  // The window is a proxy for "still inside this function", not a size budget — it was widened from 1500 when
  // the remembered-id guard grew a second question (exists vs. is-shown). It still fails the moment the fetch
  // leaves the function, which is the regression this pins; if it needs widening again, check that first.
  none('the cold-cache fetch is gone (a never-visited shared project resolves to a phantom draft again)',
    /async function sessionToOpenFor\(wsId, targetSession(?:, \w+)?\)[\s\S]{0,2200}?claudible\.sessionListWs\(wsId\)/.test(APP)
      ? [] : ['sessionToOpenFor no longer fetches on a cold cache']);
  none('the kept-tab rollback path lost its dedupe (main may have refused BECAUSE the session is live elsewhere)',
    /Object\.assign\(t, prev\);[\s\S]{0,900}?const want = await sessionToOpenFor\(id, targetSession(?:, \w+)?\);[\s\S]{0,700}?rec\.session === want\) \{ setActiveTab\(rec\.tabId\); return; \}/.test(APP)
      ? [] : ['the keptTab branch does not dedupe before newBlankTab']);
  // The refusal now also records WHY (I4 — session:open reads _lastRespawnRefusal to toast a reason), so the
  // dedupe returns from a block rather than bare. What this pin protects is unchanged: the cross-tab scan still
  // exists, still returns FALSE, and still does so BEFORE the destructive ptys.delete.
  none('main lost its one-session-one-claude guard (the renderer dedupe is the only defence again)',
    /function respawnPty\(tabId, session, opts\) \{[\s\S]{0,2900}?for \(const \[tid, r2\] of ptys\) if \(tid !== tabId && !liveTabs\.has\(tid\) && r2\.session === session\) \{ _lastRespawnRefusal = 'open-elsewhere'; return false; \}[\s\S]{0,8000}?ptys\.delete\(tabId\);/.test(MAIN)
      ? [] : ['respawnPty has no cross-tab session dedupe before the destructive re-point']);
  none('an empty-string session strands the active tab without a sidebar row again',
    /if \(sid === ''\) return t;/.test(APP) ? [] : ['orphanTab no longer covers the \'\' shape']);
}

// ---------------------------------------------------------------------------------------------------------
// 61. `npm test` MUST RUN EVERY FILE. It was a 43-step `&&` chain, so one stale assertion at step 20 meant 23
//   files — including ALL NINE shell tests — silently never executed, locally or in CI, and the output looked
//   identical to an ordinary single failure. The runner never short-circuits and reports an aggregate.
// ---------------------------------------------------------------------------------------------------------
{
  const PKG = JSON.parse(read('package.json'));
  const RUN = read('test/run-all.js');
  none('npm test is back to an && chain (one failure hides the rest of the suite)',
    PKG.scripts && PKG.scripts.test === 'node test/run-all.js' ? [] : ['scripts.test is not the aggregate runner']);
  none('…and the e2e boot test lost its separate, opt-in script',
    PKG.scripts && PKG.scripts['test:e2e'] === 'node test/e2e-boot.test.js' ? [] : ['test:e2e is missing']);
  none('the runner short-circuits instead of running every file',
    /for \(const \{ f, cmd \} of steps\)/.test(RUN) && !/break;/.test(RUN) && /failures\.push/.test(RUN)
      ? [] : ['run-all.js does not run all steps and collect failures']);
  none('…and a test killed by a signal counts as a pass',
    /r\.status == null \? 1 : r\.status/.test(RUN) ? [] : ['a null exit status is not treated as failure']);
  none('…and it still exits non-zero on failure (so CI keeps gating)',
    /process\.exit\(failures\.length \? 1 : 0\)/.test(RUN) ? [] : ['run-all.js does not propagate failure']);
  // Discovery, not a hardcoded list — a new test file can never be silently left out of the suite.
  none('the runner uses a hardcoded list a new test can be forgotten from',
    /readdirSync\(DIR\)/.test(RUN) && /endsWith\('\.test\.js'\)/.test(RUN) && /endsWith\('\.sh'\)/.test(RUN)
      ? [] : ['run-all.js does not discover test files']);
}

// ---------------------------------------------------------------------------------------------------------
// 62. CI's TEST JOB MUST INSTALL THE DEPS THE SUITE ACTUALLY USES. It ran `npm test` with no install, on the
//   claim that the suite is "pure Node + bash". share/server.js requires `ws`, so share-names.test.js caught the
//   module error and skipped Parts B/C/D — resume, supersede-zombie-socket, roster-bound, voice-relay-dedup —
//   while still printing "0 failed" and exiting 0. Measured: 16 assertions without ws, 43 with it.
// ---------------------------------------------------------------------------------------------------------
{
  const CI = read('.github/workflows/test.yml');
  none('the CI test job runs the suite without the deps it needs (live-share coverage skips, silently green)',
    /npm ci --omit=dev --ignore-scripts/.test(CI) && /run: npm test/.test(CI)
      ? [] : ['test.yml does not install prod deps before npm test']);
  none('…and the install is ordered after npm test (too late to matter)',
    CI.indexOf('npm ci --omit=dev --ignore-scripts') < CI.indexOf('run: npm test')
      ? [] : ['deps are installed after the suite runs']);
  none('a ws-less run reports itself as fully passing',
    /SKIPPED: ws module unavailable/.test(read('test/share-names.test.js'))
      ? [] : ['share-names.test.js no longer announces a skipped integration']);
}

// ---------------------------------------------------------------------------------------------------------
// 63. NO SHIPPED .js FILE MAY BE UNLINTED. eslint.config.js matches files by glob, so a file in a directory no
//   glob covers gets ZERO rules and `npm run lint` still exits 0 — "lint passes" becomes true-by-omission.
//   It had already happened once (share/cloudflared.js + share/server.js, per the config's own comment) and had
//   happened again to share/replay.js, relay/worker.js and scripts/preinstall-check.js. Rather than name those
//   three, walk the tree and assert EVERY shipped .js matches some glob — the drift class, not its instances.
//   Pure text/fs so it runs with no devDeps (the CI test job installs --omit=dev, so eslint isn't there).
// ---------------------------------------------------------------------------------------------------------
{
  const cfg = read('eslint.config.js');
  const globs = [];
  for (const m of cfg.matchAll(/files:\s*\[([^\]]+)\]/g)) {
    for (const g of m[1].matchAll(/'([^']+)'/g)) globs.push(g[1]);
  }
  // Mirrors eslint.config.js's own `ignores`, plus the two dirs that are RUNTIME STATE rather than shipped
  // code: .claude/ is the hook bundle Claudible injects into a workspace (gitignored, regenerated per run)
  // and .git/. Verified untracked+ignored before excluding them — not assumed.
  const ignores = ['node_modules', 'dist', 'runtime', 'patches', 'assets', path.join('test', 'fixtures'), '.git', '.claude'];
  // Star-replacement must run BEFORE the ** placeholder expands: `(?:.*/)?` contains a `*`, and replacing
  // stars afterwards mangled it into `(?:.[^/]*/)?` — a ONE-segment matcher. That made this pin blind to
  // files two+ directories deep (test/e2e/findings/ was flagged unlinted while real eslint linted it fine).
  const toRe = (g) => new RegExp('^' + g.split('/').map((p) => p === '**' ? '@@' : p)
    .join('/').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
    .replace(/@@\//g, '(?:.*/)?').replace(/@@/g, '.*') + '$');
  const res = globs.map(toRe);
  const walk = (dir, acc) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir || '.'), { withFileTypes: true })) {
      const rel = dir ? dir + '/' + e.name : e.name;
      if (ignores.some((i) => rel === i || rel.startsWith(i + '/'))) continue;
      if (e.isDirectory()) walk(rel, acc);
      else if (e.name.endsWith('.js')) acc.push(rel);
    }
    return acc;
  };
  const unmatched = walk('', []).filter((f) => !res.some((re) => re.test(f)));
  none('a shipped .js file matches no ESLint glob (0 rules — lint would pass by omission)', unmatched);
}

// ---------------------------------------------------------------------------------------------------------
// 64. THE INLINE RENAME FIELD MUST ACTUALLY BE USABLE. Two leftovers from the flex conversion, both measured:
//   .sess-rename kept a 44px right padding reserved for the ✓/✗ back when they were positioned OVER the input
//   (they became an in-flow sibling in 2799ffd), and .sess-meta — absolute and zero-width pre-flex — became a
//   real flex sibling that takes width while editing. Together: a saved row had 81.8px of usable text area and
//   a DRAFT row had 9.8px. After: 157px for both.
// ---------------------------------------------------------------------------------------------------------
{
  const flat = HTML.replace(/\s*\n\s*/g, '');
  none('the rename input keeps a padding reserve for buttons that no longer overlap it',
    /\.sess-rename\{[^}]*padding:4px 7px/.test(flat) && !/\.sess-rename\{[^}]*padding:4px 44px/.test(flat)
      ? [] : ['.sess-rename still reserves right padding for the old absolute ✓/✗']);
  none('the meta cluster still steals width from the rename field (a draft row had 9.8px to type in)',
    /\.sess\.renaming \.sess-meta\{display:none\}/.test(flat)
      ? [] : ['no .sess.renaming .sess-meta guard — unlike its menu-btn / flair / live-ind siblings']);
}

// ---------------------------------------------------------------------------------------------------------
// 65. THE RELEASE NOTES MUST NOT SILENTLY DEGRADE. build.yml's release step awks the `## [<tag version>]`
//   block out of CHANGELOG.md and uses it as the GitHub Release body — but that step ends in `|| true` (on
//   purpose: a notes problem must never abort a publish whose installers already built). So if no heading
//   matches, or the section is empty, the release publishes with a bare "See CHANGELOG.md" link and NOTHING
//   turns red. The tag must equal package.json's version (build.yml hard-fails otherwise), so package.json is
//   the version to check here. This is the one gate on that path; docs/RELEASE-CHECKLIST.md §1 says so too.
//   The drift is real: this file sat 40 commits behind its own heading, including the view-only-by-default
//   change and every session/sidebar fix — all of which would have been absent from the release page.
// ---------------------------------------------------------------------------------------------------------
{
  const VERSION = JSON.parse(read('package.json')).version;
  const CHANGELOG = read('CHANGELOG.md');
  // Mirror build.yml's awk exactly: from `## [<v>]` to the next `## [`.
  const lines = CHANGELOG.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## [${VERSION}]`));
  none(`CHANGELOG.md has no "## [${VERSION}]" heading (release notes would degrade to a bare link, silently)`,
    start < 0 ? [`package.json is ${VERSION}`] : []);
  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) if (lines[i].startsWith('## [')) { end = i; break; }
    const body = lines.slice(start + 1, end).join('\n').trim();
    none(`the "## [${VERSION}]" section is empty — the extracted release body would be the heading alone`,
      body.length > 40 ? [] : [`${body.length} chars`]);
  }
  // `## [Unreleased]` is fine as a placeholder, but content parked under it is NOT extracted by the awk above,
  // so it never reaches the release page. Catch a populated Unreleased sitting above the shipping version.
  const u = lines.findIndex((l) => l.startsWith('## [Unreleased]'));
  if (u >= 0) {
    let ue = lines.length;
    for (let i = u + 1; i < lines.length; i++) if (lines[i].startsWith('## [')) { ue = i; break; }
    const ubody = lines.slice(u + 1, ue).join('\n').replace(/<!--[\s\S]*?-->/g, '').trim();
    none('[Unreleased] has content — build.yml extracts only the version block, so this would not ship in the notes',
      ubody ? [`${ubody.split('\n')[0].slice(0, 60)}…`] : []);
  }
}

// ---------------------------------------------------------------------------------------------------------
// 66. DOCS MUST NOT DESCRIBE THE PRE-MULTI-TAB BRIDGE PATHS. status.json/hooks.ndjson have not been global
//   since tabs landed — they are per SPAWN, at runtime/tabs/<runtimeId>/ (nextRuntimeId(), read at the two
//   pollers). ARCHITECTURE.md and main.js's own header still named the old flat paths, which is the exact
//   "the doc reads true and is false" class: a reader debugging a stuck meter would look in a directory that
//   no longer exists. Any reference must carry the tabs/ segment.
// ---------------------------------------------------------------------------------------------------------
{
  const stale = [];
  for (const f of ['docs/ARCHITECTURE.md', 'README.md', 'main.js', 'CONTRIBUTING.md']) {
    let txt = ''; try { txt = read(f); } catch { continue; }
    for (const line of txt.split('\n')) {
      if (/runtime\/(status\.json|hooks\.ndjson)/.test(line)) stale.push(`${f}: ${line.trim().slice(0, 60)}`);
    }
  }
  none('a doc/comment still names the pre-tabs flat bridge path (runtime/status.json | runtime/hooks.ndjson)', stale);
  // and the real layout must still be what they were corrected TO
  none('main.js no longer writes/reads the per-tab bridge dir the docs describe',
    /path\.join\(RT, 'tabs', rec\.runtimeId, 'status\.json'\)/.test(MAIN)
    && /path\.join\(RT, 'tabs', rec\.runtimeId, 'hooks\.ndjson'\)/.test(MAIN) ? [] : ['runtime/tabs/<runtimeId>/ poller paths not found in main.js']);
}

// ---------------------------------------------------------------------------------------------------------
// 67. THE INSTALLER RESULT MUST STAY BANNER-PROOF, AND ITS ERRORS HUMAN. runScript wraps scripts in
//   `bash -lc` — a LOGIN shell — so profile banners (nvm/conda/MOTD) print above the script's one JSON line.
//   onboard:install-claude used to bare-JSON.parse that stdout AND discard runScript's `err` (it never
//   rejects — it RESOLVES {err, stdout}), so a timeout read as a generic "no output" and a banner read as a
//   SyntaxError shown to the user. Pins: the handler extracts via lastJsonLine and consults err; the wizard's
//   error filter knows the SyntaxError and raw .NET shapes; both signIn()s carry the in-flight guard
//   (onboardClaudeLogin RESPAWNS the fg tab — a double-click is the duplicate-spawn class, again).
// ---------------------------------------------------------------------------------------------------------
{
  none('onboard:install-claude parses stdout raw again (one profile banner breaks the wizard)',
    /ipcMain\.handle\('onboard:install-claude'[\s\S]{0,900}?lastJsonLine\(stdout/.test(MAIN)
      ? [] : ['the handler does not extract its result with lastJsonLine']);
  none('onboard:install-claude still throws away runScript’s err (a timeout would read "no output")',
    /ipcMain\.handle\('onboard:install-claude'[\s\S]{0,900}?if \(err\) return \{ ok: false, error: err\.message/.test(MAIN)
      ? [] : ['the handler does not surface err when no JSON came back']);
  none('main.js does not import the extractor it depends on',
    /require\('\.\/lib\/lastJsonLine'\)/.test(MAIN) ? [] : ['lastJsonLine require missing']);
  // the renderer filter learned the two unreadable-internals shapes
  none('installErrText no longer catches a JSON SyntaxError reaching the DOM',
    /is not valid JSON\|\^SyntaxError\\b/.test(APP) ? [] : ['no SyntaxError branch in installErrText']);
  none('installErrText no longer catches raw .NET/PowerShell error text',
    /System\\\.\[A-Za-z\.\]\*Exception/.test(APP) ? [] : ['no .NET branch in installErrText']);
  // both sign-in buttons: exactly two signIn functions, each guarded
  const signIns = [...APP.matchAll(/async function signIn\(\) \{\n\s*if \(signInFlight\) return;/g)];
  none('a signIn() lost its in-flight guard (double-click respawns the fg tab twice)',
    signIns.length === 2 ? [] : [`found ${signIns.length} guarded signIn()s, expected 2`]);

  // The wizard's GitHub step is a real CONNECT, not printed shell instructions (the packaged-install smoke
  // found nobody ever connected from the old DIY text). Guarded one-click flow: device code shown in the
  // wizard, main opens ONLY the fixed github device URL (never a URL parsed from child output — a hostile
  // PATH gh must not choose what we open), and ✓ lands via the status poll, which must cover the gh step.
  // That step is 3, not 4, since the create-project step was removed (see the superseded R23 note above) —
  // the number is asserted against goGh() in that block so the two can never drift apart silently.
  none('the wizard gh step regressed to DIY instructions (no guarded connect action)',
    /async function connectGh\(\) \{\n\s*if \(ghFlight\) return;/.test(APP) && /claudible\.onboardGhLogin\(\)/.test(APP) ? [] : ['no guarded connectGh()']);
  none('the gh install button lost its guard or its preflight route',
    /async function installGh\(\) \{\n\s*if \(ghFlight\) return;/.test(APP) && /preflightInstall\('gh'\)/.test(APP) ? [] : ['no guarded installGh()']);
  none('gh-login opens a child-supplied URL (must be the fixed device page)',
    MAIN.includes("shell.openExternal('https://github.com/login/device')") ? [] : ['gh-login openExternal is not the fixed URL']);
  none('the wizard poll ignores the gh wait (the gh step could never flip to ✓)',
    /step === 3 && ghWaiting/.test(APP) ? [] : ['tick has no gh-step branch']);
  none('preload: onboardGhLogin is not bridged',
    /onboardGhLogin: \(\) => ipcRenderer\.invoke\('onboard:gh-login'\)/.test(PRELOAD) ? [] : ['no onboardGhLogin bridge']);

  // REPAIR MODE: the wizard was first-run-only, and dismiss() persists onboardingDone — so a user who LOST a
  // required dep afterwards (an uninstall, an AV quarantine, a half-elevated teardown) had no way back to the
  // installer UI, even though detection and every per-row Install button still worked. Nothing was broken but
  // the door. It must reopen on a blocking row, reuse sysBlocking (one definition of "blocking", so the thing
  // that POPS the wizard and the thing that HOLDS it open cannot drift), and stay off the boot path.
  none('the wizard can no longer reopen when a required dep goes missing',
    /async function maybeRepair\(\)/.test(APP) && /setTimeout\(maybeRepair, \d+\)/.test(APP) ? [] : ['no maybeRepair boot hook']);
  // TWO CLAUDES ON ONE TRANSCRIPT: the tab scan in openSession only sees sessions already ADOPTED into a tab
  // record, and a tab records its session only after sessionOpen's IPC resolves. Two clicks inside that window
  // both passed and spawned a second claude on the same id — the frozen-terminal failure, seen live as two
  // claude.exe processes resuming one session. The in-flight set must be checked BEFORE the spawn and released
  // in `finally`, or a refusal/throw strands the id and the session becomes permanently un-openable.
  // GIT-BASH RESOLUTION: `where bash.exe` returns C:\Windows\System32\bash.exe FIRST on every Windows box with
  // WSL enabled — that is the WSL launcher, not MSYS. Taking hit [0] blind meant cygpath was missing, appDirGuest
  // threw, APPDIR_WSL went falsy, and every workspace/sync/diff path short-circuited to ERR_NO_BACKEND while the
  // terminal and voice kept working — so the only symptom was that sync silently did nothing. Validate the pick,
  // walk EVERY hit, and never pay a process spawn for the two paths that are never MSYS.
  const WINR = read('runners/win.js');
  none('gitBash accepts an unvalidated bash again (WSL\'s launcher wins `where` on every WSL-enabled box)',
    /function isGitBash\(p\)/.test(WINR) && /if \(!isGitBash\(c\)\) return false;/.test(WINR) ? [] : ['no MSYS validation in gitBash']);
  none('gitBash still takes only the FIRST `where bash.exe` hit (a real Git Bash further down never gets a look)',
    /for \(const h of cp\.execFileSync\('where', \['bash\.exe'\][\s\S]{0,120}?if \(take\(h\)\)/.test(WINR) ? [] : ['where fallback does not iterate every hit']);
  none('the WSL launcher is probed by execution again (measured 15s to say no)',
    /system32\|sysnative\|windowsapps/i.test(WINR) ? [] : ['no location-based WSL rejection']);
  none('the MSYS probe uses a LOGIN shell again (bash -lc measured 37s vs 5s for -c)',
    /'-c', 'command -v cygpath'/.test(WINR) && !/'-lc', 'command -v cygpath'/.test(WINR) ? [] : ['probe uses a login shell']);
  none('openSession lost its in-flight dedupe (a double-click spawns a second claude on one transcript)',
    /if \(_openingSessions\.has\(id\)\) return;/.test(APP) && /_openingSessions\.add\(id\)/.test(APP) ? [] : ['no in-flight session guard']);
  none('the in-flight session guard is not released in finally (a strand makes the session un-openable)',
    /finally \{ if \(id !== 'new'\) _openingSessions\.delete\(id\); \}/.test(APP) ? [] : ['guard not released in finally']);
  none('repair mode re-derives "blocking" instead of reusing sysBlocking (the two can drift apart)',
    /const bad = r\.deps\.filter\(\(d\) => d && sysBlocking\(d\)\);/.test(APP) ? [] : ['maybeRepair does not use sysBlocking']);
  none('a failed dep probe can throw the full-screen wizard up ("could not check" is not "missing")',
    /if \(!r \|\| r\.unavailable \|\| !Array\.isArray\(r\.deps\) \|\| !r\.deps\.length\) return;/.test(APP) ? [] : ['maybeRepair does not bail on an unusable probe']);
}

// ---------------------------------------------------------------------------------------------------------
// 68. A SPAWN-PATH THROW MUST REACH THE TERMINAL, AND A LONG PATH MUST EXPLAIN ITSELF. installHooks throwing
//   (ENAMETOOLONG from a deep adopted folder) used to bubble uncaught out of the tab-spawn handler — the
//   terminal showed NOTHING. main.js now catches around runner.spawnClaude and prints e.message on the same
//   pty:data surface the null case uses; win.js classifies ENAMETOOLONG into the complete instruction
//   (shorter folder, or LongPathsEnabled + restart). Both halves pinned — either alone is inert: an
//   unclassified throw prints raw internals, an uncaught classified throw prints nothing.
// ---------------------------------------------------------------------------------------------------------
{
  const WIN = read('runners/win.js');
  none('main.js lets a spawnClaude throw escape the tab-spawn handler again (a thrown error shows NOTHING)',
    /let proc = null, spawnErr = '';\s*\n\s*try \{ proc = runner\.spawnClaude\(/.test(MAIN)
      && /catch \(e\) \{ spawnErr = \(e && e\.message\) \|\| String\(e\);/.test(MAIN)
      ? [] : ['no try/catch around runner.spawnClaude with spawnErr surfacing']);
  none('…or swallows spawnErr instead of printing it to the terminal',
    /\$\{spawnErr \|\| `terminal backend \(node-pty\) unavailable: \$\{pty\.err\}`\}/.test(MAIN)
      ? [] : ['the !proc branch no longer prefers the thrown message']);
  none('win.js installHooks lost its ENAMETOOLONG classification (a long path throws raw internals again)',
    /const guardLongPath = \(fn, p\) => \{[\s\S]{0,300}?e\.code === 'ENAMETOOLONG'/.test(WIN)
      && /guardLongPath\(\(\) => \{ fs\.mkdirSync\(cdir, \{ recursive: true \}\); fs\.mkdirSync\(rt, \{ recursive: true \}\); \}, cdir\)/.test(WIN)
      ? [] : ['guardLongPath missing or not wrapping the mkdir pair']);
  none('the long-path message stopped carrying its fix',
    /LongPathsEnabled/.test(WIN) ? [] : ['no LongPathsEnabled instruction in the classified error']);
}

// ---------------------------------------------------------------------------------------------------------
// 69. "NEW SESSION" LIVES IN THE MANAGE MENU, NOT IN THE SCROLLING TREE. The inline row sat inside
//   .ws-children — i.e. inside #ws-chips, the ONE scroll container, between project chips — so its 31px moved
//   with every list resize, it was .remove()d/re-appended on all 14 renderWsChips() call sites, and the
//   scrollTop save/restore around that render clamped differently once its height appeared. Three ways for the
//   whole sidebar to shift. Pins: the row is gone everywhere, the menu offers it FIRST, and the action targets
//   the project whose menu was opened (w.id) — never the ambient activeWsId, since a menu opens on any project.
// ---------------------------------------------------------------------------------------------------------
{
  none('the inline "+ New Session" row is back in the sidebar (it re-enters the scroll flow it was removed from)',
    [/id="new-session"/.test(HTML) ? 'index.html still has #new-session' : '',
     /\.newsess-row\{/.test(HTML) ? 'index.html still styles .newsess-row' : '',
     /new-session|newsess-row|newSessEl/.test(APP) ? 'app.js still references the removed row' : ''].filter(Boolean));
  none('the create action is not the FIRST item of a project’s manage menu',
    /const items = \[\];[\s\S]{0,600}?items\.push\(\{\s*\n\s*icon: PLUS_SVG, accent: true, label: 'New session'/.test(APP)
      ? [] : ['wsMenuItems does not push the New session item first']);
  none('…or it targets the ambient activeWsId instead of the project whose menu is open',
    /act: \(\) => promptNewSession\(w\.id\)/.test(APP) && /async function promptNewSession\(wsId\)/.test(APP)
      && /newBlankTab\(wsId \|\| activeWsId, 'new', name \|\| ''\)/.test(APP)
      ? [] : ['promptNewSession is not project-parameterised end to end']);
  none('the double-click guard was lost when the handler moved out of the sidebar',
    /let newSessionPrompting = false;[\s\S]{0,900}?if \(newSessionPrompting\) return;/.test(APP)
      ? [] : ['promptNewSession has no in-flight guard (two dialogs / two tabs)']);
  none('the green + cannot render — the accent flag or its CSS is missing',
    /\(it\.accent \? ' accent' : ''\)/.test(APP) && /const PLUS_SVG =/.test(APP)
      && /\.ws-menu \.ws-mi\.accent \.ws-mi-ic\{color:var\(--ok\)\}/.test(HTML)
      ? [] : ['accent class, PLUS_SVG or the .ws-mi.accent rule is absent']);
}

// ---------------------------------------------------------------------------------------------------------
// 70. ONE CONVENTION FOR A STATUS LIGHT: LEFT OF THE NAME. A session's busy dot is a ::before on .sess-prev,
//   with index.html's own note — "a status light belongs at the left edge, not buried in the right cluster".
//   The project chip's .ws-dot contradicted that: it was appended into .ws-right, pressed against the manage
//   button. Pins the dot's position (before .ws-name, out of .ws-right), and that its slot is RESERVED when
//   idle — an unreserved dot would shift the project name every time share/sync is toggled, which is the class
//   of movement this sidebar has been getting rid of.
// ---------------------------------------------------------------------------------------------------------
{
  none('the project status dot is back in the right cluster (crowds the manage button, splits the convention)',
    /right\.appendChild\(dot\)/.test(APP) ? ['.ws-dot is appended into .ws-right again'] : []);
  none('…or no longer leads the chip, immediately before the project name',
    /chip\.appendChild\(dot\);\s*\n\s*const nm = document\.createElement\('span'\); nm\.className = 'ws-name'/.test(APP)
      ? [] : ['the dot is not built directly before .ws-name']);
  none('the idle slot is no longer reserved — toggling share/sync will nudge the project name',
    /' off'/.test(APP) && /\.ws-chip \.ws-dot\.off\{visibility:hidden\}/.test(HTML)
      ? [] : ['no .off class on the idle dot, or no visibility:hidden rule for it']);
  // the session side of the convention must stay put, or "one standard" quietly becomes none
  none('a session\u2019s status light left the left edge (the convention this dot was aligned to)',
    /\.sess\.busy:not\(\.sess-draft\) \.sess-prev::before\{/.test(HTML)
      ? [] : ['the busy dot is no longer a ::before on .sess-prev']);
}

// ---------------------------------------------------------------------------------------------------------
// 71. ICON CLUSTERS USE ONE GAP EACH. Two spacing anomalies a user's eye caught before any test did:
//   (a) a selected session row's cluster ran 5px between flairs but 8px before the ▾ — .sess-meta{gap:5px}
//       against .sess{gap:6px} PLUS .sess-menu-btn{margin-left:2px}. Measured 4.25px glyph-to-glyph.
//   (b) the chip's manage+collapse pair sat 6px apart (13.5px glyph-to-glyph) reading as two loose buttons.
//   Both are pure spacing, but they are the visible kind of wrong, so they get pinned. The ▾ stays 22px on
//   purpose — it is what sets the 29px row height (see check 64 and .sess-skel's strut); shrinking it to match
//   the 18px flairs would silently resize every row.
// ---------------------------------------------------------------------------------------------------------
{
  const flat = HTML.replace(/\s*\n\s*/g, '');
  none('the session meta cluster is back to a gap that differs from the row it sits in',
    /\.sess-meta\{display:flex;align-items:center;gap:6px\}/.test(flat) ? [] : ['.sess-meta gap is not 6px (the row\u2019s own gap)']);
  none('the options button re-grew its extra margin (8px before the ▾, 6px everywhere else)',
    /\.sess-menu-btn\{flex:none;margin-left:/.test(flat) ? ['.sess-menu-btn has a margin-left again'] : []);
  none('the chip\u2019s two controls drifted apart again (they are one pair, not two buttons)',
    /\.ws-chip \.ws-right\{flex:none;display:flex;align-items:center;gap:2px;margin-left:6px\}/.test(flat)
      ? [] : ['.ws-right gap is not 2px']);
  // the ▾ must KEEP the 22px box the 29px row height is built on
  none('the session ▾ left its 22px box — every row height and the skeleton strut are derived from it',
    /\.sess-menu-btn\{[^}]*width:22px;height:22px/.test(flat) ? [] : ['.sess-menu-btn is no longer 22x22']);
}

// ---------------------------------------------------------------------------------------------------------
// 72. THE TWO ROW MENUS ARE ONE COMPONENT: same width rule, same positioning rule, mutually exclusive.
//   The project menu was given an INLINE width equal to its chip's full box (279px at a 289px sidebar — the
//   whole pane), while the session menu was content-sized by CSS. And both triggers call e.stopPropagation(),
//   which is exactly what prevented the OTHER menu's document-level click listener from firing — so the two
//   could sit open on top of each other. The mutual close lives INSIDE the openers, so all three trigger
//   sites inherit it and a fourth cannot forget it.
// ---------------------------------------------------------------------------------------------------------
{
  const flat = HTML.replace(/\s*\n\s*/g, '');
  none('openWsMenu forces an inline width again (the menu re-covers the sidebar)',
    [/m\.style\.width = Math\.round\(r\.width\)/.test(APP) ? 'inline width from the chip box is back' : '',
     /m\.style\.minWidth = '0'/.test(APP) ? "minWidth:'0' overrides the shared floor" : ''].filter(Boolean));
  none('the two menus no longer share ONE width rule',
    /\.ws-menu\{min-width:184px;max-width:232px;/.test(flat) ? [] : ['.ws-menu lost its shared min/max width']);
  none('the project menu stopped being positioned from its own trigger like the session menu is',
    /const r = btn\.getBoundingClientRect\(\), mw = m\.offsetWidth, mh = m\.offsetHeight;/.test(APP)
      ? [] : ['openWsMenu does not use the session menu’s trigger-anchored math']);
  none('opening a project menu leaves a session menu (or the info popover) open underneath',
    /function openWsMenu\(btn, chip, nm, w\) \{[\s\S]{0,700}?closeSessMenu\(\); closeWsInfo\(\);/.test(APP)
      ? [] : ['openWsMenu does not close its sibling popovers']);
  none('…or the reverse: opening a session menu leaves the project menu open',
    /function openSessMenu\(btn, row, items, key\) \{[\s\S]{0,300}?closeWsMenu\(\); closeWsInfo\(\);/.test(APP)
      ? [] : ['openSessMenu does not close its sibling popovers']);
  none('the New-session separator is back (a 1px rule reading as a hole in the menu)',
    /act: \(\) => promptNewSession\(w\.id\),\s*\n\s*\}\);\s*\n\s*items\.push\(\{ sep: true \}\);/.test(APP)
      ? ['a separator was re-added under New session'] : []);
}

// ---------------------------------------------------------------------------------------------------------
// 73. THE REPAIR WIZARD MUST NOT OPEN OVER THE SETTINGS DRAWER. maybeRepair() guards `done`, an already-shown
//   wizard, and any other `.approve.show` — but the drawer is NOT a `.approve` modal, so none of those saw it.
//   #wizard is `.approve` at z-index 10000; the drawer is 9001; nothing enforced mutual exclusion. 2.5s after
//   every boot the wizard could therefore drop its full-screen scrim over an open drawer and swallow EVERY
//   click in it — reported as "the username field is unclickable", which is #collab-name-in sitting under a
//   scrim nobody could see. Strictly worse on Windows: a dead script backend makes preflightStatus() misreport
//   deps as missing, which is exactly what makes sysBlocking fire and the wizard reopen.
// ---------------------------------------------------------------------------------------------------------
{
  const mr = (APP.match(/async function maybeRepair\(\) \{[\s\S]*?\n  \}/) || [''])[0];
  none('maybeRepair lost its drawer guard (the wizard scrim re-covers an open Settings drawer)',
    /if \(drawer\.classList\.contains\('open'\)\) return;/.test(mr) ? [] : ['no drawer guard in maybeRepair']);
}

// ---------------------------------------------------------------------------------------------------------
// 76. 2g — `gh auth login` IS REACHABLE FROM THE RUNNING APP. The wizard's one-click connect exists only inside
//   the wizard, which after the repair fix reopens ONLY for a sysBlocking dep — and a gh that is installed but
//   signed out is not blocking, so it never returns for it. Settings shows no gh status (W4, Phase 3). That left
//   the single command that unblocks sync as something the user had to know by heart. It rides the git menu's
//   existing gitCmd path (types into the live terminal), so the device-code flow is readable and answerable.
// ---------------------------------------------------------------------------------------------------------
{
  none('the git menu lost its connect-GitHub item (gh auth login is unreachable in-app again)',
    /id="git-ghauth"/.test(HTML) ? [] : ['#git-ghauth is not in the git menu']);
  none('connect-GitHub stopped routing through gitCmd (it must land in the live terminal, not a shell-out)',
    /\$\('git-ghauth'\)\.addEventListener\('click', \(\) => gitCmd\('gh auth login'\)\)/.test(APP)
      ? [] : ['#git-ghauth does not call gitCmd(\'gh auth login\')']);
  none('the git button\'s tooltip no longer names all three actions',
    /id="git-btn" title="Git — push \/ pull \/ connect GitHub"/.test(HTML) ? [] : ['#git-btn title is stale']);
}

// ---------------------------------------------------------------------------------------------------------
// 75. S1 — AUTOMATIC DISCOVERY MUST ANNOUNCE ITSELF. The manual Check-for-invites button toasts; the boot timer
//   and maybeDiscoverOnFocus did not, so an invited project appeared as an inert sidebar row and nothing said a
//   single click sets it up (three sat unnoticed on a real machine). Q3 decided first-sighting-per-repo-per-run:
//   a toast on every focus rediscovery would nag daily about an invite deliberately not accepted. The dedupe set
//   is the whole mechanism, so pin it — and pin that an EMPTY added list stays quiet, since workspace:added also
//   fires when discovery merely reconciled a rename.
//   NOT pinned as changed: the clone-on-consent gate. It is deliberate and load-bearing for privacy.
// ---------------------------------------------------------------------------------------------------------
{
  const wa = (APP.match(/claudible\.onWorkspaceAdded\(\(list\) => \{[\s\S]*?\n\}\);/) || [''])[0];
  none('automatic discovery went silent again (an invited project is an inert row nobody knows to click)',
    /toast\(fresh\.length === 1/.test(wa) ? [] : ['onWorkspaceAdded does not toast a fresh invite']);
  none('the per-run dedupe is gone (every window focus re-nags about the same invite)',
    /_invitesAnnounced/.test(wa) && /new Set\(\)/.test(APP) ? [] : ['no first-sighting-per-repo set']);
  none('an empty added list can toast again (discovery fires workspace:added on a rename-only reconcile)',
    /if \(!fresh\.length\) return;/.test(wa) ? [] : ['no empty-list guard']);
}

// ---------------------------------------------------------------------------------------------------------
// 74. I4 — A REFUSAL MUST SAY WHICH GUARD FIRED. respawnPty has four deliberate refusal branches and every one
//   of them reached the renderer as a bare `{ ok:false }`, so "I can't open any session but the active one"
//   was indistinguishable from a dead click. The reason travels BESIDE the boolean (a module-level token read
//   same-tick by session:open) because respawnPty's synchronous true/false contract must not change — nine
//   call sites use `!respawnPty(...)` as a guard and a Promise would make every one of them stop refusing.
//   'open-elsewhere' is the load-bearing one: main's dedupe is NOT workspace-scoped while the renderer's
//   existing-tab scan IS, so a session open in another PROJECT's tab could never be opened and never said why.
// ---------------------------------------------------------------------------------------------------------
{
  const so = (MAIN.match(/ipcMain\.handle\('session:open'[\s\S]*?\n\}\);/) || [''])[0];
  none('session:open dropped the refusal reason (a refused click is a dead click again)',
    /reason: _lastRespawnRefusal \|\| 'refused'/.test(so) ? [] : ['session:open returns a bare {ok:false}']);
  none('respawnPty stopped recording WHICH guard refused',
    ["'live'", "'busy'", "'open-elsewhere'", "'live-shared'"].filter((t) => !MAIN.includes('_lastRespawnRefusal = ' + t)));
  none('the renderer mints a tab main will refuse for a session already open elsewhere',
    /r\.reason === 'open-elsewhere'[\s\S]{0,600}?setActiveTab\(rec\.tabId\)/.test(APP)
      ? [] : ['openSession does not focus the owning tab on open-elsewhere']);
}

// ---------------------------------------------------------------------------------------------------------
// 77. P — "COULD NOT LOOK" MUST NOT RENDER AS "GENUINELY EMPTY". session:list-ws returned a bare [] on its two
//   entry gates (no script backend / unknown project) while the REST of the same handler already resolved a
//   typed {error} for a fetch failure — precisely so a failure could not masquerade as an empty list. Those two
//   lines were the hole, and sessionToOpenFor could not tell the cases apart: it branched on Array.isArray for
//   CACHING only, then fell through to 'new' regardless. Result: a phantom "New session" over a project full of
//   work, which reads as data loss. Fourth trigger of this class (b68027c, e10ff48, ab0b8fa + 3c63eea before).
//   The signal rides an OPTIONAL out-object, never a changed return type: this codebase's recurring injury is
//   one missed call site silently disarming a guard, and a caller that ignores `out` behaves exactly as before.
//   NOT claimed fixed: a LOCAL, non-shared project with the backend down still has no in-session recovery
//   (onSyncChanged fires only for repo-backed, sync-enabled projects). The draft becomes honest and
//   reconcilable — it is not repaired.
// ---------------------------------------------------------------------------------------------------------
{
  const lw = (MAIN.match(/ipcMain\.handle\('session:list-ws'[\s\S]*?\n\}\)\);/) || [''])[0];
  none('session:list-ws resolves a bare [] again (a dead backend reads as "this project is empty")',
    /return resolve\(\{ error: ERR_NO_BACKEND \}\);/.test(lw) && /return resolve\(\{ error: 'no such project' \}\);/.test(lw)
      ? [] : ['the entry gates do not return the typed shape the rest of the handler already uses']);
  none('…or the merged bare-[] gate came back',
    /if \(!APPDIR_WSL \|\| !ws\) return resolve\(\[\]\);/.test(lw) ? ['the bare-[] gate is back'] : []);
  none('sessionToOpenFor stopped recording that it could not look',
    /else if \(out\) out\.unknown = true;/.test(APP) && /catch \{ if \(out\) out\.unknown = true; \}/.test(APP)
      ? [] : ['no unknown signal on a typed error or on a throw']);
  none('an unknown-derived draft is no longer announced or reconcilable',
    /function noteUnknownSessions\(info\)/.test(APP)
      && (APP.match(/noteUnknownSessions\(/g) || []).length >= 4   // the definition + all three tab-minting sites
      ? [] : ['noteUnknownSessions is missing from a tab-minting path']);
}

// ---------------------------------------------------------------------------------------------------------
// 78. V-button — THE VOICE INSTALL BUTTON, ALL THREE CAUSES. It survived every previous voice fix because
//   setup-win.ps1 was only ever proven by running it MANUALLY, which bypasses all three of these.
//   (1) APPDIR_WSL is a boot-time snapshot and the win runner memoizes beside it, so on a fresh machine — where
//       the wizard installs Git moments earlier — it stays null all session and the voice branch could never
//       install. The generic dep path drops those caches after an install; the voice special-case RETURNS
//       BEFORE that line. It must re-derive, and it must SAY which gate closed instead of a bare {ok:false}.
//   (2) The lock's pid liveness probe had no age cap. Windows recycles pids, so a crash between writing the
//       lock and dropping it could wedge voice permanently behind an unrelated process.
//   (3) "Install all missing" broke out of the loop on the first restart-requiring dep. Git has
//       restartOnInstall and sorts SECOND, so on a fresh machine claude/uv/voice/cloudflared/gh were never
//       attempted, nothing said so, and restartNeeded is in-memory only so nothing resumed after the relaunch.
//   (1) and (3) MUST ship together: landing (1) alone still leaves "install all" visibly stalling after Git,
//   and the team credits the wrong fix. Pinned together for that reason.
// ---------------------------------------------------------------------------------------------------------
{
  none('the voice branch trusts the boot-time app-dir snapshot again (voice cannot install until a restart)',
    /function appDirNow\(\)/.test(MAIN) && /if \(!appDirNow\(\)\) return false;/.test(MAIN)
      ? [] : ['ensureVoiceProvisioned does not re-derive the app dir']);
  none('a declined voice install went silent again (the row snaps back to "install" with no reason)',
    /return \{ ok: false, error: why, restartRequired: false \};/.test(MAIN) ? [] : ['no typed reason from the win voice branch']);
  none('the voice lock lost its age cap (a recycled Windows pid wedges voice forever)',
    /VOICE_LOCK_MAX_MS/.test(MAIN) && /ageMs < VOICE_LOCK_MAX_MS && Number\.isFinite\(pid\)/.test(MAIN)
      ? [] : ['the pid probe runs without an age cap']);
  // Scoped to the function BODY and comment-stripped: the prose above installAllMissing quotes the very line it
  // removed, and a whole-file match happily passed on that quotation — the comment-blindness trap this file
  // warns about at the top, walked into while writing a pin about walking into traps.
  const iam = (APP.match(/async function installAllMissing\(\) \{[\s\S]*?\n  \}/) || [''])[0].replace(/\/\/.*$/gm, '');
  none('install-all abandons the list on the first restart-requiring dep again (2a(3) — ships WITH 2a(1))',
    /for \(const id of ids\) await installDep\(id\);/.test(iam) && !/\bbreak;/.test(iam)
      ? [] : ['installAllMissing still breaks out of its loop']);
  none('provision-win.ps1 quietly grew a voice case with no implementation',
    /ValidateSet\('node', 'git', 'claude', 'uv', 'cloudflared', 'gh', 'ffmpeg'\)/.test(read('setup/provision-win.ps1'))
      ? [] : ['the ValidateSet changed — voice must not be accepted without a real switch case']);
}

// ---------------------------------------------------------------------------------------------------------
// 79. X/2d — respawnPty STAYS SYNCHRONOUS. This is the #1 entry on the patch plan's risk register, and it is a
//   silent failure, which is why it gets a pin rather than a code review. On Windows the facade's kill fires
//   `taskkill /T /F` detached and returns immediately, so the replacement claude used to spawn in the SAME TICK
//   as the old one died — two claudes on one transcript, and Claude Code's "already running or being resumed"
//   modal swallows every keystroke including space. The sync-triggered reload path reaches this, and neither
//   e10ff48 nor d42bd8d covers it: both guard USER-initiated opens only.
//
//   The obvious fix — make respawnPty async and await the kill — is a TRAP. Nine call sites use
//   `!respawnPty(...)` as a guard, several in plain synchronous contexts (a share-server callback, session:open,
//   claude:refresh-session, openWorkspaceInTab). `!Promise` is ALWAYS false, so miss one and the busy guard, the
//   one-session-one-claude dedupe (the d42bd8d fix) and the live-reroute refusal all quietly stop refusing —
//   no error, no log, no failing test, and the bug this fixes comes back wearing a different hat.
//   So: the wait lives INSIDE, after every guard has run and after `true` has been decided.
//   If a future session proposes making this async, this pin is the answer.
// ---------------------------------------------------------------------------------------------------------
{
  const rp = (MAIN.match(/\nfunction respawnPty\(tabId, session, opts\) \{[\s\S]*?\n\}/) || [''])[0];
  none('respawnPty stopped being synchronous — `!respawnPty(...)` becomes `!Promise` (always false) at nine call sites',
    [/\nasync function respawnPty\(/.test(MAIN) ? 'declared async' : '',
     /\bawait\b/.test(rp) ? 'awaits inside the body' : '',
     /return new Promise/.test(rp) ? 'returns a Promise' : '',
     rp ? '' : 'respawnPty could not be located at all'].filter(Boolean));
  none('every respawnPty exit is still a literal boolean',
    (rp.match(/^ {2}return .*/gm) || []).filter((r) => !/^ {2}return (true|false);$/.test(r)));
  none('the Windows spawn is no longer deferred until the old tree is reaped (the two-claude window is back)',
    /old\.kill\(undefined, doSpawn\); killWaits = true;/.test(rp) && /setTimeout\(doSpawn, 1500\)/.test(rp)
      ? [] : ['respawnPty does not wait for the taskkill callback on win']);
  // …and the wait must stay NARROW. Deferring every respawn made an ordinary A→B session switch queue claude's
  // boot behind taskkill instead of overlapping it — a visible ~1s black screen, reported on real hardware the
  // same day 2d shipped. The collision needs ONE transcript, so only a same-transcript respawn can hit it.
  // Both directions are pinned: broaden this and the black screen returns, drop it and the race returns.
  none('the deferral went back to blocking EVERY respawn (the 1s black screen on every session switch)',
    /const sameTranscript = !!rec && session !== 'new' && \(!session \|\| session === rec\.session\);/.test(rp)
      && /runner\.id === 'win' && sameTranscript/.test(rp)
      ? [] : ['the win deferral is not gated on sameTranscript']);
  none('the supersede token is gone (a second respawn inside the window can double-spawn again)',
    /_respawnPending\.get\(tabId\) !== spawnToken/.test(rp) ? [] : ['no token check before the deferred spawn']);
  none('win.js kill stopped reporting when the tree is reaped',
    /kill\(signal, onReaped\)/.test(read('runners/win.js')) && /c\.once\('exit', settleOnce\); c\.once\('error', settleOnce\);/.test(read('runners/win.js'))
      ? [] : ['the facade kill lost its optional reaped callback']);
  none('…and listening for the reap must not have cost us the detach (the quit sweep outlives app.quit())',
    /c\.unref\(\);/.test(read('runners/win.js')) ? [] : ['taskkill child is no longer unref\'d']);
}

// ---------------------------------------------------------------------------------------------------------
// 80. 3a/L1-L3 — JOINING BEFORE THE HOST IS READY. Presence arrives in two phases: a phase-1 stamp the moment
//   the host clicks Share, then the full url+token handle a few seconds later once their tunnel is up. The row
//   appeared immediately and was INERT for those seconds — which is precisely the window in which someone
//   watching for it tries to click. The click did nothing, said nothing, and the affordance changed under the
//   pointer when the handle landed.
//   Three parts, all riding machinery that already existed:
//     L1 both phases build the SAME joinable button, so the "Join →" hover applies throughout
//     L2 an early click builds the tab, parks it in 'starting', and returns BEFORE liveConnect (nothing to dial)
//     L3 'starting' joins LIVE_RECONNECTABLE, so reconcileJoinedTabs — which already re-derives each tracked
//        session's peer every poll and connects when a handle appears (built for host-handle ROTATION) —
//        promotes that waiting tab by itself. One click, no second click, no new poll.
// ---------------------------------------------------------------------------------------------------------
{
  none('L3: a waiting tab can no longer be auto-promoted when the handle lands',
    /const LIVE_RECONNECTABLE = new Set\(\['offline', 'reconnecting', 'starting'\]\);/.test(APP)
      ? [] : ["'starting' is not in LIVE_RECONNECTABLE — an early join would wait forever"]);
  none('L2: an early join dials a handle that does not exist yet, or never returns early',
    /if \(!peer\.url \|\| !peer\.token\) \{\s*\n\s*setLiveState\(rec, 'starting'\);[\s\S]{0,200}?return;\s*\n\s*\}/.test(APP)
      ? [] : ['openLiveTab does not park a handle-less peer in starting and return']);
  none('…and the top-of-function bail is back, which would make the click do nothing again',
    /if \(!peer\.url \|\| !peer\.token\) return;/.test(APP) ? ['openLiveTab still hard-returns on a phase-1 peer'] : []);
  none('L1: the whole phase-1 row is inert again',
    /\/\/ L1 — the whole row is clickable in BOTH phases now[\s\S]{0,300}?row\.addEventListener\('click', \(\) => openLiveTab\(peer\)\);/.test(APP)
      ? [] : ['renderLivePeerRow gates its click on !peer.starting again']);
  none('the waiting state has no words (a blank overlay is the dead click, wearing a scrim)',
    /starting: 'waiting to join…'/.test(APP) && /starting: 'Waiting for ' \+ who/.test(APP)
      ? [] : ['no label and/or no overlay copy for the starting state']);
}

// ---------------------------------------------------------------------------------------------------------
// 81. 3e/I1 — AN EXPLAINER MUST NOT COVER THE THING IT EXPLAINS. Both ⓘ popovers anchored at `r.bottom + 6`,
//   directly under the icon — which sits directly above the field the text is about. Opening one laid a 250px
//   panel over that input, and since a click INSIDE a popover is not an outside-click, the field stopped
//   responding until it was dismissed. That is the second half of "the username field is unclickable"; the
//   first half (the wizard scrim over the drawer) shipped in v0.9.1. Prefer ABOVE the icon — that space holds
//   the section label, never an input — and fall back to below only when there is genuinely no room.
// 82. W4/3d — GITHUB STATE IS VISIBLE OUTSIDE THE WIZARD. onboardStatus() always returned it; only the
//   first-run wizard rendered it, and that wizard now reopens only for a BLOCKING dep — which a gh that is
//   installed but signed out is not. So the dependency behind sync, invites and repo projects had no visible
//   state at all. The row reuses 2g's terminal route to connect rather than duplicating the device-code flow.
// ---------------------------------------------------------------------------------------------------------
{
  none('an ⓘ popover anchors below its icon again (it lands on the field it describes)',
    [/function placeInfoPop\(pop, anchor\)/.test(APP) ? '' : 'placeInfoPop is gone',
     /const above = r\.top - h - 6;/.test(APP) ? '' : 'placeInfoPop no longer prefers ABOVE the anchor',
     (APP.match(/pop\.style\.top = \(r\.bottom \+ 6\)/g) || []).length ? 'a popover still hard-codes bottom+6' : ''].filter(Boolean));
  // The trailing `;` is load-bearing: without it this also matched `function placeInfoPop(pop, anchor) {`
  // and counted the definition as a third call site. Same trap as the comment-blind matches elsewhere here.
  none('both ⓘ popovers must share the one placer (they drifted apart before)',
    (APP.match(/placeInfoPop\(pop, anchor\);/g) || []).length === 2
      ? [] : ['expected exactly 2 placeInfoPop call sites (workspace ⓘ + username ⓘ)']);
  none('Settings lost its GitHub row (the state sync/invites depend on is invisible again)',
    [/id="gh-text"/.test(HTML) ? '' : 'no #gh-text row in the drawer',
     /async function refreshGhRow\(\)/.test(APP) ? '' : 'no refreshGhRow()',
     // The rule defended here is "the GitHub row refreshes when Settings opens", not the literal neighbours it
     // used to share a line with: loadSkills/loadPlugins moved to the Skill & Strategy panel along with their
     // sections, and are pinned at their new address below. This now names openDrawer itself.
     /function openDrawer\(open\) \{[\s\S]{0,400}?refreshGhRow\(\)/.test(APP) ? '' : 'refreshGhRow is not wired to the drawer opening',
     // …and the inventory scans still run when the panel that OWNS those sections opens.
     /function openStrat\(open\) \{[\s\S]{0,400}?loadSkills\(\); loadPlugins\(\)/.test(APP) ? '' : 'loadSkills/loadPlugins are not wired to the Skill & Strategy panel opening',
     // both sections must actually live in that panel, or the scans paint into nothing
     /id="stratdrawer"[\s\S]*?id="skills-list"[\s\S]*?id="plugins-list"/.test(HTML) ? '' : 'skills/plugins are not inside #stratdrawer'].filter(Boolean));
  none('…and its dot has no reserved slot, so resolving the state nudges the text',
    /\.gh-dot\.off\{visibility:hidden\}/.test(HTML) ? [] : ['.gh-dot.off is not visibility:hidden — the same shift .ws-dot.off exists to prevent']);
  none('the Settings connect button duplicates the device-code flow instead of reusing 2g',
    /gitCmd\('gh auth login'\)/.test(APP) ? [] : ['#gh-connect does not route through gitCmd']);
}

// ---------------------------------------------------------------------------------------------------------
// 83. 3b/W1 — THE FOURTH PROJECT KIND. `local` makes a folder, `repo` MINTS a brand-new private repo, `adopt`
//   registers a folder already on disk. None of them could clone a repo that already EXISTS on GitHub — the
//   only path that did was invite/topic discovery, which requires someone to have invited you. So "I have a
//   repo, I want to work in it here" had no route at all.
//   It reuses ensureClone → clone-workspace.sh (the same generic `gh repo clone` discovery uses) WITHOUT the
//   invite gate: you named the repo, so there is nothing further to consent to.
//   Two decisions worth keeping:
//     · Q4 — accept `owner/repo` AND a pasted URL (and an ssh remote). A paste that silently fails is exactly
//       the class of silent refusal Phase 2 existed to delete.
//     · syncSessions stays OFF. An invite means "join our shared sessions"; importing your own repo means
//       "work here". Enabling sync would start publishing transcripts to a repo the user only wanted to code
//       in — and that is a decision with its own disclosure, one click away in the ▾ menu.
//   Registration is rolled BACK if the clone fails: a repo row that can never be cloned looks like a pending
//   invite and discovery would keep reconciling it.
// ---------------------------------------------------------------------------------------------------------
{
  // role= went from radio to button when the modal split in two: the tiles stopped SELECTING a value some later
  // control acts on and became the action itself. What this pin protects — that the import kind is reachable
  // from the modal — is unchanged, so it moved address rather than being relaxed.
  none('the New-project modal lost its import tile',
    /id="ch-import" data-kind="import" role="button"/.test(HTML) ? [] : ['index.html has no #ch-import tile']);
  none('…or the owner/repo field it needs',
    /id="ws-repo-in"/.test(HTML) ? [] : ['no #ws-repo-in input']);
  none('WS_KINDS cannot reach the import path',
    /const WS_KINDS = \[[^\]]*'import'[^\]]*\]/.test(APP) ? [] : ["WS_KINDS has no 'import' kind"]);
  none('the import IPC is not bridged, or main has no handler',
    [/workspaceImport: \(repo\) => ipcRenderer\.invoke\('workspace:import'/.test(PRELOAD) ? '' : 'no workspaceImport bridge',
     /ipcMain\.handle\('workspace:import'/.test(MAIN) ? '' : 'no workspace:import handler'].filter(Boolean));
  none('a pasted GitHub URL is rejected again (Q4: accept both forms)',
    /replace\(\/\^https\?:\\\/\\\/\(www\\\.\)\?github\\\.com\\\/\/i, ''\)/.test(MAIN)
      ? [] : ['workspace:import no longer strips a github.com URL prefix']);
  none('importing silently turns session sync on (it must not — that is a separate, disclosed choice)',
    /ipcMain\.handle\('workspace:import'[\s\S]*?\n\}\);/.exec(MAIN)?.[0].includes('syncSessions = true')
      ? ['workspace:import enables syncSessions'] : []);
  none('a failed clone leaves a phantom repo row behind',
    /registry\.workspaces\.splice\(i, 1\); saveRegistry\(\);/.test(MAIN)
      ? [] : ['workspace:import does not roll back its registration when the clone fails']);
  none('an already-imported repo dead-ends instead of switching to it',
    /ir\.error === 'already'/.test(APP) ? [] : ['the renderer does not handle the typed already-exists result']);
}

// ---------------------------------------------------------------------------------------------------------
// 84. THE 2026-08-02 BUG SWEEP. Five defects found by an audit of the whole tree, each verified before fixing.
//   They share no root cause, but four of them share a SHAPE: a value that is correct at one point in time,
//   read at another point where it is no longer correct. Worth pinning individually — none had a test.
// ---------------------------------------------------------------------------------------------------------
{
  // (a) PREFS_KEY was `const` beside loadPrefs (~line 3000), but two top-level IIFEs call loadPrefs DURING
  //     module evaluation. TDZ ReferenceError, swallowed by the bare catch around the localStorage read, so
  //     `ls` stayed {} and was MEMOIZED — killing both the one-time migration and the settings.json fallback,
  //     while savePrefs (which runs later, so it works) kept overwriting the mirror.
  none('PREFS_KEY moved back below its callers (its own read re-enters the temporal dead zone)',
    /^'use strict';\n(?:\/\/[^\n]*\n)*const PREFS_KEY = 'claudible_prefs';/m.test(APP)
      ? [] : ['PREFS_KEY is no longer declared at the top of renderer/app.js, before any loadPrefs() caller']);
  // (b) settings:set REPLACES settings.json with the renderer's cache, which is seeded once at boot. Anything
  //     main wrote afterwards died on the next pref write — and the only such key, depEnv, is what makes a
  //     no-UAC portable Git/Node survive the restart it asks for.
  none('a renderer pref write can erase main-owned settings keys again (depEnv → "I installed Git and it came back missing")',
    /if \(prev\.depEnv && !next\.depEnv\) next\.depEnv = prev\.depEnv;/.test(MAIN)
      ? [] : ['settings:set no longer carries depEnv forward']);
  // (c) .claude/settings.json is WORKSPACE-shared but bakes PER-GENERATION hook paths. wsl/session.sh exports
  //     the paths so each claude routes by its own env; win.js set only CLAUDIBLE_TAB, so a second tab on the
  //     same project silently stole the first tab's telemetry.
  none('the win runner stopped routing per-tab hook output by env (two tabs on one project cross-write)',
    [/env\.CLAUDIBLE_STATUS = rtPaths\.statusPath;/.test(read('runners/win.js')) ? '' : 'CLAUDIBLE_STATUS not set',
     /env\.CLAUDIBLE_HOOKS = rtPaths\.hooksPath;/.test(read('runners/win.js')) ? '' : 'CLAUDIBLE_HOOKS not set',
     /env\.CLAUDIBLE_CONTEXT = rtPaths\.contextPath;/.test(read('runners/win.js')) ? '' : 'CLAUDIBLE_CONTEXT not set'].filter(Boolean));
  none('…and the hooks must still prefer the env over the baked argv, or setting it achieves nothing',
    [/process\.env\.CLAUDIBLE_HOOKS \|\| process\.argv\[2\]/.test(read('hooks/hook.js')) ? '' : 'hook.js no longer env-first',
     /process\.env\.CLAUDIBLE_STATUS \|\| process\.argv\[2\]/.test(read('hooks/statusline.js')) ? '' : 'statusline.js no longer env-first'].filter(Boolean));
  // (c2) hook.js used to swallow every failure (empty catch {}) — a broken CLAUDIBLE_HOOKS path (bad dir,
  //     permissions, disk full) went completely silent, so telemetry/agents/voice/sync just stopped with no
  //     trace anywhere. The hook must still always exit 0 (never break the user's session) but must now name
  //     the failure on stderr, which Claude Code captures without polluting the stdout hook protocol.
  none('hooks/hook.js went back to swallowing failures with an empty catch {} instead of reporting to stderr',
    (() => {
      const HOOK = read('hooks/hook.js');
      const bad = [];
      // The two TRY SITES must each name their failure. A blanket /catch\s*\{\s*\}/ scan cannot be used here:
      // the reporting itself is wrapped in `try { …stderr… } catch {}` (a closed stderr must not throw out of
      // a hook that is contractually required to exit 0), so an empty catch legitimately exists inside them.
      if (!/try \{ buf = fs\.readFileSync\(0[^\n]*catch \(e\) \{[^\n]*process\.stderr\.write/.test(HOOK)) bad.push('hook.js stdin-read failure is swallowed again (no stderr report)');
      if (!/appendFileSync\(out[^\n]*catch \(e\) \{[^\n]*process\.stderr\.write/.test(HOOK)) bad.push('hook.js append failure is swallowed again (no stderr report)');
      if (!/process\.stderr\.write/.test(HOOK)) bad.push('hook.js no longer writes failures to process.stderr');
      if (!/no output path/.test(HOOK)) bad.push('hook.js no longer reports a falsy CLAUDIBLE_HOOKS/argv path');
      if (!/process\.exit\(0\)/.test(HOOK)) bad.push('hook.js no longer always exits 0');
      return bad;
    })());
  // (d) respawnPty defers the spawn on win having already dropped the ptys entry; tab:close inside that window
  //     killed nothing and doSpawn then spawned a pty for a tab that no longer exists — invisible, polled
  //     forever, and able to become fgTabId.
  none('closing a tab mid-respawn can strand an invisible pty again',
    /_respawnPending\.delete\(tabId\);\s*\n\s*ptys\.delete\(tabId\); hookState\.delete\(tabId\);/.test(MAIN)
      ? [] : ['tab:close does not cancel a pending deferred respawn']);
  // (e) stop() cleared `pending` without firing onApprovalCancel — the ws 'close' handler cannot, because by
  //     then the entry is gone. regenerateLink already got this right; stop() did not.
  none('stopping a share strands the host’s "X wants to join" modal',
    /onApprovalCancel && onApprovalCancel\(id\); \} catch \{\} \}\s*\n\s*for \(const \[, p\] of pending\) \{ try \{ p\.ws\.close/.test(read('share/server.js'))
      ? [] : ['stop() clears pending without cancelling the host prompt']);
  // (f) workspace:import sanitized the repo NAME and then cloned the sanitized result — `vercel/next.js`
  //     fetched `vercel/nextjs`, a different repository. SUPERSEDED by C-3.4 (test 86 below): the refusal
  //     this note describes is now GONE on purpose — the folder name and the clone target are carried as
  //     separate values end to end, so `my_repo`/`next.js` clone correctly instead of being refused.
  none('the retired import refusal message is back (the C-3.4 two-value fix should have replaced it)',
    /Claudible can.t import repositories whose name contains/.test(MAIN)
      ? ['the dots/underscores refusal message is still in main.js'] : []);
}

// ---------------------------------------------------------------------------------------------------------
// 86. C-3.4 — UNIFIED NAMING: the repo Claudible asks GitHub to clone and the local folder it clones into are
//   two SEPARATE values across all three name-mangling callers (import, discovery/invite, rename), and the
//   project-name / rename fields validate the allowed charset live instead of silently stripping characters.
//   Before this: an invite to `my_repo` cloned `myrepo` (a DIFFERENT repo) with no error — the audit's §9 #6
//   defect, alive on the one path that involves a second person and no error message.
// ---------------------------------------------------------------------------------------------------------
{
  none('the shared repoName/folderSlug helpers are missing (every caller below depends on them)',
    [/const REPO_NAME_RE = \/\^\[A-Za-z0-9\._-\]\{1,100\}\$\//.test(MAIN) ? '' : 'REPO_NAME_RE missing',
     /function isGithubRepoName\(/.test(MAIN) ? '' : 'isGithubRepoName missing',
     /function folderSlugFor\(/.test(MAIN) ? '' : 'folderSlugFor missing'].filter(Boolean));
  none('ensureClone stopped passing the exact repoName to clone-workspace.sh (back to cloning the sanitized slug)',
    /const repoName = isGithubRepoName\(ws\.repoName\) \? ws\.repoName : slug;/.test(MAIN)
      && /runScript\('clone-workspace\.sh', `'\$\{owner\}' '\$\{repoName\}' '\$\{slug\}'\$\{dirArg\}`/.test(MAIN)
      ? [] : ['ensureClone no longer threads a separate exact repoName through to the clone script']);
  none('clone-workspace.sh no longer takes owner/repo/slug as three separate positional args',
    [/repo="\$\{2:-\}"/.test(read('wsl/clone-workspace.sh')) ? '' : 'no $2 repo arg',
     /slug="\$\{3:-\}"/.test(read('wsl/clone-workspace.sh')) ? '' : 'no $3 slug arg',
     /gh repo clone "\$owner\/\$repo" "\$dir"/.test(read('wsl/clone-workspace.sh')) ? '' : 'clone no longer targets $owner/$repo'].filter(Boolean));
  none('discovery went back to sanitizing the repo name before matching/cloning it',
    /const slug = String\(item && item\.slug \|\| ''\);/.test(MAIN)
      && /if \(!isGithubRepoName\(slug\) \|\| !owner\) continue;/.test(MAIN)
      && /const folderSlug = folderSlugFor\(slug\);/.test(MAIN)
      ? [] : ['discoverWorkspaces no longer keeps the exact name (slug) and the folder name (folderSlug) separate']);
  none('sessions-discover.sh silently drops repos with a dot/underscore in the name again',
    (read('wsl/sessions-discover.sh').match(/case "\$n(ame)?"\s+in '' \| \. \| \.\. \| \*\[!A-Za-z0-9\._-\]\*\) continue/g) || []).length === 2
      ? [] : ['sessions-discover.sh no longer widens BOTH name filters to GitHub\'s repo-name charset']);
  none('workspace:import\'s repoName/slug split regressed',
    /const repoName = m\[2\];/.test(MAIN) && /if \(!isGithubRepoName\(repoName\)\)/.test(MAIN) && /const slug = folderSlugFor\(repoName\);/.test(MAIN)
      ? [] : ['workspace:import no longer keeps the exact repoName and the sanitized folder slug separate']);
  none('workspace:rename collapses the label into dashes before sending it to GitHub again',
    /newName = label\.replace\(\/\[\^A-Za-z0-9-\]\+\/g, '-'\)/.test(MAIN)
      ? ['the dash-collapsing rename mangler is back'] : []);
  none('workspace:rename no longer sends the label to GitHub verbatim when it is already legal',
    /const newName = label;/.test(MAIN) ? [] : ['rename-repo.sh is no longer called with the untouched label']);
  none('the renderer lost the live naming-charset validator (ws-name-in / .ws-rename)',
    [/function disallowedNameChars\(/.test(APP) ? '' : 'disallowedNameChars missing',
     /function wireNameValidator\(/.test(APP) ? '' : 'wireNameValidator missing',
     /wsNameCheck = wireNameValidator\(\$\('ws-name-in'\)/.test(APP) ? '' : 'ws-name-in is not wired to the validator',
     /wireNameValidator\(inp, null\);/.test(APP) ? '' : 'the inline rename input (.ws-rename) is not wired to the validator'].filter(Boolean));
  none('the rename input can commit while a disallowed character is still present',
    /const valid = \(\) => !disallowedNameChars\(inp\.value\)\.length;/.test(APP)
      && /if \(e\.key === 'Enter'\) \{ e\.preventDefault\(\); if \(valid\(\)\) commit\(true\); \}/.test(APP)
      ? [] : ['startWsEdit no longer gates Enter/blur on validity']);
}

// ---------------------------------------------------------------------------------------------------------
// 85. B1/B2/B5 — THE LINUX RELEASE CONTRACT (2026-08-03). A packaged Linux build (AppImage = read-only
//   mount, .deb = root-owned /opt) cannot write per-tab runtime under $APPDIR. The fix is ONE env contract
//   shared by four files: main.js exports CLAUDIBLE_RUNTIME on every packaged platform, posix.js runtimeDir()
//   honors it, and session.sh (writer) + killtree.sh (reaper) resolve the SAME root in bash. If any ONE of
//   the four drifts, writers and readers split silently — frozen telemetry or unreaped orphan claudes.
// ---------------------------------------------------------------------------------------------------------
{
  const SESSION_SH = read('wsl/session.sh');
  const KILLTREE_SH = read('wsl/killtree.sh');
  const POSIX_JS = read('runners/posix.js');
  // (a) the bash WRITER honors an absolute CLAUDIBLE_RUNTIME — with the /*-guard, so a Windows path that
  //     leaks across interop (C:\…) can never win. RT must derive from the guarded root, not from $APPDIR.
  none('session.sh stopped honoring CLAUDIBLE_RUNTIME (packaged posix writes into a read-only mount again)',
    [/case "\$\{CLAUDIBLE_RUNTIME:-\}" in \/\*\) RTROOT="\$CLAUDIBLE_RUNTIME"/.test(SESSION_SH) ? '' : 'the /*-guarded RTROOT override is gone',
     /RT="\$RTROOT\/tabs\/\$TAB"/.test(SESSION_SH) ? '' : 'RT no longer derives from RTROOT'].filter(Boolean));
  // (b) the REAPER reads the same env with the same guard. A relocated writer with an unrelocated reaper is
  //     §9 #4's orphan-claude disease reintroduced: tab-close finds no boot.pid and kills nothing, forever.
  none('killtree.sh looks for boot.pid where session.sh no longer writes it (orphan claudes on packaged posix)',
    [/case "\$\{CLAUDIBLE_RUNTIME:-\}" in \/\*\) RTROOT="\$CLAUDIBLE_RUNTIME"/.test(KILLTREE_SH) ? '' : 'killtree lost the /*-guarded RTROOT override',
     /PIDFILE="\$RTROOT\/tabs\/\$TAB\/boot\.pid"/.test(KILLTREE_SH) ? '' : 'PIDFILE no longer derives from RTROOT'].filter(Boolean));
  // (c) the JS READER (main's pollers go through runtimeDir) honors the same env, absolute-only — mirroring
  //     the bash guard exactly. Non-absolute values must fall back, or a leaked relative path splits the pair.
  none('posix.runtimeDir() no longer honors an absolute CLAUDIBLE_RUNTIME (readers split from the bash writer)',
    /path\.isAbsolute\(rt\)\) \? rt : path\.join\(APP_ROOT, 'runtime'\)/.test(POSIX_JS)
      ? [] : ['runtimeDir() lost the absolute-guarded env override']);
  // (d) main.js sets the env on EVERY packaged platform (B1 un-gated it from win32) while CLAUDIBLE_RUNNER=win
  //     stays win32-only — posix must keep auto-selecting the posix runner.
  none('the packaged-runtime relocation regressed to win32-only (B1 re-broken)',
    [/if \(app\.isPackaged\) \{\s*\n\s*if \(!process\.env\.CLAUDIBLE_RUNTIME\)/.test(MAIN) ? '' : 'CLAUDIBLE_RUNTIME is gated on win32 again',
     /if \(process\.platform === 'win32' && !process\.env\.CLAUDIBLE_RUNNER\) process\.env\.CLAUDIBLE_RUNNER = 'win';/.test(MAIN) ? '' : 'the win-runner force-select lost its win32 gate'].filter(Boolean));
  // (e) B2 — native posix binds voice to LOOPBACK. services.sh defaults to 0.0.0.0, which is load-bearing on
  //     WSL (the app reaches across the NAT, and the NAT shields the LAN) but is a LAN exposure on native
  //     Linux/macOS. posix must override like win.js does; wsl.js must NOT (that would break WSL voice).
  none('native posix voice services bind 0.0.0.0 again (whisper/kokoro reachable from the LAN)',
    [/CLAUDIBLE_BIND_HOST: '127\.0\.0\.1'/.test(POSIX_JS) ? '' : 'posix.js no longer sets loopback',
     /CLAUDIBLE_BIND_HOST: '127\.0\.0\.1'/.test(read('runners/win.js')) ? '' : 'win.js no longer sets loopback',
     /CLAUDIBLE_BIND_HOST/.test(read('runners/wsl.js').replace(/^\s*\/\/[^\n]*$/gm, '')) ? 'wsl.js now sets CLAUDIBLE_BIND_HOST — 0.0.0.0 is load-bearing there' : ''].filter(Boolean));
  // (f) B5 — every file this suite regexes is pinned to LF. Without this, a core.autocrlf=true clone reports
  //     phantom failures naming plausible regressions (467/6 observed at ecb0424, incl. pin 84a itself).
  none('.gitattributes stopped pinning the contract-read files to LF (Windows clones see phantom failures)',
    [/^\*\.js\s+text eol=lf/m.test(read('.gitattributes')) ? '' : '*.js not pinned',
     /^\*\.html\s+text eol=lf/m.test(read('.gitattributes')) ? '' : '*.html not pinned',
     /^\*\.ps1\s+text eol=lf/m.test(read('.gitattributes')) ? '' : '*.ps1 not pinned',
     /^\*\.md\s+text eol=lf/m.test(read('.gitattributes')) ? '' : '*.md not pinned',
     /^\*\.yml\s+text eol=lf/m.test(read('.gitattributes')) ? '' : '*.yml not pinned',
     /^\*\.json\s+text eol=lf/m.test(read('.gitattributes')) ? '' : '*.json not pinned'].filter(Boolean));
}

// ---------------------------------------------------------------------------------------------------------
// 86. THE 0.9.4 LIVE-SHARE + STARTUP BATCH. Ten fixes from a demo that went wrong in front of a guest, plus
//   two collaborator reports. The share ones matter most: live share is the product's headline feature, and
//   each of these turned it into a liability rather than merely breaking it.
// ---------------------------------------------------------------------------------------------------------
{
  const WIN_JS = read('runners/win.js');
  const SERVER_JS = read('share/server.js');
  // (a) B20 — the two cygpath probes run at MODULE LOAD on a blocked main thread, before any window exists.
  //     `-lc` sources the user's whole bash profile; this file's own header measured that at 37s on a real box.
  //     A login shell here is a black screen at every launch, and it must never come back.
  none('a startup cygpath probe went back to a LOGIN shell (-lc), or lost its timeout',
    [/cygpath -u '\$\{shared\.shq\(APP_ROOT\)\}'`\], \{ encoding: 'utf8', timeout: \d+/.test(WIN_JS) ? '' : 'appDirGuest is not `-c` + timeout',
     /cygpath \$\{flag\} '\$\{shared\.shq\(key\)\}'`\], \{ encoding: 'utf8', timeout: \d+/.test(WIN_JS) ? '' : 'toGuestPath/toHostPath is not `-c` + timeout',
     /\['-lc',\s*`cygpath/.test(WIN_JS) ? 'a cygpath call still uses -lc' : ''].filter(Boolean));
  // …and every synchronous probe behind detectDeps is bounded. detectDeps is sync behind an ipcMain await, so
  // each of these blocks the main thread — on boot AND on every Settings-drawer open. `gh` reaches the network.
  // Line-based, deliberately: every call in this file is written on one line with its own options object, and
  // a paren-counting regex trips over the nested `shared.shq(...)` inside the cygpath commands.
  none('a synchronous dependency probe lost its timeout (an offline box hangs the Settings drawer)',
    WIN_JS.split('\n')
      .filter((l) => /cp\.execFileSync\(/.test(l) && !/^\s*\/\//.test(l) && !/timeout:/.test(l))
      .map((l) => l.trim().slice(0, 70)));
  // (a2) B21 — runScript is the HOT path (every session list, sync and presence probe; the beacon fires one
  //      per synced workspace every 1.5s). A login shell there sources Git-for-Windows' own /etc/profile:
  //      measured at 3.5-6.9s per call on a collaborator's box vs 0.6-1.2s for `-c`, with beacon probes at
  //      10-12s against a 1.5s cadence. Verified before changing it that `-c` still resolves sed/grep/awk/
  //      cygpath/git/gh/node identically. services.sh keeps `-lc` deliberately (startup-only, uv resolution).
  none('runScript went back to a LOGIN shell (the hot path pays Git’s /etc/profile on every call)',
    /cp\.execFile\(bash, \['-c', cmd\]/.test(WIN_JS) ? [] : ['runScript no longer uses a non-login shell']);
  // …and the beacon must back off on SLOW, not only on FAILED — a probe that succeeds in 10s against a 1.5s
  // cadence saturates the chain and starves every other script call behind it.
  none('the presence beacon can saturate a slow machine again',
    [/_beaconCost\.set\(wsId, Date\.now\(\) - t0\)/.test(MAIN) ? '' : 'probe cost is not recorded',
     /Math\.max\(backoff, cost \* 4\)/.test(MAIN) ? '' : 'the delay no longer floors at a multiple of the last probe cost',
     /const t0 = Date\.now\(\);   \/\/ declared OUTSIDE the try/.test(MAIN) ? '' : 't0 is not in scope for the finally that records the cost'].filter(Boolean));
  // (b) B13 — one server, one pin. A second Share must REFUSE, not hand back the first share's link.
  none('a second Share can publish the FIRST share’s session again (B13)',
    [/tunnelUp && sharedTabIdR != null && sharedTabIdR !== activeTabId/.test(APP) ? '' : 'doStartSharing lost its already-sharing refusal',
     /sharedTabId != null && fgTabId != null && sharedTabId !== fgTabId/.test(MAIN) ? '' : 'share:start lost the main-process backstop'].filter(Boolean));
  // (c) B14 — the warning must describe the mode that will actually be SERVED. Reading the checkbox showed
  //     "they can't type" while co-drive was live, and the box ships `checked`, so that was the DEFAULT flow.
  none('the share warning reads the checkbox instead of the real server mode again (B14)',
    /const ro = locked \? !!lastShareReadOnly : !!\(cb && cb\.checked\)/.test(APP)
      ? [] : ['renderShareWarn no longer prefers lastShareReadOnly when the toggle is locked']);
  // …and a locked toggle must LOOK locked. The real checkbox is display:none and the switch is painted from
  // :checked alone, so without these rules a dead control is pixel-identical to a working one.
  none('a disabled toggle is visually indistinguishable from a working one again',
    [/\.toggle input:disabled \+ \.sw\{/.test(HTML) ? '' : 'no :disabled style for the switch',
     /\.toggle:has\(input:disabled\)\{cursor:not-allowed/.test(HTML) ? '' : 'a locked toggle still shows a pointer cursor'].filter(Boolean));
  // …and the lock must be re-evaluated on EVERY ensureTunnel exit, including the early returns that used to
  // skip it and strand the switch dead with no live share to justify it.
  none('the view-only lock is no longer synced on the early-return paths (B14c)',
    [/function syncShareRoLock\(\)/.test(APP) ? '' : 'syncShareRoLock is gone',
     /if \(want === tunnelUp\) \{ syncShareRoLock\(\)/.test(APP) ? '' : 'the already-in-state early return does not sync the lock',
     (APP.match(/syncShareRoLock\(\)/g) || []).length >= 4 ? '' : 'syncShareRoLock is not called from every exit + the tunnel-down/up handlers'].filter(Boolean));
  // (d) B16/B17 — 'new' was the one resolution with no dedupe, so an empty project minted a tab per click and
  //     the duplicate spawn triggered Claude Code's selection prompt, which eats every space. C-4.4 (owners'
  //     decision, 2026-08-06) retired the auto-spawn itself — dedupeBlankDraft/autoDraft are gone, replaced by
  //     parkedTabFor, which mints a tab that never gets a pty at all until an explicit Create/Retry click. The
  //     same repeated-click pile-up risk still applies to PARKED tabs, so the dedupe discipline survives intact.
  none('an empty project can mint a fresh tab per click again (B16 → the spacebar bug; C-4.4 retired the auto-spawn it guarded)',
    [/function parkedTabFor\(wsId, reason\)/.test(APP) ? '' : 'parkedTabFor is gone',
     /rec\.wsId === wsId && rec\.parked && !rec\.busy/.test(APP) ? '' : 'the parked-tab dedupe no longer requires an untouched, non-busy parked tab',
     (APP.match(/parkedTabFor\(id,/g) || []).length >= 3 ? '' : 'not all three switchWorkspace branches dedupe the ‘new’ case through parkedTabFor'].filter(Boolean));
  // (e) B18 — `switch` is the only guest frame that changes host state; it must respect the privacy pause,
  //     exactly as input and paste already do.
  none('a guest can move the host’s workspace during the privacy pause again (B18)',
    /msg\.type === 'switch'[\s\S]{0,120}?if \(readOnly \|\| paused\) return;/.test(SERVER_JS)
      ? [] : ['the switch frame no longer gates on `paused`']);
  // (f) A failed voice provision must not re-run a several-hundred-MB download at every launch. The manual
  //     Settings retry passes force and must stay unaffected.
  none('a failed voice provision retries on every launch again',
    [/if \(s0\.voiceProvisionFailedAt && !force\) return false;/.test(MAIN) ? '' : 'the failed-before stamp is not honoured at boot',
     /s\.voiceProvisionFailedAt = Date\.now\(\)/.test(MAIN) ? '' : 'a failed provision records nothing',
     /ensureVoiceProvisioned\(true\)/.test(MAIN) ? '' : 'the manual Settings retry no longer forces past the stamp'].filter(Boolean));
}

// ---------------------------------------------------------------------------------------------------------
// 87. C-1.2/1.3 — the wsl runner gets the same speed fix win.js got in 0.9.6: memoized wslpath translation
//   (toGuestPath/toHostPath were a fresh wsl.exe spawn per call) + runScript off the login shell (same hot
//   path win.js's own pin #86(a2) documents: every session list, sync, presence probe, and the 1.5s-interval
//   beacon). spawnClaude KEEPS `-lc` — session.sh execs `claude` bare with no node-path.sh-style PATH fixup
//   in front of it, and claude may be nvm-installed in the distro. services.sh KEEPS its own login shell too
//   (uv/kokoro provisioning needs the profile) — untouched on purpose, so its pin only proves it's still there.
// ---------------------------------------------------------------------------------------------------------
{
  const WSL_JS = read('runners/wsl.js');
  none('wsl runScript went back to a LOGIN shell (the hot path pays a profile source on every call)',
    /cp\.execFile\('wsl\.exe', \['-e', 'bash', '-c', cmd\]/.test(WSL_JS) ? [] : ['runScript no longer uses a non-login shell']);
  none('wsl spawnClaude lost its login shell (claude may be nvm-installed with no PATH fixup ahead of it)',
    /pty\.mod\.spawn\('wsl\.exe', \['-e', 'bash', '-lc', buildBoot/.test(WSL_JS) ? [] : ['spawnClaude no longer uses a login shell']);
  none('wsl startVoiceServices lost its login shell (uv/kokoro needs the profile)',
    /\['-e', 'bash', '-lc', shared\.scriptCmd\(appdir, 'services\.sh'\)\]/.test(WSL_JS) ? [] : ['startVoiceServices no longer uses a login shell']);
  none('wsl toGuestPath/toHostPath lost their memo (wslpath spawns a fresh wsl.exe per call again)',
    [/const _guestPathMemo = new Map\(\)/.test(WSL_JS) ? '' : '_guestPathMemo is gone',
     /const _hostPathMemo = new Map\(\)/.test(WSL_JS) ? '' : '_hostPathMemo is gone',
     /_guestPathMemo\.has\(key\)/.test(WSL_JS) ? '' : 'toGuestPath does not consult the memo',
     /_hostPathMemo\.has\(key\)/.test(WSL_JS) ? '' : 'toHostPath does not consult the memo'].filter(Boolean));
  none('wsl resetCaches is missing, unexported, or does not clear the memoized state',
    [/function resetCaches\(\) \{[^}]*_guestPathMemo\.clear\(\)[^}]*_hostPathMemo\.clear\(\)/.test(WSL_JS) ? '' : 'resetCaches does not clear both memo Maps',
     /resetCaches,/.test(WSL_JS.slice(WSL_JS.indexOf('module.exports'))) ? '' : 'resetCaches is not exported'].filter(Boolean));
}

// ---------------------------------------------------------------------------------------------------------
// 88. C-8.1 — the green-lit two-card revert bug. With two Project History cards expanded, reverting from the
//   SECOND card's feed used to hit the FIRST card's workspace: revertToCheckpoint read the one shared
//   _histFeedWsId/activeWsId globals instead of the wsId the clicked row's own card actually learned (r.wsId,
//   captured per-card by loadHistoryInto). Mirrors the already-correct doDiffRevert/loadDiffInto pattern,
//   which threads wsId as an explicit parameter instead of reading a shared global.
// ---------------------------------------------------------------------------------------------------------
{
  none('renderHistoryEntry no longer threads a wsId into its Revert button (reverts the wrong card again)',
    [/function renderHistoryEntry\(en, revertable, wsId\)/.test(APP) ? '' : 'renderHistoryEntry lost its wsId parameter',
     /revertToCheckpoint\(en, wsId\)/.test(APP) ? '' : 'the Revert button no longer closes over the row’s wsId'].filter(Boolean));
  none('revertToCheckpoint no longer prefers its passed wsId over the shared globals (C-8.1 regressed)',
    [/async function revertToCheckpoint\(en, wsId\)/.test(APP) ? '' : 'revertToCheckpoint lost its wsId parameter',
     /const targetWs = wsId !== undefined \? wsId : \(_histFeedWsId \|\| activeWsId\)/.test(APP) ? '' : 'targetWs no longer prefers the passed wsId, falling back to the globals only when undefined',
     /wsBusy\(targetWs\)/.test(APP) ? '' : 'the busy safety check no longer uses the per-card targetWs'].filter(Boolean));
  none('loadHistoryInto no longer passes each card\'s own wsId to renderHistoryEntry',
    /renderHistoryEntry\(en, i < 10, r\.wsId \|\| targetWsId\)/.test(APP)
      ? [] : ['the main render loop no longer threads r.wsId (the card\'s true workspace) into each row']);
}

// ---------------------------------------------------------------------------------------------------------
// 89. C-5.10 — the guest double-checks it's watching what the host promised. The host already threads the
//   PINNED tab's session id through the tracker frame (s.sessionId, alongside s.session) and main forwards
//   the whole status payload verbatim to share.broadcastStatus — this pin guards BOTH ends staying wired,
//   plus the guest-side comparison that was the actually-missing half: remember the FIRST id, warn on a
//   later mismatch. (If this ever "temporarily" regresses, C-5.1 is one step from breaking again.)
// ---------------------------------------------------------------------------------------------------------
{
  none('the host tracker no longer threads sessionId onto the pinned tab\'s status frame (C-5.10 host half)',
    /sessionId: \(t\.session && t\.session !== 'new'\) \? t\.session : ''/.test(APP)
      ? [] : ['pushTracker no longer sends sessionId']);
  none('main no longer forwards the raw tracker payload to guests (sessionId would be silently dropped)',
    /ipcMain\.on\('share:tracker', \(e, s\) => \{[\s\S]{0,400}?share\.broadcastStatus\(s\);/.test(MAIN)
      ? [] : ['share:tracker handler no longer forwards s verbatim']);
  none('guest.js lost the session-mismatch check (C-5.10 — one step from C-5.1 breaking again)',
    [/function checkSessionId\(sid\)/.test(GUEST_JS) ? '' : 'checkSessionId is gone',
     /if \(!knownSessionId\) \{ knownSessionId = sid; return; \}/.test(GUEST_JS) ? '' : 'no longer remembers the FIRST sessionId as the baseline',
     /sessionMismatch = true;/.test(GUEST_JS) ? '' : 'no mismatch flag is ever set',
     /checkSessionId\(s\.sessionId\)/.test(GUEST_JS) ? '' : 'applyStatus no longer calls checkSessionId'].filter(Boolean));
  none('a flagged session mismatch is never actually shown to the guest',
    [/chip\.classList\.add\('mismatch'\)/.test(GUEST_JS) ? '' : 'no visible chip warning on mismatch',
     /sessionMismatch \? 'different session!'/.test(GUEST_JS) ? '' : 'the chip label falls back to the normal session name instead of staying a warning'].filter(Boolean));
}

// ---------------------------------------------------------------------------------------------------------
// 90. C-1.5 — THE BACKEND-UNAVAILABLE BANNER. The old signal was a toast that showed once, 2.2s after boot,
//   and was gone: the whole point of "no script backend" (~35 handlers short-circuit while the terminal keeps
//   working) is that it is otherwise invisible, and a MISSED toast recreated that exact silence. Now a
//   persistent chip (build-drift's vocabulary) with a Retry button that re-derives the backend live (the same
//   appDirNow()/resetCaches pattern the voice path already trusts) instead of forcing a restart. Pins: the
//   banner markup exists, the renderer shows it (not just a toast) and wires Retry to a real IPC round-trip,
//   and main's handler both answers the retry AND writes the fresh value back so the ~35 gated handlers — not
//   just the chip — come back without a relaunch.
// ---------------------------------------------------------------------------------------------------------
{
  none('index.html lost the backend-unavailable banner (or it is not the tunnel-warn chip vocabulary)',
    [/id="backend-warn"/.test(HTML) ? '' : 'no #backend-warn element',
     /class="tunnel-warn tw-err" id="backend-warn"/.test(HTML) ? '' : '#backend-warn does not reuse the tunnel-warn/tw-err chip classes',
     /id="backend-warn-txt"/.test(HTML) ? '' : 'no #backend-warn-txt text span',
     /id="backend-warn-retry"/.test(HTML) ? '' : 'no #backend-warn-retry button'].filter(Boolean));
  none('app.js still toasts backend-unavailable instead of showing the persistent banner',
    [/function renderBackendWarn\(text\)/.test(APP) ? '' : 'no renderBackendWarn()',
     /claudible\.onBackendUnavailable\(\(s\) => \{/.test(APP) ? '' : 'onBackendUnavailable listener is gone',
     /renderBackendWarn\(_backendWarnReason\)/.test(APP) ? '' : 'onBackendUnavailable no longer calls renderBackendWarn'].filter(Boolean));
  none('the banner Retry button lost its click handler (or stopped calling backendRetry/refreshWorkspaces on success)',
    [/\$\('backend-warn-retry'\)/.test(APP) ? '' : 'no #backend-warn-retry lookup',
     /claudible\.backendRetry\(\)/.test(APP) ? '' : 'Retry no longer calls claudible.backendRetry()',
     /refreshWorkspaces\(\)/.test(APP) ? '' : 'app.js no longer calls refreshWorkspaces() anywhere'].filter(Boolean));
  none('preload: backendRetry is not bridged to backend:retry',
    /backendRetry: \(\) => ipcRenderer\.invoke\('backend:retry'\)/.test(PRELOAD) ? [] : ['no backendRetry bridge']);
  none('main.js lost the backend:retry handler, or it no longer re-derives + writes back APPDIR_WSL',
    [/ipcMain\.handle\('backend:retry', \(\) => \{/.test(MAIN) ? '' : 'no backend:retry handler',
     /const dir = appDirNow\(\);\s*\n\s*if \(dir\) \{ APPDIR_WSL = dir; return \{ ok: true \}; \}/.test(MAIN) ? '' : 'handler no longer re-derives via appDirNow() and writes APPDIR_WSL back on success'].filter(Boolean));
  none('APPDIR_WSL is const again (a successful retry could not un-gate the ~35 handlers that read it)',
    /const APPDIR_WSL = runner\.appDirGuest\(\);/.test(MAIN) ? ['APPDIR_WSL is declared const'] : []);
}

// ---------------------------------------------------------------------------------------------------------
// 91. C-4.5 — OWNERS' RULE: NEVER PAINT A NAME THAT ISN'T CONFIRMED FOR A SESSION KNOWN TO HAVE CHANGED.
//   sessTitle's warm-cache fallback (for the ~2s before pollTitles lands) held the last-known shared name — but
//   for a session already flagged s.diverged, that cached name can be exactly the one true BEFORE the fork on
//   the other machine. sessTitle must check s.diverged before consulting the cache and return null instead, so
//   renderSessionRow paints a neutral "loading…" state (not a possibly-wrong name) until the live poll (remote-
//   Titles) reconciles it. Undiverged sessions must keep painting the cache instantly — the common path must not
//   pay for this.
// ---------------------------------------------------------------------------------------------------------
{
  const sessTitleBody = (APP.match(/function sessTitle\(s, wsId\) \{[\s\S]*?\n\}/) || [''])[0];
  none('sessTitle no longer checks s.diverged before falling back to remoteTitlesCache (C-4.5)',
    [sessTitleBody ? '' : 'sessTitle(s, wsId) not found',
     /if \(s\.diverged\) return null;/.test(sessTitleBody) ? '' : 'sessTitle does not return null for a diverged session',
     (() => {
       const divIdx = sessTitleBody.indexOf('if (s.diverged) return null;');
       const cacheIdx = sessTitleBody.indexOf('remoteTitlesCache');
       return (divIdx !== -1 && cacheIdx !== -1 && divIdx < cacheIdx) ? '' : 'the diverged check no longer runs BEFORE the remoteTitlesCache fallback';
     })()].filter(Boolean));
  none('renderSessionRow paints straight through a null (diverged, unconfirmed) title again (C-4.5)',
    [/const _st = sessTitle\(s\);/.test(APP) ? '' : 'renderSessionRow no longer captures sessTitle(s) before deciding how to paint it',
     /if \(_st == null\) \{ p\.classList\.add\('sess-title-pending'\); p\.textContent = 'loading…'; \}/.test(APP) ? '' : 'renderSessionRow no longer shows a muted loading placeholder for a null title'].filter(Boolean));
  none('index.html lost the muted styling for a pending (unconfirmed) session title (C-4.5)',
    /\.sess-prev\.sess-title-pending\{color:var\(--ink-faint\)/.test(HTML) ? [] : ['no .sess-prev.sess-title-pending rule']);
}

// ---------------------------------------------------------------------------------------------------------
// 92. C-9.3 — port the 6600f95 permission-override naming to the WSL/posix path. main.js:657-666 already
//   names the overridden setting for the win.js runner (claudibleForeign flag → injected terminal line); the
//   wsl/session.sh bootstrap prints its own foreign notice directly (no main.js injection in that path), so
//   the same naming has to live in resume_one's is_foreign branch, reading the already-parsed
//   CLAUDIBLE_PERMISSION_MODE instead of the generic "opening a collaborator's session" line for every mode.
// ---------------------------------------------------------------------------------------------------------
{
  const SESH92 = read('wsl/session.sh');
  const resumeOneBody = (SESH92.match(/resume_one\(\) \{[\s\S]*?\n\}/) || [''])[0];
  none('session.sh no longer names the overridden Bypass/Accept-edits setting on a foreign resume (C-9.3)',
    [/is_foreign "\$1"/.test(resumeOneBody) ? '' : 'resume_one no longer branches on is_foreign',
     /case "\$\{CLAUDIBLE_PERMISSION_MODE:-\}" in/.test(resumeOneBody) ? '' : 'the foreign branch does not read CLAUDIBLE_PERMISSION_MODE',
     /bypass\)\s*echo "\[claudible\] Bypass permissions is set, but this is a collaborator's session/.test(resumeOneBody) ? '' : 'no named Bypass-permissions override line',
     /acceptEdits\)\s*echo "\[claudible\] Accept edits is set, but this is a collaborator's session/.test(resumeOneBody) ? '' : 'no named Accept-edits override line'].filter(Boolean));
  none('the foreign branch still falls back to a generic notice when no override is remembered (C-9.3)',
    /\*\)\s*echo "\[claudible\] opening a collaborator's session - Claude will ask before running tools\."/.test(resumeOneBody)
      ? [] : ['the default (no remembered mode) case lost its fallback line']);

  // THE SAME RULE ON THE WINDOWS PATH, which carried no pin at all. claude.exe is spawned with no wrapping
  // shell, so main.js injects this notice itself — and its list of modes to name was written when the picker
  // offered two. The picker offers five. Now that a profile with no saved choice starts on Auto, an unwidened
  // list would print the GENERIC line for every foreign session on a fresh machine: the case where naming the
  // overridden setting matters most, since the user never chose the mode being overridden and has no reason
  // to connect the prompting they see with a setting they did not set.
  none('main.js names only some of the picker’s modes on a foreign session (Plan/Auto would fall through)',
    [/const overridden = mode === 'default' \? '' : \(PERM_LABELS\[mode\] \|\| ''\);/.test(MAIN)
      ? '' : 'the foreign notice does not derive the overridden setting from the shared label map',
     /\['bypass', 'acceptEdits'\]\.includes/.test(MAIN)
      ? 'the foreign notice tests a hardcoded two-mode list again — plan and auto would print the generic line' : '',
     /registry\.permissionMode === 'bypass' \? 'Bypass permissions' : 'Accept edits'/.test(MAIN)
      ? 'the foreign notice labels every non-bypass mode "Accept edits" again' : '',
     /so Claude asks before running tools — your '"\n\s*\+ overridden/.test(MAIN)
      ? '' : 'the named-override line no longer prints the resolved label'].filter(Boolean));
  // …and those names must be the words on the buttons that set them, checked against the picker itself: a
  // terminal line naming 'acceptEdits' sends someone hunting Settings for a control labelled "Accept edits".
  none('the terminal names a permission mode by something other than the picker’s own label',
    (() => {
      const picker = [...HTML.matchAll(/data-perm="([a-zA-Z]+)"[\s\S]{0,400}?class="t">([^<]+)</g)].map((m) => [m[1], m[2]]);
      const map = (MAIN.match(/const PERM_LABELS = \{[^}]*\}/) || [''])[0];
      if (picker.length !== 5) return ['the permission picker no longer offers exactly five modes (found ' + picker.length + ')'];
      return picker.filter(([v, t]) => !new RegExp(v + ": '" + t + "'").test(map)).map(([v, t]) => v + ' is not labelled "' + t + '" in main.js');
    })());

  // TRUST OVERRIDE (.claudible-trusted). The foreign mark is append-only and permanent, so it cannot tell a
  // collaborator's transcript apart from the user's OWN session synced back from their OWN second machine.
  // For the latter the guard is pure friction, and hand-clearing the foreign entry does not survive the next
  // import. The sidecar is the user's explicit per-id answer. Two properties must hold together, on BOTH
  // backends: trusted overrides foreign, and sync NEVER writes the sidecar (or the override would not last).
  none('the trust override is gone from session.sh (a synced-back own session is friction forever)',
    [/TRUSTED_LIST="\$PROJ\/\.claudible-trusted"/.test(SESH92) ? '' : 'no TRUSTED_LIST',
     /is_trusted\(\)/.test(SESH92) ? '' : 'no is_trusted helper',
     /is_foreign\(\)[^\n]*&& ! is_trusted "\$1"/.test(SESH92) ? '' : 'is_foreign does not consult is_trusted'].filter(Boolean));
  none('the trust override is gone from the win runner',
    /\.claudible-trusted'\), 'utf8'\)[\s\S]{0,120}?foreign\.delete\(l\.trim\(\)\)/.test(read('runners/win.js'))
      ? [] : ['win.js never subtracts .claudible-trusted from the foreign set']);
  none('sessions-sync writes .claudible-trusted (that would let an import forge trust)',
    /claudible-trusted/.test(read('wsl/sessions-sync.sh')) ? ['sessions-sync.sh references the trusted sidecar'] : []);
}

// ---------------------------------------------------------------------------------------------------------
// 88. THE TEST HARNESS ITSELF MUST NOT SPAWN THE WSL INTEROP LAUNCHER. On win32, plain `bash` resolved via
//   PATH can be C:\Windows\System32\bash.exe ahead of any real Git Bash — that launcher either mangles a
//   Windows-style path in its own argv translation (backslashes vanish: `C:\Users\x\foo.sh` arrives as
//   `C:Usersxfoo.sh`) or drops the argument into a WSL distro that never sees it, so run-all.js's own *.sh
//   steps (and the two test/*.test.js files that shell out directly) died with exit 127 before this fix.
// ---------------------------------------------------------------------------------------------------------
{
  const RUN = read('test/run-all.js');
  const BASHRESOLVE = read('test/_bash-resolve.js');
  const ADOPT = read('test/adopt-workspace.test.js');
  const APPDIR = read('test/appdir-quoting.test.js');
  none('run-all.js resolves a real bash on win32 instead of a bare "bash" for its *.sh steps',
    /process\.platform === 'win32' \? require\('\.\/_bash-resolve'\) : null/.test(RUN)
      ? [] : ['run-all.js no longer gates bash resolution behind win32']);
  none('…and ubuntu CI keeps spawning plain "bash" — the win32 branch must never change that path',
    /cmd: bash \? bash\.resolve\(\)\.bin : 'bash'/.test(RUN) ? [] : ['the non-win32 fallback to a bare "bash" is gone']);
  none("_bash-resolve.js mirrors runners/win.js's own probe/rejection, not a copy that could drift from it",
    /require\('\.\.\/runners\/win\.js'\)\._internals\.gitBash\(\)/.test(BASHRESOLVE)
      ? [] : ["_bash-resolve.js no longer reuses runners/win.js's gitBash()"]);
  none('_bash-resolve.js falls back to WSL (path args translated via `wsl.exe wslpath -a`) only when no MSYS bash exists',
    /wslpath', '-a'/.test(BASHRESOLVE) && /looksWindowsPath/.test(BASHRESOLVE)
      ? [] : ['the WSL fallback / Windows-path translation is missing']);
  none("adopt-workspace.test.js no longer spawns 'bash' literally (would hit the WSL launcher on win32)",
    /cp\.execFileSync\('bash'/.test(ADOPT) ? ["a literal execFileSync('bash', …) survived"] : []);
  none("appdir-quoting.test.js's own bash probe no longer hardcodes 'bash' literally",
    /cp\.execFileSync\('bash', \['-c', 'true'\]/.test(APPDIR) ? ["the HAS_BASH probe still hardcodes 'bash'"] : []);
}

// ---------------------------------------------------------------------------------------------------------
// 93. C-8.2 — the undo snapshot is ONE overwritable slot (refs/claudible/ckpt/undo), not per-workspace. A
//   second revert — even on a different project than the first — silently clobbers the still-usable undo
//   point from an earlier revert. The confirm must say so before the user commits to it, and that warning must
//   be derived from TRUTH (does refs/claudible/ckpt/undo actually exist in that workspace's repo right now?),
//   not solely from the in-memory _revertUndoWs flag — which resets on drawer close / app restart and so goes
//   silently wrong across sessions. _revertUndoWs is still allowed as a fast-path shortcut when it already
//   names the SAME workspace (no round trip needed), but the truth check must be the fallback, not vice versa.
// ---------------------------------------------------------------------------------------------------------
{
  none('revertToCheckpoint no longer warns that an existing undo point gets replaced (C-8.2)',
    /hasUndo \? '\\n\\n.*replaces it.*no longer be recoverable/.test(APP)
      ? [] : ['the confirm body lost its stacked-revert / single-slot-undo warning']);
  none('revertToCheckpoint no longer asks main for the TRUTH of an existing undo point (C-8.2)',
    /let hasUndo = _revertUndoWs === targetWs;[\s\S]{0,200}claudible\.checkpointUndoExists\(targetWs\)/.test(APP)
      ? [] : ['the warning fell back to the in-memory _revertUndoWs flag alone, or dropped the checkpointUndoExists round trip']);
  none('wsl/checkpoint-tool.js lost the read-only "exists" subcommand backing the truth check (C-8.2)',
    /sub === 'exists'[\s\S]{0,500}ck\.resolve\(git, id\)/.test(read('wsl/checkpoint-tool.js'))
      ? [] : ['no exists <id> -> { ok, exists } subcommand in checkpoint-tool.js']);
  none('main.js lost the checkpoint:undoExists IPC handler (C-8.2)',
    /ipcMain\.handle\('checkpoint:undoExists'/.test(MAIN) ? [] : ["no ipcMain.handle('checkpoint:undoExists', ...) in main.js"]);
  none('preload.js lost the checkpointUndoExists bridge (C-8.2)',
    /checkpointUndoExists:\s*\(wsId\)\s*=>\s*ipcRenderer\.invoke\('checkpoint:undoExists'/.test(PRELOAD)
      ? [] : ['no checkpointUndoExists bridge in preload.js']);
}

// ---------------------------------------------------------------------------------------------------------
// 88. C-9.1 — THE SETTINGS DRAWER MUST NEVER WAIT ON THE NETWORK. refreshGhRow used to await the FULL
//   onboard:status probe (claude + gh + voice) just to paint one row. gh:state now answers instantly from a
//   module-level cache and refreshes it in the background (5000ms timeout of its own), pushing fresh data over
//   'gh:state-changed'. The wizard is unaffected — it still needs the full, blocking onboard:status.
// ---------------------------------------------------------------------------------------------------------
{
  none('gh:state cheap handler is missing (drawer would block on onboardStatus again)',
    [/ipcMain\.handle\('gh:state'/.test(MAIN) ? '' : "no ipcMain.handle('gh:state', ...) in main.js",
     // takes a `force` argument now: a drawer-open serves the cache and spawns nothing, while the events that
    // genuinely invalidate it pass true. The rule pinned here is unchanged — the function must exist and the
    // handler must not block on onboardStatus.
    /function refreshGhStateCache\(force\)/.test(MAIN) ? '' : 'no refreshGhStateCache() background-refresh function',
    // …and the throttle must actually be honoured, or every drawer-open respawns `gh` as before
    /if \(!force && _ghProbedAt && \(Date\.now\(\) - _ghProbedAt\) < GH_PROBE_TTL\) return;/.test(MAIN)
      ? '' : 'the gh probe is no longer throttled — every drawer open would spawn one again',
    // THE RULE, not the characters: A FAILED PROBE IS THROTTLED TOO. The guard also required
    // _ghStateCache.known, which is set only on SUCCESS — so a probe that timed out or threw left it false,
    // the guard was skipped, and the next drawer-open spawned `gh` all over again, on exactly the slow or
    // offline machine the throttle was written for. The stamp was always right (_ghProbedAt is set before the
    // empty-result bail); only the guard disagreed with it. Any success-only condition reappearing in this
    // guard is that bug coming back, so the shape is pinned from the other side too.
    /if \(!force &&[^\n]*_ghStateCache\.known/.test(MAIN)
      ? 'the throttle gates on a SUCCESSFUL probe again — a failed probe would respawn gh on every drawer open' : '',
     /setTimeout\(\(\) => resolve\(null\), 5000\)/.test(MAIN) ? '' : 'gh:state\'s background probe lost its 5000ms timeout',
     /ghState: \(\) => ipcRenderer\.invoke\('gh:state'\)/.test(PRELOAD) ? '' : 'no ghState bridge in preload.js',
     /onGhStateChanged: \(cb\) => ipcRenderer\.on\('gh:state-changed'/.test(PRELOAD) ? '' : 'no onGhStateChanged bridge in preload.js'].filter(Boolean));
  none('refreshGhRow awaits onboardStatus again (the drawer would block on gh\'s network)',
    [/async function refreshGhRow\(\) \{[\s\S]{0,200}?claudible\.onboardStatus\(\)/.test(APP) ? 'refreshGhRow still calls claudible.onboardStatus()' : '',
     /s = await claudible\.ghState\(\);/.test(APP) ? '' : 'refreshGhRow no longer calls claudible.ghState()'].filter(Boolean));
  none('connectGh success / a post-install no longer invalidate the drawer\'s gh cache',
    // These three sites must FORCE the probe: they are the events the throttle would otherwise swallow, which
    // is exactly how a drawer ends up showing a signed-out row to someone who just signed in.
    [/if \(r\.ok\) refreshGhStateCache\(true\);/.test(MAIN) ? '' : 'onboard:gh-login no longer refreshes the gh cache on success',
     (MAIN.match(/refreshGhStateCache\(true\);/g) || []).length >= 3 ? '' : 'refreshGhStateCache() is not called from both the connectGh-success and post-install paths'].filter(Boolean));
}

// ---------------------------------------------------------------------------------------------------------
// 94. C-1.6 — the post-boot background timers fire sooner. pruneTrash was 12000ms after createWindow and
//   checkForUpdate was 15000ms after app.whenReady — both pushed well past a session most users have already
//   started typing into. Trimmed to 7000ms and 9000ms respectively; the 3000ms workspace-discovery timer is
//   untouched (it was never the slow one).
// ---------------------------------------------------------------------------------------------------------
{
  none('pruneTrash no longer fires 7000ms after boot (C-1.6)',
    /appTimers\.trash = setTimeout\(\(\) => pruneTrash\(\), 7000\);/.test(MAIN)
      ? [] : ['the trash-prune timer is not scheduled at 7000ms']);
  none('checkForUpdate no longer fires 9000ms after boot (C-1.6)',
    /setTimeout\(checkForUpdate, 9000\)/.test(MAIN)
      ? [] : ['the update-check timer is not scheduled at 9000ms']);
}

// ---------------------------------------------------------------------------------------------------------
// 95. C-4.6 — the two SILENT already-open jump paths get the same toast the refusal-recovery branch (main
//   refuses the re-point with reason 'open-elsewhere') already shows. openSession's same-workspace scan and
//   openWsSessionInTab's cross-project scan both just focused the existing tab with no feedback at all — a
//   click that visibly did nothing if the tab you landed on wasn't obviously different from the one you left.
// ---------------------------------------------------------------------------------------------------------
{
  none('openSession\'s same-workspace already-open branch no longer toasts (C-4.6)',
    /if \(rec\.wsId === activeWsId && rec\.session === id\) \{ setActiveTab\(rec\.tabId\); toast\('That session is already open — switched to its tab'\); return; \}/.test(APP)
      ? [] : ['openSession focuses the existing tab silently again']);
  none('openWsSessionInTab\'s cross-project already-open branch no longer toasts (C-4.6)',
    /if \(rec\.kind !== 'live' && rec\.wsId === w\.id && rec\.session === s\.id\) \{ setActiveTab\(rec\.tabId\); toast\('That session is already open — switched to its tab'\); return; \}/.test(APP)
      ? [] : ['openWsSessionInTab focuses the existing tab silently again']);
}

// ---------------------------------------------------------------------------------------------------------
// 96. C-4.4 — THE STRUCTURAL FIX (owners' decision, 2026-08-06): auto-creating sessions is removed entirely.
//   The five-times-patched phantom-draft family (dedupeBlankDraft/autoDraft + the onSyncChanged/boot "reconcile
//   a phantom draft once sessions land" dance) is retired outright rather than patched again. In its place: a
//   tab whose target project resolves to 'new' is PARKED (session:'new', parked:true) and shows a create
//   overlay — never a spawned pty — until an explicit Create click (which prompts for a name first, reusing
//   promptNewSession's modalPrompt conventions). A session list fetch failure (info.unknown) parks the SAME
//   way but shows a distinct retry overlay that must never read as "this project is empty".
// ---------------------------------------------------------------------------------------------------------
{
  const bodyOf = (name) => (APP.match(new RegExp('function ' + name + '\\([\\s\\S]*?(?=\\nfunction |\\nlet |\\nconst )')) || [''])[0];
  const swBody = bodyOf('switchWorkspace');
  // (a) THE PIN: no automatic newBlankTab('new') remains reachable from switchWorkspace. The real kill-switch
  //     is structural — sync() never starts a pty for a parked tab, no matter which caller reaches it — plus
  //     every branch that used to resolve 'new' now explicitly routes it through parkedTabFor before any
  //     newBlankTab call, so newBlankTab is only ever reached with a CONFIRMED real session id.
  none('sync() can auto-spawn a parked tab again (C-4.4\'s real kill-switch)',
    /if \(!t\.started && !t\.parked\) \{ t\.started = true; claudible\.tabOpen/.test(APP)
      ? [] : ['sync() no longer gates the first pty spawn on !t.parked']);
  none('a switchWorkspace branch stopped gating the empty/unreachable resolution before spawning (C-4.4)',
    [swBody ? '' : 'switchWorkspace(id, targetSession) not found',
     (swBody.match(/=== 'new'\) \{/g) || []).length >= 3 ? '' : 'fewer than 3 explicit empty-case gates in switchWorkspace (busy / normal / kept)',
     (swBody.match(/parkedTabFor\(id,/g) || []).length >= 3 ? '' : 'switchWorkspace does not route every empty-case branch through parkedTabFor'].filter(Boolean));
  // The normal (idle-tab) branch is the one that used to commit STRAIGHT to a respawn regardless of `sess` —
  // its `if (sess === 'new')` early-return must sit BEFORE the `await claudible.workspaceOpen(id, sess)` call,
  // or an empty project reached through this branch still auto-spawns exactly as it did pre-C-4.4.
  none('the normal switchWorkspace branch can reach workspaceOpen with sess===\'new\' again (C-4.4 auto-create)',
    (() => {
      const gateIdx = swBody.indexOf("if (sess === 'new') {");
      const openIdx = swBody.indexOf('await claudible.workspaceOpen(id, sess)');
      return (gateIdx !== -1 && openIdx !== -1 && gateIdx < openIdx) ? [] : ['the sess===\'new\' gate is missing, or does not run before workspaceOpen(id, sess)'];
    })());
  // (b) THE OVERLAY ELEMENT EXISTS: styled in index.html, built (as a per-tab sibling of the xterm mount —
  //     never a replacement for it) by paintCreateOverlay in app.js.
  none('the .create-ov overlay is gone from index.html (C-4.4)',
    [/\.create-ov\{/.test(HTML) ? '' : 'no .create-ov base rule',
     /\.create-ov\.show\{display:flex\}/.test(HTML) ? '' : 'no .create-ov.show rule',
     /\.create-ov-btn\{/.test(HTML) ? '' : 'no .create-ov-btn rule'].filter(Boolean));
  none('paintCreateOverlay stopped building/toggling the .create-ov element (C-4.4)',
    [/function paintCreateOverlay\(t\)/.test(APP) ? '' : 'paintCreateOverlay is gone',
     /ov\.className = 'create-ov'/.test(APP) ? '' : 'paintCreateOverlay no longer creates a .create-ov element',
     /if \(!t\.parked\) \{ if \(ov\) ov\.classList\.remove\('show'\); return; \}/.test(APP) ? '' : 'paintCreateOverlay no longer hides the overlay for a non-parked tab'].filter(Boolean));
  // (c) THE CREATE BUTTON PROMPTS FOR A NAME, before anything is created — reusing the same modalPrompt
  //     "Name this session" convention as the manage-menu's "+ New Session" (promptNewSession).
  none('createSessionFromOverlay stopped prompting for a session name before creating (C-4.4)',
    /async function createSessionFromOverlay\(t\)[\s\S]{0,400}?modalPrompt\(\{ title: 'Name this session'/.test(APP)
      ? [] : ['createSessionFromOverlay no longer calls modalPrompt before commitParkedTab']);
  none('createSessionFromOverlay can create on a Cancel/Esc (name === null) again (C-4.4)',
    /if \(name === null\) return;[\s\S]{0,300}?commitParkedTab\(t2, 'new', name \|\| ''\)/.test(APP)
      ? [] : ['createSessionFromOverlay no longer bails out before commitParkedTab on a null (cancelled) name']);
  // (d) THE ERROR PATH STAYS DISTINCT: an unreachable session list must never render as — or offer — "Create".
  none('the unknown-sessions overlay can render as (or act like) the create overlay again (C-4.4)',
    [/const unknown = \(t\.parkReason === 'unknown'\);/.test(APP) ? '' : 'paintCreateOverlay no longer branches on parkReason',
     /if \(cur\.parkReason === 'unknown'\) retryParkedTab\(cur\); else createSessionFromOverlay\(cur\);/.test(APP) ? '' : 'the overlay button no longer routes unknown → Retry / empty → Create separately',
     /async function retryParkedTab\(t\)/.test(APP) ? '' : 'retryParkedTab is gone'].filter(Boolean));
  // (e) CLEANUP: the retired mechanism is actually gone, not just unreferenced from switchWorkspace.
  none('the retired autoDraft/dedupeBlankDraft mechanism crept back in (C-4.4 said it could become dead)',
    /\bautoDraft\b/.test(APP.replace(/\/\/[^\n]*/g, '')) || /function dedupeBlankDraft/.test(APP)
      ? ['autoDraft or dedupeBlankDraft is referenced again outside comments'] : []);
}

// ---------------------------------------------------------------------------------------------------------
// 97. C-3.6 — the delete/trash flow (both owners' decision, 2026-08-06). Four pieces:
//   (1) every native confirm() on a session/project delete path is gone, replaced by the SAME in-app modal
//       convention (modalChoice) every other Claudible popup already uses.
//   (2) the modal's options depend on kind: LOCAL → Delete / Archive to trash (both the same recoverable
//       trash-move — there is no separate permanent-delete path for a local folder); SHARED (repo) → Delete
//       from GitHub / Delete only locally / Archive to trash. 'Delete from GitHub' is guarded by typing the
//       exact repo name, re-validated by main before it ever shells out to `gh repo delete`.
//   (3) a trash icon LEFT of the settings drawer's × opens the OS file manager on the trash folder directly.
//   (4) Settings gets Open trash + Delete trash (permanent, confirmed via the same modal first).
// ---------------------------------------------------------------------------------------------------------
{
  // (1) no native confirm() survives on the three exact strings this feature replaced (session delete + the
  //     two project-delete call sites) — a partial revert (fixing the wording back but leaving confirm()) would
  //     still fail this, since the STRINGS are gone, not just re-wrapped.
  none('a native confirm() crept back into a session-delete menu item (C-3.6)',
    /act: \(\) => \{ if \(confirm\('Delete/.test(APP)
      ? ['savedSessMenuItems still calls confirm() directly'] : []);
  none('a native confirm() crept back into a project-delete call site (C-3.6)',
    /if \(confirm\(deleteWsPrompt\(w\)\)\)/.test(APP)
      ? ['a project-delete site still calls confirm(deleteWsPrompt(w))'] : []);
  none('deleteWsPrompt (the retired native-confirm string builder) is back (C-3.6)',
    /function deleteWsPrompt\(w\)/.test(APP)
      ? ['deleteWsPrompt still exists — confirmDeleteWorkspace should have replaced it'] : []);

  // (2a) the modal exists and every session-delete path routes through it (confirmModal → modalChoice).
  none('confirmModal is gone, or no longer built on modalChoice (C-3.6)',
    /async function confirmModal\(title, body, okLabel\)[\s\S]{0,220}?modalChoice\(/.test(APP)
      ? [] : ['confirmModal missing, or not implemented via modalChoice']);
  none('a session-delete menu item stopped awaiting confirmModal (C-3.6)',
    (APP.match(/await confirmModal\(/g) || []).length >= 3   // "Delete for me" / "Delete everywhere" / plain "Delete"
      ? [] : ['fewer than 3 session-delete items call confirmModal']);

  // (2b) confirmDeleteWorkspace exists and branches on kind exactly as the constitution specifies.
  const cdw = (APP.match(/async function confirmDeleteWorkspace\(w\) \{[\s\S]*?\n\}\n/) || [''])[0];
  none('confirmDeleteWorkspace is gone (C-3.6)', cdw ? [] : ['confirmDeleteWorkspace not found']);
  none('a LOCAL project no longer offers both Delete and Archive to trash (C-3.6)',
    [/key: 'delete', label: 'Delete', danger: true/.test(cdw) ? '' : 'no plain Delete choice',
     /key: 'trash', label: 'Archive to trash'/.test(cdw) ? '' : 'no Archive to trash choice'].filter(Boolean));
  none('a SHARED (repo) project no longer offers all three delete options (C-3.6)',
    [/label: 'Delete from GitHub'/.test(cdw) ? '' : 'no Delete from GitHub choice',
     /label: 'Delete only locally'/.test(cdw) ? '' : 'no Delete only locally choice',
     (cdw.match(/label: 'Archive to trash'/g) || []).length >= 1 ? '' : 'no Archive to trash choice in the repo branch'].filter(Boolean));
  none('confirmDeleteWorkspace stopped branching on w.kind === \'repo\' (C-3.6)',
    /if \(w\.kind === 'repo'\) \{/.test(cdw) ? [] : ['the repo-kind branch is gone']);
  none('an adopted folder can reach the repo/local trash options again (C-3.6)',
    /if \(w\.adopted\) \{/.test(cdw) && cdw.indexOf("if (w.adopted) {") < cdw.indexOf("if (w.kind === 'repo')")
      ? [] : ['the adopted-folder branch no longer returns before the kind checks']);

  // (2c) 'Delete from GitHub' is guarded by typing the exact repo name, client AND server side.
  none('confirmDeleteFromGithub stopped requiring the typed repo name to match (C-3.6)',
    /async function confirmDeleteFromGithub\(w\)[\s\S]{0,1600}?if \(typed !== repoName\)/.test(APP)
      ? [] : ['confirmDeleteFromGithub no longer compares the typed value against repoName']);
  none('main no longer re-validates the typed repo name server-side (C-3.6)',
    /if \(!repoName \|\| String\(confirmName \|\| ''\) !== repoName\)/.test(MAIN)
      ? [] : ['workspace:deleteFromGithub trusts the renderer without re-checking confirmName']);
  none('the gh delete_repo scope hint is gone from delete-repo.sh (C-3.6)',
    /gh auth refresh -h github\.com -s delete_repo/.test(fs.readFileSync(path.join(ROOT, 'wsl', 'delete-repo.sh'), 'utf8'))
      ? [] : ['delete-repo.sh no longer tells the user how to grant the missing scope']);

  // (2c-i) THE DEAD END: GitHub keeps repository deletion behind a separate permission that an ordinary
  // sign-in does not grant, so the first delete always failed — after the user had already typed the repo
  // name — on a refusal they could do nothing with. The flow now asks for the permission BEFORE it asks for
  // any confirmation, and offers a one-click grant. Order is the whole fix: a pre-flight that runs after the
  // typed-name prompt would restore the exact dead end.
  const cdfg = (APP.match(/async function confirmDeleteFromGithub\(w\) \{[\s\S]*?\n\}\n/) || [''])[0];
  none('confirmDeleteFromGithub is gone (C-3.6)', cdfg ? [] : ['confirmDeleteFromGithub not found']);
  none('the GitHub delete-permission check no longer runs BEFORE the typed-name prompt (C-3.6)',
    cdfg && cdfg.includes('claudible.ghDeleteScope(') && cdfg.indexOf('claudible.ghDeleteScope(') < cdfg.indexOf('modalPrompt(')
      ? [] : ['the permission pre-flight is missing, or no longer precedes the typed-name prompt']);
  none('the grant step is gone from the delete flow (C-3.6)',
    /function grantGithubDeletePermission\(\)/.test(APP) && /claudible\.ghGrantDelete\(\)/.test(APP) && /claudible\.ghDeleteScope\(\)/.test(APP)
      ? [] : ['no grant modal, or it no longer polls the permission it asked for']);
  // ...and the OTHER half of that order fix: "couldn't read the permission" is not "the permission is
  // missing". A sign-in that never lists its permissions (a fine-grained token, or one handed over through the
  // environment) can still be allowed to delete, and cannot complete the approval step at all — so a check
  // that can't tell must let the deletion continue to GitHub's own answer, not stand in front of it. Reading
  // "unknown" as "missing" would turn this fix into a NEW dead end for those accounts.
  none('an unreadable permission answer now blocks the delete instead of letting GitHub answer (C-3.6)',
    cdfg && /scope\.checked && !scope\.hasScope/.test(cdfg)
      ? [] : ['the grant step is offered even when the permission state could not be read']);
  const scopeH = (MAIN.match(/ipcMain\.handle\('workspace:ghDeleteScope'[\s\S]*?\n\}\);\n/) || [''])[0];
  none('the permission check stopped saying whether it could read the answer at all (C-3.6)',
    scopeH && /checked: !!/.test(scopeH)
      ? [] : ['workspace:ghDeleteScope no longer distinguishes "missing" from "could not read"']);
  // (2c-ii) SECOND WARNING: the choice modal's "Delete from GitHub" option is warning #1; the typed-name
  // prompt must lead with the second, in plain words, before it asks for the name.
  none('the second delete-from-GitHub warning no longer precedes the typed-name confirm (C-3.6)',
    cdfg && cdfg.includes('delete this repository from GitHub')
      && cdfg.indexOf('delete this repository from GitHub') < cdfg.indexOf('Type the repo name to confirm')
      ? [] : ['the second warning sentence is missing, or no longer comes before the typed-name line']);
  // (2c-iii) Same security rule the sign-in device flow is pinned to above: the grant child prints text we
  // read a CODE out of, and NOTHING else — the page we open is always the fixed device URL, never a URL the
  // child chose. Exactly one openExternal in that handler, and it is the literal.
  const grantH = (MAIN.match(/ipcMain\.handle\('workspace:ghGrantDelete'[\s\S]*?\n\}\);\n/) || [''])[0];
  none('the delete-permission grant handler is gone (C-3.6)', grantH ? [] : ['workspace:ghGrantDelete not found']);
  none('the delete-permission grant opens a child-supplied URL (must be the fixed device page)',
    grantH && grantH.includes("shell.openExternal('https://github.com/login/device')") && (grantH.match(/openExternal\(/g) || []).length === 1
      ? [] : ['ghGrantDelete does not open exactly the one fixed device URL']);
  none('preload: the delete-permission bridges are missing (C-3.6)',
    /ghDeleteScope: \(\) => ipcRenderer\.invoke\('workspace:ghDeleteScope'\)/.test(PRELOAD)
      && /ghGrantDelete: \(\) => ipcRenderer\.invoke\('workspace:ghGrantDelete'\)/.test(PRELOAD)
      ? [] : ['ghDeleteScope/ghGrantDelete are not bridged']);

  // The delegation now passes force=true, and MUST. The remote repo is already deleted by this point,
  // so the dirty/unpushed refusal cannot apply — there is nothing left to push to, and refusing would strand the
  // workspace registered against a repo that no longer exists. The typed-exact-name confirm IS the override.
  none('workspace:deleteFromGithub stopped delegating to workspaceDeleteCore on success (C-3.6)',
    /if \(!r\.ok\) return \{ ok: false, error: r\.error \|\| 'gh repo delete failed' \};[\s\S]{0,900}?\n\s*return workspaceDeleteCore\(id, true, !!keepLocal\);/.test(MAIN)
      ? [] : ['a successful gh repo delete no longer falls through to the ordinary local delete — with force']);

  // (3) the trash icon sits in the settings drawer's head, left of the × close button, and opens the OS file
  //     manager on the trash folder (never a bare listing inside Claudible — "a basic function, nothing complex").
  none('the drawer-head trash icon button is gone from index.html, or moved to the wrong side (C-3.6)',
    /id="drawer-trash"[\s\S]{0,700}?id="drawer-close"/.test(HTML)
      ? [] : ['drawer-trash no longer sits immediately before drawer-close in the drawer-head markup']);
  none('the drawer-trash icon stopped opening the trash folder (C-3.6)',
    /\$\('drawer-trash'\)\.addEventListener\('click', openTrashFolder\)/.test(APP)
      ? [] : ['drawer-trash has no click handler wired to openTrashFolder']);

  // (4) Settings gets Open trash + Delete trash, the latter permanent and confirmed via the modal first.
  none('the settings drawer lost its Open trash / Delete trash buttons (C-3.6)',
    [/id="trash-open-btn"/.test(HTML) ? '' : 'no #trash-open-btn in index.html',
     /id="trash-delete-btn"/.test(HTML) ? '' : 'no #trash-delete-btn in index.html'].filter(Boolean));
  none('Delete trash stopped confirming via the modal before running (C-3.6)',
    /\$\('trash-delete-btn'\)\.addEventListener\('click', async \(\) => \{\s*\n\s*const ok = await confirmModal\(/.test(APP)
      ? [] : ['#trash-delete-btn no longer confirms via confirmModal before calling claudible.trashEmpty']);
  none('claudible.trashOpen / trashEmpty lost their preload bridge or main handler (C-3.6)',
    [/trashOpen: \(\) => ipcRenderer\.invoke\('trash:open'\)/.test(PRELOAD) ? '' : 'preload.trashOpen missing',
     /trashEmpty: \(\) => ipcRenderer\.invoke\('trash:empty'\)/.test(PRELOAD) ? '' : 'preload.trashEmpty missing',
     /ipcMain\.handle\('trash:open'/.test(MAIN) ? '' : "main has no ipcMain.handle('trash:open')",
     /ipcMain\.handle\('trash:empty'/.test(MAIN) ? '' : "main has no ipcMain.handle('trash:empty')"].filter(Boolean));
  // "Delete trash" reuses trash-prune.sh's own guards (must resolve to a real .claudible/trash leaf, direct
  // children only, symlinks unlinked never followed) via a flag, rather than a second `rm -rf` implementation.
  none('trash:empty stopped using the CLAUDIBLE_TRASH_EMPTY_ALL flag on trash-prune.sh (C-3.6)',
    /runScript\('trash-prune\.sh', '', \{ timeout: 120000, extraEnv: 'CLAUDIBLE_TRASH_EMPTY_ALL=1 ' \}\)/.test(MAIN)
      ? [] : ['trash:empty no longer passes CLAUDIBLE_TRASH_EMPTY_ALL to trash-prune.sh']);
  none('trash-prune.sh lost its EMPTY_ALL branch, or the guarded zap() is bypassed (C-3.6)',
    (() => {
      const tp = fs.readFileSync(path.join(ROOT, 'wsl', 'trash-prune.sh'), 'utf8');
      return /if \[ -n "\$EMPTY_ALL" \]; then/.test(tp) && (tp.match(/zap "\$p"/g) || []).length >= 3
        ? [] : ['the empty-all branch is gone, or no longer reuses zap() for its removals'];
    })());
}

// ---------------------------------------------------------------------------------------------------------
// 98. C-10.1 — update visibility, the owners' three-piece fix. (1) installed version + build sha visible in
//   Settings' About row, packaged builds included (readGitSha() can't see a commit there — no .git ships —
//   so readPackagedBuildSha() reads a build-time-embedded file instead, degrading to null the same way).
//   (2) the packaged update notice is a PERSISTENT chip (#update-avail), not the old one-time toast — the
//   toast call site is gone outright, not just re-wrapped. (3) Settings shows "you're on X · latest is Y"
//   once the once-per-launch release check has actually run, fed by a cached main-side result exposed
//   through a small pull-only IPC (update:status) that never itself triggers a new network call.
// ---------------------------------------------------------------------------------------------------------
{
  // (1a) BUILD falls back to the packaged-install sha when there's no .git to read, and buildIdentity.js
  //      actually exports the fallback (a revert of either half re-breaks packaged version/build display).
  none('BUILD lost its packaged-install (no .git) sha fallback (C-10.1)',
    /const BUILD = readGitSha\(__dirname\) \|\| readPackagedBuildSha\(__dirname\) \|\| \{ sha: '', short: '', at: 0 \};/.test(MAIN)
      ? [] : ['main.js no longer falls back to readPackagedBuildSha(__dirname) when readGitSha finds no .git']);
  none('readPackagedBuildSha is gone from lib/buildIdentity.js, or unexported (C-10.1)',
    (() => {
      const bi = fs.readFileSync(path.join(ROOT, 'lib', 'buildIdentity.js'), 'utf8');
      return /function readPackagedBuildSha\(dir\)/.test(bi) && /module\.exports = \{ readGitSha, readPackagedBuildSha \};/.test(bi)
        ? [] : ['readPackagedBuildSha missing, or not exported alongside readGitSha'];
    })());
  none('build.yml stopped embedding the packaged build sha before packaging (C-10.1)',
    (() => {
      const by = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build.yml'), 'utf8');
      return /echo "\$\{GITHUB_SHA::7\}" > build-sha\.txt/.test(by) ? [] : ['build.yml no longer writes build-sha.txt from GITHUB_SHA'];
    })());
  none('package.json stopped shipping build-sha.txt in the packaged app (C-10.1)',
    /"build-sha\.txt",/.test(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
      ? [] : ['build-sha.txt is no longer in the electron-builder "files" list']);

  // (1b) the About row exists in the drawer and paints version + sha from the SAME boot-time fetches the
  //      status-bar badge already made — no new network/IPC round trip on drawer open.
  none('the Settings About row (#about-version / #about-update) is gone from index.html (C-10.1)',
    [/id="about-version"/.test(HTML) ? '' : 'no #about-version in index.html',
     /id="about-update"/.test(HTML) ? '' : 'no #about-update in index.html'].filter(Boolean));
  none('paintAboutRow stopped showing version + build sha (C-10.1)',
    /function paintAboutRow\(\) \{[\s\S]{0,220}?APP_VERSION[\s\S]{0,140}?MY_SHA/.test(APP)
      ? [] : ['paintAboutRow no longer reads both APP_VERSION and MY_SHA']);
  none('the boot version fetch stopped setting APP_VERSION (C-10.1)',
    // What C-10.1 needs is that the boot fetch SETS APP_VERSION, which is what paintAboutRow reads. The old
    // form also pinned a write to #app-ver — a second version line that printed the same string as
    // #about-version, in the speaker menu; that element is gone, so the pin names only the rule that matters.
    /claudible\.appVersion\(\)[\s\S]{0,160}?APP_VERSION = av/.test(APP)
      ? [] : ['the app:version boot fetch no longer sets APP_VERSION']);

  // (2a) the toast call site is GONE — a partial revert that re-adds the toast text while leaving the chip
  //      markup behind would still fail this (the constitution says the toast is REPLACED, not duplicated).
  none('the old one-time update toast crept back in (C-10.1 replaced it with a persistent chip)',
    /toast\('Claudible ' \+ p\.latest \+ ' is out/.test(APP)
      ? ["onUpdateAvailable still calls toast('Claudible ' + p.latest + ' is out…')"] : []);
  none('onUpdateAvailable stopped painting the persistent #update-avail chip (C-10.1)',
    /const el = \$\('update-avail'\), tx = \$\('update-avail-txt'\);[\s\S]{0,200}?el\.style\.display = '';/.test(APP)
      ? [] : ['onUpdateAvailable no longer shows the #update-avail chip']);
  none('the #update-avail chip markup is gone from index.html, or lost its Download button (C-10.1)',
    [/id="update-avail" style="display:none"/.test(HTML) ? '' : 'no #update-avail chip in index.html',
     /id="update-avail-txt"/.test(HTML) ? '' : 'no #update-avail-txt span',
     /id="update-avail-open"/.test(HTML) ? '' : 'no #update-avail-open button'].filter(Boolean));
  none('#update-avail-open stopped opening the GitHub releases page (C-10.1)',
    /\$\('update-avail-open'\)[\s\S]{0,120}?claudible\.openExternal\('https:\/\/github\.com\/synthetiks\/claudible\/releases\/latest'\)/.test(APP)
      ? [] : ['#update-avail-open no longer opens the releases page via claudible.openExternal']);

  // (2b) checkForUpdate's early-return regression guard: a revert that puts back `|| latest === mine` would
  //      make lastUpdateCheck (and therefore Settings' line) never populate for an up-to-date install.
  none('checkForUpdate stopped caching the up-to-date case too (C-10.1 piece 3 needs it even when not newer)',
    /if \(!\/\^\\d\+\\\.\\d\+\\\.\\d\+\$\/\.test\(latest\)\) return;/.test(MAIN) && !/if \(!\/\^\\d\+\\\.\\d\+\\\.\\d\+\$\/\.test\(latest\) \|\| latest === mine\) return;/.test(MAIN)
      ? [] : ["checkForUpdate's early return still short-circuits on latest === mine before caching"]);
  none('checkForUpdate stopped writing lastUpdateCheck on every successful check (C-10.1)',
    /lastUpdateCheck = \{ mine, latest, newer \};/.test(MAIN)
      ? [] : ['checkForUpdate no longer caches { mine, latest, newer } to lastUpdateCheck']);

  // (3) the cache is exposed via a small pull-only IPC, wired end to end, and Settings actually reads it on
  //     drawer open (never on a timer, never blocking the drawer's instant paint — C-9.1).
  none('update:status lost its main handler, or its preload bridge (C-10.1)',
    [/ipcMain\.handle\('update:status', \(\) => lastUpdateCheck\)/.test(MAIN) ? '' : "no ipcMain.handle('update:status', ...) in main.js",
     /updateStatus: \(\) => ipcRenderer\.invoke\('update:status'\)/.test(PRELOAD) ? '' : 'no updateStatus bridge in preload.js'].filter(Boolean));
  none('refreshAboutRow stopped reading claudible.updateStatus() (C-10.1)',
    /async function refreshAboutRow\(\) \{[\s\S]{0,220}?claudible\.updateStatus\(\)/.test(APP)
      ? [] : ['refreshAboutRow no longer calls claudible.updateStatus()']);
  none('refreshAboutRow is no longer called when the drawer opens (C-10.1)',
    /try \{ refreshAboutRow\(\); \} catch \(e\) \{\} \}/.test(APP)
      ? [] : ['openDrawer no longer calls refreshAboutRow() on open']);
  none('paintAboutUpdateLine stopped rendering "you\'re on X · latest is Y" (C-10.1)',
    /function paintAboutUpdateLine\(mine, latest, newer\)[\s\S]{0,260}?you're on/.test(APP)
      ? [] : ['paintAboutUpdateLine no longer builds the "you\'re on X · latest is Y" line']);
}

// ---------------------------------------------------------------------------------------------------------
// 99. C-5.9 — the roster redesign (owners' note, 2026-08-06). Badges become ~2× bigger and rectangular
//   (.hv-btn/.chat-term's shape language); the kick ✕ is visible by default, not hover-only; "Group Chat"
//   becomes "Chat"; and the host is ALWAYS labeled as host — "HOST (name)" once a name is set, plain "HOST"
//   otherwise — through ONE format function used by both the roster and every chat "who" line, on the
//   Electron app AND the browser guest page (share/guest.js has its own copy; no shared module to import).
// ---------------------------------------------------------------------------------------------------------
{
  none('the kick ✕ went back to hover-only opacity (C-5.9 — must be visible by default)',
    /\.rmember:hover \.rkick\{opacity/.test(HTML)
      ? ['.rmember:hover .rkick{opacity…} is back in index.html — the ✕ is hidden until hover again'] : []);
  none('the kick ✕ lost its non-zero default opacity (C-5.9)',
    /\.rkick\{[^}]*opacity:\.9[^}]*\}/.test(HTML)
      ? [] : ['.rkick{…} no longer sets a visible-by-default opacity']);
  none('name badges are no longer rectangular / button-shaped (C-5.9)',
    /\.rmember\{[^}]*height:28px[^}]*border-radius:8px[^}]*\}/.test(HTML)
      ? [] : ['.rmember{…} lost the 28px height / 8px radius that matches .hv-btn/.chat-term']);
  none('the roster strip stopped being horizontally scrollable (C-5.9 — more than 2-3 guests must stay reachable)',
    /\.chat-roster\{[^}]*overflow-x:auto[^}]*\}/.test(HTML)
      ? [] : ['#chat-roster no longer sets overflow-x:auto']);
  none('the old "+N" pop-down fold crept back in (C-5.9 replaced it with strip scrolling)',
    /roster-more|roster-pop/.test(HTML) || /roster-more|roster-pop|computeRosterOverflow/.test(APP)
      ? ['a roster-more/roster-pop/computeRosterOverflow reference is back — the strip should scroll, not fold']
      : []);
  // 2026-08-15, owners: the header is "Live Session" with a live dot, not "Chat". The panel only exists while
  // sharing (`.body.sharing .chat`) and the browser guest page only exists inside a live session, so on both
  // sides the header names what the panel IS. "Group Chat" — the label the 2026-08-06 note removed for not
  // fitting its spot — must still never come back, and the two pages must still agree with each other.
  none('the chat header is not "Live" with its live dot (C-5.9, owners 2026-08-15)',
    [/Group Chat/.test(HTML) ? 'index.html has the long-removed "Group Chat" label back' : '',
     /<span class="chat-title" id="chat-title"><span class="live-dot" id="live-dot"><\/span><span id="live-txt">Live<\/span><\/span>/.test(HTML)
       ? '' : 'no <span class="chat-title" id="chat-title"> carrying #live-dot + #live-txt "Live" in index.html'].filter(Boolean));
  none('guest.html\'s chat header no longer matches the host label (C-5.9 — the two pages must say the same thing)',
    [/Group Chat/.test(GUEST_HTML) ? 'guest.html has the long-removed "Group Chat" label back' : '',
     /<span class="chat-title"><span class="live-dot"><\/span><span>Live<\/span><\/span>/.test(GUEST_HTML)
       ? '' : 'no <span class="chat-title"> carrying a .live-dot + "Live" in guest.html'].filter(Boolean));
  // the dot is not decoration: it is the only carrier of the two alarm states the deleted live bar used to
  // own. Losing either rule loses a warning, not a colour — a host would be told "Live Session" while their
  // guests are frozen out, or lose the way back to a session they left running.
  none('the chat header lost the paused/elsewhere alarm states the live bar used to carry (C-5.2/C-5.9)',
    [/html\.skin \.chat-title\.paused \.live-dot\{[^}]*var\(--warn\)/.test(HTML) ? '' : 'no html.skin .chat-title.paused .live-dot rule painting --warn — a frozen mirror would paint calm green',
     /liveTxt\.textContent = paused \? 'Paused' : 'Live'/.test(APP) ? '' : 'the header no longer says "Paused" while the mirror is frozen',
     /title\.classList\.toggle\('elsewhere', elsewhere && !paused\)/.test(APP) ? '' : 'the header no longer marks the browsing-elsewhere state',
     /if \(!_ct\.classList\.contains\('elsewhere'\)\) return;/.test(APP) ? '' : 'the header is no longer the way back to a live session left running elsewhere'].filter(Boolean));
  // the bar itself must stay gone — a resurrected #livebar would put the roster back above the terminal and
  // re-split the co-drive warning across two homes.
  none('the live bar above the terminal is back (owners removed it 2026-08-15)',
    [/id="livebar"/.test(HTML) ? 'index.html has a #livebar element again' : '',
     /id="live-members"/.test(HTML) ? 'index.html has a #live-members roster above the terminal again' : ''].filter(Boolean));
  // the HOST() label function: defined once per file (renderer + browser guest page each need their own copy),
  // and actually used by BOTH the roster (renderRoster's "you" chip + the host's roster pill) and chat (the
  // host's own outgoing "who", and every received host chat line) — a partial wire-up would still leave the
  // exact mismatch the owners called out: bare name in the roster, "HOST" only in chat.
  // 2026-08-15, owners: sentence case — "Host (name)" / "Host". The redesign's chat is a quiet mono column and
  // an all-caps label was the loudest thing in it. The RULE is untouched; only the casing moved.
  none('app.js lost the HOST() label function (C-5.9)',
    /function HOST\(name\) \{ const n = String\(name \|\| ''\)\.trim\(\); return n \? `Host \(\$\{n\}\)` : 'Host'; \}/.test(APP)
      ? [] : ['app.js no longer defines function HOST(name) with the "Host (name)" / "Host" format']);
  none('guest.js lost its own HOST() label function (C-5.9 — browser page has no shared module with the renderer)',
    /function HOST\(name\) \{ var n = String\(name \|\| ''\)\.trim\(\); return n \? \('Host \(' \+ n \+ '\)'\) : 'Host'; \}/.test(GUEST_JS)
      ? [] : ['guest.js no longer defines function HOST(name) with the "Host (name)" / "Host" format']);
  // ONE SOURCE FOR THE HOST'S NAME. This is the pin the "top bar says Host (crazy), chat says Host (Host)"
  // report earned. hostDisplayName was declared as the literal 'Host' and only assigned in doStartSharing, a
  // path a collab share never runs — so the roster read the real username and the chat read a placeholder
  // that looks exactly like a real name. advertisedHostName() returns the same expression ensureTunnel puts
  // on the wire, and returns EMPTY rather than a placeholder, so HOST() falls through to plain "Host".
  none('the host name is being read from two different sources again (C-5.9 — this is the "Host (Host)" bug)',
    [/function advertisedHostName\(\) \{ return collabName\(\) \|\| hostDisplayName \|\| ''; \}/.test(APP)
       ? '' : 'advertisedHostName() is gone or no longer mirrors what ensureTunnel advertises',
     /^let hostDisplayName = '';$/m.test(APP)
       ? '' : "hostDisplayName is initialised to something other than '' — a placeholder that reads like a name is the whole defect",
     /hostDisplayName = typed \|\| collabName\(\) \|\| '';/.test(APP)
       ? '' : "doStartSharing reintroduced a placeholder fallback for hostDisplayName",
     (APP.match(/HOST\(hostDisplayName\)/g) || []).length === 0
       ? '' : 'a label reads hostDisplayName directly again instead of advertisedHostName()'].filter(Boolean));
  none('renderRoster stopped labeling the host with HOST() (C-5.9)',
    [/you\.appendChild\(document\.createTextNode\(hosting \? HOST\(advertisedHostName\(\)\) : youName\(\)\)\);/.test(APP)
       ? '' : 'the "you" chip no longer wraps HOST(advertisedHostName()) when you are hosting',
     /m\.appendChild\(d\); m\.appendChild\(document\.createTextNode\(g\.host \? HOST\(g\.name\) : g\.name\)\);/.test(APP)
       ? '' : 'the roster member loop no longer wraps HOST() around a host entry\'s name'].filter(Boolean));
  // resolved at PAINT time, not frozen into the buffer at send time: a label baked into a message composed
  // before the name resolved could never be corrected by a repaint, which is how "Host (Host)" survived.
  none('the host\'s own outgoing chat message stopped resolving its label at paint time (C-5.9)',
    [/chatAppend\(hostChat, \{ host: true, text, mine: true \}, true\)/.test(APP)
       ? '' : 'sendChat no longer marks your own host-share message with host:true for late resolution',
     /const whoText = m\.host \? HOST\(m\.hostName != null \? m\.hostName : advertisedHostName\(\)\) : m\.who;/.test(APP)
       ? '' : 'renderChatLog no longer resolves a host message\'s label at paint time'].filter(Boolean));
  none('a joined tab\'s received host chat stopped using HOST() (C-5.9)',
    /p\.role === 'host' \? \{ host: true, hostName: p\.name \|\| rec\.hostName \|\| '', text: p\.text, mine: false \}/.test(APP)
      ? [] : ['onLiveChat no longer carries the HOST\'s own advertised name for late resolution — resolving it from OUR name would label a different person']);
  none('guest.js\'s chat rendering stopped using HOST() for host messages (C-5.9)',
    /addChat\(HOST\(msg\.name \|\| hostName\), msg\.text, false, null, true\);/.test(GUEST_JS)
      ? [] : ['guest.js\'s chat handler no longer wraps a host message\'s name in HOST()']);
}

// ---------------------------------------------------------------------------------------------------------
// 99b. WHO SAID THIS — one colour per person (owners, 2026-08-15). A live chat gives each author a hue: it
//   inks their name and tints the ground behind their messages, so the eye groups a speaker without reading a
//   word. Two properties are load-bearing and neither is taste.
//   (1) THE SAME PERSON IS THE SAME COLOUR ON BOTH SIDES. The renderer and the browser guest page each carry
//       their own copy of the palette and the slot rule (no shared module), so they are pinned against each
//       other — a drift means the host and the guest see one conversation in two different colour schemes.
//   (2) THE NAME STAYS READABLE. The hue inks the sender name, which is the ONLY identity cue on a message
//       (they are not bubbles — no face, no side, no tail). "Subtle" is a constraint on the TINT, never a
//       licence to dim the text: --ink-name was raised out of a ~2:1 hole for exactly this reason and these
//       eight must not walk it back. The tint is 6% and the ink is the full value; those are different jobs.
//   The untinted path is live, not decorative: an author that cannot be keyed ships with no data-tint and
//   keeps --ink-name, which is why that token is still the default ink for .who rather than dead code.
//   RE-MEASURED 2026-08-15 after the owners toned the names down to 30% hue over the neutral. 8 colours ×
//   4 themes = 32 cells, each ink against the ground it actually sits on (that theme's --chrome with the
//   author's own 6% tint composited over it, not bare --chrome):
//       slot           dark  graphite  midnight  cockpit
//       1 host/orange  4.88    4.83      4.85     4.88
//       2 blue         5.33    5.27      5.33     5.21
//       3 green        5.58    5.51      5.57     5.46
//       4 purple       5.21    5.15      5.20     5.13
//       5 cyan         5.64    5.57      5.64     5.50
//       6 pink         5.27    5.21      5.24     5.24
//       7 amber        5.64    5.56      5.59     5.59
//       8 teal         5.59    5.52      5.58     5.46
//   Worst cell 4.83:1, floor 4.5:1. The toning is real and not cosmetic: the host's orange drops from 60% to
//   16% chroma, i.e. 73% less colourful, which is what was asked for. Mixing TOWARD --ink-name rather than
//   dimming is what keeps the floor — the eight land within a hair of --ink-name's own 4.93-5.02 instead of
//   below it. Guest page, same rule over its own --ink-name: worst 4.77:1.
//   If the 30% or any hue is ever retuned, RE-MEASURE. The orange is the tightest cell and it is the host's,
//   so it is the one that goes under first.
// ---------------------------------------------------------------------------------------------------------
{
  const WHO = ['#d97757', '#6fa8f5', '#62c98d', '#b48cf0', '#56c8d8', '#ef85b5', '#e0b158', '#55c9b0'];
  none('the 8 author colours are missing or have drifted apart between the two pages (owners 2026-08-15)',
    WHO.flatMap((hex, i) => {
      const n = i + 1;
      return [new RegExp('--who-' + n + ':' + hex + ';').test(HTML) ? '' : `--who-${n} is not ${hex} in index.html`,
              new RegExp('--who-' + n + ':' + hex + ';').test(GUEST_HTML) ? '' : `--who-${n} is not ${hex} in guest.html — the guest page would colour the same person differently`];
    }).filter(Boolean));
  none('the host is no longer always the first author slot (owners: host orange, then guests in join order)',
    [/function tintFor\(name, isHost\) \{\s*\n\s*if \(isHost\) return 1;/.test(APP) ? '' : 'app.js tintFor no longer pins the host to slot 1',
     /function tintFor\(name, isHost\) \{\s*\n\s*if \(isHost\) return 1;/.test(GUEST_JS) ? '' : 'guest.js tintFor no longer pins the host to slot 1'].filter(Boolean));
  // keyed case-INSENSITIVELY, because the share server dedups names that way (its nameTaken/eqCI). Without
  // this, "MK" and "mk" are one person on the wire and two colours on screen.
  none('author colours stopped being keyed case-insensitively (one person would get two colours)',
    [/authorTints\.get\(k\)/.test(APP) && /String\(name \|\| ''\)\.trim\(\)\.toLowerCase\(\)/.test(APP) ? '' : 'app.js tintFor no longer lower-cases its key',
     /String\(name \|\| ''\)\.trim\(\)\.toLowerCase\(\)/.test(GUEST_JS) ? '' : 'guest.js tintFor no longer lower-cases its key'].filter(Boolean));
  // the tint is a GROUND, not a face. 6% over --chrome is a shift you feel and cannot name; a bigger number
  // is what turns a two-person chat into a colour chart, which is the thing the owners asked against.
  none('the message tint stopped being subtle (owners: a visual cue, not a circus)',
    [/html\.skin \.chat-msg\[data-tint\]\{[^}]*color-mix\(in srgb,var\(--who-tint\) 6%,transparent\)/.test(HTML)
       ? '' : 'the renderer message tint is no longer 6% of the author hue',
     /\.chat-msg\.them\[data-tint\]\{background:color-mix\(in srgb,var\(--who-tint\) 8%,#14171c\)/.test(GUEST_HTML)
       ? '' : 'the guest page message tint is no longer 8% of the author hue over its bubble'].filter(Boolean));
  // the name takes a TOUCH of the hue over the neutral ink — 30%, owners 2026-08-15: at full strength it read
  // as a colour chart rather than a cue, and the name's job is to say who, quietly. Mixing toward the neutral
  // rather than dimming is what keeps the contrast the sender line was raised to. --ink-name remains the
  // default for an unkeyed author — the fallback that keeps that token honest rather than something the tint
  // quietly replaced. If the 30% is ever changed, re-measure: the mix is what holds the floor.
  none('the sender name lost its author tint, or --ink-name stopped being the real fallback',
    [/html\.skin \.chat-msg \.who\{[^}]*color:var\(--ink-name\)/.test(HTML) ? '' : '.who no longer defaults to --ink-name for an unkeyed author',
     /html\.skin \.chat-msg\[data-tint\] \.who\{color:color-mix\(in srgb,var\(--who-tint\) 30%,var\(--ink-name\)\)\}/.test(HTML) ? '' : '.who no longer takes 30% of the author hue over --ink-name',
     /\.chat-msg\[data-tint\] \.who\{color:color-mix\(in srgb,var\(--who-tint\) 30%,var\(--ink-name\)\)\}/.test(GUEST_HTML) ? '' : 'guest.html .who no longer takes 30% of the author hue over its neutral ink',
     /--ink-name:#9a9086;/.test(GUEST_HTML) ? '' : 'guest.html lost its own --ink-name — it would fall back to --ink-faint, which measured 3.52:1 on the message bubbles (below the readable floor for the only line that says who wrote something)',
     /\.chat-msg \.who\{[^}]*color:var\(--ink-name\)/.test(GUEST_HTML) ? '' : 'guest.html .who no longer defaults to --ink-name'].filter(Boolean));
}

// ---------------------------------------------------------------------------------------------------------
// 100. C-3.4 — NAMING COMPLETION: the three gaps the round-3a verifier found in the b7da892 unified-naming
//   work. (1) SESSION names get the same live "which characters aren't allowed" popover project names have,
//   but against a WIDER charset — session names only ever cross a shell as base64 (sessions-sync.sh's
//   title-set), so spaces/punctuation are safe and only control characters are blocked. (2) delete-repo.sh
//   still refused a GitHub-legal dotted/underscored ws.repoName. (3) repo:invite still sanitized repoName
//   down to the folder-slug charset before inviting, so `my_repo` silently targeted `myrepo`.
// ---------------------------------------------------------------------------------------------------------
{
  // (1a) the session charset is genuinely WIDER than the project one — spaces/punctuation allowed, only C0
  //   control chars + DEL blocked — and disallowedNameChars/wireNameValidator can be handed it.
  none('the session-name charset is missing, or no longer wider than the project/GitHub one (C-3.4)',
    [/const SESSION_NAME_CHAR_RE = \/\[\^\\x00-\\x1F\\x7F\]\//.test(APP) ? '' : 'SESSION_NAME_CHAR_RE missing or no longer just blocks control characters',
     /function disallowedNameChars\(s, allowedRe\)/.test(APP) ? '' : 'disallowedNameChars no longer takes an allowedRe param',
     /function wireNameValidator\(input, getBtn, opts\)/.test(APP) ? '' : 'wireNameValidator no longer takes an opts param (charRe/note)'].filter(Boolean));
  // (1b) modalPrompt (the "Name this session" dialog) can opt into that validator, and both real session-naming
  //   call sites (promptNewSession, createSessionFromOverlay) actually opt in — confirmDeleteFromGithub, the
  //   modal's OTHER caller, must NOT (it types back an existing repo name verbatim), so this checks the wiring
  //   exists rather than making it unconditional.
  none('modalPrompt lost its session-name validation opt-in, or stopped wiring it through (C-3.4)',
    [/function modalPrompt\(\{ title, body, placeholder, value, ok, validateNames, checkbox \}\)/.test(APP) ? '' : 'modalPrompt no longer accepts a validateNames option',
     /if \(validateNames\) wireNameValidator\(inp, \(\) => okb, \{ charRe: SESSION_NAME_CHAR_RE, note: SESSION_NAME_NOTE \}\);/.test(APP) ? '' : 'modalPrompt does not wire SESSION_NAME_CHAR_RE to its input when validateNames is set'].filter(Boolean));
  none('promptNewSession / createSessionFromOverlay stopped asking their "Name this session" modalPrompt to validate (C-3.4)',
    (APP.match(/title: 'Name this session'[\s\S]{0,180}?validateNames: true/g) || []).length >= 2
      ? [] : ['fewer than 2 "Name this session" modalPrompt calls pass validateNames: true']);
  // (2) delete-repo.sh: ws.repoName can legitimately hold dots/underscores after b7da892 — the $2 check must
  //   accept GitHub's own repo-name charset, same as rename-repo.sh/repo-invite.sh, not just [A-Za-z0-9-].
  none('delete-repo.sh went back to refusing GitHub-legal dotted/underscored repo names (C-3.4)',
    /case "\$name"\s+in ''\s*\|\s*\.\s*\|\s*\.\.\s*\|\s*\*\[!A-Za-z0-9\._-\]\*\)/.test(read('wsl/delete-repo.sh'))
      ? [] : ['delete-repo.sh\'s $name check is not widened to GitHub\'s repo-name charset']);
  // (3) repo:invite: the two-value treatment (exact repoName to GitHub, sanitized slug only for local use)
  //   that b7da892 already gave clone/discovery/rename, now applied here too — and repo-invite.sh's own
  //   shell-side guard widened to match, so a script called directly can't reintroduce the mangle either.
  none('repo:invite sanitizes repoName down to the folder-slug charset again (an invite to my_repo would target myrepo) (C-3.4)',
    /const repo = isGithubRepoName\(ws\.repoName \|\| ws\.slug \|\| ''\) \? String\(ws\.repoName \|\| ws\.slug\) : '';/.test(MAIN)
      ? [] : ['ipcMain repo:invite no longer derives repo via isGithubRepoName']);
  none('repo-invite.sh went back to refusing GitHub-legal dotted/underscored repo names (C-3.4)',
    /case "\$slug"\s+in ''\s*\|\s*\.\s*\|\s*\.\.\s*\|\s*\*\[!A-Za-z0-9\._-\]\*\)/.test(read('wsl/repo-invite.sh'))
      ? [] : ['repo-invite.sh\'s $slug check is not widened to GitHub\'s repo-name charset']);
}

// ---------------------------------------------------------------------------------------------------------
// 101. C-2.5 — WIZARD GITHUB GATING (owners' decision, 2026-08-06): the wizard must actively ASK whether to
//   connect GitHub and must not continue past that step until GitHub is connected OR the user explicitly
//   skips. wiz-finish starts disabled in the markup; applyGh() is the only place that re-enables it, either
//   because s.ghSignedIn came back true (already-connected users sail through with no click) or because
//   skipGh() was explicitly clicked (the labeled Skip control, distinct from the whole-wizard wiz-skip link).
// ---------------------------------------------------------------------------------------------------------
{
  // (a) Finish is gated: the button starts disabled in the HTML, not left implicitly enabled.
  none('wiz-finish is no longer disabled by default in index.html (C-2.5 — Finish must not complete the step unconditionally)',
    /<button id="wiz-finish" class="primary" disabled>Finish<\/button>/.test(HTML)
      ? [] : ['wiz-finish button no longer has the disabled attribute in its markup']);
  // (b) the step's own explicit Skip control exists (separate from wiz-skip, which abandons the whole wizard)
  //   and clicking it is what is allowed to unlock Finish.
  none('the GitHub step\'s explicit Skip control is missing from index.html (C-2.5)',
    /<button id="wiz-gh-skip" class="ghost" type="button" style="display:none">Skip for now — you can connect later in Settings<\/button>/.test(HTML)
      ? [] : ['wiz-gh-skip button missing or its label/markup changed']);
  none('skipGh() no longer sets ghSkipped and enables wiz-finish (C-2.5)',
    /function skipGh\(\) \{ ghSkipped = true; const fin = \$\('wiz-finish'\); if \(fin\) fin\.disabled = false; \}/.test(APP)
      ? [] : ['skipGh() missing or no longer flips ghSkipped / enables wiz-finish']);
  none('wiz-gh-skip lost its click listener wired to skipGh (C-2.5)',
    /\$\('wiz-gh-skip'\)\.addEventListener\('click', skipGh\);/.test(APP)
      ? [] : ['wiz-gh-skip has no click listener calling skipGh']);
  // (c) already-signed-in short-circuits: applyGh enables Finish (and hides the skip control) when
  //   s.ghSignedIn is true, with no click required — existing users, or a user who just connected, sail through.
  none('applyGh no longer auto-enables wiz-finish when s.ghSignedIn is true (C-2.5 — already-connected users must sail through)',
    /if \(fin\) fin\.disabled = false;\s*\n\s*ghWaiting = false; pollStop\(\);/.test(APP)
      ? [] : ['the s.ghSignedIn branch of applyGh no longer clears wiz-finish.disabled']);
  // (d) the not-yet-connected branches gate Finish on ghSkipped specifically — not left permanently enabled,
  //   and not left permanently disabled with no way to skip.
  none('applyGh\'s not-signed-in branches stopped gating wiz-finish on ghSkipped (C-2.5)',
    (APP.match(/if \(fin\) fin\.disabled = !ghSkipped;/g) || []).length >= 2
      ? [] : ['fewer than 2 applyGh branches gate wiz-finish.disabled on !ghSkipped']);
}

// ---------------------------------------------------------------------------------------------------------
// 102. C-7.3 — THE OWNERS' MANUAL-PATH ADDITION. On an auto-provision failure the app must (1) surface what
//   to do next — a real action on the failure chip, not just a log-path string in a title attribute — and
//   (2) offer a RESCAN that re-checks voiceProvisioned() fresh and, with no download, clears the failed
//   stamp + flips the settings voice row green the moment a hand-installed tree satisfies it.
// ---------------------------------------------------------------------------------------------------------
{
  // (a) voice:rescan exists, is wired end to end, re-checks FRESH (not a cached flag), and only clears the
  //   failed stamp — never sets it, never spawns setup-win.ps1 — so a miss stays a miss with no side effect.
  none('voice:rescan handler is missing or no longer re-checks voiceProvisioned() fresh (C-7.3)',
    [/ipcMain\.handle\('voice:rescan', \(\) => \{/.test(MAIN) ? '' : "no ipcMain.handle('voice:rescan', ...) in main.js",
     /const ready = voiceProvisioned\(\);/.test(MAIN) ? '' : 'voice:rescan does not call voiceProvisioned() fresh',
     /delete s\.voiceProvisionFailedAt; delete s\.voiceProvisionFailedCode; writeSettings\(s\); \} \} catch \{\} \}\s*\n\s*return \{ ok: true, voiceReady: ready \};/.test(MAIN)
       ? '' : 'voice:rescan no longer clears the failed stamp on success before returning',
     /voiceRescan: \(\) => ipcRenderer\.invoke\('voice:rescan'\)/.test(PRELOAD) ? '' : 'no voiceRescan bridge in preload.js'].filter(Boolean));
  // (b) the settings voice row's Rescan button exists, is wired to a handler that actually calls
  //   claudible.voiceRescan() (not just re-painting stale state), and on success clears the notice.
  none('the settings voice row lost its Rescan control, or Rescan no longer calls claudible.voiceRescan() (C-7.3)',
    [/<button type="button" class="eff-pill" id="voice-setup-rescan">Rescan<\/button>/.test(HTML) ? '' : 'voice-setup-rescan button missing from index.html',
     /\$\('voice-setup-rescan'\)\.addEventListener\('click', voiceRescanClick\)/.test(APP) ? '' : 'voice-setup-rescan has no click listener calling voiceRescanClick',
     /async function voiceRescanClick\(\) \{[\s\S]{0,240}?claudible\.voiceRescan\(\)/.test(APP) ? '' : 'voiceRescanClick no longer calls claudible.voiceRescan()',
     /r && r\.ok && r\.voiceReady\) \{[\s\S]{0,80}?hideVoiceSetupNote\(\)/.test(APP) ? '' : 'a successful rescan no longer hides the settings voice-setup notice'].filter(Boolean));
  // (c) the failure path surfaces the manual info — the chip carries a real click action (not bare text), and
  //   that action, plus the settings row's own button, both open the manual-steps panel.
  none('the voice failure chip stopped offering "see how to fix it" (C-7.3)',
    [/note\.innerHTML = 'voice setup failed — <button type="button" class="linkbtn" id="voice-fix-link">see how to fix it<\/button>';/.test(APP)
       ? '' : 'the error-phase chip no longer renders a see-how-to-fix-it action',
     /fixBtn\.addEventListener\('click', \(e\) => \{ e\.stopPropagation\(\); openVoiceManual\(\); \}\)/.test(APP) ? '' : 'the chip action no longer opens openVoiceManual()',
     /\$\('voice-setup-fix'\)\.addEventListener\('click', openVoiceManual\)/.test(APP) ? '' : 'the settings voice row\'s "See how to fix it" button no longer opens openVoiceManual()'].filter(Boolean));
  // (d) the manual-steps panel actually carries the manual info: log path + per-item on-disk target, sourced
  //   from main's voice:manualInfo (the same paths voiceProvisioned() checks — never re-typed by hand in the UI).
  none('voice:manualInfo handler is missing, or the manual panel stopped rendering its items (C-7.3)',
    [/ipcMain\.handle\('voice:manualInfo', \(\) => voiceManualInfo\(\)\);/.test(MAIN) ? '' : "no ipcMain.handle('voice:manualInfo', ...) in main.js",
     /function voiceManualInfo\(\) \{/.test(MAIN) ? '' : 'voiceManualInfo() is gone from main.js',
     /voiceManualInfo: \(\) => ipcRenderer\.invoke\('voice:manualInfo'\)/.test(PRELOAD) ? '' : 'no voiceManualInfo bridge in preload.js',
     /pth\.textContent = 'put it at: ' \+ it\.path;/.test(APP) ? '' : 'renderVoiceManual no longer shows each item\'s on-disk target path'].filter(Boolean));
  // (e) the notice survives a restart: a drawer opened AFTER the launch that failed must still show the
  //   manual-path notice, driven by a fresh fs-only read of the persisted failed stamp — not only the
  //   in-flight 'provision' event, which a later launch never fires again.
  none('the settings voice row no longer re-checks the persisted failed stamp on drawer open (C-7.3)',
    [/ipcMain\.handle\('voice:status', \(\) => \{/.test(MAIN) ? '' : "no ipcMain.handle('voice:status', ...) in main.js",
     /failed = !!s\.voiceProvisionFailedAt;/.test(MAIN) ? '' : 'voice:status no longer reads the persisted failed stamp',
     /try \{ refreshVoiceSetupRow\(\); \} catch \(e\) \{\}/.test(APP) ? '' : 'openDrawer no longer calls refreshVoiceSetupRow() on open',
     /s && s\.failed && !s\.voiceReady\) showVoiceSetupNote\(\); else hideVoiceSetupNote\(\);/.test(APP) ? '' : 'refreshVoiceSetupRow no longer gates the notice on failed && !voiceReady'].filter(Boolean));
}

// ---------------------------------------------------------------------------------------------------------
// 103. C-7.4 — CONSENT BEFORE THE AUTOMATIC ~500MB DOWNLOAD, AND CHECKSUM-PINNED FETCHES. First run must ASK
//   before ensureVoiceProvisioned's automatic fire downloads models + runs third-party installers; a decline
//   must be persisted and respected forever (never auto-fires again); and the two large model downloads
//   (setup-win.ps1, setup.sh) must be SHA-256 verified after fetch, failing loudly on a mismatch.
// ---------------------------------------------------------------------------------------------------------
{
  // (a) the automatic (non-force) path is gated on consent: a decline short-circuits to false with NO spawn,
  //   and never-yet-decided asks (via askVoiceConsent) instead of silently downloading — it does not fall
  //   through to the failed-stamp/lock/spawn code below in either case.
  none('ensureVoiceProvisioned no longer gates the automatic path on consent (C-7.4)',
    [/if \(s0\.voiceConsentDeclinedAt\) return false;/.test(MAIN) ? '' : 'a decline no longer short-circuits the automatic call',
     /if \(!s0\.voiceConsentGrantedAt\) \{/.test(MAIN) ? '' : 'never-decided no longer branches before granting',
     /askVoiceConsent\(\);   \/\/ wizard already done/.test(MAIN) ? '' : 'the never-decided branch no longer calls askVoiceConsent()',
     /function askVoiceConsent\(\) \{/.test(MAIN) ? '' : 'askVoiceConsent() is gone from main.js',
     /win && win\.webContents\.send\('voice:consent-ask'\);/.test(MAIN) ? '' : 'askVoiceConsent no longer sends voice:consent-ask to the renderer'].filter(Boolean));
  // (b) force always proceeds (an explicit click IS consent) — the SAME force flag also clears a stale decline,
  //   mirroring C-7.3's failed-stamp clear right next to it.
  none('force no longer bypasses the consent gate or clears a stale decline (C-7.4)',
    /\} else if \(s0\.voiceConsentDeclinedAt \|\| !s0\.voiceConsentGrantedAt\) \{\s*\n\s*s0\.voiceConsentGrantedAt = Date\.now\(\); delete s0\.voiceConsentDeclinedAt; writeSettings\(s0\);/.test(MAIN)
      ? [] : ['the force branch no longer grants consent + clears the decline']);
  // (c) the decline is PERSISTED: the renderer's modal round-trips through voice:consent-decision, which writes
  //   voiceConsentDeclinedAt on decline (and voiceConsentGrantedAt on accept, re-entering with force), and both
  //   ends of the IPC bridge exist.
  none('voice:consent-decision no longer persists the decision (C-7.4)',
    [/ipcMain\.handle\('voice:consent-decision', \(_e, granted\) => \{/.test(MAIN) ? '' : "no ipcMain.handle('voice:consent-decision', ...) in main.js",
     /s\.voiceConsentDeclinedAt = Date\.now\(\); delete s\.voiceConsentGrantedAt;/.test(MAIN) ? '' : 'a decline no longer stamps voiceConsentDeclinedAt',
     /s\.voiceConsentGrantedAt = Date\.now\(\); delete s\.voiceConsentDeclinedAt;/.test(MAIN) ? '' : 'a grant no longer stamps voiceConsentGrantedAt',
     /if \(granted\) ensureVoiceProvisioned\(true\);/.test(MAIN) ? '' : 'a granted decision no longer re-enters ensureVoiceProvisioned(true)',
     /onVoiceConsentAsk: \(cb\) => ipcRenderer\.on\('voice:consent-ask', \(\) => cb\(\)\)/.test(PRELOAD) ? '' : 'no onVoiceConsentAsk bridge in preload.js',
     /voiceConsentDecision: \(granted\) => ipcRenderer\.invoke\('voice:consent-decision', !!granted\)/.test(PRELOAD) ? '' : 'no voiceConsentDecision bridge in preload.js',
     /claudible\.onVoiceConsentAsk\(async \(\) => \{/.test(APP) ? '' : 'the renderer no longer listens for voice:consent-ask',
     /claudible\.voiceConsentDecision\(choice === 'download'\)/.test(APP) ? '' : 'the renderer no longer reports the consent choice back to main'].filter(Boolean));
  // (d) the manual Install button and Rescan (both `force`-driven) clear a stale decline, so a decline never
  //   strands a user who then fixes voice by hand or clicks Install themselves.
  none('the manual voice paths no longer clear a stale decline (C-7.4)',
    [/if \(id === 'voice' && runner\.id === 'win'\) \{\s*\n\s*if \(voiceProvisioned\(\)\) return \{ ok: true, restartRequired: false \};\s*\n\s*if \(ensureVoiceProvisioned\(true\)\)/.test(MAIN)
       ? '' : 'preflight:install voice no longer calls ensureVoiceProvisioned(true) (which is what clears the decline on force)',
     /if \(ready\) \{ try \{ const s = readSettings\(\); if \(s\.voiceConsentDeclinedAt\) \{ delete s\.voiceConsentDeclinedAt; writeSettings\(s\); \} \} catch \{\} \}/.test(MAIN)
       ? '' : 'voice:rescan no longer clears a stale decline on a successful rescan'].filter(Boolean));
  // (e) both setup scripts pin known-good SHA-256 hashes for the whisper model + kokoro .pth, verify AFTER
  //   download, and fail loudly (expected vs actual) on a mismatch — never silently trust a corrupted/tampered
  //   fetch. Both constant blocks are clearly marked so a placeholder can't be mistaken for a real pin.
  none('setup-win.ps1 lost its checksum-verification plumbing (C-7.4)',
    [/\$KNOWN_HASHES = @\{/.test(SETUPWIN) ? '' : 'no $KNOWN_HASHES block in setup-win.ps1',
     /function Test-Checksum\(\$path, \$key\)/.test(SETUPWIN) ? '' : 'Test-Checksum function is gone from setup-win.ps1',
     /Warn "CHECKSUM MISMATCH for \$key/.test(SETUPWIN) ? '' : 'Test-Checksum no longer warns loudly on a mismatch',
     /if \(-not \(Test-Checksum \$model 'ggml-base\.bin'\)\)/.test(SETUPWIN) ? '' : 'the whisper model download is no longer checksum-verified',
     /if \(-not \(Test-Checksum \$kModel 'kokoro-v1_0\.pth'\)\)/.test(SETUPWIN) ? '' : 'the kokoro model download is no longer checksum-verified',
     /\$KOKORO_PIN_TAG = 'v0\.1\.4'/.test(SETUPWIN) ? '' : 'the Kokoro-FastAPI clone tag pin is gone from setup-win.ps1',
     /git clone --depth 1 --branch \$KOKORO_PIN_TAG https:\/\/github\.com\/remsky\/Kokoro-FastAPI/.test(SETUPWIN) ? '' : 'the Kokoro-FastAPI clone no longer pins a tag (clones HEAD again)'].filter(Boolean));
  none('setup.sh lost its checksum-verification plumbing (C-7.4)',
    [/^WHISPER_MODEL_SHA256=/m.test(SETUPSH) ? '' : 'no WHISPER_MODEL_SHA256 constant in setup.sh',
     /^KOKORO_MODEL_SHA256=/m.test(SETUPSH) ? '' : 'no KOKORO_MODEL_SHA256 constant in setup.sh',
     /verify_checksum\(\) \{/.test(SETUPSH) ? '' : 'verify_checksum() function is gone from setup.sh',
     /say "CHECKSUM MISMATCH for \$label/.test(SETUPSH) ? '' : 'verify_checksum no longer warns loudly on a mismatch',
     /verify_checksum "\$whisper_model" "\$WHISPER_MODEL_SHA256" "ggml-base\.bin"/.test(SETUPSH) ? '' : 'the whisper model download is no longer checksum-verified',
     /verify_checksum "\$kokoro_model" "\$KOKORO_MODEL_SHA256" "kokoro-v1_0\.pth"/.test(SETUPSH) ? '' : 'the kokoro model download is no longer checksum-verified',
     /^KOKORO_PIN_TAG="v0\.1\.4"/m.test(SETUPSH) ? '' : 'the Kokoro-FastAPI clone tag pin is gone from setup.sh',
     /git clone --depth 1 --branch "\$KOKORO_PIN_TAG" https:\/\/github\.com\/remsky\/Kokoro-FastAPI/.test(SETUPSH) ? '' : 'the Kokoro-FastAPI clone no longer pins a tag (clones HEAD again)'].filter(Boolean));
  // (f) neither pinned hash is a leftover 'TBD-' placeholder — both were actually verified (downloaded + hashed),
  //   not guessed. If this ever legitimately needs to regress to a placeholder, update this pin deliberately.
  none('a real checksum regressed to an unverified TBD- placeholder (C-7.4)',
    [/'ggml-base\.bin'\s*= 'TBD-/.test(SETUPWIN) ? "setup-win.ps1's ggml-base.bin hash is a TBD- placeholder" : '',
     /'kokoro-v1_0\.pth'\s*= 'TBD-/.test(SETUPWIN) ? "setup-win.ps1's kokoro-v1_0.pth hash is a TBD- placeholder" : '',
     /WHISPER_MODEL_SHA256="TBD-/.test(SETUPSH) ? "setup.sh's WHISPER_MODEL_SHA256 is a TBD- placeholder" : '',
     /KOKORO_MODEL_SHA256="TBD-/.test(SETUPSH) ? "setup.sh's KOKORO_MODEL_SHA256 is a TBD- placeholder" : ''].filter(Boolean));
}

// ---------------------------------------------------------------------------------------------------------
// 104. C-10.6 — IN-APP COMMIT CREDITING. Two pins the feature is judged by: the Settings toggle exists and
//   defaults OFF, and the hook installer never clobbers a pre-existing (foreign) prepare-commit-msg hook.
//   The real never-clobber behavior is proven functionally in test/coauthor-hook.test.js against a real
//   throwaway directory; this block pins the WIRING that behavior depends on staying intact.
// ---------------------------------------------------------------------------------------------------------
{
  const COAUTHOR_LIB = read('lib/coauthorHook.js');
  const COAUTHOR_SH = read('wsl/coauthor-hook.sh');
  // (a) the toggle exists in the drawer, unchecked by default (no `checked` attribute), and the renderer
  //   mirrors that default (absence/false -> OFF) rather than defaulting it on.
  none('the Settings drawer lost the C-10.6 co-author toggle, or it no longer defaults off',
    [/<input type="checkbox" id="auto-coauthor" \/>/.test(HTML) ? '' : 'index.html: #auto-coauthor is missing or gained a default `checked` attribute (must default OFF)',
     /class="toggle" id="coauthor-toggle"/.test(HTML) ? '' : 'index.html: #coauthor-toggle no longer starts unchecked (`class="toggle"`, no `on`)',
     /const ac = p\.autoCoauthor === true;/.test(APP) ? '' : "app.js no longer treats ONLY an explicit true as on (absence/false must read as OFF)"].filter(Boolean));
  // (b) the toggle actually persists through savePrefs -> settings:set, and main reacts to a real flip (not
  //   just stores it) by (un)installing the hook — the setting doing NOTHING when clicked would be as broken
  //   as it defaulting on.
  none('the auto-coauthor toggle no longer round-trips to main or main no longer reacts to it (C-10.6)',
    [/savePrefs\(\{ autoCoauthor: e\.target\.checked \}\)/.test(APP) ? '' : 'app.js #auto-coauthor change handler no longer calls savePrefs({ autoCoauthor })',
     /const prevAC = !!prev\.autoCoauthor, nextAC = !!\(obj && obj\.autoCoauthor\);/.test(MAIN) ? '' : "main.js settings:set no longer diffs autoCoauthor before/after"].filter(Boolean));
  // (c) NEVER CLOBBER, at the wiring level: install() only ever backs up a foreign hook (copyFileSync to the
  //   suffixed path) before writing its own file, and only when neither a marker nor a backup already exists —
  //   the exact guard that makes a second install a no-op re-backup instead of silently dropping whatever ran
  //   between the first install and now.
  none('lib/coauthorHook.js install() no longer guards against clobbering a foreign hook',
    [/const alreadyOurs = existing !== null && isOurs\(existing\);/.test(COAUTHOR_LIB) ? '' : 'install() no longer checks whether the existing file is already ours',
     /if \(existing !== null && !alreadyOurs && !chained\) \{/.test(COAUTHOR_LIB) ? '' : 'install() no longer gates the backup on "foreign AND not already backed up"',
     /fs\.copyFileSync\(hookPath, backupPath\);/.test(COAUTHOR_LIB) ? '' : 'install() no longer copies the foreign hook to a backup path before overwriting it'].filter(Boolean));
  // (d) uninstall() is equally disciplined: a hook that is present but neither ours nor backed up is refused,
  //   never deleted — the exact case of "someone hand-replaced our file" that must be left alone.
  none('lib/coauthorHook.js uninstall() no longer refuses to touch a hook it cannot prove it owns',
    [/if \(!isOurs\(current\)\) return \{ ok: false, error:/.test(COAUTHOR_LIB) ? '' : 'uninstall() no longer refuses on a non-Claudible hook',
     /fs\.renameSync\(backupPath, hookPath\);/.test(COAUTHOR_LIB) ? '' : 'uninstall() no longer restores the backup by renaming it back over the live hook'].filter(Boolean));
  // (e) the hook itself is a no-op for a solo commit (empty/missing coauthors file) and never fires on a
  //   merge/squash message, which git already assembled.
  none('the installed hook script lost its solo-commit no-op or its merge/squash skip (C-10.6)',
    [/case "\$src" in merge\|squash\) exit 0 ;; esac/.test(COAUTHOR_LIB) ? '' : 'hookScript() no longer skips merge/squash sources',
     /\[ -s "\$coauthors" \] \|\| exit 0/.test(COAUTHOR_LIB) ? '' : 'hookScript() no longer no-ops on an empty/missing coauthors file'].filter(Boolean));
  // (f) uninstall is wired to the ONE sanctioned share teardown (stopLiveSharing), not some other end-of-share
  //   path that could drift out of sync with it (see the share.stop() coupling pin above, #226).
  none('C-10.6 uninstall is no longer called from stopLiveSharing',
    [/function stopLiveSharing\(opts\) \{\s*\n\s*_coauthorTeardown\(\);/.test(MAIN) ? '' : '_coauthorTeardown() is no longer the first line of stopLiveSharing()'].filter(Boolean));
  // (g) the wsl-side adapter never assumes `.git/hooks` — it asks git, so a repo with core.hooksPath moved
  //   still gets the real hooks dir (and the real git dir, for the coauthors file).
  none('coauthor-hook.sh / coauthor-tool.js no longer resolve hooks/git dirs through git itself',
    [/git rev-parse --is-inside-work-tree/.test(COAUTHOR_SH) ? '' : 'coauthor-hook.sh no longer checks it is inside a real git repo',
     /'rev-parse', '--git-dir'/.test(read('wsl/coauthor-tool.js')) ? '' : 'coauthor-tool.js no longer resolves the git dir via `git rev-parse --git-dir`',
     /'rev-parse', '--git-path', 'hooks'/.test(read('wsl/coauthor-tool.js')) ? '' : "coauthor-tool.js no longer resolves hooks dir via `git rev-parse --git-path hooks`"].filter(Boolean));
}

// ---------------------------------------------------------------------------------------------------------
// 105. C-2.1 — FFMPEG GETS ITS OWN SYSTEM-CHECK ROW. It used to be silently bundled inside the Voice install
//   with no row of its own. Three things this pin holds: (a) the manifest row exists with the winget id
//   setup-win.ps1's own (still-bundled, unchanged) ffmpeg install already uses — a drift between the two
//   would leave the row installing a DIFFERENT ffmpeg than the one Voice already checks for; (b) it is
//   NON-blocking (voice-only dependency — required:false, so Next never waits on it, and it sits in the
//   `voice` category alongside uv/voice rather than `core`); (c) the win/posix installers both carry a real
//   case for it — deps.js's installRoute would otherwise report "installable" for a dep with nothing behind
//   the button.
// ---------------------------------------------------------------------------------------------------------
{
  const ffm = deps.MANIFEST.find((m) => m.id === 'ffmpeg');
  none('the ffmpeg manifest row disappeared (C-2.1)', ffm ? [] : ['no id:\'ffmpeg\' entry in runners/deps.js MANIFEST']);
  if (ffm) {
    none('the ffmpeg row became blocking (Next must not require a voice-only dependency)',
      ffm.required === false ? [] : ['ffmpeg.required is not false']);
    none('the ffmpeg row\'s winget id drifted from setup-win.ps1\'s own bundled install',
      ffm.win && ffm.win.winget === 'Gyan.FFmpeg' ? [] : [`ffmpeg.win.winget is ${ffm.win && ffm.win.winget}`]);
    none('setup-win.ps1\'s own (still-bundled) ffmpeg install uses a different winget id than the new row',
      /winget install -e --id Gyan\.FFmpeg/.test(SETUPWIN) ? [] : ['setup-win.ps1 no longer installs Gyan.FFmpeg']);
    none('the ffmpeg row is not actually installable on the win runner',
      deps.installRoute(ffm, 'win') === 'win' ? [] : [`installRoute(ffmpeg, 'win') = ${deps.installRoute(ffm, 'win')}`]);
    none('the ffmpeg row is not actually installable on the posix runner',
      deps.installRoute(ffm, 'posix') === 'posix' ? [] : [`installRoute(ffmpeg, 'posix') = ${deps.installRoute(ffm, 'posix')}`]);
  }
  // the win-native per-dep installer has a REAL switch case for ffmpeg (not just an accepted-but-unhandled
  // ValidateSet entry — pin #78 above already guards the reverse: a ValidateSet member with no case).
  const PROVWIN = read('setup/provision-win.ps1');
  none('provision-win.ps1 lost its ffmpeg install case',
    /'ffmpeg' \{[\s\S]{0,700}?Try-Winget 'Gyan\.FFmpeg'/.test(PROVWIN) ? [] : ['no working ffmpeg case in provision-win.ps1']);
  // the posix installer (wsl/provision.sh) has a real case too, following the same apt/brew pkg() convention
  // git/gh already use — not a bare "unknown dependency" fallthrough.
  const PROVSH = read('wsl/provision.sh');
  none('wsl/provision.sh lost its ffmpeg install case',
    /ffmpeg\)\s+have ffmpeg && ok; pkg ffmpeg;/.test(PROVSH) ? [] : ['no working ffmpeg case in wsl/provision.sh']);
  // detection: the win runner's pure-Node probe actually asks for ffmpeg (not just installs it blind), and
  // uses ffmpeg's real single-dash -version flag rather than the --version every other tool here takes.
  const WIN = read('runners/win.js');
  none('the win runner stopped probing for ffmpeg in detectDeps',
    /DETECT_TOOLS = \[[^\]]*'ffmpeg'[^\]]*\]/.test(WIN) ? [] : ["DETECT_TOOLS no longer lists 'ffmpeg'"]);
  none('the win runner reads ffmpeg\'s version with the wrong flag (ffmpeg has no --version; needs -version)',
    /id === 'ffmpeg' \? '-version' : '--version'/.test(WIN) ? [] : ['toolVersion no longer special-cases ffmpeg\'s -version flag']);
  // wsl/posix detection (preflight.sh) also asks for ffmpeg, with the same -version flag, and reports it in
  // the JSON line deps.js parses.
  const PREFLIGHT = read('wsl/preflight.sh');
  none('wsl/preflight.sh stopped probing for ffmpeg',
    /ffmpeg -version/.test(PREFLIGHT) && /"ffmpeg":\{"installed":%s,"version":"%s"\}/.test(PREFLIGHT)
      ? [] : ['preflight.sh no longer detects or reports ffmpeg']);
}

// ---------------------------------------------------------------------------------------------------------
// 106. C-8.3 — DISCARD GOES TO TRASH, NOT rm -f. "Discard" on a brand-new (untracked) file used to be a
//   silent, permanent `rm -f` — a real deletion dressed up as a one-click button. It now routes through the
//   same recoverable Claudible trash every other delete uses (C-3.6's flow): a FLAT top-level entry,
//   ~/.claudible/trash/discarded-<timestamp>-<pid>-<basename>, so trash-prune.sh's -maxdepth 1 sweep ages
//   each discard by its OWN mtime (a shared subfolder would refresh its mtime on every discard and dodge
//   both the 30-day and 2GB passes). Tracked-file behavior (apply-reverse restores the old version) is
//   untouched — this pin only touches the discard branch.
// ---------------------------------------------------------------------------------------------------------
{
  const DIFFAPPLY = read('wsl/diff-apply.sh');
  none('diff-apply.sh\'s discard case went back to rm -f\'ing the file (C-8.3 regressed)',
    /rm -f -- "\$target"/.test(DIFFAPPLY)
      ? ['discard still calls rm -f -- "$target" instead of moving it to trash'] : []);
  none('diff-apply.sh\'s discard case no longer moves the file into the Claudible trash (C-8.3)',
    /trashdir="\$HOME\/\.claudible\/trash"/.test(DIFFAPPLY) &&
    /mv -f -- "\$target" "\$dest"/.test(DIFFAPPLY)
      ? [] : ['discard no longer moves the target into ~/.claudible/trash']);
  none('diff-apply.sh\'s discard case dropped the FLAT pid-suffixed top-level trash name (C-8.3)',
    /dest="\$trashdir\/discarded-\$ts-\$\$-\$base"/.test(DIFFAPPLY)
      ? [] : ['dest is no longer $trashdir/discarded-$ts-$$-$base — a shared subfolder would defeat trash-prune\'s per-entry aging (its mtime refreshes on every discard), and same-second discards could clobber each other']);
  none('diff-apply.sh\'s apply-reverse (tracked-file revert) branch was touched by the C-8.3 fix',
    /git apply -R --recount "\$tmp"/.test(DIFFAPPLY)
      ? [] : ['apply-reverse no longer reverse-applies via git apply -R — tracked-file restore should be untouched']);

  none('the Discard button\'s title no longer mentions the trash (C-8.3)',
    /db\.title = 'Move this new file to the trash'/.test(APP)
      ? [] : ['renderUntracked\'s Discard button title text changed away from the trash wording']);
  none('the Discard success toast no longer says the file went to the trash (C-8.3)',
    /toast\('Discarded to trash — recoverable from Settings'\)/.test(APP)
      ? [] : ['renderUntracked\'s success toast no longer says "Discarded to trash — recoverable from Settings"']);
}

// ---------------------------------------------------------------------------------------------------------
// 107. C-13 item 5 / roadmap B12.4 — CRASH VISIBILITY. Before this, uncaughtException/unhandledRejection
//   just console.error'd — invisible in a packaged GUI build, so a stranger who crashed had nothing to
//   attach to a bug report. Now: an ALWAYS-ON rotating crash log under ~/.claudible/logs/crash.log,
//   written SYNCHRONOUSLY inside the handlers (uncaughtException may be the process's last act), and
//   uncaughtException additionally shows a native error dialog naming the log path. unhandledRejection
//   logs but does NOT dialog (too noisy). CLAUDIBLE_DEBUG's separate opt-in debug.log is untouched.
// ---------------------------------------------------------------------------------------------------------
{
  none('the crash log writer is gone or no longer synchronous (C-13/B12.4)',
    [/function _writeCrashLog\(kind, e\) \{/.test(MAIN) ? '' : '_writeCrashLog() is gone from main.js',
     /fs\.appendFileSync\(CRASH_LOG_FILE, line\)/.test(MAIN) ? '' : '_writeCrashLog no longer writes crash.log synchronously (fs.appendFileSync)',
     /CRASH_LOG_FILE = path\.join\(CRASH_LOG_DIR, 'crash\.log'\)/.test(MAIN) ? '' : 'the crash log is no longer named crash.log under CRASH_LOG_DIR',
     /CRASH_LOG_DIR = path\.join\(app\.getPath\('home'\), '\.claudible', 'logs'\)/.test(MAIN) ? '' : 'the crash log dir moved off ~/.claudible/logs'].filter(Boolean));
  none('the crash log stopped rotating at ~1MB with one .old (C-13/B12.4)',
    [/st\.size > 1024 \* 1024/.test(MAIN) ? '' : 'rotation no longer triggers at ~1MB',
     /fs\.copyFileSync\(CRASH_LOG_FILE, CRASH_LOG_FILE \+ '\.old'\)/.test(MAIN) ? '' : 'rotation no longer keeps a .old copy'].filter(Boolean));
  none('uncaughtException no longer writes the crash log (C-13/B12.4)',
    /process\.on\('uncaughtException', \(e\) => \{\s*\n\s*console\.error\('\[claudible\] uncaughtException:', e && e\.message\);\s*\n\s*const logFile = _writeCrashLog\('uncaughtException', e\);/.test(MAIN)
      ? [] : ['uncaughtException handler no longer calls _writeCrashLog']);
  none('unhandledRejection no longer writes the crash log (C-13/B12.4)',
    /process\.on\('unhandledRejection', \(e\) => \{\s*\n\s*console\.error\('\[claudible\] unhandledRejection:', e && \(e\.message \|\| e\)\);\s*\n\s*_writeCrashLog\('unhandledRejection', e\);/.test(MAIN)
      ? [] : ['unhandledRejection handler no longer calls _writeCrashLog']);
  none('the crash dialog no longer names the log file path (C-13/B12.4)',
    /dialog\.showErrorBox\('Claudible hit an error', 'Claudible ran into an unexpected error\. Details were saved to a log file you can attach to a bug report:\\n\\n' \+ logFile\)/.test(MAIN)
      ? [] : ['uncaughtException no longer shows a dialog naming the crash log path']);
  none('unhandledRejection started popping a dialog too (should stay log-only — too noisy)',
    /process\.on\('unhandledRejection'[\s\S]{0,400}?showErrorBox/.test(MAIN)
      ? ['unhandledRejection handler now calls dialog.showErrorBox — it should log only'] : []);
  {
    const handlersBlock = MAIN.match(/process\.on\('uncaughtException'[\s\S]*?\n\}\);\s*\n[\s\S]*?process\.on\('unhandledRejection'[\s\S]*?\n\}\);/);
    none('the crash handlers changed exit behavior (should keep running, same as before this fix)',
      (handlersBlock && !/process\.exit/.test(handlersBlock[0])) ? [] : ['a crash handler now calls process.exit (or the handlers block no longer matches) — exit behavior must stay unchanged']);
  }
}

// ---------------------------------------------------------------------------------------------------------
// 108. C-11.6 / roadmap §7 decision 5 — THE SHIPPED WINDOWS RUNNER GETS ITS FIRST AUTOMATED COVERAGE. Before
//   this, only the ubuntu `test` job ran the suite; the Windows runner's own code ran in NO CI job at all.
//   test.yml gets a `test-windows` job on windows-latest running the conservative --windows-safe subset
//   (test/run-all.js owns what that subset means — one decision point, not duplicated as a file list in
//   YAML). Every file in the subset was run and confirmed green on real Windows hardware before this
//   landed; *.sh and the three known env-failing .test.js files are deliberately left out so the job can be
//   green on its first run — see run-all.js's own comment for exactly why each is excluded.
// ---------------------------------------------------------------------------------------------------------
{
  const CI = read('.github/workflows/test.yml');
  const RUN = read('test/run-all.js');
  const PKG = JSON.parse(read('package.json'));
  none('the windows CI job is gone (C-11.6 — the Windows runner has no automated coverage again)',
    /test-windows:\s*\n\s*runs-on: windows-latest/.test(CI) ? [] : ['test.yml has no test-windows job on windows-latest']);
  none('…and it stopped checking out + installing deps like every other leg',
    /test-windows:[\s\S]{0,400}?actions\/checkout@v4[\s\S]{0,400}?actions\/setup-node@v4/.test(CI)
      ? [] : ['test-windows no longer checks out and sets up node']);
  none('…and it stopped running the windows-safe subset script',
    /test-windows:[\s\S]{0,700}?run: npm run test:windows-safe/.test(CI) ? [] : ['test-windows no longer runs npm run test:windows-safe']);
  none('…and it started running the FULL suite (network/gh-auth/.sh tests can\'t pass on a plain runner)',
    /test-windows:[\s\S]{0,700}?run: npm test\b/.test(CI) ? ['test-windows now runs the full suite, not the windows-safe subset'] : []);
  none('the windows-safe npm script is gone or no longer points at run-all.js --windows-safe',
    PKG.scripts && PKG.scripts['test:windows-safe'] === 'node test/run-all.js --windows-safe'
      ? [] : ['package.json test:windows-safe script missing or changed']);
  none('run-all.js no longer supports the --windows-safe flag',
    /windowsSafe = process\.argv\.includes\('--windows-safe'\)/.test(RUN) ? [] : ['--windows-safe flag detection is gone']);
  none('--windows-safe stopped cutting out every *.sh step',
    /const sh = windowsSafe \? \[\] : all\.filter/.test(RUN) ? [] : ['windows-safe mode no longer excludes all *.sh files']);
  none('--windows-safe stopped excluding the known env-failing .test.js files',
    /WINDOWS_UNSAFE_JS = new Set\(\['adopt-workspace\.test\.js', 'build-identity\.test\.js', 'appdir-quoting\.test\.js'\]\)/.test(RUN)
      ? [] : ['WINDOWS_UNSAFE_JS no longer names the known env-failing files']);
}

// ---------------------------------------------------------------------------------------------------------
// 109. C-1.3 — the posix runner gets the same hot-path fix wsl.js got (pin #87) and win.js before it:
//   runScript off the login shell. This is the last of the three runners to carry a login shell on the hot
//   path — win.js and wsl.js both already moved to `bash -c` with measured justification; posix.js's
//   runScript still shelled out `bash -lc`, the exact pattern C-1.3 forbids. spawnClaude KEEPS `-lc` — same
//   reasoning as wsl.js: session.sh (reused unchanged from wsl/*.sh on this backend) execs `claude` bare
//   with no node-path.sh-style PATH fixup in front of it, and claude may be nvm-installed on this machine.
//   startVoiceServices/services.sh KEEPS its login shell too — C-12's "the -lc in services.sh: LEAVE IT"
//   row, untouched on purpose, so its pin only proves it's still there. toGuestPath/toHostPath are identity
//   functions on this backend (no wslpath, no per-call process spawn) — nothing there to memoize.
// ---------------------------------------------------------------------------------------------------------
{
  const POSIX_JS = read('runners/posix.js');
  none('posix runScript went back to a LOGIN shell (the hot path pays a profile source on every call)',
    /cp\.execFile\('bash', \['-c', cmd\]/.test(POSIX_JS) ? [] : ['runScript no longer uses a non-login shell']);
  none('posix spawnClaude lost its login shell (claude may be nvm-installed with no PATH fixup ahead of it)',
    /pty\.mod\.spawn\('bash', \['-lc', buildBoot/.test(POSIX_JS) ? [] : ['spawnClaude no longer uses a login shell']);
  none('posix startVoiceServices lost its login shell (uv/kokoro needs the profile)',
    /cp\.execFile\('bash', \['-lc', shared\.scriptCmd\(APP_ROOT, 'services\.sh'\)\]/.test(POSIX_JS) ? [] : ['startVoiceServices no longer uses a login shell']);
}

// ---------------------------------------------------------------------------------------------------------
// 110. C-5.2 — THE LOUD CO-DRIVE WARNING MUST NOT VANISH ONCE SHARING STARTS. Before this, "Co-drive is on —
//   an approved guest can run commands on your computer, as you" only ever painted in the pre-share dialog
//   (renderShareWarn) and disappeared the instant a share actually went live — exactly when it matters most.
//   Now the CHAT HEADER carries a persistent #codrive-badge whenever the RUNNING share's real served mode is
//   co-drive: lastShareReadOnly for a share we're hosting (same truth source renderShareWarn reads once locked
//   — B14's whole point, the #share-ro checkbox can lie about what's actually being served) or the joined
//   tab's own liveReadOnly (stamped from the host's onLiveHello) for a session we joined. Never the checkbox.
//   Gone the instant either flips to view-only, the tunnel drops, or the share ends.
//   2026-08-15: the badge started in the live bar above the terminal, moved to the chat head when the owners
//   deleted that bar, and now lives in the TOP BAR's live flag — because a host with the chat panel collapsed
//   never looked at the chat head either. C-5.2 does not care where the warning lives, only that it is
//   standing while co-drive is; every rule below is the same rule at the newest address.
// ---------------------------------------------------------------------------------------------------------
{
  // (a) the badge element exists, starts hidden, and carries the exact warning sentence as its tooltip.
  none('index.html lost the #codrive-badge element (C-5.2)',
    [/class="liveflag" id="liveflag"/.test(HTML) ? '' : 'no #liveflag element to anchor it in',
     /class="codrive-badge" id="codrive-badge" style="display:none"/.test(HTML) ? '' : '#codrive-badge missing, or no longer starts hidden',
     /id="codrive-badge"[^>]*title="Co-drive is on — an approved guest can run commands on your computer, as you\./.test(HTML) ? '' : '#codrive-badge tooltip no longer carries the full warning sentence'].filter(Boolean));
  // it must sit inside the TOP BAR's flag, which nothing rebuilds — not in #crumb, #chat-roster or #chat-log,
  // all of which are wiped by textContent=''/innerHTML='' on every repaint. That was the original reason it sat
  // outside the roster and the reason survives every move.
  none('#codrive-badge is not inside the top-bar live flag (a repainted container would wipe it)',
    (() => {
      const flag = (HTML.match(/<span class="liveflag" id="liveflag"[\s\S]*?<\/span>\s*\n\s*<\/span>/) || [''])[0];
      return flag.indexOf('id="codrive-badge"') !== -1 ? [] : ['#codrive-badge is not inside #liveflag — check it did not drift into #crumb, #chat-roster or #chat-log, which are wiped on every repaint'];
    })());
  // (a2) the flag is only up while something is actually live, escalates as a WHOLE when co-drive is on (a
  //   host reading the bar from across the room must not have to parse a word to tell the two apart), and the
  //   escalation is driven by the same helper as the chip — never a second, drift-prone decision.
  none('the top-bar live flag stopped tracking the live state (owners 2026-08-15)',
    [/const anyLive = liveTab \|\| collabLive;\s*\n\s*flag\.style\.display = anyLive \? '' : 'none';/.test(APP)
       ? '' : 'the flag no longer shows exactly while a session is live (it must stay up while the host browses elsewhere — that is when a chat-panel-only signal is invisible)',
     /const f = \$\('liveflag'\); if \(f\) f\.classList\.toggle\('codrive', !!show\);/.test(APP)
       ? '' : 'the flag no longer escalates from the same paintCoDriveBadge call as the chip — two decisions would drift',
     /html\.skin \.liveflag\.codrive\{[^}]*var\(--live\)/.test(HTML)
       ? '' : 'html.skin .liveflag.codrive no longer repaints the flag in the danger ink'].filter(Boolean));
  // (a3) the GUEST is told the same fact from the same value: exactly one of read-only / co-drive is visible,
  //   both branches driven by the server's msg.readOnly rather than any local guess.
  none('the browser guest is no longer told when co-drive is on (C-5.2, guest half)',
    [/<span class="pill codrive" id="codrive" style="display:none" title="Co-drive is on — what you type runs on the host's computer, as them\."/.test(GUEST_HTML)
       ? '' : 'guest.html lost the #codrive pill or its warning tooltip',
     /\$\('ro'\)\.style\.display = readOnly \? '' : 'none';\s*\n\s*\$\('codrive'\)\.style\.display = readOnly \? 'none' : '';/.test(GUEST_JS)
       ? '' : 'the guest page no longer branches both pills off the same server-sent readOnly value'].filter(Boolean));
  // (b) the paint helper exists, and toggles the element's display — the only thing renderLiveState is allowed
  //   to drive it with.
  none('paintCoDriveBadge is gone from app.js (C-5.2)',
    /function paintCoDriveBadge\(show\) \{\s*\n\s*const b = \$\('codrive-badge'\); if \(b\) b\.style\.display = show \? '' : 'none';/.test(APP)
      ? [] : ['paintCoDriveBadge missing, or no longer toggles #codrive-badge.style.display']);
  // (c) the HOST path reads lastShareReadOnly (the running share's real mode), gated on tunnelUp so a dropped
  //   tunnel can't keep flashing a warning for a share nobody can actually reach — and never reads the
  //   #share-ro checkbox.
  none('renderLiveState\'s host branch stopped keying the badge off lastShareReadOnly (C-5.2)',
    (APP.match(/tunnelUp && lastShareReadOnly === false/g) || []).length >= 2
      ? [] : ['fewer than 2 sites gate the badge on tunnelUp && lastShareReadOnly === false (the shared-tab view + the "browsing elsewhere" reminder)']);
  none('the co-drive badge reads the #share-ro checkbox instead of the real served mode (C-5.2 regressed)',
    /paintCoDriveBadge\([^)]*share-ro[^)]*\)/.test(APP)
      ? ["a paintCoDriveBadge(...) call reads #share-ro directly"] : []);
  // (d) the GUEST path reads the joined tab's own liveReadOnly (stamped from the host's hello), not any local
  //   assumption, and excludes a paused/dead tab (C-5.6: nothing a guest sends changes anything while paused).
  none('renderLiveState\'s joined-tab branch stopped keying the badge off the real liveReadOnly (C-5.2)',
    /paintCoDriveBadge\(liveTab \? \(t\.liveReadOnly === false && t\.liveState !== 'paused' && !LIVE_DEAD\.has\(t\.liveState \|\| ''\)\) : \(tunnelUp && lastShareReadOnly === false\)\)/.test(APP)
      ? [] : ['the live branch no longer branches liveTab vs. host with the exact real-mode conditions']);
  // (e) the not-live early return explicitly clears the badge — otherwise a tab switch away from any live
  //   context could leave a stale badge lit in a header that is no longer describing a live session.
  none('the not-live early return stopped clearing the badge (C-5.2)',
    /if \(!\(collabLive && onSharedTab\) && !liveTab\) \{ paintCoDriveBadge\(false\); return; \}/.test(APP)
      ? [] : ['the not-live branch no longer calls paintCoDriveBadge(false) before returning']);
  // (f) a host who steps away mid-share still sees it: the "elsewhere" state paints the badge too, not just
  //   the calm "still running" tooltip — browsing away doesn't pause co-drive.
  none('the "browsing elsewhere" state stopped painting the badge (C-5.2)',
    /if \(elsewhere && !paused\) \{[\s\S]{0,600}?paintCoDriveBadge\(tunnelUp && lastShareReadOnly === false\);\s*\n\s*return;/.test(APP)
      ? [] : ['the elsewhere branch no longer paints the badge before returning']);
  // (g) a host-side pause repaints the header too, so the badge can't outlive a pause taking effect while the
  //   shared tab is the one on screen.
  none('onLivePaused stopped repainting the live state for the active tab (C-5.2)',
    /claudible\.onLivePaused\(\(p\) => \{ const rec = tabs\.get\(p\.tabId\); if \(rec && rec\.kind === 'live'\) \{ setLiveState\(rec, p\.paused \? 'paused' : 'live'\); if \(p\.tabId === activeTabId\) renderLiveState\(\); \} \}\);/.test(APP)
      ? [] : ['onLivePaused no longer calls renderLiveState() for the active tab']);
  // (h) styling: red, matching the existing danger vocabulary (var(--live)) rather than an ad-hoc color.
  //   ANCHORED ON THE RULE THAT ACTUALLY PAINTS. `class="skin"` is hardcoded and permanent on <html>,
  //   so `html.skin .codrive-badge` always outranks the bare `.codrive-badge` rule — a pin anchored on the
  //   bare one passed with the effective rule DELETED and failed only when the dead one was, which is worse
  //   than no pin at all: it converts an unguarded safety control into one everybody believes is guarded.
  //   Revert-tested both ways when it was rewritten.
  none('.codrive-badge lost its red (var(--live)) styling (C-5.2)',
    (() => {
      // OWNER PASS: the badge's BORDER and FILL were removed on purpose — inside the (now also frameless) live
      // flag they were a box within a box. So this pin no longer asks for a frame. It asks for what actually
      // carries the warning now, and it asks for MORE of it than before, because with the chrome gone the ink
      // is the only signal left: the badge's own red ink and weight, AND the whole flag escalating to red ink
      // with a red dot. Deleting the assertions instead of moving them would have quietly unguarded C-5.2.
      const rule = (HTML.match(/html\.skin \.codrive-badge\{[\s\S]*?\}/) || [''])[0];
      if (!rule) return ['no html.skin .codrive-badge rule — the badge has no effective styling at all'];
      const flag = (HTML.match(/html\.skin \.liveflag\.codrive\{[\s\S]*?\}/) || [''])[0];
      const dot = (HTML.match(/html\.skin \.liveflag\.codrive \.live-dot\{[\s\S]*?\}/) || [''])[0];
      return [/color:[^;]*var\(--live\)/.test(rule) ? '' : 'the effective rule no longer inks the label from --live',
              /font-weight:7\d\d/.test(rule) ? '' : 'the effective rule dropped below the 700 weight that lets the chip be found without a glow',
              flag && /color:[^;]*var\(--live\)/.test(flag) ? '' : 'the live flag no longer escalates its INK to --live for co-drive — with the frame gone that ink is the escalation',
              dot && /background:var\(--live\)/.test(dot) ? '' : 'the live dot no longer turns --live for co-drive'].filter(Boolean);
    })());
}

// ---------------------------------------------------------------------------------------------------------
// 110b. THE CHAT SENDER LINE'S INK TOKEN, DEFINED IN EVERY PALETTE. The skin flattens messages out of bubbles
//   deliberately — no face, no border, no radius, no side — so the small mono name above each message is the
//   ONLY remaining answer to "who said this". It is painted with --ink-name, a token that exists for that one
//   job and is defined once per theme. A palette edit that drops the line is silent: the name falls back to
//   unset, and nothing else in this suite looks at it. So the pin is on the token's existence in all four
//   palettes AND on the rule that consumes it — either half alone would pass while the pairing is broken.
// ---------------------------------------------------------------------------------------------------------
{
  // `[^}]*` bounds each match at its own block's closing brace — a generous character window would happily
  // reach the NEXT theme's definition and pass while this one is missing, which is the failure a count alone
  // cannot see either. Count (4) plus three bounded block matches is what proves the base palette has one too.
  const themed = (name) => new RegExp('html\\[data-theme="' + name + '"\\]\\{[^}]*--ink-name:\\s*#[0-9a-fA-F]{3,8}').test(HTML);
  const defs = (HTML.match(/--ink-name:\s*#[0-9a-fA-F]{3,8}/g) || []).length;
  none('--ink-name is no longer defined for every theme',
    [defs === 4 ? '' : `--ink-name is defined ${defs} times, expected 4 (the base palette plus graphite, midnight and cockpit)`,
      themed('graphite') ? '' : 'the graphite theme no longer defines --ink-name',
      themed('midnight') ? '' : 'the midnight theme no longer defines --ink-name',
      themed('cockpit') ? '' : 'the cockpit theme no longer defines --ink-name'].filter(Boolean));
  none('the chat sender name stopped painting with --ink-name',
    /html\.skin \.chat-msg \.who\{[^}]*color:var\(--ink-name\)/.test(HTML)
      ? [] : ['html.skin .chat-msg .who no longer uses var(--ink-name) — the sender line is the only cue left, so this is who-said-what going unreadable']);
}

// ---------------------------------------------------------------------------------------------------------
// 111. C-7.5 — setup.sh PARITY WITH setup-win.ps1. Two halves the posix/WSL path had not caught up to yet.
//   (a) setup.sh now stops any live voice server BEFORE any rm/clone, mirroring setup-win.ps1's
//   Stop-VoiceServers (a live server holds its own files open and blocks its own reinstall — found on a
//   real Windows box during the v0.9.1 smoke, and the same class of bug can bite Linux/macOS too).
//   (b) the ASCII gate (test/ps1-ascii.test.js) now scans setup/*.sh too, not just *.ps1, so the two
//   setup halves can't quietly diverge on encoding again.
// ---------------------------------------------------------------------------------------------------------
{
  // (a) stop_voice_servers exists, kills whisper-server by exact process name and Kokoro's python by a
  //   command-line match scoped to THIS install's own kokoro dir (never a bare python/uvicorn match —
  //   that would risk killing an unrelated process on the machine).
  none('setup.sh lost its stop_voice_servers function, or it stopped matching both servers precisely (C-7.5)',
    [/stop_voice_servers\(\) \{/.test(SETUPSH) ? '' : 'stop_voice_servers() is gone from setup.sh',
     /pgrep -x whisper-server/.test(SETUPSH) ? '' : 'stop_voice_servers no longer matches whisper-server by exact process name',
     /pgrep -f "\$VOICE\/kokoro"/.test(SETUPSH) ? '' : "stop_voice_servers no longer scopes its Kokoro match to \$VOICE/kokoro (would risk killing an unrelated python)"].filter(Boolean));
  // (a, cont'd) it is actually CALLED — and called before the file's first rm -rf / git clone, not just
  //   defined and left dead. Order matters: this is the whole point of the fix.
  none('setup.sh no longer actually calls stop_voice_servers (defined but dead) (C-7.5)',
    /\nstop_voice_servers\n/.test(SETUPSH) ? [] : ['no bare `stop_voice_servers` call in setup.sh']);
  {
    const callIdx = SETUPSH.indexOf('\nstop_voice_servers\n');
    const firstRm = SETUPSH.search(/rm -rf "\$VOICE/);
    const firstClone = SETUPSH.indexOf('git clone');
    none("setup.sh calls stop_voice_servers AFTER it has already rm -rf'd or cloned something (C-7.5 — must run first)",
      (callIdx !== -1 && firstRm !== -1 && firstClone !== -1 && callIdx < firstRm && callIdx < firstClone)
        ? [] : [`stop_voice_servers call at ${callIdx}, first rm -rf "$VOICE at ${firstRm}, first git clone at ${firstClone}`]);
  }
  // (b) the ASCII gate now covers setup/*.sh via its own git ls-files scan, and setup.sh itself is clean —
  //   it used to carry em dashes/ellipses that nothing scanned (harmless to bash, but a silent encoding
  //   asymmetry with the .ps1 half this file is supposed to mirror).
  const PS1ASCII = read('test/ps1-ascii.test.js');
  none('test/ps1-ascii.test.js stopped scanning setup/*.sh (C-7.5)',
    /git ls-files "setup\/\*\.sh"/.test(PS1ASCII) ? [] : ['no git ls-files "setup/*.sh" scan in test/ps1-ascii.test.js']);
  none('setup.sh itself regressed to non-ASCII bytes (C-7.5)',
    (() => {
      const buf = fs.readFileSync(path.join(ROOT, 'setup/setup.sh'));
      for (let i = 0; i < buf.length; i++) { if (buf[i] > 0x7f) return [`byte 0x${buf[i].toString(16)} at offset ${i}`]; }
      return [];
    })());
}

// ---------------------------------------------------------------------------------------------------------
// 112. C-9.4 — an error must not paint an empty list over the cache. skills:list / plugins:list used to
//   resolve() a bare [] on both a genuine "no backend" / exec-error / bad-JSON failure AND on a real,
//   successful, empty scan — the renderer's loadSkills/loadPlugins couldn't tell those apart, so a transient
//   IPC failure or timeout flashed "No skills/plugins found" over whatever was already listed. The fix: the
//   main-process handlers now resolve null on every failure path (no backend, exec error, bad JSON) and a
//   real array — including an empty one — only on an actual successful scan. The renderer keeps the last
//   successful array in a module-level cache (_skillsCache / _pluginsCache) and, on a null result, repaints
//   that cache instead of clobbering it; a genuinely empty successful scan still renders the empty state.
// ---------------------------------------------------------------------------------------------------------
{
  // (a) main.js: both handlers resolve(null) — not resolve([]) — on the no-backend guard, the exec error, and
  //   a bad-JSON parse. A partial revert (fixing one branch but not all three) still fails this.
  none('skills:list stopped resolving null on failure (C-9.4)',
    [/ipcMain\.handle\('skills:list', \(\) => new Promise\(\(resolve\) => \{\s*\n\s*if \(!APPDIR_WSL\) return resolve\(null\);/.test(MAIN)
       ? '' : 'skills:list no longer resolves null when APPDIR_WSL is unset',
     /\[claudible\] skills:list', err\.message\); return resolve\(null\); \}/.test(MAIN)
       ? '' : 'skills:list no longer resolves null on a runScript error',
     /skills:list[\s\S]{0,260}?catch \{ resolve\(null\); \}/.test(MAIN)
       ? '' : 'skills:list no longer resolves null on a JSON.parse failure'].filter(Boolean));
  none('plugins:list stopped resolving null on failure (C-9.4)',
    [/ipcMain\.handle\('plugins:list', \(\) => new Promise\(\(resolve\) => \{\s*\n\s*if \(!APPDIR_WSL\) return resolve\(null\);/.test(MAIN)
       ? '' : 'plugins:list no longer resolves null when APPDIR_WSL is unset',
     /\[claudible\] plugins:list', err\.message\); return resolve\(null\); \}/.test(MAIN)
       ? '' : 'plugins:list no longer resolves null on a runScript error',
     /plugins:list[\s\S]{0,260}?catch \{ resolve\(null\); \}/.test(MAIN)
       ? '' : 'plugins:list no longer resolves null on a JSON.parse failure'].filter(Boolean));
  // (b) main.js: a real (successful) empty scan is still a bare [] — it must stay indistinguishable from any
  //   other successful empty array, not get wrapped into some {ok:false}-shaped sentinel.
  none('skills:list/plugins:list stopped defaulting a successful empty stdout to [] (C-9.4)',
    (MAIN.match(/resolve\(JSON\.parse\(String\(stdout\)\.trim\(\) \|\| '\[\]'\)\);/g) || []).length >= 2
      ? [] : ['fewer than 2 resolve(JSON.parse(...) || \'[]\') sites left in main.js for skills:list/plugins:list']);

  // (c) renderer/app.js: module-level caches exist, and loadSkills/loadPlugins branch on null vs a real array
  //   — null repaints the cache (or leaves the DOM alone if there's no cache yet); a real array (even []) both
  //   updates the cache AND is what gets painted, so a genuine empty scan still shows the empty state.
  none('the renderer lost its last-known-good skills/plugins caches (C-9.4)',
    [/let _skillsCache = null;/.test(APP) ? '' : 'no module-level _skillsCache in app.js',
     /let _pluginsCache = null;/.test(APP) ? '' : 'no module-level _pluginsCache in app.js'].filter(Boolean));
  none('loadSkills stopped branching on a null (error) result before touching the cache (C-9.4)',
    /async function loadSkills\(\) \{[\s\S]{0,260}?if \(list === null \|\| list === undefined\) \{[\s\S]{0,400}?if \(_skillsCache\) renderSkillsList\(_skillsCache\);[\s\S]{0,40}?return;\s*\n\s*\}/.test(APP)
      ? [] : ['loadSkills no longer keeps painting _skillsCache when skillsList() resolves null']);
  none('loadPlugins stopped branching on a null (error) result before touching the cache (C-9.4)',
    /async function loadPlugins\(\) \{[\s\S]{0,260}?if \(list === null \|\| list === undefined\) \{[\s\S]{0,400}?if \(_pluginsCache\) renderPluginsList\(_pluginsCache\);[\s\S]{0,40}?return;\s*\n\s*\}/.test(APP)
      ? [] : ['loadPlugins no longer keeps painting _pluginsCache when pluginsList() resolves null']);
  none('loadSkills/loadPlugins stopped updating the cache on a successful (even empty) scan (C-9.4)',
    [/_skillsCache = Array\.isArray\(list\) \? list : \[\];/.test(APP) ? '' : 'loadSkills no longer writes a successful result into _skillsCache',
     /_pluginsCache = Array\.isArray\(list\) \? list : \[\];/.test(APP) ? '' : 'loadPlugins no longer writes a successful result into _pluginsCache'].filter(Boolean));
  // (d) the actual painting (the old empty-state check) moved into standalone render functions, so a cache
  //   repaint on error uses the exact same empty-vs-populated logic as a fresh successful load.
  none('renderSkillsList/renderPluginsList (the shared paint path) are gone (C-9.4)',
    [/function renderSkillsList\(list\) \{/.test(APP) ? '' : 'no renderSkillsList(list) function in app.js',
     /function renderPluginsList\(list\) \{/.test(APP) ? '' : 'no renderPluginsList(list) function in app.js'].filter(Boolean));
}

// ---------------------------------------------------------------------------------------------------------
// 113. C-5.1 — THE OWNERS' PIN LAW (amended 2026-08-07). A share is welded to the session the host chose at
//   start; it NEVER follows the host, and starting a second share while one runs is refused, in all four
//   web/collab orderings. The 2026-08-07 hardware exposure: ensureTunnel()'s `want === tunnelUp` boolean
//   short-circuit let toggleShareSession silently relabel a running share (sharedSessionId flipped to a NEW
//   session) without ever calling share:start again — so main's real pin (sharedTabId) never moved, but every
//   renderer surface describing WHICH session was shared (presence, sidebar, elsewhere-bar) drifted to whatever
//   the host most recently clicked, while guests kept receiving the ORIGINAL pinned tab's bytes under the new
//   session's name. Four-layer fix: (1) toggleShareSession gets the same B13 refusal doStartSharing already had,
//   (2) ensureTunnel gets an identity-aware backstop so a mismatch can never silently reuse the tunnel, (3) main's
//   live:advertise self-checks against the REAL pin before publishing presence, (4) the share link itself carries
//   the pinned session's id so guest.js's C-5.10 tripwire has an independent promise to check every frame
//   against, not just its own first-seen frame.
// ---------------------------------------------------------------------------------------------------------
{
  const appNoComments = APP.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const bodyOf = (name) => (appNoComments.match(new RegExp('function ' + name + '\\([\\s\\S]*?(?=\\nfunction |\\nconst |\\nlet )')) || [''])[0];

  // (1) toggleShareSession refuses a share for a DIFFERENT session than what's actually pinned, before ever
  //     touching sharedSessionId — mirrors doStartSharing's own B13 guard (pin #86b), applied to the collab path.
  const tog = bodyOf('toggleShareSession');
  none('toggleShareSession lost its B13 refusal (a second Share can relabel a running one again)',
    [/if \(tunnelUp && sharedTabIdR != null\) \{/.test(tog) ? '' : 'no tunnelUp/sharedTabIdR guard',
     /if \(pinnedRec && pinnedRec\.session !== s\.id\) \{/.test(tog)
       ? '' : 'guard no longer compares the pinned tab\'s RAW session (incl. an unresolved new/\'\' draft) against the requested id'].filter(Boolean));
  {
    // …and the refusal must fire BEFORE sharedSessionId is ever reassigned, or the state corruption already
    // happened by the time the check runs.
    const iGuard = tog.indexOf('if (tunnelUp && sharedTabIdR != null)');
    const iAssign = tog.indexOf("sharedSessionId = s.id; sharedWsId = activeWsId;");
    none('toggleShareSession\'s B13 guard runs AFTER sharedSessionId is reassigned (too late to refuse)',
      (iGuard > -1 && iAssign > -1 && iGuard < iAssign) ? [] : ['guard does not precede the sharedSessionId assignment']);
  }

  // (2) ensureTunnel's short-circuit is identity-aware, not a bare boolean — the backstop for any caller that
  //     doesn't go through toggleShareSession's own guard first. Must never mutate state on a host merely
  //     browsing away from the pinned tab (collabLive/tunnelUp legitimately stay true the whole time).
  const ens = bodyOf('ensureTunnel');
  none('ensureTunnel lost its identity-aware backstop before the want===tunnelUp short-circuit',
    [/if \(collabLive && tunnelUp && sharedTabIdR != null && sharedSessionId\) \{/.test(ens) ? '' : 'no collabLive/tunnelUp/sharedSessionId guard',
     /if \(pinnedRec && pinnedRec\.session !== sharedSessionId\) \{/.test(ens) ? '' : 'backstop no longer compares the pinned tab\'s RAW session against sharedSessionId'].filter(Boolean));
  {
    const iBackstop = ens.indexOf('if (collabLive && tunnelUp && sharedTabIdR != null && sharedSessionId)');
    const iShort = ens.indexOf('if (want === tunnelUp)');
    none('the identity backstop runs AFTER the want===tunnelUp short-circuit (too late — already no-op\'d)',
      (iBackstop > -1 && iShort > -1 && iBackstop < iShort) ? [] : ['backstop does not precede the short-circuit']);
  }

  // (3) main.js: live:advertise refuses to publish a session other than the one actually pinned.
  none('main.js: live:advertise lost its self-check against the real pin (C-5.1 defense in depth)',
    [/function pinnedSessionId\(\)/.test(MAIN) ? '' : 'pinnedSessionId() helper is gone',
     /const pinnedSid = pinnedSessionId\(\);\s*\n\s*if \(pinnedSid && pinnedSid !== sid\) \{/.test(MAIN)
       ? '' : 'live:advertise no longer compares the requested sid against the real pin',
     /error: 'session-mismatch'/.test(MAIN) ? '' : 'no session-mismatch refusal shape'].filter(Boolean));
  none('app.js: updateAdvertise no longer handles a session-mismatch refusal (would strand "sharing" in the UI)',
    /if \(r && r\.error === 'session-mismatch'\) \{[\s\S]{0,600}?sharedSessionId = null; sharedWsId = null;/.test(APP)
      ? [] : ['no session-mismatch branch rolls sharedSessionId back']);

  // (4) the share link carries the pinned session's id, and guest.js checks EVERY frame (including the first)
  //     against that independent promise — closing the "first-seen becomes truth" gap C-5.10's old design left.
  none('main.js: a share link no longer embeds the pinned session\'s id (C-5.10 has no independent promise again)',
    [(MAIN.match(/&sid=\$\{sid0\}/g) || []).length >= 2 ? '' : 'share:start\'s already-running reuse no longer embeds &sid= in both url/localUrl',
     (MAIN.match(/&sid=\$\{sid\}/g) || []).length >= 2 ? '' : 'share:start\'s fresh-tunnel path no longer embeds &sid= in both url/localUrl',
     /&sid=\$\{pinnedSessionId\(\)\}/.test(MAIN) ? '' : 'share:newlink no longer embeds &sid='].filter(Boolean));
  none('guest.js: promisedSessionId is no longer read from the link\'s ?sid= param',
    /var promisedSessionId = new URLSearchParams\(location\.search\)\.get\('sid'\);/.test(GUEST_JS)
      ? [] : ['promisedSessionId is not sourced from the URL']);
  none('guest.js: checkSessionId no longer checks EVERY frame against the promised id (only first-seen again)',
    [/if \(promisedSessionId != null\) \{/.test(GUEST_JS) ? '' : 'no promised-id branch in checkSessionId',
     /if \(!promisedSessionId\) \{ promisedSessionId = sid; return; \}/.test(GUEST_JS)
       ? '' : 'an empty (resume-latest) promise no longer adopts the first real id',
     /if \(sid !== promisedSessionId\) flagSessionMismatch\(\);/.test(GUEST_JS)
       ? '' : 'a promised mismatch no longer flags on the very first frame'].filter(Boolean));
  none('guest.js: the pre-C-5.10-hardening fallback (first-seen tripwire) is gone for older host builds',
    /if \(knownSessionId === sid\) return;\s*\n\s*if \(!knownSessionId\) \{ knownSessionId = sid; return; \}\s*\n\s*flagSessionMismatch\(\);/.test(GUEST_JS)
      ? [] : ['no first-seen fallback when the link predates ?sid=']);
}


// ---------------------------------------------------------------------------------------------------------
// 93. TRANSCRIPTS DO NOT RIDE THE CODE REPO. Sessions used to sync to a branch of the project's OWN repo, so
//   every prompt, reply, file content and command output sat one "make public" click from the world — and
//   deleting the branch afterwards does not undo it (history, forks, clones). This project nearly shipped
//   exactly that. A repo workspace now also gets a SEPARATE PRIVATE sessions repo, wired as the
//   `claudible-sessions` remote; sessions-sync prefers it and falls back to origin so pre-existing projects
//   are untouched. Three properties must hold together or the guarantee is not real.
// ---------------------------------------------------------------------------------------------------------
{
  const SS = read('wsl/sessions-sync.sh'), CW = read('wsl/create-workspace.sh');
  none('sessions-sync no longer resolves a dedicated sessions remote (transcripts fall back onto the code repo)',
    /SREM=claudible-sessions/.test(SS) && /remote get-url claudible-sessions/.test(SS)
      ? [] : ['no claudible-sessions remote resolution']);
  // The probe MUST run after the cygpath rewrite: git.exe cannot read the MSYS form of SDIR, so probing
  // earlier answers "no such remote" on the win flavor and silently puts transcripts back on the code repo.
  none('the sessions-remote probe moved back above the Windows path normalization (silently re-exposes on win)',
    SS.indexOf('remote get-url claudible-sessions') > SS.indexOf('WT="$(cygpath -m "$WT"')
      ? [] : ['the claudible-sessions probe runs before SDIR is cygpath-normalized']);
  // A leftover hard-coded origin on a $BR operation would send THAT operation to the code repo while the rest
  // went next door — the worst outcome, because it leaks quietly rather than failing.
  none('a session-branch git op still hard-codes origin instead of $SREM',
    SS.split('\n').filter((l) => !/^\s*#/.test(l) && /\$BR/.test(l) && /\borigin\b/.test(l) && !/SREM/.test(l))
      .map((l) => 'hard-coded origin: ' + l.trim().slice(0, 90)));
  none('create-workspace no longer mints the private sessions repo + remote',
    /gh repo create "\$owner\/\$sess_repo" --private/.test(CW) && /remote add claudible-sessions/.test(CW)
      ? [] : ['no sessions repo creation']);
  none('the sessions repo is created without --private (it would be PUBLIC)',
    /gh repo create "\$owner\/\$sess_repo"(?![^\n]*--private)/.test(CW) ? ['sessions repo not created private'] : []);
  // The three paths a project can reach a collaborator by. Miss any one and their transcripts land on the CODE
  // repo instead - silently, on their machine, and invisible to the project owner.
  const CL = read('wsl/clone-workspace.sh'), INV = read('wsl/repo-invite.sh'), UP = read('wsl/upgrade-workspace.sh');
  none('a cloned shared project no longer wires the sessions remote (a collaborator would push transcripts to the code repo)',
    /sessionsRepo/.test(CL) && /remote add claudible-sessions/.test(CL) ? [] : ['clone-workspace does not wire claudible-sessions']);
  none('the clone path feeds an unvalidated sessionsRepo string into a remote URL',
    /sess=""/.test(CL) && /A-Za-z0-9/.test(CL) ? [] : ['sessionsRepo is not charset-validated before becoming a URL']);
  none('inviting a collaborator no longer adds them to the sessions repo (their sync can neither fetch nor push)',
    INV.includes("collaborators/$login") && /slug-sessions/.test(INV) ? [] : ['repo-invite does not invite to the sessions repo']);
  none('a sessions-repo invite failure now fails the whole invite (the code invite already succeeded)',
    /"status":"invited","note":/.test(INV) ? [] : ['no non-fatal note path for a sessions-repo invite failure']);
  none('upgrading a local project to a repo skips the sessions split (the one path that would still expose)',
    /slug-sessions/.test(UP) && /remote add claudible-sessions/.test(UP) ? [] : ['upgrade-workspace does not create the sessions repo']);
  // THE COMPATIBILITY GUARANTEE: every project created before this change has no claudible-sessions remote and
  // must behave EXACTLY as before. The fallback is what makes this shippable with no migration.
  none('the origin fallback is gone (every pre-existing project would break)',
    /^SREM=origin/m.test(SS) ? [] : ['SREM no longer defaults to origin']);
}

// ---------------------------------------------------------------------------------------------------------
// 94. /clear MOVES A SHARED SESSION OUT FROM UNDER THE MIRROR. Sharing welds a session ID at Share time but
//   streams a pinned TAB, and nothing kept the two in agreement. Claude Code mints a new session id from
//   INSIDE the pty (/clear, /compact), so none of the guards that protect a pinned tab from being re-pointed
//   ever fire: the guest was carried into a conversation the host never shared while presence advertised the
//   old id. Observed live. The drift handler must fire ONLY on real drift, and must never touch the two
//   invariants around it.
// ---------------------------------------------------------------------------------------------------------
{
  const A = read('renderer/app.js'), M = read('main.js'), PL = read('preload.js'), SRV = read('share/server.js');
  none('onStatus no longer distinguishes real drift from a first resolve / a genuine new session',
    A.includes("const driftFrom = (t.session && t.session !== 'new') ? t.session : null;")
      ? [] : ["driftFrom guard missing - a first resolve or a genuine new session would count as drift"]);
  // All four conditions matter: real drift, the SHARED tab, and a weld still naming the session we drifted
  // from (so a re-share that happened meanwhile is never stomped).
  none('the drift re-weld lost one of its four guards',
    A.includes('if (driftFrom && sharedTabIdR != null && t.tabId === sharedTabIdR && sharedSessionId === driftFrom)')
      ? [] : ['the drift guard is not the full four-way check']);
  none('drift no longer re-welds + re-advertises (presence would name a session nobody is in)',
    A.includes('sharedSessionId = s.sessionId;') && A.includes('updateAdvertise();')
      ? [] : ['no re-weld + updateAdvertise on drift']);
  // THE INVARIANT: updateAdvertise is keyed on the SHARED session, never the viewed one — that is what stops
  // ordinary browsing from unadvertising. Drift may only READ it.
  none('updateAdvertise stopped keying on the shared session (browsing would unadvertise)',
    A.includes("const want = (aw && aw.kind === 'repo' && sharedSessionId) ? sharedSessionId : null;")
      ? [] : ['updateAdvertise no longer keys on sharedSessionId']);
  // A cleared session is NOT user-created: bornNew drives the unsaved-row filter and must keep its meaning.
  none('drift sets bornNew (a cleared session would render as a user-created unsaved row)',
    /driftFrom[\s\S]{0,400}?t\.bornNew = true/.test(A) ? ['drift path writes bornNew'] : []);
  // ROW SAFETY — deliberately NOT solved with new code. A just-cleared session has 0 messages, so it is not in
  // savedIds, and bornNew is (correctly) false, so it is not in liveTabs either. The tab would vanish from its
  // own sidebar — except section 8's `orphanTab` already exists for exactly this shape ("the active tab always
  // has a sidebar row", written for the unresumable-fallback case, which is the same shape as /clear drift).
  // Adding a second row-source for drift would risk re-flashing the phantom row that liveTabs' comment warns
  // about, in the file that has hosted three separate row bugs. So drift RELIES on orphanTab, and this pin
  // records the dependency: orphanTab must keep admitting a real, unsaved, non-bornNew session on the active tab.
  none('orphanTab stopped covering a real-but-unsaved session (a cleared session would vanish from the sidebar)',
    /if \(sid === 'new'\) return null;|if \(sid == null \|\| sid === 'new'\) return null;/.test(A)
      && /if \(savedIds\.has\(sid\)\) return null;/.test(A)
      && /if \(liveTabs\.some\(\(r\) => r\.tabId === t\.tabId\)\) return null;/.test(A)
      && /\n *return t;\n *\}\)\(\);/.test(A)
      ? [] : ['orphanTab no longer returns a real, unsaved, non-bornNew active tab']);
  // KEEP THE NAME: /clear mints a new id, but the user sees one window with cleared context. The name is
  // carried onto the new id through the SAME store+publish path a rename uses, so the row stays readable and
  // collaborators see it. Only an EXPLICIT name, and never over a name the new session already has.
  none('a cleared session no longer inherits its window name (the sidebar fills with untitled rows)',
    A.includes('if (driftFrom && !hasExplicitTitle(s.sessionId, t.wsId))') ? [] : ['no name carry-forward on drift']);
  none('the carry-forward invented its own publish path instead of reusing titleSet',
    A.includes('claudible.titleSet(s.sessionId, carried, t.wsId)') ? [] : ['carry-forward does not publish through titleSet']);
  none('guests are moved silently again (no system line on the chat they already have)',
    M.includes("ipcMain.handle('share:session-changed'") && M.includes('share.systemChat(')
      ? [] : ['no share:session-changed handler emitting a system chat']);
  none('share/server no longer exports systemChat (main could not announce the change)',
    SRV.includes('broadcastChat, systemChat,') ? [] : ['systemChat not exported']);
  none('preload: shareSessionChanged is not bridged',
    PL.includes("shareSessionChanged: () => ipcRenderer.invoke('share:session-changed')") ? [] : ['no shareSessionChanged bridge']);
  none('the drift notice can pause, kick or end the share (it must stay advisory)',
    /share:session-changed[\s\S]{0,600}?(setSharePaused|kickGuest|share\.stop)/.test(M)
      ? ['the session-changed handler mutates share state'] : []);
}

// ---------------------------------------------------------------------------------------------------------
// 114. CHECKSUM PLUMBING FAILS CLOSED. A missing/TBD SHA-256 pin (or a missing hasher) used to WARN
//   and let an unverified binary through anyway (setup.sh's verify_checksum, setup-win.ps1's Test-Checksum);
//   both now REFUSE (exit 1 / return $false). The whisper.cpp clone was unpinned HEAD; it now pins a tag AND
//   verifies the resolved commit (tags move, commits don't). setup-win.ps1's whisper zip download resolved a
//   floating "latest release" and extracted before any hash check; it now uses only the pinned URL and verifies
//   BEFORE Expand-Archive. provision-win.ps1 had no hash infrastructure at all for its three direct-download
//   executables (node zip, PortableGit, cloudflared) and resolved floating "latest"/index.json URLs; it now
//   has Fetch-Verified + pinned URLs. This block pins the PLUMBING itself (fail-closed branches, wiring);
//   real pin VALUES are asserted separately below (test 115), where a PIN-COMPUTATION step has now filled
//   every TBD-* placeholder with a hash/commit computed from the actual downloaded bytes.
// ---------------------------------------------------------------------------------------------------------
{
  const PROVWIN = read('setup/provision-win.ps1');
  none('setup.sh verify_checksum no longer fails closed on a missing/TBD pin or a missing hasher',
    [/''\|TBD-\*\) say "REFUSING: no verified SHA-256 pin for \$label[\s\S]{0,220}return 1 ;;/.test(SETUPSH)
       ? '' : "the TBD/empty case no longer says REFUSING and returns 1",
     /if \[ -z "\$actual" \]; then say "REFUSING: no sha256sum\/shasum on this system/.test(SETUPSH)
       ? '' : 'the no-hasher branch no longer refuses',
     /''\|TBD-\*\) say "REFUSING:[\s\S]{0,240}return 0 ;;/.test(SETUPSH)
       ? 'verify_checksum still has a return 0 warn-and-pass branch' : ''].filter(Boolean));
  none('setup-win.ps1 Test-Checksum no longer fails closed on a missing/TBD pin',
    /if \(\(-not \$expected\) -or \(\$expected\.StartsWith\('TBD-'\)\)\) \{ Warn "REFUSING: no verified SHA-256 pin for \$key[\s\S]{0,240}return \$false \}/.test(SETUPWIN)
      ? [] : ['the TBD/missing-pin branch no longer Warns REFUSING and returns $false']);
  none('setup.sh no longer pins the whisper.cpp clone to a tag + verified commit',
    [/WHISPER_PIN_TAG="v1\.9\.1"/.test(SETUPSH) ? '' : 'no WHISPER_PIN_TAG constant',
     /WHISPER_PIN_COMMIT="[0-9a-fA-F]{40}"/.test(SETUPSH) ? '' : 'no WHISPER_PIN_COMMIT constant (or it is not a 40-hex commit)',
     /git clone --depth 1 --branch "\$WHISPER_PIN_TAG" https:\/\/github\.com\/ggml-org\/whisper\.cpp/.test(SETUPSH)
       ? '' : 'the whisper.cpp clone no longer pins --branch "$WHISPER_PIN_TAG" (clones unpinned HEAD again)',
     /actual="\$\(git -C "\$VOICE\/whisper" rev-parse HEAD\)"/.test(SETUPSH) ? '' : 'the clone no longer rev-parses HEAD to verify the commit',
     /if \[ "\$actual" != "\$WHISPER_PIN_COMMIT" \]; then/.test(SETUPSH) ? '' : 'the clone no longer compares HEAD against WHISPER_PIN_COMMIT'].filter(Boolean));
  none('provision-win.ps1 lost its Fetch-Verified checksum plumbing or a direct-download site regressed to a floating URL',
    [/function Fetch-Verified\(\$url, \$out, \$what, \$pinKey\)/.test(PROVWIN) ? '' : 'Fetch-Verified is gone from provision-win.ps1',
     /\$PINS = @\{/.test(PROVWIN) ? '' : 'no $PINS block in provision-win.ps1',
     /Invoke-RestMethod[\s\S]{0,80}releases\/latest/.test(PROVWIN) ? 'a live releases/latest API resolution is still present in a download path' : '',
     /Invoke-RestMethod[\s\S]{0,80}index\.json/.test(PROVWIN) ? 'the nodejs.org index.json "latest LTS" resolution is still present' : '',
     /Fetch-Verified \$url \$zip 'Node\.js' "node-\$a"/.test(PROVWIN) ? '' : 'the node.js zip download is no longer routed through Fetch-Verified',
     /Fetch-Verified \$sfxUrl \$sfx 'PortableGit' 'PortableGit'/.test(PROVWIN) ? '' : 'the PortableGit download is no longer routed through Fetch-Verified',
     /Fetch-Verified \$CLOUDFLARED_URL \$exe 'cloudflared' 'cloudflared'/.test(PROVWIN) ? '' : 'the cloudflared download is no longer routed through Fetch-Verified'].filter(Boolean));
}

// ---------------------------------------------------------------------------------------------------------
// 115. PIN VALUES FILLED. CHECKSUM-PLUMBING (test 114) landed the fail-closed wiring with every
//   real hash/commit left as a 'TBD-*' placeholder on purpose (a placeholder must never be mistaken for a
//   verified pin, and the plumbing hard-refuses on one by construction). A separate PIN-COMPUTATION step,
//   a one-time maintainer-verified download, took each exact artifact from its official host, hashed the actual
//   bytes, and deleted the download; those computed values now replace every placeholder here. This is the
//   closing pin: NO 'TBD-' placeholder may remain in any of the three scripts a live install runs.
// ---------------------------------------------------------------------------------------------------------
{
  const PROVWIN2 = read('setup/provision-win.ps1');
  // Matches an ASSIGNMENT of a TBD- value ( ="TBD- / = 'TBD- ), not the fail-closed detection logic that
  // legitimately still compares against the 'TBD-' prefix (e.g. `''|TBD-*)`, `StartsWith('TBD-')`) nor the
  // prose comments explaining the convention -- neither of those puts an `=` directly before the quote.
  const TBD_PLACEHOLDER = /=\s*['"]TBD-/;
  none('a TBD- placeholder pin still remains in one of the checksum-verified setup scripts',
    [TBD_PLACEHOLDER.test(SETUPSH) ? "setup.sh still has an unfilled TBD- pin assignment" : '',
     TBD_PLACEHOLDER.test(SETUPWIN) ? "setup-win.ps1 still has an unfilled TBD- pin assignment" : '',
     TBD_PLACEHOLDER.test(PROVWIN2) ? "provision-win.ps1 still has an unfilled TBD- pin assignment" : ''].filter(Boolean));
}

// ---------------------------------------------------------------------------------------------------------
// history:append used payload.wsId raw as the history-file key instead of resolving it through
// _wsById like its sibling handlers (checkpoint:revert/undo/undoExists just above it). A stale/garbage wsId
// would mint a new runtime/history/<garbage>.json instead of falling back to activeWorkspace.
// ---------------------------------------------------------------------------------------------------------
(function () {
  const handler = (MAIN.match(/ipcMain\.handle\('history:append', \(e, payload\) => \{[\s\S]*?\n\}\);/) || [''])[0];
  none('history:append no longer resolves wsId through _wsById (a stale id would mint a garbage history file)',
    /_wsById\(payload && payload\.wsId\)/.test(handler) ? [] : ['history:append handler missing _wsById resolution']);
})();

// ---------------------------------------------------------------------------------------------------------
// A hand-edited workspaces.json can hold a ws.path that round-trips fine (isSafePath) but is
// relative or contains a traversal segment. The two registry-sourced ws.path -> script sites (clone,
// upgrade) must validate with the stricter isContainedPath before building the runScript command.
// ---------------------------------------------------------------------------------------------------------
(function () {
  none('main.js no longer imports isContainedPath from lib/pathSafe',
    /require\('\.\/lib\/pathSafe'\)/.test(MAIN) && /isContainedPath/.test(MAIN) ? [] : ['isContainedPath not imported']);
  const cloneSite = (MAIN.match(/function ensureClone\(ws\) \{[\s\S]*?\n  \}\)\;/) || [''])[0];
  none('ensureClone (clone-workspace.sh site) no longer guards ws.path with isContainedPath',
    /isContainedPath\(ws\.path\)/.test(cloneSite) ? [] : ['ensureClone missing isContainedPath guard']);
  const upgradeSite = (MAIN.match(/ipcMain\.handle\('workspace:upgrade', async \(e, id\) => \{[\s\S]*?\n\}\);/) || [''])[0];
  none('workspace:upgrade (upgrade-workspace.sh site) no longer guards ws.path with isContainedPath',
    /isContainedPath\(ws\.path\)/.test(upgradeSite) ? [] : ['workspace:upgrade missing isContainedPath guard']);
})();

// ---------------------------------------------------------------------------------------------------------
// Porcelain `git diff` against a workspace repo must always suppress driver execution. Unlike the
// fixed config keys _git-safe.sh neutralizes via GIT_CONFIG_KEY_n, `diff.<driver>.textconv` is keyed by an
// ATTACKER-CHOSEN driver name (set via .gitattributes), so it cannot be wildcarded by env — the only backstop
// is passing --no-ext-diff --no-textconv at every porcelain diff call site. wsl/diff.sh runs three: the
// uncommitted `diff HEAD` and both `diff <base> HEAD` (week-window and latest-window) net-diffs.
// ---------------------------------------------------------------------------------------------------------
{
  const diffSh = fs.readFileSync(path.join(wslDir, 'diff.sh'), 'utf8');
  // Matched narrowly on the ACTUAL invocation prefix diff.sh uses (`git -c core.quotepath=false diff`), not a
  // bare /git.*diff/ scan — line 15's comment ("core.fsmonitor fires on `git diff HEAD`") mentions git diff in
  // prose and would otherwise false-positive as an unflagged call site.
  const diffInvocations = diffSh.split('\n').filter((l) => /git -c core\.quotepath=false diff\b/.test(l) && !/^\s*#/.test(l));
  none('diff.sh has fewer porcelain `git … diff …` call sites than expected (this pin would go vacuous)',
    diffInvocations.length >= 3 ? [] : [`only ${diffInvocations.length} found: ${JSON.stringify(diffInvocations)}`]);
  none('a `git … diff …` call in diff.sh is missing --no-ext-diff and/or --no-textconv (textconv/ext-diff RCE — driver names are attacker-chosen, so env cannot neutralize this; see _git-safe.sh header)',
    diffInvocations.filter((l) => !/--no-ext-diff/.test(l) || !/--no-textconv/.test(l)));
  // Merge-driver half of the same RCE class (merge.<driver>.driver, also attacker-named via .gitattributes, so
  // also un-neutralizable by env). It is NOT absent from this tree — sessions-sync.sh:344/:350 really do run
  // `merge`, through the `gitwt()` wrapper — so this pin is an EXPLICIT-EXEMPTION sweep, not an absence claim:
  // every merge/rebase/cherry-pick site must be a KNOWN one, and a new file (or a new wrapper) fails the build.
  // Subcommand-anchored, and wrapper-aware: any function this file defines whose body calls git counts as a git
  // invocation, because a bare /\bgit\s+merge/ scan is blind to `gitwt merge` — the only form actually used
  // here. Still no false positives on `git config --get branch.$b.merge` (git-fetch.sh): `config` is not a flag,
  // so the subcommand slot does not match.
  const KNOWN_MERGE_SITES = {
    // Runs against $WT, a linked worktree of $SDIR — so it reads $SDIR/.git/config, which IS attacker-controlled
    // for an adopted workspace. Left as-is deliberately: closing it means editing sessions-sync.sh, outside
    // the textconv/ext-diff fix's file list. Tracked separately as follow-up work (the merge-driver half).
    'sessions-sync.sh': 'gitwt merge --no-edit / --abort on the sessions worktree (pull_branch)',
  };
  const mergeIsh = fs.readdirSync(wslDir).filter((f) => f.endsWith('.sh')).filter((f) => {
    const src = stripComments(fs.readFileSync(path.join(wslDir, f), 'utf8'));
    const callers = new Set(['git']);
    for (const m of src.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{[^\n]*\bgit\b/gm)) callers.add(m[1]);
    const re = new RegExp(`\\b(?:${[...callers].join('|')})(?:\\s+-{1,2}\\S+|\\s+-C\\s+\\S+|\\s+[A-Za-z_][A-Za-z0-9_]*=\\S+)*\\s+(?:merge|rebase|cherry-pick)\\b`);
    return re.test(src);
  });
  none('a NEW wsl script runs merge/rebase/cherry-pick against a workspace repo — merge.<driver>.driver is the same attacker-chosen-key RCE class as textconv and no flag suppresses it; escalate before adding one',
    mergeIsh.filter((f) => !Object.prototype.hasOwnProperty.call(KNOWN_MERGE_SITES, f)));
  none('a KNOWN_MERGE_SITES entry no longer matches — the exemption has rotted; delete the entry (and the escalation with it)',
    Object.keys(KNOWN_MERGE_SITES).filter((f) => !mergeIsh.includes(f)));
}

// ---------------------------------------------------------------------------------------------------------
// The model-strategy env pin never overrides an explicit spawn-time model choice.
//   CLAUDE_CODE_SUBAGENT_MODEL was measured (API response stamps) overriding even explicitly-
//   requested spawn models, so the app must never hard-set it: the cheap-tier default is carried by the
//   context-hook nudge text instead, and modelStrategyNow() defaults OFF (opt-in only).
// ---------------------------------------------------------------------------------------------------------
{
  // (reinstated with the fix/modelstrategy reapply; renumbering dropped — the checksums branch claims 114/115)
  none('main.js: modelStrategyNow no longer defaults OFF (must require an exact allowlisted opt-in)',
    /function modelStrategyNow\(\) \{ return \['planBigExecSmall', 'custom'\]\.includes\(registry\.modelStrategy\) \? registry\.modelStrategy : 'off'; \}/.test(MAIN)
      ? [] : ['modelStrategyNow does not gate on the explicit planBigExecSmall|custom allowlist']);
  const SESSSH = read('wsl/session.sh');
  const WIN = read('runners/win.js');
  none('wsl/session.sh: a hard CLAUDE_CODE_SUBAGENT_MODEL pin has crept back in (a default must never override an explicit model choice)',
    /CLAUDE_CODE_SUBAGENT_MODEL\s*=/.test(SESSSH) ? ['session.sh still assigns CLAUDE_CODE_SUBAGENT_MODEL'] : []);
  none('runners/win.js: a hard CLAUDE_CODE_SUBAGENT_MODEL pin has crept back in (a default must never override an explicit model choice)',
    /CLAUDE_CODE_SUBAGENT_MODEL\s*=/.test(WIN) ? ['win.js still assigns CLAUDE_CODE_SUBAGENT_MODEL'] : []);

  // ---- The strategy is REAL (files + observation), and these pins keep each honesty guard alive.
  // Every pin below was proven to BITE at introduction: its guard was deleted on the working tree,
  // the suite went red, the guard was restored. A pin that cannot fail is worse than no pin.
  // (a) The Agents pane must never substitute the tab's model for an omitted Task-call model — that displayed
  //     an assumption as an observation, which is the exact disease these pins exist against.
  {
    const start = APP.indexOf('function onAgentStart(');
    const seg = start >= 0 ? APP.slice(start, APP.indexOf('function onAgentDone(')) : '';
    none('renderer: onAgentStart could not be located (the model-guess pin would go vacuous)', seg ? [] : ['onAgentStart not found']);
    none('renderer: the Agents pane GUESSES an omitted subagent model from the tab again (observed truth only)',
      /model: String\(ti\.model \|\| ''\)\s*\|\|/.test(seg) ? ['onAgentStart falls back past the Task call for model'] : []);
  }
  // (b) The team chip types into a pty; it must run behind the SAME guard as every cockpit send —
  //     a joined/parked/unstarted tab never receives its bytes.
  {
    const at = APP.indexOf("const pb = $('pb-btn')");
    const seg = at >= 0 ? APP.slice(at, at + 900) : '';
    none('renderer: the team chip sends without canApplyToLiveSession (a guest could type into the host)',
      /canApplyToLiveSession\(\)/.test(seg) ? [] : ['pb-btn arm path does not consult canApplyToLiveSession']);
  }
  // (c) The file writer's delete path may touch exactly ONE thing: the plan-big skill dir. A second rmSync
  //     appearing in that tool means its blast radius grew — fail loudly before it ships.
  {
    const TOOL = read('wsl/strategy-files-tool.js');
    const rms = (TOOL.match(/rmSync\(/g) || []).length;
    none('strategy-files-tool: the delete path widened beyond the plan-big skill dir',
      rms === 1 && /rmSync\(skillDir/.test(TOOL) ? [] : [`expected exactly one rmSync(skillDir…), found ${rms}`]);
    none('strategy-files-tool: seat overrides are no longer allowlisted (unknown values must reject, never interpolate)',
      /MODELS\.includes\(v\.model\)/.test(TOOL) && /EFFORTS\.includes\(v\.effort\)/.test(TOOL) ? [] : ['the model/effort allowlist checks are gone']);
  }
  // (d) The toggle must keep REPORTING whether the files really landed (a real readback) — a return without
  //     filesOk turns the honest toast back into a guess.
  none('main.js: modelStrategy:set no longer reports filesOk (the toast would claim installs it cannot see)',
    /return \{ ok: true, modelStrategy: now, filesOk \}/.test(MAIN) ? [] : ['the set handler return dropped filesOk']);
  // (e) The old env rail stays DEAD: CLAUDIBLE_MODEL_STRATEGY must not reappear in any spawn path. Two
  //     competing mechanisms claiming one setting is how the original cosmetic-control bug family started.
  {
    const SH = ['runners/_shared.js', 'runners/win.js', 'runners/posix.js', 'runners/wsl.js', 'wsl/session.sh'].map((f) => f + ': ' + read(f));
    none('the CLAUDIBLE_MODEL_STRATEGY env rail grew back in a spawn path (it was deleted — files, not env)',
      SH.filter((s) => /CLAUDIBLE_MODEL_STRATEGY\s*[:=]|CLAUDIBLE_MODEL_STRATEGY='/.test(s)).map((s) => s.slice(0, s.indexOf(':'))));
  }
  // (f) GRAPHS (the N-node compiler). Two guards keep custom graphs as safe as the fixed five:
  //     the prune regex is the ONLY file-deletion in the graph path and must stay anchored to the reserved
  //     node pattern; and every node type must pass the library allowlist — an unknown type REJECTS, never
  //     interpolates into a generated file.
  {
    const TOOL = read('wsl/strategy-files-tool.js');
    none('strategy-files-tool: the graph prune regex lost its anchors (it could match beyond the reserved node files)',
      TOOL.includes('/^claudible--pb--n\\d+-[a-z-]+\\.md$/') ? [] : ['the anchored prune regex ^claudible--pb--n\\d+-[a-z-]+\\.md$ is gone']);
    none('strategy-files-tool: an unknown node type no longer rejects (it must never reach a generated file)',
      /!LIB\[n\.type\]\) return \{ ok: false/.test(TOOL) ? [] : ['the LIB[n.type] allowlist rejection is gone']);
  }
  // (f-i) THE AGENTS LEDGER (variant A4, owner-approved 2026-08-19). This pane had ZERO pins before today,
  //       which is why a redesign could quietly take load-bearing behaviour with it. Three things are pinned —
  //       each one a silent failure if lost, not a visible one.
  {
    // (1) The 1s tick must keep advancing timers IN PLACE. Rebuilding the pane every second re-creates every
    //     row: the entry animations re-flash, and the open detail pane and its scroll position are destroyed
    //     under the user's cursor while they read. The data-start contract is what keeps that cheap.
    none('renderAgents() lost its in-place timer tick (the pane would rebuild every second)',
      /if \(sig === _agentsSig\) \{[\s\S]{0,400}?querySelectorAll\('\[data-start\]'\)[\s\S]{0,200}?return;/.test(APP)
        && /el\.dataset\.start = startSec/.test(APP)
        ? [] : ['the sig short-circuit or the data-start elapsed cell is gone']);
    // (2) The filter and the selected row change what is on screen with no underlying data change. If they are
    //     not in the signature, clicking a filter repaints nothing and the pane looks frozen.
    none('the agents signature ignores the filter/selection (clicks would paint nothing)',
      /agentsFilter, selectedAgent\]\)/.test(APP) ? [] : ['agentsFilter/selectedAgent are not in the render signature']);
    // (3) The observed strip's pin was RETIRED on 2026-08-19, the day after it was added — the owner removed
    //     the strip itself, because the A4 ledger prints Model on every row and the strip said it twice. What
    //     survives, and is pinned instead, is the part that was never redundant: `obs` still feeds the
    //     empty-state test, so a tab whose only evidence is on-disk transcripts cannot claim it has no agents.
    none('the agents empty-state ignores on-disk transcript evidence (it would claim "No agents running")',
      /if \(!all\.length && !obs\.length\)/.test(APP) ? [] : ['the empty-state no longer consults obs']);
    // (4) Tokens are absent (not zero) for a running Task subagent — they arrive with the completion payload.
    //     Printing 0 would state as fact that an agent used no tokens, which is a different claim.
    none('a running agent with no token report would render as 0 rather than as unknown',
      /\(a\.tokens \|\| 0\) > 0 \? fmtK\(a\.tokens\) : '—'/.test(APP) ? [] : ['the unknown-tokens em-dash fallback is gone']);
  }
  // (f-ii) The graphs drawer's reading link (owner-chosen, 2026-08-19). Pinned because it is the one element
  //        here that rots SILENTLY: a dead or swapped URL still renders as a perfectly good button, and nobody
  //        clicks their own docs link. The three notes are pinned as three <li> for the same reason — the
  //        run-on line they replaced was a readability defect the owner had to report by eye.
  {
    // The destination changed 2026-08-19 (article -> video, owner call: more concise and direct). The pin moves
    // with it rather than being loosened — the whole point is that a swapped or dead link still renders as a
    // perfectly good button, so the exact URL is what has to be guarded.
    none('the graphs drawer lost its learn-more button, or it stopped opening the owner-chosen video',
      /id="strat-learn"/.test(HTML)
        && /\$\('strat-learn'\)[\s\S]{0,200}?claudible\.openExternal\('https:\/\/www\.youtube\.com\/watch\?v=mBePcvqLX88'\)/.test(APP)
        ? [] : ['#strat-learn is gone or no longer opens the owner-chosen graphs video']);
    // "Save & use" on the ALREADY-ACTIVE graph must still confirm and repaint. activate() early-returns on a
    // no-op switch, so routing every useAfter through it swallowed both the toast and the list redraw: the
    // click read as dead, and a rename left the old name on screen. The guard is the id !== deck.active test.
    none('"Save & use" routes an already-active graph back through activate() (the click goes silent again)',
      /if \(useAfter && r\.id !== deck\.active\) \{ await activate\(r\.id\); return; \}/.test(APP)
        ? [] : ['save() no longer guards the useAfter path against a no-op activate()']);
    none('the graphs notes collapsed back into one run-on line',
      (HTML.match(/<ul class="strat-notes">[\s\S]*?<\/ul>/) || [''])[0].match(/<li>/g)?.length === 3
        ? [] : ['the .strat-notes list is missing or no longer has exactly three items']);
  }
  // (g) SEND-BACK (the deliver lane's bounded feedback loop — widened from synthesizer-only on owner order,
  //     2026-08-19). Three guards keep it honest: the value is allowlisted (×1/×2 only — an unbounded loop
  //     must never compile), it is deliver-lane-only (on any other node the whole call REJECTS rather than
  //     silently dropping the option), and the generated coordinator actually carries the rule — without it
  //     the dial is cosmetic — the exact failure this whole feature was rebuilt to avoid.
  {
    const TOOL = read('wsl/strategy-files-tool.js');
    // Widened to [1,2,3,5] on 2026-08-19 with the header's Loop Settings control. The POINT of the pin is
    // unchanged and is the reason "loop until done" ships as 5 rather than as a real unbounded loop: the value
    // must stay a finite allowlist. A regression to accept any integer, or to drop the check, still fails here.
    none('strategy-files-tool: the send-back cap allowlist is gone (an unbounded loop could compile)',
      /!\[1, 2, 3, 5\]\.includes\(n\.sendback\)\) return \{ ok: false/.test(TOOL) ? [] : ['the [1, 2, 3, 5] send-back rejection is gone']);
    none('the Loop Settings control offers a value the compiler would reject (or an unbounded one)',
      (() => { const m = APP.match(/const LOOP_OPTS = \[([\s\S]*?)\];/); if (!m) return ['LOOP_OPTS is gone'];
        const vals = [...m[1].matchAll(/\[(\d+),/g)].map((x) => Number(x[1]));
        const bad = vals.filter((v) => v !== 0 && ![1, 2, 3, 5].includes(v));
        return bad.length ? ['LOOP_OPTS offers ' + bad.join('/') + ', which the compiler rejects'] : []; })());
    none('strategy-files-tool: send-back stopped being deliver-lane-only (other lanes must reject, never silently drop it)',
      /t\.lane !== 'deliver'\) return \{ ok: false/.test(TOOL) ? [] : ['the deliver-lane rejection is gone']);
    none('strategy-files-tool: the generated coordinator lost the SEND-BACK rule (the dial would be cosmetic)',
      /SEND-BACK: if /.test(TOOL) && /never loop past it/.test(TOOL) ? [] : ['the SEND-BACK coordinator rule is gone']);
  }
}

// ---------------------------------------------------------------------------------------------------------
// The sidebar keeps its last good session list painted through a refresh.
//   Two ways a populated sidebar used to go blank for a second or more: (a) a sync dropped the cached list
//   outright, so the pre-fill and the project tree had nothing to paint while the fresh list was being fetched
//   (a shell + node round trip, not instant); (b) a list read taken while the store was being rewritten came
//   back empty and painted the "no sessions" notice straight over real rows. The cache entry is now MARKED
//   out of date instead of dropped, and an empty answer is only believed on a second, quiet re-check.
// ---------------------------------------------------------------------------------------------------------
{
  const handler = (APP.match(/claudible\.onSyncChanged\(\(s\) => \{[\s\S]*?\n\}\);/) || [''])[0];
  none('renderer: the sync-changed handler could not be located (the two pins below would go vacuous)',
    handler ? [] : ['onSyncChanged((s) => { ... }) not found in renderer/app.js']);
  none('renderer: a sync DROPS the cached session list instead of marking it out of date (the sidebar blanks for the whole refresh)',
    /_wsSessCache\.delete\(/.test(handler) ? ['onSyncChanged still calls _wsSessCache.delete('] : []);
  none('renderer: the sync-changed handler no longer marks the cached session list as out of date',
    /_wsSessCache\.get\(s\.id\)[\s\S]{0,200}?\.stale = true/.test(handler) ? [] : ['onSyncChanged does not set .stale = true on the cached entry']);
  // The mark is only useful if every fetch path treats it as "refetch now" — otherwise a just-written cache
  // entry would keep serving pre-sync rows to the non-active project tree until its age threshold expired.
  none('renderer: the non-active project tree ignores the out-of-date mark (it would keep serving pre-sync rows)',
    /if \(\(!c \|\| c\.stale \|\| Date\.now\(\) - c\.ts > \d+\)/.test(APP) ? [] : ['the subtree refetch condition does not consider c.stale']);

  const fnAt = APP.indexOf('async function refreshSessions()');
  const branchAt = APP.indexOf('if (!list.length && !liveTabs.length', fnAt);
  const noticeAt = APP.indexOf('No saved sessions yet', branchAt);
  none('renderer: refreshSessions / its empty-list branch / the empty notice could not be located (the pins below would go vacuous)',
    fnAt > 0 && branchAt > fnAt && noticeAt > branchAt ? [] : [`fnAt=${fnAt} branchAt=${branchAt} noticeAt=${noticeAt}`]);
  const body = APP.slice(fnAt, noticeAt);       // everything in refreshSessions BEFORE the notice is painted
  const branch = APP.slice(branchAt, noticeAt); // the empty-list branch itself, up to the notice
  none('renderer: refreshSessions no longer reads the previously cached list before overwriting it',
    /const lastGood = _wsSessCache\.get\(myWs\);/.test(body) ? [] : ['no `const lastGood = _wsSessCache.get(myWs)` read ahead of the cache write']);
  none('renderer: the empty-list branch paints its notice without consulting the last good cached list',
    /lastGood/.test(branch) ? [] : ['the empty-list branch never references the last good cached list']);
  none('renderer: the empty-list branch no longer requires rendered rows before keeping the current paint',
    /sessListEl\.querySelector\('\.sess'\)/.test(branch) ? [] : ['the empty-list guard does not check for rendered .sess rows']);
  none('renderer: the empty-list branch no longer schedules exactly one quiet re-check before believing an empty answer',
    /setTimeout\(\(\) => \{[^\n]*refreshSessions\(\);[^\n]*\}, 1500\)/.test(branch) ? [] : ['no single delayed refreshSessions re-check found in the empty-list branch']);
  none('renderer: the single-re-check flag can stack (the guard must skip scheduling while one is already pending)',
    /if \(!_sessRecheckTimer\) _sessRecheckTimer = setTimeout\(/.test(branch) ? [] : ['the re-check is scheduled without a pending-timer guard']);
}

// ---------------------------------------------------------------------------------------------------------
// 116. A CONTINUED CONVERSATION LEAVES ITS PREDECESSOR IN THE LIST. `/clear` mints a new session id, so the
//   window the user named once becomes TWO sidebar rows wearing the same name — the emptied original beside
//   the one they are actually in, indistinguishable and both clickable. The continuation link already exists;
//   the sidebar just never used it. These pins hold the three pieces that make the fold work and keep it safe:
//   the link is recorded LOCALLY (so a project with no repo behind it folds too, and the fold survives a
//   restart), it travels with the shared names for the OTHER machine (strictly inside the opt-in branch, or
//   test/port-parity.sh's byte comparison of the plain output breaks), and the list is folded BEFORE it is
//   cached (or the warm cache and the paint disagree). Two guards are load-bearing and pinned individually:
//   a predecessor is hidden only when its continuation is itself visible, and the ancestor walk is bounded.
// ---------------------------------------------------------------------------------------------------------
{
  const TOOL = read('wsl/sessions-sync-tool.js');
  const fnAt = APP.indexOf('async function refreshSessions()');
  const cacheAt = APP.indexOf('_wsSessCache.set(myWs,', fnAt);
  none('renderer: refreshSessions / its list-cache write could not be located (the pins below would go vacuous)',
    fnAt > 0 && cacheAt > fnAt ? [] : [`fnAt=${fnAt} cacheAt=${cacheAt}`]);
  const pre = APP.slice(fnAt, cacheAt);   // everything refreshSessions does BEFORE it caches the list
  none('renderer: the list is cached before superseded conversations are folded out (cache and paint would disagree)',
    /const superseded = new Set\(\);/.test(pre) && /list = list\.filter\(\(s\) => !superseded\.has\(s\.id\)\);/.test(pre)
      ? [] : ['no superseded set is built and filtered ahead of the _wsSessCache write']);
  none('renderer: the fold reads only one source of the continuation link (local-only, or shared-only)',
    /lineage\[cur\]/.test(pre) && /shared\.cf/.test(pre)
      ? [] : ['the ancestor walk does not consult both the local map and the shared entry']);
  none('renderer: a predecessor is hidden even when the row continuing it is not in the list (it would vanish outright)',
    /if \(present\.has\(parent\)\) superseded\.add\(parent\);/.test(pre)
      ? [] : ['no visibility guard before marking a predecessor superseded']);
  none('renderer: the ancestor walk lost its cycle guard (a self- or circular link would hang the sidebar)',
    /seen\.has\(parent\)/.test(pre) ? [] : ['no visited-set guard in the ancestor walk']);
  // The link must be stored locally and UNGATED on workspace kind — the repo-only publish alone leaves every
  // plain local project unfolded, and leaves even a repo project unfolded until the next shared-name poll.
  none('renderer: the continuation link is no longer recorded locally (a project with no repo would never fold)',
    /function saveSessionLineage\(/.test(APP) && /saveSessionLineage\(s\.sessionId, driftFrom\);/.test(APP)
      ? [] : ['the drift handler does not persist the link outside the repo-gated publish']);
  none('renderer: the local link map is unbounded (settings.json would carry every clear ever)',
    /MAX_LINEAGE_PREFS/.test(APP) ? [] : ['no cap on the stored continuation links']);
  // An optimistic name write must MERGE into the shared entry: replacing it drops the link and un-folds the
  // predecessor row until the next poll. It must also survive a legacy bare-string entry (spreading a string
  // would produce character-indexed keys).
  none('renderer: an optimistic name write replaces the shared entry instead of merging (the link would be dropped)',
    /remoteTitles\[s\.sessionId\] = Object\.assign\(\{\}, titleExtra\(remoteTitles\[s\.sessionId\]\)/.test(APP)
      ? [] : ['a remoteTitles write still clobbers the whole entry']);
  none('renderer: the merge helper accepts a legacy bare-string entry (it would spread into character keys)',
    /const titleExtra = \(v\) => \(v && typeof v === 'object' && !Array\.isArray\(v\)\) \? v : null;/.test(APP)
      ? [] : ['titleExtra does not restrict itself to real entry objects']);
  // The shared read: `cf` inside the opt-in branch ONLY.
  const trAt = TOOL.indexOf('function titleRead()');
  const optInAt = TOOL.indexOf("if (process.env.CL_TS === '1') {", trAt);
  const elseAt = TOOL.indexOf('} else {', optInAt);
  const resAt = TOOL.indexOf('const result = obj([', elseAt);
  none('the shared title read / its opt-in branch could not be located (the pins below would go vacuous)',
    trAt > 0 && optInAt > trAt && elseAt > optInAt && resAt > elseAt ? [] : [`trAt=${trAt} optInAt=${optInAt} elseAt=${elseAt} resAt=${resAt}`]);
  none('the opt-in shared title read no longer carries the continuation link (the other machine could never fold)',
    /'cf'/.test(TOOL.slice(optInAt, elseAt)) ? [] : ['no cf key emitted in the opt-in branch']);
  none('the continuation link leaked into the plain title read (its output must stay byte-identical)',
    /cf/.test(TOOL.slice(elseAt, resAt)) ? ['the no-env branch emits a continuation link'] : []);
  // One winner per id: the link has to be decided by the SAME newest-entry rule as the name, or a name from
  // one author's file could be paired with a link from another's.
  none('the continuation link is not decided by the same newest-entry rule as the name',
    /best\.set\(i, \[ts, t, cf\]\);/.test(TOOL) ? [] : ['cf is not carried in the per-id winner tuple']);
}

// ---------------------------------------------------------------------------------------------------------
// THE PRIVACY PAUSE IS AUTOMATIC ONLY. There is no host-side Pause/Resume button and no renderer-driven way to
// freeze the mirror: the mirror pauses exactly when the host moves onto a workspace that isn't shared, derived
// in main. This block pins BOTH halves — the manual control stays gone (button, its IPC handler, its preload
// bridge), and the automatic machinery it was bolted onto is still standing (the setSharePaused wrapper in
// main, the share server's own `paused` gate). Deleting the button must never take the auto-pause with it.
// ---------------------------------------------------------------------------------------------------------
{
  const H = read('renderer/index.html'), A = read('renderer/app.js'), M = read('main.js'), PL = read('preload.js'), SRV = read('share/server.js');
  none('a host-side pause button is back in the cockpit (the pause is automatic — a manual override would out-rank it)',
    [/pause-btn/.test(H) ? 'renderer/index.html still references pause-btn' : '',
     /pause-btn/.test(A) ? 'renderer/app.js still references pause-btn' : ''].filter(Boolean));
  none('main.js accepts a renderer request to flip the pause state again',
    /ipcMain\.handle\(\s*'share:pause'/.test(M) ? ['main.js still handles share:pause'] : []);
  none('preload.js still bridges a manual pause call into main',
    /sharePause\s*:/.test(PL) ? ['preload.js still exposes a sharePause bridge'] : []);
  // …and the automatic half must survive: without these the removal above would have deleted the feature.
  none('the automatic privacy pause was removed along with the button',
    [/function setSharePaused\(/.test(M) ? '' : 'main.js no longer defines setSharePaused',
     /setSharePaused\(/.test(M) ? '' : 'nothing in main.js calls setSharePaused',
     /paused/.test(SRV) ? '' : "share/server.js no longer has a `paused` gate"].filter(Boolean));
}

// ---------------------------------------------------------------------------------------------------------
// THE SESSION CHIP MUST NOT INVENT A NAME WHILE IT WAITS. On join, the guest paints the chip the moment the
// socket is admitted, roughly a second before the first status push carries the real session name. That gap
// used to be filled with the literal "live session", which reads like an actual session name rather than a
// wait state, so a guest could screenshot a chip naming a session that does not exist. The admission handler
// now paints a neutral loading label; the status path keeps its own unnamed-session fallback, which is a
// FINAL state (a session that genuinely has no name) and is deliberately left alone.
// ---------------------------------------------------------------------------------------------------------
{
  const helloHandler = (GUEST_JS.match(/if \(msg\.type === 'hello'\) \{[\s\S]*?\} else if \(msg\.type === 'pending'\)/) || [''])[0];
  none('the guest join handler was not found (this pin would go vacuous)',
    helloHandler ? [] : ['could not isolate the hello branch of share/guest.js']);
  none('the session chip still shows a name-like placeholder during the wait for the first status push',
    [/ct\.textContent = 'loading…'/.test(helloHandler) ? '' : 'the join handler does not paint the neutral loading label',
     /'live session'/.test(helloHandler) ? 'the join handler still assigns the literal "live session"' : ''].filter(Boolean));
  // The final-state fallback is a separate code path and must survive untouched.
  none('the unnamed-session fallback on the status path was removed along with it',
    /s\.session \|\| 'live session'/.test(GUEST_JS) ? [] : ['the status path no longer falls back for a genuinely unnamed session']);
}

// ---------------------------------------------------------------------------------------------------------
// UPDATING CLAUDE CODE MUST NOT BREAK CLAUDE CODE. Two independent ways the old flow shipped a dead CLI:
//   1. it replaced the program while sessions were still running it (Windows holds the file open, npm writes
//      a half-tree), and
//   2. it trusted npm's exit code, which is 0 even when the Windows program was skipped as an optional piece.
// So: offer to close the running sessions first (never a bare refusal, never a silent kill), and prove the
// installed binary actually starts before anything is allowed to report success.
// ---------------------------------------------------------------------------------------------------------
{
  const pf = (MAIN.match(/ipcMain\.handle\('preflight:install'[\s\S]*?\n\}\);/) || [''])[0];
  none('the install handler cannot receive the caller consent flag at all',
    /ipcMain\.handle\('preflight:install', async \(_e, depId, opts\)/.test(pf)
      ? [] : ['preflight:install does not take an options argument']);
  none('installing Claude Code no longer stops while local sessions are running it',
    /id === 'claude' && runner\.id === 'win' && ptys\.size > 0 && !\(opts && opts\.closeSessions\)[\s\S]{0,300}?needsSessionsClosed: true/.test(pf)
      ? [] : ['no running-sessions gate on the claude install path']);
  none('...and the gate reports the counts the question needs (how many, how many mid-turn)',
    /sessions: ptys\.size, busy/.test(pf) && /if \(rec && rec\.busy\) busy\+\+/.test(pf)
      ? [] : ['the gate does not report the session/mid-turn counts']);
  {
    const iGate = pf.indexOf('needsSessionsClosed: true'), iInstall = pf.indexOf('deps.install(');
    none('the gate is reached AFTER the install has already run (it would guard nothing)',
      iGate > -1 && iInstall > -1 && iGate < iInstall ? [] : ['the running-sessions gate does not precede deps.install']);
  }
  none('consent no longer closes the sessions before installing',
    /opts && opts\.closeSessions && ptys\.size[\s\S]{0,300}?rec\.proc\.kill\(\)/.test(pf)
      ? [] : ['the consent path does not kill the local ptys first']);
  none('...and it starts the install before the closed sessions have actually let go of the binary',
    /for \(let i = 0; i < 30 && ptys\.size; i\+\+\) await new Promise/.test(pf)
      ? [] : ['no bounded wait for the ptys to drain before installing']);
  // The post-install proof. Order is the whole point: the caches must be cleared FIRST, or the check runs
  // against the path resolved before the install and proves nothing.
  {
    const iReset = pf.indexOf('runner.resetCaches()'), iVerify = pf.indexOf('runner.verifyClaudeRuns()');
    none('a Claude Code install is still reported successful without ever running the result',
      iVerify > -1 ? [] : ['preflight:install never verifies that claude starts']);
    none('the verification runs against the stale resolved path (caches not cleared first)',
      iReset > -1 && iVerify > -1 && iReset < iVerify ? [] : ['verifyClaudeRuns is not called after resetCaches']);
  }
  none('a binary that will not start still reports a green install',
    /return \{ ok: false, error: 'Claude Code installed but will not start: ' \+ detail/.test(pf)
      ? [] : ['a failed verification does not fail the install with the real reason']);
  // …and that early return still has to do the housekeeping the normal end of the success path does: the
  // install really ran and really moved PATH, so the settings drawer's cached GitHub row is stale from here on.
  none('the failed-verification exit leaves the settings drawer holding a stale GitHub row',
    /refreshGhStateCache\(true\);[\s\S]{0,200}?return \{ ok: false, error: 'Claude Code installed but will not start/.test(pf)
      ? [] : ['the failed-verification return skips the gh state refresh after a PATH move']);
  none('the consent flag is not carried across the preload bridge',
    /preflightInstall: \(depId, opts\) => ipcRenderer\.invoke\('preflight:install', depId, opts\)/.test(PRELOAD)
      ? [] : ['preload drops the options argument']);
  none('a renderer install button ignores the "close your sessions?" answer',
    [/async function askCloseSessions\(id, r\)/.test(APP) ? '' : 'no shared close-sessions helper in the renderer',
     /claudible\.preflightInstall\(id, \{ closeSessions: true \}\)/.test(APP) ? '' : 'the helper never retries with consent',
     (APP.match(/if \(r && r\.needsSessionsClosed\) r = await askCloseSessions\(/g) || []).length >= 3
       ? '' : 'fewer than three install call sites route through the helper',
     /cancelled: true/.test(APP) ? '' : 'a declined close is not reported as a plain cancel'].filter(Boolean));
}
{
  const PROVCC = (read('setup/provision-win.ps1').match(/'claude' \{[\s\S]*?\n    \}/) || [''])[0];
  none('the claude case of provision-win.ps1 was not found (this pin would go vacuous)',
    PROVCC ? [] : ['could not isolate the claude case']);
  none('the npm install throws its own output away again',
    [/Out-Null/.test(PROVCC.split('\n').filter((l) => /npm install -g/.test(l)).join('\n')) ? 'the npm line still pipes to Out-Null' : '',
     /--include=optional/.test(PROVCC) ? '' : 'the optional Windows program is not requested',
     /--foreground-scripts/.test(PROVCC) ? '' : 'install scripts are still hidden',
     /Out-File -FilePath \$log/.test(PROVCC) ? '' : 'the output is not written to a log',
     /\$tail/.test(PROVCC) ? '' : 'the failure message carries none of the output'].filter(Boolean));
  none('an npm success with a Claude Code that will not start is still treated as a success',
    /claude --version[\s\S]{0,300}?npm reported success but Claude Code will not start/.test(PROVCC)
      && /exit 1/.test(PROVCC) ? [] : ['no post-install run check in the claude case']);
}
{
  const ex = (MAIN.match(/proc\.onExit\(\(ev\)[\s\S]*?\n    \}\);/) || [''])[0];
  none('the session-exit handler no longer receives the exit information',
    ex ? [] : ['proc.onExit does not take the exit event']);
  none('a session that died without ever rendering anything is reported as a plain "session ended"',
    [/const deadSpawn = !!\(r && !r\.closing && !r\.sawData/.test(ex) ? '' : 'no dead-spawn detection',
     /Claude exited immediately \(exit code /.test(ex) ? '' : 'no exit-code diagnostic',
     /spawnTs: Date\.now\(\)/.test(MAIN) ? '' : 'the pty record carries no spawn timestamp'].filter(Boolean));
  {
    const iReset = ex.indexOf('runner.resetCaches()'), iPresent = ex.indexOf('runner.claudePresent()');
    none('the not-connected hint is still decided by a memo taken before the spawn',
      iReset > -1 && iPresent > -1 && iReset < iPresent ? [] : ['the dead-spawn branch does not re-resolve before claudePresent']);
  }
  // The sessions Claudible closes ITSELF to free the program are the one case that looks exactly like a dead
  // spawn (blank, seconds old) and is not one. Unmarked, every update with a just-opened tab would print the
  // broken-install line, which is how a diagnostic stops being believed.
  none('a session Claudible closed on purpose is accused of having crashed',
    /rec\.closing = true;[\s\S]{0,120}?rec\.proc\.kill\(\)/.test(MAIN) && /!r\.closing/.test(ex)
      ? [] : ['the deliberate close is not distinguished from a dead spawn']);
}

// ---- a launcher that resolves is not a program that runs -------------------------------------------------
// The pre-spawn guard asked only whether a launcher EXISTS. Claude Code's updater renames its binary aside
// before writing the replacement, so an interrupted update leaves the launcher resolving and the program gone:
// the guard passed, the session spawned, and it died with nothing but the shell's raw error. These pin the
// three parts of the answer — diagnose before spawning, refuse to spawn, and offer the rename back.
{
  none('a session is still spawned when the resolved launcher points at nothing',
    [/runner\.claudeHealthNow === 'function'/.test(MAIN) ? '' : 'no pre-spawn health check',
     /health\.state !== 'ok'/.test(MAIN) ? '' : 'the health answer does not gate the spawn',
     /interrupted-update/.test(MAIN) ? '' : 'the interrupted-update case is not named to the user'].filter(Boolean));
  {
    // The refusal must come BEFORE the pty is created, or it is a post-mortem like the dead-spawn line.
    const iHealth = MAIN.indexOf('runner.claudeHealthNow'), iSpawn = MAIN.indexOf('const runtimeId = nextRuntimeId(tabId)');
    none('the health check runs after the pty has already been created',
      iHealth > -1 && iSpawn > -1 && iHealth < iSpawn ? [] : ['the health gate does not precede the spawn']);
  }
  const WINRUN = read('runners/win.js');
  none('the repair is claimed on the strength of a rename alone',
    /renameSync\(h\.oldFile, h\.target\)[\s\S]{0,240}?verifyClaudeRuns\(\)/.test(WINRUN)
      ? [] : ['repairClaude does not prove the restored program starts']);
  none('the popup cannot offer the repair (the one button that fixes the machine)',
    [/claudeRepair/.test(PRELOAD) ? '' : 'no repair bridge in preload',
     /claudeHealth/.test(PRELOAD) ? '' : 'no health bridge in preload',
     /Put the previous version back/.test(APP) ? '' : 'no repair button in the popup',
     /loadHealth\(\)\.then\(\(\) => \{ open\(\)/.test(APP) ? '' : 'the popup opens before it knows whether to offer the repair'].filter(Boolean));
  none('a machine with a healthy install pays a directory read on every spawn',
    /_claudeHealth = undefined;/.test(WINRUN) && /if \(_claudeHealth !== undefined\) return _claudeHealth;/.test(WINRUN)
      ? [] : ['the health answer is not memoized, or resetCaches does not clear it']);
}

// ---- a deleted conversation leaves nothing behind that can name it ---------------------------------------
{
  const SSYNC = read('wsl/sessions-sync.sh');
  const STOOL = read('wsl/sessions-sync-tool.js');
  none('deleting a conversation leaves its name on the shared branch',
    [/meta-evict/.test(STOOL) ? '' : 'the tool cannot evict a meta entry',
     /meta-evict/.test(SSYNC) ? '' : 'the delete never calls it',
     /tag_drop/.test(SSYNC) ? '' : 'no way to drop the exporter stamp of a deleted conversation'].filter(Boolean));
  none('a link claiming to continue a deleted conversation survives the delete',
    /continuesFrom/.test(STOOL) && /cf\[1\] === gone/.test(STOOL) ? [] : ['meta-evict drops the entry but not links pointing at it']);
  // DETECTING the link is not repairing it: cutting it strands everything above the deleted one, and the live
  // conversation at the top of that chain reappears beside its own continuation. The renderer half is pinned
  // separately (lnNext[child] = grandparent) — this is its shared-branch twin.
  none('the shared half cuts the chain instead of re-pointing it',
    /rest\.push\(\['continuesFrom', grandparent\]\)/.test(STOOL) && /grandparent !== p\[0\]/.test(STOOL)
      ? [] : ['meta-evict does not re-point a continuation onto what the deleted entry itself continued']);
  none('the local name maps keep a deleted conversation addressable',
    [/function forgetSessionTitle\(id, wsId, gone\)/.test(APP) ? '' : 'forgetSessionTitle cannot scope to a project',
     /if \(!gone\) \{ if \(Object\.keys\(patch\)\.length\) savePrefs\(patch\); return; \}/.test(APP) ? '' : 'a local-only delete still evicts the shared name of a session collaborators still have',
     /lnNext\[child\] = grandparent/.test(APP) ? '' : 'a deleted middle link is cut instead of re-pointed, stranding the chain above it',
     /patch\.remoteTitlesCache = rcNext/.test(APP) ? '' : 'the shared-name cache is never evicted per conversation',
     /patch\.sessionLineage = lnNext/.test(APP) ? '' : 'the continuation links are never evicted'].filter(Boolean));
  // A drift away from something GONE is not a continuation — recording it publishes a link to nothing and
  // permanently folds a live row away. One-sided: only a populated list for THIS project may convict.
  // …and the check must read the UNFILTERED ids: a conversation you cleared out of is routinely hidden (a stub,
  // or already folded away), and judging it on the painted rows would drop the link and strand the chain.
  none('a continuation is recorded onto a conversation that no longer exists',
    /const parentGone = \(id\) => \{[\s\S]{0,320}?_wsSessCache\.get\(t\.wsId\)[\s\S]{0,900}?return !c\.ids\.includes\(id\);/.test(APP)
      && /Date\.now\(\) - \(c\.ts \|\| 0\) > 30000\) return false;/.test(APP)
      && /if \(driftFrom && !parentGone\(driftFrom\)\)/.test(APP)
      ? [] : ['lineage is still recorded without checking the parent exists']);
  // EXISTS and IS PAINTED are different questions. Both conviction sites must read the unfiltered ids.
  none('a hidden-but-live conversation can still be convicted as deleted',
    [/const rawIds = \(fellBack && Array\.isArray\(fellBack\.ids\)\) \? fellBack\.ids\.slice\(\) : list\.map/.test(APP) ? '' : 'the unfiltered ids are never captured, or a cached repaint narrows them to the painted set',
     /_wsSessCache\.set\(myWs, fellBack \? \{ list, ids: rawIds, ts: fellBack\.ts, stale: fellBack\.stale \}/.test(APP) ? '' : 'the cache carries no existence answer, or a cached repaint is republished as a fresh one',
     /!still && !rawIds\.includes\(remembered\)/.test(APP) ? '' : 'the highlight site still convicts on the painted list',
     /Array\.isArray\(warm\.ids\) && warm\.ids\.length\) \? warm\.ids : null/.test(APP) ? '' : 'the resolver still convicts on the painted list'].filter(Boolean));
}
// ---- deleting a GitHub repo does not have to take the user's folder with it -------------------------------
{
  none('the GitHub delete always trashes the local folder too',
    [/checkbox: \{ label: 'Also delete my local copy/.test(APP) ? '' : 'no choice offered on the confirm',
     /function workspaceDeleteCore\(id, force, keepFolder\)/.test(MAIN) ? '' : 'the core cannot keep a folder',
     /keepFolder \? 'CLAUDIBLE_KEEP_DIR=1 ' : ''/.test(MAIN) ? '' : 'keepFolder does not reach the cleanup script',
     /CLAUDIBLE_KEEP_DIR:-\}" = 1/.test(read('wsl/delete-workspace.sh')) ? '' : 'the cleanup script has no keep-the-folder mode',
     /keptDir/.test(read('wsl/delete-workspace.sh')) ? '' : 'keeping the folder skips the shadow dir and sync worktree instead of still trashing them',
     /workspaceDeleteCore\(id, true, !!keepLocal\)/.test(MAIN) ? '' : 'the handler drops the choice',
     /keepLocal: !!\(opts && opts\.keepLocal\)/.test(PRELOAD) ? '' : 'the bridge drops the choice'].filter(Boolean));
  none('the choice defaults to anything other than today’s behaviour',
    /checkbox: \{ label: 'Also delete my local copy[\s\S]{0,420}?checked: true \}/.test(APP)
      ? [] : ['the local-copy checkbox does not default to checked']);
  // THE line that decides whether a user's folder lives or dies. Inverting it passes every pin above, so it is
  // pinned by its exact shape: an object answer honours `checked`, and anything else keeps the old behaviour.
  none('the checkbox answer is read backwards, or an older caller silently loses its folder',
    /const alsoLocal = !\(ans && typeof ans === 'object'\) \|\| ans\.checked !== false;/.test(APP)
      ? [] : ['the alsoLocal decision does not have its verified shape']);
  none('the folder-keeping mode is unreachable because the script no longer runs',
    /const willMoveFolder = APPDIR_WSL/.test(MAIN)
      ? [] : ['keepFolder gates the whole cleanup script again, stranding the transcripts and the sync worktree']);
  // …and the mode must still TRASH the two things that are not the user's folder.
  { const DW = read('wsl/delete-workspace.sh');
    const keep = (DW.match(/if \[ "\$\{CLAUDIBLE_KEEP_DIR:-\}" = 1 \][\s\S]*?\nfi/) || [''])[0];
    none('keeping the folder also strands the transcripts or the shared-sessions worktree',
      [/mv -f "\$proj"/.test(keep) ? '' : 'the transcript shadow dir is left behind',
       /mv -f "\$HOME\/\.claudible\/sessions-sync\/\$slug"/.test(keep) ? '' : 'the sessions worktree is left behind'].filter(Boolean)); }
}

// ---------------------------------------------------------------------------------------------------------
// THE SHIPPED PERMISSION DEFAULT, THE CLAUDE CODE FLOOR IT DEPENDS ON, AND THE MODEL RAIL.
//   (a) The app now starts on Auto instead of asking before every step. The stored mode is read on FOUR lines
//       — the spawn log, the mode handed to spawnClaude, the foreign-override notice, and the get handler —
//       and each used to carry its own private fallback, so changing one alone made the chip promise a mode
//       the session did not launch with (the handler said Auto while spawnClaude was handed undefined and
//       fell through to Manual). One resolver answers all four. Absent means Auto; anything already stored is
//       returned untouched, INCLUDING the legacy 'default' that means Manual, so no saved choice is rewritten
//       by shipping a new default; and reading never writes, which keeps 'absent' recoverable.
//   (b) Every native-Windows launch now carries a permission-mode value, where the old default path passed
//       nothing at all. A Claude Code from before those values existed rejects the flag outright: the session
//       dies at spawn and the automatic resume-refusal retry sends the same flag again, so it never recovers.
//       A version floor stops that with an explanation naming the fix — and FAILS OPEN, because a version we
//       could not read must never cost anyone a session that would have worked.
//   (c) The model rail (allow-listed ids -> IPC handlers -> preload bridges) had no pin at either end.
// ---------------------------------------------------------------------------------------------------------
{
  const WINRUN = require('../runners/win.js');
  none('the shipped permission default is no longer Auto (a fresh profile would launch Manual again)',
    [/function permModeNow\(\) \{ return registry\.permissionMode \|\| 'auto'; \}/.test(MAIN)
      ? '' : 'permModeNow() is missing, or an unset mode no longer resolves to auto',
     /ipcMain\.handle\('permissionMode:get', \(\) => permModeNow\(\)\)/.test(MAIN)
      ? '' : 'permissionMode:get answers from something other than the shared resolver',
     /permMode: permModeNow\(\)/.test(MAIN)
      ? '' : 'spawnClaude is handed the raw registry value again — undefined on a fresh profile, which falls through to manual at the runner',
     /permission-mode=' \+ permModeNow\(\)/.test(MAIN)
      ? '' : 'the spawn log line reads the registry directly again, so the log can disagree with the mode that launched',
     /registry\.permissionMode \|\| 'default'/.test(MAIN)
      ? 'a private "|| default" fallback is back in main.js — the chip and the session can disagree again' : ''].filter(Boolean));
  none('an already-saved permission mode is no longer preserved exactly as the user saved it',
    [/\['default', 'acceptEdits', 'plan', 'auto', 'bypass'\]\.includes\(mode\) \? mode : 'default'/.test(MAIN)
      ? '' : "the set handler stopped accepting the legacy 'default' (Manual) alongside the five modes, or its unknown-value fallback stopped being the most restrictive one",
     /function permModeNow\(\) \{[^\n]*saveRegistry/.test(MAIN)
      ? 'the resolver WRITES on read — an absent mode would be stamped to disk at boot and stop being recoverable' : ''].filter(Boolean));

  // (b) The floor is a pure function of whatever `claude --version` printed, so the RULE is exercised here,
  //     not the characters that spell it.
  const gate = WINRUN._internals.claudeVersionGate;
  none('the Claude Code version floor is gone, moved off 2.1.200, or stopped failing open',
    [typeof gate === 'function' ? '' : 'runners/win.js exports no claudeVersionGate',
     typeof WINRUN.claudeVersionNow === 'function' ? '' : 'runners/win.js exports no claudeVersionNow for main.js to consult',
     ...(typeof gate === 'function' ? [
       gate('').ok === true ? '' : 'a version that could not be read is treated as too old — it must fail open',
       gate('claude: command not found').ok === true ? '' : 'an unparseable version is treated as too old — it must fail open',
       // The NUMBER is pinned, not just the mechanism. 2.1.200 is where `--permission-mode manual` starts being
       // accepted, and that single fact is the floor's whole basis; an earlier draft used 2.1.207 on a second
       // ground that turned out to apply only to the Bedrock/Vertex/Foundry backends.
       gate('').min === '2.1.200' ? '' : `the floor moved off 2.1.200 (now ${gate('').min}) — the only published basis for this gate is that 2.1.200 is where --permission-mode manual begins`,
       gate('2.1.200 (Claude Code)').ok === true ? '' : 'the floor version itself is judged too old',
       gate('2.1.233 (Claude Code)').ok === true ? '' : 'a current Claude Code is judged too old',
       gate('2.1.199 (Claude Code)').ok === false ? '' : 'a Claude Code below the floor is judged fine, so its session would silently ignore the mode chip with nothing said',
       gate('1.0.0').ok === false ? '' : 'a years-old Claude Code is judged fine',
     ] : [])].filter(Boolean));
  // The floor DEGRADES, it does not block. Claudible has never refused to start a session over a version
  // number: below the floor the runner sends no --permission-mode (exactly what every release before this one
  // sent, on every Claude Code ever shipped) and main.js says so, so the session still starts and works.
  // Both halves are pinned, because either alone is a defect — silently degrading is the dishonesty this work
  // set out to remove, and warning while still sending the rejected flag would kill the session anyway.
  none('the version floor started BLOCKING launches instead of degrading them',
    [/if \(ver\.ok === false\) winSend\(/.test(MAIN)
      ? '' : 'the spawn path no longer just warns on a below-floor version — if it returns or throws here, a working setup becomes a blocked one',
     /if \(ver\.ok === false\)[^\n]*\n\s*return;/.test(MAIN)
      ? 'the spawn path REFUSES to launch on a below-floor version — degrade and warn, never block' : '',
     /function claudeTooOldLines\(v\)/.test(MAIN) ? '' : 'the too-old message has no single wording shared by both places that can discover it',
     /npm install -g @anthropic-ai\/claude-code@latest/.test(MAIN) ? '' : 'the message no longer names the command that fixes it',
     /Claude Code ' \+ \(v\.version \|\| /.test(MAIN) ? '' : 'the message no longer names the version that was found',
     /older than ' \+ v\.min \+ '/.test(MAIN) ? '' : 'the message no longer names the version that would make the mode chip work'].filter(Boolean));
  none('a below-floor Claude Code is still sent the flag its parser rejects',
    (() => {
      const argv = WINRUN._internals && WINRUN._internals.claudeArgv;
      if (typeof argv !== 'function') return ['runners/win.js exports no claudeArgv to check the degraded argv against'];
      const old = argv({ mode: 'fresh' }, 'C:\\home', 'high', 'auto', '', false);
      const cur = argv({ mode: 'fresh' }, 'C:\\home', 'high', 'auto', '', true);
      const oldBypass = argv({ mode: 'fresh' }, 'C:\\home', 'high', 'bypass', '', false);
      return [old.includes('--permission-mode') ? 'a below-floor CLI is still handed --permission-mode, which its parser rejects and the session dies at spawn' : '',
        cur.includes('--permission-mode') ? '' : 'a current CLI stopped receiving --permission-mode at all — the chip would be decorative everywhere',
        // Bypass never used this flag, so no version can refuse it; degrading it would remove a mode the user explicitly chose.
        oldBypass.includes('--dangerously-skip-permissions') ? '' : 'bypass was degraded too, but bypass does not use --permission-mode and no version refuses it'].filter(Boolean);
    })());
  none('the dependency row and the spawn gate disagree about the same floor',
    [/if \(id === 'claude'\) rec\.ok = installed && claudeVersionGate\(rec\.version\)\.ok;/.test(read('runners/win.js'))
      ? '' : 'buildDepReport no longer scores claude against the floor, so Settings would show ready for a CLI that cannot launch a session',
     /if \(\(m\.id === 'node' \|\| m\.id === 'claude'\) && r\.ok === false\) return 'outdated';/.test(read('runners/deps.js'))
      ? '' : 'the deps row ignores claude.ok, so the floor never reaches the Settings pill'].filter(Boolean));

  // (c) The model rail, both ends. Allow-listed rather than free text so a typo cannot make every future
  //     session fail to launch, and '' must stay the answer for anything off the list (let Claude Code decide).
  none('the model allow-list or its bridges went missing (free text could ride into --model)',
    [/const MODELS = \['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'\];/.test(MAIN)
      ? '' : 'the MODELS allow-list is gone or no longer holds the four shipped ids',
     /registry\.model = MODELS\.includes\(id\) \? id : '';/.test(MAIN)
      ? '' : "model:set no longer falls back to '' for an id outside the list",
     /ipcMain\.handle\('model:get'/.test(MAIN) ? '' : "no ipcMain.handle('model:get', …) for the bridge to reach",
     /ipcMain\.handle\('model:set'/.test(MAIN) ? '' : "no ipcMain.handle('model:set', …) for the bridge to reach",
     /modelGet: \(\) => ipcRenderer\.invoke\('model:get'\)/.test(PRELOAD) ? '' : 'no modelGet bridge in preload.js',
     /modelSet: \(id\) => ipcRenderer\.invoke\('model:set', id\)/.test(PRELOAD) ? '' : 'no modelSet bridge in preload.js'].filter(Boolean));
}

// ---- the model/effort selectors apply to the RUNNING session, and cannot reach another machine ----
// Plain .includes() rather than regex: these pins have been eaten by backslash escaping before, and the whole
// point of the block is that the GUARDS survive a refactor. A dropped live-tab guard is silent until a guest's
// slider types into somebody else's terminal, so it is pinned harder than the feature it protects.
{
  const body = APP.slice(APP.indexOf('function canApplyToLiveSession()'), APP.indexOf('// Default MODEL for new sessions'));
  none('the live-apply guards for the model/effort selectors went missing',
    [APP.includes('function canApplyToLiveSession()')
      ? '' : 'canApplyToLiveSession() is gone — the selectors have no single place deciding whether a send is safe',
     body.includes("t.kind === 'live'")
      ? '' : 'THE CROSS-MACHINE GUARD IS GONE: without it a guest moving their own slider types into the HOST’s pty via liveInput',
     body.includes('t.parked')
      ? '' : 'the parked-tab guard is gone — a parked tab has no pty, so the toast would claim a send that never happened',
     body.includes('!t.started')
      ? '' : 'the not-yet-spawned guard is gone — same false-success problem as the parked case',
     APP.includes('function applyToLiveSessionSoon(')
      ? '' : 'the debounce wrapper is gone — the effort slider clicks its pill on every drag step and would fire a command per step',
     APP.includes('clearTimeout(liveApplyTimer)')
      ? '' : 'applyToLiveSessionSoon no longer coalesces, so a drag from low to max sends four commands'].filter(Boolean));
  none('the model/effort selectors stopped applying to the session in front of you',
    [APP.includes("applyToLiveSessionSoon('/effort ' + set)")
      ? '' : 'the effort selector no longer sends /effort to the running session — the control is decorative again',
     APP.includes("applyToLiveSessionSoon('/model ' + set)")
      ? '' : 'the model selector no longer sends /model to the running session — the control is decorative again',
     APP.includes("' — applied to this session and saved as default'")
      ? '' : 'the toast no longer distinguishes a live apply from a next-session-only one',
     // Permission mode has no mid-session COMMAND — `/permissions` edits allow/deny rules, not the mode, and
     // the CLI's bindable command list has chat:cycleMode and no setter. Phase 2 drives the cycle instead
     // (cyclePermTo, pinned below); a /permissions send would still be wrong by construction.
     APP.includes("applyToLiveSessionSoon('/permissions")
      ? 'a /permissions send appeared on the perm selector — that command edits RULES, not the mode; the mode is reached via cyclePermTo' : ''].filter(Boolean));
  // Drag is preview, release is choice (owner ruling on hardware: a drag committed every notch it paused on).
  // `input` must only paint; the pill click that commits lives in `change`, which fires once on release.
  none('the effort slider commits per-notch again instead of on release',
    [APP.includes("slider.addEventListener('input', () => paint(sliderLevel()))")
      ? '' : "the slider's input handler is no longer paint-only — dragging would commit every notch it pauses on",
     APP.includes("slider.addEventListener('change', () => {")
      ? '' : 'the slider has no change handler — nothing commits on release',
     APP.includes('if (want === cur) { paint(cur); return; }')
      ? '' : 'the settle-back no-op is gone — releasing on the starting level would commit a change that is not one'].filter(Boolean));

  // ---- the perm control drives Claude Code's OWN mode cycle, with eyes ----
  // A cycle is not a setter, so this control presses Shift+Tab and READS the screen after every press. The
  // reading is the whole safety argument: without it the presses are blind, and a wrong count lands in bypass.
  const cyc = APP.slice(APP.indexOf('async function cyclePermTo('), APP.indexOf('// Default MODEL for new sessions'));
  none('the permission-mode cycle lost a guard or started pressing blind',
    [APP.includes('function readPermModeFromScreen(')
      ? '' : 'readPermModeFromScreen is gone — the cycle would be counting presses blind again',
     APP.includes("return null; }") && APP.includes('} catch (e) { return null; }')
      ? '' : 'the screen reader no longer returns null on failure, so an unreadable screen would be treated as a known mode',
     cyc.includes('if (now === null) return null')
      ? '' : 'FAIL-CLOSED IS GONE: an unreadable screen no longer stops the presses',
     cyc.includes('!canApplyToLiveSession()')
      ? '' : 'THE CROSS-MACHINE GUARD IS GONE: a joined guest could cycle the HOST’s permission mode',
     cyc.includes('t.busy')
      ? '' : 'THE MID-TURN GUARD IS GONE: reaching a mode can transit THROUGH bypass, and mid-turn a tool call could run under it',
     cyc.includes("sendInput('\\x1b[Z')")
      ? '' : 'the Shift+Tab byte (CSI Z) is no longer what gets sent',
     APP.includes('PERM_CYCLE_MAX')
      ? '' : 'the press cap is gone — an unreachable target would press forever'].filter(Boolean));
  // ---- the top bar names the SESSION, and does not clip it early ----
  // This was reported, closed, and reported again, so it gets a pin rather than a third sighting. A joined
  // live tab's label is stamped 'Live · <who>' and histSessionName is the LOCAL resolver, so without the
  // override below the bar reads "project / Live · crazy" for a session with a perfectly good name.
  none('the top-bar crumb prints the live placeholder instead of the session name',
    [APP.includes("if (rec && rec.kind === 'live')") && APP.includes('rec.joinedAsLabel')
      ? '' : 'paintCrumb no longer resolves a joined tab to its real session name — the Live placeholder is back in the bar',
     APP.includes("p.className = 'crumb-proj'")
      ? '' : 'the project half is a bare text node again, so it cannot shrink independently and the session name gets clipped with it'].filter(Boolean));
  none('the crumb clips the session name before 22 characters',
    [/html\.skin \.crumb b\{flex:none;max-width:22ch/.test(HTML)
      ? '' : 'the session half lost its own 22ch budget, so a long project name eats it again',
     /html\.skin \.crumb-proj\{[^}]*text-overflow:ellipsis/.test(HTML)
      ? '' : 'the project half no longer ellipsises, so it cannot be the half that yields',
     /html\.skin \.crumb-proj\{[^}]*white-space:pre/.test(HTML)
      ? '' : "the project span lost white-space:pre — as flex items the separator space collapses and it prints 'Local /4444'"].filter(Boolean));
  // The consent flag is what makes bypass reachable at all; the foreign branch must never see it.
  // (win-runner.test.js proves the behaviour; this pins the intent next to the rest of the rail.)
  none('the bypass consent flag went missing, or leaked into the sandboxed foreign branch',
    [read('runners/win.js').includes("['--allow-dangerously-skip-permissions']")
      ? '' : 'runners/win.js no longer passes --allow-dangerously-skip-permissions, so bypass cannot be reached mid-session',
     read('wsl/session.sh').includes('--allow-dangerously-skip-permissions')
      ? '' : 'wsl/session.sh drifted from the win runner — the same session would behave differently per flavor'].filter(Boolean));
}

console.log(`\ncontract: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
