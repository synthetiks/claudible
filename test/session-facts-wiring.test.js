// test/session-facts-wiring.test.js — static pins over the wiring that connects the shared
// append-only session record to what the user actually sees. The pure pieces are unit-tested
// elsewhere (session-facts, derive-sessions); these guard the parts that only exist as call sites,
// where a refactor can quietly disconnect a correct mechanism and every other test still passes.
// Run: node test/session-facts-wiring.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { stripCode } = require('./_strip-comments.js');

const ROOT = path.resolve(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
const TOOL = fs.readFileSync(path.join(ROOT, 'wsl/sessions-sync-tool.js'), 'utf8');
const SYNC = fs.readFileSync(path.join(ROOT, 'wsl/sessions-sync.sh'), 'utf8');
const MAIN_NC = stripCode(MAIN, 'main.js');
const APP_NC = stripCode(APP, 'renderer/app.js');
const TOOL_NC = stripCode(TOOL, 'wsl/sessions-sync-tool.js');

let pass = 0, fail = 0;
const ok = (label, c) => c ? pass++ : (fail++, console.error('  FAIL ' + label));

// ---- minting: the two things a fact cannot be correct without ----
// A reused id makes one machine's record swallow another's, silently. Nothing warns; the fact is
// simply gone from everyone's view of history.
ok('facts are minted with a globally unique id',
  /recordSessionFact[\s\S]{0,600}?id: require\('crypto'\)\.randomUUID\(\)/.test(MAIN_NC));
// The app's own clock, not the sync side's — a rename's stamp decides whose name wins.
ok('facts are stamped from the app clock',
  /recordSessionFact[\s\S]{0,600}?ts: Date\.now\(\)/.test(MAIN_NC));
ok('a fact that cannot be built is dropped rather than written malformed',
  /recordSessionFact[\s\S]{0,900}?if \(!fact\) return;/.test(MAIN_NC));

// ---- dual-write: the ONLY thing protecting a machine that has not updated ----
// An older build reads the per-author name map and knows nothing about facts. Stop writing the map
// and a collaborator on the previous release silently stops seeing renames — with no error anywhere.
ok('a rename writes BOTH the record and the older name map',
  /recordSessionFact\([\s\S]{0,120}?'session\.renamed'[\s\S]{0,400}?runPresence\(`title-set/.test(MAIN_NC));
ok('a clear writes BOTH the record and the older link',
  /recordSessionFact\([\s\S]{0,120}?'session\.cleared'[\s\S]{0,400}?runPresence\(`lineage-set/.test(MAIN_NC));
ok('a delete-everywhere records the deletion',
  /recordSessionFact\(ws, 'session\.deleted'/.test(MAIN_NC));

// ---- the clock the shared stamps are written with ----
// CLAUDIBLE_NOW is whole SECONDS (the presence arbiter's unit, pinned in contract.test.js). Reusing
// it for a rename would drop that stamp back to second precision — the exact resolution that used to
// let two renames inside one second tie and leave the machines disagreeing permanently.
ok('main injects a millisecond clock alongside the seconds one',
  MAIN.includes('CLAUDIBLE_NOW_MS=${Date.now()}'));
ok('main still injects the seconds clock the presence arbiter needs',
  MAIN.includes('CLAUDIBLE_NOW=${Math.floor(Date.now() / 1000)}'));
ok('a title stamp comes from the injected clock, not the sync side',
  /setPair\(entryPairs, 'ts', nowMs\(\)\)/.test(TOOL_NC));
ok('nowMs prefers the injected millisecond clock',
  /function nowMs\(\)[\s\S]{0,300}?process\.env\.CLAUDIBLE_NOW_MS/.test(TOOL_NC));
ok('nowMs falls back to local time for a standalone run',
  /function nowMs\(\)[\s\S]{0,300}?return Date\.now\(\);/.test(TOOL_NC));

// ---- reading: the record decides what is shown ----
ok('the session list drops what the record says was deleted',
  /applyFactDeletions/.test(MAIN_NC) && /resolve\(known \? applyFactDeletions\(parsed, known\) : parsed\)/.test(MAIN_NC));
ok('names resolve with the record winning over the older map',
  /resolve\(known \? applyFactTitles\(titles, known\) : titles\)/.test(MAIN_NC));
ok('a cold cache paints exactly as before and fetches for next time',
  /if \(!known\) refreshSessionFacts\(ws\);/.test(MAIN_NC));
// Continuations are recorded but still resolved the old way. Two mechanisms folding the same row
// would leave no way to tell which one was wrong.
ok('only renames and deletions are applied to the list so far',
  /applyFactDeletions[\s\S]{0,700}?f\.type === 'session\.renamed' \|\| f\.type === 'session\.deleted'/.test(MAIN_NC));
ok('a projection that throws returns the list untouched rather than blanking the sidebar',
  /function applyFactDeletions[\s\S]{0,900}?catch \(e\) \{ return list; \}/.test(MAIN_NC));

// ---- the record must never be pruned or rewritten ----
ok('appending a fact is an append, never a read-modify-write',
  /function factAppend[\s\S]{0,1400}?fs\.appendFileSync\(f, line \+ '\\n'\)/.test(TOOL_NC));
ok('an id-less fact is refused at the door',
  /function factAppend[\s\S]{0,1200}?fact-append: no id/.test(TOOL_NC));
ok('the conflict reset preserves unpushed facts the way it preserves deletion markers',
  SYNC.includes('fact-restore') && SYNC.includes('preserve local session facts across conflict reset'));
ok('the facts snapshot is taken BEFORE the reset',
  /cp -f "\$WT\/facts\/\$author\.jsonl" "\$fsnap"[\s\S]{0,400}?reset --hard/.test(SYNC));

// ---- the guest follows a host that cleared, instead of reading it as an ending ----
// /clear mints a new session id. The peer lookup asks for the id this tab joined with, finds
// nothing, and everything downstream reads that as "the host left".
ok('a vanished peer is checked for the same host on a NEW session before being called ended',
  /const moved = rec\.peer\.login && peersForWs\(rec\.peerWsId\)\.find\(\(p\) => p\.login === rec\.peer\.login[\s\S]{0,200}?p\.session !== rec\.peer\.session\)/.test(APP_NC));
ok('following a clear re-points the record',
  /if \(moved\)[\s\S]{0,600}?rec\.peer = moved;/.test(APP_NC));
// The tunnel does not restart on a clear, so the handle is normally identical — re-dialling would
// drop a working connection to fix a bookkeeping error.
ok('an unchanged handle is followed WITHOUT re-dialling',
  /moved\.url === rec\.peer\.url && moved\.token === rec\.peer\.token\)[\s\S]{0,300}?rec\.peer = moved;\s*\n\s*continue;/.test(APP_NC));
ok('a changed handle still re-arms the socket',
  /console\.log\('\[live\] host cleared onto a new handle[\s\S]{0,400}?claudible\.liveConnect\(rec\.tabId, moved, collabName\(\)\)/.test(APP_NC));
ok('the auto-close for a genuinely ended host is still reachable',
  /if \(pollOk && rec\.peerWsId === activeWsId && LIVE_RECONNECTABLE\.has\(rec\.liveState\)\) ended\.push\(rec\.tabId\);/.test(APP_NC));

console.log(`session-facts-wiring: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
