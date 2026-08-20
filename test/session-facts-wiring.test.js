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
  /resolve\(known \? applySessionFacts\(parsed, known\) : parsed\)/.test(MAIN_NC));
ok('names resolve with the record winning over the older map',
  /resolve\(known \? applyFactTitles\(titles, known\) : titles\)/.test(MAIN_NC));
ok('a projection that throws returns the list untouched rather than blanking the sidebar',
  /function applySessionFacts[\s\S]{0,1000}?catch \(e\) \{ return list; \}/.test(MAIN_NC));

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

// ---- facts reach a connected peer over the socket, not by waiting for the next sync ----
// The record travels by git sync, which measured about five minutes in the field. Anything a person
// is watching for has to ride the channel that is already open.
const SRV = fs.readFileSync(path.join(ROOT, 'share/server.js'), 'utf8');
const SRV_NC = stripCode(SRV, 'share/server.js');
ok('the server can push one fact and a snapshot',
  /function pushFact\(fact\)/.test(SRV_NC) && /function pushFacts\(list\)/.test(SRV_NC));
ok('both are exported',
  /pushFacts, pushFact,/.test(SRV_NC));
ok('a fact is unioned by id, never replacing another',
  /function pushFact[\s\S]{0,400}?lastFacts\.some\(\(f\) => f && f\.id === fact\.id\)/.test(SRV_NC));
// Same privacy rule as scrollback, status and history: a private workspace's session NAMES must not
// leak, and the cache must not survive to replay at a later joiner.
ok('nothing is pushed while the mirror is paused',
  /function pushFact\(fact\) \{\s*\n\s*if \(paused/.test(SRV_NC) && /function pushFacts\(list\)[\s\S]{0,200}?if \(paused\) \{ lastFacts = \[\]; return; \}/.test(SRV_NC));
ok('pausing drops the cached facts',
  /if \(paused\) \{ ring = Buffer\.alloc\(0\); lastStatus = null; lastHistory = \[\]; lastFacts = \[\]; \}/.test(SRV_NC));
ok('a late joiner is replayed what already happened',
  /if \(!paused && lastFacts\.length\) ws\.send/.test(SRV_NC));
ok('recording a fact also streams it to guests',
  /seedSessionFact\(ws, fact\);[\s\S]{0,200}?share\.pushFact\(fact\)/.test(MAIN_NC));
ok('recording a fact also seeds this machine, so the host does not wait on its own sync',
  /function seedSessionFact/.test(MAIN_NC));
// A seeded fact must take effect at once WITHOUT making a stale cache look freshly read — otherwise a
// rename made here would suppress the sync that carries the collaborator's.
ok('seeding preserves the last fetch time',
  /_factCache\.set\(key, \{ ts: \(cur && cur\.ts\) \|\| 0, facts: merged \}\)/.test(MAIN_NC));
ok('what we have and when to refresh are separate questions',
  /function sessionFactsNow/.test(MAIN_NC) && /function sessionFactsStale/.test(MAIN_NC));
// BOTH readers, counted — not "at least one". The first version of this pin matched either call
// site, so breaking one of the two left it green: a session list that stopped refreshing while the
// title list still did would have shipped with the suite reporting nothing wrong.
ok('both readers refresh on staleness, not on emptiness',
  (MAIN_NC.match(/if \(sessionFactsStale\(ws\)\) refreshSessionFacts\(ws\);/g) || []).length === 2);
ok('no reader still refreshes only when it has nothing at all',
  !/if \(!known\) refreshSessionFacts\(ws\);/.test(MAIN_NC));
ok('a joined guest accepts streamed facts',
  /case 'session-fact': acceptStreamedFact\(r, m\.fact\); break;/.test(MAIN_NC) && /case 'session-facts':/.test(MAIN_NC));
ok('a streamed fact is normalised before it can reach the projection',
  /function acceptStreamedFact[\s\S]{0,400}?_facts\.makeFact\(raw\)[\s\S]{0,200}?if \(!f\) return;/.test(MAIN_NC));
ok('streamed facts are unioned, not appended blindly',
  /_streamedFacts = _facts\.mergeFacts\(_streamedFacts, \[f\]\)/.test(MAIN_NC));
ok('streamed facts are bounded',
  /_streamedFacts\.length > 500/.test(MAIN_NC));
ok('streamed facts are folded into what the projection reads',
  /function sessionFactsNow[\s\S]{0,400}?_facts\.mergeFacts\(own, _streamedFacts\)/.test(MAIN_NC));
ok('a guest joining midway gets a snapshot, not only what happens next',
  /function _pushFactsToShare[\s\S]{0,400}?share\.pushFacts\(known \|\| \[\]\)/.test(MAIN_NC));
ok('the snapshot is gated on the workspace being shareable',
  /function _pushFactsToShare[\s\S]{0,300}?isShareable\(ws\)/.test(MAIN_NC));

// ---- the projection now folds a clear, which is what removes the guest's duplicate row ----
ok('continuations are applied to the list',
  /function applySessionFacts[\s\S]{0,700}?f\.type === 'session\.cleared'/.test(MAIN_NC));
ok('the older link is still written, so a machine on the previous build keeps working',
  /runPresence\(`lineage-set/.test(MAIN_NC) && /runPresence\(`title-set/.test(MAIN_NC));

// ---- project-level facts ----
// WHAT IS AND IS NOT WORTH MOVING, since this was nearly a much larger refactor: the workspace
// registry is machine-local and never synced — it holds paths, window state and clone flags that mean
// nothing on another machine — so its ~39 in-place writes have exactly ONE writer each. Editing
// single-writer local state in place is not the defect this work exists to remove; two machines
// editing their own copy of a SHARED value is. So only the genuinely shared project fact moves: its
// NAME. The rest stay exactly where they are, and pinning them would have been churn guarding
// nothing.
ok('renaming a project records the new name as a fact',
  /recordSessionFact\(ws, 'workspace\.renamed', \{ workspaceId: ws\.id, label \}\)/.test(MAIN_NC));
ok('the local registry is still written too — it holds machine-local things the record must not own',
  /ws\.label = label; saveRegistry\(\);/.test(MAIN_NC));
ok('adopting a project is recorded',
  /recordSessionFact\(ws, 'workspace\.adopted'/.test(MAIN_NC));
ok('dismissing a project is recorded',
  /recordSessionFact\(ws, 'workspace\.dismissed'/.test(MAIN_NC));
// Recorded is not the same as READ. Whether dismissing a project here should hide it on the other
// machine is a product question nobody has answered, and applying an unanswered decision would be
// worse than waiting. The projection is deliberately not looking at these yet.
ok('project facts are recorded but not yet applied to what is shown',
  !/f\.type === 'workspace\./.test(MAIN_NC));

console.log(`session-facts-wiring: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
