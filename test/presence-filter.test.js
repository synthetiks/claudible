// test/presence-filter.test.js — the presence-list robustness fix. wsl/sessions-sync-tool.js `presence-filter`
// reads candidate live/<author>.json blobs (one per line) and must emit a VALID presence-list result that contains
// only the well-formed peer objects — so a single corrupt/torn/concatenated file can't poison the whole peers[]
// array (which would make the renderer's JSON.parse throw and silently kill the roster / "Join live" badge).
// Run: node test/presence-filter.test.js
'use strict';
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const TOOL = path.join(__dirname, '..', 'wsl', 'sessions-sync-tool.js');

let pass = 0, fail = 0;
function ok(label, c) { c ? pass++ : (fail++, console.error('  FAIL ' + label)); }

function run(input) {
  const r = spawnSync(process.execPath, [TOOL, 'presence-filter'], { input, encoding: 'utf8' });
  return r.stdout || '';
}
// every emitted line must itself be parseable (the whole point) and shaped like a presence-list result.
function peersOf(out) {
  let parsed;
  try { parsed = JSON.parse(out); } catch { return { bad: true }; }
  return parsed;
}

// ---- one valid peer amid every flavor of junk the old brace-guard let through ----
{
  const input = [
    '{"login":"mk","session":"s1","ts":5}',   // valid
    '{}x{}',                                    // trailing garbage (the exact case the brace guard accepted)
    '{"a":1',                                   // torn write (unterminated)
    '{"x":1}{"y":2}',                           // two concatenated objects
    '   ',                                       // blank
    '[1,2]',                                     // array, not an object
    '42',                                        // bare number
    'null',                                      // null
    '{"login":"cd","session":"s2","ts":9}',     // valid
  ].join('\n') + '\n';
  const out = run(input);
  const p = peersOf(out);
  ok('output is valid JSON', !p.bad);
  ok('result is a presence-list', p.op === 'presence-list' && p.ok === true);
  ok('keeps exactly the 2 valid peers', Array.isArray(p.peers) && p.peers.length === 2);
  ok('drops all the junk, keeps content', p.peers && p.peers[0].login === 'mk' && p.peers[1].login === 'cd');
}

// ---- all junk → a VALID empty list (never invalid output) ----
{
  const out = run('{}x{}\n{"a":1\ngarbage\n');
  const p = peersOf(out);
  ok('all-junk → valid JSON', !p.bad);
  ok('all-junk → empty peers', Array.isArray(p.peers) && p.peers.length === 0);
}

// ---- empty stdin → valid empty list ----
{
  const p = peersOf(run(''));
  ok('empty input → valid empty list', !p.bad && Array.isArray(p.peers) && p.peers.length === 0);
}

// ---- a unicode name survives and re-serializes to valid JSON ----
{
  const p = peersOf(run('{"login":"mk","name":"MØ Dev 🚀","ts":1}\n'));
  ok('unicode peer survives', !p.bad && p.peers.length === 1 && p.peers[0].name === 'MØ Dev 🚀');
}

console.log(`presence-filter: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
