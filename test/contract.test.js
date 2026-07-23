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
  // A DRAFT row builds its OWN .sess-draftdot span and the rule above already pulses it when .busy is set. If the
  // busy dot stops excluding draft rows, a busy draft wears TWO dots — a red one and an amber one, side by side.
  // That shipped for one commit; it must not ship twice.
  none('the busy dot no longer excludes draft rows (a busy draft would wear two dots)',
    /\.sess\.busy(?!:not\(\.sess-draft\))[^{,]*\.sess-prev::before/.test(flat) ? ['.sess.busy .sess-prev::before is not :not(.sess-draft)-guarded'] : []);
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
  none('…and the ▾ itself must stay on the transform-free centring',
    /\.sess-menu-btn\{[^}]*top:0;bottom:0;margin:auto 0/.test(flat) ? [] : ['.sess-menu-btn is no longer centred by top/bottom + margin:auto']);
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
    /function placeToast[\s\S]{0,400}?getBoundingClientRect/.test(APP) && /function toast\(msg\)[\s\S]{0,300}?placeToast\(/.test(APP)
      ? [] : ['placeToast is missing, or toast() no longer calls it']);

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
  none('the New-project modal lost its shared-repo tile', /id="ch-repo" data-kind="repo" role="radio"/.test(HTML) ? [] : ['index.html has no #ch-repo radio tile']);
  none('the modal path cannot reach workspaceCreate with kind repo',
    /const WS_KINDS = \['local', 'repo', 'adopt'\]/.test(APP) && /creating private repo on GitHub/.test(APP) ? [] : ['WS_KINDS lost repo (or its busy text is gone)']);
  // Creating shared publishes transcripts from birth — the tile must gate on the same honest disclosure the
  // ▾-menu flows use (R2). Pinned to the repo branch of createWorkspace, not just any confirm() somewhere.
  none('the shared tile creates without the transcript-sync consent gate',
    /wsChoiceKind === 'repo' && !confirm\([\s\S]{0,420}session sync commits your Claude transcripts/.test(APP) ? [] : ['no consent confirm before workspaceCreate(repo)']);
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
    /function liveReasonText\(/.test(APP) && (APP.match(/liveReasonText\(rec\.liveReason\)/g) || []).length === 2 ? [] : ['both row sites must map through liveReasonText']);
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
none('the wizard create-step gate ignores firstRun again (step 3 is dead code for every user)',
  /hasWs = real\.length > \(bootFirstRun \? 1 : 0\);/.test(APP) && /bootFirstRun = true;/.test(APP) ? [] : ['the firstRun-aware gate is gone']);

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
}

// ---------------------------------------------------------------------------------------------------------
// 27. R15 — delete-tombstones cover every GitHub-identified workspace. The old kind==='repo' gate meant a
//     deleted ADOPTED project (kind:'local') never tombstoned and re-surfaced as a phantom invite; a delete
//     before the ghId backfill tombstoned by name only, so an external rename resurrected it. The tombstone
//     is now kind-agnostic, and the stable gh: key is backfilled in the background onto a snapshot.
// ---------------------------------------------------------------------------------------------------------
{
  const del = (MAIN.match(/ipcMain\.handle\('workspace:delete'[\s\S]*?\n\}\)\);/) || [''])[0];
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
  none('win.js facade.kill no longer tree-reaps (children pile up across restarts on win-native)',
    /const pid = inner && inner\.pid;\s*\n\s*try \{ inner\.kill\(signal\); \} catch \{\}\s*\n\s*if \(pid\) \{ try \{ const c = cp\.spawn\('taskkill', \['\/PID', String\(pid\), '\/T', '\/F'\]/.test(WIN)
    && /detached: true, stdio: 'ignore'/.test(WIN) ? [] : ['taskkill /T /F tree-reap missing from facade.kill']);
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
    /View-only — the host shared a watch link/.test(APP) && /rec\.liveReadOnly \? ' · view-only' : ''/.test(APP) ? [] : ['toast + row label required']);
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

console.log(`\ncontract: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
