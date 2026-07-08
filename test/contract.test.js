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
const ok = (label, c) => c ? pass++ : (fail++, console.error('  FAIL ' + label));
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

console.log(`\ncontract: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
